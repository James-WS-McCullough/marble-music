// Course planner: turns timed note groups (one list per instrument part) into a marble-run
// laid out in front of a wall. Each part gets its own marble, running in its own "lane" at a
// different depth in front of the wall.
//
// Core idea: work BACKWARDS from the music. Every note is a pad the marble must strike at an
// exact time. Between notes the marble is either
//   - in free flight (ballistic, gravity only): we choose where the next pad goes and solve the
//     launch velocity that lands the marble there exactly `dt` seconds later, or
//   - (long gaps) kicked onto a ramp: a real rolling simulation (gravity + rolling drag) down
//     zig-zag switchback ramps, after which it drops off the end onto the next note.
// Each pad's normal is normalize(v_out - v_in): the mirror that turns the incoming velocity
// into the required outgoing one, so every note is a genuine-looking bounce.
//
// Layout: the marbles follow a shared "route" that sweeps diagonally across a big wall (down-left,
// then down-right, ...) at a speed matched to the note density, so pads are spread out along a
// line instead of piling up, and a close follow camera only ever sees a handful of them.
// Momentum looks conserved: a pad never sends the marble off more than 15% faster than it
// arrived (a hard limit; the search always finds another layout, ramp or redo instead).
//
// Motion is 2D (x across the wall, y up) at a fixed depth z per lane.

import { mulberry32, clamp } from './util.js';

// Gravity is scaled down from 9.8: like filming a bigger-scale model, the motion stays fully
// consistent but calmer, so the eye can follow the marble from note to note.
export const G = 6;
export const MARBLE_R = 0.06;
export const TUBE_R = 0.085; // outer radius of the glass tubes that hold ramps with U-bends
export const SIM_DT = 1 / 480;
const K_ROLL = 5 / 7; // rolling sphere: a = 5/7 g sin(theta)
const RAMP_DROPS = [(18 * Math.PI) / 180, 0, (28 * Math.PI) / 180]; // landing angle onto a ramp
const WIDE_SLOPES = [3, 5, 7, 9, 12, 14, 17, 20, 23, 26].map((d) => (d * Math.PI) / 180); // when looking wider

export const DEFAULTS = {
  routeW: 5, // the route sweeps between x = -routeW/2 and +routeW/2
  routeAngle: (22 * Math.PI) / 180, // how steeply the route descends
  spacing: 0.6, // target distance along the route between consecutive notes (m)
  speedMin: 0.8, // route speed limits (m/s); the max is 0.44 * vMax unless given
  vMax: 2.3, // the marble never moves faster than this, so the eye can follow it (m/s)
  corridor: 0.5, // pads may stray this far sideways from the route for free
  laneDrop: 0.85, // the second marble runs this far below the first
  laneGap: 0.3, // depth spacing between lanes
  laneZ0: 0.2, // depth of the back-most lane
  vh: 1.25, // nominal horizontal speed for "travel" runs (m/s)
  minDisp: 0.34, // min horizontal spacing between consecutive pads (m)
  maxGain: 1.15, // hard limit: a pad never sends the marble off faster than this x its arrival speed
  flightMax: 0.68, // gaps longer than this (s) go via a rolling ramp (also limited by vMax)
  shelfMin: 0.5, // a lane lagging below the others may use short track pieces for gaps >= this
  rampSlope: (7 * Math.PI) / 180,
  topSlope: (5 * Math.PI) / 180,
  gutterSlope: (6 * Math.PI) / 180,
  rampDrag: 0.7, // v^2 drag on ramps -> terminal speed ~1.1 m/s
  switchR: 0.14, // radius of switchback U-bends
  kicks: [{ t1: 0.2, vh: 0.9 }, { t1: 0.3, vh: 0.7 }, { t1: 0.14, vh: 1.1 }, { t1: 0.16, vh: 0.5 }], // hop from a pad onto a ramp
  rampSlopes: [9, 14, 5, 20, 26].map((d) => (d * Math.PI) / 180),
  exitTime: 0.14, // min drop time from a ramp end onto the next pad
  lift: 2.2, // lift ride time (s)
  seed: 1,
};

// ------------------------------------------------------------------ pad shapes

const KICKS = new Set([35, 36]);
const SNARES = new Set([37, 38, 39, 40]);
const HATS = new Set([42, 44, 46]);
export const CYMBALS = new Set([42, 44, 46, 49, 51, 52, 53, 55, 57, 59]);

/**
 * What a hit's pad is. Drums follow their notes; pitched parts are keys/bars by default, or
 * whatever object the song's object plan chose for that hit (`obj`: key, bar, button, tube).
 */
export function padType(style, notes, obj = null) {
  if (style === 'drums' || style === 'cymbals') {
    const ms = notes.map((n) => n.midi);
    if (ms.some((m) => KICKS.has(m))) return 'kick';
    if (ms.some((m) => SNARES.has(m))) return 'snare';
    if (ms.some((m) => !CYMBALS.has(m))) return 'tom';
    if (ms.some((m) => HATS.has(m))) return 'hat';
    return 'crash';
  }
  if (obj) return obj;
  return { keys: 'key', bars: 'bar', chimes: 'chime' }[style] || 'key';
}

/**
 * Size of a pad along its surface (len) and along its normal (thick). `scale` < 1 shrinks pads
 * in fast passages (a quick run is played on small keys, like a glockenspiel).
 */
export function padShape(type, midi, scale = 1) {
  const s = padShapeFull(type, midi);
  return scale === 1 ? s : { len: s.len * scale, thick: s.thick };
}
function padShapeFull(type, midi) {
  switch (type) {
    case 'kick': return { len: 0.26, thick: 0.1 };
    case 'snare': return { len: 0.2, thick: 0.07 };
    case 'tom': return { len: 0.19, thick: 0.07 };
    case 'hat': return { len: 0.18, thick: 0.03 };
    case 'crash': return { len: 0.28, thick: 0.02 };
    case 'bar': return { len: clamp(0.42 - (midi - 28) * 0.005, 0.22, 0.42), thick: 0.055 };
    case 'chime': return { len: clamp(0.3 - (midi - 60) * 0.004, 0.14, 0.3), thick: 0.03 };
    case 'button': return { len: 0.17, thick: 0.055 }; // an arcade button: round cap in a bezel
    case 'tube': return { len: clamp(0.42 - (midi - 48) * 0.006, 0.2, 0.42), thick: 0.045 }; // a chime tube (lower = longer)
    default: return { len: clamp(0.32 - (midi - 48) * 0.004, 0.16, 0.32), thick: 0.05 };
  }
}

// ------------------------------------------------------------------ 2D track paths

/** A chain of straight lines and circular arcs, parameterised by arc length. */
export class Path {
  constructor(p, angle) {
    this.pieces = [];
    this.len = 0;
    this.end = { x: p.x, y: p.y };
    this.endAngle = angle;
  }
  line(L) {
    this.pieces.push({ type: 'line', s0: this.len, L, p: { ...this.end }, a: this.endAngle });
    this.len += L;
    this.end = { x: this.end.x + L * Math.cos(this.endAngle), y: this.end.y + L * Math.sin(this.endAngle) };
  }
  arc(r, turn) {
    const sign = Math.sign(turn);
    const ca = this.endAngle + (sign * Math.PI) / 2;
    const c = { x: this.end.x + r * Math.cos(ca), y: this.end.y + r * Math.sin(ca) };
    const phi0 = ca + Math.PI;
    const L = r * Math.abs(turn);
    this.pieces.push({ type: 'arc', s0: this.len, L, c, r, phi0, sign });
    this.len += L;
    this.end = { x: c.x + r * Math.cos(phi0 + turn), y: c.y + r * Math.sin(phi0 + turn) };
    this.endAngle += turn;
  }
  at(s) {
    // most lookups move forward a little from the last one: check that piece first, else binary search
    const ps = this.pieces;
    let i = this._last ?? 0;
    if (!(i < ps.length && ps[i].s0 <= s && (i === ps.length - 1 || ps[i + 1].s0 > s))) {
      let lo = 0, hi = ps.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ps[mid].s0 <= s) lo = mid; else hi = mid - 1; }
      i = lo;
    }
    this._last = i;
    const pc = ps[i];
    const u = s - pc.s0;
    if (pc.type === 'line') {
      const right = Math.cos(pc.a) >= 0;
      return { x: pc.p.x + u * Math.cos(pc.a), y: pc.p.y + u * Math.sin(pc.a), ang: pc.a, piece: pc,
        // support side (where the rails are): below the marble
        nx: right ? Math.sin(pc.a) : -Math.sin(pc.a), ny: right ? -Math.cos(pc.a) : Math.cos(pc.a) };
    }
    const phi = pc.phi0 + (pc.sign * u) / pc.r;
    // in a U-bend the marble is pressed against the outside of the curve
    return { x: pc.c.x + pc.r * Math.cos(phi), y: pc.c.y + pc.r * Math.sin(phi), ang: phi + (pc.sign * Math.PI) / 2,
      piece: pc, nx: Math.cos(phi), ny: Math.sin(phi) };
  }
}

/**
 * Roll a marble along a path. Either until the path ends (fixed length), or for a time budget
 * with `extend` adding switchbacks as needed. A budget run never ends mid U-bend: it stops at
 * the start of the bend and the leftover time goes to the drop afterwards.
 */
function rollRail(path, u0, opts) {
  return cutRoll(path, rollRaw(path, u0, opts), opts.budget ?? Infinity, null, !!opts.extend);
}

/** The raw roll (every SIM_DT sample) up to the budget, untrimmed; see cutRoll. */
function rollRaw(path, u0, { drag, budget = Infinity, extend = null, s0 = 0 }) {
  const xs = [], ys = [], ss = [], vs = [], arc = [];
  let s = s0, v = u0;
  let last;
  const push = (q) => { last = q; xs.push(q.x); ys.push(q.y); ss.push(s); vs.push(v); arc.push(q.piece.type === 'arc'); };
  push(path.at(s));
  for (;;) {
    let q = last;
    if (s >= path.len - 1e-9) {
      if (!extend) break;
      extend(path);
      q = path.at(s); // the path just grew: look the point up again
      arc[arc.length - 1] = q.piece.type === 'arc';
      xs[xs.length - 1] = q.x; ys[ys.length - 1] = q.y;
    }
    if (xs.length * SIM_DT > budget) break;
    const a = K_ROLL * G * -Math.sin(q.ang) - drag * v * v;
    v = Math.max(0.25, v + a * SIM_DT);
    s = extend ? s + v * SIM_DT : Math.min(path.len, s + v * SIM_DT);
    push(path.at(s));
  }
  return { xs, ys, ss, vs, arc };
}

