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
/** Choices for the melody marble and for the second marble's harmony/bass ('mix' = by section). */
export const MELODY_OBJECTS = ['mix', 'song', 'key', 'epiano', 'guitar', 'button', 'tube', 'bamboo', 'bottle', 'neon', 'bell'];
export const HARMONY_OBJECTS = ['mix', 'bar', 'vinyl', 'guitar', 'epiano', 'button', 'tube', 'bamboo', 'bottle', 'neon', 'bell'];
/** The drum marble: the standard kit, woodblocks & cowbells, or both by song section. */
export const DRUM_KITS = ['kit', 'blocks', 'mix'];

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

/**
 * Choose what each hit is played on: melody = MELODY_OBJECTS entry, harmony = HARMONY_OBJECTS
 * entry (for the second marble when it plays harmony or bass). An explicit choice is used for
 * every hit (even a bass line); 'mix' follows the song's sections (bass stays on bars).
 */
export function assignObjects(parts, { melody = 'mix', harmony = 'mix', drums = 'kit', seed = 1, bpm = 120, bar = 4, lofi = false } = {}) {
  const rng = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  const sections = melody === 'mix' || harmony === 'mix' || drums === 'mix' ? songSections(parts, { bpm, bar }) : null;
  const beat = 60 / bpm;
  const sectionOf = (t) => Math.min(sections.labels.length - 1, Math.max(0, Math.floor((t - sections.t0 + 0.25 * beat) / sections.len)));
  for (const p of parts) {
    if (p.style === 'drums') { // the kit: as chosen, or the standard kit for the first tune and blocks for others
      for (const g of p.groups) g.obj = drums === 'mix' ? (sections.labels[sectionOf(g.t)] % 2 ? 'blocks' : 'kit') : drums;
      continue;
    }
    const lead = p.role === 'lead', base = lofi ? (lead ? 'epiano' : 'vinyl') : lead ? 'key' : 'bar';
    const choice = lead ? melody : harmony;
    if (choice !== 'mix') { for (const g of p.groups) g.obj = choice; continue; }
    if (p.role === 'bass' || (lofi && !lead)) { for (const g of p.groups) g.obj = lofi ? 'vinyl' : 'bar'; continue; }
    // the first tune keeps the classic instrument; each new tune gets the next one (order by seed)
    // (lofi keeps to the mellow ones: e-piano, guitar, bamboo, bottles, bells)
    const others = lofi ? ['guitar', 'bamboo', 'bottle', 'bell'] : lead ? ['guitar', 'button', 'tube', 'bamboo', 'bottle', 'neon', 'bell'] : ['guitar', 'tube', 'bamboo', 'button', 'bottle', 'neon', 'bell'];
    for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
    const order = [base, ...others];
    for (const g of p.groups) g.obj = order[sections.labels[sectionOf(g.t)] % order.length];
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Lofi: jazzy 7th/9th chord progressions, a laid-back pentatonic melody that repeats every two
// bars, a swung boom-bap beat (a background track, not on a marble) and a structure of switch
// blocks: a muffled intro with vinyl crackle, the beat and full sound dropping in, a filter dip,
// and an outro. Deterministic per seed.
const MAJOR = [0, 2, 4, 5, 7, 9, 11], NAT_MINOR = [0, 2, 3, 5, 7, 8, 10], DORIAN = [0, 2, 3, 5, 7, 9, 10];
const LOFI_PROGRESSIONS = [
  { name: 'ii-V-I-vi', scale: MAJOR, chords: [[2, 'm9'], [5, '9'], [1, 'maj9'], [6, 'm7']] },
  { name: 'I-vi-ii-V', scale: MAJOR, chords: [[1, 'maj7'], [6, 'm9'], [2, 'm7'], [5, '7']] },
  { name: 'IV-iii-ii-I', scale: MAJOR, chords: [[4, 'maj7'], [3, 'm7'], [2, 'm9'], [1, 'maj9']] },
  { name: 'vi-IV-I-V', scale: MAJOR, chords: [[6, 'm9'], [4, 'maj7'], [1, 'maj9'], [5, '9']] },
  { name: 'I-iii-IV-iv', scale: MAJOR, chords: [[1, 'maj9'], [3, 'm7'], [4, 'maj7'], [4, 'm7']] },
  { name: 'ii-V vamp', scale: MAJOR, chords: [[2, 'm9'], [5, '9'], [2, 'm9'], [5, '9']] },
  { name: 'i-iv-VII-III', scale: NAT_MINOR, chords: [[1, 'm9'], [4, 'm7'], [7, '9'], [3, 'maj7']] },
  { name: 'i-VI-iv-v', scale: NAT_MINOR, chords: [[1, 'm7'], [6, 'maj7'], [4, 'm9'], [5, 'm7']] },
  { name: 'i-v-iv-VI', scale: NAT_MINOR, chords: [[1, 'm9'], [5, 'm7'], [4, 'm7'], [6, 'maj7']] },
  { name: 'i-IV dorian', scale: DORIAN, chords: [[1, 'm9'], [4, '9'], [1, 'm9'], [4, '9']] },
];
const CHORD_SHAPES = { maj7: [0, 4, 7, 11], maj9: [0, 4, 7, 11, 14], m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], 7: [0, 4, 7, 10], 9: [0, 4, 7, 10, 14] };
const LOFI_TITLES = ['rainy window', 'late night study', 'coffee & clouds', 'sleepy tram', 'paper lanterns', 'city lights',
  'quiet afternoon', 'warm tape', 'moonlit desk', 'slow sunday', 'snowfall', 'lost cassette', 'night bus', 'old polaroids',
  'tea gone cold', 'window seat', 'last train home', 'sunset rooftop', 'fog lights', 'library hush', 'soft focus', 'neon drizzle'];

// Song forms: 4-bar sections. I = the intro (the hook, muffled), A = the hook, A2 = the hook
// answered (comes home), B = a contrasting idea, B2 = B answered.
const LOFI_FORMS = [
  ['I', 'A', 'A2', 'B', 'A2'],
  ['I', 'A', 'B', 'A2'],
  ['I', 'A', 'B', 'B2', 'A2'],
  ['I', 'A2', 'B', 'A', 'A2'],
];
// Grooves: per-beat patterns (positions in beats within a bar) for the background beat.
// k = kick, s = snare, r = rim click, h = closed hat, o = open hat, x = shaker; v = velocity.
const LOFI_GROOVES = {
  boombap: { feel: 8, k: [[0, 2.5], [0, 1.75, 2.5]], s: [1, 3], h: 'eighths' },
  halftime: { feel: 8, k: [[0, 1.75], [0, 0.75, 1.75]], s: [2], h: 'eighths', ghost: [3.25] },
  shuffle: { feel: 16, k: [[0, 0.75, 2.5], [0, 2.25, 2.5]], s: [1, 3], h: 'sixteenths', ghost: [1.75, 3.75] },
  dilla: { feel: 8, k: [[0, 1.5, 2.75], [0, 0.75, 2.75]], s: [1, 3], h: 'eighths', late: 0.07 },
  bossa: { feel: 8, k: [[0, 1.5, 2, 3.5]], r: [[0, 1.5, 3], [1, 2]], h: 'shaker' },
  sparse: { feel: 8, k: [[0, 2.5], [0]], r: [[1, 3]], h: 'quarters' },
};
// Melody rhythm cells ([onset, length] in beats), by density
const LOFI_CELLS = {
  sparse: [[[0, 2], [2, 2]], [[0, 2], [2, 1], [3, 1]], [[0.5, 1.5], [2, 2]], [[0, 1.5], [1.5, 2.5]], [[0, 1], [1, 1], [2, 2]], [[0, 1], [1, 2], [3, 1]]],
  flowing: [
    [[0, 1], [1, 0.5], [1.5, 1.5], [3, 1]], [[0.5, 0.5], [1, 1], [2, 0.5], [2.5, 1.5]], [[0, 0.75], [0.75, 0.75], [1.5, 1], [2.5, 1.5]],
    [[0, 1.5], [1.5, 0.5], [2, 2]], [[1, 0.5], [1.5, 0.5], [2, 1], [3, 1]], [[0, 0.5], [0.5, 0.5], [1, 2], [3, 0.5], [3.5, 0.5]],
  ],
  busy: [
    [[0, 0.5], [0.5, 0.25], [0.75, 0.75], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5]],
    [[0, 0.25], [0.25, 0.25], [0.5, 1], [1.5, 0.5], [2, 0.5], [2.5, 1.5]],
    [[0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 0.5], [2.5, 0.5], [3, 1]],
    [[0, 0.75], [0.75, 0.25], [1, 0.5], [1.5, 1.5], [3, 0.25], [3.25, 0.75]],
    [[0, 0.5], [0.5, 0.5], [1, 0.25], [1.25, 0.75], [2, 2]],
  ],
};
const LOFI_SHAPES = [[1, 1, -2, 1], [-1, -1, 2, -1], [2, -1, -1, 1], [0, 1, -1, -2], [1, -2, 1, 1], [-2, 1, 1, -1], [1, 1, 1, -3], [-1, 2, -1, -1], [1, -1, 2, -1]];

