// The course contract: what every planned marble run must satisfy, for built-in songs,
// procedural songs, awkward MIDI-shaped stress songs, and different paces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCourse, marbleAt, padShape, lastHitIndex, MARBLE_R, toPlain, rehydratePlan } from '../src/planner.js';
import { buildSong, generateSong, groupNotes, splitParts, assignObjects, SONGS } from '../src/music.js';
import { stressSongs } from './stress-songs.js';
import { clipReport } from './clip-check.js';

const SONG_LIST = [
  ...Object.keys(SONGS).map(buildSong),
  ...[1, 2, 3, 42, 777, 9001].map(generateSong),
  generateSong(150), // regression: a pad once landed 6 mm inside an earlier pad (landing spot unchecked)
  ...stressSongs(),
];

const cache = new Map();
/** Plan a song once per (second marble, pace) and reuse it across tests. */
function planFor(song, second, vMax = 2.3) {
  const key = `${song.name}|${second}|${vMax}`;
  if (!cache.has(key)) {
    const split = splitParts(song.notes, { second });
    if (split.second !== second) { cache.set(key, null); return null; }
    const parts = assignObjects(split.parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups })), { mode: 'mix', seed: 7 });
    const t0 = Date.now();
    const plan = planCourse(parts, { seed: 7, vMax });
    cache.set(key, { plan, parts, ms: Date.now() - t0 });
  }
  return cache.get(key);
}

const ratio = (h) => Math.hypot(h.vout.x, h.vout.y) / Math.hypot(h.vin.x, h.vin.y);

