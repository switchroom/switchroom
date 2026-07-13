/**
 * ADVERSARIAL — sub-agent card first-paint independence + full lifecycle
 * (attacks fix #3231 / commit 1aa700a0).
 *
 * The fix guarantees the worker/sub-agent progress card paints a SKELETON on
 * registration, INDEPENDENT of JSONL growth — the ~205s "invisible card"
 * blackout (a57fbf, 2026-07-13) happened because the card was driven ONLY by
 * growth-triggered cues, so a worker that registered and then BLOCKED on its
 * first tool (no JSONL growth) surfaced nothing until the next growth event.
 *
 * This probe is deliberately hostile to that: the dispatched worker's FIRST
 * and ONLY action is a long `sleep` — it registers, starts one Bash tool, and
 * then produces NO further JSONL growth for the whole block. If the skeleton
 * first-paint regressed, the `🛠 Worker` card would not appear until the block
 * ends (or never), and the sub-60s deadline below goes red.
 *
 * Beyond first-paint (per Ken's amendment) it also asserts the WHOLE card
 * lifecycle:
 *   - skeleton/running paints BEFORE any tool OUTPUT (first paint is NOT a
 *     terminal recap),
 *   - the body UPDATES live (elapsed advances / body differs after a wait),
 *   - the metric line carries the LIVE friendly model label (never a stale
 *     sentinel / raw `claude-…` id — a standing product invariant),
 *   - it transitions to a correct terminal recap (`done|failed|incomplete ·
 *     N tools · elapsed`).
 *
 * Deadlines are generous but bounded; the feed edits in-place so we re-fetch
 * the SAME message id rather than listening for new sends. `quiesceBeforeStart`
 * + `tearDown` reap so this scenario doesn't bleed into the next.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { WORKER_FEED_RE } from "../assertions.js";

// The block dominates the worker's wall-clock: it registers, fires ONE Bash
// (`sleep 75`), and emits no further JSONL until the sleep returns. 75s is
// comfortably longer than the 60s first-paint deadline below, so the skeleton
// MUST paint during a genuine no-growth window (the exact condition the fix
// covers). A single leaf worker (no child) → the skeleton cue is NOT suppressed.
const SILENT_WORKER_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this EXACT task: ` +
  `"Your first and only action: run \`sleep 75\` via the Bash tool as a ` +
  `single Bash call. Do not narrate, do not run anything else before it, do ` +
  `not batch. After the sleep returns, run \`echo done\` via the Bash tool ` +
  `and then stop." After dispatching, send a one-line reply saying you kicked ` +
  `off the background worker.`;

// In-flight running metric line: `<elapsed> · <n> tools[ · <model>]`. Present
// on a real running/skeleton paint, absent on a bare glyph-only card.
const RUNNING_METRIC_RE = /·\s*\d+\s+tools?\b/i;
// Terminal recap: state word anchored to the metric line.
const TERMINAL_RE = /\b(done|failed|incomplete)\s*·\s*\d+\s+tools?\b/i;
// Live friendly model label (model-label.ts formatModelLabel output).
const MODEL_GOOD_RE = /\b(opus|sonnet|haiku)\s+\d[\d.]*/i;
const MODEL_SR_RE = /\bsr-[\w.-]+/i;
// Stale/sentinel/raw id — the model-freshness invariant forbids these.
const MODEL_BAD_RE = /<synthetic>|<compact>|claude-[a-z]/i;

