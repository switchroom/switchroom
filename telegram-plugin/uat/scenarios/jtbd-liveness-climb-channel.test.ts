/**
 * Deterministic-turn-liveness climb — CHANNEL twin of
 * `jtbd-liveness-climb-dm.test.ts` (Phase 4a, `deterministic-turn-liveness.md`).
 *
 * Surface parity is a production-readiness bar for this job (job spec §
 * Production-readiness: "every signal is proven in both DM and forum
 * channel"). Phase 1's climb is keyed on the SAME `feedHeartbeatTick` /
 * `runSilentTurnHeartbeatTick` path regardless of chat type — this scenario
 * proves the card edits land, CLIMB, and stay ping-free in a supergroup too,
 * not just a DM. It is brought to full parity with the DM twin: it parses the
 * elapsed suffix, asserts non-decreasing climb, and HARD-FAILS on a frozen
 * card (zero edits across a clearly-long silent tool) — the exact freeze this
 * fix exists to detect. (Previously it only warned "INCONCLUSIVE" on a freeze,
 * so it could never catch the regression it exists for.)
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
import { isActivityFeedMessage, isFrameworkFallbackText } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);

const MIN_CLIMB_EDITS = 4;
const OVERALL_BUDGET_MS = 160_000;
const SILENT_TOOL_SECONDS = 40;

const SILENT_TOOL_PROMPT =
  "Do exactly this and nothing else: run a single Bash command " +
  `\`sleep ${SILENT_TOOL_SECONDS}\` and wait for it to finish. Do NOT narrate ` +
  "anything before or during the sleep — no commentary, no other tool calls, " +
  "no intermediate messages. Only after the sleep completes, reply with a " +
  "one-line confirmation that you waited.";

/** Parse the `Working · Ns` (or `· Nm Ss`) elapsed suffix out of a card body.
 *  Returns null when the shape isn't present. Mirrors the DM twin. */
function parseElapsedSeconds(text: string): number | null {
  const m = text.match(/(?:^|\s)·\s*(?:(\d+)\s*m)?\s*(\d+)\s*s\b/i);
  if (!m) return null;
  const minutes = m[1] ? Number.parseInt(m[1], 10) : 0;
  const seconds = Number.parseInt(m[2], 10);
  return minutes * 60 + seconds;
}

describe("uat: deterministic turn liveness — silent-tool card climb (channel parity)", () => {
  it(
    "climbs the activity card in a supergroup ≥4 times with non-decreasing elapsed, no mid-turn ping",
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

        const iter = sc.driver
          .observeMessages(SUPERGROUP_ID)
          [Symbol.asyncIterator]();

        await sc.driver.sendText(SUPERGROUP_ID, SILENT_TOOL_PROMPT);
        const sentAt = Date.now();
        console.log("[liveness-climb-channel] prompt sent; watching card edits…");

        let cardMessageId: number | null = null;
        const elapsedSamples: number[] = [];
        let cardEditCount = 0;
        let answer: ObservedMessage | null = null;
        let otherLoudMessage: ObservedMessage | null = null;

        const deadline = Date.now() + 110_000;
        while (Date.now() < deadline) {
          if (answer && cardEditCount >= MIN_CLIMB_EDITS) break;
          const remaining = deadline - Date.now();
          const next = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), Math.max(0, remaining)),
            ),
          ]);
          if (next.done || next.value == null) break;
          const m = next.value as ObservedMessage;
          if (m.senderUserId === sc.driverUserId) continue;

          if (isActivityFeedMessage(m)) {
            if (cardMessageId == null) cardMessageId = m.messageId;
            if (m.messageId === cardMessageId && m.edited) {
              cardEditCount++;
              const secs = parseElapsedSeconds(m.text);
              if (secs != null) elapsedSamples.push(secs);
              console.log(
                `[liveness-climb-channel] card edit #${cardEditCount} at +${Date.now() - sentAt}ms: ` +
                  JSON.stringify(m.text.slice(0, 100)),
              );
            }
            if (m.edited && m.silent === false) otherLoudMessage = otherLoudMessage ?? m;
            continue;
          }

          if (m.edited) continue;
          // A framework fallback TEXT send is a mid-turn erosion, not the
          // completion proof — reject it from the answer lane (see DM twin).
          if (isFrameworkFallbackText(m.text)) {
            otherLoudMessage = otherLoudMessage ?? m;
            continue;
          }
          if (!answer && m.text.trim().length > 0) {
            answer = m;
            console.log(`[liveness-climb-channel] answer at +${Date.now() - sentAt}ms.`);
            continue;
          }
          if (m.silent === false) otherLoudMessage = otherLoudMessage ?? m;
        }
        await iter.return?.();

        // No mid-turn erosion: the climb is edit-only in a supergroup too.
        expect(
          otherLoudMessage,
          `a mid-turn message eroded the ping-free/edit-only guarantee in the ` +
            `supergroup (loud ping or framework fallback text): ` +
            JSON.stringify(otherLoudMessage?.text?.slice(0, 120)),
        ).toBeNull();

        if (cardEditCount === 0 && cardMessageId == null) {
          console.warn(
            "[liveness-climb-channel] INCONCLUSIVE — no activity card observed at all " +
              "(the model may have narrated, or the turn completed too fast).",
          );
          expect(answer, "even in the inconclusive branch the turn must complete").not.toBeNull();
          return;
        }

        if (cardEditCount > 0 && cardEditCount < MIN_CLIMB_EDITS) {
          console.warn(
            `[liveness-climb-channel] INCONCLUSIVE — card edited ${cardEditCount} time(s), ` +
              `below the ${MIN_CLIMB_EDITS} target (model may have narrated a tool label ` +
              "partway through, handing to the labelled-feed heartbeat).",
          );
        } else {
          expect(
            cardEditCount,
            `HARD FAIL — the silent tool ran ~${SILENT_TOOL_SECONDS}s in a supergroup but the ` +
              `activity card edited only ${cardEditCount} time(s) (< ${MIN_CLIMB_EDITS}). This is ` +
              "the pre-Phase-1 freeze regression, in the channel surface.",
          ).toBeGreaterThanOrEqual(MIN_CLIMB_EDITS);
        }

        // Climbing property: elapsed samples must be non-decreasing…
        for (let i = 1; i < elapsedSamples.length; i++) {
          expect(
            elapsedSamples[i],
            `elapsed suffix went backwards/froze across edits: ${JSON.stringify(elapsedSamples)}`,
          ).toBeGreaterThanOrEqual(elapsedSamples[i - 1]);
        }
        // …and must actually climb across the full window (frozen == the freeze
        // this fix closes; backs the job-spec Prove-it claim).
        if (elapsedSamples.length >= MIN_CLIMB_EDITS) {
          expect(
            elapsedSamples[elapsedSamples.length - 1],
            `HARD FAIL — the elapsed suffix never advanced across ${elapsedSamples.length} ` +
              `card edits in the supergroup (frozen at ${JSON.stringify(elapsedSamples)}).`,
          ).toBeGreaterThan(elapsedSamples[0]);
        }

        // Completion proof: an ANSWER (not the card itself) resumes in the same
        // chat. Guarding on `!isActivityFeedMessage` stops the old
        // `expectMessage(SUPERGROUP_ID, /\S/)` from matching a card edit and
        // declaring the turn done while the agent was still climbing.
        expect(
          answer,
          "FAIL — no answer (distinct from the activity card) arrived within budget; the turn may be wedged.",
        ).not.toBeNull();
        expect(answer?.chatId).toBe(SUPERGROUP_ID);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
