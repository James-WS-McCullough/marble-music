// Web Audio synth. Every sound is synthesised here, and each visual object has its own sound:
// keys and wooden bars play a warm marimba, arcade buttons an electric blip, chime tubes a
// tubular bell, bamboo a hollow knock, bottles a glassy ping, neon tubes a buzzy synth,
// handbells a bright bell, drums an acoustic kit (or woodblocks & cowbells). Lofi songs add an
// electric piano, vinyl-record chords, a dusty boom-bap beat track, and a master chain the
// marble's switch blocks control: a low-pass filter, vinyl crackle and lofi tone.
//
// Notes are scheduled ahead on the AudioContext clock, which also drives the animation, so
// sound and visuals stay locked together.

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const CYM = (m) => m === 42 || m === 44 || m === 46 || (m >= 49 && m <= 59);

/** Which voice plays each object (keys and bars: marimba). */
export const OBJECT_VOICES = {
  key: 'note_marimba', bar: 'note_marimba', button: 'note_arcade', tube: 'note_tube', bamboo: 'note_bamboo',
  bottle: 'note_bottle', neon: 'note_neon', bell: 'note_bell', epiano: 'note_rhodes', vinyl: 'note_rhodes', switch: 'note_rhodes',
};

function impulse(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  }
  return buf;
}

/**
 * Vinyl surface noise (looped): what a record sounds like between the notes, not static. A very
 * quiet, warm hiss (band-limited: no harsh top), a faint slow rumble, a few soft ticks and the
 * occasional deeper pop. Seeded, and long enough (9 s) that the loop isn't noticeable.
 */
function crackleBuffer(ctx, seconds = 9) {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let seed = 0x5eed;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // warm hiss: white noise through two one-pole low-passes (~2.5 kHz) and a gentle high-pass
  const a = Math.exp(-2 * Math.PI * 2500 / sr), hp = Math.exp(-2 * Math.PI * 180 / sr);
  let l1 = 0, l2 = 0, h = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    l1 = a * l1 + (1 - a) * (rnd() * 2 - 1);
    l2 = a * l2 + (1 - a) * l1;
    h = hp * (h + l2 - prev); prev = l2;
    // the hiss breathes a little (like a slightly worn groove), plus a 0.55 Hz rumble
    d[i] = h * 0.05 * (0.8 + 0.2 * Math.sin((2 * Math.PI * i) / (sr * 1.8))) + 0.004 * Math.sin((2 * Math.PI * 0.55 * i) / sr);
  }
  // ticks: tiny, short, softened clicks (~2.5 a second); every so often a rounder, deeper pop
  const click = (at, amp, len, tone) => {
    let z = 0;
    for (let j = 0; j < len && at + j < n; j++) {
      z = tone * z + (1 - tone) * (rnd() * 2 - 1);
      d[at + j] += z * amp * Math.exp(-j / (len / 5));
    }
  };
  for (let k = 0; k < seconds * 2.5; k++) click(Math.floor(rnd() * n), 0.04 + 0.08 * rnd() ** 2, 12 + Math.floor(rnd() * 30), 0.55);
  for (let k = 0; k < seconds * 0.35; k++) click(Math.floor(rnd() * n), 0.12 + 0.1 * rnd(), 90 + Math.floor(rnd() * 120), 0.9);
  // crossfade the tail into the start; playback loops before the tail (loopEnd), so it's seamless
  const f = Math.floor(sr * 0.05);
  for (let j = 0; j < f; j++) { const w = j / f; d[j] = d[j] * w + d[n - f + j] * (1 - w); }
  buf.loopEndTime = (n - f) / sr;
  return buf;
}

