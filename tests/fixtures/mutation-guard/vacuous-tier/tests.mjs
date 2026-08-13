// The pre-#4663-follow-up suite: every queue is in ts-ascending order, so no
// case can distinguish tier 2 from tier 3. Passes on the original AND on a
// tier-2-neutralised mutant.
import assert from "node:assert/strict";
import { selectVictim } from "./module.mjs";

const now = 100 * 60 * 1000;
const out = (ts) => ({ outcome: true, ts });
const msg = (ts) => ({ outcome: false, ts });

assert.deepEqual(selectVictim([out(now), msg(now)], now), {
  index: 1,
  reason: "non-outcome",
});
// In-order: oldest is also stalest. Tier 2 and tier 3 agree on the index.
assert.equal(selectVictim([out(now - 20 * 60 * 1000), out(now)], now).index, 0);
assert.equal(selectVictim([out(now), out(now)], now).index, 0);
