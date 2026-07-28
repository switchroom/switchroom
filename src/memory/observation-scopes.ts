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
 * Read the configured scope out of an environment.
 *
 * Absent or empty is `unset` — start.sh emits no export at all when the
 * operator set nothing, and an empty export is the plugin's existing idiom for
 * "hand authority back to the config". Anything off-list is reported as
 * `invalid` rather than coerced, so the caller can fail closed instead of
 * silently writing at a scope nobody asked for.
 */
export function resolveObservationScopeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ObservationScopeResolution {
  const raw = env[OBSERVATION_SCOPES_ENV];
  if (raw === undefined) return { kind: "unset" };
  const value = raw.trim();
  if (!value) return { kind: "unset" };
  if (!isObservationScope(value)) return { kind: "invalid", raw };
  return { kind: "set", scope: value };
}
