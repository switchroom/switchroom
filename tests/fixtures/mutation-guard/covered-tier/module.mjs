// Same production logic as ../vacuous-tier/module.mjs — the only difference is
// the suite next to it. Proves the guard reports on the TESTS, not on a code
// shape: identical source, opposite verdict.
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
