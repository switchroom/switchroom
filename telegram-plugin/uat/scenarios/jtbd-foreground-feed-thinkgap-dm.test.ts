/**
 * Foreground activity-feed visibility across a between-tools silent-thinking gap.
 *
 * ## Cause class — bug #680, the vector the defer does NOT cover
 *
 * The gateway maintains a live activity-feed Telegram message while a foreground
 * turn is in progress. Its silence-fallback timer (`SILENCE_FALLBACK_MS`, shrunk
 * to 20 000 ms on the test-harness for these scenarios) fires when no liveness
 * signal arrives for longer than the threshold. On fire, `currentTurn` is nulled:
 * the gateway stops sending activity-feed edits and the feed goes dark — even
 * while the agent is still working.
 *
 * The fleet runs `SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=1` (prod default). That
 * defer HOLDS the fallback while a tool is still in-flight — so a long in-flight
 * tool (e.g. `sleep 35`) does NOT trigger the fallback; the heartbeat keeps the
 * feed lit. The sibling scenario `jtbd-foreground-feed-visibility-dm.test.ts`
 * pins that deterministic, defer-protected case.
 *
 * What the defer does NOT protect is a long SILENT MODEL-THINKING GAP between
 * two tool calls, where:
 *   - the prior tool has returned (no tool in-flight),
 *   - no answer-stream draft is emitting, and
 *   - no new tool-label has rendered yet.
 *
 * In that window the silence clock runs UNPROTECTED. If the model thinks silently
 * for longer than 20 s before issuing the next tool call or starting its answer,
 * the fallback fires, `currentTurn` is nulled, and the feed goes dark — while the
 * agent is still working on the turn. This is the exact #680 regression vector.
 *
 * ## Why this is BEST-EFFORT and non-deterministic
 *
 * A gap long enough to trigger the 20 s fallback CANNOT be forced reliably. The
 * model may:
 *   (a) Stream a partial answer-draft, which resets the silence clock — the gap
 *       never opens 20 s unprotected regardless of model latency.
 *   (b) Think quickly and issue its answer before 20 s elapses.
 *   (c) Think slowly and silently for > 20 s, opening the exact vector.
 *
 * Only case (c) lets us observe the bug. Cases (a) and (b) are inconclusive —
 * a lit feed in either case does NOT prove the bug is absent; it just means the
 * trigger condition didn't materialize this run.
 *
 * The workload prompt is engineered to maximize the probability of case (c):
 *   1. One fast tool first (`date` via Bash) so the feed OPENS.
 *   2. An explicit instruction to think silently for at least 30 s without further
 *      tools and without sending anything.
 *   3. A genuinely hard open-ended reasoning question (multi-factor design
 *      estimation) that rewards sustained internal deliberation.
 *
 * This structural bias raises the chance the model hits > 20 s of unprotected
 * silence, but cannot guarantee it on every run.
 *
 * ## Asymmetric assertion logic
 *
 * The scenario uses five distinct code paths, exactly one of which fires per run:
 *
 *   Branch 1 — FEED NEVER OPENED: no activity-feed message appeared after the
 *     first tool call. Cannot observe the #680 vector at all. `console.warn` +
 *     return INCONCLUSIVE (no assertion failure).
 *
 *   Branch 2 — TURN ENDED BEFORE THE MARK: the final answer arrived BEFORE the
 *     fallback-window mark was reached. The dark window cannot have been caused
 *     by a mid-think-gap null because the turn was already complete. This is NOT
 *     the bug; treat as pass/INCONCLUSIVE. `console.warn` + return.
 *
 *   Branch 3 — FEED WENT DARK AND TURN WAS STILL IN-PROGRESS AT THE MARK:
 *     the feed existed before the mark; after the mark there were no further feed
 *     edits; and the final answer had NOT yet arrived at the mark (but does arrive
 *     afterward). This is #680 reproduced. HARD FAIL with a precise message naming
 *     the dark window and that `currentTurn` was nulled mid-think-gap.
 *
 *   Branch 4 — FEED STAYED LIT PAST THE MARK: the feed kept receiving edits after
 *     the mark. Ambiguous — either the fix held, OR the model didn't produce a
 *     > 20 s silent gap (cases (a)/(b) above). Cannot distinguish without deeper
 *     gateway instrumentation. `console.warn` explaining both possibilities and
 *     that a lit feed is NOT proof of fix here — that's the sibling guard's job.
 *     Return INCONCLUSIVE (no assertion failure).
 *
 *   Branch 5 — TURN WEDGED (final answer never arrives): distinct from #680's
 *     trigger; could be a compound regression or a model hang. HARD FAIL.
 *
 * ## Tolerances and timing
 *
 *   - FALLBACK_WINDOW_MS (25 000): wait time from the moment the feed FIRST
 *     appears before taking the "before-mark" snapshot. Chosen to be safely above
 *     the shrunk 20 s fallback while leaving room in the budget.
 *   - POST_MARK_FEED_WAIT_MS (12 000): how long to drain the live stream after the
 *     mark for further feed edits. Short but enough for one heartbeat cycle.
 *   - ANSWER_BUDGET_MS (90 000): how long to wait for the final answer after the
 *     mark. Generous because the model may still be mid-think at the mark.
 *   - OVERALL_BUDGET_MS (150 000): total test timeout including settle, turn
 *     onset, the window, and final-answer drain.
 *
 * ## Env precondition (operator must set on test-harness agent)
 *
 *   SWITCHROOM_SILENCE_FALLBACK_MS=20000   (on the agent's env: block)
 *   SWITCHROOM_SILENCE_DEFER_INFLIGHT_TOOLS=1  (prod default — defer must be ON
 *     so we're isolating the between-tools vector, not the in-flight-tool one)
 *
 * Mirror the fallback value into the UAT env:
 *   SWITCHROOM_UAT_SILENCE_FALLBACK_MS=20000  (in repo-root .env)
 *
 * The scenario reads `SWITCHROOM_UAT_SILENCE_FALLBACK_MS` at runtime to detect
 * whether the precondition is satisfied. If absent or > 30 000, it skips with a
 * clear warning rather than producing a vacuous green or a misleading timeout.
 *
 * ## Cross-reference
 *
 * This is the best-effort, non-deterministic HALF of the feed-visibility pair.
 * The deterministic half (long in-flight tool, defer-protected) is:
 *   `jtbd-foreground-feed-visibility-dm.test.ts`
 * Together the two cover the feed-visibility invariant: deterministically (there)
 * and best-effort for the true #680 between-tools vector (here).
 */

