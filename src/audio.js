// Web Audio synth with retro "sound fonts". Every sound is synthesised here (no ripped game
// samples): each font imitates the *hardware* of a classic console sound chip.
//
//   nes      - NES 2A03-style: pulse waves (12.5/25/50% duty), 4-bit stepped triangle bass,
//              LFSR noise drums, 60 Hz stepped volume envelopes.
//   snes     - SNES SPC700-style: short low-rate 8-bit-ish sampled instruments that get
//              muffled when pitched down, Gaussian-ish low-pass, and the classic echo.
//   genesis  - Mega Drive/Genesis YM2612-style: 2-operator FM leads, slap bass and FM e-piano,
//              crunchy low-bit PCM drums.
//   mallets  - acoustic ensemble: marimba lead, vibraphone harmony.
//   marimba / glock / vibes - the original instruments: every note on one acoustic instrument,
//              built from decaying sine partials, with acoustic drums.
//
// Notes are scheduled ahead on the AudioContext clock, which also drives the animation, so
// sound and visuals stay locked together.

export const FONTS = [
  { id: 'nes', name: 'NES 8-bit (2A03-style)' },
  { id: 'snes', name: 'SNES 16-bit (SPC700-style)' },
  { id: 'genesis', name: 'Genesis FM (YM2612-style)' },
  { id: 'mallets', name: 'Acoustic mallets' },
  { id: 'marimba', name: 'Marimba' },
  { id: 'glock', name: 'Glockenspiel' },
  { id: 'vibes', name: 'Vibraphone' },
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function impulse(ctx, seconds) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  }
  return buf;
}

