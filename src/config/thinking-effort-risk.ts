/**
 * Model-aware thinking-effort risk guard (#1978) — LEGACY, Opus 4.x only.
 *
 * Opus models use *adaptive thinking* — they emit
 * `thinking`/`redacted_thinking` blocks. switchroom dispatches work to
 * concurrent sub-agents (worker/researcher/reviewer via the Task tool,
 * often `background: true`), and old builds of the bundled `claude` CLI
 * could mis-merge the interleaved streaming content blocks, after which
 * the Anthropic API rejected the turn with:
 *
 *   400 messages.N.content.M: 'thinking' or 'redacted_thinking' blocks
 *   in the latest assistant message cannot be modified.
 *
 * THIS BUG IS FIXED UPSTREAM. It was an UPSTREAM claude CLI streaming-merge
 * bug, not a switchroom bug, and the fix shipped in claude-code **2.1.156**
 * — pinned by switchroom v0.14.8 (CHANGELOG "Claude CLI pinned to `@2.1.156`
 * (the 400-fix build)"). Containers run the production pin from
 * `docker/Dockerfile.base` (`ARG CLAUDE_CODE_VERSION`), many builds past that
 * fix. Do NOT restate the pin here: it moves on every CLI bump, and
 * `readPinnedClaudeCliVersion()` (`src/cli/doctor-claude-cli.ts`) reads it out
 * of the Dockerfile at doctor time so nothing has to hardcode it.
 *
 * The guard is therefore retained ONLY for pinned Opus 4.x model ids
 * (`claude-opus-4*`), where the `medium`+ reproduction was actually observed
 * and where nobody has re-tested since. It deliberately does NOT match Opus 5
 * or the bare `opus` alias:
 *
 *   - Opus 5 runs at `thinking_effort: medium` on klanker and overlord since
 *     2026-07-25 with no recurrence of the 400.
 *   - The bare `opus` alias resolves to whatever the CLI's *current* default
 *     Opus is (Opus 5 on the pinned build), so matching the alias would flag
 *     Opus 5 by proxy.
 *
 * A related, separately-verified NON-cause: the em-dash scrubber was once
 * blamed for invalidating thinking-block signatures. That is wrong —
 * `normalizePunctuation` (`telegram-plugin/format.ts`) runs only in the
 * Telegram send path and never rewrites the session `.jsonl`, so it cannot
 * touch what is replayed to the API.
 *
 * `effort: low` keeps adaptive thinking near-zero (few/no thinking
 * blocks to mis-merge) and was the safe floor; `medium`+ reproduced the 400
 * on Opus 4.x under the pre-2.1.156 CLI. The scaffold defaults unset
 * `thinking_effort` to `low` (see SWITCHROOM_DEFAULT_THINKING_EFFORT), so an
 * UNSET value is safe — only an explicit `medium`/`high`/`xhigh`/`max` on a
 * pinned Opus 4.x model is flagged.
 *
 * Scope note: this guard intentionally flags the Opus 4.x family ONLY — not
 * Opus 5, not the bare `opus` alias, not Sonnet. Sonnet 5 also has adaptive
 * thinking, but the fleet runs Sonnet sub-agents at higher effort without
 * hitting this, so flagging it would be a false alarm. When the Opus 4.x
 * reproduction is re-tested green on a post-2.1.156 CLI, delete this module
 * and its `doctor` check outright.
 *
 * Pure (no I/O) so it can back both `switchroom doctor` and a config-load
 * advisory, and be unit-tested directly.
 */

/**
 * The claude-code build that fixed the #1978 interleaved-streaming merge bug.
 *
 * This is the SINGLE source of truth for that floor. `isAdaptiveThinkingOpus()`
 * was narrowed to `claude-opus-4*` *because* every container is expected to run
 * a CLI at or above this version — so anything that re-states the floor
 * (this module's operator-facing reason string, and the
 * `<agent>: claude CLI floor` doctor check in `src/cli/doctor-claude-cli.ts`)
 * must import it from here rather than re-typing "2.1.156".
 *
 * The floor is a LOWER bound, not the pin: the production pin lives in
 * `docker/Dockerfile.base` (`ARG CLAUDE_CODE_VERSION`) and is read from that
 * file at doctor time. `tests/doctor-claude-cli.test.ts` asserts the pin is
 * still >= this floor so the two cannot drift apart silently.
 */
