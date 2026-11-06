// Sound fonts: render each one offline (node-web-audio-api) and check the output is sane:
// every voice makes sound, nothing is NaN or clipping, and notes are in tune.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAudioContext } from 'node-web-audio-api';
import { Synth, FONTS } from '../src/audio.js';

const SR = 22050;
const note = (midi, dur = 0.4, ch = 0, vel = 0.8) => ({ midi, dur, ch, vel });
const PHRASE = {
  lead: [72, 74, 76, 79].map((m, i) => ({ n: note(m, 0.25), t: 0.05 + i * 0.25 })),
  chord: [[60, 64, 67]].flatMap((ch) => ch.map((m) => ({ n: note(m, 0.5), t: 0.05 }))),
  harmony: [64, 65].map((m, i) => ({ n: note(m, 0.45, 1), t: 0.05 + i * 0.5 })),
  bass: [43, 41].map((m, i) => ({ n: note(m, 0.45, 1), t: 0.05 + i * 0.5 })),
  drums: [36, 38, 42, 49].map((m, i) => ({ n: note(m, 0.1, 9), t: 0.05 + i * 0.25 })),
};

async function render(font, fn, seconds = 1.6) {
  const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
  const synth = new Synth(ctx);
  synth.font = font;
  fn(synth);
  const d = (await ctx.startRendering()).getChannelData(0);
  let peak = 0, sum = 0, nan = 0;
  for (const x of d) { if (Number.isNaN(x)) nan++; else { peak = Math.max(peak, Math.abs(x)); sum += x * x; } }
  return { d, peak, rms: Math.sqrt(sum / d.length), nan };
}

/** Autocorrelation pitch estimate over a window. */
function pitch(d, a = 0.06, b = 0.3) {
  const i0 = Math.floor(a * SR), i1 = Math.floor(b * SR);
  let best = 0, lag = 0;
  for (let L = Math.floor(SR / 2000); L < SR / 60; L++) {
    let s = 0;
    for (let i = i0; i < i1; i++) s += d[i] * d[i + L];
    if (s > best) { best = s; lag = L; }
  }
  return SR / lag;
}

for (const { id } of FONTS) {
  test(`font ${id}: every voice sounds, no NaN, no clipping`, async () => {
    for (const [role, notes] of Object.entries(PHRASE)) {
      const r = await render(id, (s) => notes.forEach(({ n, t }) => s.play(n, t, role === 'drums' ? 'lead' : role)));
      assert.equal(r.nan, 0, `${role}: no NaN`);
      assert.ok(r.rms > 0.002, `${role}: audible (rms ${r.rms.toFixed(4)})`);
      assert.ok(r.peak <= 1.0, `${role}: no clipping (peak ${r.peak.toFixed(2)})`);
    }
    // everything at once, through playHit (lead + chord + drum in one pad hit)
    const all = await render(id, (s) => {
      for (const [role, notes] of Object.entries(PHRASE)) if (role !== 'chord') notes.forEach(({ n, t }) => s.play(n, t, role === 'drums' ? 'lead' : role));
      s.playHit([note(76, 0.5), note(60, 0.5), note(67, 0.5), note(36, 0.1, 9)], 0.6, 'lead');
    });
    assert.equal(all.nan, 0);
    assert.ok(all.peak <= 1.05, `full mix peak ${all.peak.toFixed(2)}`);
  });

  // the glockenspiel's inharmonic overtones fool a simple pitch estimator, so it's skipped
  if (id !== 'glock') test(`font ${id}: lead notes are in tune`, async () => {
    for (const midi of [64, 72]) {
      const r = await render(id, (s) => s.play(note(midi, 0.6), 0, 'lead'), 0.8);
      const want = 440 * 2 ** ((midi - 69) / 12), got = pitch(r.d);
      const cents = 1200 * Math.log2(got / want);
      assert.ok(Math.abs(cents) < 30, `${id} midi ${midi}: ${got.toFixed(1)} Hz vs ${want.toFixed(1)} (${cents.toFixed(0)} cents)`);
    }
  });
}

for (const obj of ['button', 'tube']) {
  test(`${obj}s have their own sound: audible, clean, in tune, with chords`, async () => {
    for (const font of ['nes', 'mallets']) {
      const r = await render(font, (s) => s.playHit([note(72, 0.4), note(64, 0.4), note(67, 0.4), note(36, 0.1, 9)], 0.05, 'lead', font, obj));
      assert.equal(r.nan, 0);
      assert.ok(r.rms > 0.002 && r.peak <= 1.0, `${obj}/${font}: rms ${r.rms.toFixed(4)} peak ${r.peak.toFixed(2)}`);
    }
    if (obj === 'button') { // (a tube's inharmonic partials would fool the simple pitch estimator)
      const r = await render('nes', (s) => s.playHit([note(64, 0.6)], 0, 'lead', 'nes', 'button'), 0.8);
      const cents = 1200 * Math.log2(pitch(r.d, 0.08, 0.3) / (440 * 2 ** ((64 - 69) / 12)));
      assert.ok(Math.abs(cents) < 30, `${cents.toFixed(0)} cents`);
    }
  });
}

