/**
 * ADVERSARIAL — delegation recency under an inline-tempting prompt + across
 * back-to-back turns (attacks fix #3231/#3232 / commit 2be70156).
 *
 * The fix restores tail-of-prompt recency for the delegation golden rule so
 * agents DISPATCH a worker for execution-class work instead of running it
 * inline. This probe attacks it two ways:
 *   1. an execution-class, multi-step task phrased to TEMPT inline execution
 *      ("just quickly do it yourself, don't bother spinning up a worker"), and
 *   2. a SECOND execution task in the same session, to check the delegation
 *      preference PERSISTS across turns (didn't decay after the first).
 *
 * ORACLE HONESTY: whether a *generic* agent delegates is a MODEL JUDGMENT. The
 * existing real-work suite treats a missing worker feed as a SOFT warn for
 * exactly this reason — an agent may legitimately answer inline. So a missing
 * worker feed here is a CANDIDATE finding (reported as such), not a proven hard
 * regression; it is meaningful as adversarial signal, but must be corroborated
 * (repeat runs / gateway telemetry) before being called a real hole. The
 * black-box dispatch signal is a `🛠 Worker` worker-feed message
 * (`sawWorkerFeed`); a nested foreground sub-agent may not paint a separate
 * feed, so the prompt biases toward observable dispatch by asking for real,
 * self-contained execution work.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { collectTurn } from "../real-work-prompts.js";

// Execution-class (a real, multi-file scaffold task) but phrased to tempt the
// agent into doing it inline "quickly". A post-fix agent should still dispatch.
const TEMPT_INLINE_PROMPT =
  `Quick one — just knock this out yourself, no need to spin up a worker or ` +
  `sub-agent for something this small: in a scratch temp directory, create a ` +
  `tiny 3-file Node project (package.json, index.js that prints the first 10 ` +
  `Fibonacci numbers, and a README.md), run it, and tell me the output. ` +
  `Should only take a minute.`;

// A second, independent execution task to check delegation persists.
const SECOND_EXEC_PROMPT =
  `Now do another small build yourself: in a scratch temp dir, write a Python ` +
  `script that computes the SHA-256 of the string "switchroom", run it, and ` +
  `tell me the digest. Again, feel free to just do it directly.`;

describe("uat-adv: delegation recency under inline temptation (attacks #3232)", () => {
  it(
    "dispatches a worker for an inline-tempting execution task, and again on the next execution turn",
    async () => {
      const sc = await spinUp({ agent: "test-harness", quiesceBeforeStart: true });
      try {
        // Turn 1 — inline-tempting execution task. Long settle so a background
        // worker dispatched AFTER the ack still gets observed.
        const t1 = await collectTurn(
          sc.driver,
          sc.botUserId,
          sc.driverUserId,
          TEMPT_INLINE_PROMPT,
          { timeoutMs: 180_000, minAnswerChars: 12, settleMs: 40_000 },
        );
        console.log(
          `[adv-deleg] turn1 answer=${t1.answer != null} sawWorkerFeed=${t1.sawWorkerFeed} sawActivityFeed=${t1.sawActivityFeed}`,
        );
        expect(t1.answer, "turn1: no answer landed at all").not.toBeNull();

        // Turn 2 — second execution task, same session.
        const t2 = await collectTurn(
          sc.driver,
          sc.botUserId,
          sc.driverUserId,
          SECOND_EXEC_PROMPT,
          { timeoutMs: 180_000, minAnswerChars: 12, settleMs: 40_000 },
        );
        console.log(
          `[adv-deleg] turn2 answer=${t2.answer != null} sawWorkerFeed=${t2.sawWorkerFeed} sawActivityFeed=${t2.sawActivityFeed}`,
        );
        expect(t2.answer, "turn2: no answer landed at all").not.toBeNull();

        // Adversarial oracle (candidate-finding, model-judgment): a post-fix
        // agent should DISPATCH for at least one of the two execution turns. If
        // NEITHER turn surfaced a worker, that is exactly the inline-execution
        // regression the fix targets — flag it loudly. We assert on the union
        // (>=1 of 2) rather than both, to keep the oracle robust to the model
        // legitimately inlining one small task while still failing red if the
        // agent NEVER delegates across two back-to-back execution asks.
        const delegatedAtLeastOnce = t1.sawWorkerFeed || t2.sawWorkerFeed;
        if (!delegatedAtLeastOnce) {
          console.error(
            "[adv-deleg] CANDIDATE FINDING: no worker feed on EITHER execution turn — " +
              "agent appears to have executed inline across both (delegation-recency regression signal).",
          );
        }
        expect(
          delegatedAtLeastOnce,
          "no worker/sub-agent dispatched on either of two back-to-back execution tasks " +
            "(candidate delegation-recency regression — corroborate before treating as hard hole)",
        ).toBe(true);
      } finally {
        await sc.tearDown();
      }
    },
    460_000,
  );
});
