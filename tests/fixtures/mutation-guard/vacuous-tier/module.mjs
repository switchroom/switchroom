// Fixture: the #4663 shape, reduced.
//
// Tiered victim selection. Tier 2 (the staleness bound) and tier 3 (oldest
// wins) choose the SAME index whenever the queue is in ts-ascending order —
// which is normal insertion order — so an in-order fixture cannot tell them
// apart. Neutralising tier 2 is therefore invisible to a suite that only ever
// builds in-order queues. That is exactly what happened in
// `selectEvictionVictim` (git show 2338c280).
export const PROTECT_MS = 15 * 60 * 1000;

export function selectVictim(queue, nowMs) {
  for (let i = 0; i < queue.length; i++) {
    if (!queue[i].outcome) return { index: i, reason: "non-outcome" };
  }
  for (let i = 0; i < queue.length; i++) {
    if (nowMs - queue[i].ts >= PROTECT_MS) {
      return { index: i, reason: "stale-outcome" };
    }
  }
  return { index: 0, reason: "all-outcomes" };
}
