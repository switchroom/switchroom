/**
 * Narrated mid-turn work still shows words on the card — CHANNEL twin of
 * `jtbd-liveness-narration-dm.test.ts` (Phase 4a, `deterministic-turn-liveness.md`).
 *
 * Surface parity bar per the job spec. Self-skips green when no test
 * supergroup is wired.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage, isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);
const OVERALL_BUDGET_MS = 140_000;

const NARRATED_WORK_PROMPT =
  "Do four short steps, ONE AT A TIME. Before EACH step, write a brief " +
  'one-sentence narration of what you are about to do (e.g. "Checking the ' +
  'hostname now.") — this is not a reply, just your normal narration — then ' +
  "run the step via Bash (`sleep 3` is fine as the step body). After all " +
  "four steps, send a one-line final summary reply.";

describe("uat: deterministic turn liveness — narration lands mid-turn (channel parity)", () => {
  it(
    "the model's own words appear on the activity card mid-turn, in a supergroup",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[liveness-narration-channel] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(`[liveness-narration-channel] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
          return;
        }

        await sc.driver.sendText(SUPERGROUP_ID, NARRATED_WORK_PROMPT);
        const sentAt = Date.now();

        const card = await expectMessage(
          sc.driver,
          SUPERGROUP_ID,
          (m: ObservedMessage) => isActivityFeedMessage(m) && !/^Working(\s*[·…]|$)/i.test(m.text.trim()),
          { timeout: 60_000, senderFilter: { notUserId: sc.driverUserId } },
        );
        console.log(
          `[liveness-narration-channel] narrated card content at +${Date.now() - sentAt}ms (id=${card.messageId}): ` +
            JSON.stringify(card.text.slice(0, 140)),
        );
        expect(card.chatId).toBe(SUPERGROUP_ID);

        const answer = await expectMessage(
          sc.driver,
          SUPERGROUP_ID,
          /\S/,
          { timeout: 60_000, senderFilter: { notUserId: sc.driverUserId } },
        );
        expect(answer.chatId).toBe(SUPERGROUP_ID);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
