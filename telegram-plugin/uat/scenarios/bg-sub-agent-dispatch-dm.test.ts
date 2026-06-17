/**
 * Background sub-agent visibility scenario — closes #709 / #776 / #782 / #788
 * (the four-issue family analysed in `reference/rfcs/sub-agent-visibility.md`).
 *
 * Verifies three acceptance criteria from the RFC in a single run because
 * they share setup:
 *
 *   AC-1 — Background-dispatch-and-continue: card stays pinned past
 *          parent `turn_end`; fleet zone surfaces the running sub-agent.
 *   AC-2 — Done semantics: header reads 🌀 Background (not ✅ Done)
 *          while the bg sub-agent runs; flips to ✅ Done after it
 *          terminates.
 *   AC-3 — Live activity: card body materially changes across a 15s
 *          window while bg work is in flight (elapsed counter or fleet
 *          row's `last activity` advances) — proves the heartbeat +
 *          subagent-watcher are actually feeding the renderer.
 *
 * Prompt strategy: **Option 1 (explicit tool-naming)** per the RFC §
 * "Background-dispatch prompt". An earlier Option-2 (naturalistic)
 * attempt produced exactly the failure mode the RFC predicted —
 * model ran the sleeps inline via Bash, card never reached Background
 * phase. This test verifies the *visibility infra*, not the LLM's
 * delegation judgment; pinning the tool name and arg keeps the
 * scenario deterministic.
 *
 * Requires the same env as the other DM scenarios (see SETUP.md §6)
 * and the test-harness override `progress_card.delay_ms: 1000` so the
 * card actually fires on a short turn (SETUP.md §5).
 *
 * Runtime budget is generous — the inner deadlines sum to ~150s
 * worst-case (5s pin + 30s parent-ack + 30s background phase + 15s
 * delta-snapshot + 120s done) plus ~12s spinUp overhead. The outer
 * `it()` timeout absorbs the lot.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

// Explicit dispatch prompt (Option 1 per the RFC §"Background-dispatch
// prompt"). The naturalistic Option-2 version didn't reliably get the
// model to use the Agent tool with run_in_background:true — first
// attempt produced the failure mode the RFC predicted (parent ran the
// sleeps inline via Bash; card never transitioned to Background).
//
// This test asserts the VISIBILITY INFRA works, not that the model
// makes good delegation judgments. Naming the tool + the arg lets the
// scenario be deterministic. If the model can't be made to use the
// Agent tool even with this prompt, that's an unrelated bug (model
// alignment / tool registration) and the scenario fails distinctly
// from the visibility-infra failure modes we're trying to catch.
//
// Time profile: ~60s of bg work, paced with three separate sleeps so
// the worker emits multiple tool_use events the subagent-watcher can
// surface as fresh `last activity` updates. We need the Background
// phase to last long enough that we can take a snapshot, wait one
// heartbeat tick (5s default), and snapshot again.
const BG_DISPATCH_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this exact task: ` +
  `"Run \`sleep 20\` via the Bash tool, then \`echo step1\`, then ` +
  `\`sleep 20\` again, then \`echo step2\`, then \`sleep 20\` a third ` +
  `time, then \`echo done\`. That's three separate Bash tool calls ` +
  `with sleeps between echoes." After dispatching, send a brief reply ` +
  `saying you've kicked off the background worker so I can watch the ` +
  `progress card.`;

/**
 * STATUS: currently red — surfaces two real production bugs the
 * RFC §Risks predicted as possible-but-unverified. Marked `it.fails`
 * so a future fix flips it green and a regression flips it red again.
 *
 *   Bug 1 — orphan correlation. The parent's `Agent` tool_use_id
 *           doesn't get matched to the spawned `sub_agent_started`
 *           event. Gateway log: `pendingSpawns=0 correlated=orphan`.
 *           Result: `isBackgroundDispatch` is never set on the fleet
 *           member; the card's header phase transitions to Background
 *           only by accident (orphans defer too, but they don't carry
 *           the bg flag).
 *
 *   Bug 2 — subagent-watcher can't track the worker. Gateway log:
 *           `subagent-watcher: liveness skip <agentId> — row not in
 *           DB yet (Phase 2 Pre hook pending)`. Result: no
 *           sub_agent_tool_use events reach the fleet member; the
 *           fleet row's `last activity` field never updates with the
 *           worker's actual tool calls. The card edits we see are
 *           just elapsed-counter ticks from the heartbeat.
 *
 * Both bugs are real and live on `main`. The scenario above passes
 * AC-1 (card stays pinned), partially passes AC-2 (Background phase
 * fires) and AC-3 (card body changes — from heartbeat alone), and
 * fails AC-2's closing half (card never reaches Done in 120s because
 * the orphan never terminates from the gateway's view).
 *
 * When Bug 1 + Bug 2 are fixed, change `describe.skip` to `describe`
 * below — the assertions are correct; only the production code is
 * wrong.
 *
 * Update post-#1105: all five RFC bugs (1–5 in earlier PRs, 6–7 in
 * #1105) merged. Unskipped here for the next UAT re-run. If 6/6 ACs
 * pass, close #709 / #776 / #782 / #788.
 */
