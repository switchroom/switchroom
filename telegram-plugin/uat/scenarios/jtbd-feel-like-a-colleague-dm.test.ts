/**
 * JTBD scenario — feel like a colleague, not a chatbot (DM).
 *
 * Serves: `reference/jobs/feel-like-a-colleague.md`. The colleague posture
 * is shipped fleet-wide as lane-2 model-visible text (`~/.switchroom/fleet/
 * CLAUDE.md`, seeded by `renderFleetDefaultsClaudeMd()` in
 * `src/agents/fleet-defaults.ts`, epic #1850 / issue #1855). One bullet of
 * "Good looks like" reads:
 *
 *   "The agent asks at most one good clarifying question, and skips it when
 *    intent is clear, stating its assumption inline as it acts."
 *
 * This scenario sends a genuinely ambiguous request and asserts the agent
 * asks EXACTLY ONE clarifying question rather than a question avalanche
 * (the "Bad looks like" failure) or a confident guess that ignores the
 * ambiguity.
 *
 * Gating: like every file under `telegram-plugin/uat/scenarios/`, this hits
 * real Telegram + real Claude and only runs under `vitest.uat.config.ts`
 * (`bun run test:uat`). The default vitest config excludes this directory,
 * so CI stays green without live credentials.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

// Ambiguous on purpose: "the report" has no referent, no format, no
// destination. A colleague asks which report / what for; it does not
// silently invent one, and it does not fire three questions.
const AMBIGUOUS_PROMPT = "can you send over the report when you get a sec?";

/**
 * Count clarifying questions in a reply. We count sentences that end in a
 * question mark. Rhetorical framing ("sure, which one?") counts as one
 * question; the invariant is at most one.
 */
function countQuestions(text: string): number {
  const matches = text.match(/[^.!?\n]*\?/g);
  if (matches == null) return 0;
  // Filter out trivial fragments (a lone "?" or whitespace) that are not
  // real questions.
  return matches.filter((m) => m.replace(/[^a-z0-9]/gi, "").length >= 3).length;
}

describe("uat: feel like a colleague — one clarifying question when ambiguous", () => {
  it(
    "ambiguous ask → agent asks exactly one clarifying question",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM(AMBIGUOUS_PROMPT);

        const reply = await sc.expectMessage(/\S/, {
          from: "bot",
          timeout: 90_000,
        });

        expect(reply.text.length).toBeGreaterThan(0);

        const questionCount = countQuestions(reply.text);

        // Invariant: at least one clarifying question (it did not guess
        // blindly) and at most one (no question avalanche).
        if (questionCount === 0) {
          throw new Error(
            `[colleague] ambiguous ask got no clarifying question — the ` +
            `agent either guessed a referent or ignored the ambiguity. ` +
            `Reply: ${JSON.stringify(reply.text.slice(0, 300))}`,
          );
        }
        if (questionCount > 1) {
          throw new Error(
            `[colleague] question avalanche: ${questionCount} questions ` +
            `where one would do. Reply: ${JSON.stringify(reply.text.slice(0, 300))}`,
          );
        }
        expect(questionCount).toBe(1);

        // Posture bonus: no sycophantic preamble. A soft forensic warn,
        // not a hard fail (voice specifics are audited in
        // fuzz-voice-scrub-dm).
        if (/^(great question|i'?d be happy to|absolutely!|of course!)/i.test(reply.text.trim())) {
          console.warn(
            `[colleague] reply opens with sycophantic preamble: ` +
            `${JSON.stringify(reply.text.slice(0, 120))}`,
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    120_000,
  );
});
