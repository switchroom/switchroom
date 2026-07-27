/**
 * Declarative recall-latency tunables for the vendored hindsight plugin.
 *
 * ## Why this module exists
 *
 * The knobs that decide whether recall works at all used to live as LITERALS
 * inside the installed plugin tree:
 *
 *   - `vendor/hindsight-memory/scripts/recall.py` — a bare `timeout=8` on the
 *     per-bank recall request.
 *   - `vendor/hindsight-memory/hooks/hooks.json` — a bare `"timeout": 12` on
 *     the UserPromptSubmit hook.
 *
 * and `recallParallelDeadlineSeconds`, while readable from config, had no
 * switchroom-side channel at all: nothing resolved it from `switchroom.yaml`,
 * so the only way to change it was to hand-edit a file inside the agent's
 * installed plugin.
 *
 * `installHindsightPlugin` rm's and re-copies that whole tree from `vendor/`
 * on every reconcile, so every one of those hand-edits was reverted by the
 * next `switchroom apply`. That is not hypothetical — the operator's
 * switchroom.yaml carries three separate gravestones for it, and the
 * `~/.hindsight/claude-code.json` companion file literally documents the
 * workaround ("must be re-applied after any `switchroom apply`"). Nobody ever
 * re-applied them, so the fleet silently ran shipped defaults while the config
 * read as though it were tuned.
 *
 * The fix is the same one `applyHindsightSettingsOverrides` already uses for
 * `settings.json`: the vendor tree stays pristine, and switchroom STAMPS the
 * resolved values onto the deployed copy after every copy. A stamped value is
 * re-derived from `switchroom.yaml` on every reconcile, so an apply RE-ASSERTS
 * it instead of reverting it.
 *
 * ## The latency envelope
 *
 * The three knobs are not independent — they are nested deadlines:
 *
 * ```
 *   hook ceiling            (hooks.json, Claude Code kills the hook here)
 *   └── parallel deadline   (shared fan-out budget; ceiling - headroom)
 *       └── per-bank timeout (one bank's HTTP request)
 * ```
 *
 * Inverting any pair produces a silently useless configuration: a per-bank
 * timeout above the shared deadline can never fire, and a shared deadline
 * above the hook ceiling means Claude Code kills the hook before recall gets
 * to degrade gracefully — the operator sees NO memories rather than partial
 * ones. So the resolver derives the inner values from the outer one by default
 * and CLAMPS explicit overrides back inside it, reporting each clamp so
 * `switchroom doctor` can surface it.
 */

/** Vendor/shipped default for the UserPromptSubmit hook ceiling (seconds). */
export const DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS = 12;

/**
 * Headroom (seconds) reserved between the hook ceiling and the shared parallel
 * recall deadline, for block formatting + cache write + stdout flush after the
 * fan-out completes. A straggler bank that runs to the deadline must still
 * leave enough budget for recall to emit its block, or the work is thrown away
 * at the ceiling.
 *
 * This is a MINIMUM, not a suggestion: `src/setup/hindsight-reranker-budget.test.ts`
 * fails CI when the vendored defaults violate `hook - deadline >= 2`, because at
 * equality a deadline-abandoned fan-out has zero time left to format the block,
 * write the cache, and flush stdout — Claude Code SIGKILLs the hook mid-write
 * and the turn loses BOTH the memories and the `recall_log.jsonl` row that would
 * have explained why. The resolver below enforces the same inequality on
 * operator yaml, which that guard cannot see (it only reads `vendor/`).
 */
export const RECALL_DEADLINE_HEADROOM_SECONDS = 2;

/**
 * The smallest hook ceiling that can carry a coherent envelope: the deadline
 * must be at least 1s AND sit at least `RECALL_DEADLINE_HEADROOM_SECONDS` below
 * the ceiling, so any ceiling below `headroom + 1` is unsatisfiable by
 * construction. A configured ceiling under this floor is clamped UP (and
 * reported) rather than silently producing a zero-headroom envelope.
 */
export const MIN_RECALL_HOOK_TIMEOUT_SECONDS = RECALL_DEADLINE_HEADROOM_SECONDS + 1;

/** Vendor/shipped default for the per-bank recall HTTP timeout (seconds). */
export const DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS = 8;

