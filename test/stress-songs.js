// Synthetic songs shaped like awkward real MIDI files: long rests in one part, dense runs in
// the other, late entries. Used by the planner test to check the two marbles stay together.
import { mulberry32 } from '../src/util.js';

function line(out, { t0, t1, step, ch = 0, base = 72, spread = 7, dur = step * 0.9, vel = 0.8, rng }) {
  for (let t = t0; t < t1 - 1e-9; t += step) out.push({ t, dur, midi: base + Math.floor(rng() * spread), vel, ch });
}
const drumBar = (out, t0, t1, beat) => {
  for (let t = t0, i = 0; t < t1 - 1e-9; t += beat / 2, i++)
    out.push({ t, dur: 0.1, midi: i % 4 === 0 ? 36 : i % 4 === 2 ? 38 : 42, vel: 0.8, ch: 9 });
};

export function stressSongs() {
  const rng = mulberry32(99);
  const songs = [];
  { // melody with a long rest in the middle, then fast 16ths; bass with a 10 s hole
    const n = [];
    line(n, { t0: 0, t1: 8, step: 0.25, rng });
    line(n, { t0: 14, t1: 22, step: 0.125, rng });
    line(n, { t0: 0, t1: 6, step: 1, ch: 1, base: 40, spread: 5, dur: 0.9, rng });
    line(n, { t0: 16, t1: 22, step: 1, ch: 1, base: 40, spread: 5, dur: 0.9, rng });
    songs.push({ name: 'Stress: rests + runs', notes: n });
  }
  { // bass only enters late, melody busy throughout
    const n = [];
    line(n, { t0: 0, t1: 24, step: 0.2, rng });
    line(n, { t0: 15, t1: 24, step: 0.5, ch: 1, base: 38, spread: 6, rng });
    songs.push({ name: 'Stress: late bass', notes: n });
  }
  { // very fast melody (140 bpm 16ths) against a sparse bass
    const n = [];
    line(n, { t0: 0, t1: 18, step: 0.107, rng });
    line(n, { t0: 0, t1: 18, step: 2, ch: 1, base: 40, spread: 5, dur: 1.8, rng });
    songs.push({ name: 'Stress: fast vs sparse', notes: n });
  }
  { // drum break: melody rests 8 s while the drums keep going
    const n = [];
    line(n, { t0: 0, t1: 8, step: 0.5, rng });
    line(n, { t0: 16, t1: 24, step: 0.25, rng });
    drumBar(n, 0, 24, 0.5);
    songs.push({ name: 'Stress: drum break', notes: n });
  }
  { // both parts alternate: call and response with 4 s gaps each
    const n = [];
    for (let k = 0; k < 4; k++) {
      line(n, { t0: k * 8, t1: k * 8 + 4, step: 0.25, rng });
      line(n, { t0: k * 8 + 4, t1: k * 8 + 8, step: 0.25, ch: 1, base: 45, spread: 7, rng });
    }
    songs.push({ name: 'Stress: call & response', notes: n });
  }
  return songs;
}
