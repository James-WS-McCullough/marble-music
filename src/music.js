// Music sources: a tiny text notation for built-in tunes, a procedural tune generator,
// and grouping of notes into "hits" (one marble can only hit one thing at a time).
//
// Note format everywhere: { t: seconds, midi: 0-127, vel: 0-1, ch: channel (9 = drums) }

import { mulberry32 } from './util.js';
import { CYMBALS } from './planner.js';

const NAMES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
export function noteToMidi(s) {
  const m = /^([A-Ga-g])(#|b)?(-?\d)$/.exec(s);
  if (!m) throw new Error(`Bad note "${s}"`);
  let v = NAMES[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return v + 12 * (parseInt(m[3], 10) + 1);
}

const DUR = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25 };
function parseDur(d) {
  if (!d) return 1;
  if (/^[\d.]+$/.test(d)) return parseFloat(d);
  let v = DUR[d[0]];
  if (v === undefined) throw new Error(`Bad duration "${d}"`);
  if (d.endsWith('.')) v *= 1.5;
  return v;
}

/** Parse "C4:q E4+G4:e r:e |" into notes. Durations in beats: w h q e s, "." = dotted, or a number. */
export function parseVoice(src, bpm, { ch = 0, vel = 0.8 } = {}) {
  const notes = [];
  let beat = 0;
  for (const tok of src.trim().split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const [p, d] = tok.split(':');
    const dur = parseDur(d);
    if (p !== 'r') for (const nm of p.split('+')) notes.push({ t: (beat * 60) / bpm, dur: (dur * 60) / bpm, midi: noteToMidi(nm), vel, ch });
    beat += dur;
  }
  return notes;
}

// Public-domain melodies.
export const SONGS = {
  ode: {
    name: 'Ode to Joy (Beethoven)',
    bpm: 132,
    bar: 4, // beats per bar
    voices: [
      {
        vel: 0.85,
        src: `E4:q E4:q F4:q G4:q | G4:q F4:q E4:q D4:q | C4:q C4:q D4:q E4:q | E4:q. D4:e D4:h |
              E4:q E4:q F4:q G4:q | G4:q F4:q E4:q D4:q | C4:q C4:q D4:q E4:q | D4:q. C4:e C4:h |
              D4:q D4:q E4:q C4:q | D4:q E4:e F4:e E4:q C4:q | D4:q E4:e F4:e E4:q D4:q | C4:q D4:q G3:h |
              E4:q E4:q F4:q G4:q | G4:q F4:q E4:q D4:q | C4:q C4:q D4:q E4:q | D4:q. C4:e C4:h`,
      },
      {
        ch: 1,
        vel: 0.55,
        src: `C3:h E3:h | G2:h B2:h | C3:h E3:h | G2:h G2:h | C3:h E3:h | G2:h B2:h | C3:h G2:h | C3:w |
              G2:h B2:h | C3:h E3:h | G2:h B2:h | G2:h D3:h | C3:h E3:h | G2:h B2:h | C3:h G2:h | C3:w`,
      },
    ],
  },
  twinkle: {
    name: 'Twinkle Twinkle Little Star',
    bpm: 110,
    bar: 4,
    voices: [
      {
        vel: 0.85,
        src: `C5:q C5:q G5:q G5:q | A5:q A5:q G5:h | F5:q F5:q E5:q E5:q | D5:q D5:q C5:h |
              G5:q G5:q F5:q F5:q | E5:q E5:q D5:h | G5:q G5:q F5:q F5:q | E5:q E5:q D5:h |
              C5:q C5:q G5:q G5:q | A5:q A5:q G5:h | F5:q F5:q E5:q E5:q | D5:q D5:q C5:h`,
      },
      {
        ch: 1,
        vel: 0.5,
        src: `C4:h E4:h | F4:h E4:h | D4:h C4:h | G3:h C4:h | E4:h D4:h | C4:h G3:h | E4:h D4:h | C4:h G3:h |
              C4:h E4:h | F4:h E4:h | D4:h C4:h | G3:h C4:h`,
      },
    ],
  },
  elise: {
    name: 'Für Elise, opening (Beethoven)',
    bpm: 68,
    bar: 1.5, // 3/8 time
    voices: [
      {
        vel: 0.8,
        src: `E5:s D#5:s E5:s D#5:s E5:s B4:s D5:s C5:s A4:e r:s C4:s E4:s A4:s B4:e r:s E4:s G#4:s B4:s C5:e r:s
              E4:s E5:s D#5:s E5:s D#5:s E5:s B4:s D5:s C5:s A4:e r:s C4:s E4:s A4:s B4:e r:s E4:s C5:s B4:s A4:q`,
      },
      {
        ch: 1,
        vel: 0.5,
        src: `r:2 A2:s E3:s A3:s r:s r:e E2:s E3:s G#3:s r:s r:e A2:s E3:s A3:s r:s r:2
              A2:s E3:s A3:s r:s r:e E2:s E3:s G#3:s r:s r:e A2:s E3:s A3:q`,
      },
    ],
  },
};

export function buildSong(key) {
  const s = SONGS[key];
  const notes = s.voices.flatMap((v) => parseVoice(v.src, s.bpm, v));
  return { name: s.name, notes, bpm: s.bpm, bar: s.bar || 4 };
}

// ---------------------------------------------------------------------------------------------
// Procedural tune generator: chord progression + rhythm cells + chord-tone-aware random walk,
// arranged A A' B A' so it has repetition (which makes it sound like a "real" tune).

const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
const PROGS = [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 0], [5, 3, 0, 4], [0, 0, 3, 4], [0, 5, 1, 4]];
const CELLS = [
  [1, 1, 1, 1], [0.5, 0.5, 1, 1, 1], [1.5, 0.5, 1, 1], [0.5, 0.5, 0.5, 0.5, 1, 1],
  [1, 0.5, 0.5, 1, 1], [0.75, 0.25, 0.5, 0.5, 1, 1], [1, 1, 2], [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1],
];
const CADENCES = [[1, 1, 2], [2, 2], [1, 0.5, 0.5, 2], [0.5, 0.5, 1, 2]];
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function generateSong(seed) {
  const rng = mulberry32(seed);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const modeName = pick(Object.keys(MODES));
  const scale = MODES[modeName];
  const root = 60 + Math.floor(rng() * 7) - 3;
  const bpm = Math.round(92 + rng() * 44);
  const prog = pick(PROGS);
  const withDrums = rng() < 0.4;
  const deg2midi = (d) => root + 12 * Math.floor(d / 7) + scale[((d % 7) + 7) % 7];

  const snapToChord = (deg, chord) => {
    let best = deg, bd = Infinity;
    for (let k = -2; k <= 2; k++)
      for (const c of [0, 2, 4]) {
        const cand = chord + c + 7 * k;
        const dd = Math.abs(cand - deg);
        if (dd < bd) { bd = dd; best = cand; }
      }
    return best;
  };

  // A bar = list of {beat, deg, dur} relative to bar start.
  function makeBar(chord, rhythm, startDeg, cadence = false) {
    const out = [];
    let deg = startDeg, b = 0;
    rhythm.forEach((dur, idx) => {
      if (Number.isInteger(b) && b % 2 === 0) deg = snapToChord(deg, chord);
      else deg += pick([-2, -1, -1, 1, 1, 2, 0]);
      deg = Math.max(-3, Math.min(11, deg));
      if (cadence && idx === rhythm.length - 1) deg = deg > 3 ? 7 : 0;
      out.push({ beat: b, deg, dur });
      b += dur;
    });
    return { notes: out, end: deg };
  }

  function phrase(rhythms, startDeg, cadence) {
    const bars = [];
    let d = startDeg;
    for (let i = 0; i < 4; i++) {
      const bar = makeBar(prog[i], rhythms[i], d, cadence && i === 3);
      bars.push(bar.notes);
      d = bar.end;
    }
    return bars;
  }

  const rA = pick(CELLS), rB = pick(CELLS), rC = pick(CELLS), rD = pick(CELLS);
  const A = phrase([rA, rB, rA, rC], 2 + Math.floor(rng() * 3), false);
  const A2 = A.slice(0, 3).concat([makeBar(prog[3], pick(CADENCES), A[2].at(-1).deg, true).notes]);
  const B = phrase([rD, rD, rB, rC], 6, false);
  const bars = [...A, ...A2, ...B, ...A2];

  const notes = [];
  const sec = (beat) => (beat * 60) / bpm;
  const bassStyle = Math.floor(rng() * 3);
  bars.forEach((bar, bi) => {
    const t0 = bi * 4;
    for (const nt of bar) notes.push({ t: sec(t0 + nt.beat), dur: sec(nt.dur), midi: deg2midi(nt.deg + 7), vel: 0.85, ch: 0 });
    const chord = prog[bi % 4];
    const bass = (d) => deg2midi(chord + d - 7);
    if (bassStyle === 0) {
      notes.push({ t: sec(t0), dur: sec(2), midi: bass(0), vel: 0.55, ch: 1 }, { t: sec(t0 + 2), dur: sec(2), midi: bass(4), vel: 0.5, ch: 1 });
    } else if (bassStyle === 1) {
      [0, 1, 2, 3].forEach((b, k) => notes.push({ t: sec(t0 + b), dur: sec(1), midi: bass([0, 4, 7, 4][k]), vel: 0.45, ch: 1 }));
    } else {
      notes.push({ t: sec(t0), dur: sec(2.5), midi: bass(0), vel: 0.55, ch: 1 }, { t: sec(t0 + 2.5), dur: sec(1.5), midi: bass(2), vel: 0.45, ch: 1 });
    }
    if (withDrums) {
      const hit = (beat, midi, vel) => notes.push({ t: sec(t0 + beat), dur: 0.1, midi, vel, ch: 9 });
      hit(0, 36, 0.8); hit(2, 36, 0.7); hit(1, 38, 0.6); hit(3, 38, 0.6);
      for (const b of [0.5, 1.5, 2.5, 3.5]) hit(b, 42, 0.35);
    }
  });
  const endT = sec(bars.length * 4);
  notes.push({ t: endT, dur: sec(4), midi: root + 12, vel: 0.9, ch: 0 }, { t: endT, dur: sec(4), midi: root + 7, vel: 0.6, ch: 0 },
    { t: endT, dur: sec(4), midi: root - 12, vel: 0.6, ch: 1 });

  const name = `Procedural #${seed} — ${NOTE_NAMES[((root % 12) + 12) % 12]} ${modeName}, ${bpm} bpm${withDrums ? ', drums' : ''}`;
  return { name, notes, bpm, bar: 4 };
}

