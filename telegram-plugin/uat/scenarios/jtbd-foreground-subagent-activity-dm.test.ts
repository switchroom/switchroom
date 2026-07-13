/**
 * Foreground sub-agent live activity nesting (#2032) — UAT.
 *
 * Background (#2027): a FOREGROUND sub-agent (Agent/Task WITHOUT
 * run_in_background) runs INSIDE the parent turn, blocking it. Its live steps
 * were meant to nest into the parent's activity-summary feed (Model A). But
 * every render path bailed on `turn.replyCalled`, and the framework's
 * ack-first pattern replies "On it…" FIRST — so the sub-agent ran with
 * replyCalled already true and NOTHING ever painted. #2027 only tested the
 * pure renderer, so the regression shipped silently (the "marko's researcher
 * showed no Telegram activity" report). #2032 renders foreground progress
 * regardless of replyCalled.
 *
 * This scenario forces the exact broken shape end-to-end:
 *   1. Prompt the agent to send a quick ack FIRST (sets replyCalled=true),
 *   2. THEN dispatch a FOREGROUND sub-agent (run_in_background:false) that
 *      narrates ~10 paced steps so its jsonl keeps ticking under the
 *      test-harness 5s stall floor and the feed can paint + edit,
 *   3. then report done.
 *
 * Asserts the load-bearing proof: an activity-summary feed message appears
 * carrying the NESTED foreground marker ("↳") with the sub-agent's narration —
 * i.e. live foreground activity surfaced AFTER the ack. Pre-#2032 this message
 * never existed. Logs every observed body so a human can read the real UX.
 *
 * NOT a draft: the activity-summary feed is a real sendMessage/editMessageText
 * (gateway.ts drainActivitySummary), so mtcute can observe it — unlike the
 * answer-stream draft, which mtcute cannot see.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

// Same paced-narration discipline as jtbd-worker-activity-feed-dm: each step
// is its own Bash call with a one-line narration so the sub-agent emits a
// `sub_agent_text` line every ~2s — under SWITCHROOM_SUBAGENT_STALL_MS=5000,
// so the watcher never synth-terminates it mid-flight (which would suppress
// onProgress and the feed would never paint). run_in_background:false makes it
// FOREGROUND — the whole point.
const FG_DISPATCH_PROMPT =
  `First, immediately send me a one-line acknowledgement that you're starting ` +
  `(just "On it — running a check now."). Then use the Agent tool with ` +
  `subagent_type "general-purpose" and run_in_background: false (a FOREGROUND ` +
  `sub-agent) with this exact task: "Do eight steps, ONE AT A TIME, k = 1 ` +
  `through 8. Before each step write a brief one-sentence narration of what ` +
  `you are about to do, then run \`sleep 2\` via the Bash tool, then run ` +
  `\`echo step-k\` via the Bash tool (substitute the real number for k). Run ` +
  `every sleep and every echo as its OWN separate Bash call — never batch or ` +
  `chain them with && — and narrate before each so progress surfaces ` +
  `incrementally. Do not stop early; complete all eight steps, then return a ` +
  `one-line summary." Wait for the foreground sub-agent to finish, then send ` +
  `me a brief reply telling me it's done.`;

// The nested foreground block renders each child line prefixed with "↳"
// (NESTED_PREFIX = "   ↳ "), newest as a bold "→ …" current step. Telegram
// strips the bold but keeps the literal ↳ / → glyphs in message text.
const NESTED_RE = /↳/;

describe("uat: foreground sub-agent live activity nesting (#2032)", () => {
  it(
    "surfaces nested foreground activity in the feed AFTER the ack-first reply",
    async () => {
      // quiesceBeforeStart: wait for a prior scenario's background worker to
      // finish editing the shared chat before sending, for clean isolation.
      const sc = await spinUp({ agent: "test-harness", quiesceBeforeStart: true });
      try {
        await sc.sendDM(FG_DISPATCH_PROMPT);

        // Ack-first reply — establishes replyCalled=true BEFORE the
        // foreground sub-agent runs. This is the condition that broke #2027.
        const ack = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 60_000,
        });
        console.log(`[fg-activity UAT] ack-first reply: ${JSON.stringify(ack.text)}`);

        // The activity-summary feed carrying the NESTED foreground narrative.
        // First paint waits for the sub-agent to dispatch + narrate (~8s
        // first-paint throttle), so give it a generous window. Its presence
        // is the load-bearing proof of the fix: post-ack foreground activity.
        const feed = await sc.expectMessage(NESTED_RE, {
          from: "bot",
          timeout: 90_000,
        });
        console.log(
          `[fg-activity UAT] nested feed paint (id=${feed.messageId}): ${JSON.stringify(feed.text)}`,
        );
        expect(feed.messageId).toBeGreaterThan(0);
        expect(feed.text).toMatch(NESTED_RE);

        // Live edit: re-fetch the SAME message after the throttle + a few
        // sub-agent steps. Body should change as the nested narrative
        // advances — proving it's a live feed, not a one-shot post. Soft:
        // log either way; the nested-paint above is the load-bearing proof.
        const before = feed.text;
        await new Promise((r) => setTimeout(r, 10_000));
        const mid = await sc.driver.getMessage(sc.botUserId, feed.messageId);
        console.log(
          `[fg-activity UAT] same feed after 10s (id=${feed.messageId}): ${JSON.stringify(mid?.text ?? null)}`,
        );

        // Final answer — the parent resumes after the foreground sub-agent
        // returns and reports done. The feed hands off (clears) to this
        // answer. Confirms the turn completes cleanly, not wedged.
        const done = await sc.expectMessage(/done|complete|finished|step-8|wrapped/i, {
          from: "bot",
          timeout: 120_000,
        });
        console.log(`[fg-activity UAT] final answer: ${JSON.stringify(done.text)}`);
        expect(done.text.length).toBeGreaterThan(0);
        // Did the nested narrative actually move while in flight?
        if (mid?.text != null) {
          console.log(
            `[fg-activity UAT] body moved in-flight: ${mid.text !== before}`,
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    // Outer budget = worst-case quiesce-before-start (QUIESCE_MAX_MS ~360s,
    // normally ~15s) + the ~270s inner observation deadlines + slack. Quiesce
    // runs inside spinUp before the observation window, so the it() ceiling
    // must cover it.
    360_000 + 300_000,
  );
});
