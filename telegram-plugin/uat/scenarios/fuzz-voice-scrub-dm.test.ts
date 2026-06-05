/**
 * Voice-scrub fuzz — end-to-end proof of the deterministic voice gate.
 *
 * The gateway's `scrubVoice` strips em/en dashes and leading sycophancy
 * openers ("You're absolutely right", "Great catch", ...) from every
 * outbound reply. This fuzz file drives REAL Telegram inbounds engineered
 * to bait those exact AI-tells (statements the agent will want to affirm;
 * prose asks where models reach for em-dashes) and asserts the observed
 * reply carries neither.
 *
 * Why this is a good UAT target: unlike the grounding/voice PROMPT
 * guidance (soft, semantic, not cleanly observable), the scrub is a
 * deterministic transform on the wire, so mtcute's view of the sent
 * message is ground truth. If an em-dash or a leading affirmation reaches
 * the user, the gate failed.
 *
 * Self-skips green when the harness can't spin up (env unwired) — same as
 * the sibling fuzz files; uat/** is excluded from gating CI.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

interface VoiceCase {
  name: string;
  prompt: string;
  timeout: number;
}

// Prompts engineered to bait the two AI-tells the gate removes.
const VOICE_CASES: readonly VoiceCase[] = [
  // ── Bait leading affirmation: an assertion the agent will agree with ──
  { name: "affirm-bait: await", prompt: "I'm pretty sure the bug is a missing await on the handler. Am I right?", timeout: 60_000 },
  { name: "affirm-bait: timezone", prompt: "So the off-by-one is just a timezone offset, correct?", timeout: 60_000 },
  { name: "affirm-bait: cache", prompt: "I worked out it's the cache not invalidating. Good call on my part, no?", timeout: 60_000 },
  { name: "affirm-bait: restart", prompt: "To pick up the new config I just need to restart the process, yeah?", timeout: 60_000 },
  { name: "affirm-bait: correction", prompt: "Actually I think 2 + 2 is 4, not 5 like I said before. Right?", timeout: 60_000 },
  { name: "affirm-bait: praise-fish", prompt: "I refactored it into one pure function. Pretty clean solution, right?", timeout: 60_000 },

  // ── Bait em-dashes: prose explanations / tradeoff asks ──
  { name: "dash-bait: tradeoff", prompt: "In a sentence or two, what's the tradeoff between threads and async?", timeout: 60_000 },
  { name: "dash-bait: definition", prompt: "Explain what a closure is, briefly, in your own words.", timeout: 60_000 },
  { name: "dash-bait: contrast", prompt: "Quick: difference between TCP and UDP, a couple sentences.", timeout: 60_000 },
  { name: "dash-bait: aside", prompt: "Give me a one-line summary of what a load balancer does, with the nuance.", timeout: 60_000 },
  { name: "dash-bait: list-prose", prompt: "What are the two biggest risks of caching, written as flowing prose not bullets?", timeout: 60_000 },

  // ── Combined: agree AND explain (both tells in one reply) ──
  { name: "combo: agree+explain", prompt: "I think REST is simpler than GraphQL for small apps. Agree? Explain why in a couple sentences.", timeout: 60_000 },
];

const TYPO_DASH_RE = /[—–]/; // em-dash, en-dash

// Mirrors the gateway scrubber's exact strip condition (affirmation +
// separator/end). Asserting THIS, not a looser "starts with the word",
// keeps the UAT a reliable regression test of the deterministic gate: it
// fails only when a strippable opener actually survived to the user, not
// when the soft prompt layer emits a non-strippable variant.
const LEADING_AFFIRMATION_RE =
  /^(you(?:['’]| a)re absolutely right|you(?:['’]| a)re so right|you(?:['’]| a)re absolutely correct|absolutely right|exactly right|great catch|good catch|nice catch|spot on)\b(?:\s*$|\s*[!.,;:—–-])/i;

describe("uat: voice-scrub fuzz — no em-dashes, no sycophancy openers reach the user", () => {
  for (const vc of VOICE_CASES) {
    it(
      `[voice] ${vc.name} — reply is dash-free and affirmation-free`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          await sc.sendDM(vc.prompt);
          const reply = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: vc.timeout,
          });
          const text = reply.text ?? "";

          // Invariant 1: non-empty reply (user not ghosted).
          expect(text.trim().length).toBeGreaterThan(0);

          // Invariant 2: no typographic em/en dash reached the user.
          // The scrubber converts every surviving dash outside code to a
          // comma/period/hyphen, so any [—–] in the wire text is
          // a gate miss. (Em-dash-inside-code is astronomically unlikely
          // for these prose/agreement prompts.)
          if (TYPO_DASH_RE.test(text)) {
            throw new Error(
              `[voice] ${vc.name}: em/en dash reached the user (scrub miss). `
              + `Reply: ${JSON.stringify(text.slice(0, 400))}`,
            );
          }

          // Invariant 3: reply does not OPEN with a sycophancy affirmation.
          if (LEADING_AFFIRMATION_RE.test(text.trim())) {
            throw new Error(
              `[voice] ${vc.name}: reply opened with a stripped-class affirmation. `
              + `Reply: ${JSON.stringify(text.slice(0, 200))}`,
            );
          }
        } finally {
          await sc.tearDown();
        }
      },
      vc.timeout + 30_000,
    );
  }
});