/**
 * Merge notes that are (nearly) simultaneous into one hit. Notes keep their own time for audio,
 * the group time is when the marble strikes. Very fast passages merge into chords.
 */
export function groupNotes(notes, { merge = 0.075, maxGroups = 700, maxSeconds = 150 } = {}) {
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  const t0 = sorted.length ? sorted[0].t : 0;
  const groups = [];
  let truncated = false;
  for (const n of sorted) {
    if (n.t - t0 > maxSeconds) { truncated = true; break; }
    const g = groups[groups.length - 1];
    if (g && n.t - g.t < merge) g.notes.push(n);
    else {
      if (groups.length >= maxGroups) { truncated = true; break; }
      groups.push({ t: n.t, notes: [n] });
    }
  }
  return { groups, truncated };
}

// ---------------------------------------------------------------------------------------------
// Split a song into instrument parts, one marble each (max `maxLanes`). Each pad then matches
// exactly one sound: melody keys, bass bars, drums, cymbals.

const avgPitch = (ns) => ns.reduce((a, n) => a + n.midi, 0) / ns.length;

function polyphony(ns) {
  const { groups } = groupNotes(ns, { merge: 0.03, maxGroups: Infinity, maxSeconds: Infinity });
  return ns.length / Math.max(1, groups.length);
}

