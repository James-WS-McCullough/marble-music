// Music sources: note names, the tiny notation, built-in songs, the procedural generator,
// grouping into hits and splitting a song between the two marbles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteToMidi, parseVoice, SONGS, buildSong, generateSong, groupNotes, splitParts, assignObjects, songSections } from '../src/music.js';

test('note names map to MIDI numbers', () => {
  assert.equal(noteToMidi('C4'), 60);
  assert.equal(noteToMidi('A4'), 69);
  assert.equal(noteToMidi('C#4'), 61);
  assert.equal(noteToMidi('Db4'), 61);
  assert.equal(noteToMidi('B3'), 59);
  assert.equal(noteToMidi('C-1'), 0);
  assert.throws(() => noteToMidi('H4'));
});

test('the notation parses times, durations, chords and rests', () => {
  const ns = parseVoice('C4:q E4+G4:e r:e D4:h.', 120);
  assert.deepEqual(ns.map((n) => n.midi), [60, 64, 67, 62]);
  assert.deepEqual(ns.map((n) => n.t), [0, 0.5, 0.5, 1.0]); // q = 0.5 s at 120 bpm, rest skips 0.25 s
  assert.equal(ns[0].dur, 0.5);
  assert.equal(ns[3].dur, 1.5); // dotted half
  assert.throws(() => parseVoice('C4:x', 120));
});

test('every built-in song builds, with notes in order and a second voice', () => {
  for (const key of Object.keys(SONGS)) {
    const s = buildSong(key);
    assert.ok(s.notes.length > 20, key);
    assert.ok(s.notes.every((n) => Number.isFinite(n.t) && n.dur > 0 && n.midi >= 0 && n.midi < 128), key);
    assert.ok(s.notes.some((n) => n.ch === 1), `${key} has a second voice`);
  }
});

test('procedural songs are deterministic per seed and differ between seeds', () => {
  const a = generateSong(42), b = generateSong(42), c = generateSong(43);
  assert.deepEqual(a.notes, b.notes);
  assert.notDeepEqual(a.notes, c.notes);
  assert.ok(a.bpm > 60 && a.bpm < 200);
  for (const seed of [1, 2, 3, 7, 99]) {
    const s = generateSong(seed);
    assert.ok(s.notes.length > 30);
    assert.ok(s.notes.every((n) => n.dur > 0));
  }
});

test('grouping merges near-simultaneous notes into one hit', () => {
  const notes = [{ t: 0, midi: 60 }, { t: 0.05, midi: 64 }, { t: 0.2, midi: 67 }, { t: 0.5, midi: 72 }];
  const { groups } = groupNotes(notes);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups[0].notes.map((n) => n.midi), [60, 64]);
  assert.equal(groups[1].t, 0.2);
});

test('grouping truncates very long songs and says so', () => {
  const notes = Array.from({ length: 50 }, (_, i) => ({ t: i * 0.5, midi: 60 }));
  const r = groupNotes(notes, { maxGroups: 10 });
  assert.equal(r.groups.length, 10);
  assert.equal(r.truncated, true);
  assert.equal(groupNotes(notes).truncated, false);
});

test('splitting: harmony mode gives melody + harmony/bass and mutes drums', () => {
  const song = generateSong(42); // has drums
  const { parts, muted, second } = splitParts(song.notes, { second: 'harmony' });
  assert.equal(second, 'harmony');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].role, 'lead');
  assert.ok(['bass', 'harmony'].includes(parts[1].role));
  assert.ok(muted.length > 0 && muted.every((n) => n.ch === 9), 'drums are muted, not silently dropped');
  const used = parts.reduce((a, p) => a + p.notes.length, 0) + muted.length;
  assert.equal(used, song.notes.length, 'every note is either played by a marble or reported muted');
});

test('splitting: percussion mode puts all pitched notes on the melody marble', () => {
  const song = generateSong(42);
  const { parts, muted, second } = splitParts(song.notes, { second: 'percussion' });
  assert.equal(second, 'percussion');
  assert.equal(parts[1].role, 'drums');
  assert.equal(muted.length, 0);
  assert.equal(parts[0].notes.length + parts[1].notes.length, song.notes.length);
  assert.ok(parts[1].notes.every((n) => n.ch === 9));
});

test('splitting: auto picks percussion only when the song has drums; none = melody only', () => {
  assert.equal(splitParts(generateSong(42).notes, { second: 'auto' }).second, 'percussion');
  assert.equal(splitParts(buildSong('ode').notes, { second: 'auto' }).second, 'harmony');
  assert.equal(splitParts(buildSong('ode').notes, { second: 'percussion' }).second, 'harmony', 'no drums to play');
  const none = splitParts(buildSong('ode').notes, { second: 'none' });
  assert.equal(none.parts.length, 1);
});