/**
 * A procedural lofi song. Every seed draws its own groove (boom-bap, half-time, 16th shuffle,
 * Dilla-style, bossa, sparse) with its own swing and fills, its own form, chord rhythm, bass line,
 * melody density and progression - and writes the melody as a tune: a one-bar hook, sequenced
 * over the next chord and answered, mostly stepwise with the strong beats on the chord. Switch
 * blocks shape it: the beat drops in, the B section dips into the filter or breaks the beat
 * down, and the end goes back to how it started (seamless loop). Deterministic per seed.
 */
export function generateLofi(seed) {
  const rng = mulberry32((seed >>> 0) ^ 0x10f1);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const grooveName = pick(Object.keys(LOFI_GROOVES)), groove = LOFI_GROOVES[grooveName];
  const bpm = Math.round(grooveName === 'halftime' ? 78 + rng() * 14 : 68 + rng() * 20);
  const beat = 60 / bpm, bar = 4, barLen = bar * beat;
  const prog = pick(LOFI_PROGRESSIONS), scale = prog.scale;
  const root = 48 + Math.floor(rng() * 7); // C3 .. F#3
  const degree = (d) => root + scale[(d - 1) % 7] + 12 * Math.floor((d - 1) / 7);
  const form = pick(LOFI_FORMS), BARS = form.length * 4;
  const sectionAt = (b) => form[Math.floor(b / 4) % form.length]; // (past the end: the loop starts again)
  const bShift = pick([2, 1, 3]); // the B section's chords: the progression from another chord
  const chordOf = (b) => prog.chords[(sectionAt(b)[0] === 'B' ? b + bShift : b) % 4];
  const density = grooveName === 'shuffle' || grooveName === 'sparse' ? pick(['flowing', 'sparse']) : bpm <= 80 ? pick(['sparse', 'flowing', 'flowing', 'busy']) : pick(['sparse', 'flowing']);
  const comp = pick(['pad', 'pad', 'stabs', 'halves']);
  const bassStyle = comp === 'stabs' ? pick(['roots', 'walk']) : pick(['roots', 'sync', 'walk']);
  const sw8 = 0.03 + rng() * 0.11, sw16 = 0.02 + rng() * 0.05; // swing (in beats) for off-8ths / off-16ths
  const swing = (on) => { const f = ((on % 1) + 1) % 1; return on + (Math.abs(f - 0.5) < 1e-6 ? sw8 : Math.abs(f - 0.25) < 1e-6 || Math.abs(f - 0.75) < 1e-6 ? sw16 : 0); };
  const notes = [], beatTrack = [];

  // ---- chords (voice-led) + bass, on the second marble (channel 1)
  let prev = null;
  for (let b = 0; b < BARS; b++) {
    const [d, q] = chordOf(b), [dn] = chordOf(b + 1);
    const r = degree(d), shape = CHORD_SHAPES[q];
    let best = null; // the inversion nearest the previous voicing, around middle C
    for (let inv = 0; inv < shape.length; inv++) for (const oct of [0, 12, -12]) {
      const v = shape.map((iv, i) => r + iv + oct + (i < inv ? 12 : 0)).sort((x, y) => x - y);
      if (v[0] < 50 || v[v.length - 1] > 79) continue;
      const cost = prev ? v.reduce((a, m, i) => a + Math.abs(m - (prev[i] ?? prev[prev.length - 1])), 0) : Math.abs(v[0] - 57);
      if (!best || cost < best.cost) best = { v, cost };
    }
    const v = (prev = (best || { v: shape.map((iv) => r + iv + 12) }).v);
    const t0 = b * barLen, bass = r - 12, fifth = bass + 7, third = bass + shape[1];
    const chordAt = (on, len, vel = 0.45) => { for (const m of v) notes.push({ t: t0 + swing(on) * beat, dur: len * beat, midi: m, vel, ch: 1 }); };
    if (comp === 'pad') chordAt(b > 0 && rng() < 0.3 ? -0.5 : 0, bar * 0.95);
    else if (comp === 'stabs') { chordAt(0, 0.9); chordAt(1.5, 1.2, 0.4); }
    else { chordAt(0, 1.8); chordAt(2, 1.8, 0.4); }
    const bassAt = (on, len, midi, vel = 0.55) => notes.push({ t: t0 + swing(on) * beat, dur: len * beat, midi, vel, ch: 1 });
    if (bassStyle === 'roots') { bassAt(0, 1.8, bass, 0.6); bassAt(2, 1.5, rng() < 0.3 ? fifth : bass); }
    else if (bassStyle === 'sync') { bassAt(0, 1.5, bass, 0.6); bassAt(1.75, 1, bass); bassAt(3, 0.9, fifth, 0.5); }
    else if (bassStyle === 'long') bassAt(0, 3.6, bass, 0.6);
    else { // walking: root, third, fifth, then a step into the next chord's root
      const next = degree(dn) - 12, approach = next + (next > fifth ? -1 : 1);
      [bass, third, fifth, approach].forEach((m, i) => bassAt(i, 0.9, m, i ? 0.5 : 0.6));
    }
  }

  // ---- melody: a hook, built like a tune. Pitches are scale steps (idx 0 = the key's root, an
  // octave above the chords); notes on beats 1 and 3 land on the chord; phrases are question (ends
  // up in the air) and answer (comes home).
  const MEL0 = root + 12;
  const midiOf = (i) => MEL0 + scale[((i % 7) + 7) % 7] + 12 * Math.floor(i / 7);
  const isTone = (i, b) => [0, 2, 4].includes((((i - (chordOf(b)[0] - 1)) % 7) + 7) % 7);
  const toTone = (i, b, dir = 1) => { for (const d of [0, dir, -dir, 2 * dir, -2 * dir, 3]) if (isTone(i + d, b)) return i + d; return i; };
  const LO = -1, HI = 9; // the melody's range in scale steps (about a tenth)
  const fit = (i) => (i > HI ? i - 7 * Math.ceil((i - HI) / 7) : i < LO ? i + 7 * Math.ceil((LO - i) / 7) : i);
  const makeHook = () => {
    const shape = pick(LOFI_SHAPES), cells = shuffle(LOFI_CELLS[density]);
    return { a: cells[0], sa: shape, b: cells[1], sb: shape.map((x) => -x), c: cells[2 % cells.length], sc: pick(LOFI_SHAPES) };
  };
  const melody = [];
  let last = 4;
  const playCell = (cell, shape, start, b) => {
    let i = fit(start), same = 0;
    cell.forEach(([on, len], k) => {
      if (k > 0) {
        let step = shape[(k - 1) % shape.length];
        if (i + step > HI || i + step < LO) step = -step; // turn back at the edges of the range
        const prevI = i;
        i += step;
        if (on % 2 === 0) i = toTone(i, b, step >= 0 ? 1 : -1); // strong beats sit on the chord
        if (step !== 0 && i === prevI) i += step > 0 ? 1 : -1; // (don't let the snap undo the step)
        same = i === prevI ? same + 1 : 0;
        if (same >= 2) { i += i > (LO + HI) / 2 ? -1 : 1; same = 0; } // no more than two repeats
      } else if (on % 2 === 0) i = toTone(i, b);
      i = fit(i);
      melody.push({ b, on, len, i, strong: on % 2 === 0 });
    });
    last = i;
    return start;
  };
  const cadence = (b, home) => { // a step into a long note: home (the chord's root) or up in the air
    const cr = chordOf(b)[0] - 1;
    let target = home ? cr + 7 * Math.round((last - cr) / 7) : toTone(last + (last < HI - 2 ? 2 : -2), b);
    target = fit(target);
    if (target > HI - 1) target -= 7;
    if (target < LO + 1) target += 7;
    const lead = target + (last > target ? 1 : -1); // step into it from the side the tune comes from
    melody.push({ b, on: 0, len: 1, i: lead, strong: true });
    melody.push({ b, on: 1, len: home ? 2.5 : 2, i: target, strong: false });
    last = target;
  };
  const phrase = (h, b0, home, center) => {
    const s0 = playCell(h.a, h.sa, toTone(center, b0), b0); // the hook
    playCell(h.a, h.sa, toTone(s0, b0 + 1), b0 + 1); // ... again, from the next chord (a sequence)
    if (home) playCell(h.c, h.sc, toTone(last - 1, b0 + 2), b0 + 2); // a different turn on the way home
    else playCell(h.b, h.sb, toTone(last + 1, b0 + 2), b0 + 2);
    cadence(b0 + 3, home);
  };
  const hook = makeHook(), hookB = makeHook(), bCenter = pick([7, 6, 2]);
  form.forEach((sec, k) => {
    const b0 = k * 4;
    if (sec === 'B' || sec === 'B2') phrase(hookB, b0, sec === 'B2', bCenter);
    else phrase(hook, b0, sec === 'A2' || k === form.length - 1, 4);
  });
  for (const m of melody) {
    const t = (m.b * bar + swing(m.on)) * beat;
    const dur = Math.min(m.len * beat * 0.92, BARS * barLen - t - 0.05);
    if (dur <= 0.05) continue;
    notes.push({ t, dur, midi: midiOf(m.i), vel: (m.strong ? 0.68 : 0.56) + rng() * 0.08, ch: 0 });
  }

  // ---- the beat (a background track): the groove, varied a little by section, humanised
  const hum = () => (rng() - 0.5) * 0.02; // up to +-10 ms
  const hit = (b, on, midi, vel) => beatTrack.push({ t: Math.max(0, (b * bar + swing(on)) * beat + hum()), midi, vel: Math.min(1, vel * (0.9 + rng() * 0.2)), ch: 9, dur: 0.05 });
  const kickBars = groove.k.map((k) => k); // two kick patterns, alternating for a 2-bar phrase
  const fillStyle = pick(['snare', 'kick', 'none']);
  for (let b = 0; b < BARS; b++) {
    const sec = sectionAt(b), inB = sec[0] === 'B', lastOfSection = b % 4 === 3 && b < BARS - 1;
    const fill = lastOfSection && fillStyle !== 'none' && rng() < 0.75;
    for (const k of kickBars[b % kickBars.length]) if (!(fill && k >= 3)) hit(b, k, 36, 0.8);
    for (const s of groove.s || []) if (!(fill && s >= 3)) hit(b, s + (groove.late || 0), inB && grooveName === 'boombap' ? 37 : 38, 0.7);
    for (const g of groove.ghost || []) if (!fill) hit(b, g, 38, 0.18);
    for (const r of groove.r ? groove.r[b % groove.r.length] : []) hit(b, r, 37, 0.6);
    const hats = groove.h === 'sixteenths' ? 16 : groove.h === 'quarters' ? 4 : 8;
    for (let e = 0; e < hats; e++) {
      const on = (e * 4) / hats;
      if (fill && on >= 3) continue;
      if (groove.h === 'shaker') { hit(b, on, 70, e % 2 ? 0.5 : 0.8); if (e % 2) hit(b, on + 0.25, 70, 0.35); continue; }
      const open = e === hats - 1 && b % 2 === 1 && rng() < 0.4;
      const acc = groove.h === 'sixteenths' ? [0.65, 0.3, 0.45, 0.3][e % 4] : e % 2 ? 0.45 : 0.62;
      hit(b, on, open ? 46 : 42, (inB && grooveName !== 'sparse' ? 0.8 : 1) * acc);
    }
    if (fill) { // into the next section: a snare roll or a kick pickup
      if (fillStyle === 'snare') for (let k = 0; k < 4; k++) hit(b, 3 + k * 0.25, 38, 0.3 + k * 0.13);
      else { hit(b, 3, 38, 0.6); hit(b, 3.5, 36, 0.7); hit(b, 3.75, 36, 0.6); }
    }
  }

  // ---- the switch blocks, each thrown on the "and of 4" at the end of a phrase (the melody holds
  // its last note there, so the marble has a moment of its own) and landing on the next downbeat
  const beatInIntro = rng() < 0.35; // some intros already have the beat, muffled
  const initial = { beat: beatInIntro, filter: true, crackle: true };
  const bMode = pick(['dip', 'breakdown']); // the B section: muffled, or the beat drops out
  const at = (b) => (b * bar - 0.5) * beat;
  const fx = [];
  let inBNow = false;
  form.forEach((sec, k) => {
    if (k === 0) return;
    const b0 = k * 4, isB = sec[0] === 'B';
    if (k === 1) fx.push({ t: at(b0), set: isB ? { beat: bMode !== 'breakdown', filter: bMode !== 'dip' } : { beat: true, filter: false } });
    else if (isB && !inBNow) fx.push({ t: at(b0), set: bMode === 'dip' ? { filter: true } : { beat: false } });
    else if (!isB && inBNow) fx.push({ t: at(b0), set: bMode === 'dip' ? { filter: false } : { beat: true } });
    inBNow = isB;
  });
  fx.push({ t: at(BARS), set: { beat: initial.beat, filter: true } }); // the end: back to the start
  const title = pick(LOFI_TITLES);
  return { name: `lofi — ${title}`, notes, beat: beatTrack, fx, initial, bpm, bar, lofi: true, seed,
    style: { groove: grooveName, form: form.join(' '), density, comp, bass: bassStyle, progression: prog.name } };
}

