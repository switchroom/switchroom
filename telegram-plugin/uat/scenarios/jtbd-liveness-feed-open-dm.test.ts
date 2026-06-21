/**
 * Liveness-driven feed open — a thinking-only turn still surfaces a live feed.
 *
 * ## Cause class (the #680 dark-turn, true vector)
 *
 * The activity feed is TOOL-driven: it opens only when a tool emits a non-null
 * label (`drainActivitySummary`). A turn dominated by model thinking, or by
 * suppressed-by-design tools (typing / memory recall / reply), emits no label —
 * so the feed never opens and a long turn reads as pure silence until the 300s
 * silence-poke. Turn #680 was exactly this: 335 s alive, `tools=4`, yet
 * `feedOpened=false / activityMsgId=none` the entire time.
 *
 * The fix (gateway `feedHeartbeatTick`): once a turn has been alive for
 * `FEED_LIVENESS_OPEN_MS` with no labelled tool yet, open a minimal `Working…`
 * feed and let the existing 6 s heartbeat climb its elapsed. The first real
 * tool label takes over and its edit replaces the placeholder; a pure-thinking
 * turn finalizes to `✓ Working…` rather than freezing on the live line.
 *
 * ## Precondition (set on the test-harness agent for this run)
 *
 *   SWITCHROOM_FEED_LIVENESS_OPEN_MS=6000   (shrinks the default 12 s so the
 *                                            window is exercised within budget)
 *
 * The scenario does not hard-require it — at the 12 s default the feed still
 * opens, just later; the deadlines below tolerate either.
 *
 * ## What it asserts (asymmetric — non-determinism is handled, not faked)
 *
 * The trigger is a "think, then answer at length, use NO tools" prompt. The
 * model's exact behaviour is not fully forceable, so the branches are:
 *
 *   PASS         — a `Working…` activity-feed message appeared. ONLY the
 *                  liveness path produces a bare "Working…" feed (a tool would
 *                  carry a tool label), so this is positive proof the timer
 *                  opened the feed on a tool-less turn.
 *   INCONCLUSIVE — the agent used a tool anyway (feed opened with a tool label,
 *                  no "Working…"). The liveness path was not exercised; not a
 *                  failure of the fix. Warn + pass.
 *   INCONCLUSIVE — the turn was too short (answer landed before the threshold).
 *                  Warn + pass.
 *   HARD FAIL    — the turn ran clearly longer than the threshold with NO feed
 *                  of any kind, yet produced an answer. Liveness should have
 *                  opened a feed and did not — the regression this guard exists
 *                  to catch.
 *   FAIL         — no answer at all within budget (wedged).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

/** A substantive answer is at least this many characters (skips a brief ack). */
const MIN_ANSWER_CHARS = 200;

/** Overall test budget. */
const OVERALL_BUDGET_MS = 150_000;

/**
 * Workload: think, then answer at length, with NO tools. The long answer
 * generation holds the turn open past the liveness threshold with no tool
 * label, which is exactly the condition that should open the `Working…` feed.
 */
const THINKING_WORKLOAD_PROMPT =
  "Do NOT use any tools at all for this — no Bash, no Read, no memory search, " +
  "nothing. Just think carefully and then write me a thorough, detailed " +
  "explanation (at least 450 words) of how the TCP three-way handshake works, " +
  "including SYN, SYN-ACK, ACK, sequence numbers, and what happens if the final " +
  "ACK is lost. Take your time getting it right, then reply with the full essay " +
  "in one message.";

describe("uat: liveness-driven feed open (thinking-only turn stays visible)", () => {
  it(
    "opens a 'Working…' feed for a turn that emits no tool label",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const iter = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();

        await sc.sendDM(THINKING_WORKLOAD_PROMPT);
        const sentAt = Date.now();
        console.log("[liveness-feed] prompt sent; watching for feed + answer…");

        // Drain the stream until EITHER a feed message appears OR a substantive
        // answer lands. Track which kind of feed (liveness vs tool) we saw.
        let livenessFeed: ObservedMessage | null = null;
        let toolFeed: ObservedMessage | null = null;
        let answer: ObservedMessage | null = null;
        let answerAt = 0;

        const deadline = Date.now() + 110_000;
        while (Date.now() < deadline) {
          if (livenessFeed && answer) break;
          const remaining = deadline - Date.now();
          const next = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(
                () => r({ done: true, value: undefined }),
                Math.max(0, remaining),
              ),
            ),
          ]);
          if (next.done || next.value == null) break;
          const m = next.value as ObservedMessage;
          if (m.senderUserId === sc.driverUserId) continue;

          if (isActivityFeedMessage(m)) {
            // A "Working…" feed body is the liveness placeholder; anything else
            // is a tool-label feed.
            if (/Working/.test(m.text)) {
              if (!livenessFeed) {
                livenessFeed = m;
                console.log(
                  `[liveness-feed] LIVENESS feed opened at +${Date.now() - sentAt}ms: ` +
                    JSON.stringify(m.text.slice(0, 120)),
                );
              }
            } else if (!toolFeed) {
              toolFeed = m;
              console.log(
                `[liveness-feed] tool-label feed opened at +${Date.now() - sentAt}ms: ` +
                  JSON.stringify(m.text.slice(0, 120)),
              );
            }
            continue;
          }
          if (m.edited) continue;
          if (m.text.trim().length >= MIN_ANSWER_CHARS && !answer) {
            answer = m;
            answerAt = Date.now();
            console.log(
              `[liveness-feed] answer landed at +${answerAt - sentAt}ms (len=${m.text.trim().length}).`,
            );
          }
        }

        const turnSpanMs = (answerAt || Date.now()) - sentAt;

        // ── Branch resolution ───────────────────────────────────────────────
        if (livenessFeed) {
          // PASS: the liveness timer opened a feed on a tool-less turn.
          expect(
            livenessFeed,
            "liveness feed should be present in the PASS branch",
          ).not.toBeNull();
          // Confirm it carries the in-progress placeholder shape.
          expect(livenessFeed!.text).toMatch(/Working/);
          console.log(
            "[liveness-feed] PASS — liveness-driven feed open confirmed.",
          );
          return;
        }

        if (toolFeed) {
          console.warn(
            "[liveness-feed] INCONCLUSIVE — the agent used a tool, so the feed " +
              "opened via the normal tool-label path and the liveness timer was " +
              "not exercised. Not a failure of the fix.",
          );
          // Still require the turn completed.
          expect(
            answer,
            "even in the tool-feed branch the turn must complete with an answer",
          ).not.toBeNull();
          return;
        }

        // No feed of any kind appeared.
        if (answer && turnSpanMs < 8_000) {
          console.warn(
            `[liveness-feed] INCONCLUSIVE — turn completed in ${turnSpanMs}ms, ` +
              "below the liveness threshold; no feed was expected.",
          );
          return;
        }

        // No feed, and the turn ran long enough that liveness SHOULD have opened.
        expect(
          answer,
          "FAIL — no answer arrived within budget; the turn may be wedged.",
        ).not.toBeNull();

        expect(
          livenessFeed,
          "HARD FAIL — the turn ran for " +
            `${turnSpanMs}ms (well past the liveness threshold) with NO activity ` +
            "feed of any kind, yet produced an answer. The liveness timer should " +
            "have opened a 'Working…' feed and did not — this is the #680 " +
            "dark-turn regression.",
        ).not.toBeNull();

        await iter.return?.();
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
