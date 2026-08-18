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

import { RECALL_PASSTHROUGH_DEFAULTS } from "./hindsight-recall-passthrough.js";

/** Vendor/shipped default for the UserPromptSubmit hook ceiling (seconds). */
export const DEFAULT_RECALL_HOOK_TIMEOUT_SECONDS = 12;

/**
 * switchroom smart-default for `recallMaxMemories` — the count cap on memories
 * injected per turn. The vendor ships 12 (`vendor/hindsight-memory/settings.json`
 * / `lib/config.py` DEFAULTS); switchroom tightens it to 8 (less prompt noise,
 * per the 2026-05-24 recall-quality audit). This is a count cap on the injected
 * set and is independent of `recallBudget` (which sets candidate DEPTH, not the
 * final head-slice). This is the
 * value stamped into the deployed settings.json when the operator sets no
 * `memory.recall.max_memories`, so it MUST equal what the fleet ran before this
 * became a stamped-from-cascade value or turning the stamp on would move
 * behaviour. Operators re-raise via `memory.recall.max_memories` in
 * switchroom.yaml, which start.sh also exports as HINDSIGHT_RECALL_MAX_MEMORIES.
 */
export const DEFAULT_RECALL_MAX_MEMORIES = 8;

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

/**
 * Vendor/shipped default for the per-bank recall HTTP timeout (seconds), kept
 * in lockstep with `lib/config.py`'s `DEFAULTS["recallRequestTimeoutSeconds"]`
 * and pinned by hindsight-reranker-budget.test.ts. #3757 raised it from a
 * hardcoded 8 after measuring that 8s fired on 96.8% of one agent's own-bank
 * recalls and returned the model nothing.
 *
 * Note this is a CEILING on the derived default, not the derived default
 * itself: with no operator config the request timeout resolves to the
 * effective parallel deadline (see `resolveHindsightRecallTunables`), because
 * the shared fan-out deadline is already the tighter outer guard and a
 * per-bank value above it can never bind.
 */
export const DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS = 12;

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
 * The two recall CAPS stamped into the deployed settings.json — the count cap
 * (`recallMaxMemories`) and the injected-block token budget (`recallMaxTokens`).
 *
 * These are NOT part of the latency envelope above; they are a separate pair,
 * broken out so `applyHindsightSettingsOverrides` (the stamp) and
 * `detectHindsightRecallTunableDrift` (the doctor check) resolve them from the
 * SAME cascade input and cannot disagree. Before this, `recallMaxMemories` was a
 * hardcoded `8` literal in scaffold.ts and `recallMaxTokens` was never stamped
 * at all — so an operator who set `memory.recall.max_memories`/`.max_tokens` in
 * switchroom.yaml got the value only via the start.sh env export (which wins at
 * runtime), while settings.json silently kept 8/1024. Any hindsight invocation
 * that did NOT inherit that env (a docker-exec'd retain/backfill, or the plugin
 * before the export ran) then reverted to 8/1024, and `switchroom doctor` was
 * blind to the split. Stamping from the cascade closes both gaps.
 */
export interface HindsightRecallCaps {
  /** Count cap on injected memories, stamped into settings.json. */
  maxMemories: number;
  /** Token budget for the injected block, stamped into settings.json. */
  maxTokens: number;
}

/** The `memory.recall.*` subset the caps resolver reads (post-cascade). */
export interface RecallCapInput {
  max_memories?: number | undefined;
  max_tokens?: number | undefined;
}

/**
 * Resolve the recall caps from cascaded config, mirroring the start.sh export
 * source exactly:
 *
 *   - `max_memories` → HINDSIGHT_RECALL_MAX_MEMORIES (start.sh.hbs), default
 *     {@link DEFAULT_RECALL_MAX_MEMORIES} (8) when unset. start.sh exports this
 *     one CONDITIONALLY (only when the operator set it), so when unset the
 *     settings.json stamp is the sole authority and MUST carry the switchroom
 *     smart-default.
 *   - `max_tokens` → HINDSIGHT_RECALL_MAX_TOKENS, resolved through the recall
 *     passthrough whose default is {@link RECALL_PASSTHROUGH_DEFAULTS}.maxTokens
 *     (1024, the vendor settings.json value). Matching that keeps an unset agent
 *     byte-identical.
 *
 * Pure and total like `resolveHindsightRecallTunables`: any absent/NaN/non-positive
 * input falls back to the default rather than throwing, so a config typo cannot
 * brick an agent's memory install at scaffold time.
 */
