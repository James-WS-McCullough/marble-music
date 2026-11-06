// Plans a course off the main thread, so the page stays responsive (and can show progress)
// while the beam search runs. The plan comes back as plain data (see toPlain / rehydratePlan).
// (the planner is loaded with this worker's own version tag, so it matches the page's code)
const planner = import(`./planner.js${self.location.search}`);

self.onmessage = async (e) => {
  const { id, parts, options } = e.data;
  try {
    const { planCourse, toPlain } = await planner;
    const plan = planCourse(parts, { ...options, onProgress: (p) => self.postMessage({ id, progress: p }) });
    self.postMessage({ id, plan: toPlain(plan) });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