describe("uat: background sub-agent visibility (#709/#776/#782/#788)", () => {
  it(
    "card stays pinned with 🌀 Background header + live fleet activity, then flips to ✅ Done",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(BG_DISPATCH_PROMPT);

        // AC-1 step 1: card pins quickly (delay_ms: 1000 on test-harness).
        // Generous timeout so a slow first-turn doesn't false-flag.
        const card = await sc.expectPinnedCard({ timeout: 15_000 });
        expect(card.messageId).toBeGreaterThan(0);

        // Parent ack reply. Note: we DON'T strictly require the model
        // to mention "dispatch" in the reply — naturalistic prompt means
        // the model picks the wording. We just need *some* bot reply
        // so we know the parent turn closed (which is the point where
        // pre-fix the card would unpin).
        await sc.expectMessage(/.+/, { from: "bot", timeout: 30_000 });

        // AC-2: header MUST be 🌀 Background (post-#1039) or, if the
        // bg dispatch happened so fast the worker hasn't started yet,
        // it might still be ⚙️ Working with the parent zone done. We
        // poll for the background phase with a 45s budget — long
        // enough for the worker to actually start firing tools, short
        // enough that "we never saw Background" surfaces as a real
        // bug, not a timeout-tuning issue.
        //
        // The dual-acceptable phases below model the realistic flow:
        // parent reply lands → header should be Background (or
        // briefly still Working if the parent's `done` event lags
        // the bg dispatch's tool_use).
        const bgPhaseCard = await sc.waitForCardPhase(card, "background", {
          timeout: 45_000,
        });
        expect(bgPhaseCard.text).toMatch(/🌀|Background/i);
        // The negative — Done MUST NOT have fired before bg started.
        // Asserts the defer-gate is doing its job. If this trips, the
        // `hasLiveBackground` correlation at progress-card-driver.ts:1108
        // is broken (or the bg dispatch never registered as a fleet
        // member at all — see RFC §Phase 2 diagnosis paths).
        expect(bgPhaseCard.text).not.toMatch(/✅|\bDone\b/i);

        // AC-3: card edits land regularly while bg runs. Snapshot
        // the current card body, wait one heartbeat tick (5s default
        // + 1s slack), then fetch the card body again. The body MUST
        // differ (elapsed counter, fleet last-activity age, etc.).
        //
        // We re-fetch the SAME message via `driver.getMessage(chatId,
        // cardId)` rather than `expectPinnedCard` because the latter
        // listens for NEW pin events. Once the card is pinned, no
        // further pin event fires — `expectPinnedCard` would wait
        // for an event that never comes and time out spuriously even
        // though the card is alive and being edited (caught in the
        // first run of this scenario).
        //
        // If the card freezes — heartbeat dead, subagent-watcher not
        // flushing, fleet member never registered — `afterDelta` will
        // equal `beforeDelta` and surface the bug cleanly. If the
        // card was unpinned by an over-eager defer-gate release,
        // `getMessage` returns null and we surface it with a clear
        // assertion.
        const beforeDelta = bgPhaseCard.text;
        await new Promise((r) => setTimeout(r, 6_000));
        const afterDeltaMsg = await sc.driver.getMessage(
          sc.botUserId,
          bgPhaseCard.messageId,
        );
        expect(afterDeltaMsg, "card message disappeared mid-flight (AC-1 regression)").not.toBeNull();
        expect(afterDeltaMsg!.text).not.toBe(beforeDelta);

        // AC-2 closing half: bg terminates → header flips to ✅ Done.
        // Generous budget — the inner sleeps sum to ~60s but
        // post-completion the deferred-completion gate plus the
        // heartbeat cadence can add another 5-30s before the card
        // finalises.
        const doneCard = await sc.waitForCardPhase(bgPhaseCard, "done", {
          timeout: 120_000,
        });
        expect(doneCard.text).toMatch(/✅|Done/i);
      } finally {
        await sc.tearDown();
      }
    },
    // Outer per-test budget: sum of inner deadlines (15 + 30 + 45 + 15 +
    // 10 + 120 = 235s) + spinUp settle (~12s) + slack. Round up to keep
    // the inner-deadline error visible if any of them trip.
    300_000,
  );
});