import { describe, it } from "vitest";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

/**
 * UAT-env mirror of the shrunk fallback on the test-harness agent. The
 * scenario checks this rather than querying the agent's process env
 * (which it cannot reach) — so the operator must set both knobs in sync.
 *
 * Set `SWITCHROOM_UAT_SILENCE_FALLBACK_MS=20000` in repo-root .env.
 */
const PRECONDITION_FALLBACK_MS = Number.parseInt(
  process.env.SWITCHROOM_UAT_SILENCE_FALLBACK_MS ?? "",
  10,
);

/**
 * Wait this long (ms) after the feed first appears before taking the
 * "before-mark" snapshot. Must exceed the shrunk 20 s fallback so we
 * are definitively past the point where the bug would have fired.
 */
const FALLBACK_WINDOW_MS = 25_000;

/**
 * After the mark, drain the live stream this long for further feed edits.
 * One full heartbeat cycle (typically 5–8 s) plus slack.
 */
const POST_MARK_FEED_WAIT_MS = 12_000;

/**
 * Budget for the final answer to arrive after the mark. Generous because
 * the model may still be in the middle of its think-gap at the mark.
 */
const ANSWER_BUDGET_MS = 90_000;

/**
 * A reply this many characters or longer is treated as the final answer.
 * Avoids latching onto brief acks or one-liners that are not the deliverable.
 */
const MIN_ANSWER_CHARS = 150;

/**
 * Total test timeout: settle (~8 s) + turn onset + feed wait (~30 s) +
 * FALLBACK_WINDOW_MS (25 s) + POST_MARK_FEED_WAIT_MS (12 s) + answer
 * budget (90 s) + headroom. The budget is generous because model latency
 * during the silent thinking gap is the whole point.
 */
const OVERALL_BUDGET_MS = 150_000;

