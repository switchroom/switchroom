/**
 * Narrated mid-turn work still shows words on the card — CHANNEL twin of
 * `jtbd-liveness-narration-dm.test.ts` (Phase 4a, `deterministic-turn-liveness.md`).
 *
 * Surface parity bar per the job spec. Like the DM twin (and unlike the
 * previous version of this file), it also asserts the no-mid-turn-ping
 * invariant inline — the RFC and job spec claim the ping-free assertion is
 * baked into EVERY liveness scenario, DM and channel alike. Self-skips green
 * when no test supergroup is wired.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import {
  isActivityFeedMessage,
  isFrameworkFallbackText,
  stripCardNesting,
} from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);
const OVERALL_BUDGET_MS = 150_000;

const NARRATED_WORK_PROMPT =
  "Do four short steps, ONE AT A TIME. Before EACH step, write a brief " +
  'one-sentence narration of what you are about to do (e.g. "Checking the ' +
  'hostname now.") — this is not a reply, just your normal narration — then ' +
  "run the step via Bash (`sleep 3` is fine as the step body). After all " +
  "four steps, send a one-line final summary reply.";

/** Body (narration/tool) lines of a card, minus header + climb placeholder.
 *  Mirrors the DM twin's `narratedBodyLines`. */
function narratedBodyLines(text: string): string[] {
  return text
    .split("\n")
    // strip the #3820 subordinate-card nesting (`└─ ` / U+2800 indent) first —
    // `trim()` removes neither, and a worker card's header/body lines would
    // otherwise read as model narration
    .map((l) => stripCardNesting(l))
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[→✓↳]+\s*/u, "").trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !/^(?:🤖|🛠[️]?|⚙[️]?)\s/u.test(l) &&
        !/^(?:(?:\d+m)?\d+s\s*·\s*\d+\s+tools?|(?:done|failed)\s*·)/iu.test(l) &&
        !/^Working(?:\s*[·…]|$)/i.test(l) &&
        !/^\+?\d+\s+earlier/i.test(l),
    );
}

describe("uat: deterministic turn liveness — narration lands mid-turn (channel parity)", () => {
  it(
    "the model's own words appear on the activity card mid-turn in a supergroup, with no mid-turn ping",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[liveness-narration-channel] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(`[liveness-narration-channel] supergroup ${SUPERGROUP_ID} not resolvable — skipping`);
          return;
        }

        const iter = sc.driver
          .observeMessages(SUPERGROUP_ID)
          [Symbol.asyncIterator]();

        await sc.driver.sendText(SUPERGROUP_ID, NARRATED_WORK_PROMPT);
        const sentAt = Date.now();

        const narrationSamples: string[] = [];
        let answer: ObservedMessage | null = null;
        let otherLoudMessage: ObservedMessage | null = null;

        const deadline = Date.now() + 100_000;
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
            const narrated = narratedBodyLines(m.text);
            if (narrated.length > 0) {
              narrationSamples.push(narrated.join(" | "));
              console.log(
                `[liveness-narration-channel] narrated card content at +${Date.now() - sentAt}ms: ` +
                  JSON.stringify(narrated.join(" | ").slice(0, 140)),
              );
            }
            if (m.edited && m.silent === false) otherLoudMessage = otherLoudMessage ?? m;
            continue;
          }
          if (m.edited) continue;
          if (isFrameworkFallbackText(m.text)) {
            otherLoudMessage = otherLoudMessage ?? m;
            continue;
          }
          if (!answer && m.text.trim().length > 0) {
            answer = m;
            continue;
          }
          if (m.silent === false) otherLoudMessage = otherLoudMessage ?? m;
        }
        await iter.return?.();

        // No-mid-turn-ping invariant, inline in the channel twin too.
        expect(
          otherLoudMessage,
          `a mid-turn message eroded the ping-free/edit-only guarantee in the supergroup: ` +
            JSON.stringify(otherLoudMessage?.text?.slice(0, 120)),
        ).toBeNull();

        if (narrationSamples.length === 0) {
          console.warn(
            "[liveness-narration-channel] INCONCLUSIVE — no narrated content observed on the " +
              "card (model may have batched steps or the turn was too fast).",
          );
        }

        expect(
          answer,
          "FAIL — no answer (distinct from the activity card) arrived within budget; the turn may be wedged.",
        ).not.toBeNull();
        expect(answer?.chatId).toBe(SUPERGROUP_ID);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_BUDGET_MS,
  );
});