test('objects: each marble can have its own instrument; drums stay drums', () => {
  const make = () => splitParts(buildSong('ode').notes, { second: 'harmony' }).parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups }));
  const kinds = (parts, k) => [...new Set(parts[k].groups.map((g) => g.obj))];
  for (const melody of ['key', 'button', 'tube', 'bamboo', 'bottle', 'neon', 'bell']) for (const harmony of ['bar', 'button', 'tube', 'bamboo', 'bottle', 'neon', 'bell']) {
    const parts = assignObjects(make(), { melody, harmony });
    assert.deepEqual(kinds(parts, 0), [melody]);
    assert.deepEqual(kinds(parts, 1), [harmony], 'an explicit choice applies even to a bass line');
  }
  assert.deepEqual(kinds(assignObjects(make(), { melody: 'mix', harmony: 'mix', bpm: 132 }), 1), ['bar'], 'the mix keeps a bass line on bars');
  const drums = splitParts(generateSong(42).notes, { second: 'percussion' }).parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups }));
  assignObjects(drums, { melody: 'bamboo', harmony: 'bamboo' });
  assert.deepEqual(kinds(drums, 1), ['kit'], 'drums stay on the drum kit by default');
  assert.deepEqual(kinds(drums, 0), ['bamboo']);
  assert.deepEqual(kinds(assignObjects(drums, { drums: 'blocks' }), 1), ['blocks'], 'or woodblocks & cowbells');
  const mixed = assignObjects(drums, { drums: 'mix', bpm: 131 });
  assert.equal(kinds(mixed, 1).length, 2, 'or both, by song section');
});

test('objects mix follows the song: sections of whole bars, repeats keep their instrument', () => {
  const song = buildSong('ode');
  const parts = splitParts(song.notes, { second: 'harmony' }).parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups }));
  const sec = songSections(parts, { bpm: song.bpm, bar: song.bar });
  assert.ok(Math.abs(sec.len - 4 * song.bar * 60 / song.bpm) < 1e-9, 'four-bar sections');
  assert.deepEqual(sec.labels, [0, 0, 1, 0], "Ode to Joy is A A' B A'");
  assignObjects(parts, { seed: 3, bpm: song.bpm, bar: song.bar });
  const objAt = (t) => parts[0].groups.find((g) => g.t >= t - 1e-9).obj;
  const L = sec.len;
  assert.equal(objAt(0), 'key', 'the first tune keeps the classic keys');
  assert.equal(objAt(L), 'key', 'its repeat too');
  assert.notEqual(objAt(2 * L), 'key', 'the contrasting section changes instrument');
  assert.equal(objAt(3 * L), 'key', 'and the theme comes back on keys');
  // changes only happen on section boundaries (pickups may lead in by a quarter beat)
  const beat = 60 / song.bpm, g = parts[0].groups;
  for (let i = 1; i < g.length; i++) if (g[i].obj !== g[i - 1].obj) {
    const pos = ((g[i].t - sec.t0 + 0.25 * beat) % L + L) % L;
    assert.ok(pos < 0.25 * beat + 1e-6 || L - pos < 1e-6, `change at ${g[i].t.toFixed(2)} s is on a section boundary`);
  }
  // both marbles change together: the harmony uses the melody's sections (when it isn't the bass)
  const tw = buildSong('twinkle');
  const twParts = splitParts(tw.notes, { second: 'harmony' }).parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups }));
  assert.deepEqual(songSections(twParts, { bpm: tw.bpm, bar: tw.bar }).labels, [0, 1, 0], 'Twinkle is A B A');
  const again = splitParts(song.notes, { second: 'harmony' }).parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups }));
  assignObjects(again, { seed: 3, bpm: song.bpm, bar: song.bar });
  assert.deepEqual(again[0].groups.map((x) => x.obj), g.map((x) => x.obj), 'deterministic');
});

test('a tune with little repetition gets longer sections (rare changes)', () => {
  const song = generateSong(1);
  const parts = splitParts(song.notes, { second: 'harmony' }).parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups }));
  const sec = songSections(parts, { bpm: song.bpm, bar: song.bar });
  assert.ok(sec.len >= 8 * song.bar * 60 / song.bpm - 1e-9, 'eight-bar sections');
  assert.ok(sec.labels.length <= 4);
});
