/**
 * The `observation_scopes` values Hindsight accepts as a bare string.
 *
 * Server-side `MemoryItem.observation_scopes` is typed
 * `Literal["per_tag","combined","all_combinations","shared"] | list[list[str]]
 * | None`. The explicit list-of-lists tag matrix is deliberately NOT exposed as
 * a `switchroom.yaml` *pin* value: it is an unbounded per-memory matrix with no
 * safe fleet-wide default. It IS emitted on the wire — but computed per retain
 * by the plugin's `curated` strategy (`compute_observation_scopes`,
 * `vendor/hindsight-memory/scripts/lib/config.py`), which strips volatile
 * provenance tags and produces a `[[stable…]]` scope from the retain's own
 * tags. This enum is only the operator PIN surface, whose values override the
 * strategy; the matrix has no place there.
 *
 * This is the single TS source of truth, consumed by the zod enum in
 * `src/config/schema.ts` (both the per-agent and defaults/profile tiers).
 * The Python plugin keeps a paired copy
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
