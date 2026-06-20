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

/** The leading banner of a review prompt (see `buildReviewPrompt`). */
export const REVIEW_MARKER = "[self-improvement review]";

/**
 * True iff `text` is (the transcript form of) a review turn WE injected.
 *
 * The injected inbound comes back through the gateway CHANNEL-WRAPPED, so
 * the stored user text is NOT the bare banner — it looks like:
 *
 *   <channel source="self_improve_review" ...>[self-improvement review] …</channel>
 *
 * The original guard used `text.startsWith(REVIEW_MARKER)`, which never
 * matches the wrapped form → infinite re-fire loop (issue #2462). We match
 * robustly on EITHER the channel envelope's `source="self_improve_review"`
 * attribute OR a substring of the banner, so both the wrapped form and the
 * bare form (older transcripts / tests) are caught.
 */
export function isReviewInjectedText(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  // Channel-wrapped form: `<channel ... source="self_improve_review" ...>`.
  // The attribute can appear with single or double quotes; match either,
  // only inside a leading `<channel ...>` envelope to avoid false positives
  // from an operator quoting the string.
  const sourceAttr = new RegExp(
    `^\\s*<channel\\b[^>]*\\bsource\\s*=\\s*["']?${REVIEW_SOURCE}\\b`,
    "i",
  );
  if (sourceAttr.test(text)) return true;
  // Bare / embedded banner (older transcripts, unit tests): a substring
  // check — NOT startsWith — so a channel-stripped variant still matches.
  return text.includes(REVIEW_MARKER);
}

/**
 * Build the review prompt text. `signals` is the gate's output; the
 * prompt is bounded (signals are already capped by the gate).
 */
export function buildReviewPrompt(signals: LearningSignal[]): string {
  const cfg = resolveSelfImproveConfig();
  const lines: string[] = [];

  lines.push(
    "[self-improvement review] The turn-end gate detected a learning " +
      "signal — a correction or pattern that should bind on future runs. " +
      "Run a focused, forked review. Use ONLY memory tools (recall/retain/" +
      "directives) and skill read/write tools (Read/Write/Edit under your " +
      "own .claude/skills/, skill_* / skill-personal). Do NOT touch " +
      "anything else, do NOT reply to the operator, and end the turn when " +
      "done.",
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
  lines.push("");
  lines.push(
    `Rate limits in effect: <= ${cfg.maxAutoAppliesPerDay} auto-applies/day, ` +
      `<= ${cfg.maxOutstandingPending} outstanding pending suggestions. If a ` +
      "limit is reached, stop and leave a note rather than forcing the change.",
  );

  return lines.join("\n");
}
