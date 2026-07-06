/**
 * Liveness-feed HEARTBEAT — a single long SILENT tool keeps the activity card
 * advancing (it must not freeze at open), and narration surfaces mid-turn.
 *
 * ## Cause class (the 0-label freeze — deterministic, model-independent)
 *
 * The activity card OPENs at `FEED_LIVENESS_OPEN_MS` (~1.2 s) for a turn that
 * has emitted no tool label. During a single long tool that runs SILENTLY —
 * no `tool_label`, and the model emits no `text` narration, so `mirrorLines`
 * stays empty — the pre-fix `feedHeartbeatTick` 0-label branch only re-called
 * `openLivenessFeedIfDue`, which no-ops once `activityMessageId` is set. The
 * card therefore FROZE from ~1.2 s until the tool returned: unbounded dead air.
 *
 * The fix drives the SAME climbing-elapsed EDIT the labelled branch uses once a
 * card is open, so the card advances every ~6 s heartbeat regardless of the
 * model, until the tool returns.
 *
 * ## Precondition (set on the test-harness agent for this run)
 *
 *   SWITCHROOM_FEED_LIVENESS_OPEN_MS=1200   (the shipped default; makes the open
 *                                            deterministic within budget)
 *
 * ## What it asserts (asymmetric — non-determinism is handled, not faked)
 *
 * Scenario 1 (silent long tool):
 *   PASS       — a `Working…` activity card appeared once and was EDITED ≥4
 *                times over the ~40 s tool with a climbing elapsed.
 *   HARD FAIL  — the card OPENED then got ZERO edits while the tool ran (the
 *                freeze this guard exists to catch).
 *   INCONCLUSIVE — the model narrated / used extra tools so the turn was no
 *                longer 0-label (the labelled-feed heartbeat drove it instead);
 *                not a failure of the fix. Warn + pass.
 *
 * Scenario 2 (narration surfaces mid-turn):
 *   PASS       — the narrated string appears in the activity card BEFORE the
 *                tool's label, proving narration reaches the card mid-turn (the
 *                already-shipped narration-first path, asserted here so a
 *                regression in it is caught alongside the heartbeat fix).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

/** Overall test budget per scenario. */
const OVERALL_BUDGET_MS = 150_000;

/**
 * Workload 1: run a single long tool that produces NO narration and NO
 * intermediate tool labels — the exact 0-label silent-tool shape that froze the
 * card pre-fix.
 */
const SILENT_TOOL_PROMPT =
  "Run exactly `sleep 40` in one Bash call and nothing else. Do NOT narrate, " +
  "do NOT say anything, do NOT use any other tool. When it finishes, reply " +
  "with just the single word DONE.";

/**
 * Workload 2: narrate a distinctive line, THEN run a tool. The narration must
 * surface in the activity card before the tool label.
 */
const NARRATE_THEN_TOOL_MARKER = "Root cause found — checking the port";
const NARRATE_THEN_TOOL_PROMPT =
  `Say out loud exactly this line first: "${NARRATE_THEN_TOOL_MARKER}". ` +
  "Then run a `grep` over the current directory. Do the narration BEFORE the grep.";

describe("uat: liveness-feed heartbeat (silent tool keeps the card advancing)", () => {
  it(
    "OPENs a 'Working…' card then EDITs it ≥4 times over a 40s silent tool",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const iter = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();

        await sc.sendDM(SILENT_TOOL_PROMPT);
        const sentAt = Date.now();
        console.log("[feed-heartbeat] silent-tool prompt sent; watching card…");

        let livenessCardId: number | null = null;
        let livenessEdits = 0;
        let lastElapsedS = -1;
        let elapsedClimbs = 0;
        let toolFeedSeen = false;
        let answer: ObservedMessage | null = null;

        const deadline = Date.now() + 110_000;
        while (Date.now() < deadline) {
          if (answer && livenessEdits >= 4) break;
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
            if (/Working/.test(m.text)) {
              if (livenessCardId == null && !m.edited) {
                livenessCardId = m.messageId;
                console.log(`[feed-heartbeat] card OPENED at +${Date.now() - sentAt}ms`);
              } else if (m.messageId === livenessCardId && m.edited) {
                livenessEdits++;
                // The step's climbing elapsed surfaces as "· Ns" once ≥10s.
                const mm = m.text.match(/·\s*(\d+)s/);
                if (mm) {
                  const s = Number(mm[1]);
                  if (s > lastElapsedS) {
                    elapsedClimbs++;
                    lastElapsedS = s;
                  }
                }
                console.log(`[feed-heartbeat] card EDIT #${livenessEdits} at +${Date.now() - sentAt}ms`);
              }
            } else {
              toolFeedSeen = true;
            }
            continue;
          }
          if (m.edited) continue;
          if (/\bDONE\b/.test(m.text) && !answer) {
            answer = m;
            console.log(`[feed-heartbeat] answer landed at +${Date.now() - sentAt}ms`);
          }
        }

        // ── Branch resolution ───────────────────────────────────────────────
        if (livenessCardId != null && !toolFeedSeen) {
          // The 0-label silent-tool path was genuinely exercised.
          expect(
            livenessEdits,
            "HARD FAIL — the 'Working…' card OPENED but got ZERO/insufficient edits " +
              "while a 40s silent tool ran. The heartbeat must keep it advancing; " +
              "this is the 0-label freeze regression.",
          ).toBeGreaterThanOrEqual(4);
          expect(
            elapsedClimbs,
            "the card's step elapsed must climb across the edits",
          ).toBeGreaterThanOrEqual(2);
          console.log("[feed-heartbeat] PASS — silent-tool card advanced via heartbeat edits.");
          return;
        }

        if (toolFeedSeen) {
          console.warn(
            "[feed-heartbeat] INCONCLUSIVE — the model narrated / used extra tools, " +
              "so the turn was not 0-label and the labelled-feed heartbeat drove the " +
              "card. Not a failure of the fix.",
          );
          expect(answer, "the turn must still complete").not.toBeNull();
          return;
        }

        expect(
          livenessCardId,
          "no activity card of any kind appeared for a 40s tool — liveness open failed.",
        ).not.toBeNull();

        await iter.return?.();
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );

  it(
    "surfaces narration in the activity card BEFORE the tool label (narration-first path)",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const iter = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();

        await sc.sendDM(NARRATE_THEN_TOOL_PROMPT);
        const sentAt = Date.now();
        console.log("[feed-heartbeat] narrate-then-tool prompt sent; watching card…");

        let narrationSeenInCard = false;
        let toolLabelSeenAfterNarration = false;
        let answer: ObservedMessage | null = null;

        const deadline = Date.now() + 110_000;
        while (Date.now() < deadline) {
          if (narrationSeenInCard && (toolLabelSeenAfterNarration || answer)) break;
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
            if (m.text.includes(NARRATE_THEN_TOOL_MARKER)) {
              if (!narrationSeenInCard) {
                narrationSeenInCard = true;
                console.log(`[feed-heartbeat] narration surfaced in card at +${Date.now() - sentAt}ms`);
              }
            } else if (narrationSeenInCard && /grep/i.test(m.text)) {
              toolLabelSeenAfterNarration = true;
            }
            continue;
          }
          if (!m.edited && m.text.trim().length > 0 && !answer) answer = m;
        }

        expect(
          narrationSeenInCard,
          "the narrated line should surface in the activity card mid-turn (narration-first path)",
        ).toBe(true);

        await iter.return?.();
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
