// Small shared helpers: seeded RNG and plain-object vector math (no three.js dependency,
// so the planner can run in Node for testing / offline export).

export function mulberry32(seed) {
  // scramble the seed so nearby seeds (1, 2, 3...) give unrelated sequences
  let a = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35) >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a, s) => V(a.x * s, a.y * s, a.z * s);
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const norm = (a) => {
  const l = len(a) || 1;
  return mul(a, 1 / l);
};
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
