// Endless play: songs on one clock, each one handing over to the next exactly at a loop seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeItem, appendItem, itemAt, collect, settingsAt } from '../src/timeline.js';

const song = (D, extra = {}) => ({ D, events: [{ tau: 1, id: 'a' }, { tau: D - 1, id: 'b' }], beat: [], fx: [], initial: {}, ...extra });

test('a single item loops forever', () => {
  const items = [makeItem(song(10))];
  assert.equal(itemAt(items, 25).tau, 5);
  const ev = collect(items, 0, 30).filter((e) => e.kind === 'hit');
  assert.deepEqual(ev.map((e) => e.at), [1, 9, 11, 19, 21, 29]);
  assert.equal(collect(items, 0, 30).filter((e) => e.kind === 'start').length, 3, 'a start marker each time round');
});

test('appending switches songs at the next seam, never mid-loop', () => {
  const items = [makeItem(song(10))];
  const b = makeItem(song(7));
  appendItem(items, b, 13.2); // 13.2 s in: the first song finishes its second time round
  assert.equal(items[0].reps, 2);
  assert.equal(b.start, 20);
  assert.equal(itemAt(items, 19.99).item, items[0]);
  assert.equal(itemAt(items, 20).item, b);
  assert.ok(Math.abs(itemAt(items, 30).tau - 3) < 1e-9);
  const hits = collect(items, 0, 40).filter((e) => e.kind === 'hit');
  assert.deepEqual(hits.map((e) => +e.at.toFixed(6)), [1, 9, 11, 19, 21, 26, 28, 33, 35]);
  assert.ok(hits.slice(0, 4).every((e) => e.item === items[0]) && hits.slice(4).every((e) => e.item === b));
  // windows straddling the boundary see each event exactly once
  let n = 0;
  for (let t = 0; t < 40; t += 0.25) n += collect(items, t, t + 0.25).filter((e) => e.kind === 'hit').length;
  assert.equal(n, hits.length);
  // a song is always played at least once
  const c = makeItem(song(5));
  appendItem(items, c, 20.1);
  assert.equal(b.reps, 1);
  assert.equal(c.start, 27);
});

test('switch settings: initial state, then each switch; the beat plays only while switched on', () => {
  const it = makeItem(song(10, {
    initial: { beat: false, filter: true },
    fx: [{ tau: 2, set: { beat: true, filter: false } }, { tau: 6, set: { beat: false } }],
    beat: [1, 3, 5, 7].map((tau) => ({ tau, midi: 36 })),
  }));
  assert.deepEqual(settingsAt(it, 0), { beat: false, filter: true });
  assert.deepEqual(settingsAt(it, 2), { beat: true, filter: false });
  assert.deepEqual(settingsAt(it, 9), { beat: false, filter: false });
  const ev = collect([it], 0, 20);
  assert.deepEqual(ev.filter((e) => e.kind === 'beat').map((e) => e.at), [3, 5, 13, 15]);
  assert.deepEqual(ev.filter((e) => e.kind === 'fx').map((e) => e.at), [2, 6, 12, 16]);
});