export class Synth {
  constructor(ctx = null) { // pass an OfflineAudioContext to render offline (tests)
    ctx = this.ctx = ctx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    comp.connect(this.master).connect(ctx.destination);
    // master chain: voices -> out -> lofi tone -> saturation -> filter (switch blocks) -> compressor
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass'; this.filter.frequency.value = 20000; this.filter.Q.value = 0.9;
    this.filter.connect(comp);
    this.sat = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 1.6) / Math.tanh(1.6); }
    this.sat.curve = curve;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass'; this.tone.frequency.value = 20000;
    this.tone.connect(this.sat).connect(this.filter);
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(this.tone);
    // room reverb and a soft echo
    this.revIn = ctx.createGain();
    const rev = ctx.createConvolver();
    rev.buffer = impulse(ctx, 2.4);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.28;
    this.revIn.connect(rev).connect(revOut).connect(this.tone);
    this.echoIn = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.24;
    const fbLp = ctx.createBiquadFilter();
    fbLp.type = 'lowpass'; fbLp.frequency.value = 2600;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.38;
    this.echoIn.connect(delay).connect(fbLp).connect(fb).connect(delay);
    fbLp.connect(echoOut).connect(this.tone);
    // the beat track's bus, and vinyl crackle (on top of the filter, like the record itself)
    this.beatBus = ctx.createGain();
    this.beatBus.gain.value = 0.9;
    this.beatBus.connect(this.out);
    // (the surface noise sits under the music: a gentle band-pass, then into the compressor)
    this.crackle = ctx.createGain();
    this.crackle.gain.value = 0;
    const crackleTone = ctx.createBiquadFilter();
    crackleTone.type = 'lowpass'; crackleTone.frequency.value = 5000; crackleTone.Q.value = 0.5;
    this.crackle.connect(crackleTone).connect(comp);
    this.crackleBuf = crackleBuffer(ctx);
    this.crackleSrc = null;
    const white = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    this.white = white;
    this.lofi = false;
  }

  /** Master volume (0..1). */
  setVolume(v) {
    this.master.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, 0.05);
  }

  get latency() {
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  }

  /** A per-note output gain routed to a bus (+ optional reverb / echo sends). */
  voice({ rev = 0, echo = 0, bus = this.out, pan = 0 } = {}) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    if (pan) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(bus); }
    else g.connect(bus);
    if (echo) { const s = this.ctx.createGain(); s.gain.value = echo; g.connect(s).connect(this.echoIn); }
    if (rev) { const s = this.ctx.createGain(); s.gain.value = rev; g.connect(s).connect(this.revIn); }
    return g;
  }

  osc(type, freq, time, stop, dest) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, time);
    o.connect(dest);
    o.start(time);
    o.stop(stop);
    return o;
  }

  /**
   * All the notes of one pad hit, played by the object that was hit. In the melody lane the top
   * note is the lead and the rest are a chord. Drums go by channel 10; obj 'blocks' swaps snares
   * and toms for woodblocks and hats for cowbells.
   */
  playHit(notes, time, role = 'lead', obj = null) {
    const pitched = notes.filter((n) => n.ch !== 9);
    for (const d of notes) if (d.ch === 9) {
      const m = d.midi, vel = d.vel ?? 0.8;
      const hat = m === 42 || m === 44 || m === 46, snare = m >= 37 && m <= 40, tom = !CYM(m) && m > 40 && m !== 56;
      if (m === 56 || (obj === 'blocks' && hat)) this.drum_cowbell(vel, time);
      else if (m === 76 || m === 77 || (obj === 'blocks' && (snare || tom))) this.drum_woodblock(m === 77 || tom ? 'low' : 'high', vel, time);
      else this.drum_mallets(m, vel, time);
    }
    if (obj === 'switch') this.click(time);
    if (!pitched.length) return;
    const voice = OBJECT_VOICES[obj] || 'note_marimba';
    const top = pitched.reduce((a, n) => (n.midi > a.midi ? n : a));
    for (const n of pitched) {
      const r = role === 'lead' && n !== top ? 'chord' : obj === 'vinyl' && role !== 'bass' ? 'chord' : role;
      this[voice](n.midi, n.vel ?? 0.8, time, clamp(n.dur ?? 0.3, 0.06, 2.0), r);
    }
  }

  // ---------------------------------------------------------------- lofi
  /** Lofi mode: a slightly darker, gently saturated master tone (vinyl, tape wobble). */
  setLofi(on, time = this.ctx.currentTime) {
    this.lofi = on;
    this.tone.frequency.setTargetAtTime(on ? 8500 : 20000, time, 0.05);
  }

  /** Switch block: close (muffled) or open the master low-pass filter. */
  setFilter(closed, time) {
    this.filter.frequency.setTargetAtTime(closed ? 650 : 20000, time, closed ? 0.12 : 0.25);
  }

  /** Switch block: drop the needle (crackle on) or lift it. */
  setCrackle(on, time) {
    if (!this.crackleSrc) {
      this.crackleSrc = this.ctx.createBufferSource();
      this.crackleSrc.buffer = this.crackleBuf;
      this.crackleSrc.loop = true;
      this.crackleSrc.loopStart = 0;
      this.crackleSrc.loopEnd = this.crackleBuf.loopEndTime;
      this.crackleSrc.connect(this.crackle);
      this.crackleSrc.start();
    }
    this.crackle.gain.setTargetAtTime(on ? 0.6 : 0, time, 0.3); // (fades in and out, like the needle)
  }

  /** A switch block being thrown: a soft mechanical click. */
  click(time) {
    const src = this.ctx.createBufferSource(), bp = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    src.buffer = this.white;
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 4;
    g.gain.setValueAtTime(0.35, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.02);
    src.connect(bp).connect(g).connect(this.out);
    src.start(time); src.stop(time + 0.03);
    this.partial(this.out, 1400, 0.05, 0.03, time, 'square');
  }

  /** Electric piano (Rhodes-ish): sine carrier + decaying FM bark, a bell tine, tremolo. */
  note_rhodes(midi, vel, t, dur, role) {
    const ctx = this.ctx, f = mtof(midi);
    const amp = (role === 'chord' ? 0.06 : role === 'bass' ? 0.11 : 0.1) * (0.55 + 0.45 * vel);
    const len = Math.max(role === 'chord' ? 0.9 : 0.4, Math.min(dur, 3));
    const g = this.voice({ rev: 0.3, echo: role === 'chord' ? 0 : 0.08 });
    const trem = ctx.createGain();
    trem.gain.value = 1;
    trem.connect(g);
    const tl = ctx.createOscillator(), td = ctx.createGain();
    tl.frequency.value = 4.6; td.gain.value = 0.12;
    tl.connect(td).connect(trem.gain);
    const car = this.osc('sine', f, t, t + len + 0.6, trem);
    const mod = ctx.createOscillator(), mg = ctx.createGain();
    mod.frequency.value = f;
    mg.gain.setValueAtTime(f * 1.4, t);
    mg.gain.setTargetAtTime(f * 0.25, t, 0.12);
    mod.connect(mg).connect(car.frequency);
    if (this.lofi) { // tape wobble
      const w = ctx.createOscillator(), wd = ctx.createGain();
      w.frequency.value = 0.55; wd.gain.value = 7;
      w.connect(wd).connect(car.detune);
      w.start(t); w.stop(t + len + 0.6);
    }
    this.partial(g, f * 7.0, amp * 0.12, 0.25, t); // the tine
    mod.start(t); mod.stop(t + len + 0.6);
    tl.start(t); tl.stop(t + len + 0.6);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.006);
    g.gain.setTargetAtTime(amp * 0.55, t + 0.01, 0.5);
    g.gain.setTargetAtTime(0, t + len, 0.12);
  }

  /** The background beat track: dusty boom-bap drums (soft, saturated, a little lo-fi). */
  playBeat(note, time) {
    const ctx = this.ctx, m = note.midi, vel = note.vel ?? 0.8;
    const g = ctx.createGain();
    g.connect(this.beatBus);
    if (m === 35 || m === 36) {
      const o = this.osc('sine', 115, time, time + 0.4, g);
      o.frequency.exponentialRampToValueAtTime(46, time + 0.12);
      g.gain.setValueAtTime(0.85 * vel, time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.36);
    } else {
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter();
      src.buffer = this.white;
      const snare = m >= 37 && m <= 40, open = m === 46;
      f.type = snare ? 'bandpass' : 'highpass';
      f.frequency.value = snare ? 1700 : 6500;
      f.Q.value = snare ? 0.7 : 0.5;
      const len = snare ? 0.18 : open ? 0.22 : 0.045;
      g.gain.setValueAtTime((snare ? 0.42 : 0.1) * vel, time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + len);
      src.connect(f).connect(g);
      src.start(time); src.stop(time + len + 0.02);
      if (snare) this.partial(g, 185, 0.6 * vel, 0.09, time, 'triangle');
    }
  }

  // ---------------------------------------------------------------- object voices
  // ---------------------------------------------------------------- acoustic mallets
  partial(dest, freq, amp, decay, time, type = 'sine') {
    if (freq > 18000) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(amp, time + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    o.connect(g).connect(dest);
    o.start(time);
    o.stop(time + decay + 0.05);
  }

  // ---------------------------------------------------------------- arcade buttons & chime tubes
  /** An arcade button: two detuned square waves with a quick pitch "blip" and a filter sweep. */
  note_arcade(midi, vel, t, dur, role) {
    const ctx = this.ctx, f = mtof(midi), v = 0.6 + 0.4 * vel;
    const amp = (role === 'chord' ? 0.035 : role === 'bass' ? 0.08 : 0.06) * v;
    const len = Math.max(0.12, Math.min(dur, 0.6));
    const g = this.voice({ echo: 0.3 });
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(7000, t);
    lp.frequency.exponentialRampToValueAtTime(1800, t + 0.18);
    lp.connect(g);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.detune.value = det;
      o.frequency.setValueAtTime(f * 2, t); // the blip: an octave up, dropping into the note
      o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
      o.connect(lp);
      o.start(t);
      o.stop(t + len + 0.1);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.003);
    g.gain.setTargetAtTime(amp * 0.6, t + 0.01, 0.05);
    g.gain.setValueAtTime(amp * 0.6, t + len);
    g.gain.linearRampToValueAtTime(0, t + len + 0.06);
  }

  /** A chime tube (tubular bell): long-ringing inharmonic partials and a metallic strike. */
  note_tube(midi, vel, t, dur, role) {
    const f = mtof(midi), a = 0.2 * vel * (role === 'chord' ? 0.6 : 1);
    const bus = this.ctx.createGain();
    bus.connect(this.out);
    const send = this.ctx.createGain();
    send.gain.value = 0.55;
    bus.connect(send).connect(this.revIn);
    this.partial(bus, f, a, 3.6, t);
    this.partial(bus, f * 1.0018, a * 0.35, 3.2, t); // a slow shimmer (beating)
    this.partial(bus, f * 2.76, a * 0.3, 2.0, t);
    this.partial(bus, f * 5.4, a * 0.14, 1.0, t);
    this.partial(bus, f * 8.93, a * 0.06, 0.4, t);
    const src = this.ctx.createBufferSource(), hp = this.ctx.createBiquadFilter(), sg = this.ctx.createGain();
    src.buffer = this.white;
    hp.type = 'highpass'; hp.frequency.value = 5000;
    sg.gain.setValueAtTime(a * 0.5, t);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(hp).connect(sg).connect(bus);
    src.start(t);
    src.stop(t + 0.05);
  }

  /** A wooden tube: a hollow, pitched knock (bamboo / boomwhacker): short body + a woody click. */
  note_bamboo(midi, vel, t, dur, role) {
    const f = mtof(midi), a = 0.3 * vel * (role === 'chord' ? 0.6 : 1);
    const bus = this.ctx.createGain();
    const warm = this.ctx.createBiquadFilter();
    warm.type = 'lowpass'; warm.frequency.value = Math.min(9000, f * 8);
    bus.connect(warm).connect(this.out);
    const send = this.ctx.createGain();
    send.gain.value = 0.3;
    warm.connect(send).connect(this.revIn);
    const body = 0.35 + 0.25 * Math.max(0, (72 - midi) / 24); // lower tubes ring a little longer
    this.partial(bus, f, a, body, t);
    this.partial(bus, f * 2.01, a * 0.22, body * 0.4, t);
    this.partial(bus, f * 3.03, a * 0.1, body * 0.2, t);
    const src = this.ctx.createBufferSource(), bp = this.ctx.createBiquadFilter(), cg = this.ctx.createGain();
    src.buffer = this.white;
    bp.type = 'bandpass'; bp.frequency.value = Math.min(4000, f * 3); bp.Q.value = 2.5;
    cg.gain.setValueAtTime(a * 0.9, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    src.connect(bp).connect(cg).connect(bus);
    src.start(t);
    src.stop(t + 0.04);
  }

  /** A glass bottle: a clear, glassy ping (bright partials, quick to fade). */
  note_bottle(midi, vel, t, dur, role) {
    const f = mtof(midi), a = 0.2 * vel * (role === 'chord' ? 0.6 : 1);
    const bus = this.ctx.createGain();
    bus.connect(this.out);
    const send = this.ctx.createGain();
    send.gain.value = 0.45;
    bus.connect(send).connect(this.revIn);
    this.partial(bus, f, a, 1.5, t);
    this.partial(bus, f * 2.32, a * 0.22, 0.55, t);
    this.partial(bus, f * 4.1, a * 0.1, 0.22, t);
    this.partial(bus, f * 6.6, a * 0.04, 0.08, t);
  }

  /** A neon light tube: a buzzy electric synth with a mains-hum shimmer. */
  note_neon(midi, vel, t, dur, role) {
    const ctx = this.ctx, f = mtof(midi), v = 0.6 + 0.4 * vel;
    const amp = (role === 'chord' ? 0.03 : role === 'bass' ? 0.07 : 0.05) * v;
    const len = Math.max(0.15, Math.min(dur, 1.2));
    const g = this.voice({ echo: 0.25 });
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = Math.min(5000, f * 6); lp.Q.value = 1.5;
    const hum = ctx.createGain(); // ~100 Hz flicker, like a neon tube
    hum.gain.value = 1;
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 100; depth.gain.value = 0.18;
    lfo.connect(depth).connect(hum.gain);
    lp.connect(hum).connect(g);
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + len + 0.15);
    }
    lfo.start(t); lfo.stop(t + len + 0.15);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.006);
    g.gain.setTargetAtTime(amp * 0.7, t + 0.01, 0.08);
    g.gain.setValueAtTime(amp * 0.7, t + len);
    g.gain.linearRampToValueAtTime(0, t + len + 0.1);
  }

  /** A handbell: bright with the strong ring an octave and a fifth up, long decay. */
  note_bell(midi, vel, t, dur, role) {
    const f = mtof(midi), a = 0.17 * vel * (role === 'chord' ? 0.6 : 1);
    const bus = this.ctx.createGain();
    bus.connect(this.out);
    const send = this.ctx.createGain();
    send.gain.value = 0.5;
    bus.connect(send).connect(this.revIn);
    this.partial(bus, f, a, 2.6, t);
    this.partial(bus, f * 3.0, a * 0.45, 1.5, t); // the "twelfth"
    this.partial(bus, f * 2.0, a * 0.1, 1.2, t);
    this.partial(bus, f * 5.08, a * 0.14, 0.6, t);
    this.partial(bus, f * 1.003, a * 0.3, 2.2, t); // shimmer
  }

  /** A woodblock: a sharp, hollow click (high or low). */
  drum_woodblock(which, vel, t) {
    const f = which === 'low' ? 620 : 920;
    const bus = this.voice({ rev: 0.15 });
    bus.gain.value = 1;
    this.partial(bus, f, 0.45 * vel, 0.09, t, 'triangle');
    this.partial(bus, f * 2.7, 0.12 * vel, 0.03, t);
    const src = this.ctx.createBufferSource(), bp = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    src.buffer = this.white;
    bp.type = 'bandpass'; bp.frequency.value = f * 1.6; bp.Q.value = 3;
    g.gain.setValueAtTime(0.4 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.015);
    src.connect(bp).connect(g).connect(bus);
    src.start(t); src.stop(t + 0.03);
  }

  /** A cowbell: the classic two-tone drum-machine bell. */
  drum_cowbell(vel, t) {
    const ctx = this.ctx, bus = this.voice({ rev: 0.12 });
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1000; bp.Q.value = 1.2;
    bp.connect(bus);
    for (const f of [540, 800]) {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = f;
      o.connect(bp); o.start(t); o.stop(t + 0.45);
    }
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.linearRampToValueAtTime(0.32 * vel, t + 0.002);
    bus.gain.exponentialRampToValueAtTime(0.08 * vel, t + 0.06);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  }

  // ---------------------------------------------------------------- original instruments
  /** The original sound: one mallet instrument for every note (decaying sine partials). */
  mallet(kind, midi, vel, t) {
    const f = mtof(midi), a = 0.32 * vel * (kind === 'glock' ? 0.85 : 1);
    const low = clamp((midi - 40) / 50, 0, 1);
    const bus = this.ctx.createGain();
    bus.connect(this.out);
    const send = this.ctx.createGain();
    send.gain.value = 0.5;
    bus.connect(send).connect(this.revIn);
    if (kind === 'glock') {
      const d = 2.6 - 1.4 * low;
      this.partial(bus, f, a, d, t);
      this.partial(bus, f * 2.76, a * 0.3, d * 0.35, t);
      this.partial(bus, f * 5.4, a * 0.12, d * 0.15, t);
      this.partial(bus, f * 8.93, a * 0.05, 0.08, t);
    } else if (kind === 'vibes') {
      const trem = this.ctx.createGain();
      trem.connect(bus);
      const lfo = this.ctx.createOscillator(), depth = this.ctx.createGain();
      lfo.frequency.value = 5.2;
      depth.gain.value = 0.3;
      lfo.connect(depth).connect(trem.gain);
      lfo.start(t);
      lfo.stop(t + 3);
      this.partial(trem, f, a, 2.8 - low, t);
      this.partial(trem, f * 4, a * 0.12, 0.5, t);
      this.partial(bus, f * 10, a * 0.03, 0.02, t);
    } else { // marimba
      const d = 1.3 - 0.9 * low;
      this.partial(bus, f, a, d, t);
      this.partial(bus, f * 4, a * 0.22, d * 0.25, t);
      this.partial(bus, f * 9.9, a * 0.05, 0.025, t);
    }
  }

  drum_mallets(midi, vel, t) {
    const ctx = this.ctx;
    const bus = this.voice({ rev: 0.2 });
    bus.gain.value = 1;
    const noiseHit = (decay, amp, type, freq, q = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      const flt = ctx.createBiquadFilter();
      flt.type = type;
      flt.frequency.value = freq;
      flt.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      src.connect(flt).connect(g).connect(bus);
      src.start(t);
      src.stop(t + decay + 0.05);
    };
    if (midi === 35 || midi === 36) {
      const o = this.osc('sine', 140, t, t + 0.45, bus);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      const g = ctx.createGain();
      o.disconnect();
      o.connect(g).connect(bus);
      g.gain.setValueAtTime(0.9 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    } else if (midi >= 37 && midi <= 40) {
      noiseHit(0.18, 0.5 * vel, 'bandpass', 1900, 0.8);
      this.partial(bus, 190, 0.3 * vel, 0.1, t, 'triangle');
    } else if (CYM(midi)) noiseHit(midi === 46 || midi >= 49 ? 0.35 : 0.06, 0.25 * vel, 'highpass', 7000);
    else this.partial(bus, mtof(midi) / 2, 0.45 * vel, 0.3, t);
  }

  note_marimba(midi, vel, t) { this.mallet('marimba', midi, vel, t); }
}
