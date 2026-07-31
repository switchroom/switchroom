/**
 * The `observation_scopes` values Hindsight accepts as a bare string.
 *
 * Server-side `MemoryItem.observation_scopes` is typed
 * `Literal["per_tag","combined","all_combinations","shared"] | list[list[str]]
 * | None`. The explicit list-of-lists tag matrix is deliberately NOT exposed
 * through switchroom config: it is an unbounded per-memory matrix with no safe
 * fleet-wide default and no caller here needs it.
 *
 * This is the single TS source of truth, consumed by the zod enum in
 * `src/config/schema.ts` (both the per-agent and defaults/profile tiers) and by
 * the handoff mirror's env-side resolve. The Python plugin keeps a paired copy
 * in `vendor/hindsight-memory/scripts/lib/config.py`
 * (`OBSERVATION_SCOPES_VALUES`) because it runs in the agent container with no
 * access to this module; widening the set means widening BOTH.
 *
 * Why an enum rather than a free string: the value is invisible after the
 * write. A typo would keep retaining happily — the engine would fall back to
 * its own default scope — and only surface months later as a bank whose
 * observations never merged. Cheap to reject at `switchroom apply`; expensive
 * to discover later.
 */
export const OBSERVATION_SCOPES = [
  "per_tag",
  "combined",
  "all_combinations",
  "shared",
] as const;

export type ObservationScope = (typeof OBSERVATION_SCOPES)[number];

/** Env var start.sh exports the scope through, when the operator set one. */
export const OBSERVATION_SCOPES_ENV = "HINDSIGHT_OBSERVATION_SCOPES";

/**
 * The `observationScopeStrategy` values the plugin's per-retain resolver
 * accepts — the selector that decides curated-vs-not, distinct from the pin
 * above. `curated` (the shipped default since #4035) strips volatile
 * provenance tags from each retain's consolidation scope; `shared` forces the
 * one global untagged scope; `combined` / `off` opt out entirely (emit no
 * per-row scope, restoring the pre-feature engine default). A manual
 * `observation_scopes` pin still wins over the strategy.
 *
 * Paired copy of `OBSERVATION_SCOPE_STRATEGIES` in
 * `vendor/hindsight-memory/scripts/lib/config.py` — that resolver runs in the
 * agent container with no access to this module, so widening the set means
 * widening BOTH. Same enum rationale as the pin: a typo is invisible after the
 * write, so `switchroom apply` rejecting it is the cheap catch.
 */
export const OBSERVATION_SCOPE_STRATEGIES = [
  "curated",
  "shared",
  "combined",
  "off",
] as const;

export type ObservationScopeStrategy =
  (typeof OBSERVATION_SCOPE_STRATEGIES)[number];

/** Env var start.sh exports the strategy through, when the operator set one. */
export const OBSERVATION_SCOPE_STRATEGY_ENV =
  "HINDSIGHT_OBSERVATION_SCOPE_STRATEGY";

/** Human-readable accepted set, for error messages. */
export function observationScopeStrategiesHint(): string {
  return OBSERVATION_SCOPE_STRATEGIES.join(", ");
}

export function isObservationScope(value: unknown): value is ObservationScope {
  return typeof value === "string" && (OBSERVATION_SCOPES as readonly string[]).includes(value);
}

/** Human-readable accepted set, for error messages. */
export function observationScopesHint(): string {
  return OBSERVATION_SCOPES.join(", ");
}

export type ObservationScopeResolution =
  | { kind: "unset" }
  | { kind: "set"; scope: ObservationScope }
  | { kind: "invalid"; raw: string };

/**
 * Classify one raw scope value.
 *
 * Absent or empty is `unset` — start.sh emits no export at all when the
 * operator set nothing, and an empty export is the plugin's existing idiom for
 * "hand authority back to the config". Anything off-list is reported as
 * `invalid` rather than coerced, so the caller can fail closed instead of
 * silently writing at a scope nobody asked for.
 */
export function classifyObservationScope(
  raw: string | undefined,
): ObservationScopeResolution {
  if (raw === undefined) return { kind: "unset" };
  const value = raw.trim();
  if (!value) return { kind: "unset" };
  if (!isObservationScope(value)) return { kind: "invalid", raw };
  return { kind: "set", scope: value };
}

/**
 * Resolve the scope for a caller that already holds the agent's CONFIG.
 *
 * The config wins outright; the env var is only the fallback for a caller that
 * has no config to read. That order matters: `switchroom handoff <agent>` is
 * registered as a Stop hook inside the container (where start.sh has exported
 * the var) but is ALSO runnable from the host, from `hostd agent_exec`, and by
 * hand while debugging — none of which inherit that export. Reading the env
 * first, or only, means those invocations see "unset" for an agent that is
 * configured to `shared` and POST the briefing at the engine default: one row
 * written at the wrong scope, invisible until the bank is inconsistent. Which
 * is the exact defect the per-row scope exists to prevent, relocated one level
 * out.
 *
 * `configured` is the value from `memory.observation_scopes` AFTER the
 * defaults/profile cascade (`resolveAgentConfig`), so a fleet-wide
 * `defaults.memory.observation_scopes` is honoured too. `undefined` means the
 * caller could not load the config at all (the sandboxed-container path, where
 * switchroom.yaml is not mounted) — only then does the env var speak.
 */
export function resolveObservationScope(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ObservationScopeResolution {
  if (configured !== undefined) return classifyObservationScope(configured);
  return classifyObservationScope(env[OBSERVATION_SCOPES_ENV]);
}

/** Read the configured scope out of an environment. Config-free callers only. */
export function resolveObservationScopeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObservationScopeResolution {
  return classifyObservationScope(env[OBSERVATION_SCOPES_ENV]);
}
