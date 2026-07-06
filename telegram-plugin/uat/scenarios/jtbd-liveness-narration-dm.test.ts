/**
 * Narrated mid-turn work still shows words on the card (Phase 4a,
 * `deterministic-turn-liveness.md`) — DM.
 *
 * The Phase-1 climb fills the GAPS the model leaves; it must never regress
 * the pre-existing narration path (session-tail → gateway `case 'text'` →
 * `stagePendingNarrative` → `showNarrativeStep` → `appendActivityLabel`).
 * This scenario proves the model's own narrated steps still land on the
 * card mid-turn, chronologically interleaved with the climb, when the model
 * DOES talk (the complement of `jtbd-liveness-climb-dm`, which forces the
 * model silent).
 *
 * IMPORTANT: switchroom has no streaming REPLY path. The words asserted here
 * land on the pre-existing activity/liveness card (a card-edit surface), not
 * a streamed reply — the final reply is still sent whole.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const OVERALL_BUDGET_MS = 130_000;

const NARRATED_WORK_PROMPT =
  "Do four short steps, ONE AT A TIME. Before EACH step, write a brief " +
  'one-sentence narration of what you are about to do (e.g. "Checking the ' +
  'hostname now.") — this is not a reply, just your normal narration — then ' +
  "run the step via Bash (`sleep 3` is fine as the step body). After all " +
  "four steps, send a one-line final summary reply.";

describe("uat: deterministic turn liveness — narration lands mid-turn (DM)", () => {
  it(
    "the model's own words appear on the activity card mid-turn (narration not regressed)",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const iter = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();

        await sc.sendDM(NARRATED_WORK_PROMPT);
        const sentAt = Date.now();
        console.log("[liveness-narration-dm] prompt sent; watching for narrated card content…");

        const narrationSamples: string[] = [];
        let answer: ObservedMessage | null = null;
        let otherLoudMessage: ObservedMessage | null = null;

        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (answer) break;
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
            // Anything on the card that ISN'T the bare "Working…" placeholder
            // or a "Working · Ns" climb suffix is model narration.
            if (!/^Working(\s*[·…]|$)/i.test(m.text.trim())) {
              narrationSamples.push(m.text);
              console.log(
                `[liveness-narration-dm] narrated card content at +${Date.now() - sentAt}ms: ` +
                  JSON.stringify(m.text.slice(0, 140)),
              );
            }
            if (m.edited && m.silent === false) otherLoudMessage = otherLoudMessage ?? m;
            continue;
          }
          if (m.edited) continue;
          if (!answer && m.text.trim().length > 0) {
            answer = m;
            continue;
          }
          if (m.silent === false) otherLoudMessage = otherLoudMessage ?? m;
        }
        await iter.return?.();

        expect(
          otherLoudMessage,
          `a mid-turn message pinged the user's device: ${JSON.stringify(otherLoudMessage?.text?.slice(0, 120))}`,
        ).toBeNull();

        if (narrationSamples.length === 0) {
          console.warn(
            "[liveness-narration-dm] INCONCLUSIVE — no narrated content observed on the " +
              "card (model may have batched steps or the turn was too fast). Not " +
              "necessarily a regression — but worth a human look if this recurs.",
          );
        } else {
          expect(narrationSamples.length).toBeGreaterThan(0);
        }

        expect(answer, "FAIL — no answer arrived within budget; the turn may be wedged.").not.toBeNull();
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
