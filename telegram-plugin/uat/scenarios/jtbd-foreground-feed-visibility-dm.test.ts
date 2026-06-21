/**
 * Foreground activity-feed visibility across the silence-fallback threshold.
 *
 * ## Cause class
 *
 * A foreground turn that does REAL sequential work (several tool calls, each
 * followed by a model-thinking gap) can trip the silence-fallback timer
 * (`SILENCE_FALLBACK_MS`, default 300 000 ms) even while it is visibly
 * progressing. The silence clock is reset by:
 *
 *   - A fresh `reply` or `stream_reply` first-emit (any real user-visible send).
 *   - `SILENCE_LIVENESS_PRODUCTION` ON (the default): a new tool-activity label
 *     appearing on the feed, or an answer-stream draft update.
 *
 * Crucially, every render resets the clock to ZERO — so the failure is NOT
 * cumulative across many short gaps. The feed only darkens on a SINGLE
 * continuous no-render window longer than the threshold. Heartbeat edits keep
 * the message visually advancing but do NOT count as liveness, so they do not
 * reset the clock; only a real tool-label render or an answer-stream draft does.
 *
 * This file is the DETERMINISTIC guard half of the pair. The fleet runs
 * `SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=1` (set in defaults.env — it is the
 * fleet default, despite a stale gateway.ts comment that still says "OFF, canary
 * on marko"). With the defer ON, a single long IN-FLIGHT tool does NOT trip the
 * base fallback: the defer holds it back while the tool runs (up to the hard
 * ceiling, default 15 min) and the feed heartbeat keeps editing the live
 * message. So the CORRECT behaviour for a long in-flight turn is: the feed stays
 * lit. This guard pins exactly that. A regression that breaks the defer, stops
 * the heartbeat, or nulls `currentTurn` for an in-flight turn darkens the feed,
 * and this test catches it.
 *
 * The workload is one ~35 s no-output command (`sleep 35`) — well under the
 * default 15 min hard ceiling — so under prod config the feed must stay live
 * across the shrunk 20 s base fallback. A prompt of several FAST steps would not
 * exercise the silence window at all (each tool start re-renders and resets the
 * clock); one long stretch is what holds the clock open.
 *
 * This guard does NOT reproduce #680's exact trigger — silent model thinking
 * BETWEEN tools, with no tool in-flight. The defer does not cover that vector
 * and it cannot be forced deterministically; it lives in the sibling best-effort
 * scenario `jtbd-foreground-feed-thinkgap-dm.test.ts`. Together the pair covers
 * the feed-visibility invariant deterministically (here) and the true #680
 * vector best-effort (there).
 *
 * This scenario shrinks the base fallback to 20 s via
 * `SWITCHROOM_SILENCE_FALLBACK_MS=20000` on the test-harness agent so the
 * window is exercised within a test budget instead of 5 minutes.
 *
 * ## Required env precondition (operator must set on test-harness agent)
 *
 *   SWITCHROOM_SILENCE_FALLBACK_MS=20000
 *
 * Set this under the `test-harness` agent's `env:` block in
 * `~/.switchroom/switchroom.yaml`, then restart the agent
 * (`switchroom agent restart test-harness --wait --force`) before running
 * this scenario. The scenario detects whether the threshold is plausibly
 * shrunk by reading `SWITCHROOM_UAT_SILENCE_FALLBACK_MS` from the test
 * env (a parallel knob populated by the UAT `.env` file) and
 * skip-with-message if it is not set to ≤ 30 000.
 *
 * Without the shrunk threshold the scenario still runs but the timing
 * assertions become vacuous (the default 300 s threshold far exceeds the
 * test budget) and the test exits before the scenario would have had a
 * chance to catch a regression. The skip keeps the failure signal honest.
 *
 * ## What it asserts (the gap no existing scenario covers)
 *
 * 1. **Feed opened.** An activity-feed message (`→`/`✓` lines) appears in the
 *    DM at some point during the turn — the agent started reporting progress.
 *
 * 2. **Feed survived the fallback window.** After the silence-fallback interval
 *    has elapsed from the point the feed was first observed, the feed message
 *    is still present and carries at least one more edit that arrived AFTER
 *    the threshold mark. If `currentTurn` was nulled mid-turn, the gateway
 *    stops sending activity-feed edits and the message goes stale or disappears
 *    — this assertion catches that.
 *
 * 3. **Final answer arrives.** A substantive reply (≥ 150 chars) eventually
 *    lands, confirming the turn completed rather than being wedged.
 *
 * ## Failure shapes
 *
 *   (a) Feed never opened — the activity feed did not paint at all. Either the
 *       agent never used tools or the very first drainActivitySummary call
 *       failed. Distinct from the regression; both are failures.
 *
 *   (b) Feed went dark — the feed message was present before the fallback mark
 *       but received no fresh edit after the mark. This IS the regression this
 *       test exists to catch: `currentTurn` was nulled mid-turn, silencing the
 *       live feed while the agent was still working.
 *
 *   (c) No final answer — the turn never produced a substantive reply. Possibly
 *       the fallback also dropped the answer path (compound regression), or the
 *       prompt was too slow for the overall test budget.
 *
 * ## Tolerances
 *
 * The feed edit observation is polled via `driver.getMessage` (the same
 * technique used by `jtbd-worker-activity-feed-dm`). Because mtcute's live
 * `observeMessages` may miss edits that arrive before the observer is attached,
 * we cross-check by comparing the snapshot taken just before the fallback mark
 * against a fresh fetch just after it. A changed body confirms a live edit
 * occurred across the threshold; an UNCHANGED body with no subsequent new edit
 * in the live stream is the regression signal.
 *
 * The prompt is engineered so the model does at least 4 sequential tool calls
 * with brief thinking gaps between them, each step taking ~4–6 s, giving a
 * natural total span of ~25–35 s that straddles the shrunk 20 s fallback.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

/**
 * The shrunk fallback threshold the operator must set on the test-harness
 * agent. The test reads a parallel UAT-env knob so we can detect whether
 * the precondition is satisfied without reaching into the agent's process env.
 *
 * Set `SWITCHROOM_UAT_SILENCE_FALLBACK_MS=20000` in the repo-root `.env`
 * alongside `SWITCHROOM_SILENCE_FALLBACK_MS=20000` in the agent's env block.
 */
