// Plans a course off the main thread, so the page stays responsive (and can show progress)
// while the beam search runs. The plan comes back as plain data (see toPlain / rehydratePlan).
import { planCourse, toPlain } from './planner.js';

self.onmessage = (e) => {
  const { id, parts, options } = e.data;
  try {
    const plan = planCourse(parts, { ...options, onProgress: (p) => self.postMessage({ id, progress: p }) });
    self.postMessage({ id, plan: toPlain(plan) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