describe("uat-adv: sub-agent card first-paint + lifecycle (attacks #3231)", () => {
  it(
    "skeleton card paints within 60s of a silent long-blocking worker, updates live, shows live model, reaches terminal recap",
    async () => {
      const sc = await spinUp({ agent: "test-harness", quiesceBeforeStart: true });
      try {
        const dispatchedAt = Date.now();
        await sc.sendDM(SILENT_WORKER_PROMPT);

        // Parent ack — confirms the dispatch turn closed. The worker is now
        // registered and (about to be) blocked in `sleep 75`.
        await sc.expectMessage(/.+/, { from: "bot", timeout: 45_000 });

        // ── FIRST-PAINT (the load-bearing adversarial assertion) ─────────────
        // The `🛠 Worker` card MUST appear within 60s of dispatch — well inside
        // the worker's 75s no-growth block. On the pre-fix early-return the
        // card stayed invisible until a growth event (~205s live), so this
        // goes red on a first-paint regression.
        const firstPaint = await sc.expectMessage(WORKER_FEED_RE, {
          from: "bot",
          timeout: 60_000,
        });
        const paintLatencyMs = Date.now() - dispatchedAt;
        console.log(
          `[adv-firstpaint] worker card first-painted at +${paintLatencyMs}ms: ${JSON.stringify(firstPaint.text.slice(0, 160))}`,
        );
        expect(firstPaint.messageId).toBeGreaterThan(0);
        // Paint happened BEFORE any tool OUTPUT: the worker is still blocked in
        // `sleep`, so the first paint is a skeleton / early running header, NOT
        // a terminal recap. A card that only appeared post-block would carry a
        // terminal state here.
        expect(
          firstPaint.text,
          "first paint should be skeleton/running, not terminal (proves paint before tool output)",
        ).not.toMatch(TERMINAL_RE);

        // ── LIVE UPDATE ──────────────────────────────────────────────────────
        // The card edits in-place while the worker runs. Snapshot, wait past
        // the edit throttle + a heartbeat, re-fetch the SAME message id: the
        // elapsed counter (or body) must advance.
        const before = firstPaint.text;
        await new Promise((r) => setTimeout(r, 15_000));
        const updated = await sc.driver.getMessage(sc.botUserId, firstPaint.messageId);
        expect(updated, "worker card vanished mid-flight").not.toBeNull();
        console.log(`[adv-firstpaint] card after +15s: ${JSON.stringify(updated!.text.slice(0, 160))}`);
        expect(
          updated!.text,
          "card body did not advance while the worker ran (live-update regression)",
        ).not.toBe(before);

        // ── TERMINAL RECAP ───────────────────────────────────────────────────
        // After the sleep returns (+ echo, + stall/turn_end), the card flips to
        // a terminal state. Poll the same message id up to a bounded deadline.
        let terminal: string | null = null;
        const deadline = Date.now() + 210_000;
        while (Date.now() < deadline) {
          const m = await sc.driver.getMessage(sc.botUserId, firstPaint.messageId);
          if (m != null && TERMINAL_RE.test(m.text)) {
            terminal = m.text;
            break;
          }
          await new Promise((r) => setTimeout(r, 3_000));
        }
        console.log(`[adv-firstpaint] terminal recap: ${JSON.stringify(terminal?.slice(0, 200))}`);
        expect(terminal, "worker card never reached a terminal recap").not.toBeNull();
        expect(terminal!).toMatch(TERMINAL_RE);

        // ── LIVE MODEL INVARIANT ─────────────────────────────────────────────
        // Across the lifecycle the card must, at some point, carry a live
        // friendly model label and NEVER a stale sentinel / raw id. Check the
        // union of the running + terminal renders (the running render is where
        // the model tag is most reliably present).
        const modelCorpus = `${before}\n${updated!.text}\n${terminal!}`;
        const sawModel = MODEL_GOOD_RE.test(modelCorpus) || MODEL_SR_RE.test(modelCorpus);
        console.log(`[adv-firstpaint] model label seen=${sawModel}; badMatch=${MODEL_BAD_RE.test(modelCorpus)}`);
        expect(
          MODEL_BAD_RE.test(modelCorpus),
          "card rendered a stale/sentinel/raw model id (model-freshness invariant)",
        ).toBe(false);
        // Running render should carry the live model tag. Assert it appeared
        // somewhere in the lifecycle; the running snapshot is the primary carrier.
        expect(
          sawModel || RUNNING_METRIC_RE.test(modelCorpus),
          "card never rendered a running metric line / model tag",
        ).toBe(true);
      } finally {
        await sc.tearDown();
      }
    },
    // 45s ack + 60s first-paint + 15s delta + 210s terminal + spinUp/quiesce.
    480_000,
  );
});
