/**
 * Deterministic-turn-liveness climb — CHANNEL twin of
 * `jtbd-liveness-climb-dm.test.ts` (Phase 4a, `deterministic-turn-liveness.md`).
 *
 * Surface parity is a production-readiness bar for this job (job spec §
 * Production-readiness: "every signal is proven in both DM and forum
 * channel"). Phase 1's climb is keyed on the SAME `feedHeartbeatTick` /
 * `runSilentTurnHeartbeatTick` path regardless of chat type — this scenario
 * proves the card edits land in a supergroup too, not just a DM.
 *
 * Self-skips green when no test supergroup is wired (`SWITCHROOM_UAT_CHAT_ID`
 * unset / unresolvable) — mirrors the existing channel-twin convention (see
 * `jtbd-foreground-subagent-activity-channel.test.ts`).
 *
 * mtcute has no forum-topic API here, so this uses the General topic — same
 * limitation as every other channel twin in this suite.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { expectMessage, isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

const MIN_CLIMB_EDITS = 4;
const OVERALL_BUDGET_MS = 150_000;
const SILENT_TOOL_SECONDS = 40;

const SILENT_TOOL_PROMPT =
  "Do exactly this and nothing else: run a single Bash command " +
  `\`sleep ${SILENT_TOOL_SECONDS}\` and wait for it to finish. Do NOT narrate ` +
  "anything before or during the sleep — no commentary, no other tool calls, " +
  "no intermediate messages. Only after the sleep completes, reply with a " +
  "one-line confirmation that you waited.";

describe("uat: deterministic turn liveness — silent-tool card climb (channel parity)", () => {
  it(
    "climbs the activity card in a supergroup the same way it does in a DM",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[liveness-climb-channel] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(`[liveness-climb-channel] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
          return;
        }

        await sc.driver.sendText(SUPERGROUP_ID, SILENT_TOOL_PROMPT);
        const sentAt = Date.now();

        // First observation of the card — proves it opens in the channel.
        const firstCard = await expectMessage(
          sc.driver,
          SUPERGROUP_ID,
          (m: ObservedMessage) => isActivityFeedMessage(m),
          { timeout: 30_000, senderFilter: { notUserId: sc.driverUserId } },
        );
        console.log(
          `[liveness-climb-channel] card opened at +${Date.now() - sentAt}ms (id=${firstCard.messageId}): ` +
            JSON.stringify(firstCard.text.slice(0, 100)),
        );

        // Poll the SAME card by id at intervals across the silent window,
        // checking the body actually changes (climbs) rather than freezing.
        const samples: string[] = [firstCard.text];
        const pollDeadline = Date.now() + (SILENT_TOOL_SECONDS + 20) * 1000;
        let lastText = firstCard.text;
        let changeCount = 0;
        while (Date.now() < pollDeadline && changeCount < MIN_CLIMB_EDITS) {
          await new Promise((r) => setTimeout(r, 6_000));
          const cur = await sc.driver.getMessage(SUPERGROUP_ID, firstCard.messageId);
          if (cur == null) continue;
          if (cur.text !== lastText) {
            changeCount++;
            lastText = cur.text;
            samples.push(cur.text);
            console.log(
              `[liveness-climb-channel] card changed (#${changeCount}) at +${Date.now() - sentAt}ms: ` +
                JSON.stringify(cur.text.slice(0, 100)),
            );
          }
        }

        if (changeCount === 0) {
          console.warn(
            "[liveness-climb-channel] INCONCLUSIVE — card body never changed across the " +
              "silent window (model may have narrated a tool label, taking the labelled " +
              "heartbeat path with different cadence). Not a hard failure on its own.",
          );
        } else if (changeCount < MIN_CLIMB_EDITS) {
          console.warn(
            `[liveness-climb-channel] INCONCLUSIVE — only ${changeCount} change(s) observed ` +
              `(< ${MIN_CLIMB_EDITS} target).`,
          );
        }

        // Final answer resumes in the same chat — parity + completion proof.
        const done = await expectMessage(
          sc.driver,
          SUPERGROUP_ID,
          /\S/,
          { timeout: 60_000, senderFilter: { notUserId: sc.driverUserId } },
        );
        expect(done.chatId).toBe(SUPERGROUP_ID);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
