// Physics building blocks: track paths, flights, rolling, and dropping onto a rail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { G, SIM_DT, Path, evalSeg, marbleAt, lastHitIndex, padShape, padType, _internals } from '../src/planner.js';

const { rollRail, settleOnRail, landAndRoll } = _internals;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('paths chain straight lines and arcs by arc length', () => {
  const p = new Path({ x: 0, y: 0 }, 0);
  p.line(1);
  assert.ok(near(p.end.x, 1) && near(p.end.y, 0));
  p.arc(0.5, Math.PI); // U-turn
  assert.ok(near(p.len, 1 + 0.5 * Math.PI));
  assert.ok(near(p.end.x, 1, 1e-9) && near(Math.abs(p.end.y), 1, 1e-9));
  const mid = p.at(1 + 0.25 * Math.PI);
  assert.ok(near(Math.hypot(mid.x - 1, mid.y - (p.end.y / 2)), 0.5, 1e-9), 'arc points stay on the circle');
});

test('flights follow gravity exactly', () => {
  const seg = { type: 'flight', t0: 0, t1: 1, p: { x: 0, y: 0 }, v: { x: 1, y: 2 } };
  const q = evalSeg(seg, 0.5);
  assert.ok(near(q.x, 0.5) && near(q.y, 2 * 0.5 - 0.5 * G * 0.25));
  assert.ok(near(q.vy, 2 - G * 0.5));
});

test('marbleAt picks the segment for the time and lastHitIndex finds the latest hit', () => {
  const lane = { z: 0.3, segs: [
    { type: 'hold', t0: 0, t1: 1, p: { x: 5, y: 5 } },
    { type: 'flight', t0: 1, t1: 2, p: { x: 0, y: 0 }, v: { x: 1, y: 0 } },
  ], hits: [{ t: 0.5 }, { t: 1.5 }] };
  assert.equal(marbleAt(lane, 0.5).x, 5);
  assert.ok(near(marbleAt(lane, 1.25).x, 0.25));
  assert.equal(marbleAt(lane, 1.25).z, 0.3);
  assert.equal(lastHitIndex(lane, 0.2), -1);
  assert.equal(lastHitIndex(lane, 1.0), 0);
  assert.equal(lastHitIndex(lane, 9), 1);
});

test('a marble rolls down a slope, speeding up towards a terminal speed', () => {
  const slope = (8 * Math.PI) / 180;
  const p = new Path({ x: 0, y: 0 }, -slope);
  p.line(3);
  const r = rollRail(p, 0.3, { drag: 0.7 });
  assert.ok(near(r.sEnd, 3, 1e-6), 'reaches the end');
  const v = Math.hypot(r.v.x, r.v.y);
  assert.ok(v > 0.3 && v < Math.sqrt((5 / 7) * G * Math.sin(slope) / 0.7) + 0.01, `terminal speed respected (${v})`);
  assert.ok(near(r.duration, (r.xs.length - 1) * SIM_DT));
});

test('a time budget with switchbacks never stops half way round a bend', () => {
  const slope = (8 * Math.PI) / 180;
  let d = 1;
  const p = new Path({ x: 0, y: 0 }, -slope);
  p.line(0.6);
  const extend = (pth) => { pth.arc(0.14, d > 0 ? -(Math.PI - 2 * slope) : Math.PI - 2 * slope); d = -d; pth.line(0.6); };
  for (const budget of [0.5, 1.3, 2.2, 3.1]) {
    const r = rollRail(p, 0.5, { drag: 0.7, budget, extend });
    const piece = p.at(r.sEnd).piece;
    assert.ok(r.duration <= budget + 1e-9);
    assert.ok(piece.type === 'line' || near(r.sEnd, piece.s0, 1e-6), `budget ${budget}: ends on a straight`);
  }
});

test('dropping onto a rail at an angle: small, shrinking hops, then it rolls on smoothly', () => {
  const slope = (8 * Math.PI) / 180;
  const p = new Path({ x: 0, y: 0 }, -slope);
  p.line(3);
  const vLand = { x: 1.0, y: -Math.tan(slope + (25 * Math.PI) / 180) * 1.0 };
  const hop = settleOnRail(p, vLand);
  assert.ok(hop, 'settles');
  assert.ok(hop.xs.length > 1);
  // stays on or above the rail, and ends back on it
  let maxH = 0;
  for (let i = 0; i < hop.xs.length; i++) {
    const q = p.at(Math.max(0, Math.min(p.len, (hop.xs[i] - 0) / Math.cos(slope))));
    const h = (hop.ys[i] - q.y) * Math.cos(slope);
    assert.ok(h > -1e-6, 'never sinks into the rail');
    maxH = Math.max(maxH, h);
  }
  assert.ok(maxH > 0.0005 && maxH < 0.05, `visible but small hop (${maxH.toFixed(4)} m)`);
  // along the rail it keeps its speed (minus a little scuff), plus only what the slope adds while hopping
  const vt = vLand.x * Math.cos(slope) - vLand.y * Math.sin(slope);
  assert.ok(hop.v <= vt + G * Math.sin(slope) * hop.duration + 1e-6, 'no speed out of nowhere');
  assert.ok(hop.v >= 0.9 * vt, 'keeps most of its speed along the rail');
  // landAndRoll joins the hops and the roll without a jump
  const r = landAndRoll(p, vLand, { drag: 0.7 });
  for (let i = 1; i < r.xs.length; i++) assert.ok(Math.hypot(r.xs[i] - r.xs[i - 1], r.ys[i] - r.ys[i - 1]) < 0.02, `continuous at ${i}`);
});

test('an almost tangential landing needs no hops', () => {
  const slope = (8 * Math.PI) / 180;
  const p = new Path({ x: 0, y: 0 }, -slope);
  p.line(3);
  assert.equal(settleOnRail(p, { x: Math.cos(slope), y: -Math.sin(slope) }), null);
});

test('pad shapes shrink with scale and drums/keys map from notes', () => {
  const full = padShape('key', 60), small = padShape('key', 60, 0.5);
  assert.ok(near(small.len, full.len * 0.5) && small.thick === full.thick);
  assert.ok(padShape('key', 84).len < padShape('key', 48).len, 'higher keys are shorter');
  assert.equal(padType('keys', [{ midi: 60 }]), 'key');
  assert.equal(padType('bars', [{ midi: 40 }]), 'bar');
  assert.equal(padType('drums', [{ midi: 36 }, { midi: 42 }]), 'kick');
  assert.equal(padType('drums', [{ midi: 38 }]), 'snare');
  assert.equal(padType('drums', [{ midi: 42 }]), 'hat');
  assert.equal(padType('drums', [{ midi: 49 }]), 'crash');
});