/** PeriodicWave from an arbitrary single-cycle function f(phase in [0,1)). */
function waveFrom(ctx, f, harmonics = 64) {
  const M = 4096;
  const real = new Float32Array(harmonics + 1), imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    let re = 0, im = 0;
    for (let k = 0; k < M; k++) {
      const ph = k / M, v = f(ph);
      re += v * Math.cos(2 * Math.PI * n * ph);
      im += v * Math.sin(2 * Math.PI * n * ph);
    }
    real[n] = (2 * re) / M;
    imag[n] = (2 * im) / M;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** 15-bit LFSR noise like the NES noise channel. short = 93-step metallic mode. */
function lfsrNoise(ctx, short, hold = 4) {
  const n = ctx.sampleRate; // 1 second, looped
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let reg = 1, out = 0;
  for (let i = 0; i < n; i++) {
    if (i % hold === 0) {
      const fb = (reg & 1) ^ ((reg >> (short ? 6 : 1)) & 1);
      reg = (reg >> 1) | (fb << 14);
      out = reg & 1 ? -1 : 1;
    }
    d[i] = out;
  }
  return buf;
}

/** Render a sample at a low rate with light quantisation (a little SNES-ish grit, not hiss). */
function makeSample(ctx, rate, seconds, fn, bits = 9) {
  const n = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  const q = Math.pow(2, bits - 1);
  for (let i = 0; i < n; i++) d[i] = Math.round(clamp(fn(i / rate), -1, 1) * q) / q;
  return buf;
}

export class Synth {
  constructor(ctx = null) { // pass an OfflineAudioContext to render offline (tests)
    ctx = this.ctx = ctx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(comp);
    // room reverb (mallets) and SNES-style echo (feedback delay through a low-pass)
    this.revIn = ctx.createGain();
    const rev = ctx.createConvolver();
    rev.buffer = impulse(ctx, 2.4);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.28;
    this.revIn.connect(rev).connect(revOut).connect(comp);
    this.echoIn = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.24;
    const fbLp = ctx.createBiquadFilter();
    fbLp.type = 'lowpass';
    fbLp.frequency.value = 2600;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.38;
    this.echoIn.connect(delay).connect(fbLp).connect(fb).connect(delay);
    fbLp.connect(echoOut).connect(comp);

    // NES bus: the console's output filters (gentle high-pass + low-pass take the edge off the
    // raw square waves), plus a short clean "pulse echo" like NES composers faked by hand.
    this.nesBus = ctx.createGain();
    const nesHp = ctx.createBiquadFilter(); nesHp.type = 'highpass'; nesHp.frequency.value = 50;
    const nesLp = ctx.createBiquadFilter(); nesLp.type = 'lowpass'; nesLp.frequency.value = 9000; nesLp.Q.value = 0.5;
    this.nesBus.connect(nesHp).connect(nesLp).connect(this.out);
    this.nesEcho = ctx.createGain();
    const nd = ctx.createDelay(1); nd.delayTime.value = 0.15;
    const nfb = ctx.createGain(); nfb.gain.value = 0.25;
    const nOut = ctx.createGain(); nOut.gain.value = 0.3;
    this.nesEcho.connect(nd).connect(nfb).connect(nd);
    nd.connect(nOut).connect(this.nesBus);

    // SNES bus: stereo ping-pong echo through a low-pass (the SPC700 echo + FIR), a touch of reverb
    this.snesBus = ctx.createGain();
    this.snesBus.connect(this.out);
    this.snesEcho = ctx.createGain();
    const dL = ctx.createDelay(1), dR = ctx.createDelay(1);
    dL.delayTime.value = 0.21; dR.delayTime.value = 0.21;
    const eLp = ctx.createBiquadFilter(); eLp.type = 'lowpass'; eLp.frequency.value = 3200;
    const efb = ctx.createGain(); efb.gain.value = 0.45;
    const pL = ctx.createStereoPanner(), pR = ctx.createStereoPanner();
    pL.pan.value = -0.7; pR.pan.value = 0.7;
    const eOut = ctx.createGain(); eOut.gain.value = 0.42;
    this.snesEcho.connect(eLp).connect(dL);
    dL.connect(dR); dR.connect(efb).connect(eLp);
    dL.connect(pL).connect(eOut); dR.connect(pR).connect(eOut);
    eOut.connect(this.out);
    const sRev = ctx.createGain(); sRev.gain.value = 0.35;
    this.snesBus.connect(sRev).connect(this.revIn);

    this.font = 'nes';
    this.waves = {
      pulse12: waveFrom(ctx, (p) => (p < 0.125 ? 1 : -1)),
      pulse25: waveFrom(ctx, (p) => (p < 0.25 ? 1 : -1)),
      pulse50: waveFrom(ctx, (p) => (p < 0.5 ? 1 : -1)),
      // NES triangle: 32 steps, 4-bit
      tri: waveFrom(ctx, (p) => { const s = Math.floor(p * 32); const v = s < 16 ? 15 - s : s - 16; return v / 7.5 - 1; }),
    };
    this.noiseLong = lfsrNoise(ctx, false);
    this.noiseShort = lfsrNoise(ctx, true);
    const white = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    this.white = white;
    this.crunch = ctx.createWaveShaper(); // shared low-bit quantiser for Genesis PCM drums
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.round(x * 12) / 12; }
    this.crunch.curve = curve;
    this.crunch.connect(this.out);
    this.snes = this.buildSnesSamples();
  }

  get latency() {
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  }

  /** A per-note output gain routed to a bus (+ optional reverb / echo sends). */
  voice({ rev = 0, echo = 0, bus = this.out, echoBus = this.echoIn, pan = 0 } = {}) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    if (pan) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(bus); }
    else g.connect(bus);
    if (echo) { const s = this.ctx.createGain(); s.gain.value = echo; g.connect(s).connect(echoBus); }
    if (rev) { const s = this.ctx.createGain(); s.gain.value = rev; g.connect(s).connect(this.revIn); }
    return g;
  }

  osc(type, freq, time, stop, dest) {
    const o = this.ctx.createOscillator();
    if (this.waves[type]) o.setPeriodicWave(this.waves[type]);
    else o.type = type;
    o.frequency.setValueAtTime(freq, time);
    o.connect(dest);
    o.start(time);
    o.stop(stop);
    return o;
  }

  /** NES-style volume envelope: 16 levels, updated at 60 Hz, hard cut at the end. */
  steppedEnv(param, time, dur, peak, decayTo, decayTime) {
    const frames = Math.max(1, Math.round(dur * 60));
    for (let f = 0; f <= frames; f++) {
      const u = Math.min(1, f / 60 / decayTime);
      const level = peak + (decayTo - peak) * u;
      param.setValueAtTime(Math.round(level * 15) / 15, time + f / 60);
    }
    param.setValueAtTime(0, time + dur);
  }

  adsr(param, time, dur, { a = 0.005, peak = 1, d = 0.2, s = 0.7, r = 0.08 }) {
    param.setValueAtTime(0, time);
    param.linearRampToValueAtTime(peak, time + a);
    param.setTargetAtTime(peak * s, time + a, d / 3);
    param.setValueAtTime(peak * s, time + Math.max(a, dur)); // approx; ramps from here
    param.setTargetAtTime(0, time + Math.max(a, dur), r / 3);
  }

  /**
   * All the notes of one pad hit. In the melody lane the top note is the lead and the rest are
   * a chord (which a font may play its own way, e.g. NES arpeggios); drums go by channel 10.
   */
  playHit(notes, time, role = 'lead', font = this.font, obj = null) {
    const pitched = notes.filter((n) => n.ch !== 9);
    for (const d of notes) if (d.ch === 9) this.play(d, time, role, font);
    if (!pitched.length) return;
    // arcade buttons and chime tubes have their own sound, whatever the font
    if (obj === 'button' || obj === 'tube') {
      const top = pitched.reduce((a, n) => (n.midi > a.midi ? n : a));
      for (const n of pitched) {
        const r = role === 'lead' && n !== top ? 'chord' : role;
        const dur = clamp(n.dur ?? 0.3, 0.06, 2.0), vel = n.vel ?? 0.8;
        if (obj === 'button') this.note_arcade(n.midi, vel, time, dur, r);
        else this.note_tube(n.midi, vel, time, dur, r);
      }
      return;
    }
    if (role !== 'lead') { for (const n of pitched) this.play(n, time, role, font); return; }
    const top = pitched.reduce((a, n) => (n.midi > a.midi ? n : a));
    this.play(top, time, 'lead', font);
    const rest = pitched.filter((n) => n !== top);
    if (!rest.length) return;
    if (this[`chord_${font}`]) this[`chord_${font}`](rest, time);
    else for (const n of rest) this.play(n, time, 'chord', font);
  }

  /** role: 'lead' | 'chord' | 'harmony' | 'bass' (drums are picked by MIDI channel 10). */
  play(note, time, role = 'lead', font = this.font) {
    const dur = clamp(note.dur ?? 0.3, 0.06, 2.0);
    const vel = note.vel ?? 0.8;
    if (note.ch === 9) return this[`drum_${font}`](note.midi, vel, time);
    return this[`note_${font}`](note.midi, vel, time, dur, role);
  }

  // ---------------------------------------------------------------- NES
  /**
   * NES-style volume envelope, 16 levels updated at 60 Hz: a quick drop from the attack peak to
   * a sustain level, a slow fade while held, then a few frames of release (no click).
   */
  nesEnv(param, t, dur, peak, { sus = 0.65, fade = 0.5, rel = 3 } = {}) {
    const frames = Math.max(2, Math.round(dur * 60));
    const q = (v) => Math.round((v / peak) * 15) / 15 * peak;
    for (let f = 0; f < frames; f++) {
      const attack = Math.max(0, 1 - f / 5); // first ~5 frames: peak -> sustain
      const held = Math.max(fade, 1 - (1 - fade) * (f / 60 / 1.2)); // slow fade while held
      param.setValueAtTime(q(peak * (sus + (1 - sus) * attack) * held), t + f / 60);
    }
    const last = peak * sus * Math.max(fade, 1 - (1 - fade) * (frames / 60 / 1.2));
    for (let f = 1; f <= rel; f++) param.setValueAtTime(q(last * (1 - f / (rel + 1))), t + (frames + f - 1) / 60);
    param.setValueAtTime(0, t + (frames + rel) / 60);
    return (frames + rel) / 60;
  }

  nesVoice(wave, f, t, dur, amp, { echo = 0, attackWave = null, vibrato = 0, env = {} } = {}) {
    const g = this.voice({ bus: this.nesBus, echo, echoBus: this.nesEcho });
    const len = this.nesEnv(g.gain, t, dur, amp, env);
    const o = this.osc(wave, f, t, t + len + 0.02, g);
    if (attackWave) { // a 2-frame thinner duty at the start gives notes a crisp "bite"
      const ga = this.voice({ bus: this.nesBus });
      ga.gain.setValueAtTime(amp * 0.7, t);
      ga.gain.setValueAtTime(0, t + 2 / 60);
      this.osc(attackWave, f, t, t + 3 / 60, ga);
    }
    if (vibrato && dur > 0.28) { // delayed vibrato, as NES composers loved to do
      const lfo = this.ctx.createOscillator(), depth = this.ctx.createGain();
      lfo.frequency.value = 6;
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(vibrato, t + 0.25);
      lfo.connect(depth).connect(o.detune);
      lfo.start(t);
      lfo.stop(t + len + 0.02);
    }
    return o;
  }

  note_nes(midi, vel, t, dur, role) {
    const f = mtof(midi), v = 0.6 + 0.4 * vel;
    if (role === 'bass') { // triangle: no volume control on the real chip; a 2-frame fade avoids clicks
      const g = this.voice({ bus: this.nesBus });
      const end = t + Math.max(dur, 0.1);
      g.gain.setValueAtTime(0.22, t);
      g.gain.setValueAtTime(0.22, end);
      g.gain.linearRampToValueAtTime(0, end + 2 / 60);
      this.osc('tri', f, t, end + 0.05, g);
      return;
    }
    if (role === 'lead') this.nesVoice('pulse25', f, t, Math.max(dur, 0.1), 0.15 * v, { echo: 0.6, attackWave: 'pulse12', vibrato: 14 });
    else if (role === 'harmony') this.nesVoice('pulse50', f, t, Math.max(dur, 0.1), 0.075 * v, { echo: 0.4, env: { sus: 0.55, fade: 0.4 } });
    else this.nesVoice('pulse50', f, t, Math.min(Math.max(dur, 0.1), 0.6), 0.06 * v, { env: { sus: 0.5, fade: 0.3 } });
  }

  /** Chords on the NES = one pulse channel cycling through the notes every 2 frames. */
  chord_nes(notes, t) {
    const dur = clamp(Math.max(...notes.map((n) => n.dur ?? 0.3)), 0.12, 0.7);
    const g = this.voice({ bus: this.nesBus, echo: 0.3, echoBus: this.nesEcho });
    const len = this.nesEnv(g.gain, t, dur, 0.065, { sus: 0.6, fade: 0.35 });
    const o = this.osc('pulse12', mtof(notes[0].midi), t, t + len + 0.02, g);
    const ms = notes.map((n) => n.midi).sort((a, b) => a - b);
    for (let f = 0, i = 0; f / 60 < len; f += 2, i++) o.frequency.setValueAtTime(mtof(ms[i % ms.length]), t + f / 60);
  }

  drum_nes(midi, vel, t) {
    const noise = (buf, rate, dur, amp) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = rate;
      const g = this.voice({ bus: this.nesBus });
      src.connect(g);
      this.steppedEnv(g.gain, t, dur, amp, 0, dur);
      src.start(t);
      src.stop(t + dur + 0.02);
    };
    const triDrop = (f0, f1, len, amp) => { // triangle pitch drop, stepped per frame like the chip
      const g = this.voice({ bus: this.nesBus });
      const o = this.osc('tri', f0, t, t + len + 0.03, g);
      const frames = Math.round(len * 60);
      for (let f = 0; f <= frames; f++) o.frequency.setValueAtTime(f0 * Math.pow(f1 / f0, f / frames), t + f / 60);
      g.gain.setValueAtTime(amp, t);
      g.gain.setValueAtTime(amp, t + len);
      g.gain.linearRampToValueAtTime(0, t + len + 0.015);
    };
    if (midi === 35 || midi === 36) { // triangle pitch-drop kick + a click of noise
      triDrop(170, 50, 0.1, 0.5 * vel);
      noise(this.noiseLong, 0.5, 0.035, 0.18 * vel);
    } else if (midi >= 37 && midi <= 40) { // snare: noise burst + a little triangle "body"
      noise(this.noiseLong, 0.45, 0.15, 0.26 * vel);
      triDrop(240, 140, 0.05, 0.22 * vel);
    } else if (midi === 42 || midi === 44) noise(this.noiseShort, 1, 0.035, 0.11 * vel);
    else if (midi === 46 || (midi >= 49 && midi <= 59)) noise(this.noiseLong, 1, 0.42, 0.12 * vel);
    else triDrop(mtof(midi), mtof(midi) / 2, 0.15, 0.4 * vel); // toms
  }

  // ---------------------------------------------------------------- SNES
  buildSnesSamples() {
    const ctx = this.ctx, R = 32000;
    // Looped samples use a base pitch whose period is a whole number of samples, so the loop
    // seam is click-free. The baked envelope is just the attack colour; the ADSR is applied live.
    const exact = (f) => R / Math.round(R / f);
    const add = (f0, parts) => (x) => parts.reduce((a, [h, amp, ph = 0]) => a + amp * Math.sin(2 * Math.PI * f0 * h * x + ph), 0);
    const looped = (f, seconds, body, attack = () => 0, loopFrom = 0.15) => {
      const base = exact(f), per = Math.round(R / f) / R;
      const fn = add(base, body);
      const buf = makeSample(ctx, R, seconds, (x) => 0.8 * (fn(x) + attack(x)));
      const ls = Math.ceil(loopFrom / per) * per;
      return { buf, base, loop: [ls, ls + Math.floor((seconds - ls - 0.01) / per) * per] };
    };
    const noise = () => Math.random() * 2 - 1;
    // lead: a reedy, slightly hollow synth-flute (odd harmonics strong) with a breathy chiff
    const lead = looped(mtof(72), 0.5, [[1, 0.6], [2, 0.12], [3, 0.3], [4, 0.05], [5, 0.14], [7, 0.06], [9, 0.03]],
      (x) => 0.35 * noise() * Math.exp(-x * 60));
    // harmony: a soft string-ish pad
    const pad = looped(mtof(60), 0.6, [[1, 0.5], [2, 0.3, 0.7], [3, 0.2, 1.3], [4, 0.14, 0.4], [5, 0.1, 2.1], [6, 0.07], [8, 0.04]]);
    // bass: picked bass, bright attack then a round looped tail
    const bassBase = exact(mtof(36)), bassFn = add(bassBase, [[1, 0.7], [2, 0.35], [3, 0.12]]);
    const bassBright = add(bassBase, [[4, 0.25], [5, 0.18], [6, 0.12], [7, 0.08]]);
    const bassBuf = makeSample(ctx, R, 0.9, (x) => 0.8 * (bassFn(x) + bassBright(x) * Math.exp(-x * 14) + 0.2 * noise() * Math.exp(-x * 200)));
    const bper = Math.round(R / mtof(36)) / R, bls = Math.ceil(0.4 / bper) * bper;
    // chord: a harp/piano-like pluck (decay baked in, no loop)
    const C5 = mtof(72);
    const harp = makeSample(ctx, R, 1.6, (x) => Math.min(1, x / 0.002) * 0.75 * (
      0.6 * Math.sin(2 * Math.PI * C5 * x) * Math.exp(-x * 2.2) + 0.25 * Math.sin(2 * Math.PI * C5 * 2.003 * x) * Math.exp(-x * 4) +
      0.12 * Math.sin(2 * Math.PI * C5 * 3.01 * x) * Math.exp(-x * 7) + 0.06 * Math.sin(2 * Math.PI * C5 * 4.02 * x) * Math.exp(-x * 11)));
    const kick = makeSample(ctx, 16000, 0.35, (x) => 0.95 * Math.sin(2 * Math.PI * (48 * x + 70 * (1 - Math.exp(-x * 35)) / 1.2)) * Math.exp(-x * 8) + 0.3 * noise() * Math.exp(-x * 300), 8);
    const snare = makeSample(ctx, 16000, 0.25, (x) => (noise() * 0.65 * Math.exp(-x * 14) + 0.5 * Math.sin(2 * Math.PI * 185 * x) * Math.exp(-x * 30)), 8);
    const hat = makeSample(ctx, 16000, 0.1, (x) => noise() * Math.exp(-x * 50) * 0.7, 7);
    const crash = makeSample(ctx, 16000, 1.0, (x) => noise() * Math.exp(-x * 3.2) * 0.6, 7);
    return { lead, pad, bass: { buf: bassBuf, base: bassBase, loop: [bls, bls + Math.floor(0.45 / bper) * bper] },
      harp: { buf: harp, base: C5 }, kick, snare, hat, crash };
  }

  /** One sample voice with an SNES-style hardware ADSR (exponential decay / release). */
  playSample(s, f, t, dur, amp, { echo = 0.35, adsr = {}, vibrato = 0, detune = 0, pan = 0 } = {}) {
    const { a = 0.008, d = 0.12, sus = 0.7, r = 0.08 } = adsr;
    const src = this.ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = f / s.base;
    src.detune.value = detune;
    if (s.loop) { src.loop = true; src.loopStart = s.loop[0]; src.loopEnd = s.loop[1]; }
    const lp = this.ctx.createBiquadFilter(); // the SNES Gaussian interpolation's soft top end
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(11000, 6000 * Math.sqrt(f / s.base) + 2000);
    lp.Q.value = 0.4;
    const g = this.voice({ bus: this.snesBus, echo, echoBus: this.snesEcho, pan });
    src.connect(lp).connect(g);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + a);
    g.gain.setTargetAtTime(amp * sus, t + a, d / 3);
    const end = t + Math.max(dur, a + 0.02);
    g.gain.setTargetAtTime(0, end, r / 3);
    if (vibrato && dur > 0.3) {
      const lfo = this.ctx.createOscillator(), depth = this.ctx.createGain();
      lfo.frequency.value = 5.2;
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(0, t + 0.2);
      depth.gain.linearRampToValueAtTime(vibrato, t + 0.5);
      lfo.connect(depth).connect(src.detune);
      lfo.start(t);
      lfo.stop(end + r * 2 + 0.05);
    }
    src.start(t);
    src.stop(end + r * 2 + 0.05);
  }

  note_snes(midi, vel, t, dur, role) {
    const f = mtof(midi), a = 0.42 * (0.55 + 0.45 * vel);
    const S = this.snes;
    if (role === 'lead') { // two slightly detuned copies spread left/right: the wide, chorused SNES lead
      for (const [det, pan] of [[-6, -0.35], [6, 0.35]])
        this.playSample(S.lead, f, t, Math.max(dur, 0.12), a * 0.5, { vibrato: 12, detune: det, pan, adsr: { d: 0.18, sus: 0.75, r: 0.1 } });
    } else if (role === 'bass') this.playSample(S.bass, f, t, Math.max(dur, 0.2), a * 0.95, { echo: 0.08, adsr: { a: 0.004, d: 0.3, sus: 0.55, r: 0.06 } });
    else if (role === 'harmony') this.playSample(S.pad, f, t, Math.max(dur, 0.3), a * 0.5, { echo: 0.4, adsr: { a: 0.03, d: 0.3, sus: 0.8, r: 0.25 } });
    else this.playSample(S.harp, f, t, Math.max(dur, 0.5), a * 0.5, { echo: 0.45, adsr: { a: 0.002, d: 0.6, sus: 0.6, r: 0.3 } });
  }

  drum_snes(midi, vel, t) {
    const S = this.snes;
    const buf = midi === 35 || midi === 36 ? S.kick : midi >= 37 && midi <= 40 ? S.snare : midi === 42 || midi === 44 ? S.hat
      : midi === 46 || (midi >= 49 && midi <= 59) ? S.crash : S.kick;
    const rate = !CYM(midi) && !(midi >= 35 && midi <= 40) ? mtof(midi) / mtof(45) : 1; // toms: pitched kick
    this.playSample({ buf, base: 1 }, rate, t, buf.duration, 0.6 * vel, { echo: 0.12, adsr: { a: 0.001, d: 2, sus: 0.98, r: 0.01 } });
  }

  // ---------------------------------------------------------------- Genesis / YM2612-style FM
  fm(f, t, dur, { ratio = 1, index = [2, 1], indexTime = 0.3, amp = 0.2, env = {}, detune = 0, dest }) {
    const ctx = this.ctx;
    const g = dest || this.voice({ echo: 0.06 });
    const stop = t + dur + 0.4;
    const car = this.osc('sine', f, t, stop, g);
    car.detune.value = detune;
    const mod = ctx.createOscillator();
    mod.frequency.value = f * ratio;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(index[0] * f * ratio, t);
    mg.gain.setTargetAtTime(index[1] * f * ratio, t, indexTime / 3);
    mod.connect(mg).connect(car.frequency);
    mod.start(t);
    mod.stop(stop);
    this.adsr(g.gain, t, dur, { peak: amp, ...env });
    return g;
  }

  note_genesis(midi, vel, t, dur, role) {
    const f = mtof(midi), v = 0.6 + 0.4 * vel;
    if (role === 'lead') { // brassy lead, two slightly detuned operators for width
      this.fm(f, t, dur, { ratio: 1, index: [3.2, 1.3], indexTime: 0.25, amp: 0.11 * v, detune: -5, env: { d: 0.3, s: 0.75, r: 0.1 } });
      this.fm(f, t, dur, { ratio: 1, index: [3.2, 1.3], indexTime: 0.25, amp: 0.11 * v, detune: 5, env: { d: 0.3, s: 0.75, r: 0.1 } });
    } else if (role === 'bass') { // slap bass
      this.fm(f, t, dur, { ratio: 1, index: [6, 0.8], indexTime: 0.1, amp: 0.3 * v, env: { d: 0.25, s: 0.45, r: 0.05 } });
    } else { // FM electric piano: body + tine
      const a = (role === 'chord' ? 0.08 : 0.13) * v;
      this.fm(f, t, Math.max(dur, 0.4), { ratio: 1, index: [1.8, 0.25], indexTime: 0.6, amp: a, env: { d: 1.2, s: 0.25, r: 0.25 } });
      this.fm(f, t, 0.08, { ratio: 14, index: [0.7, 0], indexTime: 0.05, amp: a * 0.35, env: { d: 0.06, s: 0, r: 0.03 } });
    }
  }

  drum_genesis(midi, vel, t) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.connect(this.crunch); // low-bit PCM crunch
    if (midi === 35 || midi === 36 || (!CYM(midi) && midi > 40)) {
      const f0 = midi <= 36 ? 150 : mtof(midi);
      const o = this.osc('sine', f0, t, t + 0.4, g);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.3, t + 0.12);
      g.gain.setValueAtTime(0.9 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      const flt = ctx.createBiquadFilter();
      const snare = midi >= 37 && midi <= 40;
      flt.type = snare ? 'bandpass' : 'highpass';
      flt.frequency.value = snare ? 2200 : 7500;
      const len = snare ? 0.2 : midi === 42 || midi === 44 ? 0.05 : 0.5;
      src.connect(flt).connect(g);
      g.gain.setValueAtTime((snare ? 0.7 : 0.3) * vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.start(t);
      src.stop(t + len + 0.02);
      if (snare) {
        const tone = this.osc('triangle', 210, t, t + 0.1, g);
        tone.frequency.exponentialRampToValueAtTime(140, t + 0.08);
      }
    }
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
  note_marimba(midi, vel, t) { this.mallet('marimba', midi, vel, t); }
  note_glock(midi, vel, t) { this.mallet('glock', midi, vel, t); }
  note_vibes(midi, vel, t) { this.mallet('vibes', midi, vel, t); }
  drum_marimba(midi, vel, t) { this.drum_mallets(midi, vel, t); }
  drum_glock(midi, vel, t) { this.drum_mallets(midi, vel, t); }
  drum_vibes(midi, vel, t) { this.drum_mallets(midi, vel, t); }

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

  note_mallets(midi, vel, t, dur, role) {
    const f = mtof(midi), a = 0.32 * vel * (role === 'chord' ? 0.6 : 1);
    const low = clamp((midi - 40) / 50, 0, 1);
    const bus = this.ctx.createGain();
    bus.connect(this.out);
    const send = this.ctx.createGain();
    send.gain.value = 0.5;
    bus.connect(send).connect(this.revIn);
    if (role === 'harmony') { // vibraphone
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
}

const CYM = (m) => m === 42 || m === 44 || m === 46 || (m >= 49 && m <= 59);