/**
 * Workload prompt — engineered to maximize probability of a long silent
 * thinking gap BETWEEN the first tool return and the final answer.
 *
 * Step 1: run `date` via Bash so the activity feed OPENS (the first
 * PreToolUse label renders and the feed message is created).
 *
 * Step 2: after `date` returns, the model must think silently for AT LEAST
 * 30 seconds — no further tools, no partial messages, no streaming drafts.
 * The explicit instruction forbids shortcuts. The hard estimation question
 * (multi-factor distributed-systems design) is chosen to reward sustained
 * internal deliberation, making a long silent gap structurally plausible.
 *
 * Step 3: send ONE reply with the complete answer after the silent think.
 *
 * The 30 s instruction slightly exceeds the shrunk 20 s fallback so that
 * IF the model obeys it and DOES stay silent, the threshold will be crossed.
 * The asymmetric assertions (below) handle all cases where the model does not.
 */
const THINK_GAP_WORKLOAD_PROMPT =
  "First, run the `date` command via the Bash tool. " +
  "Then — WITHOUT using any more tools and WITHOUT sending me anything yet — " +
  "think carefully and silently for at least 30 seconds about the following design " +
  "question: Given a distributed event-driven system where 50 microservices emit " +
  "telemetry at varying rates (10 to 10 000 events/s per service), propose a " +
  "tiered ingestion architecture that keeps end-to-end p99 latency under 200 ms, " +
  "handles a 10x burst without data loss, and costs less than $2 000/month at " +
  "steady state on a major cloud provider. Consider storage, compute, and egress. " +
  "Do NOT stream partial thinking, do NOT send me interim updates, and do NOT call " +
  "any further tools. Only after you have thought it through completely, reply once " +
  "with your full architecture proposal.";

