/**
 * Model-aware thinking-effort risk guard (#1978).
 *
 * Opus 4.x models use *adaptive thinking* — they emit
 * `thinking`/`redacted_thinking` blocks. switchroom dispatches work to
 * concurrent sub-agents (worker/researcher/reviewer via the Task tool,
 * often `background: true`), and the bundled `claude` CLI can mis-merge
 * the interleaved streaming content blocks, after which the Anthropic
 * API rejects the turn with:
 *
 *   400 messages.N.content.M: 'thinking' or 'redacted_thinking' blocks
 *   in the latest assistant message cannot be modified.
 *
 * This is an UPSTREAM claude CLI bug (a fix is credited in claude's own
 * changelog for the concurrent-agent / interleaved-streaming merge
 * path), not a switchroom bug — so switchroom can't fully fix it; it can
 * only (a) keep effort at the safe floor and (b) warn loudly when an
 * operator configures a combo known to trigger it.
 *
 * `effort: low` keeps adaptive thinking near-zero (few/no thinking
 * blocks to mis-merge) and is the safe floor; `medium`+ reliably
 * reproduces the 400. The scaffold defaults unset `thinking_effort` to
 * `low` (see SWITCHROOM_DEFAULT_THINKING_EFFORT), so an UNSET value is
 * safe — only an explicit `medium`/`high`/`xhigh`/`max` on an Opus 4.x
 * model is flagged.
 *
 * Scope note: this guard intentionally only flags the Opus 4.x family.
 * Sonnet 5 also has adaptive thinking, but the fleet runs Sonnet
 * sub-agents at higher effort without hitting this, so flagging it would
 * be a false alarm. Revisit if the failure is observed on Sonnet.
 *
 * Pure (no I/O) so it can back both `switchroom doctor` and a config-load
 * advisory, and be unit-tested directly.
 */

/** Effort levels that produce enough adaptive thinking to risk the merge bug. */
const RISKY_EFFORTS = new Set(["medium", "high", "xhigh", "max"]);

/**
 * True for models whose adaptive thinking + switchroom's concurrent
 * sub-agent dispatch is known to trigger the claude-CLI thinking-block
 * merge 400. Matches the `opus` alias (resolves to the latest Opus,
 * currently 4.8) and any pinned `claude-opus-4-*` id.
 */
export function isAdaptiveThinkingOpus(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return m === "opus" || m.startsWith("claude-opus-4");
}

export interface ThinkingEffortRisk {
  risky: boolean;
  /** Operator-facing explanation, present iff `risky`. */
  reason?: string;
}

/**
 * Assess whether a (model, thinking_effort) combo risks the adaptive-
 * thinking merge 400. Safe (`risky: false`) when effort is unset (→
 * scaffold floor `low`), when effort is `low`, or when the model isn't an
 * Opus 4.x adaptive-thinking model.
 *
 * @param model   Resolved model — alias (`opus`) or full id (`claude-opus-4-8`).
 * @param effort  Resolved `thinking_effort` (may be undefined).
 */
export function assessThinkingEffortRisk(
  model: string | undefined,
  effort: string | undefined,
): ThinkingEffortRisk {
  if (!effort) return { risky: false };
  if (!RISKY_EFFORTS.has(effort.trim().toLowerCase())) return { risky: false };
  if (!isAdaptiveThinkingOpus(model)) return { risky: false };
  return {
    risky: true,
    reason:
      `thinking_effort '${effort}' on adaptive-thinking model '${model}' can trigger ` +
      `'400 thinking/redacted_thinking blocks cannot be modified' errors when work runs ` +
      `through concurrent sub-agents (issue #1978). Pin 'thinking_effort: low' (the safe ` +
      `floor) unless the bundled claude CLI includes the concurrent-agent thinking-block ` +
      `merge fix.`,
  };
}
