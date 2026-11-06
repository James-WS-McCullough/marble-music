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
  return { x: c.x, y: c.y, h: Math.min(1.5, h - 1.0, (w - 0.7) / aspect) };
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

/** The first marble's first and last hits (between them, the camera follows the music). */
function seamTimes(plan) {
  if (plan._seamTimes) return plan._seamTimes;
  const hits = plan.lanes[0].hits;
  return (plan._seamTimes = { first: hits[0].t, last: hits[hits.length - 1].t });
}

/**
 * Camera framing at loop time tau: { x, y } to look at and h = the height of wall in view.
 * Follows the playing marbles (smoothed over a short window). Around the loop seam it tracks the
 * first marble itself - out of the start stub, and into the end stub - zoomed in like the seam
 * shot. At t = 0 and t = D that marble sits hidden in its stub, so both ends are exactly the
 * seam shot (the loop is seamless) without ever holding a static frame. `zoom` (> 1 = closer)
 * changes the follow framing only: the seam shot stays as it is, filling the seam sign.
 */
export function cameraPose(plan, tau, aspect, { zoom = 1 } = {}) {
  const n = 17, win = 1.6;
  let x = 0, y = 0, h = 0;
  for (let j = 0; j < n; j++) {
    const t = Math.min(plan.D, Math.max(0, tau + (j / (n - 1) - 0.5) * win));
    const f = followAt(plan, t, aspect);
    x += f.x / n; y += f.y / n; h += f.h / n / zoom;
  }
  const { first, last } = seamTimes(plan);
  const blend = (p, s, w) => ({ x: p.x + (s.x - p.x) * w, y: p.y + (s.y - p.y) * w, h: p.h + (s.h - p.h) * w });
  // the first marble's position, smoothed (so its little settling hops as it lands on a rail don't
  // shake the camera) - except right at the loop's ends, where it must be exact for the seam shot
  const hw = 0.4 * Math.min(1, Math.max(0, Math.min(tau, plan.D - tau) / 0.6));
  let mx = 0, my = 0;
  for (let j = 0; j < 9; j++) {
    const m = marbleAt(plan.lanes[0], Math.min(plan.D, Math.max(0, tau + (j / 8 - 0.5) * 2 * hw)));
    mx += m.x / 9; my += m.y / 9;
  }
  const seamH = seamPose(plan, 'top', aspect).h;
  const track = { x: mx, y: my, h: seamH };
  let pose = { x, y, h };
  pose = blend(pose, track, 1 - smooth(first - 0.9, first + 0.5, tau));
  pose = blend(pose, track, smooth(last - 0.2, last + 0.9, tau));
  return pose;
}

/** Where the camera sits for a framing: a little above and to the side, so pads read as slabs. */
export function cameraPlacement(pose) {
  const dist = pose.h / 2 / TAN;
  return { position: { x: pose.x + (0.25 * dist) / 5, y: pose.y + (0.7 * dist) / 5, z: dist }, lookAt: { x: pose.x, y: pose.y - 0.05, z: 0.3 } };
}