const PRECONDITION_FALLBACK_MS = Number.parseInt(
  process.env.SWITCHROOM_UAT_SILENCE_FALLBACK_MS ?? "",
  10,
);

/**
 * How long to wait after the feed first appears before taking the
 * "before-mark" snapshot. We want the fallback timer to have clearly
 * elapsed by the time we take the "after-mark" snapshot. Chosen to be
 * safely above the shrunk 20 s fallback while staying comfortably within
 * the test budget.
 */
const FALLBACK_WINDOW_MS = 25_000;

/**
 * How long to poll after the fallback window for a fresh feed edit. Short
 * enough not to waste budget but long enough for one more drainActivitySummary
 * cycle to land (the feed heartbeat fires roughly every 5–8 s).
 */
const POST_MARK_EDIT_WAIT_MS = 15_000;

/**
 * A substantive answer is at least this many characters. Avoids latching
 * onto a brief "on it" ack or a stub.
 */
const MIN_ANSWER_CHARS = 150;

/**
 * Overall test budget. Includes:
 *   - spinUp settle: ~8 s
 *   - turn onset (first tool + first feed paint): ~20 s
 *   - FALLBACK_WINDOW_MS: 25 s
 *   - POST_MARK_EDIT_WAIT_MS: 15 s
 *   - final-answer wait: ~30 s
 *   - headroom: ~20 s
 */
const OVERALL_BUDGET_MS = 150_000;

/**
 * Workload prompt: one ~33 s no-output command, `timeout 33 tail -f /dev/null`.
 * NOTE: standalone `sleep` is blocked by the Claude Code harness ("foreground
 * sleep is blocked"), so this is the hook-safe equivalent of a long in-flight
 * no-op. The tool's label renders once at its start (resetting the clock to
 * zero), then nothing renders for ~33 s while the tool is in-flight. Under prod
 * config (defer ON) the base fallback is HELD during that in-flight stretch, so
 * the feed must stay live and the heartbeat keeps editing it. That is the
 * invariant this guard asserts; a regression that lets `currentTurn` get nulled
 * mid-stretch breaks it.
 *
 * The prompt explicitly asks the model to give the Bash call a short
 * DESCRIPTION. That matters: an empty-label tool is dropped from the activity
 * feed (it never opens), which would fail the test on "feed never appeared"
 * (shape a) for the wrong reason. A labelled tool opens the feed reliably.
 *
 * Why not several fast steps: each fast tool start emits a fresh label that
 * resets the clock, so the silence window never opens at all and the test would
 * pass vacuously (a false green). One long stretch is what holds it open.
 *
 * We do NOT use run_in_background — this must be a FOREGROUND turn so
 * currentTurn stays in place and the silence clock applies to it directly.
 */