/** Highest note of each chord -> upper part, the rest -> lower part. */
function skyline(ns) {
  const { groups } = groupNotes(ns, { merge: 0.03, maxGroups: Infinity, maxSeconds: Infinity });
  const upper = [], lower = [];
  for (const g of groups) {
    const top = g.notes.reduce((a, b) => (b.midi > a.midi ? b : a));
    for (const n of g.notes) (n === top ? upper : lower).push(n);
  }
  return { upper, lower };
}

/**
 * Split a song into (at most) two marbles:
 *   lane 1: the melody, carrying the other notes too as chords where there's no harmony lane
 *   lane 2: either the harmony/bass notes or the percussion
 * second: 'auto' (percussion if the song has drums), 'harmony', 'percussion' or 'none'.
 * Notes no marble plays are returned in `muted` (they aren't played, so every sound you hear
 * has an object you can see).
 */
export function splitParts(notes, { second = 'auto' } = {}) {
  const drums = notes.filter((n) => n.ch === 9);
  const pitched = notes.filter((n) => n.ch !== 9);
  if (second === 'auto') second = drums.length >= 8 ? 'percussion' : 'harmony';
  if (second === 'percussion' && !drums.length) second = 'harmony';

  // find the melody: the highest of the busy channels; a single chordal channel -> skyline
  const byCh = new Map();
  for (const n of pitched) { if (!byCh.has(n.ch)) byCh.set(n.ch, []); byCh.get(n.ch).push(n); }
  let chans = [...byCh.values()].map((ns) => ({ notes: ns, avg: avgPitch(ns) })).sort((a, b) => b.notes.length - a.notes.length);
  let melody = [], rest = [];
  if (chans.length === 1) {
    if (polyphony(chans[0].notes) > 1.25 && second === 'harmony') ({ upper: melody, lower: rest } = skyline(chans[0].notes));
    else melody = chans[0].notes;
  } else if (chans.length) {
    const maxN = chans[0].notes.length;
    const mi = chans.reduce((bi, c, i) => (c.notes.length >= 0.3 * maxN && c.avg > chans[bi].avg ? i : bi), 0);
    melody = chans[mi].notes;
    rest = chans.filter((_, i) => i !== mi).flatMap((c) => c.notes);
  }

  const parts = [];
  const muted = [];
  if (second === 'harmony' && rest.length) {
    parts.push({ name: 'Melody', style: 'keys', role: 'lead', notes: melody });
    const avg = avgPitch(rest);
    parts.push({ name: avg < 52 ? 'Bass' : 'Harmony', style: 'bars', role: avg < 52 ? 'bass' : 'harmony', notes: rest });
    muted.push(...drums);
  } else if (second === 'percussion') {
    parts.push({ name: 'Melody', style: 'keys', role: 'lead', notes: [...melody, ...rest] });
    parts.push({ name: 'Drums', style: 'drums', role: 'drums', notes: drums });
  } else {
    parts.push({ name: 'Melody', style: 'keys', role: 'lead', notes: [...melody, ...rest] });
    muted.push(...drums);
  }
  return { parts: parts.filter((p) => p.notes.length), muted, second };
}

