/**
 * Agent self-improvement — the forked-review PROMPT (RFC §"Run the review
 * forked, async, restricted toolset").
 *
 * Constraint (CLAUDE.md "claude-native, subscription-funded"): the review
 * is a model call, so it MUST go through the interactive session as a
 * synthesized turn (`inject_inbound`) — NOT a new `claude -p` spawn. The
 * gate (a Stop hook) therefore does not call the model itself; it builds
 * this prompt and injects it as an inbound, the same primitive cron uses.
 * The injected turn runs forked/async, off the operator's reply path.
 *
 * The prompt:
 *   - States the toolset restriction (memory + skill read/write only) so
 *     the review stays in its lane.
 *   - Hands the review the detected signals (the gate's evidence).
 *   - Tells it the EXACT contract: diagnose the lesson, the smallest
 *     binding change, the blast-radius tier; for T1 run the per-skill
 *     eval gate before landing; T2/T3 → queue a pending suggestion, do
 *     NOT apply.
 *
 * The synthesized inbound carries `meta.source = "self_improve_review"`
 * so the gateway / audit can distinguish it (mirrors cron's
 * `meta.source` convention).
 */

import type { LearningSignal } from "./types.js";
import { resolveSelfImproveConfig } from "./config.js";

/** The `meta.source` stamped on the synthesized review inbound. */
export const REVIEW_SOURCE = "self_improve_review";

/**
 * The leading title line of a self-improvement CARD — the ONE sanctioned
 * operator-facing output of a review turn. MUST stay byte-identical to
 * `SELF_IMPROVEMENT_TITLE` in
 * `telegram-plugin/hooks/audience-classify.mjs`: the review turn emits a message
 * opening with this line, and the backstop's card gate (`isSelfImprovementCard`)
 * delivers it ONLY because it opens with exactly this string. A drift would make
 * every surfacing card fall through the gate and be suppressed as raw reasoning.
 * `tests/self-improve-review-audience.test.ts` pins the equality.
 */
export const SELF_IMPROVEMENT_CARD_TITLE = "🔧 **Self-improvement**";

/**
 * The banner that opens every review prompt. Single source of truth so the
 * builder (below) and the review-turn DETECTOR (`isReviewTurn`) can never
 * drift apart — a drift there is exactly what let the re-fire loop through
 * (the detector matched a string the builder no longer emitted at offset 0).
 */
export const REVIEW_BANNER = "[self-improvement review]";

/**
 * Is `text` the transcript of a review turn WE injected? Used by the Stop
 * hook to (a) short-circuit so a review never reviews itself, and (b) drop
 * our own injected prompts from the gate's scan window.
 *
 * Robust to the TWO shapes the review prompt takes in a transcript:
 *   - bare banner — the raw `buildReviewPrompt` output (unit tests, and a
 *     safety net), where the banner is at offset 0; and
 *   - channel-wrapped — the REAL runtime shape. The gateway wraps every
 *     injected inbound in a `<channel source="…" source="self_improve_review"
 *     …>\n<prompt>` envelope before it lands in the transcript, so the banner
 *     is NOT at offset 0. The brittle `startsWith(BANNER)` check missed this
 *     entirely → the guard never fired → the gate re-injected every turn
 *     (issue #2462). We match our own `meta.source` on the envelope, or the
 *     banner immediately after the opening tag.
 */
export function isReviewTurn(text: string): boolean {
  if (!text) return false;
  if (text.startsWith(REVIEW_BANNER)) return true;
  const env = /^<channel\b[^>]*>/i.exec(text);
  if (env) {
    if (env[0].includes(`source="${REVIEW_SOURCE}"`)) return true;
    if (text.slice(env[0].length).replace(/^\s+/, "").startsWith(REVIEW_BANNER)) {
      return true;
    }
  }
  return false;
}

/**
 * Build the review prompt text. `signals` is the gate's output; the
 * prompt is bounded (signals are already capped by the gate).
 */
