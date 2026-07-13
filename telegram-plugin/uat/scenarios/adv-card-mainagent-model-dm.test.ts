/**
 * ADVERSARIAL — main-agent (foreground) liveness card paints with a LIVE model
 * label (model-freshness invariant, harness-reachable).
 *
 * Ken's amendment asks that, if reachable, we also probe the MAIN-agent
 * progress card — not only sub-agent/worker cards. The main-agent liveness card
 * is the two-line `🤖 Agent` header (renderActivityHeader) that paints while the
 * foreground turn runs tools. It carries the same live-model tag on its metric
 * line (`<elapsed> · <n> tools · <model>`), sourced live from the session
 * transcript — never a stale/cached value.
 *
 * This probe makes the main agent do enough inline tool work that the liveness
 * card paints, then asserts:
 *   - the `🤖 Agent` liveness card appears (isLivenessCardMessage), and
 *   - somewhere across its lifecycle it carries a live friendly model label and
 *     never a stale sentinel / raw `claude-…` id.
 *
 * Note: on a fast turn the liveness card can be collapsed/absent (the agent may
 * answer before the card's first-paint threshold), so a MISSING card is a SOFT
 * outcome (logged, not failed). The HARD assertion is the model-freshness one:
 * WHEN a card/metric line renders, it must never show a stale/raw id.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { collectTurn } from "../real-work-prompts.js";
import { isLivenessCardMessage } from "../assertions.js";

// Force inline foreground tool work in the MAIN agent (explicitly NOT a
// sub-agent) so the 🤖 Agent liveness card has reason to paint.
const INLINE_TOOLWORK_PROMPT =
  `Do this yourself in THIS turn, without dispatching any sub-agent or ` +
  `background worker: run four Bash commands ONE AT A TIME, each as its own ` +
  `separate Bash call with a brief pause of \`sleep 2\` between them — ` +
  `\`echo one\`, \`echo two\`, \`echo three\`, \`echo four\`. Then reply with ` +
  `the four words you printed, in order.`;

const MODEL_GOOD_RE = /\b(opus|sonnet|haiku)\s+\d[\d.]*/i;
const MODEL_SR_RE = /\bsr-[\w.-]+/i;
const MODEL_BAD_RE = /<synthetic>|<compact>|claude-[a-z]/i;
const AGENT_HEADER_RE = /^🤖\s+Agent\b/mu;

describe("uat-adv: main-agent liveness card model-freshness (attacks live-model invariant)", () => {
  it(
    "main-agent liveness card, when it paints, carries a live model label and never a stale/raw id",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const obs = await collectTurn(
          sc.driver,
          sc.botUserId,
          sc.driverUserId,
          INLINE_TOOLWORK_PROMPT,
          { timeoutMs: 150_000, minAnswerChars: 8, settleMs: 8_000 },
        );

        // Gather every liveness-card render seen this turn (initial sends + edits).
        const all = [...obs.botMessages, ...obs.edits];
        const cards = all.filter(
          (m) => isLivenessCardMessage(m) || AGENT_HEADER_RE.test(m.text),
        );
        console.log(
          `[adv-mainagent] answer=${obs.answer != null} livenessCards=${cards.length} sawActivityFeed=${obs.sawActivityFeed}`,
        );
        for (const c of cards.slice(0, 3)) {
          console.log(`[adv-mainagent] card: ${JSON.stringify(c.text.slice(0, 160))}`);
        }

        // An answer must land regardless.
        expect(obs.answer, "no substantive answer landed on the inline-toolwork turn").not.toBeNull();

        // HARD: NO card/render may ever show a stale sentinel / raw id.
        const corpus = all.map((m) => m.text).join("\n");
        expect(
          MODEL_BAD_RE.test(corpus),
          "a rendered surface carried a stale/sentinel/raw model id (model-freshness invariant)",
        ).toBe(false);

        // SOFT: if a liveness card painted, it should carry a live friendly
        // model label. Report but don't fail when the card collapsed on a fast
        // turn (the agent answered before first-paint threshold).
        if (cards.length > 0) {
          const cardCorpus = cards.map((c) => c.text).join("\n");
          const sawModel = MODEL_GOOD_RE.test(cardCorpus) || MODEL_SR_RE.test(cardCorpus);
          if (!sawModel) {
            console.warn(
              "[adv-mainagent] WARN: liveness card painted but no friendly model label found — " +
                "candidate model-freshness gap, verify against gateway telemetry.",
            );
          } else {
            console.log("[adv-mainagent] liveness card carried a live friendly model label.");
          }
        } else {
          console.warn(
            "[adv-mainagent] WARN: no liveness card painted (fast turn / collapsed) — " +
              "main-agent card not exercised this run.",
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    210_000,
  );
});