// ---------------------------------------------------------------------------------------------
// What each hit is played on. 'classic' = keys (melody) and bars (harmony/bass); 'arcade' =
// light-up arcade buttons; 'chimes' = hanging chime tubes. 'mix' follows the song's structure:
// it's cut into sections of whole bars (4, or 8 if the tune hardly repeats), each section's
// melody is compared with the earlier ones, and a repeat gets the same instrument again - so
// Ode to Joy's A A' B A' plays keys, keys, buttons, keys. Instruments only change on section
// boundaries, together in both marbles. The bass always stays on bars, drums stay drums.
// Sets g.obj on each group; deterministic for a seed.
export const OBJECT_MODES = ['mix', 'classic', 'arcade', 'chimes'];

/**
 * The song's sections: { t0, len, labels } where section i covers [t0 + i len, t0 + (i+1) len)
 * and labels[i] is the same number for sections whose melody (near-)repeats.
 */
export function songSections(parts, { bpm = 120, bar = 4 } = {}) {
  const beat = 60 / bpm;
  const all = parts.flatMap((p) => p.groups);
  if (!all.length) return { t0: 0, len: 1, labels: [0] };
  const t0 = Math.min(...all.map((g) => g.t)), tEnd = Math.max(...all.map((g) => g.t));
  const lead = parts[0].groups;
  const label = (bars) => {
    const len = bars * bar * beat;
    const n = Math.max(1, Math.floor((tEnd - t0) / len + 1e-6) + 1);
    // each section's melody as (onset in quarter beats, top pitch), pickups count with the next
    const secs = Array.from({ length: n }, () => []);
    for (const g of lead) {
      const i = Math.min(n - 1, Math.floor((g.t - t0 + 0.25 * beat) / len));
      const top = Math.max(...g.notes.filter((x) => x.ch !== 9).map((x) => x.midi), -1);
      secs[i].push([Math.round((g.t - t0 - i * len) / (beat / 4)), top]);
    }
    const similar = (a, b) => {
      if (!a.length || !b.length) return a.length === b.length;
      const set = new Set(b.map(([o, m]) => `${o}:${m}`));
      return a.filter(([o, m]) => set.has(`${o}:${m}`)).length / Math.max(a.length, b.length) >= 0.6;
    };
    const labels = [], reps = [];
    for (const sec of secs) {
      let l = reps.findIndex((r) => similar(sec, r));
      if (l < 0) { l = reps.length; reps.push(sec); }
      labels.push(l);
    }
    return { t0, len, labels, distinct: reps.length };
  };
  const four = label(4);
  // a tune with little repetition: use longer sections, so changes stay rare
  return four.distinct > Math.max(2, four.labels.length / 2) ? label(8) : four;
}

export function assignObjects(parts, { mode = 'mix', seed = 1, bpm = 120, bar = 4 } = {}) {
  const rng = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  const sections = mode === 'mix' ? songSections(parts, { bpm, bar }) : null;
  const beat = 60 / bpm;
  for (const p of parts) {
    if (p.style === 'drums') continue;
    const base = p.style === 'bars' ? 'bar' : 'key';
    if (mode === 'classic' || p.role === 'bass') { for (const g of p.groups) g.obj = base; continue; }
    if (mode === 'arcade' || mode === 'chimes') { for (const g of p.groups) g.obj = mode === 'arcade' ? 'button' : 'tube'; continue; }
    // the first tune keeps the classic instrument; each new tune gets the next one (order by seed)
    const others = p.role === 'lead' ? ['button', 'tube'] : ['tube', 'button'];
    if (rng() < 0.5) others.reverse();
    const order = [base, ...others];
    const { t0, len, labels } = sections;
    for (const g of p.groups) {
      const i = Math.min(labels.length - 1, Math.max(0, Math.floor((g.t - t0 + 0.25 * beat) / len)));
      g.obj = order[labels[i] % order.length];
    }
  }
  return parts;
}