export function buildReviewPrompt(signals: LearningSignal[]): string {
  const cfg = resolveSelfImproveConfig();
  const lines: string[] = [];

  lines.push(
    `${REVIEW_BANNER} The turn-end gate detected a learning ` +
      "signal — a correction or pattern that should bind on future runs. " +
      "Run a focused, forked review. Use ONLY memory tools (recall/retain/" +
      "directives) and skill read/write tools (Read/Write/Edit under your " +
      "own .claude/skills/, skill_* / skill-personal). Do NOT touch " +
      "anything else, and do NOT reply to the operator with tools.",
  );
  lines.push("");
  lines.push("Signals detected this turn:");
  for (const s of signals) {
    lines.push(`  - [${s.kind}] ${s.reason}`);
    if (s.evidence) lines.push(`      evidence: ${s.evidence}`);
  }
  lines.push("");
  lines.push("Diagnose and act, strictly within these rules:");
  lines.push(
    "  1. State the lesson in one line and the SMALLEST change that makes " +
      "it bind (prefer the strongest deterministic layer: a skill edit " +
      "over a Hindsight directive).",
  );
  lines.push(
    `  2. Classify the change's blast radius. T1 = a small (<= ${cfg.t1MaxChangedLines} ` +
      "changed lines, single file) reversible edit to a skill you ALREADY " +
      "own. Anything medium / shared / new-cron / new-skill / cross-agent " +
      "/ irreversible is T2 or T3.",
  );
  lines.push(
    "  3. For a T1: BEFORE editing, confirm the skill has evals/evals.json " +
      "and that your edit passes them without regressing baseline (the " +
      "skill-creator grader + aggregate_benchmark.py). Land the edit via " +
      "the native skill-write path (Write/Edit) only if the evals pass. " +
      "If the skill has no evals.json, do NOT auto-apply — treat it as T2.",
  );
  lines.push(
    "  4. For T2/T3: do NOT apply anything. Record a one-line pending " +
      "suggestion (the operator actions it later). Never auto-create a " +
      "cron or a new skill, never edit a shared/other-agent skill.",
  );
  lines.push(
    "  5. If this was an operator CORRECTION tied to a skill you own, turn " +
      "it into a regression test: run `switchroom self-improve add-eval-case " +
      "--skill <slug> --chat <operator chat id> " +
      "--prompt \"<the correction framed as a test prompt>\"`. The `--chat` " +
      "flag is REQUIRED — pass the real operator chat id from this session's " +
      "context (the chat the correction arrived in), NOT the review turn's " +
      "own placeholder chat id, or the command is rejected. This proposes " +
      "the case as a one-tap card; the operator's tap runs a deterministic " +
      "applier that writes it (PII/secret-scanned). Do NOT Write or Edit " +
      "evals/evals.json yourself — a direct write is blocked, bypasses the " +
      "scan, and skips the operator's approval.",
  );
  lines.push("");
  lines.push(
    `Rate limits in effect: <= ${cfg.maxAutoAppliesPerDay} auto-applies/day, ` +
      `<= ${cfg.maxOutstandingPending} outstanding pending suggestions. If a ` +
      "limit is reached, stop and leave a note rather than forcing the change.",
  );

  // ── The operator-facing output contract (Ken, 2026-08-07) ────────────────
  // A review turn is OFF the operator reply path (its inbound targets a
  // placeholder chat). Its ONE operator-facing output is the final text of this
  // turn, and the backstop only lets it through when it is a well-formed card
  // (leading `SELF_IMPROVEMENT_CARD_TITLE` — see `isSelfImprovementCard`). Raw
  // reasoning as trailing text is SUPPRESSED, so it can never leak again. Lock
  // the exact shape here so the model emits what the gate expects.
  lines.push("");
  lines.push(
    "OPERATOR OUTPUT — READ CAREFULLY. You have exactly ONE operator-facing " +
      "message this turn, and it is the FINAL TEXT you write (not a tool call).",
  );
  lines.push(
    "  - If you actioned NOTHING this turn (deduped, no-op, already handled, or " +
      "nothing worth the operator's attention), write NO final text at all — " +
      "end the turn SILENTLY. Do NOT narrate your reasoning; trailing reasoning " +
      "prose is suppressed and never reaches the operator.",
  );
  lines.push(
    "  - If you surfaced a REAL outcome (logged a pending suggestion, applied a " +
      "T1, or proposed an eval case), end the turn with a SINGLE message in " +
      "EXACTLY this format and nothing else:",
  );
  lines.push("");
  lines.push(`${SELF_IMPROVEMENT_CARD_TITLE} — <one-line outcome>`);
  lines.push("- **Signal:** <what tripped the gate>");
  lines.push("- **Suggestion:** <the proposed change>");
  lines.push(
    "- **Status:** <tier + whether anything auto-applied, e.g. " +
      '"T2, logged for your review, nothing auto-applied">',
  );
  lines.push("");
  lines.push(
    `The leading "${SELF_IMPROVEMENT_CARD_TITLE}" line is REQUIRED verbatim — it ` +
      "is what marks the message as a self-improvement card. Anything not " +
      "starting with it is treated as raw reasoning and dropped.",
  );

  return lines.join("\n");
}