/**
 * The roll for a given time budget, as a prefix of a longer raw roll (so one simulation serves
 * many budgets). A budgeted run with switchbacks never ends mid U-bend: it stops at the start of
 * the bend and the leftover time goes to the drop afterwards. `hop` = settling hops before it.
 */
function cutRoll(path, raw, budget, hop = null, trimArcs = true) {
  let L = Math.min(raw.xs.length, budget === Infinity ? Infinity : Math.floor(budget / SIM_DT + 1e-9) + 1);
  if (L < 1) return null;
  if (trimArcs && raw.arc[L - 1]) { let j = L - 1; while (j > 0 && raw.arc[j - 1]) j--; L = j + 1; }
  const n = L - 1, q = path.at(raw.ss[n]);
  const xs = raw.xs.slice(0, L), ys = raw.ys.slice(0, L);
  return { xs: hop ? hop.xs.concat(xs) : xs, ys: hop ? hop.ys.concat(ys) : ys,
    duration: (hop ? hop.duration : 0) + n * SIM_DT, sEnd: raw.ss[n], end: { x: raw.xs[n], y: raw.ys[n] },
    v: { x: raw.vs[n] * Math.cos(q.ang), y: raw.vs[n] * Math.sin(q.ang) } };
}

/**
 * A marble dropping onto an open rail at an angle (not perfectly along it): on each impact it
 * keeps most of its speed along the rail but loses most of it into the rail (restitution e),
 * giving a couple of small settling hops before it rolls. Stepped at SIM_DT on the first straight
 * piece. Returns the hop samples and where/how fast it starts rolling (null: no room to settle).
 */
function settleOnRail(path, vLand, e = 0.45) {
  const q0 = path.at(0), pc = q0.piece;
  if (pc.type !== 'line') return null;
  const tx = Math.cos(pc.a), ty = Math.sin(pc.a);
  const away = { x: -q0.nx, y: -q0.ny }; // off the rail, towards the marble's free side
  const aS = -G * ty, aH = -G * away.y; // gravity along the rail / along "away"
  let sPos = 0, vS = (vLand.x * tx + vLand.y * ty) * 0.96; // impact scuffs a little speed
  let h = 0, vH = -(vLand.x * away.x + vLand.y * away.y) * e;
  const xs = [], ys = [];
  if (vH < 0.06) return null; // hardly any drop: nothing to settle
  for (let n = 0; n < 4000; n++) {
    const q = path.at(sPos);
    xs.push(q.x + away.x * h); ys.push(q.y + away.y * h);
    vS += aS * SIM_DT; sPos += vS * SIM_DT;
    vH += aH * SIM_DT; h += vH * SIM_DT;
    if (sPos > pc.L - 0.05) return null; // must settle before the first bend
    if (h <= 0) { // touches the rail again: a smaller bounce, or it's settled and starts rolling
      h = 0; vH = -vH * e;
      if (vH < 0.06) break;
    }
  }
  return { xs, ys, s: sPos, v: Math.max(0.25, vS), duration: xs.length * SIM_DT };
}

/** Land on a rail (settling hops) then roll on, as one sampled rail segment. */
function landAndRoll(path, vLand, opts) {
  const hop = settleOnRail(path, vLand);
  if (!hop) return null;
  const budget = (opts.budget ?? Infinity) - hop.duration;
  return cutRoll(path, rollRaw(path, hop.v, { ...opts, s0: hop.s, budget }), budget, hop, !!opts.extend);
}

// ------------------------------------------------------------------ segment evaluation

export function evalSeg(seg, t) {
  switch (seg.type) {
    case 'flight':
      return { x: seg.p.x + seg.v.x * t, y: seg.p.y + seg.v.y * t - 0.5 * G * t * t, vx: seg.v.x, vy: seg.v.y - G * t };
    case 'rail': {
      const f = clamp(t / SIM_DT, 0, seg.xs.length - 1);
      const i = Math.min(Math.floor(f), seg.xs.length - 2), u = f - i;
      if (i < 0) return { x: seg.xs[0], y: seg.ys[0], vx: 0, vy: 0 };
      return { x: seg.xs[i] + (seg.xs[i + 1] - seg.xs[i]) * u, y: seg.ys[i] + (seg.ys[i + 1] - seg.ys[i]) * u,
        vx: (seg.xs[i + 1] - seg.xs[i]) / SIM_DT, vy: (seg.ys[i + 1] - seg.ys[i]) / SIM_DT };
    }
    case 'lift': {
      const T = seg.t1 - seg.t0, u = clamp(t / T, 0, 1);
      const e = u * u * (3 - 2 * u), de = (6 * u * (1 - u)) / T;
      return { x: seg.p0.x + (seg.p1.x - seg.p0.x) * e, y: seg.p0.y + (seg.p1.y - seg.p0.y) * e,
        vx: (seg.p1.x - seg.p0.x) * de, vy: (seg.p1.y - seg.p0.y) * de };
    }
    default: // hold
      return { x: seg.p.x, y: seg.p.y, vx: 0, vy: 0 };
  }
}

export function marbleAt(lane, tau) {
  const segs = lane.segs;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].t0 <= tau) lo = mid;
    else hi = mid - 1;
  }
  const seg = segs[lo];
  return { ...evalSeg(seg, clamp(tau - seg.t0, 0, seg.t1 - seg.t0)), z: lane.z, type: seg.type };
}

/** Index of the most recent hit at or before tau in a lane (-1 if none). */
export function lastHitIndex(lane, tau) {
  const hits = lane.hits;
  let lo = -1, hi = hits.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (hits[mid].t <= tau) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ------------------------------------------------------------------ obstacles (2D)

/**
 * Obstacles in a uniform grid so collision checks only look at nearby pieces. Supports
 * truncating back to an earlier size (to re-plan a lane): obstacles are removed in reverse
 * order of insertion, so each is always the last entry of its cells.
 */
class ObstacleGrid {
  constructor(cell = 0.2) { this.cell = cell; this.cells = new Map(); this.list = []; }
  get length() { return this.list.length; }
  set length(n) {
    while (this.list.length > n) {
      const o = this.list.pop();
      for (const key of o.cellKeys) this.cells.get(key).pop();
    }
  }
  push(...objs) {
    const c = this.cell;
    for (const o of objs) {
      const pad = o.r + 0.001;
      const x0 = Math.floor((Math.min(o.x1, o.x2) - pad) / c), x1 = Math.floor((Math.max(o.x1, o.x2) + pad) / c);
      const y0 = Math.floor((Math.min(o.y1, o.y2) - pad) / c), y1 = Math.floor((Math.max(o.y1, o.y2) + pad) / c);
      o.cellKeys = [];
      for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
        const key = ix * 100003 + iy;
        let arr = this.cells.get(key);
        if (!arr) this.cells.set(key, (arr = []));
        arr.push(o);
        o.cellKeys.push(key);
      }
      this.list.push(o);
    }
  }
  filter(fn) { return this.list.filter(fn); }
  /** True if fn(o) is true for any obstacle whose cells overlap the disc (x, y, rad). */
  some(x, y, rad, fn) {
    const c = this.cell;
    const x0 = Math.floor((x - rad) / c), x1 = Math.floor((x + rad) / c), y0 = Math.floor((y - rad) / c), y1 = Math.floor((y + rad) / c);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const arr = this.cells.get(ix * 100003 + iy);
      if (arr) for (const o of arr) if (fn(o)) return true;
    }
    return false;
  }
}

function distSeg(px, py, o) {
  const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? clamp(((px - o.x1) * dx + (py - o.y1) * dy) / L2, 0, 1) : 0;
  return Math.hypot(px - (o.x1 + t * dx), py - (o.y1 + t * dy));
}