for (const song of SONG_LIST) for (const second of ['harmony', 'percussion']) {
  const name = `${song.name} [${second}]`;

  test(name, async (t) => {
    const r = planFor(song, second);
    if (!r) return t.skip('song has no drums for a percussion marble');
    const { plan, parts } = r;

    await t.test('each pad is the object chosen for it (keys, bars, buttons, tubes, drums)', () => {
      plan.lanes.forEach((lane, k) => lane.hits.forEach((h, i) => {
        const obj = parts[k].groups[i].obj;
        if (obj) assert.equal(h.type, obj);
        else assert.ok(['kick', 'snare', 'tom', 'hat', 'crash'].includes(h.type));
      }));
    });

    await t.test('every note is played exactly once, at its moment', () => {
      plan.lanes.forEach((lane, k) => {
        const want = parts[k].notes.length;
        const got = lane.hits.reduce((a, h) => a + h.notes.length, 0);
        assert.equal(got, want, `${lane.name}: ${got} of ${want} notes`);
        for (let i = 1; i < lane.hits.length; i++) assert.ok(lane.hits[i].t > lane.hits[i - 1].t, 'hits in time order');
        for (const h of lane.hits) {
          const m = marbleAt(lane, h.t + 1e-9);
          assert.ok(Math.hypot(m.x - h.pos.x, m.y - h.pos.y) < 1e-6, `${lane.name}: marble is at the pad when its note plays`);
        }
      });
    });

    await t.test('the path is continuous and finite within the loop', () => {
      for (const lane of plan.lanes) {
        let prev = marbleAt(lane, 0);
        for (let tt = 0; tt <= plan.D; tt += 0.002) {
          const m = marbleAt(lane, tt);
          assert.ok(Number.isFinite(m.x + m.y), 'finite');
          assert.ok(Math.hypot(m.x - prev.x, m.y - prev.y) < 0.06, `${lane.name}: no jump at ${tt.toFixed(3)}`);
          prev = m;
        }
      }
    });

    await t.test('seamless loop: the last frame matches the first', () => {
      const { seam } = plan;
      // every marble is hidden in a pipe stub at the loop point
      for (const lane of plan.lanes) for (const tt of [0, plan.D - 1e-6]) {
        const m = marbleAt(lane, tt);
        assert.equal(m.type, 'hidden', `${lane.name} hidden at t=${tt.toFixed(2)}`);
        const st = tt === 0 ? lane.stubs[0] : lane.stubs[1];
        assert.ok(Math.hypot(m.x - st.x, m.y - st.y) < 1e-6, 'inside its stub');
      }
      // the first marble starts and ends in the two seam stubs
      const L0 = plan.lanes[0];
      assert.ok(Math.hypot(L0.stubs[0].x - seam.top.x, L0.stubs[0].y - seam.top.y) < 1e-9);
      assert.ok(Math.hypot(L0.stubs[1].x - seam.bottom.x, L0.stubs[1].y - seam.bottom.y) < 1e-9);
      assert.ok(Math.abs(L0.stubs[0].angle - L0.stubs[1].angle) < 1e-9, 'same pipe angle');
      // each seam frame contains only its stub and two straight rails, identical relative to the stub
      const inside = (b, p) => p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1;
      const contents = (b, c) => {
        const items = [];
        for (const l of plan.lanes) {
          for (const h of l.hits) assert.ok(!inside(b, h.pos), `${l.name} pad inside a seam frame`);
          for (const st of l.stubs) if (inside(b, st)) items.push(`stub ${(st.x - c.x).toFixed(3)},${(st.y - c.y).toFixed(3)}`);
          for (const r of l.rails) for (let s = r.s0 || 0; s <= r.sEnd; s += 0.05) {
            const q = r.path.at(s);
            if (inside(b, q)) items.push(`rail ${(q.x - c.x).toFixed(2)},${(q.y - c.y).toFixed(2)}`);
          }
          for (const q of [...l.rails.flatMap((r) => r.brackets || []), ...l.stubs.map((st) => st.bracket)])
            if (inside(b, q)) items.push(`bracket ${(q.x - c.x).toFixed(3)},${(q.y - c.y).toFixed(3)}`);
        }
        return new Set(items);
      };
      const top = contents(seam.boxTop, seam.top), bottom = contents(seam.boxBottom, seam.bottom);
      const missing = [...top].filter((x) => !bottom.has(x)), extra = [...bottom].filter((x) => !top.has(x));
      assert.ok(top.size > 20, 'the frames show the rails');
      assert.deepEqual({ missing: missing.length, extra: extra.length }, { missing: 0, extra: 0 }, `differs: ${[...missing.slice(0, 3), ...extra.slice(0, 3)].join('; ')}`);
    });

    await t.test('every note is a real bounce: head-on, leaving away from the pad', () => {
      for (const lane of plan.lanes) lane.hits.forEach((h, i) => {
        const n = h.normal, sIn = Math.hypot(h.vin.x, h.vin.y), sOut = Math.hypot(h.vout.x, h.vout.y);
        const incidence = -(h.vin.x * n.x + h.vin.y * n.y) / sIn, departure = (h.vout.x * n.x + h.vout.y * n.y) / sOut;
        assert.ok(incidence > 0.29 && departure > 0.29, `${lane.name} pad ${i}: incidence ${incidence.toFixed(2)} departure ${departure.toFixed(2)}`);
      });
    });

    await t.test('momentum: no pad launches the marble (out <= 1.15 x in)', () => {
      for (const lane of plan.lanes) lane.hits.forEach((h, i) => assert.ok(ratio(h) <= 1.151, `${lane.name} pad ${i}: ${ratio(h).toFixed(2)}x`));
    });

    await t.test('the marble never goes faster than the pace allows', () => {
      for (const lane of plan.lanes) for (let tt = lane.hits[0].t; tt < lane.hits.at(-1).t; tt += 0.005) {
        const m = marbleAt(lane, tt);
        assert.ok(Math.hypot(m.vx, m.vy) <= plan.opt.vMax * 1.03, `${lane.name}: ${Math.hypot(m.vx, m.vy).toFixed(2)} m/s at ${tt.toFixed(2)}`);
      }
    });

    await t.test('nothing clips into anything (pads, track, brackets, marbles)', () => {
      const issues = clipReport(plan);
      assert.deepEqual(issues, []);
    });

    await t.test('the two marbles stay together while both are playing', () => {
      if (plan.lanes.length < 2) return;
      const act = (l, tt) => { const i = lastHitIndex(l, tt); return (i >= 0 && tt - l.hits[i].t < 1) || (l.hits[i + 1] && l.hits[i + 1].t - tt < 1.5); };
      const gaps = [];
      for (let tt = 0; tt < plan.D; tt += 0.05) {
        if (!plan.lanes.every((l) => act(l, tt))) continue;
        const [a, b] = plan.lanes.map((l) => marbleAt(l, tt));
        gaps.push(Math.hypot(a.x - b.x, a.y - b.y - plan.opt.laneDrop));
      }
      gaps.sort((x, y) => x - y);
      const p90 = gaps.length ? gaps[Math.floor(0.9 * (gaps.length - 1))] : 0;
      assert.ok(p90 < 3, `90% of the time within ${p90.toFixed(2)} m`);
    });

    await t.test('no forced compromises', () => {
      for (const lane of plan.lanes) lane.hits.forEach((h, i) => assert.ok(!(h.pen >= 30), `${lane.name} pad ${i} is a compromise (${h.pen})`));
    });

    await t.test('pads stay on the wall; tubes only where a ramp loops back', () => {
      for (const lane of plan.lanes) {
        for (const h of lane.hits) assert.ok(Math.abs(h.pos.x) <= plan.half + 0.2, 'pad on the wall');
        for (const rail of lane.rails) {
          const s0 = rail.s0 || 0;
          const loops = rail.path.pieces.some((pc) => pc.type === 'arc' && pc.s0 < rail.sEnd - 1e-6 && pc.s0 + pc.L > s0 + 1e-6);
          assert.equal(!!rail.tube, rail.kind === 'ramp' && loops, `${rail.kind}: tube iff it loops back`);
          if (rail.tube) assert.ok(rail.path.pieces.every((pc) => pc.type !== 'arc' || pc.s0 >= s0 - 1e-6 || pc.s0 + pc.L <= s0), 'every bend is inside the tube');
        }
      }
    });
  });
}

