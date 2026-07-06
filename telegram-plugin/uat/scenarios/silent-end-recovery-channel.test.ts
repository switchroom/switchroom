/**
 * Silent-end recovery — CHANNEL twin of `silent-end-recovery-dm.test.ts`
 * (Phase 4a, `deterministic-turn-liveness.md`: the dark-turn guard must
 * deliver exactly one fallback message on the real surface, in a DM AND a
 * forum topic alike).
 *
 * Phase 2 (already shipped) hardens `recordUndeliveredTurnEnd` /
 * `SILENT_END_FALLBACK_TEXT` as the ONE deterministic guard for a turn that
 * ends having delivered no reply. This scenario proves it fires — at most
 * once — for the same tool-heavy prompt shape, in a supergroup.
 *
 * Self-skips green when no test supergroup is wired.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

const TOOL_HEAVY_PROMPT =
  "Pick a directory under /tmp that doesn't exist yet. Create it. " +
  "List its contents (should be empty). Write a small file in it. " +
  "List again. Then report what you did in a one-line reply.";

describe("uat: silent-end recovery (channel parity)", () => {
  it(
    "user asks in a supergroup → agent always replies exactly once via the fallback ladder if needed",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[silent-end-recovery-channel] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(`[silent-end-recovery-channel] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
          return;
        }

        await sc.driver.sendText(SUPERGROUP_ID, TOOL_HEAVY_PROMPT);

        // Same budget rationale as the DM twin: covers normal latency, one
        // Stop-hook re-prompt cycle, and the worst-case 300s framework
        // fallback.
        const reply = await expectMessage(
          sc.driver,
          SUPERGROUP_ID,
          /\S/,
          { timeout: 320_000, senderFilter: { notUserId: sc.driverUserId } },
        );
        expect(reply.text.length).toBeGreaterThan(0);
        expect(reply.chatId).toBe(SUPERGROUP_ID);

        if (/no update from agent|didn't send a reply/i.test(reply.text)) {
          console.warn(
            "[silent-end-recovery-channel] reply was the framework/dark-turn fallback — " +
              `model never replied on its own. Reply text: ${JSON.stringify(reply.text.slice(0, 200))}`,
          );

          // Exactly-once proof: no SECOND fallback-shaped message should
          // follow within a short window (the `exhausted` latch).
          let secondFallback: ObservedMessage | null = null;
          try {
            secondFallback = await expectMessage(
              sc.driver,
              SUPERGROUP_ID,
              /no update from agent|didn't send a reply/i,
              { timeout: 15_000, senderFilter: { notUserId: sc.driverUserId } },
            );
          } catch {
            // Timeout is the expected/good outcome — no second fallback fired.
          }
          expect(
            secondFallback,
            "the dark-turn/framework fallback fired MORE than once for the same turn " +
              "(the `exhausted` latch should give fire-once)",
          ).toBeNull();
        }
      } finally {
        await sc.tearDown();
      }
    },
    360_000,
  );
});