/** Melody instruments for "one per song": each song (seed) gets the next one, so it changes every song. */
const SONG_INSTRUMENTS = ['key', 'guitar', 'bamboo', 'bell', 'bottle', 'tube', 'neon', 'button'];
const LOFI_SONG_INSTRUMENTS = ['epiano', 'guitar', 'bamboo', 'bell', 'bottle', 'key'];
export function instrumentForSong(seed, lofi = false) {
  const list = lofi ? LOFI_SONG_INSTRUMENTS : SONG_INSTRUMENTS;
  return list[((seed % list.length) + list.length) % list.length];
}

/**
 * Put the switch blocks on the melody marble, each as a hit of its own (no note: the marble hits
 * the switch, not an instrument). If a melody note is too close to fit a separate hit, the switch
 * moves a little earlier to the nearest free moment (up to a beat); only if there's none at all
 * does it share the note's hit. Call after grouping and assignObjects.
 */
export function attachSwitches(parts, fx, t0 = 0, { gap = 0.22, maxShift = 0.8 } = {}) {
  const lead = parts[0];
  for (const f of fx) {
    const want = f.t + t0;
    let g = null;
    for (let d = 0; d <= maxShift + 1e-9; d += 0.02) {
      const t = want - d;
      if (lead.groups.every((x) => Math.abs(x.t - t) >= gap)) { g = { t, notes: [] }; break; }
    }
    if (g) {
      lead.groups.push(g);
      lead.groups.sort((a, b) => a.t - b.t);
    } else g = lead.groups.reduce((a, x) => (Math.abs(x.t - want) < Math.abs(a.t - want) ? x : a));
    g.obj = 'switch';
    g.fx = f.set;
  }
  return parts;
}

