/**
 * JTBD scenario — guaranteed fast acknowledgement (human-feel UX epic).
 *
 * Serves: `reference/conversational-pacing.md` and the JTBD
 * "talking to my agent feels like talking to a capable person".
 *
 * A person you message answers in a beat — "got it", "on it, checking
 * now" — before the work is done. PR #1633 made that opening
 * acknowledgement a *guarantee*, split across two layers:
 *
 *   - the conversational-pacing prompt teaches the model to open with
 *     a short human one-liner unless the real answer lands in a second
 *     or two;
 *   - the silence-poke subsystem *enforces* it — a ~10s ack-budget
 *     poke fires when nothing at all has been sent this turn, nudging
 *     the model to acknowledge before it does more work.
 *
 * This UAT drives a FUZZY set of non-trivial prompt shapes — research,
 * multi-step compute, open-ended advice, code, reflective asks. Every
 * one needs real work, so a turn that goes silent for tens of seconds
 * is a black box. The invariant under test: the user sees a sign of
 * life FAST, every time, across every prompt shape.
 *
 * ## Targets
 *
 *   - **Hard contract (deterministic):** the first outbound lands
 *     within `ACK_HARD_MS` for every prompt. This is backstopped by
 *     the framework ack poke (~10s) — even a non-compliant model is
 *     nudged and sends *something* well inside the budget, so the
 *     assertion does not depend on model goodwill. Pre-#1633 a slow
 *     prompt's first outbound was the full answer, often 30-60s out —
 *     this bound cleanly separates the fixed behaviour from a
 *     regression.
 *   - **Vision target (soft, per-case forensic):** the first outbound
 *     lands within `ACK_VISION_MS` and is short — a genuine
 *     acknowledgement, not a full-answer dump. The model self-acking
 *     (rather than waiting for the framework backstop) is what makes
 *     it *feel* human. Logged, not failed: real model runs vary, and
 *     the prompt explicitly lets a turn skip the ack when the answer
 *     itself arrives in the first couple of seconds.
 *
 * ## Relationship to adjacent UATs
 *
 *   - `jtbd-fast-trivial-dm.test.ts` — TRIVIAL prompts: the answer
 *     itself should land fast, no ack ceremony. This file is the
 *     non-trivial inverse: real work, but a fast *acknowledgement*.
 *   - `jtbd-soft-commit-dm.test.ts` — the predecessor: a single slow
 *     prompt, a looser "first reply within 30s" floor. This file is
 *     the stronger, fuzzed successor of that contract.
 *
 * Each case is a single inbound; cases run sequentially. As with the
 * other fuzz files, a prior turn may still be finishing in the
 * background when the next case starts — an accepted, noted risk.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

// Hard contract: a sign of life within this budget, every prompt.
// Sized to comfortably cover the framework-backstop path — the ~10s
// ack poke, plus the nudge piggybacking the next tool result, plus
// the model emitting the reply, plus mtcute polling jitter.
const ACK_HARD_MS = 20_000;

// Vision target: the model self-acknowledges in a beat, well before
// the framework has to step in.
const ACK_VISION_MS = 8_000;

// A first outbound at or under this length reads as an acknowledgement
// one-liner rather than a full-answer dump. Mirrors the >200-char
// "long answer" heuristic in jtbd-soft-commit-dm, with headroom for a
// persona-voiced ack ("on it — pulling the os-release and hostname now").
const ACK_LEN_CEILING = 320;

interface AckCase {
  name: string;
  /** A prompt that genuinely needs more than a second or two of work,
   *  so an instant full answer is not a legitimate ack-skip. */
  prompt: string;
}