/** Distance between two segments {x1,y1,x2,y2}. */
function segDist(a, b) {
  const cross = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const o1 = cross(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1), o2 = cross(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const o3 = cross(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1), o4 = cross(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  if (o1 !== o2 && o3 !== o4 && o1 && o3) return 0;
  return Math.min(distSeg(a.x1, a.y1, b), distSeg(a.x2, a.y2, b), distSeg(b.x1, b.y1, a), distSeg(b.x2, b.y2, a));
}

/** The pad body (a thick line segment) for a pad touching the marble at p with normal n. */
function padSeg(p, n, type, midi, scale = 1) {
  const { len, thick } = padShape(type, midi, scale);
  const cx = p.x - n.x * (MARBLE_R + thick / 2), cy = p.y - n.y * (MARBLE_R + thick / 2);
  const tx = -n.y, ty = n.x;
  return { x1: cx - (tx * len) / 2, y1: cy - (ty * len) / 2, x2: cx + (tx * len) / 2, y2: cy + (ty * len) / 2, r: thick / 2 };
}

/** Is this pad body clear of the earlier flight paths (excluding the one arriving at it)? */
function padClear(seg, grid, rel, arrivingIdx, P) {
  const cx = (seg.x1 + seg.x2) / 2, cy = (seg.y1 + seg.y2) / 2;
  const rad = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) / 2 + MARBLE_R + seg.r;
  return !grid.some(cx, cy, rad, (o) => o.path && rel(o) &&
    !(o.idx === arrivingIdx && Math.hypot(o.x1 - P.x, o.y1 - P.y) < 0.1) &&
    distSeg(o.x1, o.y1, seg) < MARBLE_R + seg.r + 0.004);
}

/** Does this pad body overlap any solid piece (pads, track, brackets of lanes in front)? */
function bodyHits(seg, grid, rel) {
  const cx = (seg.x1 + seg.x2) / 2, cy = (seg.y1 + seg.y2) / 2;
  const rad = Math.hypot(seg.x2 - seg.x1, seg.y2 - seg.y1) / 2 + seg.r + 0.1;
  return grid.some(cx, cy, rad, (o) => !o.path && rel(o) && segDist(seg, o) < seg.r + o.r + 0.004);
}

function padObstacle(k, hit, idx) {
  const { len, thick } = padShape(hit.type, hit.midi, hit.scale);
  const n = hit.normal;
  const cx = hit.pos.x - n.x * (MARBLE_R + thick / 2), cy = hit.pos.y - n.y * (MARBLE_R + thick / 2);
  const tx = -n.y, ty = n.x;
  return [
    { k, own: true, hitIdx: idx, x1: cx - (tx * len) / 2, y1: cy - (ty * len) / 2, x2: cx + (tx * len) / 2, y2: cy + (ty * len) / 2, r: thick / 2 },
    // the bracket holding this pad (at the middle of its back face) runs back to the wall,
    // through every lane behind it
    { k, own: false, bracket: true, x1: cx - (n.x * thick) / 2, y1: cy - (n.y * thick) / 2, x2: cx - (n.x * thick) / 2, y2: cy - (n.y * thick) / 2, r: 0.012 },
  ];
}

/**
 * Track as obstacles: an open rail under the marble, or a glass tube around its path (switchback
 * ramps). Also returns the support brackets (every ~0.5 m), which the renderer draws at exactly
 * these points so the planner and the picture agree.
 */
function railObstacles(k, path, sEnd, tube = false, s0 = 0) {
  const out = [], brackets = [];
  let prev = null, i = 0;
  const step = 0.06;
  for (let s = s0; ; s += step, i++) {
    const q = path.at(Math.min(s, sEnd));
    const p = tube ? { x: q.x, y: q.y } : { x: q.x + q.nx * MARBLE_R, y: q.y + q.ny * MARBLE_R };
    if (prev) out.push({ k, own: true, x1: prev.x, y1: prev.y, x2: p.x, y2: p.y, r: tube ? TUBE_R : 0.012 });
    if (i % 8 === 4 && q.piece.type === 'line') { // mount on the support side (outside of the tube / under the rail)
      const off = tube ? TUBE_R : 0.02;
      const b = tube ? { x: q.x + q.nx * off, y: q.y + q.ny * off } : { x: p.x + q.nx * off, y: p.y + q.ny * off };
      brackets.push(b);
      out.push({ k, own: false, bracket: true, x1: b.x, y1: b.y, x2: b.x, y2: b.y, r: 0.012 });
    }
    prev = p;
    if (s >= sEnd) break;
  }
  out.brackets = brackets;
  return out;
}

// ------------------------------------------------------------------ planning

const flightPos = (p, v, t) => ({ x: p.x + v.x * t, y: p.y + v.y * t - 0.5 * G * t * t });
const flightVel = (v, t) => ({ x: v.x, y: v.y - G * t });

/** Sample a flight as "path" obstacles: future pads must not be placed on it. */
function pathObstacles(k, p, v, T, idx) {
  const out = [];
  const n = Math.max(2, Math.ceil((Math.hypot(v.x, v.y) * T) / 0.04));
  for (let j = 0; j <= n; j++) {
    const q = flightPos(p, v, (j / n) * T);
    out.push({ k, own: true, path: true, idx, x1: q.x, y1: q.y, x2: q.x, y2: q.y, r: 0 });
  }
  return out;
}

function setNormal(hit) {
  const dx = hit.vout.x - hit.vin.x, dy = hit.vout.y - hit.vin.y;
  const l = Math.hypot(dx, dy);
  hit.normal = l < 1e-6 ? { x: 0, y: 1 } : { x: dx / l, y: dy / l };
}

/**
 * What one candidate course "sees": everything already committed (the shared grid) plus the
 * pieces this candidate added in its own recent, not yet committed, steps. Lets many candidate
 * courses share one grid without copying it.
 */
class World {
  constructor(grid, node) { this.grid = grid; this.node = node; }
  some(x, y, rad, fn) {
    if (this.grid.some(x, y, rad, fn)) return true;
    for (let n = this.node; n && !n.committed; n = n.parent) {
      const b = n.bbox;
      if (!b || x + rad < b.x0 || x - rad > b.x1 || y + rad < b.y0 || y - rad > b.y1) continue;
      for (const o of n.obs) if (fn(o)) return true;
    }
    return false;
  }
}

function bboxOf(obs) {
  if (!obs.length) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const o of obs) {
    x0 = Math.min(x0, o.x1 - o.r, o.x2 - o.r); x1 = Math.max(x1, o.x1 + o.r, o.x2 + o.r);
    y0 = Math.min(y0, o.y1 - o.r, o.y2 - o.r); y1 = Math.max(y1, o.y1 + o.r, o.y2 + o.r);
  }
  return { x0, x1, y0, y1 };
}

/**
 * parts: [{ name, style, role, groups: [{ t, notes }] }], front-most lane first.
 *
 * Search: a beam of candidate courses per lane. At every note each candidate is extended by its
 * few best *valid* next steps (hard rules filter: no clipping, no launch, speed cap, a real
 * head-on hit); costs only express taste (follow the route, spacing, style). The best BEAM
 * candidates survive; steps they all share are committed. A candidate heading into a dead end
 * simply loses to one that turned earlier. If every candidate dies, the search backs up a few
 * notes and re-searches that stretch with a wider beam; a lane that still needs a compromise
 * is planned again with small variations, and the cleanest result is kept.
 */