const SEQUENTIAL_WORK_PROMPT =
  "Use the Bash tool to run EXACTLY this command — and give the tool call a " +
  'short description such as "long-running wait" so it is clearly labelled: ' +
  "`timeout 33 tail -f /dev/null`. It runs for about 33 seconds and then exits " +
  "on its own (a non-zero timeout exit code is expected and fine). Do not run " +
  "any other tool while it is running. After it finishes, reply with a short " +
  "paragraph (a few sentences) telling me it completed and that you waited " +
  "about 33 seconds.";

describe("uat: foreground activity-feed visibility across silence-fallback threshold", () => {
  it(
    "feed remains live and receives edits after the shrunk fallback window",
    async () => {
      // Precondition guard: if the operator hasn't shrunk the silence
      // fallback to ≤ 30 000 ms on the test-harness agent (and mirrored
      // it into the UAT env), the timing assertions are vacuous. Skip
      // with a clear message rather than silently producing a false green.
      if (!Number.isFinite(PRECONDITION_FALLBACK_MS) || PRECONDITION_FALLBACK_MS > 30_000) {
        console.warn(
          "[uat/foreground-feed-visibility] SKIPPED — precondition not met.\n" +
            "  This scenario requires SWITCHROOM_SILENCE_FALLBACK_MS=20000 set on\n" +
            "  the test-harness agent AND SWITCHROOM_UAT_SILENCE_FALLBACK_MS=20000\n" +
            "  in the repo-root .env. Without it the silence fallback does not fire\n" +
            "  within the test window and the regression cannot be detected.\n" +
            "  See the header doc comment in this file for setup instructions.",
        );
        return;
      }

      const sc = await spinUp({ agent: "test-harness" });
      try {
        // Start observing BEFORE sending so no activity-feed messages are missed.
        const iter = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();

        await sc.sendDM(SEQUENTIAL_WORK_PROMPT);

        console.log("[foreground-feed] prompt sent; watching for activity-feed message…");

        // ── Assertion 1: feed opened ─────────────────────────────────────────
        // Drain the live message stream until we see an activity-feed message
        // (lines matching `→ …` or `✓ …`). Give generous budget for the agent to
        // start tools and open the feed.
        let feedMsg: ObservedMessage | null = null;
        const feedDeadline = Date.now() + 90_000;

        while (Date.now() < feedDeadline) {
          const remaining = feedDeadline - Date.now();
          const next = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), Math.max(0, remaining)),
            ),
          ]);
          if (next.done || next.value == null) break;
          const m = next.value as ObservedMessage;
          // Skip our own echo and worker-feed messages; we want the foreground
          // activity feed.
          if (m.senderUserId === sc.driverUserId) continue;
          if (isActivityFeedMessage(m)) {
            feedMsg = m;
            break;
          }
        }

        expect(
          feedMsg,
          "Failure shape (a): the foreground activity-feed message never appeared. " +
            "Either the agent did not use tools, the prompt was too fast for the " +
            "feed to paint, or drainActivitySummary failed on every attempt this turn.",
        ).not.toBeNull();

        // feedMsg is confirmed non-null beyond this point.
        const { messageId: feedId } = feedMsg!;
        console.log(
          `[foreground-feed] feed opened (id=${feedId}): ` +
            JSON.stringify(feedMsg!.text.slice(0, 120)),
        );

        // ── Snapshot before the fallback mark ───────────────────────────────
        // Record the feed body and clock, then wait FALLBACK_WINDOW_MS so the
        // shrunk base fallback has definitely elapsed. During this wait the
        // single in-flight stretch (`sleep 35`) emits no renders, but the defer
        // (prod default ON) HOLDS the base fallback while the tool is in-flight,
        // so currentTurn survives and the feed heartbeat keeps editing the
        // message. We assert those heartbeat edits keep landing after the mark;
        // if a regression nulls currentTurn mid-stretch, the edits stop and we
        // catch it.
        const beforeMarkText = feedMsg!.text;
        const markAt = Date.now() + FALLBACK_WINDOW_MS;

        console.log(
          `[foreground-feed] waiting ${FALLBACK_WINDOW_MS}ms for fallback window to elapse…`,
        );
        await new Promise((r) => setTimeout(r, FALLBACK_WINDOW_MS));

        // ── Assertion 2: feed survived the fallback window ───────────────────
        // Fetch the feed message directly. If currentTurn was nulled mid-turn,
        // the gateway either stopped editing (stale text) or the message may have
        // been deleted by clearActivitySummary (null). Either condition is the
        // regression.
        const afterMark = await sc.driver.getMessage(sc.botUserId, feedId);

        console.log(
          `[foreground-feed] feed state after ${FALLBACK_WINDOW_MS}ms mark ` +
            `(id=${feedId}): ` +
            JSON.stringify(afterMark?.text?.slice(0, 120) ?? null),
        );

        expect(
          afterMark,
          "Failure shape (b): the activity-feed message was deleted after the " +
            `silence-fallback window (${FALLBACK_WINDOW_MS}ms). This means ` +
            "currentTurn was nulled mid-turn by the silence-fallback handler, " +
            "which then triggered clearActivitySummary and removed the live feed " +
            "message. The regression: a productive foreground turn went dark " +
            "because a continuous no-render window exceeded the " +
            `shrunk threshold (SWITCHROOM_SILENCE_FALLBACK_MS=${PRECONDITION_FALLBACK_MS}).`,
        ).not.toBeNull();

        // The body should have changed — i.e. the feed received at least one
        // edit after the fallback mark — proving it is still alive. We check
        // both the polled snapshot and the live-stream edits we may have
        // collected during the wait.
        const bodyChangedAfterMark = afterMark!.text !== beforeMarkText;

        // Also drain any edits that arrived during the POST_MARK_EDIT_WAIT_MS
        // window to catch the next drainActivitySummary cycle if the polled
        // snapshot was taken slightly before the edit landed.
        let sawFeedEditAfterMark = bodyChangedAfterMark;
        const postMarkDeadline = Date.now() + POST_MARK_EDIT_WAIT_MS;

        while (!sawFeedEditAfterMark && Date.now() < postMarkDeadline) {
          const remaining = postMarkDeadline - Date.now();
          const next = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), Math.max(0, remaining)),
            ),
          ]);
          if (next.done || next.value == null) break;
          const m = next.value as ObservedMessage;
          if (m.senderUserId === sc.driverUserId) continue;
          // An edit of the feed message that arrived after the mark
          if (m.edited && m.messageId === feedId && m.date.getTime() >= markAt) {
            sawFeedEditAfterMark = true;
            console.log(
              `[foreground-feed] feed edit confirmed after mark (id=${feedId}): ` +
                JSON.stringify(m.text.slice(0, 120)),
            );
          }
        }

        expect(
          sawFeedEditAfterMark,
          "Failure shape (b): the activity-feed message still exists but received " +
            `no edit after the ${FALLBACK_WINDOW_MS}ms fallback window. This is the ` +
            "feed-went-dark regression: currentTurn was nulled mid-turn so no further " +
            "drainActivitySummary calls fired. The feed body was frozen at " +
            `${JSON.stringify(beforeMarkText.slice(0, 80))} and did not advance.`,
        ).toBe(true);

        // ── Assertion 3: final answer lands ─────────────────────────────────
        // Collect from the live stream until a substantive bot reply arrives.
        // This confirms the turn completed — the fallback did not also drop
        // the answer path.
        let finalAnswer: ObservedMessage | null = null;
        const answerDeadline = Date.now() + 60_000;

        while (Date.now() < answerDeadline) {
          const remaining = answerDeadline - Date.now();
          const next = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), Math.max(0, remaining)),
            ),
          ]);
          if (next.done || next.value == null) break;
          const m = next.value as ObservedMessage;
          if (m.senderUserId === sc.driverUserId) continue;
          if (m.edited) continue; // edits are feed updates, not the answer
          if (isActivityFeedMessage(m)) continue; // skip feed-only sends
          if (m.text.trim().length >= MIN_ANSWER_CHARS) {
            finalAnswer = m;
            break;
          }
        }

        console.log(
          `[foreground-feed] final answer (id=${finalAnswer?.messageId ?? "NONE"}): ` +
            JSON.stringify(finalAnswer?.text?.slice(0, 180) ?? null),
        );

        expect(
          finalAnswer,
          "Failure shape (c): no final answer arrived after the silence-fallback " +
            `window. The turn did not produce a substantive reply (≥${MIN_ANSWER_CHARS} chars). ` +
            "If the feed-gone-dark assertion also failed, the fallback may have " +
            "suppressed the entire turn's output. If only this assertion failed, " +
            "the turn is still in flight past the test budget — increase the prompt " +
            "timeout or check that the agent is not wedged.",
        ).not.toBeNull();

        await iter.return?.();
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