const ACK_CASES: readonly AckCase[] = [
  // ─── Research / multi-source read ─────────────────────────────
  {
    name: "machine-summary research",
    prompt:
      "Read /etc/os-release and /etc/hostname, then tell me in one "
      + "sentence what kind of machine this is.",
  },
  // ─── Multi-step compute ───────────────────────────────────────
  {
    name: "compound date math",
    prompt:
      "Work out what day of the week it is today, then tell me how "
      + "many days are left until the end of this month.",
  },
  // ─── Open-ended advice ("take your time") ─────────────────────
  {
    name: "open-ended prioritisation",
    prompt:
      "I've got a free afternoon and three half-finished side "
      + "projects. Help me decide what to focus on. Take your time.",
  },
  // ─── Summarise / explain ──────────────────────────────────────
  {
    name: "plain-language summary",
    prompt:
      "Give me a 3-bullet summary of what a Linux container actually "
      + "is, in plain language.",
  },
  // ─── Code task ────────────────────────────────────────────────
  {
    name: "bash one-liner with explanation",
    prompt:
      "Write me a small bash one-liner that counts the total number "
      + "of lines across all .ts files under the current directory, "
      + "and explain how it works.",
  },
  // ─── Reflective / vague-but-real ──────────────────────────────
  {
    name: "reflective open ask",
    prompt:
      "Something feels off with how I'm spending my mornings lately. "
      + "Help me think through it.",
  },
  // ─── Comparison / judgement ───────────────────────────────────
  {
    name: "tech comparison",
    prompt:
      "Compare REST and GraphQL for a small side project — which "
      + "would you pick and why?",
  },
  // ─── Investigate the box ──────────────────────────────────────
  {
    name: "disk-usage investigation",
    prompt:
      "Have a look at what's taking up the most space under /var/log "
      + "and summarise what you find.",
  },
];

describe("uat: guaranteed fast acknowledgement — fuzzy prompt shapes", () => {
  for (const tc of ACK_CASES) {
    it(
      `[ack] ${tc.name} — sign of life within ${ACK_HARD_MS / 1000}s`,
      async () => {
        const sc = await spinUp({ agent: AGENT });
        try {
          const sendStart = Date.now();
          await sc.sendDM(tc.prompt);

          const firstOutbound = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: ACK_HARD_MS + 6_000,
          });
          const ttfo = Date.now() - sendStart;
          const len = firstOutbound.text.trim().length;

          // Invariant: the outbound is a real, non-empty message.
          expect(len).toBeGreaterThan(0);

          // Hard contract: a sign of life FAST, deterministically
          // backstopped by the framework ack poke.
          if (ttfo >= ACK_HARD_MS) {
            throw new Error(
              `[ack] ${tc.name}: TTFO=${ttfo}ms exceeds the hard `
              + `contract ${ACK_HARD_MS}ms — the user sat on a silent `
              + `chat. The guaranteed-ack path (prompt + ~10s ack `
              + `poke) is not delivering. First outbound: `
              + `${JSON.stringify(firstOutbound.text.slice(0, 200))}`,
            );
          }
          expect(ttfo).toBeLessThan(ACK_HARD_MS);

          // Forensic, soft: did the model self-acknowledge in a beat,
          // or did the framework have to drag it over the line?
          const looksLikeAck = len <= ACK_LEN_CEILING;
          if (ttfo < ACK_VISION_MS && looksLikeAck) {
            console.log(
              `[ack] ${tc.name}: TTFO=${ttfo}ms, ${len} chars — fast `
              + `short acknowledgement. Feels human.`,
            );
          } else if (ttfo < ACK_VISION_MS && !looksLikeAck) {
            // Fast but long: the answer itself arrived quickly. The
            // pacing prompt explicitly sanctions skipping the ack when
            // the answer lands in the first couple of seconds.
            console.log(
              `[ack] ${tc.name}: TTFO=${ttfo}ms, ${len} chars — fast `
              + `full answer (legitimate ack-skip).`,
            );
          } else {
            // Passed the hard contract but slower than the vision
            // target — the canary for the model leaning on the
            // framework backstop instead of self-acking.
            console.warn(
              `[ack] ${tc.name}: TTFO=${ttfo}ms (vision target `
              + `<${ACK_VISION_MS}ms), ${len} chars`
              + `${looksLikeAck ? "" : " — and long, not an ack one-liner"}`
              + `. The model leaned on the framework ack poke rather `
              + `than acknowledging on its own.`,
            );
          }
        } finally {
          await sc.tearDown();
        }
      },
      ACK_HARD_MS + 45_000,
    );
  }
});