export function planCourse(parts, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const rng = mulberry32((opt.seed >>> 0) ^ 0x5bd1e995);
  parts = parts.filter((p) => p.groups.length);
  if (!parts.length) throw new Error('No notes to plan');
  const BEAM = opt.beam ?? 10, PER_NODE = opt.perNode ?? 4, WINDOW = opt.window ?? 20;
  const A = opt.routeW / 2;
  const half = A + 0.9; // pads stay within [-half, half]
  const liftX = A + 1.4; // (right-hand limit for where start rails end)
  const g0 = Math.min(...parts.map((p) => p.groups[0].t));
  const speedMax = opt.speedMax ?? 0.44 * opt.vMax; // the route must leave room to bounce around it
  const flightMax = Math.min(opt.flightMax, (0.85 * 2 * opt.vMax) / G);
  const span = Math.max(...parts.map((p) => p.groups[p.groups.length - 1].t)) - g0;

  // ---------------------------------------------------------------- the route
  // Its speed follows how busy the music is *right now* (notes in a 2 s window), so pads stay
  // ~`spacing` apart in busy passages and the route nearly waits during rests. S(u) = distance
  // along the route at song time u (seconds after the first note); Dx(u) = extra straight drop.
  const SU = 0.05, U0 = -30, nU = Math.ceil((span + 60) / SU);
  const Sgrid = new Float64Array(nU + 1), Dgrid = new Float64Array(nU + 1);
  {
    const counts = new Float64Array(nU + 1), busiest = new Float64Array(nU + 1);
    parts.forEach((p, k) => { for (const g of p.groups) { const j = Math.round((g.t - g0 - U0) / SU); if (j >= 0 && j <= nU) counts[j] += k === 0 ? 1 : 0.6; } });
    const W = Math.round(1 / SU); // +-1 s window
    { // the busiest lane's note rate in the window (every lane's pads need room)
      const per = parts.map((p) => { const c = new Float64Array(nU + 1); for (const g of p.groups) { const j = Math.round((g.t - g0 - U0) / SU); if (j >= 0 && j <= nU) c[j]++; } return c; });
      for (const c of per) { let r = 0; for (let j = 0; j <= nU; j++) { r += c[j] - (j - 2 * W - 1 >= 0 ? c[j - 2 * W - 1] : 0); const jc = j - W; if (jc >= 0) busiest[jc] = Math.max(busiest[jc], r / 2); } }
    }
    let run = 0;
    for (let j = 0; j <= Math.min(nU, W); j++) run += counts[j];
    for (let j = 0; j < nU; j++) {
      const u = U0 + j * SU;
      const quiet = u < 0 || u > span ? opt.speedMin : 0.3;
      // very dense passages may go faster (still well under vMax) so every note gets room
      const vCap = Math.max(speedMax, Math.min(0.55 * opt.vMax, 0.2 * busiest[j]));
      const v = clamp(Math.max(opt.spacing * run / 2, 0.2 * busiest[j]), Math.min(quiet, speedMax), vCap);
      // beyond the normal max the extra goes straight down (a dense run becomes a staircase)
      // rather than sweeping sideways faster than a marble can follow
      Sgrid[j + 1] = Sgrid[j] + Math.min(v, speedMax) * SU;
      Dgrid[j + 1] = Dgrid[j] + Math.max(0, v - speedMax) * SU;
      if (j + W + 1 <= nU) run += counts[j + W + 1];
      if (j - W >= 0) run -= counts[j - W];
    }
    const s0 = Sgrid[Math.round(-U0 / SU)], d0 = Dgrid[Math.round(-U0 / SU)];
    for (let j = 0; j <= nU; j++) { Sgrid[j] -= s0; Dgrid[j] -= d0; }
  }
  const gridFn = (g) => (u) => { const f = clamp((u - U0) / SU, 0, nU), j = Math.min(nU - 1, Math.floor(f)); return g[j] + (g[j + 1] - g[j]) * (f - j); };
  const S = gridFn(Sgrid), Dx = gridFn(Dgrid);
  const sinA = Math.sin(opt.routeAngle), cosA = Math.cos(opt.routeAngle);
  const speed = S(span) / Math.max(1, span), descent = speed * sinA;
  // The loop seam: each marble rolls out of a short pipe stub at its start and into an identical
  // stub at its end. The first marble's two stubs sit in identical, reserved "seam frames" (same
  // rails in and out, nothing else), so the last frame of the video matches the first exactly.
  const SEAM = { w: 4.8, h: 3.4, stubLen: 0.36, rail: 3.2, margin: 0.35, shadow: 0.8, launch: 0.09 };
  const slopeT = opt.topSlope;

  // x bounces between -A and A (a triangle wave), y descends; starts near the lift heading left
  const tri = (u) => { const m = (((u + A) % (4 * A)) + 4 * A) % (4 * A); return m < 2 * A ? m - A : 3 * A - m; };
  let offset = 0;
  const xRoute = (t) => tri(A - 0.7 - cosA * S(t - offset));
  const yTarget = (t) => -sinA * S(t - offset) - Dx(t - offset);
  // The second marble chases the FIRST marble's actual (smoothed) position, laneDrop below it.
  let lead = null, dropScale = 1; // (dropScale: varied if a lane has to be re-planned)
  const target = (k, t) => {
    const drop = k * opt.laneDrop * dropScale;
    const xr = xRoute(t), yr = yTarget(t) - drop;
    if (k === 0 || !lead) return { x: xr, y: yr };
    const w = lead.weight(t);
    if (!w) return { x: xr, y: yr };
    const q = lead.at(t);
    return avoidSeams({ x: (1 - w) * xr + w * q.x, y: (1 - w) * yr + w * (q.y - drop) });
  };
  // The lanes behind steer around the reserved seam frames (instead of discovering them late):
  // a target inside one moves to just outside its nearer side.
  let seamBoxes = [];
  const avoidSeams = (p) => {
    for (const b of seamBoxes) {
      if (p.x <= b.x0 - 0.4 || p.x >= b.x1 + 0.4 || p.y <= b.y0 - 0.4 || p.y >= b.y1 + 0.4) continue;
      const opts = [{ x: b.x0 - 0.5, y: p.y }, { x: b.x1 + 0.5, y: p.y }, { x: p.x, y: b.y0 - 0.5 }];
      return opts.reduce((a, c) => (Math.hypot(c.x - p.x, c.y - p.y) < Math.hypot(a.x - p.x, a.y - p.y) ? c : a));
    }
    return p;
  };

  // ---------------------------------------------------------------- obstacle queries
  const grid = new ObstacleGrid();
  // what matters to lane k: its own pieces + brackets of lanes in front (they run back to the wall)
  const relFor = (k) => (o) => o.k === k || (!o.own && o.k < k);
  const ROOM = (o, sc, prev) => (o.path ? (o.idx === prev - 1 ? 0.06 + 0.14 * sc : 0.2) : !o.own ? 0.09
    : o.hitIdx === prev ? MARBLE_R + o.r + 0.03 : 0.1 + 0.14 * sc);
  /** Is there room for a new pad (size `sc`) at (x, y), placed right after pad `prev`? (taste) */
  const roomBlocked = (w, rel, x, y, sc = 1, prev = -9) => w.some(x, y, 0.24, (o) => rel(o) && distSeg(x, y, o) < ROOM(o, sc, prev));
  /** Is (x, y) right on an earlier flight of this lane? No pad can ever be placed there. */
  const onOldPath = (w, k, x, y, i) => w.some(x, y, 0.08, (o) => o.path && o.k === k && o.idx < i && Math.hypot(o.x1 - x, o.y1 - y) < 0.07);
  /** Would a pad here visually overlap a piece of a lane in front (different depth, so legal)? */
  const overlapsFront = (w, k, x, y) => w.some(x, y, 0.2, (o) => o.own && !o.path && o.k < k && distSeg(x, y, o) < 0.17);
  /** Does a marble at q hit anything solid (ignoring only what it's touching at P)? */
  const solidHit = (w, rel, q, P, margin) => {
    const away = Math.hypot(q.x - P.x, q.y - P.y) > 0.12;
    return w.some(q.x, q.y, MARBLE_R + 0.08 + margin, (o) => !o.path && rel(o) &&
      distSeg(q.x, q.y, o) < MARBLE_R + o.r + margin &&
      (away || !o.own || distSeg(P.x, P.y, o) > MARBLE_R + o.r + 0.006));
  };
  /** Points along a flight, including where it lands. */
  const sampleFlight = (p, v, T0) => {
    const n = Math.max(2, Math.ceil((Math.hypot(v.x, v.y) * T0) / 0.02));
    return Array.from({ length: n }, (_, j) => flightPos(p, v, ((j + 1) / n) * T0));
  };

  const lanes = parts.map((p, k) => ({
    k, name: p.name, style: p.style, role: p.role, groups: p.groups,
    z: opt.laneZ0 + (parts.length - 1 - k) * opt.laneGap,
    segs: [], hits: [], rails: [],
  }));

  // ---------------------------------------------------------------- intro (stub -> start rail -> drop)
  // The path starts at the stub's centre; the rail is drawn from its mouth (s0 = stubLen / 2).
  // The first marble's start rail runs out of the seam frame before it drops onto the first note.
  const introLen = (k, rail = 0.9) => SEAM.stubLen / 2 + (k === 0 ? SEAM.rail : rail);
  const buildIntro = (lane, y, rail) => {
    const L = introLen(lane.k, rail), sx = lane.xStart + L * Math.cos(slopeT);
    const path = new Path({ x: sx, y }, Math.PI + slopeT);
    path.line(L);
    const roll = rollRail(path, 0.3, { drag: opt.rampDrag });
    const tDrop = 0.18;
    return { path, roll, tDrop, P0: flightPos(roll.end, roll.v, tDrop), vin0: flightVel(roll.v, tDrop), time: roll.duration + tDrop,
      stub: { x: sx, y, angle: Math.PI + slopeT } };
  };
  const minLaunch = (k) => (k === 0 ? SEAM.launch : 0.3); // time hidden in the start stub
  for (const lane of lanes) {
    lane.xStart = clamp(xRoute(offset + lane.groups[0].t - g0), -A, liftX - 0.5);
    lane.introTime = buildIntro(lane, 0).time;
  }
  offset = Math.max(...lanes.map((l) => minLaunch(l.k) + l.introTime - (l.groups[0].t - g0)));
  const timeOf = (t) => offset + (t - g0);

  // the seam frames: reserved boxes nothing else may enter (pads, track, brackets, other lanes)
  const seamBox = (c) => ({ x0: c.x - SEAM.w / 2 - SEAM.margin, x1: c.x + SEAM.w / 2 + SEAM.margin,
    y0: c.y - SEAM.h / 2 - SEAM.margin, y1: c.y + SEAM.h / 2 + SEAM.margin + SEAM.shadow });
  const reserve = (b) => {
    const out = [];
    for (let y = b.y0; y <= b.y1 + 1e-9; y += 0.3) out.push({ k: -1, own: false, reserved: true, x1: b.x0, y1: y, x2: b.x1, y2: y, r: 0.18 });
    grid.push(...out);
  };
  const inBox = (b, x, y, pad = 0) => x > b.x0 - pad && x < b.x1 + pad && y > b.y0 - pad && y < b.y1 + pad;
  const stubObstacle = (k, st) => {
    const hx = Math.cos(st.angle) * SEAM.stubLen / 2, hy = Math.sin(st.angle) * SEAM.stubLen / 2;
    return { k, own: true, x1: st.x - hx, y1: st.y - hy, x2: st.x + hx, y2: st.y + hy, r: TUBE_R };
  };
  /** A stub hangs from one bracket under its middle (running back to the wall like all brackets). */
  const stubBracket = (st) => {
    const c = Math.cos(st.angle), sn = Math.sin(st.angle);
    const n = c >= 0 ? { x: sn, y: -c } : { x: -sn, y: c }; // the side below the pipe
    return { x: st.x + n.x * (TUBE_R + 0.01), y: st.y + n.y * (TUBE_R + 0.01) };
  };
  const stubObstacles = (k, st) => { const b = stubBracket(st); return [stubObstacle(k, st), { k, own: false, bracket: true, x1: b.x, y1: b.y, x2: b.x, y2: b.y, r: 0.012 }]; };
  /** A decorative rail continuing straight out of a stub (so both seam frames look the same). */
  const decoRail = (k, st, angle) => {
    const path = new Path({ x: st.x, y: st.y }, angle);
    path.line(SEAM.stubLen / 2 + SEAM.rail);
    const obs = railObstacles(k, path, path.len, false, SEAM.stubLen / 2);
    return { rail: { path, s0: SEAM.stubLen / 2, sEnd: path.len, kind: 'deco', brackets: obs.brackets }, obs };
  };
  // the first marble's start is known now: reserve its seam frame before anything is planned
  lanes[0].xStart = clamp(xRoute(timeOf(lanes[0].groups[0].t)), -A, liftX - 0.5);
  const seamTop = buildIntro(lanes[0], target(0, timeOf(lanes[0].groups[0].t)).y - buildIntro(lanes[0], 0).P0.y).stub;
  const boxTop = seamBox(seamTop);
  reserve(boxTop);
  let seamBottom = null, boxBottom = null;

  // ---------------------------------------------------------------- plan each lane (front first)
  // If a lane still needs a compromise (the lane in front fixed things exactly where it needed
  // room), plan it again with small variations - a different gap below the first marble and a
  // different style sequence - and keep the cleanest result.
  for (const lane of lanes) {
    const grid0 = grid.length;
    let best = null;
    for (const scale of [1, 1.3, 0.75]) {
      dropScale = scale;
      Object.assign(lane, { segs: [], hits: [], rails: [], compromises: 0 });
      planLane(lane);
      const bad = lane.hits.filter((h) => h.pen >= 30).length;
      if (!best || bad < best.bad) best = { bad, scale, lane: { ...lane }, obs: grid.list.slice(grid0) };
      if (!bad) break;
      grid.length = grid0;
    }
    if (best.lane.hits !== lane.hits) { // an earlier attempt was better: restore it
      Object.assign(lane, best.lane);
      grid.length = grid0;
      grid.push(...best.obs);
    }
    lane.dropScale = best.scale;
    dropScale = 1;
    if (lane.k === 0) {
      lead = smoothPath(lane);
      seamBottom = lane.stubIn;
      boxBottom = lane.box || seamBox(seamBottom);
      reserve(boxBottom);
      seamBoxes = [boxTop, boxBottom];
    }
  }

  function smoothPath(lane) {
    const ta = lane.hits[0].t, tb = lane.hits[lane.hits.length - 1].t;
    const segs = [...lane.segs].sort((a, b) => a.t0 - b.t0);
    const posAt = (t) => { let seg = segs[0]; for (const sg of segs) if (sg.t0 <= t) seg = sg; return evalSeg(seg, clamp(t - seg.t0, 0, seg.t1 - seg.t0)); };
    const step = 0.1, n = Math.ceil((tb - ta) / step);
    const ps = Array.from({ length: n + 1 }, (_, j) => posAt(ta + j * step));
    // smooth over +-0.6 s so the follower tracks the overall path, not every zig-zag
    const sm = ps.map((_, j) => { let x = 0, y = 0, c = 0; for (let d = -6; d <= 6; d++) if (ps[j + d]) { x += ps[j + d].x; y += ps[j + d].y; c++; } return { x: x / c, y: y / c }; });
    return {
      at: (t) => { const f = clamp((t - ta) / step, 0, n), j = Math.min(n - 1, Math.floor(f)), u = f - j; return n ? { x: sm[j].x + (sm[j + 1].x - sm[j].x) * u, y: sm[j].y + (sm[j + 1].y - sm[j].y) * u } : sm[0]; },
      weight: (t) => clamp(Math.min(t - ta + 1, tb + 1 - t), 0, 1), // fade in/out over 1 s at the ends
    };
  }

  function planLane(lane) {
    const { k } = lane;
    const rel = relFor(k);
    const T = lane.groups.map((g) => timeOf(g.t));
    const N = T.length;
    const scaleOf = (j) => clamp(Math.min(j > 0 ? T[j] - T[j - 1] : 9, j < N - 1 ? T[j + 1] - T[j] : 9) / 0.3, lane.style === 'drums' ? 0.5 : 0.38, 1);
    // bounce style per note (travel with the route / zig-zag across it / drop): fixed per note so
    // every candidate course shares the same style plan
    const modes = [];
    for (let i = 0; i < N;) {
      const r = rng(), mode = i === 0 ? 'trav' : r < 0.55 ? 'trav' : r < 0.9 ? 'zig' : 'drop';
      const run = 3 + Math.floor(rng() * 6), zigW = 0.32 + rng() * 0.25;
      for (let j = 0; j < run && i < N; j++, i++) modes.push({ mode, zigW });
    }
    const hitBase = (i) => {
      const notes = lane.groups[i].notes, pitched = notes.filter((n) => n.ch !== 9);
      return { t: T[i], notes, type: padType(lane.style, notes, lane.groups[i].obj), scale: scaleOf(i), midi: pitched.length ? Math.max(...pitched.map((n) => n.midi)) : 60 };
    };

    // ---- starting candidates (a lane starting later leaves its lift part-way down)
    const roots = [];
    {
      const x0 = k === 0 ? lanes[0].xStart : clamp(xRoute(T[0]), -A, liftX - 0.5);
      lane.xStart = x0;
      const y0 = target(k, T[0]).y - buildIntro(lane, 0).P0.y;
      const far = { x: 1e9, y: 1e9 }, w = new World(grid, null);
      const clear = (it) => {
        if (w.some(it.stub.x, it.stub.y, 0.4, (o) => !o.path && rel(o) && segDist(stubObstacle(k, it.stub), o) < TUBE_R + o.r + 0.01)) return false;
        for (let s = 0; s <= it.roll.sEnd; s += 0.03) { const q = it.path.at(s); if (solidHit(w, rel, { x: q.x + q.nx * MARBLE_R, y: q.y + q.ny * MARBLE_R }, far, 0.02) || solidHit(w, rel, q, far, 0.01)) return false; }
        for (let j = 1; j <= 20; j++) if (solidHit(w, rel, flightPos(it.roll.end, it.roll.v, (j / 20) * it.tDrop), far, 0.01)) return false;
        return true;
      };
      // every clear start position within reach, then a well-spread selection of them (nearest
      // first): if the area near the target is boxed in, some candidates start somewhere else
      const clearStarts = [];
      // (a later-starting marble's start rail may be longer, so its stub can sit clear of the
      // busy area the first marble is passing through, while it rolls in to the right spot)
      for (const rail of k === 0 ? [0.9] : [0.9, 1.6, 2.4])
      for (const dy of [0, 0.2, -0.2, 0.4, -0.4, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2, 1.6, -1.6, 2.1, -2.1]) {
        for (const dx of [0, -0.3, 0.3, -0.6, 0.6, -1, 1, -1.4, 1.4, -1.9, 1.9]) {
          lane.xStart = clamp(x0 + dx, -half, liftX - 0.5);
          const it = buildIntro(lane, y0 + dy, rail);
          if (T[0] - it.time < minLaunch(k) - 1e-9) continue; // must leave its stub after the loop starts
          if (k > 0 && !clear(it)) continue;
          clearStarts.push({ it, at: { x: lane.xStart, y: y0 + dy }, cost: 0.5 * Math.abs(dy) + 0.3 * Math.abs(dx) + 0.2 * (rail - 0.9) });
          if (k === 0) break;
        }
        if (k === 0 && clearStarts.length) break;
      }
      clearStarts.sort((a, b) => a.cost - b.cost);
      for (const c of clearStarts.slice(0, k === 0 ? 1 : 16)) roots.push(makeRoot(c.it, c.at, c.cost));
      if (!roots.length) { lane.xStart = x0; roots.push(makeRoot(buildIntro(lane, y0), { x: x0, y: y0 }, 0)); }
    }
    function makeRoot(it, at, cost) {
      const launch = T[0] - it.time;
      const top = railObstacles(k, it.path, it.roll.sEnd, false, SEAM.stubLen / 2);
      const obs = [...top, ...stubObstacles(k, it.stub), ...pathObstacles(k, it.roll.end, it.roll.v, it.tDrop, -1)];
      const rails = [{ path: it.path, s0: SEAM.stubLen / 2, sEnd: it.roll.sEnd, kind: 'top', brackets: top.brackets }];
      if (k === 0) { const d = decoRail(k, it.stub, slopeT); rails.push(d.rail); obs.push(...d.obs); } // the "rail in" of the seam frame
      return { depth: 0, P: it.P0, vin: it.vin0, dir: -1, cost, parent: null, committed: false, obs, bbox: bboxOf(obs),
        segs: [{ type: 'hidden', t0: 0, t1: launch, p: { x: it.stub.x, y: it.stub.y } },
          { type: 'rail', t0: launch, t1: launch + it.roll.duration, xs: it.roll.xs, ys: it.roll.ys },
          { type: 'flight', t0: launch + it.roll.duration, t1: T[0], p: it.roll.end, v: it.roll.v }],
        rails, start: { xStart: at.x, yTop: at.y, intro: it, launch, stubOut: it.stub } };
    }

    // ---- beam search over the notes
    let committedDepth = -1, committedNode = null, rewinds = 0;
    const commit = (n) => {
      grid.push(...n.obs);
      lane.segs.push(...n.segs);
      lane.rails.push(...n.rails);
      if (n.hit) lane.hits.push(n.hit);
      if (n.start) Object.assign(lane, { xStart: n.start.xStart, yTop: n.start.yTop, intro: n.start.intro, launch: n.start.launch, stubOut: n.start.stubOut });
      if (n.end) Object.assign(lane, n.end);
      n.committed = true;
      committedDepth = n.depth;
      committedNode = n;
    };
    const ancestorAt = (n, d) => { while (n && n.depth > d) n = n.parent; return n; };
    /** The best `width` candidates: no near-duplicates, at most 3 per parent, consistent with what's committed. */
    const select = (cands, width) => {
      const seen = new Set(), out = [], perParent = new Map();
      for (const c of cands) {
        if (committedNode && ancestorAt(c, committedDepth) !== committedNode) continue;
        const key = `${Math.round(c.P.x / 0.04)},${Math.round(c.P.y / 0.04)},${Math.sign(c.vin.x)}`;
        if (seen.has(key) || (perParent.get(c.parent) || 0) >= 3) continue;
        seen.add(key);
        perParent.set(c.parent, (perParent.get(c.parent) || 0) + 1);
        out.push(materialize(c));
        if (out.length >= width) break;
      }
      return out;
    };
    const LAG = 16; // keep the last few notes open, so a dead end can still be backed out of
    const history = []; // history[d] = every candidate seen for depth d, best first
    history[0] = [...roots].sort((a, b) => a.cost - b.cost);
    let beam = select(history[0], BEAM), wideUntil = -1, wideMul = 3;
    const rewound = [];
    for (let d = 0; d <= N - 1;) {
      if (opt.onProgress && d % 4 === 0) opt.onProgress({ lane: k, lanes: lanes.length, name: lane.name, done: d / N });
      const width = d <= wideUntil ? BEAM * wideMul : BEAM;
      let kids = [];
      for (const node of beam) kids.push(...expand(node, false, 1));
      if (!kids.length) for (const node of beam) kids.push(...expand(node, false, 3)); // look wider
      if (!kids.length) {
        // Dead end for every candidate: back up a few notes and search that stretch with a
        // wider beam. Only if that can't help, allow a compromise for this one step.
        // 1st: 4 notes back, 3x wider; 2nd: 8 back, 5x; 3rd: the whole open window, 8x
        const tries = rewound[d] || 0, STAGES = [[4, 3], [8, 5], [Infinity, 8]];
        if (tries < STAGES.length && rewinds < N) {
          const [back, mul] = STAGES[tries];
          const j = Math.max(committedDepth + 1, d - back);
          rewound[d] = tries + 1;
          // back up to note j (or, if there's nothing earlier, try this note's unused alternatives)
          const alt = select(j < d ? history[j] : history[d].filter((c) => !beam.includes(c)), BEAM * mul);
          if (alt.length) { rewinds++; beam = alt; wideUntil = d + 2; wideMul = mul; d = j; continue; }
          continue; // (nothing to back into at this stage: try the next one)
        }
        for (const node of beam) kids.push(...expand(node, true, 1));
        lane.compromises = (lane.compromises || 0) + 1;
      }
      kids.sort((a, b) => a.cost - b.cost);
      history[d + 1] = kids;
      beam = select(kids, width);
      d++;
      // commit what every candidate agrees on (once it's LAG notes back); never let the undecided
      // window grow beyond WINDOW
      for (;;) {
        const dd = committedDepth + 1;
        if (dd > beam[0].depth) break;
        const a = ancestorAt(beam[0], dd);
        if (dd <= d - LAG && beam.every((n) => ancestorAt(n, dd) === a)) { commit(a); continue; }
        if (beam[0].depth - committedDepth > WINDOW) {
          const keep = ancestorAt(beam[0], dd);
          beam = beam.filter((n) => ancestorAt(n, dd) === keep);
          commit(keep);
          continue;
        }
        break;
      }
    }
    // the best complete course: commit the rest of its chain
    const best = beam[0], chain = [];
    for (let n = best; n && !n.committed; n = n.parent) chain.push(n);
    for (const n of chain.reverse()) commit(n);
    lane.beamWidth = BEAM;
    lane.rewinds = rewinds;

    // ---- one node's next steps
    function expand(node, soft, widen) {
      const i = node.depth, P = node.P, vin = node.vin;
      const w = new World(grid, node);
      const hit = { ...hitBase(i), pos: P, vin };
      if (i === N - 1) return outroOptions(node, w, hit, soft).map((o) => child(node, hit, o));
      const dt = T[i + 1] - T[i];
      const tg = target(k, T[i + 1]);
      const cx = target(k, T[i] + dt / 2).x;
      const c = { k, i, hit, P, vin, dt, yT: tg.y, xT: tg.x, nextScale: scaleOf(i + 1), mode: modes[i], dir: node.dir,
        hdir: Math.sign(target(k, T[i + 1] + 0.05).x - target(k, T[i + 1]).x) || -1,
        xAhead: target(k, T[i] + dt + 1.0).x,
        // a widened search also looks further from where the marble "should" be
        xMin: Math.max(-half, Math.min(P.x, cx) - (widen > 1 ? 1.6 : 1.0)), xMax: Math.min(half, Math.max(P.x, cx) + (widen > 1 ? 1.6 : 1.0)), widen };
      { // ramps may span everywhere the target goes during the gap, so a long rest can follow it
        let lo = Math.min(P.x, c.xMin), hi = Math.max(P.x, c.xMax);
        for (let t = T[i]; t <= T[i + 1]; t += 0.1) { const x = target(k, t).x; lo = Math.min(lo, x - 0.6); hi = Math.max(hi, x + 0.6); }
        c.rMin = Math.max(-half, lo); c.rMax = Math.min(half, hi);
      }
      const below = P.y < c.yT - 0.35;
      const opts = [];
      const keep = PER_NODE * widen;
      // a lob can cover up to ~2 vMax / G under the speed cap (the filter rejects anything faster)
      if (dt <= (2 * opt.vMax) / G || soft) opts.push(...bounceOptions(c, w, soft, keep));
      if (dt > flightMax || (below && dt >= opt.shelfMin)) {
        // layouts: wide (follows the target across the gap), compact between here and the landing
        // spot, and (when looking wider) a compact stack right where the marble is
        opts.push(...rampOptions(c, w, c.rMin, c.rMax, soft, keep));
        if (dt >= 1.5) opts.push(...rampOptions(c, w, Math.max(-half, Math.min(P.x, c.xT) - 1.0), Math.min(half, Math.max(P.x, c.xT) + 1.0), soft, keep));
        if (dt >= 1.5 && widen > 1) opts.push(...rampOptions(c, w, Math.max(-half, P.x - 0.9), Math.min(half, P.x + 0.9), soft, keep));
      }
      opts.sort((a, b) => a.cost - b.cost);
      return opts.slice(0, keep).map((o) => child(node, hit, o));
    }

    /**
     * Make the child node: fixes pad i (its tilt from v_out). Its pieces (obstacles, track,
     * segments) are only built if it survives into the beam (see materialize).
     */
    function child(node, base, o) {
      const i = node.depth;
      const hit = { ...base, vout: o.vout, cost: o.cost, pen: o.pen || 0 };
      setNormal(hit);
      let P, vin, dir = node.dir;
      if (o.kind === 'ramp') { P = flightPos(o.r.end, o.r.v, o.tEx); vin = flightVel(o.r.v, o.tEx); dir = Math.sign(o.r.v.x) || dir; }
      else if (o.kind === 'outro') { P = o.r.end; vin = { x: 0, y: 0 }; }
      else { const dt = T[i + 1] - T[i]; P = flightPos(node.P, o.vout, dt); vin = flightVel(o.vout, dt); dir = Math.sign(o.vout.x) || dir; }
      return { depth: i + 1, P, vin, dir, cost: node.cost + o.cost, parent: node, committed: false, hit, o, obs: null };
    }

    function materialize(n) {
      if (n.obs) return n;
      const { o, hit } = n, node = n.parent, i = node.depth;
      const obs = [...padObstacle(k, hit, i)], segs = [], rails = [];
      if (o.kind === 'ramp') {
        hit.ramp = true;
        const { kick, t1, rp, r, tEx, tube, sTube, drop } = o;
        segs.push({ type: 'flight', t0: T[i], t1: T[i] + t1, p: node.P, v: kick });
        const tR0 = T[i] + t1, tR1 = tR0 + r.duration;
        segs.push({ type: 'rail', t0: tR0, t1: tR1, xs: r.xs, ys: r.ys });
        segs.push({ type: 'flight', t0: tR1, t1: T[i + 1], p: r.end, v: r.v });
        if (!tube || sTube > 0) { // open rail (all of it, or the part before the tube)
          const rObs = railObstacles(k, rp, tube ? sTube : r.sEnd, false);
          rails.push({ path: rp, s0: 0, sEnd: tube ? sTube : r.sEnd, kind: 'ramp', tube: false, drop, brackets: rObs.brackets, t0: tR0 });
          obs.push(...rObs);
        }
        if (tube) {
          const tObs = railObstacles(k, rp, r.sEnd, true, sTube);
          rails.push({ path: rp, s0: sTube, sEnd: r.sEnd, kind: 'ramp', tube: true, drop: sTube > 0 ? drop : 0, brackets: tObs.brackets, t0: tR0 });
          obs.push(...tObs);
        }
        obs.push(...pathObstacles(k, node.P, kick, t1, i), ...pathObstacles(k, r.end, r.v, tEx, i));
      } else if (o.kind === 'outro') {
        const { tf, gp, r, stub, box } = o;
        segs.push({ type: 'flight', t0: hit.t, t1: hit.t + tf, p: node.P, v: o.vout });
        segs.push({ type: 'rail', t0: hit.t + tf, t1: hit.t + tf + r.duration, xs: r.xs, ys: r.ys });
        // brackets measured outwards from the stub, exactly like the start's "rail in"
        const back = new Path({ x: stub.x, y: stub.y }, slopeT);
        back.line(gp.len);
        const gObs = railObstacles(k, back, back.len, false, SEAM.stubLen / 2);
        rails.push({ path: gp, s0: 0, sEnd: gp.len - SEAM.stubLen / 2, kind: 'gutter', brackets: gObs.brackets });
        obs.push(...pathObstacles(k, node.P, o.vout, tf, i), ...gObs, ...stubObstacles(k, stub));
        if (k === 0) { const d = decoRail(k, stub, Math.PI + slopeT); rails.push(d.rail); obs.push(...d.obs); } // the "rail out"
        n.end = { arrive: hit.t + tf + r.duration, base: { x: stub.x, y: stub.y }, stubIn: stub, box };
      } else {
        segs.push({ type: 'flight', t0: T[i], t1: T[i + 1], p: node.P, v: o.vout });
        obs.push(...pathObstacles(k, node.P, o.vout, T[i + 1] - T[i], i));
      }
      Object.assign(n, { obs, bbox: bboxOf(obs), segs, rails, o: null });
      return n;
    }

    // ---- bounces: the hard rules filter, costs are taste
    function bounceOptions(c, w, soft, keep) {
      const { i, hit, P, vin, dt, yT, xT, xMin, xMax, xAhead } = c;
      const sIn = Math.hypot(vin.x, vin.y);
      const below = P.y < yT - 0.3, catchUp = P.y > yT + 0.3; // lagging below / fallen behind (too high)
      const apexMax = below ? 0.8 : 0.4;
      const { mode, zigW } = c.mode;
      const pref = mode === 'trav' ? xT : mode === 'zig' ? xT + (P.x > xT ? -1 : 1) * zigW / 2 : P.x + c.dir * opt.minDisp;
      // very quick notes get closer pads (a quick double-tap) instead of a fast throw
      const minDisp = Math.min(opt.minDisp * 0.7, 0.5 * Math.min(opt.vMax, opt.maxGain * sIn) * dt);
      const step = Math.min(0.06, minDisp / 2);
      const dyLo = -Math.max(2.4, 0.5 * G * dt * dt + 0.6);
      const cands = [];
      for (let x = Math.max(xMin, P.x - 1.5); x <= Math.min(xMax, P.x + 1.5) + 1e-9; x += step) {
        if (Math.abs(x - P.x) < minDisp) continue;
        const xe = Math.abs(x - xT);
        // turning back early beats stepping further away (a staircase it can't reverse over later)
        const away = (Math.sign(x - P.x) !== Math.sign(xT - P.x) && Math.abs(xT - P.x) > opt.corridor ? 3 : 0) +
          (Math.sign(x - P.x) !== Math.sign(xAhead - P.x) && Math.abs(xAhead - P.x) > 0.3 ? 2 : 0);
        const xCost = 0.7 * Math.min(1.5, Math.abs(x - pref)) + 0.8 * xe + 5 * Math.max(0, xe - opt.corridor) + away;
        for (let dy = dyLo; dy <= 0.9; dy += 0.03) {
          const v = { x: (x - P.x) / dt, y: (dy + 0.5 * G * dt * dt) / dt };
          const sp = Math.hypot(v.x, v.y);
          const peak = Math.max(sp, Math.hypot(v.x, v.y - G * dt)); // fastest point of the flight
          const ratio = sp / sIn;
          const gains = ratio > opt.maxGain, tooFast = peak > opt.vMax;
          const nx0 = v.x - vin.x, ny0 = v.y - vin.y, nl = Math.hypot(nx0, ny0) || 1;
          const ny = ny0 / nl;
          const incidence = -(vin.x * nx0 + vin.y * ny0) / nl / sIn; // how head-on the hit is
          const departure = (v.x * nx0 + v.y * ny0) / nl / sp; // must leave AWAY from the pad
          const good = incidence >= 0.4 && departure >= 0.4 && !gains && !tooFast;
          if (!good && !soft) continue; // hard rules
          const apex = v.y > 0 ? (v.y * v.y) / (2 * G) : 0;
          const err = Math.abs(P.y + dy - yT), high = P.y + dy - yT;
          let cost = xCost + 2 * err + 3 * Math.max(0, err - 0.6) + 6 * Math.max(0, high - 0.4) +
            (below ? 0 : 3 * Math.max(0, dy)) + 2 * Math.max(0, ratio - 1) +
            4 * Math.max(0, (catchUp ? 0.35 : 0.55) - ratio) + (catchUp ? 2 * err : 0) +
            (ny >= 0.3 ? 0 : ny > -0.3 ? (catchUp ? 0.5 : 3) : 10) + // floor pads; walls to catch up; undersides rarely
            4 * Math.max(0, apex - apexMax) + 3 * Math.max(0, peak - 0.8 * opt.vMax) + 2 * Math.max(0, 0.8 - sp) +
            (below ? 1.5 : 6) * Math.max(0, (v.y - G * dt) / sp); // arrive on the way down
          let pen = 0;
          if (!good) { // soft mode only
            pen = (tooFast || gains ? 40 : 30);
            cost += 15 * Math.max(0, 0.4 - incidence) + 15 * Math.max(0, 0.4 - departure) +
              (tooFast ? 25 + 20 * (peak - opt.vMax) : 0) + (gains ? 40 + 60 * (ratio - opt.maxGain) : 0) + 30;
          }
          cands.push({ cost, pen, v, x, dy, n: { x: nx0 / nl, y: ny }, sp });
        }
      }
      cands.sort((a, b) => a.cost - b.cost);
      // validate cheapest-first; keep a few distinct valid ones
      const out = [];
      let checks = 0;
      for (const cd of cands) {
        if (out.length >= keep || checks > (c.widen > 1 ? 4000 : 250)) break;
        if (out.some((o) => Math.abs(o.x - cd.x) < 0.07 && Math.abs(o.dy - cd.dy) < 0.07)) continue;
        checks++;
        const own = padSeg(P, cd.n, hit.type, hit.midi, hit.scale);
        let clips = !padClear(own, w, rel, i - 1, P) || bodyHits(own, w, rel);
        const steps = Math.max(8, Math.ceil((cd.sp * dt) / 0.02));
        for (let j = 1; j <= steps && !clips; j++) { // (j = steps: the landing spot itself)
          const q = flightPos(P, cd.v, (j / steps) * dt);
          if (distSeg(q.x, q.y, own) < MARBLE_R + own.r + 0.002 || solidHit(w, rel, q, P, j > steps - 3 ? 0.004 : 0.015)) clips = true;
        }
        // landing right on an earlier flight would leave no room for the next pad at all
        if (!clips && onOldPath(w, k, cd.x, P.y + cd.dy, i)) clips = true;
        let { cost, pen } = cd;
        if (clips) { if (!soft) continue; cost += 100; pen = 100; } // clipping: a no-go
        if (roomBlocked(w, rel, cd.x, P.y + cd.dy, c.nextScale, i)) cost += 10; // keep pads spaced out
        if (overlapsFront(w, k, cd.x, P.y + cd.dy)) cost += 3;
        out.push({ kind: 'bounce', cost, pen, vout: cd.v, x: cd.x, dy: cd.dy });
      }
      if (soft && !out.length) // truly nothing: a gentle short hop along the route
        out.push({ kind: 'bounce', cost: 500, pen: 100, vout: { x: c.hdir * minDisp / dt, y: 0.5 * G * dt - 0.05 / dt }, x: P.x, dy: 0 });
      return out;
    }

    // ---- ramps: kick onto a rail (dropping on at an angle) or into a glass tube (if it loops back)
    function rampOptions(c, w, rMin, rMax, soft, keep) {
      const { i, hit, P, vin, dt, yT, xT, hdir } = c;
      const eR = rMax - opt.switchR, eL = rMin + opt.switchR;
      const sIn = Math.hypot(vin.x, vin.y);
      const room = (d, x) => (d > 0 ? eR - x : x - eL);
      const flightClear = (pts) => !pts.some((q) => solidHit(w, rel, q, P, 0.01));
      const out = [];
      const worst = () => (out.length >= keep ? out[out.length - 1].cost : Infinity);
      const add = (o) => { out.push(o); out.sort((a, b) => a.cost - b.cost); if (out.length > keep) out.pop(); };
      const dir0 = hdir || c.dir || 1;
      const kicks = opt.kicks;
      for (const d0 of [dir0, -dir0])
        for (const kv of kicks)
          for (const slope of keep > PER_NODE ? WIDE_SLOPES : opt.rampSlopes)
            for (const phi of RAMP_DROPS) { // 0: flies exactly along the ramp (tubes); > 0: drops onto a rail
              const { t1, vh } = kv;
              if (room(d0, P.x) < 0.25 + vh * t1) continue;
              const kick = { x: d0 * vh, y: G * t1 - vh * Math.tan(slope + phi) };
              const kn = { x: kick.x - vin.x, y: kick.y - vin.y }, knl = Math.hypot(kn.x, kn.y);
              // a real hit: head-on, and leaving away from the pad
              const headOn = -(vin.x * kn.x + vin.y * kn.y) / knl / sIn >= 0.3 &&
                (kick.x * kn.x + kick.y * kn.y) / knl / Math.hypot(kick.x, kick.y) >= 0.3;
              const gains = Math.hypot(kick.x, kick.y) > opt.maxGain * sIn;
              if (!soft && (!headOn || gains)) continue;
              const kickPad = padSeg(P, { x: kn.x / knl, y: kn.y / knl }, hit.type, hit.midi, hit.scale);
              const kickPts = sampleFlight(P, kick, t1);
              const kickClips = !flightClear(kickPts) || !padClear(kickPad, w, rel, i - 1, P) || bodyHits(kickPad, w, rel) ||
                kickPts.some((q) => distSeg(q.x, q.y, kickPad) < MARBLE_R + kickPad.r + 0.002);
              if (kickClips && !soft) continue;
              const start = flightPos(P, kick, t1);
              const tEmax = Math.max(opt.exitTime, Math.min(0.62, dt - t1 - 0.25, opt.vMax / G));
              // one simulation (for the longest ramp); each drop-off time is a prefix of it
              let d = d0;
              const rp = new Path(start, d > 0 ? -slope : Math.PI + slope);
              rp.line(Math.max(0.05, room(d, start.x)) / Math.cos(slope));
              const extend = (pth) => {
                pth.arc(opt.switchR, d > 0 ? -(Math.PI - 2 * slope) : Math.PI - 2 * slope);
                d = -d;
                pth.line(Math.max(0.3, room(d, pth.end.x)) / Math.cos(slope));
              };
              const hop = phi ? settleOnRail(rp, flightVel(kick, t1)) : null;
              if (phi && !hop) continue;
              const hopT = hop ? hop.duration : 0;
              const raw = rollRaw(rp, hop ? hop.v : vh / Math.cos(slope), { drag: opt.rampDrag, budget: dt - t1 - opt.exitTime - hopT, extend, s0: hop ? hop.s : 0 });
              for (let tE = opt.exitTime; tE <= tEmax + 1e-9; tE += 0.04) {
                const r = cutRoll(rp, raw, dt - t1 - tE - hopT, hop);
                if (!r) continue;
                const firstArc = rp.pieces.find((pc) => pc.type === 'arc' && pc.s0 < r.sEnd - 1e-6);
                const tube = !!firstArc;
                // A looping ramp's loops are in a glass tube. Flying straight in: all tube. Dropped
                // on: an open rail first (it settles there), then into the tube before the first bend.
                const sTube = phi && tube ? firstArc.s0 - 0.12 : tube ? 0 : null;
                if (phi && tube && (!hop || hop.s > sTube - 0.03)) continue; // still settling at the mouth
                const tEx = dt - t1 - r.duration;
                const Q = flightPos(r.end, r.v, tEx);
                if (Q.x < -half - 0.1 || Q.x > half + 0.1) continue;
                const tooFast = Math.hypot(r.v.x, r.v.y - G * tEx) > opt.vMax;
                if (tooFast && !soft) continue;
                const err = Math.abs(Q.y - yT), xe = Math.abs(Q.x - xT);
                let cost = 0.6 + (d0 !== dir0 ? 0.5 : 0) + 2 * err + 3 * Math.max(0, err - 0.6) + tE + (kv === opt.kicks[0] ? 0 : 0.2) +
                  (!phi && !tube ? 0.8 : 0) + // open rails: prefer a natural drop over a "magnetic" exact landing
                  0.8 * xe + 5 * Math.max(0, xe - opt.corridor);
                let pen = 0;
                if (soft) {
                  if (kickClips) { cost += 100; pen = 100; }
                  if (gains || tooFast) { cost += 45; pen = Math.max(pen, 40); }
                  if (!headOn) { cost += 30; pen = Math.max(pen, 30); }
                }
                if (cost >= worst()) continue;
                // the track (a tube is fatter than the marble; an open rail sticks out under it) and
                // the drop off its end must clear everything
                let clips = false;
                const hopN = hop ? hop.xs.length : 0;
                for (let j = 0; j < r.xs.length && !clips; j += 6) {
                  const q = { x: r.xs[j], y: r.ys[j] };
                  // is this sample inside the tube part? (raw samples follow the hops)
                  const inTube = tube && (sTube === 0 || (j >= hopN && raw.ss[j - hopN] >= sTube));
                  if (solidHit(w, rel, q, P, inTube ? TUBE_R - MARBLE_R + 0.008 : 0.01) || distSeg(q.x, q.y, kickPad) < (inTube ? TUBE_R : MARBLE_R) + kickPad.r + 0.004) clips = true;
                }
                if (!clips && sTube !== 0) { // the open rail part (sticks out under the marble)
                  const RAIL = 0.012, railEnd = tube ? sTube : r.sEnd;
                  for (let s2 = 0; s2 <= railEnd && !clips; s2 += 0.025) {
                    const q = rp.at(s2), x = q.x + q.nx * MARBLE_R, y = q.y + q.ny * MARBLE_R;
                    if (distSeg(x, y, kickPad) < RAIL + kickPad.r + 0.004 || w.some(x, y, 0.15, (o) => !o.path && rel(o) && distSeg(x, y, o) < RAIL + o.r + 0.004)) clips = true;
                  }
                }
                if (!clips && !flightClear(sampleFlight(r.end, r.v, tEx))) clips = true;
                if (!clips && onOldPath(w, k, Q.x, Q.y, i)) clips = true;
                if (clips) { if (!soft) continue; cost += 100; pen = 100; }
                if (roomBlocked(w, rel, Q.x, Q.y, c.nextScale, i)) cost += 10;
                add({ kind: 'ramp', cost, pen, vout: kick, kick, t1, rp, r, tEx, tube, sTube, drop: phi });
              }
            }
      return out;
    }

    // ---- the last pad throws the marble onto a gutter that rolls (left) into its end stub. For
    // the first marble the stub's surroundings must match the start's seam frame exactly.
    function outroOptions(node, w, hit, soft) {
      const P = node.P, vin = node.vin;
      let yMin = P.y;
      for (let n = node; n; n = n.parent) if (n.hit) yMin = Math.min(yMin, n.hit.pos.y);
      for (const h of lane.hits) yMin = Math.min(yMin, h.pos.y);
      const lim = opt.maxGain * Math.hypot(vin.x, vin.y) * 0.99;
      const dir = { x: -Math.cos(slopeT), y: -Math.sin(slopeT) };
      const out = [];
      // (the first marble's gutter may be longer, so its end seam frame can sit out of the way of
      // the lanes behind)
      for (const Lg of k === 0 ? [SEAM.rail + 0.4, SEAM.rail + 1.8, SEAM.rail + 3.3].map((L) => SEAM.stubLen / 2 + L) : [SEAM.stubLen / 2 + 1.2])
      for (const yDrop of [0, 0.25, 0.5, 0.8, 1.2, 1.7, 2.3]) {
        const yG = yMin - 0.7 - yDrop;
        for (const vy0 of [1.0, 1.6, 0.5, 2.2, 0.0, 0.25, -0.3])
          for (const vxw of [0.7, -0.7, 1.2, -1.2, 0.3, -0.3, 0.15, -0.15]) {
            let vy = vy0, vx = vxw;
            let tf = (vy + Math.sqrt(vy * vy + 2 * G * (P.y - yG))) / G;
            const sp0 = Math.hypot(vx, vy);
            if (sp0 > lim) { vx *= lim / sp0; vy *= lim / sp0; tf = (vy + Math.sqrt(vy * vy + 2 * G * (P.y - yG))) / G; } // never a launch
            const v = { x: vx, y: vy };
            const nx = vx - vin.x, ny = vy - vin.y, nl = Math.hypot(nx, ny);
            const sp = Math.hypot(vx, vy) || 1;
            const departure = (vx * nx + vy * ny) / nl / sp;
            const incidence = -(vin.x * nx + vin.y * ny) / nl / Math.hypot(vin.x, vin.y);
            const real = departure >= 0.3 && incidence >= 0.3; // head-on, leaving away from the pad
            if (!real && !soft) continue;
            let cost = Math.abs(vy - 1) * 0.2 + Math.abs(Math.abs(vx) - 0.7) * 0.2 + yDrop + 0.3 * (Lg - SEAM.rail - 0.58), pen = real ? 0 : 30;
            if (pen) cost += 20;
            if (out.length && cost >= out[0].cost) continue;
            const land = flightPos(P, v, tf);
            const stub = { x: land.x + dir.x * Lg, y: land.y + dir.y * Lg, angle: Math.PI + slopeT };
            const own = padSeg(P, { x: nx / nl, y: ny / nl }, hit.type, hit.midi, hit.scale);
            let clips = !padClear(own, w, rel, i0(node), P) || bodyHits(own, w, rel);
            for (let j = 1; j <= 60 && !clips; j++) {
              const q = flightPos(P, v, (j / 60) * tf);
              if (distSeg(q.x, q.y, own) < MARBLE_R + own.r + 0.002 || solidHit(w, rel, q, P, 0.01)) clips = true;
            }
            const gp = new Path(land, Math.PI + slopeT);
            gp.line(Lg);
            for (let s2 = 0; s2 <= gp.len - SEAM.stubLen / 2 && !clips; s2 += 0.03) { const q = gp.at(s2); if (solidHit(w, rel, { x: q.x + q.nx * MARBLE_R, y: q.y + q.ny * MARBLE_R }, P, 0.02) || solidHit(w, rel, q, P, 0.004)) clips = true; }
            if (!clips && w.some(stub.x, stub.y, 0.4, (o) => !o.path && rel(o) && segDist(stubObstacle(k, stub), o) < TUBE_R + o.r + 0.01)) clips = true;
            let box = null;
            if (!clips && k === 0) {
              // the end seam frame must hold nothing but the stub and its rails: check the box
              box = seamBox(stub);
              if ([own.x1, own.x2].some((x, j) => inBox(box, x, j ? own.y2 : own.y1, own.r))) clips = true;
              for (let x = box.x0; x <= box.x1 && !clips; x += 0.2)
                for (let y = box.y0; y <= box.y1 && !clips; y += 0.2)
                  if (w.some(x, y, 0.3, (o) => !o.path && o.k >= 0 && distSeg(x, y, o) < 0.15 + o.r)) clips = true;
              if (!clips && inBox(boxTop, stub.x, stub.y, SEAM.w)) clips = true; // keep the two seams apart
              // leave room for the lanes behind: wherever they'll be playing (roughly a lane-gap below
              // where we are at their note times), keep the reserved frame out of the way
              if (!clips && parts.length > 1) {
                const near = behindPts(node).filter((q) => inBox(box, q.x, q.y, 0.6)).length;
                cost += 4 * near;
              }
            }
            if (clips) { if (!soft) continue; cost += 100; pen = 100; }
            // drops onto the gutter, settles, and rolls into the stub
            const r = landAndRoll(gp, flightVel(v, tf), { drag: opt.rampDrag * 0.5 }) || rollRail(gp, Math.max(0.4, Math.abs(vx)), { drag: opt.rampDrag * 0.5 });
            out.length = 0;
            out.push({ kind: 'outro', cost, pen, vout: v, tf, gp, r, stub, box });
          }
        if (out.length && !out[0].pen && out[0].cost < 2) break;
      }
      return out;
    }
    function i0(node) { return node.depth - 1; }

    /** Where the lanes behind will roughly be at their note times (lane 0 only; cached per node). */
    function behindPts(node) {
      if (node._behind) return node._behind;
      const hits = [...lane.hits];
      const chain = [];
      for (let n = node; n && !n.committed; n = n.parent) if (n.hit) chain.push(n.hit);
      hits.push(...chain.reverse());
      const at = (t) => { let lo = 0, hi = hits.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (hits[m].t <= t) lo = m; else hi = m - 1; } return hits[lo].pos; };
      const out = [];
      parts.forEach((p, kk) => {
        if (kk === 0) return;
        let last = -Infinity;
        for (const g of p.groups) {
          const t = timeOf(g.t);
          if (t - last < 0.25) continue;
          last = t;
          const q = at(t);
          out.push({ x: q.x, y: q.y - kk * opt.laneDrop });
        }
      });
      return (node._behind = out);
    }
  }

  // ---------------------------------------------------------------- loop closure
  // The loop ends just after the first marble disappears into its end stub (the same moment
  // before it appears from its start stub). Every other marble is tucked into its own end stub
  // well before that, so the seam frame is identical at both ends.
  const D = Math.max(lanes[0].arrive, ...lanes.slice(1).map((l) => l.arrive + 1.6)) + SEAM.launch;
  for (const lane of lanes) {
    lane.segs.push({ type: 'hidden', t0: lane.arrive, t1: D, p: lane.base });
    lane.segs.sort((a, b) => a.t0 - b.t0);
    lane.stubs = [{ ...lane.stubOut, role: 'out' }, { ...lane.stubIn, role: 'in' }].map((st) => ({ ...st, len: SEAM.stubLen, bracket: stubBracket(st) }));
  }
  const pts = lanes.flatMap((l) => [...l.hits.map((h) => h.pos), ...l.stubs, ...l.rails.flatMap((r) => [r.path.at(r.s0 || 0), r.path.at(r.sEnd)])]);
  const bounds = { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) };
  for (const b of [boxTop, boxBottom]) { bounds.x0 = Math.min(bounds.x0, b.x0); bounds.x1 = Math.max(bounds.x1, b.x1); bounds.y0 = Math.min(bounds.y0, b.y0); bounds.y1 = Math.max(bounds.y1, b.y1); }
  const seam = { top: { x: seamTop.x, y: seamTop.y }, bottom: { x: seamBottom.x, y: seamBottom.y }, angle: Math.PI + slopeT,
    plate: { w: SEAM.w, h: SEAM.h }, boxTop, boxBottom, stubLen: SEAM.stubLen, rail: SEAM.rail };

  return { lanes, D, offset, g0, half, opt, seam, bounds, speed, descent, yTarget, target, xRoute,
    yMin: bounds.y0, yMax: bounds.y1 };
}

/**
 * The plan as plain data for sending to another thread (structured clone): no functions, no
 * planning-only scratch data. Paths become plain objects; rehydratePlan restores them.
 */
export function toPlain(plan) {
  const { yTarget, target, xRoute, opt, ...rest } = plan;
  const { onProgress, ...o } = opt;
  return { ...rest, opt: o, lanes: plan.lanes.map(({ intro, starts, ...l }) => l) };
}

/**
 * A plan that crossed a thread boundary (structured clone) has plain objects where Paths were:
 * give them their methods back.
 */
export function rehydratePlan(plan) {
  for (const lane of plan.lanes) for (const r of lane.rails) Object.setPrototypeOf(r.path, Path.prototype);
  return plan;
}

/** Internal building blocks, exported for unit tests only. */
export const _internals = { rollRail, settleOnRail, landAndRoll };