export function resolveHindsightRecallCaps(
  recall: RecallCapInput | undefined,
): HindsightRecallCaps {
  // `min` is the smallest value that is meaningful for the key: max_memories
  // admits 0 (start.sh.hbs documents `0` as "disable the cap entirely", and
  // start.sh exports it verbatim, so the settings.json stamp must match), while
  // max_tokens is a token budget with a schema floor of 1.
  const usable = (v: number | undefined, min: number): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : undefined;
  return {
    maxMemories: usable(recall?.max_memories, 0) ?? DEFAULT_RECALL_MAX_MEMORIES,
    maxTokens: usable(recall?.max_tokens, 1) ?? RECALL_PASSTHROUGH_DEFAULTS.maxTokens,
  };
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

  // Unset, the per-bank timeout DERIVES from the deadline rather than taking
  // the vendor literal. The shared fan-out deadline is already the tighter
  // outer guard (#3757), so a per-bank value above it can never fire — and
  // taking the vendor's 12 against the shipped deadline of 10 would push every
  // stock agent through the clamp below, reporting a "clamp" on a config the
  // operator never wrote. Deriving keeps the stock resolution clamp-free while
  // preserving the intent: per-bank is the safety net, not the budget.
  let requestTimeoutSeconds =
    usable(recall?.request_timeout_seconds) ??
    Math.min(DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS, parallelDeadlineSeconds);
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

/** Marker identifying the async prefetch-producer hook command in hooks.json. */
const PREFETCH_HOOK_COMMAND_MARKER = "prefetch.py";

/**
 * Vendor/shipped async ceiling for the Stop-hook prefetch producer (seconds).
 * Claude Code kills the async `prefetch.py` Stop hook at this bound — the
 * "20s-timeout prefetch" the M4 carve names.
 */
export const DEFAULT_PREFETCH_ASYNC_TIMEOUT_SECONDS = 20;

/**
 * Upper bound on a sane prefetch async ceiling. A Stop hook that can run this
 * long holds a background slot for the whole window if the producer wedges;
 * beyond it the "wedged 20s prefetch" becomes a multi-minute wedge. Matches
 * the session_start async hook's own 30s ceiling.
 */
export const MAX_PREFETCH_ASYNC_TIMEOUT_SECONDS = 30;

/** The observed shape of the prefetch Stop hook in a deployed hooks.json. */
export interface PrefetchHookShape {
  /** A Stop hook whose command references prefetch.py is registered. */
  present: boolean;
  /** That hook carries `"async": true`. */
  async: boolean;
  /** Its timeout in seconds, or null when absent / non-numeric. */
  timeout: number | null;
}

/**
 * Read the async prefetch producer's Stop-hook shape out of a deployed
 * `hooks.json` (M4 deviation-5). Scans the Stop matchers for the entry whose
 * command references `prefetch.py` and reports whether it is registered,
 * marked `"async": true`, and its timeout ceiling. Never throws — malformed
 * JSON or a missing hook yields `{present:false,...}` so the caller can treat
 * absence as "nothing to validate" rather than a crash.
 */
export function readHooksPrefetchAsyncTimeout(raw: string): PrefetchHookShape {
  const absent: PrefetchHookShape = { present: false, async: false, timeout: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return absent;
  }
  const hooks = (parsed as Record<string, unknown> | null)?.hooks;
  if (hooks == null || typeof hooks !== "object") return absent;
  const matchers = (hooks as Record<string, unknown>).Stop;
  if (!Array.isArray(matchers)) return absent;
  for (const matcher of matchers) {
    const inner = (matcher as Record<string, unknown> | null)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const h = hook as Record<string, unknown> | null;
      if (h == null || typeof h.command !== "string") continue;
      if (!h.command.includes(PREFETCH_HOOK_COMMAND_MARKER)) continue;
      return {
        present: true,
        async: h.async === true,
        timeout: typeof h.timeout === "number" ? h.timeout : null,
      };
    }
  }
  return absent;
}

/**
 * Validate the async prefetch producer's timeout envelope (M4 deviation-5).
 * Returns a list of human-readable problems; empty means the async-timeout
 * config is coherent. Detects the ways a prefetch can WEDGE a turn:
 *
 *   - the Stop hook is missing entirely (nothing to reap),
 *   - it is NOT `async`, so it blocks every turn's completion for its timeout,
 *   - it has no positive timeout, so a wedged producer is never killed,
 *   - the timeout exceeds {@link MAX_PREFETCH_ASYNC_TIMEOUT_SECONDS}, or
 *   - the producer's own recall timeout (`memoryPrefetchTimeoutSeconds`) meets
 *     or exceeds the hook ceiling, so the producer can outlive its hook and be
 *     SIGKILLed mid buffer-write, leaving a torn buffer.
 */
export function validatePrefetchAsyncTimeout(
  shape: PrefetchHookShape,
  prefetchRecallTimeoutSeconds: number,
): string[] {
  const problems: string[] = [];
  if (!shape.present) {
    problems.push(
      "hooks/hooks.json registers no Stop hook for prefetch.py (the async " +
        "recall-prefetch producer)",
    );
    return problems; // nothing further is checkable
  }
  if (!shape.async) {
    problems.push(
      'the prefetch.py Stop hook is not marked `"async": true` — a synchronous ' +
        "prefetch blocks every turn's completion for up to its timeout",
    );
  }
  if (shape.timeout === null || shape.timeout <= 0) {
    problems.push(
      "the prefetch.py Stop hook has no positive `timeout` (async ceiling) — a " +
        "wedged producer would never be reaped",
    );
    return problems; // the numeric comparisons below need a real ceiling
  }
  if (shape.timeout > MAX_PREFETCH_ASYNC_TIMEOUT_SECONDS) {
    problems.push(
      `the prefetch.py async ceiling is ${shape.timeout}s, above the ` +
        `${MAX_PREFETCH_ASYNC_TIMEOUT_SECONDS}s maximum — a wedged producer holds a ` +
        `background slot for that long`,
    );
  }
  if (prefetchRecallTimeoutSeconds >= shape.timeout) {
    problems.push(
      `memoryPrefetchTimeoutSeconds ${prefetchRecallTimeoutSeconds}s is >= the ` +
        `${shape.timeout}s async hook ceiling — the producer's own recall can outlive ` +
        `its hook and be SIGKILLed mid buffer-write, leaving a torn buffer`,
    );
  }
  return problems;
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