/** The resolved, mutually-consistent recall latency envelope for one agent. */
export interface HindsightRecallTunables {
  /** UserPromptSubmit hook ceiling, stamped into hooks/hooks.json. */
  hookTimeoutSeconds: number;
  /** Shared parallel fan-out deadline, stamped into settings.json. */
  parallelDeadlineSeconds: number;
  /** Per-bank recall HTTP timeout, stamped into settings.json. */
  requestTimeoutSeconds: number;
  /**
   * Human-readable notes for any value that was clamped away from what the
   * operator literally wrote. Empty on a clean resolution. Surfaced by
   * `switchroom doctor` so a clamp is visible rather than mysterious.
   */
  clamps: string[];
}

/** The `memory.recall.*` subset this resolver reads (post-cascade). */
export interface RecallTunableInput {
  hook_timeout_seconds?: number | undefined;
  parallel_deadline_seconds?: number | undefined;
  request_timeout_seconds?: number | undefined;
}

/**
 * Resolve the effective recall latency envelope from cascaded config.
 *
 * Pure and total: any absent/NaN/non-positive input falls back to the shipped
 * default rather than throwing, because this runs inside scaffold/reconcile
 * where a config typo must not brick an agent's memory install.
 *
 * Derivation and clamping, in order:
 *   1. hook ceiling := config ?? 12, clamped UP to MIN_RECALL_HOOK_TIMEOUT_SECONDS
 *      (a ceiling below headroom+1 admits no coherent deadline at all)
 *   2. parallel deadline := config ?? (ceiling - 2 headroom), then clamped to
 *      <= (ceiling - headroom). NOT merely <= ceiling: a deadline AT the
 *      ceiling is the zero-headroom configuration
 *      `hindsight-reranker-budget.test.ts` fails CI over — the hook is
 *      SIGKILLed mid-write and the turn loses both the memories and the
 *      telemetry row.
 *   3. per-bank timeout := config ?? 8, then clamped to <= parallel deadline
 *      (a per-bank timeout past the shared deadline can never fire)
 *
 * Post-condition, for EVERY input including the unusable ones:
 *   0 < request <= deadline  &&  hook - deadline >= RECALL_DEADLINE_HEADROOM_SECONDS
 */
export function resolveHindsightRecallTunables(
  recall: RecallTunableInput | undefined,
): HindsightRecallTunables {
  const clamps: string[] = [];

  const usable = (v: number | undefined): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

  let hookTimeoutSeconds =
    usable(recall?.hook_timeout_seconds) ?? DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS;
  if (hookTimeoutSeconds < MIN_RECALL_HOOK_TIMEOUT_SECONDS) {
    clamps.push(
      `memory.recall.hook_timeout_seconds ${hookTimeoutSeconds}s is below the minimum ` +
        `${MIN_RECALL_HOOK_TIMEOUT_SECONDS}s — raised to ${MIN_RECALL_HOOK_TIMEOUT_SECONDS}s ` +
        `(the fan-out deadline must be at least 1s AND leave ` +
        `${RECALL_DEADLINE_HEADROOM_SECONDS}s of post-deadline headroom, so a lower ` +
        `ceiling admits no usable envelope at all)`,
    );
    hookTimeoutSeconds = MIN_RECALL_HOOK_TIMEOUT_SECONDS;
  }

  // The largest deadline that still leaves the hook enough budget to format its
  // block, write the cache, and flush stdout after the fan-out is abandoned.
  // Equality with the ceiling is NOT allowed — see RECALL_DEADLINE_HEADROOM_SECONDS.
  const maxDeadline = hookTimeoutSeconds - RECALL_DEADLINE_HEADROOM_SECONDS;

  // Derived default keeps the ceiling/deadline coupling automatic: an operator
  // who raises ONLY the hook ceiling gets a proportionally larger fan-out
  // budget for free, which is the intuitive reading of that knob.
  let parallelDeadlineSeconds =
    usable(recall?.parallel_deadline_seconds) ?? maxDeadline;
  if (parallelDeadlineSeconds > maxDeadline) {
    clamps.push(
      `memory.recall.parallel_deadline_seconds ${parallelDeadlineSeconds}s leaves less ` +
        `than ${RECALL_DEADLINE_HEADROOM_SECONDS}s under hook_timeout_seconds ` +
        `${hookTimeoutSeconds}s — clamped to ${maxDeadline}s (Claude Code SIGKILLs the ` +
        `hook at the ceiling, so a deadline at or past it loses both the memories and ` +
        `the recall_log row that would have explained why)`,
    );
    parallelDeadlineSeconds = maxDeadline;
  }

  let requestTimeoutSeconds =
    usable(recall?.request_timeout_seconds) ?? DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS;
  if (requestTimeoutSeconds > parallelDeadlineSeconds) {
    clamps.push(
      `memory.recall.request_timeout_seconds ${requestTimeoutSeconds}s exceeds the ` +
        `effective parallel deadline ${parallelDeadlineSeconds}s — clamped to ` +
        `${parallelDeadlineSeconds}s (a per-bank timeout past the shared deadline can ` +
        `never fire)`,
    );
    requestTimeoutSeconds = parallelDeadlineSeconds;
  }

  return {
    hookTimeoutSeconds,
    parallelDeadlineSeconds,
    requestTimeoutSeconds,
    clamps,
  };
}

