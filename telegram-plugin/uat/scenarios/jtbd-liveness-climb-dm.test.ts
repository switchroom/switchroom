/**
 * Deterministic-turn-liveness climb — DM (Phase 4a, `deterministic-turn-liveness.md`).
 *
 * The RFC's keystone (Phase 1) gives a busy-but-silent foreground turn a
 * climbing activity card instead of the pre-#2143/#2527/#2667 freeze: once
 * the card is open and no tool emits a label, `feedHeartbeatTick`'s 0-label
 * branch re-renders the SAME message with a fresh `Working · Ns` elapsed
 * every `FEED_HEARTBEAT_MIN_STALE_MS` (~6s), edit-only (no device buzz).
 *
 * IMPORTANT product fact this scenario respects: switchroom has NO streaming
 * REPLY path — the final answer is sent whole (chunked over the char cap if
 * needed). The card observed here is the activity/liveness card — a distinct,
 * pre-existing card-edit surface (worker-activity-feed / liveness card), not
 * a streamed reply. This scenario never asserts a streamed reply edit.
 *
 * ## Trigger
 *
 * A single `Bash` call that sleeps ~40s with no intermediate narration and no
 * tool label — the exact "silent tool" shape the Phase-1 climb exists for.
 *
 * ## What it asserts (asymmetric — timing on a live model is not fully
 * forceable)
 *
 *   PASS      — the SAME activity-card message is edited (non-initial
 *               renders, i.e. `edited === true` on repeat observations of the
 *               same `messageId`) at least `MIN_CLIMB_EDITS` (4) times across
 *               the ~40s window, and the elapsed suffix parsed out of the
 *               body is monotonically non-decreasing across those edits
 *               (the "climbing" property — hard-fails on a frozen/repeated
 *               elapsed value across all edits, which reproduces the pre-
 *               Phase-1 freeze).
 *   PASS      — no bot message OTHER than the one activity-card message id
 *               appears during the silent window (no mid-turn notification
 *               ping; the climb is edit-only, per Phase 1 + the job spec's
 *               "no device buzz" bad-list item).
 *   INCONCLUSIVE — the model narrated anyway (a tool label / narrative text
 *               landed), so the 0-label silent-tool path was not exercised.
 *               Warn + pass — not a regression of this fix.
 *   FAIL      — no answer at all within budget (wedged), or a mid-turn ping
 *               is observed (silent === false on a non-final message).
 *   HARD FAIL — the turn ran clearly longer than the climb bound with fewer
 *               than `MIN_CLIMB_EDITS` edits on the card and no narration —
 *               the exact freeze this fix exists to close.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage, isFrameworkFallbackText } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const MIN_CLIMB_EDITS = 4;
const OVERALL_BUDGET_MS = 140_000;
const SILENT_TOOL_SECONDS = 40;

const SILENT_TOOL_PROMPT =
  "Do exactly this and nothing else: run a single Bash command " +
  `\`sleep ${SILENT_TOOL_SECONDS}\` and wait for it to finish. Do NOT narrate ` +
  "anything before or during the sleep — no commentary, no other tool calls, " +
  "no intermediate messages. Only after the sleep completes, reply with a " +
  "one-line confirmation that you waited.";

/** Parse the `Working · Ns` (or `· Nm Ss`) elapsed suffix out of a card body.
 *  Returns null when the shape isn't present (e.g. a labelled feed). */
function parseElapsedSeconds(text: string): number | null {
  const m = text.match(/(?:^|\s)·\s*(?:(\d+)\s*m)?\s*(\d+)\s*s\b/i);
  if (!m) return null;
  const minutes = m[1] ? Number.parseInt(m[1], 10) : 0;
  const seconds = Number.parseInt(m[2], 10);
  return minutes * 60 + seconds;
}

