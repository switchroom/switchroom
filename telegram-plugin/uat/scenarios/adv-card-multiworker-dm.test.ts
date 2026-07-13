/**
 * ADVERSARIAL — combined multi-worker header (attacks the card-lifecycle
 * surface guaranteed alongside fix #3231 / commit 1aa700a0).
 *
 * When several workers run at once the feed renders ONE combined body headed
 * `🛠 Workers · N running` (renderCombinedWorkerFeed, tool-activity-summary.ts).
 * This probe dispatches THREE background workers in a single turn and asserts:
 *   - the combined `Workers · N running` header paints (N ≥ 2) — proving every
 *     concurrently-registered worker is accounted for, not just the first,
 *   - the render carries a live friendly model label and never a stale sentinel
 *     / raw id (model-freshness invariant on the combined surface).
 *
 * The workers each do a short paced sleep so all three overlap in a running
 * window long enough for the combined header to paint. Bounded deadlines; reap
 * in teardown.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

// Three overlapping leaf workers. Each: narrate, sleep 3, echo, sleep 3, echo —
// ~2 model round-trips of overlap so the combined header has a running window.
const MULTIWORKER_PROMPT =
  `Dispatch THREE separate background workers, all in THIS turn, using the ` +
  `Agent tool with subagent_type "general-purpose" and run_in_background: ` +
  `true — one call per worker, do not wait for one before dispatching the ` +
  `next. Give EACH worker this EXACT task: "Do two steps: run \`sleep 3\` ` +
  `via the Bash tool, then \`echo a\` via the Bash tool, then \`sleep 3\` ` +
  `via the Bash tool, then \`echo b\` via the Bash tool. Each as its own ` +
  `Bash call; do not batch." After dispatching all three, send a one-line ` +
  `reply saying you launched three workers.`;

// Combined header: `🛠 **Workers** · _N running_` → Telegram-stripped to
// `🛠 Workers · N running`.
const COMBINED_HEADER_RE = /🛠[️]?\s*Workers\b[\s\S]*?\b(\d+)\s+running\b/i;
const MODEL_GOOD_RE = /\b(opus|sonnet|haiku)\s+\d[\d.]*/i;
const MODEL_SR_RE = /\bsr-[\w.-]+/i;
const MODEL_BAD_RE = /<synthetic>|<compact>|claude-[a-z]/i;

describe("uat-adv: combined multi-worker header (attacks #3231 surface)", () => {
  it(
    "renders 'Workers · N running' (N>=2) with a live model label when several workers run at once",
    async () => {
      const sc = await spinUp({ agent: "test-harness", quiesceBeforeStart: true });
      try {
        await sc.sendDM(MULTIWORKER_PROMPT);

        // Parent ack.
        await sc.expectMessage(/.+/, { from: "bot", timeout: 45_000 });

        // Wait for the combined header. With three workers dispatched, the feed
        // should combine them into one body. A single-worker-only render (N<2)
        // would mean concurrent workers were dropped from the surface.
        const combined = await sc.expectMessage(COMBINED_HEADER_RE, {
          from: "bot",
          timeout: 120_000,
        });
        console.log(`[adv-multiworker] combined header: ${JSON.stringify(combined.text.slice(0, 240))}`);
        const m = combined.text.match(COMBINED_HEADER_RE);
        expect(m, "combined worker header did not render").not.toBeNull();
        const runningCount = Number.parseInt(m![1], 10);
        console.log(`[adv-multiworker] running count in header = ${runningCount}`);
        expect(
          runningCount,
          "combined header should show >=2 running workers when three were dispatched",
        ).toBeGreaterThanOrEqual(2);

        // Model-freshness on the combined surface.
        expect(
          MODEL_BAD_RE.test(combined.text),
          "combined feed rendered a stale/sentinel/raw model id",
        ).toBe(false);
        const sawModel = MODEL_GOOD_RE.test(combined.text) || MODEL_SR_RE.test(combined.text);
        console.log(`[adv-multiworker] model label present in combined render=${sawModel}`);
        // The combined per-worker rows carry the model tag; assert at least one
        // live friendly label is present.
        expect(sawModel, "combined feed never rendered a live friendly model label").toBe(true);
      } finally {
        await sc.tearDown();
      }
    },
    240_000,
  );
});
</content>