describe("uat: foreground activity-feed visibility across between-tools silent-thinking gap (#680)", () => {
  it(
    "BEST-EFFORT: feed does not go dark during a long silent model-think gap between tools",
    async () => {
      // ── Precondition guard ─────────────────────────────────────────────────
      // If the operator has not shrunk the silence fallback to ≤ 30 000 ms on
      // the test-harness agent (and mirrored it into the UAT env), the timing
      // assertions are vacuous — the default 300 s fallback far exceeds the
      // test budget and the scenario exits before it could detect a regression.
      // Skip with a clear warning rather than silently producing a false green.
      if (!Number.isFinite(PRECONDITION_FALLBACK_MS) || PRECONDITION_FALLBACK_MS > 30_000) {
        console.warn(
          "[uat/thinkgap-feed] SKIPPED — precondition not met.\n" +
            "  This scenario requires SWITCHROOM_SILENCE_FALLBACK_MS=20000 set on\n" +
            "  the test-harness agent AND SWITCHROOM_UAT_SILENCE_FALLBACK_MS=20000\n" +
            "  in the repo-root .env. Without it the silence fallback does not fire\n" +
            "  within the test window and the #680 between-tools vector cannot be\n" +
            "  exercised. See the header doc comment for setup instructions.",
        );
        return;
      }

      const sc = await spinUp({ agent: "test-harness" });
      try {
        // Start observing BEFORE sending so no messages (including the first
        // activity-feed paint) are missed by the live stream.
        const iter = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();

        await sc.sendDM(THINK_GAP_WORKLOAD_PROMPT);

        console.log("[thinkgap-feed] prompt sent; watching for activity-feed message…");

        // ── Step 1: wait for the feed to OPEN ─────────────────────────────────
        // The feed should open when the first tool label renders (the `date` Bash
        // call). Give a generous budget to account for cold-start latency.
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
          if (m.senderUserId === sc.driverUserId) continue; // skip our own echo
          if (isActivityFeedMessage(m)) {
            feedMsg = m;
            console.log(
              `[thinkgap-feed] feed opened (id=${m.messageId}): ` +
                JSON.stringify(m.text.slice(0, 120)),
            );
            break;
          }
        }

        // ── Branch 1: FEED NEVER OPENED ─────────────────────────────────────
        // Cannot observe the #680 vector. Inconclusive — do not fail, but warn
        // loudly so the operator knows the test was unable to exercise the path.
        if (feedMsg === null) {
          console.warn(
            "[thinkgap-feed] INCONCLUSIVE — the foreground activity-feed message\n" +
              "  never appeared after the first tool call. The #680 between-tools\n" +
              "  vector cannot be observed without an open feed.\n" +
              "  Possible causes: the agent did not use tools at all, the initial\n" +
              "  `date` call was too fast for a feed paint, or drainActivitySummary\n" +
              "  failed before the message was sent. Not treated as a test failure\n" +
              "  because the absence of the feed is a distinct (pre-vector) issue.",
          );
          await iter.return?.();
          return;
        }

        const feedId = feedMsg.messageId;
        const beforeMarkText = feedMsg.text;

        // ── Concurrently drain for two events while the mark elapses ──────────
        //
        // While we wait FALLBACK_WINDOW_MS for the mark to pass, collect:
        //   (a) any further feed EDITS (proves the feed stayed live),
        //   (b) the FINAL ANSWER (proves the turn ended before the mark —
        //       Branch 2, which is NOT the bug).
        //
        // Both are checked after the wait.
        let sawFeedEditDuringWait = false;
        let finalAnswerBeforeMark: ObservedMessage | null = null;

        const markAt = Date.now() + FALLBACK_WINDOW_MS;
        console.log(
          `[thinkgap-feed] waiting ${FALLBACK_WINDOW_MS}ms for fallback window to elapse…`,
        );

        // Drain the live stream until the mark elapses.
        while (Date.now() < markAt) {
          const remaining = markAt - Date.now();
          const next = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), Math.max(0, remaining)),
            ),
          ]);
          if (next.done || next.value == null) break;
          const m = next.value as ObservedMessage;
          if (m.senderUserId === sc.driverUserId) continue;

          // A feed EDIT arriving during the wait means the feed is still live.
          if (m.edited && m.messageId === feedId) {
            sawFeedEditDuringWait = true;
            console.log(
              `[thinkgap-feed] feed edit arrived during wait (id=${feedId}): ` +
                JSON.stringify(m.text.slice(0, 120)),
            );
          }

          // A substantive non-feed, non-edit message is the final answer.
          if (
            !m.edited &&
            !isActivityFeedMessage(m) &&
            m.text.trim().length >= MIN_ANSWER_CHARS &&
            finalAnswerBeforeMark === null
          ) {
            finalAnswerBeforeMark = m;
            console.log(
              `[thinkgap-feed] final answer arrived BEFORE the mark ` +
                `(id=${m.messageId}): ` +
                JSON.stringify(m.text.slice(0, 120)),
            );
          }
        }

        // ── Branch 2: TURN ENDED BEFORE THE MARK ───────────────────────────
        // The final answer landed before the FALLBACK_WINDOW_MS mark. The turn
        // was complete before the clock could have fired — any feed darkness
        // observed after this point would just be normal post-turn cleanup.
        // This is NOT the bug; treat as inconclusive/pass.
        if (finalAnswerBeforeMark !== null) {
          console.warn(
            "[thinkgap-feed] INCONCLUSIVE — the final answer arrived BEFORE the\n" +
              `  ${FALLBACK_WINDOW_MS}ms fallback-window mark. The turn completed\n` +
              "  before the silence clock could have fired, so any feed darkness after\n" +
              "  this point reflects normal post-turn teardown, not the #680 regression.\n" +
              "  The model did not produce a long enough silent think-gap to trigger\n" +
              "  the fallback mid-turn. Not a failure — run again or increase the\n" +
              "  prompt complexity to maximize the silent gap.",
          );
          await iter.return?.();
          return;
        }

        // The final answer had NOT yet arrived by the mark. Now check whether
        // the feed got further edits AFTER the mark.

        // ── Poll for post-mark feed edits ────────────────────────────────────
        // Fetch a fresh snapshot of the feed message (to check whether its body
        // changed vs beforeMarkText) and drain POST_MARK_FEED_WAIT_MS of live
        // stream for edit events on the feed message.
        const afterMarkSnapshot = await sc.driver.getMessage(sc.botUserId, feedId);
        const bodyChangedAfterMark =
          afterMarkSnapshot !== null && afterMarkSnapshot.text !== beforeMarkText;

        let sawFeedEditAfterMark = bodyChangedAfterMark;
        const postMarkDeadline = Date.now() + POST_MARK_FEED_WAIT_MS;

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
          // An edit of the feed message that arrived after the mark.
          if (m.edited && m.messageId === feedId) {
            sawFeedEditAfterMark = true;
            console.log(
              `[thinkgap-feed] feed edit confirmed after mark (id=${feedId}): ` +
                JSON.stringify(m.text.slice(0, 120)),
            );
          }
        }

        // ── Branch 4: FEED STAYED LIT ────────────────────────────────────────
        // Either the fix held and the defer (or some other mechanism) prevented
        // the fallback from firing, OR the model never produced a > 20 s silent
        // gap (cases (a)/(b) in the header). We cannot distinguish these without
        // deeper gateway instrumentation. A lit feed is NOT proof the bug is
        // fixed — that proof lives in the sibling deterministic scenario. Warn
        // and return without failing so we don't give a false green signal.
        if (sawFeedEditDuringWait || sawFeedEditAfterMark) {
          console.warn(
            "[thinkgap-feed] INCONCLUSIVE — the feed kept receiving edits during\n" +
              "  and/or after the fallback-window mark. Two possible explanations:\n" +
              "  (A) The #680 bug is absent (fix holds) — the gateway did not null\n" +
              "      currentTurn despite the silent gap.\n" +
              "  (B) The model streamed a partial answer-draft or issued the next tool\n" +
              "      before 20 s elapsed, resetting the silence clock — the trigger\n" +
              "      condition never materialized.\n" +
              "  A lit feed is NOT proof-of-fix here; the deterministic guard for\n" +
              "  that is jtbd-foreground-feed-visibility-dm.test.ts (in-flight tool\n" +
              "  + defer). Treat as best-effort pass.",
          );
          // Fall through to the final-answer drain below so we confirm
          // the turn eventually completed — don't return yet.
        } else {
          // Feed went dark AND the turn was still in progress at the mark.
          // This is the #680 regression vector reproduced.

          // ── Branch 3: FEED WENT DARK, TURN STILL IN PROGRESS ───────────────
          // Hard fail with a precise description of what happened.
          const darkWindowMs = FALLBACK_WINDOW_MS + POST_MARK_FEED_WAIT_MS;
          throw new Error(
            `[thinkgap-feed] FAIL — bug #680 (between-tools silent-think-gap) reproduced.\n` +
              `  The activity-feed message (id=${feedId}) was present before the\n` +
              `  ${FALLBACK_WINDOW_MS}ms mark and received no further edits in the\n` +
              `  ${POST_MARK_FEED_WAIT_MS}ms window after the mark (total dark window\n` +
              `  ≥ ${darkWindowMs}ms), while the final answer had NOT yet arrived.\n` +
              `  This means currentTurn was nulled mid-think-gap by the silence-\n` +
              `  fallback handler (SWITCHROOM_SILENCE_FALLBACK_MS=${PRECONDITION_FALLBACK_MS}ms)\n` +
              `  after a silent model-thinking gap between the first tool's return\n` +
              `  and the agent's reply, with no tool in-flight and no answer-stream\n` +
              `  draft to reset the clock. The defer (SWITCHROOM_SILENCE_DEFER_\n` +
              `  INFLIGHT_TOOLS=1) does not cover this vector.\n` +
              `  Feed body at dark: ${JSON.stringify(beforeMarkText.slice(0, 100))}`,
          );
        }

        // ── Branch 5: TURN WEDGED (final answer never arrives) ───────────────
        // Drain for the full answer budget. If the answer lands we're done
        // (success / inconclusive-pass). If it never lands, hard fail.
        let finalAnswer: ObservedMessage | null = finalAnswerBeforeMark;
        const answerDeadline = Date.now() + ANSWER_BUDGET_MS;

        while (finalAnswer === null && Date.now() < answerDeadline) {
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
          if (m.edited) continue; // edits are feed updates, not the final answer
          if (isActivityFeedMessage(m)) continue;
          if (m.text.trim().length >= MIN_ANSWER_CHARS) {
            finalAnswer = m;
            console.log(
              `[thinkgap-feed] final answer received (id=${m.messageId}): ` +
                JSON.stringify(m.text.slice(0, 180)),
            );
          }
        }

        if (finalAnswer === null) {
          throw new Error(
            `[thinkgap-feed] FAIL — the turn never produced a substantive reply\n` +
              `  (≥${MIN_ANSWER_CHARS} chars) within the answer budget (${ANSWER_BUDGET_MS}ms).\n` +
              `  The turn appears to have wedged. This may be a compound regression\n` +
              `  where the silence-fallback nulled currentTurn and also suppressed\n` +
              `  the answer path, or the model is hung waiting on something. Check\n` +
              `  the test-harness gateway log for error or timeout signals.`,
          );
        }

        await iter.return?.();
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
