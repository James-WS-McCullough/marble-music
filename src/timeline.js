// A sequence of songs on one clock, for endless play. Each item: { D, events, beat, fx, initial,
// start, reps }: it plays from `start`, repeating every D seconds, `reps` times (Infinity while
// it's the last one). Appending the next song ends the current one at a loop boundary that
// hasn't been scheduled yet, so the switch happens exactly at the seam.
//   events: [{ tau, ... }] - marble hits;  beat: [{ tau, ... }] - background beat notes;
//   fx: [{ tau, set }] - switch settings;   initial: the settings at tau = 0.

export function makeItem(song, start = 0) {
  return { ...song, start, reps: Infinity };
}

/** Append `next` after the last item, at the first loop boundary at or after `notBefore`. */
export function appendItem(items, next, notBefore) {
  const last = items[items.length - 1];
  const k = Math.max(1, Math.ceil((notBefore - last.start) / last.D - 1e-9));
  last.reps = k;
  next.start = last.start + k * last.D;
  next.reps = Infinity;
  items.push(next);
  return next;
}

/** The item playing at time t, and the time within it (tau). */
export function itemAt(items, t) {
  for (const it of items) {
    const end = it.start + it.reps * it.D;
    if (t < end || it === items[items.length - 1]) {
      const tau = Math.max(0, t - it.start) % it.D;
      return { item: it, tau };
    }
  }
  return null;
}

/** The switch settings in effect at tau (the initial state, then each switch in turn). */
export function settingsAt(item, tau) {
  const s = { ...(item.initial || {}) };
  for (const f of item.fx || []) if (f.tau <= tau) Object.assign(s, f.set);
  return s;
}

/**
 * Everything to schedule in [from, until): marble-hit events, background beat notes (only while
 * the beat is switched on) and switch changes, each with its absolute time `at`.
 */
export function collect(items, from, until) {
  const out = [];
  for (const it of items) {
    const end = it.start + it.reps * it.D;
    if (end <= from || it.start >= until) continue;
    const k0 = Math.max(0, Math.floor((from - it.start) / it.D));
    for (let k = k0; k < it.reps; k++) {
      const base = it.start + k * it.D;
      if (base >= until) break;
      const inWin = (tau) => base + tau >= from && base + tau < until;
      if (k === 0 || inWin(0)) if (base >= from && base < until) out.push({ at: base, kind: 'start', item: it });
      for (const e of it.events) if (inWin(e.tau)) out.push({ at: base + e.tau, kind: 'hit', event: e, item: it });
      for (const f of it.fx || []) if (inWin(f.tau)) out.push({ at: base + f.tau, kind: 'fx', set: f.set, item: it });
      for (const b of it.beat || []) if (inWin(b.tau) && settingsAt(it, b.tau).beat) out.push({ at: base + b.tau, kind: 'beat', note: b, item: it });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
