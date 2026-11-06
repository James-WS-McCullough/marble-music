// Music sources: note names, the tiny notation, built-in songs, the procedural generator,
// grouping into hits and splitting a song between the two marbles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteToMidi, parseVoice, SONGS, buildSong, generateSong, groupNotes, splitParts } from '../src/music.js';

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