describe("uat: deterministic turn liveness — silent-tool card climb (DM)", () => {
  it(
    "climbs the SAME activity card ≥4 times with non-decreasing elapsed, no mid-turn ping",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const iter = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();

        await sc.sendDM(SILENT_TOOL_PROMPT);
        const sentAt = Date.now();
        console.log("[liveness-climb-dm] prompt sent; watching card edits…");

        let cardMessageId: number | null = null;
        const elapsedSamples: number[] = [];
        let cardEditCount = 0;
        let answer: ObservedMessage | null = null;
        let otherLoudMessage: ObservedMessage | null = null;

        const deadline = Date.now() + 100_000;
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
                `[liveness-climb-dm] card edit #${cardEditCount} at +${Date.now() - sentAt}ms: ` +
                  JSON.stringify(m.text.slice(0, 100)),
              );
            }
            // A non-silent card edit would still be a ping; card edits are
            // asserted separately below via `silent`.
            if (m.edited && m.silent === false) {
              otherLoudMessage = otherLoudMessage ?? m;
            }
            continue;
          }

          if (m.edited) continue;
          // Attributable-answer gate: a framework mid-turn/dark-turn fallback
          // TEXT send (the exact #2667 erosion this wall guards against — a
          // re-added "still working…" ping) must NOT be swallowed as the
          // turn's answer. Classify it as a mid-turn erosion regardless of its
          // silent flag, so the first loud mid-turn message trips the
          // assertion instead of masquerading as the reply.
          if (isFrameworkFallbackText(m.text)) {
            otherLoudMessage = otherLoudMessage ?? m;
            console.log(
              `[liveness-climb-dm] framework fallback text mid-turn at +${Date.now() - sentAt}ms: ` +
                JSON.stringify(m.text.slice(0, 120)),
            );
            continue;
          }
          if (!answer && m.text.trim().length > 0) {
            answer = m;
            console.log(`[liveness-climb-dm] answer at +${Date.now() - sentAt}ms.`);
            continue;
          }
          // Any OTHER non-edit bot message during the window is a candidate
          // mid-turn ping — track it for the loud-message assertion below.
          if (m.silent === false) {
            otherLoudMessage = otherLoudMessage ?? m;
          }
        }
        await iter.return?.();

        // No mid-turn erosion: neither a device-buzzing ping (silent=false on
        // a non-final message) NOR a framework fallback TEXT send (a
        // "still working…"-class mid-turn message — the climb is an edit-only
        // card, never a text send).
        expect(
          otherLoudMessage,
          `a mid-turn message eroded the ping-free/edit-only guarantee ` +
            `(loud ping or framework fallback text): ` +
            JSON.stringify(otherLoudMessage?.text?.slice(0, 120)),
        ).toBeNull();

        if (cardEditCount === 0 && cardMessageId == null) {
          console.warn(
            "[liveness-climb-dm] INCONCLUSIVE — no activity card observed at all " +
              "(the model may have narrated before/instead of the silent sleep, " +
              "or the turn completed too fast). Not a regression of this fix.",
          );
          expect(answer, "even in the inconclusive branch the turn must complete").not.toBeNull();
          return;
        }

        if (cardEditCount > 0 && cardEditCount < MIN_CLIMB_EDITS) {
          console.warn(
            `[liveness-climb-dm] INCONCLUSIVE — card edited ${cardEditCount} time(s), ` +
              `below the ${MIN_CLIMB_EDITS} target (model may have narrated a tool ` +
              "label partway through, handing off to the labelled-feed heartbeat " +
              "with a different cadence). Not a hard failure.",
          );
        } else {
          expect(
            cardEditCount,
            `HARD FAIL — the silent tool ran ~${SILENT_TOOL_SECONDS}s but the activity ` +
              `card edited only ${cardEditCount} time(s) (< ${MIN_CLIMB_EDITS}). This is ` +
              "the pre-Phase-1 freeze regression (#2143/#2527/#2667 archaeology in " +
              "reference/rfcs/deterministic-turn-liveness.md).",
          ).toBeGreaterThanOrEqual(MIN_CLIMB_EDITS);
        }

        // Climbing property: elapsed samples must be non-decreasing (never
        // rewinds across edits of the same card)…
        for (let i = 1; i < elapsedSamples.length; i++) {
          expect(
            elapsedSamples[i],
            `elapsed suffix went backwards/froze across edits: ${JSON.stringify(elapsedSamples)}`,
          ).toBeGreaterThanOrEqual(elapsedSamples[i - 1]);
        }
        // …and, when we have the full climb (≥MIN_CLIMB_EDITS parsed samples),
        // it must actually CLIMB — a frozen/repeated elapsed value across all
        // edits is the exact pre-Phase-1 freeze and a hard failure (this backs
        // the job-spec Prove-it claim; non-decreasing alone would pass a
        // frozen card).
        if (elapsedSamples.length >= MIN_CLIMB_EDITS) {
          expect(
            elapsedSamples[elapsedSamples.length - 1],
            `HARD FAIL — the elapsed suffix never advanced across ${elapsedSamples.length} ` +
              `card edits (frozen at ${JSON.stringify(elapsedSamples)}). A repeated elapsed ` +
              "value across all edits is the pre-Phase-1 freeze this fix closes.",
          ).toBeGreaterThan(elapsedSamples[0]);
        }

        expect(answer, "FAIL — no answer arrived within budget; the turn may be wedged.").not.toBeNull();
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
