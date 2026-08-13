// The post-follow-up suite: adds the OUT-OF-ORDER case (fresh head, stale
// tail) that is the only shape where tier 2 and tier 3 disagree. This is the
// assertion 2338c280 added.
import assert from "node:assert/strict";
import { selectVictim } from "./module.mjs";

const now = 100 * 60 * 1000;
const out = (ts) => ({ outcome: true, ts });
const msg = (ts) => ({ outcome: false, ts });

assert.deepEqual(selectVictim([out(now), msg(now)], now), {
  index: 1,
  reason: "non-outcome",
});
// Out of order: head FRESH, tail STALE. Tier 2 picks 1, tier 3 picks 0.
assert.deepEqual(selectVictim([out(now), out(now - 20 * 60 * 1000)], now), {
  index: 1,
  reason: "stale-outcome",
});
assert.deepEqual(selectVictim([out(now), out(now)], now), {
  index: 0,
  reason: "all-outcomes",
});
