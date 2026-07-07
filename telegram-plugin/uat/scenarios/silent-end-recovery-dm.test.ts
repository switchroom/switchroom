/**
 * Silent-end recovery scenario — the regression PR3 (#1126) introduced
 * and PR1129 fixed.
 *
 * The bug: PR3 deleted the progress-card driver, and with it the
 * `onSilentEnd` callback that wrote
 * $TELEGRAM_STATE_DIR/silent-end-pending.json. The Stop hook
 * (`silent-end-interrupt-stop.mjs`) reads that file to decide whether
 * to block-and-re-prompt. With the writer gone, the hook always read
 * "no silent-end pending" and allowed the stop. The model would
 * produce an answer in its CLI session but never call `reply`, and
 * the user got nothing back.
 *
 * This UAT exercises the outcome side directly: send a DM that
 * SHOULD produce a reply, assert that a reply lands within a budget
 * that covers (a) normal turn latency, (b) one Stop-hook re-prompt
 * cycle (the agent goes silent → hook blocks → re-prompted → calls
 * reply), and (c) worst-case framework fallback at 5 min.
 *
 * Why this scenario specifically:
 * - The bug surfaced as "user gets no reply at all." The most
 *   defensible UAT assertion is "after asking, the user gets SOME
 *   reply within a reasonable bound." Anything that breaks this
 *   contract — silent-end gap, scaffold staleness, hook misconfig,
 *   gateway crash — fails this test.
 * - Unlike `smoke-dm-reply.test.ts` (trivial inbound, fast reply),
 *   this scenario uses a tool-heavy prompt that pushes the model
 *   into the silent-end zone (lots of tool churn, easy to forget to
 *   call reply afterward). It's the actual JTBD-failure shape.
 *
 * Budget: 6 min outer, 5 min for the reply itself. Covers the
 * 5-min framework fallback floor.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";

// The prompt pushes the model into a tool-heavy state where it has
// produced "an answer" internally but hasn't yet realised it must
// surface that via `reply`. This is the shape of the gymbro
// regression: the model did the work (cat, pip install, garmin-pull,
// etc), produced a summary, then ended the turn without `reply`.
const TOOL_HEAVY_PROMPT = (
  "Pick a directory under /tmp that doesn't exist yet. Create it. "
  + "List its contents (should be empty). Write a small file in it. "
  + "List again. Then report what you did in a one-line reply."
);

describe("uat: silent-end recovery", () => {
  it(
    "user asks → agent always replies (the gymbro regression must not return)",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const { messageId: inboundId } = await sc.sendDM(TOOL_HEAVY_PROMPT);
        expect(inboundId).toBeGreaterThan(0);

        // The core assertion: SOMETHING comes back from the bot
        // within 5min. That covers the worst case of the
        // silent-end-recovery ladder:
        //   t=0:    inbound
        //   t<30s:  normal reply if all is well
        //   t=75s:  silence-poke #1 fires (model re-prompted)
        //   t=180s: silence-poke #2 fires
        //   t=300s: framework fallback ("still working… (no update
        //           from agent in 5 min)") fires from the gateway.
        // If we still get nothing by 300s+slack the bug is back.
        const reply = await sc.expectMessage(/\S/, {
          from: "bot",
          timeout: 320_000,
        });

        expect(reply.text.length).toBeGreaterThan(0);
        expect(reply.senderUserId).toBe(sc.botUserId);

        // Subtler regression catch: if the reply is the framework
        // fallback wording ("still working… (no update from agent
        // in N min)") that means the silent-end loop fired AND the
        // model didn't recover. Acceptable outcome — the user got
        // something — but a design-health alarm. Log it AND assert the
        // `exhausted` latch gave fire-once (transport-side), matching the
        // channel twin exactly — the job-spec Prove-it claim is
        // "asserted transport-side in a DM AND a supergroup alike", so the
        // DM twin must make the same exactly-once assertion, not just warn.
        if (/no update from agent|didn't send a reply/i.test(reply.text)) {
          console.warn(
            `[silent-end-recovery] reply was the framework fallback — `
            + `model never replied on its own. Reply text: ${JSON.stringify(reply.text.slice(0, 200))}`,
          );

          // No SECOND fallback-shaped message should follow within a short
          // window (the `exhausted` latch gives fire-once).
          let secondFallback: ObservedMessage | null = null;
          try {
            secondFallback = await sc.expectMessage(
              /no update from agent|didn't send a reply/i,
              { from: "bot", timeout: 15_000 },
            );
          } catch {
            // Timeout is the expected/good outcome — no second fallback fired.
          }
          expect(
            secondFallback,
            "the dark-turn/framework fallback fired MORE than once for the same turn "
            + "(the `exhausted` latch should give fire-once)",
          ).toBeNull();
        }
      } finally {
        await sc.tearDown();
      }
    },
    // Outer budget = inner deadline (320s) + spinUp overhead
    // (~12s mtcute connect + DEFAULT_SETTLE_MS) + headroom.
    360_000,
  );
});
