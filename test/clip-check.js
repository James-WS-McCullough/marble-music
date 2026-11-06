// Geometry checker: finds pieces that clip into each other, independently of the planner's own
// bookkeeping. Works in the 2D wall plane per depth layer:
//   - pads of the same lane must not overlap each other or that lane's track pieces
//   - a front lane's support brackets run back to the wall through every lane behind it, so the
//     back lane's pads, track and marble must stay clear of them
//   - a marble must not pass through anything it isn't touching at that moment
import { marbleAt, padShape, MARBLE_R, TUBE_R, WALL_MOUNTED } from '../src/planner.js';

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a, b) => a.x * b.x + a.y * b.y;

function distPointSeg(p, a, b) {
  const ab = sub(b, a), L2 = dot(ab, ab);
  const t = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
  return Math.hypot(p.x - (a.x + t * ab.x), p.y - (a.y + t * ab.y));
}
function segsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b) && o(a, b, c) !== 0 && o(c, d, a) !== 0;
}
export function distSegSeg(a, b, c, d) {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(distPointSeg(a, c, d), distPointSeg(b, c, d), distPointSeg(c, a, b), distPointSeg(d, a, b));
}

/** A pad's body as a thick segment (centre line + half thickness). */
export function padBody(h) {
  const { len, thick } = padShape(h.type, h.midi, h.scale);
  const n = h.normal, c = { x: h.pos.x - n.x * (MARBLE_R + thick / 2), y: h.pos.y - n.y * (MARBLE_R + thick / 2) };
  const t = { x: -n.y, y: n.x };
  const wall = WALL_MOUNTED.has(h.type); // runs back to the wall itself, at full width
  return { a: { x: c.x - (t.x * len) / 2, y: c.y - (t.y * len) / 2 }, b: { x: c.x + (t.x * len) / 2, y: c.y + (t.y * len) / 2 }, r: thick / 2,
    bracket: wall ? { x: c.x, y: c.y, r: thick / 2 } : { x: c.x - (n.x * thick) / 2, y: c.y - (n.y * thick) / 2, r: 0.008 } };
}

/** Track pieces as thick segments: glass tubes around the marble's path, or a rail under it. */
function trackSegs(rail) {
  const out = [];
  const step = 0.04;
  let prev = null;
  for (let s = rail.s0 || 0; ; s += step) {
    const q = rail.path.at(Math.min(s, rail.sEnd));
    const p = rail.tube ? { x: q.x, y: q.y } : { x: q.x + q.nx * MARBLE_R, y: q.y + q.ny * MARBLE_R };
    if (prev) out.push({ a: prev, b: p, r: rail.tube ? TUBE_R : 0.012 });
    prev = p;
    if (s >= rail.sEnd) break;
  }
  return out;
}

export function clipReport(plan, { tol = 0.004 } = {}) {
  const issues = [];
  const lanes = plan.lanes;
  for (const lane of lanes) {
    const bodies = lane.hits.map(padBody);
    const tracks = lane.rails.map((r) => ({ rail: r, segs: trackSegs(r) }));
    // the start/end pipe stubs are solid too
    for (const st of lane.stubs || []) {
      const hx = Math.cos(st.angle) * st.len / 2, hy = Math.sin(st.angle) * st.len / 2;
      tracks.push({ rail: { kind: 'stub' }, segs: [{ a: { x: st.x - hx, y: st.y - hy }, b: { x: st.x + hx, y: st.y + hy }, r: TUBE_R }] });
    }
    const front = lanes.filter((l) => l.k < lane.k);
    const frontBrackets = front.flatMap((l) => [
      ...l.hits.map((h) => padBody(h).bracket),
      ...l.rails.flatMap((r) => r.brackets || []),
      ...(l.stubs || []).map((st) => st.bracket),
    ]);
    // pad vs pad (same lane)
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const A = bodies[i], B = bodies[j];
      if (distSegSeg(A.a, A.b, B.a, B.b) < A.r + B.r - tol) issues.push(`${lane.name}: pads ${i} and ${j} overlap`);
    }
    // pad vs track (same lane)
    bodies.forEach((A, i) => tracks.forEach(({ rail, segs }, ri) => {
      if (segs.some((s) => distSegSeg(A.a, A.b, s.a, s.b) < A.r + s.r - tol)) issues.push(`${lane.name}: pad ${i} clips ${rail.kind} ${ri}`);
    }));
    // pads / track vs front lanes' brackets (rods r ~ 0.007)
    const ROD = 0.008, rodR = (q) => q.r ?? ROD;
    bodies.forEach((A, i) => frontBrackets.forEach((q) => {
      if (distPointSeg(q, A.a, A.b) < A.r + rodR(q) - tol) issues.push(`${lane.name}: pad ${i} pierced by a front bracket`);
    }));
    tracks.forEach(({ rail, segs }) => frontBrackets.forEach((q) => {
      if (segs.some((s) => distPointSeg(q, s.a, s.b) < s.r + rodR(q) - tol)) issues.push(`${lane.name}: ${rail.kind} pierced by a front bracket`);
    }));
    // marble vs everything it isn't touching
    const firstT = lane.hits[0].t - 1, lastT = lane.hits[lane.hits.length - 1].t + 0.3;
    for (let t = firstT; t < lastT; t += 0.005) {
      const m = marbleAt(lane, t);
      if (m.type !== 'flight' && m.type !== 'rail') continue;
      for (let i = 0; i < bodies.length; i++) {
        if (Math.abs(lane.hits[i].t - t) < 0.03) continue; // touching it right now
        const A = bodies[i];
        const dd = MARBLE_R + A.r - distPointSeg(m, A.a, A.b); if (dd > tol) { issues.push(`${lane.name}: marble passes through pad ${i}`); break; }
      }
      frontBrackets.forEach((q, qi) => { if (Math.hypot(m.x - q.x, m.y - q.y) < MARBLE_R + rodR(q) - tol) issues.push(`${lane.name}: marble hits front bracket ${qi}`); });
    }
  }
  return [...new Set(issues)];
}
