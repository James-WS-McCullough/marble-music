// The follow camera: a pure function of loop time that makes the loop seamless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCourse } from '../src/planner.js';
import { cameraPose, cameraPlacement, seamPose } from '../src/camera.js';
import { buildSong, generateSong, groupNotes, splitParts } from '../src/music.js';

const plans = [
  [buildSong('ode'), 'harmony'], [generateSong(42), 'percussion'], [buildSong('elise'), 'none'],
].map(([song, second]) => {
  const split = splitParts(song.notes, { second });
  return { name: `${song.name} [${second}]`, plan: planCourse(split.parts.map((p) => ({ ...p, groups: groupNotes(p.notes).groups })), { seed: 7 }) };
});
const ASPECTS = [16 / 9, 16 / 10, 4 / 3, 9 / 16];

for (const { name, plan } of plans) {
  test(`${name}: the first and last frames are the same shot`, () => {
    const { top, bottom } = plan.seam;
    for (const aspect of ASPECTS) {
      const a = cameraPose(plan, 0, aspect), b = cameraPose(plan, plan.D, aspect);
      assert.ok(Math.abs((a.x - top.x) - (b.x - bottom.x)) < 1e-9, 'same x offset from the stub');
      assert.ok(Math.abs((a.y - top.y) - (b.y - bottom.y)) < 1e-9, 'same y offset from the stub');
      assert.ok(Math.abs(a.h - b.h) < 1e-9, 'same zoom');
      const pa = cameraPlacement(a), pb = cameraPlacement(b);
      assert.ok(Math.abs((pa.position.x - top.x) - (pb.position.x - bottom.x)) < 1e-9 && Math.abs(pa.position.z - pb.position.z) < 1e-9);
    }
  });

  test(`${name}: the seam shot stays inside the sign behind the stub`, () => {
    for (const aspect of ASPECTS) {
      const s = seamPose(plan, 'top', aspect);
      assert.ok(s.h <= plan.seam.plate.h - 0.5 && s.h * aspect <= plan.seam.plate.w - 0.5, `aspect ${aspect.toFixed(2)}`);
    }
  });

  test(`${name}: the camera moves smoothly (no jumps between frames)`, () => {
    const aspect = 16 / 9, dt = 1 / 60;
    let prev = cameraPose(plan, 0, aspect), worst = 0;
    for (let t = dt; t <= plan.D; t += dt) {
      const p = cameraPose(plan, t, aspect);
      worst = Math.max(worst, Math.hypot(p.x - prev.x, p.y - prev.y), Math.abs(p.h - prev.h));
      prev = p;
    }
    assert.ok(worst < 0.12, `largest step per frame ${worst.toFixed(3)} m`);
  });
}
