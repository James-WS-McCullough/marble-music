// MIDI parsing: builds small Standard MIDI Files byte by byte and checks what comes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi } from '../src/midi.js';

const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
function smf(tracks, division = 480) {
  const bytes = [...'MThd'].map((c) => c.charCodeAt(0)).concat(u32(6), u16(tracks.length > 1 ? 1 : 0), u16(tracks.length), u16(division));
  for (const ev of tracks) {
    const body = ev.flat();
    bytes.push(...[...'MTrk'].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body);
  }
  return new Uint8Array(bytes).buffer;
}
const tempo = (dt, us) => [...vlq(dt), 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255];
const on = (dt, ch, note, vel = 100) => [...vlq(dt), 0x90 | ch, note, vel];
const off = (dt, ch, note) => [...vlq(dt), 0x80 | ch, note, 64];
const end = () => [0, 0xff, 0x2f, 0];

test('notes get times in seconds and durations from their note-offs', () => {
  // 120 bpm (500000 us/beat), 480 ticks/beat: C4 for one beat, then E4 for half a beat
  const buf = smf([[tempo(0, 500000), on(0, 0, 60), off(480, 0, 60), on(0, 0, 64), off(240, 0, 64), end()]]);
  const ns = parseMidi(buf);
  assert.equal(ns.length, 2);
  assert.deepEqual(ns.map((n) => n.midi), [60, 64]);
  assert.ok(Math.abs(ns[0].t) < 1e-9 && Math.abs(ns[0].dur - 0.5) < 1e-9);
  assert.ok(Math.abs(ns[1].t - 0.5) < 1e-9 && Math.abs(ns[1].dur - 0.25) < 1e-9);
  assert.ok(Math.abs(ns[0].vel - 100 / 127) < 1e-9);
});

test('tempo changes are followed', () => {
  // one beat at 120 bpm (0.5 s), then switch to 240 bpm: the next beat lasts 0.25 s
  const buf = smf([[tempo(0, 500000), on(0, 0, 60), off(480, 0, 60), tempo(0, 250000), on(0, 0, 62), off(480, 0, 62), on(0, 0, 64), off(10, 0, 64), end()]]);
  const ns = parseMidi(buf);
  assert.ok(Math.abs(ns[1].t - 0.5) < 1e-9);
  assert.ok(Math.abs(ns[1].dur - 0.25) < 1e-9);
  assert.ok(Math.abs(ns[2].t - 0.75) < 1e-9);
});

test('running status and note-on with velocity 0 (as a note-off) are understood', () => {
  const body = [tempo(0, 500000), [0, 0x90, 60, 90], [...vlq(240), 62, 90], [...vlq(240), 60, 0], [...vlq(240), 62, 0], end()];
  const ns = parseMidi(smf([body]));
  assert.deepEqual(ns.map((n) => n.midi), [60, 62]);
  assert.ok(Math.abs(ns[0].dur - 0.5) < 1e-9);
  assert.ok(Math.abs(ns[1].t - 0.25) < 1e-9 && Math.abs(ns[1].dur - 0.5) < 1e-9);
});

test('several tracks (format 1) are merged, drums keep channel 10', () => {
  const t1 = [tempo(0, 500000), end()];
  const t2 = [on(0, 0, 60), off(480, 0, 60), end()];
  const t3 = [on(240, 9, 36), off(10, 9, 36), end()];
  const ns = parseMidi(smf([t1, t2, t3])).sort((a, b) => a.t - b.t);
  assert.equal(ns.length, 2);
  assert.equal(ns[1].ch, 9);
  assert.ok(Math.abs(ns[1].t - 0.25) < 1e-9);
});

test('a note without a note-off gets a default duration; bad files are rejected', () => {
  const ns = parseMidi(smf([[tempo(0, 500000), on(0, 0, 60), end()]]));
  assert.equal(ns[0].dur, 0.25);
  assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer), /Not a MIDI file/);
});