test('open-rail ramps mostly use a natural drop, not a "magnetic" exact landing', () => {
  let rails = 0, drops = 0;
  for (const song of SONG_LIST.slice(0, 6)) {
    const r = planFor(song, 'harmony');
    for (const l of r.plan.lanes) for (const rail of l.rails) if (rail.kind === 'ramp' && !rail.tube) { rails++; if (rail.drop) drops++; }
  }
  assert.ok(rails > 10, 'enough ramps to judge');
  assert.ok(drops / rails >= 0.8, `${drops}/${rails} dropped on`);
});

test('fast passages get smaller pads (like a glockenspiel run)', () => {
  const r = planFor(stressSongs().find((s) => s.name === 'Stress: rests + runs'), 'harmony');
  const scales = r.plan.lanes[0].hits.map((h) => h.scale);
  assert.ok(Math.min(...scales) < 0.6, `smallest ${Math.min(...scales)}`);
  assert.ok(Math.max(...scales) > 0.8, `largest ${Math.max(...scales)}`);
});

test('a plan survives the trip to and from the planning worker (structured clone)', () => {
  const plan = planFor(buildSong('ode'), 'harmony').plan;
  const copy = rehydratePlan(structuredClone(toPlain(plan)));
  assert.equal(copy.D, plan.D);
  for (let k = 0; k < plan.lanes.length; k++) {
    for (let tt = 0; tt < plan.D; tt += 0.37) {
      const a = marbleAt(plan.lanes[k], tt), b = marbleAt(copy.lanes[k], tt);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-12);
    }
    const r = copy.lanes[k].rails[0];
    assert.equal(typeof r.path.at, 'function', 'paths work again');
    assert.deepEqual(r.path.at(r.sEnd / 2), plan.lanes[k].rails[0].path.at(r.sEnd / 2));
  }
});

test('planning is deterministic: same song + seed gives the same course', () => {
  const song = generateSong(3);
  const plan = () => {
    const split = splitParts(song.notes, { second: 'harmony' });
    return planCourse(split.parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups })), { seed: 5 });
  };
  const sig = (p) => p.lanes.map((l) => l.hits.map((h) => `${h.pos.x.toFixed(6)},${h.pos.y.toFixed(6)}`).join(';')).join('|');
  assert.equal(sig(plan()), sig(plan()));
});

test('other paces: speed cap, momentum and no clipping hold', () => {
  for (const vMax of [3.0, 4.0]) for (const song of [buildSong('ode'), generateSong(1), generateSong(42)]) for (const second of ['harmony', 'percussion']) {
    const r = planFor(song, second, vMax);
    if (!r) continue;
    const { plan } = r;
    for (const l of plan.lanes) {
      for (const h of l.hits) assert.ok(ratio(h) <= 1.151, `${song.name} @${vMax}: launch`);
      for (let tt = l.hits[0].t; tt < l.hits.at(-1).t; tt += 0.01) {
        const m = marbleAt(l, tt);
        assert.ok(Math.hypot(m.vx, m.vy) <= vMax * 1.03, `${song.name} @${vMax}: too fast`);
      }
    }
    assert.deepEqual(clipReport(plan), [], `${song.name} [${second}] @${vMax}`);
  }
});

// (planning runs in a background worker with a progress spinner, so a few seconds is fine)
test('regular songs plan quickly enough for the browser', () => {
  for (const song of SONG_LIST.filter((s) => !s.name.startsWith('Stress'))) for (const second of ['harmony', 'percussion']) {
    const r = planFor(song, second);
    if (r) assert.ok(r.ms < 6000, `${song.name} [${second}] took ${r.ms} ms`);
  }
});
