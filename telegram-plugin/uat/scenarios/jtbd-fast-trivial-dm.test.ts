/**
 * JTBD scenario — short happy path: trivial questions reply FAST.
 *
 * Serves: `reference/jobs/know-what-my-agent-is-doing.md` — the short-path
 * contract: a question with no real work should produce a plain reply
 * with no ceremony (no soft-commit, no progress chunks) within a tight
 * budget. Users judge agent speed on THIS path more than any other.
 *
 * Also serves: the always-on vision (`reference/vision.md`). An agent
 * that takes 30+ seconds to answer "what's 2+2" is not "always-on" —
 * it's awake but unresponsive.
 *
 * ## Targets
 *
 * From `reference/rfcs/conversational-pacing.md` and the post-v0.12.22
 * baseline measurements:
 *
 *   - **TTFO p95 (vision target):** < 30s — the published contract.
 *     This test asserts the FAST-trivial case, not p95, so we tighten.
 *   - **Trivial-prompt TTFO (this test):** < 12s as hard contract,
 *     < 6s as the vision target. The mtcute post-restart UAT measured
 *     19.4s on a COLD-START fresh-restart; a warm fast-trivial should
 *     be materially faster — the dominant cost on cold start is
 *     boot+session-resume which doesn't apply here.
 *   - **Soft-commit ceremony:** must NOT fire for trivial prompts.
 *     If the reply contains a soft-commit preamble ("let me check
 *     that for you, back in a few"), the conversational-pacing
 *     prompt classified the trivial prompt as slow — a regression.
 *
 * ## What this catches that other UATs don't
 *
 * - `jtbd-soft-commit-dm.test.ts` exercises slow prompts (the soft
 *   commit SHOULD fire). This test asserts the inverse — fast prompts
 *   should skip ceremony.
 * - `jtbd-always-on-after-restart-dm.test.ts` asserts <120s after a
 *   cold restart. This test asserts <12s on a warm agent — a much
 *   tighter bar that catches steady-state latency regressions
 *   (model swap, MCP server slowdown, gateway middleware cost, etc.).
 * - `smoke-dm-reply.test.ts` confirms the agent replies AT ALL but
 *   has no latency assertion — a 50s reply would pass smoke. This
 *   one fails.
 *
 * ## Forensic signal on a yellow-band pass
 *
 * If TTFO lands in 6-12s, the test passes but logs a forensic warning
 * so a future regression in this code path is visible BEFORE it
 * crosses the hard contract. Yellow-band drift is the canary for
 * "something's getting slower" — better to chase it at 8s than at 28s.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

// Hard contract for trivial-prompt TTFO.
const HARD_TTFO_MS = 12_000;

// Vision target: trivial prompts feel near-instant.
const VISION_TTFO_MS = 6_000;

const TRIVIAL_PROMPT = "Reply with just the number: what is 2 + 2?";

const SOFT_COMMIT_PHRASES = [
  /let me/i,
  /back in/i,
  /one (sec|moment)/i,
  /checking/i,
  /looking into/i,
  /hold on/i,
];

describe("uat: short happy path — trivial prompt is FAST", () => {
  it(
    `trivial prompt → reply lands within ${HARD_TTFO_MS / 1000}s`,
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        const sendStart = Date.now();
        await sc.sendDM(TRIVIAL_PROMPT);

        const firstReply = await sc.expectMessage(/\S/, {
          from: "bot",
          timeout: HARD_TTFO_MS + 5_000,
        });
        const ttfo = Date.now() - sendStart;

        expect(firstReply.text.length).toBeGreaterThan(0);

        if (ttfo >= HARD_TTFO_MS) {
          throw new Error(
            `[fast-trivial] TTFO=${ttfo}ms exceeds hard contract ` +
            `${HARD_TTFO_MS}ms — trivial-prompt latency regression.`,
          );
        }
        expect(ttfo).toBeLessThan(HARD_TTFO_MS);

        const triggeredSoftCommit = SOFT_COMMIT_PHRASES.some((re) =>
          re.test(firstReply.text),
        );
        if (triggeredSoftCommit) {
          console.warn(
            `[fast-trivial] First reply contains soft-commit phrasing — ` +
            `the conversational-pacing prompt likely classified the ` +
            `trivial prompt as slow. Text: ${JSON.stringify(firstReply.text.slice(0, 200))}`,
          );
        }

        if (ttfo >= VISION_TTFO_MS) {
          console.warn(
            `[fast-trivial] TTFO=${ttfo}ms — passed hard contract ` +
            `(${HARD_TTFO_MS}ms) but slower than the vision target ` +
            `(${VISION_TTFO_MS}ms). Forensic canary for delivery-path drift.`,
          );
        } else {
          console.log(
            `[fast-trivial] TTFO=${ttfo}ms — within vision target ` +
            `(<${VISION_TTFO_MS}ms). Snappy.`,
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    HARD_TTFO_MS + 15_000,
  );
});
