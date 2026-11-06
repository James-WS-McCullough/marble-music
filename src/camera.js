// The follow camera as a pure function of loop time: the same time always gives the same shot.
// That's what makes the loop seamless: at t = 0 and t = D the camera frames the start and end
// pipe stubs from exactly the same offset, and those two seam frames look identical.
import { marbleAt, lastHitIndex } from './planner.js';

const TAN = Math.tan((13 * Math.PI) / 180); // half the vertical field of view (fov 26)
const smooth = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

/** Framing of a seam stub: centred on it, zoomed in so the view stays inside its backing plate. */
export function seamPose(plan, which, aspect) {
  const c = plan.seam[which], { w, h } = plan.seam.plate;
  // (the camera looks slightly down, so the view reaches further below the stub: keep a margin)
  return { x: c.x, y: c.y, h: Math.min(2.0, h - 1.4, (w - 1.0) / aspect) };
}

/** Framing of the marbles that are playing right now (a hit in the last 1 s or next 1.5 s). */
function followAt(plan, tau, aspect) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const lane of plan.lanes) {
    const m = marbleAt(lane, tau);
    if (m.type === 'hidden') continue;
    const i = lastHitIndex(lane, tau), hits = lane.hits;
    const active = (i >= 0 && tau - hits[i].t < 1) || (hits[i + 1] && hits[i + 1].t - tau < 1.5);
    if (!active && lane.k !== 0) continue;
    if (!active && x0 <= x1) continue;
    x0 = Math.min(x0, m.x); x1 = Math.max(x1, m.x); y0 = Math.min(y0, m.y); y1 = Math.max(y1, m.y);
  }
  if (x0 > x1) { const m = marbleAt(plan.lanes[0], tau); x0 = x1 = m.x; y0 = y1 = m.y; }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, h: Math.max(2.5, y1 - y0 + 1.5, (x1 - x0 + 1.8) / aspect) };
}

/** When the first marble leaves the start seam frame, and when it enters the end one. */
function seamTimes(plan) {
  if (plan._seamTimes) return plan._seamTimes;
  const L0 = plan.lanes[0], { boxTop, boxBottom } = plan.seam;
  const inside = (b, m) => m.x > b.x0 && m.x < b.x1 && m.y > b.y0 && m.y < b.y1;
  let tOut = 0, tIn = plan.D;
  for (let t = 0; t < plan.D; t += 0.02) if (inside(boxTop, marbleAt(L0, t))) tOut = t; else if (t > 0.2) break;
  for (let t = plan.D; t > 0; t -= 0.02) if (inside(boxBottom, marbleAt(L0, t))) tIn = t; else if (t < plan.D - 0.2) break;
  return (plan._seamTimes = { tOut, tIn });
}

/**
 * Camera framing at loop time tau: { x, y } to look at and h = the height of wall in view.
 * Follows the playing marbles (smoothed over a short window), and blends into the fixed seam
 * framing at the very start and end of the loop.
 */
export function cameraPose(plan, tau, aspect) {
  const n = 17, win = 1.6;
  let x = 0, y = 0, h = 0;
  for (let j = 0; j < n; j++) {
    const t = Math.min(plan.D, Math.max(0, tau + (j / (n - 1) - 0.5) * win));
    const f = followAt(plan, t, aspect);
    x += f.x / n; y += f.y / n; h += f.h / n;
  }
  const { tOut, tIn } = seamTimes(plan);
  const blend = (p, s, w) => ({ x: p.x + (s.x - p.x) * w, y: p.y + (s.y - p.y) * w, h: p.h + (s.h - p.h) * w });
  let pose = { x, y, h };
  pose = blend(pose, seamPose(plan, 'top', aspect), 1 - smooth(tOut, tOut + 1.6, tau));
  pose = blend(pose, seamPose(plan, 'bottom', aspect), smooth(tIn - 1.6, tIn, tau));
  return pose;
}

/** Where the camera sits for a framing: a little above and to the side, so pads read as slabs. */
export function cameraPlacement(pose) {
  const dist = pose.h / 2 / TAN;
  return { position: { x: pose.x + (0.25 * dist) / 5, y: pose.y + (0.7 * dist) / 5, z: dist }, lookAt: { x: pose.x, y: pose.y - 0.05, z: 0.3 } };
}
