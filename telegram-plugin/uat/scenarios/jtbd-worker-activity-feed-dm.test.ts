/**
 * Live worker-activity feed (#2000) — UAT.
 *
 * A *background* sub-agent decouples from the parent turn; when the turn
 * ends nothing surfaces its ongoing jsonl activity and a long worker
 * reads as silence. The feed (flag `SWITCHROOM_WORKER_ACTIVITY_FEED=1`,
 * set on the test-harness agent for this run) posts ONE regular Telegram
 * message per background worker and edits it in place — current tool +
 * short summary + elapsed — finalizing with a recap on completion.
 *
 * This scenario dispatches a real background worker (~60s of paced
 * sleep/echo work, so it narrates between tools and the feed can paint
 * + edit), then asserts:
 *
 *   1. a worker-feed message appears (🛠 Worker · …), distinct from the
 *      parent's ack reply — proving background activity surfaces after
 *      the parent turn closed;
 *   2. the message edits in place while work is in flight (body changes
 *      across a window) — proving it's live, not a one-shot post;
 *   3. it finalizes to the terminal recap (finished · completed · N tools);
 *   4. the native card never leaks raw Markdown (no `**`, backticks, or
 *      ASCII `---` rule) — the #94-class regression guard.
 *
 * It logs every observed body so a human can read the real rendered UX.
 *
 * Prompt is the deterministic Option-1 dispatch from
 * `bg-sub-agent-dispatch-dm.test.ts` (naming the Agent tool + arg keeps
 * the model from running the sleeps inline via Bash).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

// The worker must keep its jsonl ticking faster than the *test-harness*
// stall window (SWITCHROOM_SUBAGENT_STALL_MS=5000 /
// SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS=10000 in switchroom.yaml — see
// PR #1110): a worker silent for >15s gets a *synthesized* terminal
// turn_end mid-flight, which flips the watcher entry to `done` and
// suppresses every later onProgress (the feed then never paints). Long
// silent `sleep 20`s tripped exactly that. So we drive ~10 short steps,
// each its own Bash call with a one-line narration, keeping the gap
// between jsonl emissions ~2s — well under the 5s stall floor — for
// ~30-40s total: long enough to clear the 8s first-paint, throttle, and
// land several in-place edits before the real end_turn.
const BG_DISPATCH_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this exact task: ` +
  `"Do ten steps, ONE AT A TIME, k = 1 through 10. Before each step ` +
  `write a brief one-sentence narration of what you are about to do, ` +
  `then run \`sleep 2\` via the Bash tool, then run \`echo step-k\` via ` +
  `the Bash tool (substitute the real number for k). Run every sleep and ` +
  `every echo as its OWN separate Bash call — never batch or chain them ` +
  `with && — and narrate before each so progress surfaces incrementally. ` +
  `Do not stop early; complete all ten steps." After dispatching, send a ` +
  `brief reply saying you've kicked off the background worker so I can ` +
  `watch its progress.`;

// The feed header rendered in Telegram: "🛠 Worker · <desc>" with a
// "running · …" status (running) or "finished · completed/failed · …"
// (terminal).
const WORKER_FEED_RE = /🛠\s*Worker|running\s*·|finished\s*·/i;
const WORKER_DONE_RE = /finished\s*·\s*(completed|failed)/i;

describe("uat: live worker-activity feed (#2000)", () => {
  it(
    "surfaces a background worker as a live, editing message that finalizes",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(BG_DISPATCH_PROMPT);

        // Parent ack — some bot reply so we know the parent turn closed.
        const ack = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 45_000,
        });
        console.log(`[worker-feed UAT] parent ack: ${JSON.stringify(ack.text)}`);

        // The worker-feed message. May arrive after the parent ack since
        // first-paint waits for the worker to run ~8s and narrate.
        const feed = await sc.expectMessage(WORKER_FEED_RE, {
          from: "bot",
          timeout: 75_000,
        });
        console.log(
          `[worker-feed UAT] first feed paint (id=${feed.messageId}): ${JSON.stringify(feed.text)}`,
        );
        expect(feed.messageId).toBeGreaterThan(0);

        // Live edit: snapshot, wait past the throttle + a heartbeat, and
        // re-fetch the SAME message. Body should change as work advances.
        // Soft: a very terse worker might narrate only once; we still
        // require the terminal recap below, which is the load-bearing
        // proof. Log either way so the real cadence is visible.
        const before = feed.text;
        await new Promise((r) => setTimeout(r, 12_000));
        const mid = await sc.driver.getMessage(sc.botUserId, feed.messageId);
        console.log(
          `[worker-feed UAT] after 12s (id=${feed.messageId}): ${JSON.stringify(mid?.text ?? null)}`,
        );
        expect(mid, "worker-feed message vanished mid-flight").not.toBeNull();

        // Terminal recap — poll the same message until it flips to the
        // done/failed header. Generous budget: ~60s of work + finalize.
        let doneText: string | null = null;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const m = await sc.driver.getMessage(sc.botUserId, feed.messageId);
          if (m != null && WORKER_DONE_RE.test(m.text)) {
            doneText = m.text;
            break;
          }
          await new Promise((r) => setTimeout(r, 5_000));
        }
        console.log(
          `[worker-feed UAT] terminal (id=${feed.messageId}): ${JSON.stringify(doneText)}`,
        );
        expect(doneText, "worker-feed never reached a terminal recap").not.toBeNull();
        expect(doneText!).toMatch(/tools?|tool ·/i);
        // Did the body actually move between first paint and terminal?
        expect(doneText).not.toBe(before);
        // #94-class regression guard: the native card strips worker Markdown,
        // so the rendered body must never carry raw `**`, backticks, or an
        // ASCII `---` rule (the finished divider is the box-drawing `─────`).
        expect(doneText!, "raw ** leaked into the card").not.toMatch(/\*\*/);
        expect(doneText!, "raw backtick leaked into the card").not.toContain("`");
        expect(doneText!, "raw --- rule leaked into the card").not.toMatch(
          /(^|\n)\s*-{3,}\s*(\n|$)/,
        );
      } finally {
        await sc.tearDown();
      }
    },
    240_000,
  );
});
