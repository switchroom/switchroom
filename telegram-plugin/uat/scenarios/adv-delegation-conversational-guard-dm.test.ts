/**
 * ADVERSARIAL — over-delegation guard (attacks the OTHER failure mode of fix
 * #3232 / commit 2be70156).
 *
 * The delegation fix must not tip the agent into spawning a worker for a purely
 * CONVERSATIONAL turn — that would be over-delegation (the fix explicitly warns
 * "unnecessary delegation costs a few tokens" but a trivia answer needs zero
 * tools). This probe sends a plain, single-fact conversational question and
 * asserts:
 *   - a normal answer lands, and
 *   - NO worker feed (`🛠 Worker`) is spawned for it.
 *
 * Unlike the "delegation happened" direction (a model judgment), this guard is
 * a genuinely HARD, low-flake oracle: a well-behaved agent must NOT dispatch a
 * sub-agent to answer "what's the capital of Australia". A worker feed here is a
 * clear over-delegation regression.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { collectTurn } from "../real-work-prompts.js";

// A purely conversational, zero-tool question. No file, no build, no research.
const CONVERSATIONAL_PROMPT =
  `Quick question, no need to look anything up: what's the capital city of ` +
  `Australia, and is it the largest city in the country? One or two sentences ` +
  `is plenty.`;

describe("uat-adv: over-delegation guard on a conversational turn (attacks #3232)", () => {
  it(
    "answers a trivia question inline without dispatching any worker/sub-agent",
    async () => {
      const sc = await spinUp({ agent: "test-harness", quiesceBeforeStart: true });
      try {
        const obs = await collectTurn(
          sc.driver,
          sc.botUserId,
          sc.driverUserId,
          CONVERSATIONAL_PROMPT,
          // Short settle: a conversational answer is prompt; a spurious worker
          // would still surface within the collection window.
          { timeoutMs: 90_000, minAnswerChars: 10, settleMs: 20_000 },
        );
        console.log(
          `[adv-overdeleg] answer=${obs.answer != null} sawWorkerFeed=${obs.sawWorkerFeed} sawActivityFeed=${obs.sawActivityFeed}`,
        );
        if (obs.answer != null) {
          console.log(`[adv-overdeleg] answer: ${JSON.stringify(obs.answer.text.slice(0, 160))}`);
        }

        expect(obs.answer, "conversational turn produced no answer").not.toBeNull();
        // HARD guard: a trivia turn must not spawn a worker/sub-agent.
        expect(
          obs.sawWorkerFeed,
          "a worker/sub-agent was dispatched for a purely conversational trivia turn (over-delegation regression)",
        ).toBe(false);
      } finally {
        await sc.tearDown();
      }
    },
    180_000,
  );
});
</content>
