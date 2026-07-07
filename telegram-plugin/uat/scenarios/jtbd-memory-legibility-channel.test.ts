/**
 * Sparse chat-legible memory in a SUPERGROUP (#2849, hindsight Phase 4) — UAT.
 *
 * Channel twin of `jtbd-memory-legibility-dm`. A directive stored while the
 * conversation is happening in a supergroup must surface its `📌 remembered:`
 * line IN the supergroup — never the operator DM (the known status-routing
 * bug class). Proves the memory-legibility status surface has DM/channel
 * parity: it routes on the ORIGINATING topic (`turn.sessionChatId` /
 * `sessionThreadId`), not the owner DM.
 *
 * Self-skips green when no test supergroup is wired (SWITCHROOM_UAT_CHAT_ID
 * unset or not resolvable). Uses the General topic (mtcute here has no
 * forum-topic create API).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage } from "../assertions.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

const REMEMBER_PROMPT =
  `Persist this as a standing directive using the ` +
  `mcp__hindsight__create_directive tool, with the directive content set ` +
  `to exactly: "Always greet me as Captain at the start of a reply". ` +
  `Name the directive "greeting-captain". After creating it, send a brief ` +
  `one-line confirmation.`;

const REMEMBERED_RE = /📌\s*remembered/i;

describe("uat: sparse chat-legible memory in a supergroup (#2849 channel parity)", () => {
  it(
    "surfaces the 📌 remembered line IN the supergroup, not the DM",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[memory-legibility channel UAT] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(`[memory-legibility channel UAT] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
          return;
        }
        await sc.driver.sendText(SUPERGROUP_ID, REMEMBER_PROMPT);

        const line = await expectMessage(sc.driver, SUPERGROUP_ID, REMEMBERED_RE, {
          timeout: 90_000,
          senderFilter: { notUserId: sc.driverUserId },
        });
        console.log(
          `[memory-legibility channel UAT] remembered line (id=${line.messageId}, chat=${line.chatId}): ${JSON.stringify(line.text)}`,
        );
        expect(line.chatId).toBe(SUPERGROUP_ID); // parity proof: in the channel, not the DM
        expect(line.fromBot).toBe(true);
        expect(line.messageId).toBeGreaterThan(0);
        expect(line.text).toMatch(/Captain/i);
      } finally {
        await sc.tearDown();
      }
    },
    180_000,
  );
});