/**
 * The hook event whose timeout switchroom manages. Only the recall hook's
 * ceiling is a tuned knob; the retain/verify/session hooks keep the vendor's
 * values (they are off the pre-turn critical path).
 */
export const MANAGED_HOOK_EVENT = "UserPromptSubmit";

/** Marker identifying the recall hook command inside hooks.json. */
const RECALL_HOOK_COMMAND_MARKER = "recall.py";

/**
 * Pure renderer for the deployed `hooks/hooks.json`: given the vendor file's
 * raw text, return the post-stamp serialization (or `null` when the input is
 * not usable JSON, so callers leave a malformed vendor file alone rather than
 * making it worse — same failure posture as
 * `renderHindsightSettingsOverrides`).
 *
 * Only the UserPromptSubmit entry whose command references `recall.py` is
 * touched; every other hook and every other field is passed through
 * byte-for-byte via a structural round-trip. That keeps the stamp narrow, so a
 * future vendor bump that adds hooks needs no change here.
 */
export function renderHindsightHooksOverrides(
  raw: string,
  tunables: HindsightRecallTunables,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const hooks = root.hooks;
  if (hooks == null || typeof hooks !== "object") return null;
  const matchers = (hooks as Record<string, unknown>)[MANAGED_HOOK_EVENT];
  if (!Array.isArray(matchers)) return null;

  let stamped = false;
  for (const matcher of matchers) {
    if (matcher == null || typeof matcher !== "object") continue;
    const inner = (matcher as Record<string, unknown>).hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      if (hook == null || typeof hook !== "object") continue;
      const h = hook as Record<string, unknown>;
      if (typeof h.command !== "string") continue;
      if (!h.command.includes(RECALL_HOOK_COMMAND_MARKER)) continue;
      h.timeout = tunables.hookTimeoutSeconds;
      stamped = true;
    }
  }
  // A vendor bump that renames recall.py would silently leave the ceiling
  // unmanaged. Refuse to claim a stamp we did not make — the caller treats
  // null as "leave the file alone", and the doctor drift row reports the
  // resulting mismatch loudly instead of going quietly green.
  if (!stamped) return null;

  return JSON.stringify(root, null, 2) + "\n";
}

/**
 * Read the effective UserPromptSubmit recall-hook ceiling out of a deployed
 * `hooks.json`. Returns `null` when the file is malformed or carries no
 * recall hook. Used by the doctor drift row to compare installed vs expected.
 */
export function readHooksRecallTimeout(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const hooks = (parsed as Record<string, unknown> | null)?.hooks;
  if (hooks == null || typeof hooks !== "object") return null;
  const matchers = (hooks as Record<string, unknown>)[MANAGED_HOOK_EVENT];
  if (!Array.isArray(matchers)) return null;
  for (const matcher of matchers) {
    const inner = (matcher as Record<string, unknown> | null)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const h = hook as Record<string, unknown> | null;
      if (h == null || typeof h.command !== "string") continue;
      if (!h.command.includes(RECALL_HOOK_COMMAND_MARKER)) continue;
      return typeof h.timeout === "number" ? h.timeout : null;
    }
  }
  return null;
}
