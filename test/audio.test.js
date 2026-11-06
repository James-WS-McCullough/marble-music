// Sounds: render offline (node-web-audio-api) and check the output is sane: every object's voice
// makes sound, nothing is NaN or clipping, pitched voices are in tune, and the lofi master
// effects (filter, crackle) really do what the switch blocks say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineAudioContext } from 'node-web-audio-api';
import { Synth, OBJECT_VOICES } from '../src/audio.js';

const SR = 22050;
const note = (midi, dur = 0.4, ch = 0, vel = 0.8) => ({ midi, dur, ch, vel });

async function render(fn, seconds = 1.6) {
  const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
  const synth = new Synth(ctx);
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

for (const obj of Object.keys(OBJECT_VOICES)) {
  test(`${obj}: its own sound, audible and clean, alone and as a chord`, async () => {
    for (const [notes, role] of [[[note(67)], 'lead'], [[note(76), note(64), note(67)], 'lead'], [[note(43, 0.6, 1)], 'bass']]) {
      const r = await render((s) => s.playHit(notes, 0.05, role, obj));
      assert.equal(r.nan, 0, 'no NaN');
      assert.ok(r.rms > 0.002, `audible (rms ${r.rms.toFixed(4)})`);
      assert.ok(r.peak <= 1.0, `no clipping (peak ${r.peak.toFixed(2)})`);
    }
  });
}

// (inharmonic voices - metal tubes, bells, bottles - would fool the simple pitch estimator)
for (const obj of ['key', 'bar', 'button', 'bamboo', 'neon', 'epiano', 'guitar']) {
  test(`${obj}: in tune`, async () => {
    for (const midi of [64, 72]) {
      const r = await render((s) => s.playHit([note(midi, 0.6)], 0, 'lead', obj), 0.8);
      const want = 440 * 2 ** ((midi - 69) / 12), got = pitch(r.d, 0.08, 0.3);
      const cents = 1200 * Math.log2(got / want);
      assert.ok(Math.abs(cents) < 30, `midi ${midi}: ${got.toFixed(1)} Hz vs ${want.toFixed(1)} (${cents.toFixed(0)} cents)`);
    }
  });
}

test('drums: the acoustic kit, and woodblocks & cowbells (the blocks kit and real MIDI notes)', async () => {
  for (const [notes, obj] of [[[note(36, 0.1, 9), note(38, 0.1, 9), note(42, 0.1, 9), note(49, 0.1, 9)], 'kit'],
    [[note(38, 0.1, 9), note(45, 0.1, 9), note(42, 0.1, 9)], 'blocks'], [[note(56, 0.1, 9), note(76, 0.1, 9), note(77, 0.1, 9)], 'kit']]) {
    const r = await render((s) => s.playHit(notes, 0.05, 'drums', obj), 0.8);
    assert.equal(r.nan, 0);
    assert.ok(r.rms > 0.002 && r.peak <= 1.0, `${obj}: rms ${r.rms.toFixed(4)} peak ${r.peak.toFixed(2)}`);
  }
  const kit = await render((s) => s.playHit([note(38, 0.1, 9)], 0.05, 'drums', 'kit'), 0.4);
  const blocks = await render((s) => s.playHit([note(38, 0.1, 9)], 0.05, 'drums', 'blocks'), 0.4);
  assert.ok(Math.abs(kit.rms - blocks.rms) > 1e-4, 'the blocks kit really swaps the sound');
});

test('lofi beat track: kick, snare and hats render cleanly', async () => {
  const r = await render((s) => { s.setLofi(true, 0); [36, 42, 38, 42, 36, 46, 38, 42].forEach((m, i) => s.playBeat(note(m, 0.1, 9), 0.05 + i * 0.18)); });
  assert.equal(r.nan, 0);
  assert.ok(r.rms > 0.005 && r.peak <= 1.0, `rms ${r.rms.toFixed(4)} peak ${r.peak.toFixed(2)}`);
});

test('switch blocks: closing the filter muffles the mix, the needle adds crackle', async () => {
  // a bright sound (hats) with the filter open vs closed: closed loses most of its energy
  const hats = (s) => { for (let i = 0; i < 8; i++) s.playBeat(note(42, 0.1, 9), 0.2 + i * 0.12); };
  const open = await render((s) => hats(s), 1.4);
  const closed = await render((s) => { s.setFilter(true, 0); hats(s); }, 1.4);
  assert.ok(closed.rms < open.rms * 0.35, `filter closed: ${closed.rms.toFixed(4)} vs open ${open.rms.toFixed(4)}`);
  // crackle on adds signal; lifting the needle again silences it
  const quiet = await render(() => {}, 1.0);
  const crackle = await render((s) => s.setCrackle(true, 0), 1.0);
  const lifted = await render((s) => { s.setCrackle(true, 0); s.setCrackle(false, 0.1); }, 1.0);
  assert.ok(crackle.rms > 0.001 && crackle.peak <= 1.0, `crackle rms ${crackle.rms.toFixed(4)}`);
  // ... but it's surface noise under the music, not static on top of it
  const music = await render((s) => [60, 64, 67, 72].forEach((m, i) => s.playHit([note(m, 0.4)], 0.05 + i * 0.25, 'lead', 'epiano')), 1.0);
  assert.ok(crackle.rms < music.rms * 0.15, `crackle ${crackle.rms.toFixed(4)} vs music ${music.rms.toFixed(4)}`);
  assert.ok(crackle.peak < 0.1, `no loud pops (peak ${crackle.peak.toFixed(3)})`);
  assert.ok(quiet.rms < 1e-4);
  assert.ok(lifted.rms < crackle.rms * 0.5);
  // a switch being thrown makes a click
  const click = await render((s) => s.playHit([], 0.05, 'lead', 'switch'), 0.3);
  assert.ok(click.rms > 0.0005 && click.nan === 0);
});
