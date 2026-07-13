/**
 * Background sub-agent visibility scenario — closes #709 / #776 / #782 / #788
 * (the four-issue family analysed in `reference/rfcs/sub-agent-visibility.md`).
 *
 * Verifies three acceptance criteria from the RFC in a single run because
 * they share setup:
 *
 *   AC-1 — Background-dispatch-and-continue: worker-feed message appears
 *          while the background sub-agent runs; persists past parent
 *          `turn_end` so the user can watch the worker in flight.
 *   AC-2 — Done semantics: feed message reads `running ·` while the bg
 *          sub-agent runs; flips to `finished · completed` (or `failed`)
 *          after it terminates.
 *   AC-3 — Live activity: feed body materially changes across a 6s window
 *          while bg work is in flight (elapsed counter or narrative step
 *          advances) — proves the subagent-watcher is actually feeding the
 *          renderer.
 *
 * Prompt strategy: **Option 1 (explicit tool-naming)** per the RFC §
 * "Background-dispatch prompt". An earlier Option-2 (naturalistic)
 * attempt produced exactly the failure mode the RFC predicted —
 * model ran the sleeps inline via Bash, feed never reached Background
 * phase. This test verifies the *visibility infra*, not the LLM's
 * delegation judgment; pinning the tool name and arg keeps the
 * scenario deterministic.
 *
 * Architecture note (post-#1122 PR3): the pinned progress card was
 * deleted. Background sub-agent visibility is now surfaced via the
 * worker-activity-feed (`SWITCHROOM_WORKER_ACTIVITY_FEED=1`): a regular
 * Telegram message that posts once the worker has been running for
 * `firstPaintMin` (8s default on test-harness) and edits in-place as
 * activity arrives. This test drives assertions against that feed.
 *
 * Requires the same env as the other DM scenarios (see SETUP.md §6).
 *
 * Root causes fixed in #2501 (this PR):
 *   Bug 1 — orphan correlation. `backfillJsonlAgentId` used a fuzzy
 *           (agentType, description) match to link a newly-discovered JSONL
 *           to its registry row. When the match failed (description null,
 *           or race), `jsonl_agent_id` stayed NULL, so
 *           `resolveWorkerFeedDispatch(getSubagentByJsonlId(db, id), …)`
 *           returned `{ isBackground: false }` — routing the worker as a
 *           foreground sub-agent and suppressing the worker-feed. Fix:
 *           prefer the direct `toolUseId` PK lookup that Claude Code already
 *           writes to `agent-<id>.meta.json`.
 *   Bug 2 — liveness writes silently skipped. With `jsonl_agent_id = NULL`
 *           (Bug 1 not fixed), `bumpSubagentActivity` queries by
 *           `jsonl_agent_id` and finds nothing — every liveness tick is a
 *           no-op and the last_activity_at column never updates. Fixed as a
 *           consequence of Bug 1 (once the row is linked, liveness writes
 *           land).
 *
 * Runtime budget is generous — the inner deadlines sum to ~225s
 * worst-case (45s parent-ack + 75s feed-first-paint + 12s delta + 180s
 * done) plus ~12s spinUp overhead. The outer `it()` timeout absorbs the lot.
 * The 180s done-window accommodates the stall-detection path: the watcher
 * fires `onFinish` 60s after the last JSONL event, because background
 * workers don't reliably emit `sub_agent_turn_end`.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { WORKER_FEED_RE } from "../assertions.js";

// Explicit dispatch prompt (Option 1 per the RFC §"Background-dispatch
// prompt"). The naturalistic Option-2 version didn't reliably get the
// model to use the Agent tool with run_in_background:true — first
// attempt produced the failure mode the RFC predicted (parent ran the
// sleeps inline via Bash; feed never surfaced Background-phase activity).
//
// This test asserts the VISIBILITY INFRA works, not that the model
// makes good delegation judgments. Naming the tool + the arg lets the
// scenario be deterministic.
//
// Time profile: paced with FIVE short steps so the worker emits multiple
// tool_use + narrative events the subagent-watcher can surface as fresh
// edits, while BOUNDING the worker's wall-clock duration. Each step is a
// model round-trip (narrate + two separate Bash calls), so under real fleet
// LLM latency a step costs ~30s regardless of the 2s sleep — ten steps ran
// ~5min in practice, which both blew the terminal-recap budget and left the
// worker editing the shared chat long after this scenario (bleeding into the
// next). Five steps bounds the worst case to ~210s (5 × ~30s + 60s stall
// terminal) — still long enough to clear the 8s first-paint threshold and
// snapshot mid-flight, but short enough to fit the 18-min CI job cap and to
// finish within this scenario's own window (no cross-scenario bleed).
const BG_DISPATCH_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this exact task: ` +
  `"Do five steps, ONE AT A TIME, k = 1 through 5. Before each step ` +
  `write a brief one-sentence narration of what you are about to do, ` +
  `then run \`sleep 2\` via the Bash tool, then run \`echo step-k\` via ` +
  `the Bash tool (substitute the real number for k). Run every sleep and ` +
  `every echo as its OWN separate Bash call — never batch or chain them ` +
  `with && — and narrate before each so progress surfaces incrementally. ` +
  `Do not stop early; complete all five steps." After dispatching, send a ` +
  `brief reply saying you've kicked off the background worker so I can ` +
  `watch the progress feed.`;

// In-flight signal. The single-worker running header shows NO literal
// "running" — it renders `<elapsed> · <n> tools` (tool-activity-summary.ts
// renderActivityHeader, running branch); the multi-worker combined header
// shows `N running`. Match BOTH shapes. Paired with the `not.toMatch(
// WORKER_DONE_RE)` exclusion on the next line and the empty/`starting…`
// skeleton case, this still goes red on the real bug (a skeleton painting
// only `🛠 Worker · <name>` with no live metric line).
const WORKER_RUNNING_RE = /\brunning\b|·\s*\d+\s+tools?\b/i;
// Terminal recap. The done/failed/incomplete header renders the STATE WORD
// followed by `· <n> tools · <elapsed>` (tool-activity-summary.ts:199) —
// e.g. `done · 20 tools · 5m38s`. It never emits the literal "finished ·
// completed". Match the terminal state word anchored to the metric line so
// a running header (`<elapsed> · <n> tools`, no leading state word) and a
// bare skeleton still fail this — line 124 keeps using it as the in-flight
// exclusion, line 172 as the terminal gate.
const WORKER_DONE_RE = /\b(done|failed|incomplete)\s*·\s*\d+\s+tools?\b/i;

describe("uat: background sub-agent visibility (#709/#776/#782/#788)", () => {
  it(
    "worker-feed appears with running status then flips to finished once the sub-agent completes",
    async () => {
      // quiesceBeforeStart: wait for the shared bot DM chat to be idle (a
      // prior scenario's background worker finished) before sending, so this
      // scenario runs against an unsaturated agent.
      const sc = await spinUp({ agent: "test-harness", quiesceBeforeStart: true });
      try {
        await sc.sendDM(BG_DISPATCH_PROMPT);

        // Parent ack reply — confirms the parent turn closed.
        await sc.expectMessage(/.+/, { from: "bot", timeout: 45_000 });

        // AC-1 step 1: worker-feed message appears after first-paint delay
        // (~8s default). The message starts with "🛠 Worker" and shows
        // "running ·" while the worker is in flight. Generous timeout so a
        // slow first tool_use + narrative doesn't false-flag.
        //
        // Distinct from the parent's ack — `expectMessage` starts observing
        // from after the parent ack, so the feed paint is the next match.
        const feed = await sc.expectMessage(WORKER_FEED_RE, {
          from: "bot",
          timeout: 75_000,
        });
        expect(feed.messageId).toBeGreaterThan(0);
        expect(feed.text).toMatch(WORKER_FEED_RE);

        // AC-2 step 1: feed body MUST show "running ·" (the in-flight
        // status), NOT the terminal "finished ·" — the worker hasn't
        // completed yet.
        expect(feed.text).toMatch(WORKER_RUNNING_RE);
        expect(feed.text).not.toMatch(WORKER_DONE_RE);

        // AC-3: feed edits land regularly while the worker runs. Snapshot
        // the current body, wait 12s (well above the 2.5s edit throttle,
        // and enough that at least one step + sleep cycle completes), then
        // re-fetch the SAME message. The body MUST differ (elapsed counter
        // or narrative step advances).
        //
        // We re-fetch the SAME message via `driver.getMessage(chatId,
        // msgId)` rather than `expectMessage(WORKER_FEED_RE)` because the
        // latter listens for NEW messages. The feed edits in-place; a new
        // send only happens on re-post (stale messageId). So re-fetching is
        // the right shape.
        //
        // 12s instead of 6s: the first edit arrives ~6-8s after paint (one
        // step/sleep cycle), so 6s was racy. 12s gives a safe 2x margin.
        const beforeDelta = feed.text;
        await new Promise((r) => setTimeout(r, 12_000));
        const afterDeltaMsg = await sc.driver.getMessage(
          sc.botUserId,
          feed.messageId,
        );
        expect(afterDeltaMsg, "feed message disappeared mid-flight (AC-1 regression)").not.toBeNull();
        expect(afterDeltaMsg!.text).not.toBe(beforeDelta);

        // AC-2 closing half: bg terminates → body flips to the terminal
        // state header ("done · N tools · <elapsed>"). The terminal edit is
        // triggered by the subagent-watcher's stall detection (60s after the
        // last JSONL activity), because background Claude Code workers don't
        // always emit a sub_agent_turn_end event.
        //
        // Budget: with the worker bounded to five steps (~150s wall under
        // fleet latency) plus the stall-terminal firing ~60s after the last
        // JSONL activity, the terminal recap lands by ~210s. 270s covers that
        // with margin while keeping the whole scenario inside the 18-min CI
        // job cap. A feed that never terminates still fails this assertion.
        let doneText: string | null = null;
        const deadline = Date.now() + 270_000;
        while (Date.now() < deadline) {
          const m = await sc.driver.getMessage(sc.botUserId, feed.messageId);
          if (m != null && WORKER_DONE_RE.test(m.text)) {
            doneText = m.text;
            break;
          }
          await new Promise((r) => setTimeout(r, 3_000));
        }
        expect(doneText, "worker-feed never reached a terminal recap").not.toBeNull();
        expect(doneText!).toMatch(/tools?/i);
        // Body MUST have changed between first paint and terminal.
        expect(doneText).not.toBe(beforeDelta);
      } finally {
        await sc.tearDown();
      }
    },
    // Outer per-test budget: sum of inner deadlines (45 + 75 + 16 + 270 =
    // 406s) + spinUp settle (~12s) + quiesce-before-start (bg runs first so
    // the chat is normally already quiet; capped at QUIESCE_MAX_MS) + slack.
    510_000,
  );
});