export const CLAUDE_CLI_THINKING_MERGE_FIX_VERSION = "2.1.156";

/** Effort levels that produce enough adaptive thinking to risk the merge bug. */
const RISKY_EFFORTS = new Set(["medium", "high", "xhigh", "max"]);

/**
 * True for an effort level high enough to emit the volume of adaptive
 * thinking blocks that reproduced the #1978 merge 400.
 *
 * Unset is safe — the scaffold floors an unset `thinking_effort` at `low`
 * (`SWITCHROOM_DEFAULT_THINKING_EFFORT`).
 */
export function isRiskyThinkingEffort(effort: string | undefined): boolean {
  if (!effort) return false;
  return RISKY_EFFORTS.has(effort.trim().toLowerCase());
}

/**
 * True for any model that uses ADAPTIVE thinking, i.e. emits
 * `thinking`/`redacted_thinking` blocks that the pre-2.1.156 CLI could
 * mis-merge. That is the whole Opus family: the bare `opus` alias,
 * `claude-opus-4*`, and `claude-opus-5*`.
 *
 * This is deliberately BROADER than `isAdaptiveThinkingOpus()`. The narrow
 * predicate answers "should we warn about this config on a CURRENT CLI?"
 * (answer: only legacy Opus 4.x, because the bug is fixed). This one answers
 * "would this config have been exposed to the bug on a PRE-fix CLI?" — which
 * is exactly the question the doctor CLI-floor check needs once it has
 * observed that a container is in fact running a pre-fix CLI. Keeping them
 * separate is the point: do not widen `isAdaptiveThinkingOpus()` to reach
 * this, or the fleet's Opus 5 agents start warning again on a healthy CLI.
 */
export function emitsAdaptiveThinking(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return m === "opus" || m.startsWith("claude-opus-");
}

/**
 * True for models whose adaptive thinking + switchroom's concurrent
 * sub-agent dispatch was known to trigger the claude-CLI thinking-block
 * merge 400 on a pre-2.1.156 CLI.
 *
 * Matches PINNED Opus 4.x ids only (`claude-opus-4`, `claude-opus-4-8`,
 * date-stamped `claude-opus-4-*` pins). It deliberately does NOT match the
 * bare `opus` alias — that alias resolves to Opus 5 on the bundled CLI, so
 * matching it would flag Opus 5 by proxy — nor any `claude-opus-5*` id.
 */
export function isAdaptiveThinkingOpus(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.trim().toLowerCase();
  return m.startsWith("claude-opus-4");
}

export interface ThinkingEffortRisk {
  risky: boolean;
  /** Operator-facing explanation, present iff `risky`. */
  reason?: string;
}

/**
 * Assess whether a (model, thinking_effort) combo risks the adaptive-
 * thinking merge 400. Safe (`risky: false`) when effort is unset (→
 * scaffold floor `low`), when effort is `low`, or when the model isn't a
 * pinned Opus 4.x id (Opus 5 and the bare `opus` alias are safe).
 *
 * @param model   Resolved model — alias (`opus`) or full id (`claude-opus-4-8`).
 * @param effort  Resolved `thinking_effort` (may be undefined).
 */
export function assessThinkingEffortRisk(
  model: string | undefined,
  effort: string | undefined,
): ThinkingEffortRisk {
  if (!isRiskyThinkingEffort(effort)) return { risky: false };
  if (!isAdaptiveThinkingOpus(model)) return { risky: false };
  return {
    risky: true,
    reason:
      `thinking_effort '${effort}' on pinned Opus 4.x model '${model}' could trigger ` +
      `'400 thinking/redacted_thinking blocks cannot be modified' errors when work runs ` +
      `through concurrent sub-agents (issue #1978). The upstream claude-CLI fix shipped in ` +
      `${CLAUDE_CLI_THINKING_MERGE_FIX_VERSION}, but the Opus 4.x reproduction has not been ` +
      `re-tested since, so pin 'thinking_effort: low' or move the agent to a current Opus model.`,
  };
}
