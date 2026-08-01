/**
 * LiteLLM virtual-key model allowlists — declarative, reconciled on apply.
 *
 * ── The bug this exists to make impossible ──────────────────────────────────
 *
 * A LiteLLM virtual key carries a `models` allowlist. The proxy enforces it at
 * REQUEST AUTH time, on the model the caller asked for: a call to a group that
 * is not on the list is rejected with `key not allowed to access model` before
 * it ever reaches a deployment.
 *
 * That allowlist lived NOWHERE declarative. It was set imperatively via
 * `POST /key/update` and stored in the proxy's Postgres `LiteLLM_VerificationToken`
 * row — not in `litellm-config.yaml`, not in `switchroom.yaml`, not in the
 * vault. So:
 *
 *  - a proxy DB rebuild/restore silently reverts it;
 *  - `switchroom apply` never noticed, because the hindsight branch
 *    short-circuited on "a key exists in the vault" and validated nothing else;
 *  - and the failure is SILENT in the only way that matters — the lane simply
 *    produces no traffic. On 2026-07-26 `gpt-oss-20b-retain` and
 *    `gpt-oss-20b-consolidation` were declared in `switchroom.yaml` and served
 *    by the proxy, but absent from the hindsight key's allowlist. Every request
 *    to them was rejected at auth. They had ZERO calls since creation: not
 *    unused, UNREACHABLE.
 *
 * ── The declarative home ────────────────────────────────────────────────────
 *
 * `switchroom.yaml` already declares exactly which model groups hindsight
 * calls, in `hindsight.llm.model` and the per-op `retain` / `reflect` /
 * `consolidation` `.model` overrides. That IS the declaration; it was simply
 * never projected onto the key. {@link requiredKeyModels} derives the required
 * allowlist from it and `switchroom apply` reconciles the key to match, exactly
 * as it already reconciles a key's TEAM binding against the config-declared
 * team. Idempotent, restored automatically, and no new file to keep in sync.
 *
 * ── What is NOT required, and how that was verified ─────────────────────────
 *
 * Router-level fallback targets do NOT need to be on the allowlist. Verified in
 * the running proxy (LiteLLM v1.91.0):
 *   - `can_key_call_model` (`litellm/proxy/auth/auth_checks.py:2959`) is called
 *     from `litellm/proxy/auth/user_api_key_auth.py:2690` — the REQUEST-auth
 *     path, against the model the client asked for.
 *   - The router's fallback dispatch does not re-enter that path.
 *     `Router._filter_deployments_by_model_access_groups` (`router.py:10052`)
 *     is the only allowlist-aware code on the routing side and it returns the
 *     candidates unchanged whenever the requested model is directly allowed.
 * So the allowlist stays as narrow as the config: a granted model is one the
 * config actually names.
 *
 * ── Provider prefixes ───────────────────────────────────────────────────────
 *
 * Config names a model the way hindsight's LiteLLM SDK client wants it —
 * `openai/gpt-oss-20b-retain` — but the SDK splits the leading provider off and
 * sends `gpt-oss-20b-retain` to the proxy, which is the name the allowlist is
 * checked against. Verified against `LiteLLM_SpendLogs` on 2026-07-26: the
 * `model` column records bare `gpt-oss-20b-retain` / `gpt-oss-20b-consolidation`
 * for exactly these calls, while other callers that genuinely send a prefixed
 * id record it prefixed (`openrouter/openai/gpt-oss-20b`).
 *
 * Rather than encode a prefix-stripping RULE — which is the kind of guess that
 * fails silently a year later when a provider is added — {@link modelCandidates}
 * offers BOTH spellings and everything downstream intersects them with the
 * groups the proxy ACTUALLY advertises (`/v1/models`). A name the proxy does
 * not serve is never granted and never demanded, so a wrong guess degrades to
 * "no opinion" instead of to a bogus failure or an over-broad grant.
 *
 * ── WHICH key, and why that is not obvious ──────────────────────────────────
 *
 * There are TWO distinct virtual keys in play for hindsight, and reconciling
 * the wrong one is a false OK on exactly the failure this module exists to
 * catch:
 *
 *  - The vault entry `litellm/hindsight/api-key`, provisioned by `apply`. It is
 *    injected as the bearer in `ANTHROPIC_CUSTOM_HEADERS`
 *    (`src/setup/hindsight.ts`), i.e. it authenticates the **claude-code**
 *    passthrough lane.
 *  - `hindsight.llm.<op>.api_key` from `switchroom.yaml`, emitted as
 *    `HINDSIGHT_API_<OP>_LLM_API_KEY`. THAT is the key the container presents on
 *    a `provider: litellm` op — the only lane `can_key_call_model` ever sees.
 *
 * Nothing keeps them equal, and on the fleet this module was written against
 * they were already different keys. So the demand is expressed per KEY:
 * {@link requiredKeyDemands} groups the derived lanes by the api_key the op is
 * configured to present.
 *
 * And a `provider: litellm` op that declares NO `api_key` is a third case, not
 * a synonym for the first: it presents no credential at all (see
 * {@link RequiredKeyModel.apiKeyRef}). Treating it as "use the service key"
 * would reconcile — and could FAIL doctor on — a key that lane never sends,
 * which is the same wrong-key mistake in the other direction. It warns instead.
 */

import type { SwitchroomConfig } from "../config/schema.js";

/**
 * A model group the config requires a given key to be able to call.
 */
export interface RequiredKeyModel {
  /** The model group name as the proxy knows it (an id from `/v1/models`). */
  group: string;
  /** The value as written in config, for the operator-facing message. */
  configured: string;
  /** Which config key asked for it, e.g. `hindsight.llm.retain`. */
  consumer: string;
  /**
   * The api_key this op is configured to PRESENT, verbatim from
   * `hindsight.llm.<op>.api_key` (so possibly a `vault:` reference — resolving
   * it is the caller's job, because only the caller knows whether it holds a
   * broker handle or a passphrase).
   *
   * `null` when the op declares none AND no global `hindsight.llm.api_key`
   * exists to inherit — and that means UNKNOWN, not "the provisioned service
   * key". Since #3687 the global `hindsight.llm` block DOES carry an optional
   * `api_key`, emitted as `HINDSIGHT_API_LLM_API_KEY`; hindsight reads it as the
   * `os.getenv(ENV_LLM_API_KEY)` fallback for any op that emits no per-op key.
   * So `requiredKeyModels` resolves a per-op omission to `?? llm.api_key` — a
   * lane is `null` only when neither the op nor the global declares a key. The
   * provisioned vault key is NOT it either: `src/setup/hindsight.ts` injects
   * that key solely as the `ANTHROPIC_CUSTOM_HEADERS` bearer for the CLAUDE-CODE
   * passthrough, which is a lane `can_key_call_model` never sees.
   *
   * So a `provider: litellm` lane with no per-op AND no global `api_key`
   * presents no credential this module can name, and no allowlist grant can fix
   * it. Callers must degrade to a warning rather than reconciling or failing
   * some other key on its behalf — blaming a key the lane does not present is
   * the same false-attribution bug this module exists to remove.
   */
  apiKeyRef: string | null;
}

/**
 * Both spellings a configured model value could reach the proxy as: the value
 * verbatim, and the value with its leading provider segment removed.
 *
 * `openai/gpt-oss-20b-retain` → `["openai/gpt-oss-20b-retain", "gpt-oss-20b-retain"]`
 * `gpt-oss-20b`               → `["gpt-oss-20b"]`
 * `openrouter/openai/gpt-oss-20b` → `["openrouter/openai/gpt-oss-20b", "openai/gpt-oss-20b"]`
 *
 * Only ONE segment is stripped: `openrouter/openai/x` is a real proxy model id
 * in this fleet, so stripping greedily would invent names that mean something
 * else. Order is significant — verbatim first, so an exact match wins.
 */
export function modelCandidates(configured: string): string[] {
  const trimmed = configured.trim();
  if (trimmed.length === 0) return [];
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return [trimmed];
  return [trimmed, trimmed.slice(slash + 1)];
}

/**
 * Resolve a configured model value to the group the PROXY serves, or null when
 * the proxy serves neither spelling.
 *
 * Returning null is deliberately not an error here: "the proxy does not list
 * this model at all" is a different defect with a different owner and a much
 * better message (`validateModelReferences` / #3407). This module only answers
 * "of the groups that DO exist, which does this key need?".
 */
export function resolveGroup(configured: string, proxyModels: ReadonlySet<string>): string | null {
  for (const candidate of modelCandidates(configured)) {
    if (proxyModels.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Derive the model groups the HINDSIGHT service key must be allowed to call,
 * from `switchroom.yaml`.
 *
 * Scope is the hindsight LLM config only — global `hindsight.llm.model` plus
 * the per-op `retain` / `reflect` / `consolidation` overrides — because that is
 * what the single `litellm/hindsight/api-key` key is used for. Per-agent keys
 * are separate keys with their own references and are not covered here.
 *
 * Only ops actually routed through the proxy count. An op pinned to
 * `provider: claude-code` reaches Anthropic through the OAuth passthrough with
 * the caller's own header, never the virtual key, so demanding an allowlist
 * entry for it would be a false positive (`consolidation` sat in exactly that
 * state for three days in July 2026).
 *
 * Returns [] when the fleet carve-out is off — with no proxy there is no key.
 * Never throws.
 */
export function requiredKeyModels(
  config: SwitchroomConfig,
  proxyModels: ReadonlySet<string>,
): RequiredKeyModel[] {
  if (config.litellm?.enabled !== true) return [];
  if (config.memory?.backend !== "hindsight") return [];

  const llm = config.hindsight?.llm;
  if (!llm) return [];

  const globalProvider = llm.provider;
  const out: RequiredKeyModel[] = [];

  const consider = (
    configured: string | undefined,
    provider: string | undefined,
    apiKey: string | undefined,
    consumer: string,
  ) => {
    if (!configured) return;
    // An op inheriting the global provider inherits its routing too.
    if ((provider ?? globalProvider) !== "litellm") return;
    const group = resolveGroup(configured, proxyModels);
    if (group === null) return;
    const ref = apiKey?.trim();
    out.push({
      group,
      configured: configured.trim(),
      consumer,
      apiKeyRef: ref && ref.length > 0 ? ref : null,
    });
  };

  // Deliberately NO dedup. Each call site passes a distinct `consumer`, and a
  // group demanded by two consumers is a finding that has to name both, so
  // there was never a duplicate to collapse here — `unreachableModels` does the
  // collapsing, by group, at report time.
  // The global op presents the global `hindsight.llm.api_key` (#3687). A per-op
  // op with no `api_key` inherits the same global credential — the engine reads
  // `HINDSIGHT_API_LLM_API_KEY` as the fallback — so we resolve `?? llm.api_key`
  // rather than treating a per-op omission as "presents nothing".
  const globalKey = llm.api_key;
  consider(llm.model, llm.provider, globalKey, "hindsight.llm.model (global)");
  consider(
    llm.retain?.model,
    llm.retain?.provider,
    llm.retain?.api_key ?? globalKey,
    "hindsight.llm.retain",
  );
  consider(
    llm.reflect?.model,
    llm.reflect?.provider,
    llm.reflect?.api_key ?? globalKey,
    "hindsight.llm.reflect",
  );
  consider(
    llm.consolidation?.model,
    llm.consolidation?.provider,
    llm.consolidation?.api_key ?? globalKey,
    "hindsight.llm.consolidation",
  );

  return out;
}

/**
 * What a key's `models` allowlist lets us conclude.
 *
 * This has to mirror what the proxy ACTUALLY enforces, because a checker that
 * is stricter than the thing it checks does not produce a safe error — it
 * produces false FAILs, which is the fastest way to train an operator to ignore
 * the check. Read out of the running proxy (LiteLLM v1.91.0,
 * `litellm/proxy/auth/auth_checks.py`), the decision is
 * `_check_model_access_helper` (`:2808`) fed by
 * `_resolve_key_models_for_auth_check` (`:2940`):
 *
 *  - `[]` → unrestricted (`len(filtered_models) == 0 and len(models) == 0`).
 *  - `"*"` → unrestricted (`"*" in filtered_models`).
 *  - `"all-proxy-models"` → unrestricted (`SpecialModelNames.all_proxy_models`).
 *  - `"all-team-models"` → NEITHER, and it DOMINATES the rest of the list. The
 *    resolver does not merge, it REPLACES: `if all_team_models in models:
 *    return [] if team_id is None else team_models`. So `["*",
 *    "all-team-models"]` is NOT unrestricted — the `"*"` is discarded and the
 *    team's (possibly narrow) list decides. This module reads the key row only
 *    and cannot see `team_id`/`team_models`, so the honest answer whenever the
 *    sentinel appears is "cannot tell from here", and both callers degrade to
 *    no-opinion rather than guessing. Guessing "restricted" would FAIL a
 *    healthy fleet; guessing "unrestricted" would hide the very defect this
 *    check exists for. Hence the sentinel is tested FIRST below — testing it
 *    after `"*"` reproduces the proxy's behaviour backwards.
 *  - anything containing `*` → a WILDCARD PATTERN matched per model, not a
 *    literal (see {@link allowlistCovers}).
 */
export type AllowlistPosture = "unrestricted" | "restricted" | "indeterminate";

/** LiteLLM `SpecialModelNames` values meaning "no per-key restriction". */
const UNRESTRICTED_SENTINELS = new Set(["*", "all-proxy-models"]);

/**
 * The sentinel that delegates to the TEAM's allowlist, which is not on the key
 * row this module can see. `litellm/proxy/_types.py SpecialModelNames`.
 */
const TEAM_DELEGATING_SENTINEL = "all-team-models";

/** Classify a key's `models` allowlist. See {@link AllowlistPosture}. */
export function classifyAllowlist(models: readonly string[]): AllowlistPosture {
  if (models.length === 0) return "unrestricted";
  // FIRST, because the proxy's resolver REPLACES the list with the team's when
  // this sentinel is present — every other entry, `"*"` included, is discarded.
  if (models.includes(TEAM_DELEGATING_SENTINEL)) return "indeterminate";
  if (models.some((m) => UNRESTRICTED_SENTINELS.has(m))) return "unrestricted";
  return "restricted";
}

/**
 * Is a key's `models` allowlist unrestricted?
 *
 * Thin wrapper over {@link classifyAllowlist} kept for call sites that only
 * need the happy-path phrasing. NOTE it is deliberately false for
 * `all-team-models`: that is `indeterminate`, not unrestricted, and a caller
 * that must not guess should branch on `classifyAllowlist` instead.
 */
export function isUnrestrictedAllowlist(models: readonly string[]): boolean {
  return classifyAllowlist(models) === "unrestricted";
}

/**
 * Does an allowlist entry cover `group`?
 *
 * An entry containing `*` is a pattern, not a literal: LiteLLM builds
 * `^<entry with * → .*>$` and `re.match`es it
 * (`is_model_allowed_by_pattern`, `auth_checks.py:4277`; an entry qualifies as
 * a pattern iff it contains `*` — `_is_wildcard_pattern`, `:4346`).
 *
 * One deliberate divergence: every regex metacharacter EXCEPT `*` is escaped
 * here, where LiteLLM interpolates the entry raw. That makes this strictly
 * NARROWER than the proxy (a literal `.` stays a literal `.`), which is the
 * only safe direction for a checker — it can under-claim coverage and warn, but
 * it can never claim a lane is reachable when the proxy would reject it. It
 * also cannot throw on an entry like `gpt-4(o)*`, which raw interpolation
 * would.
 */
export function allowlistCovers(allowlist: readonly string[], group: string): boolean {
  for (const entry of allowlist) {
    if (entry === group) return true;
    if (!entry.includes("*")) continue;
    const pattern = entry
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    if (new RegExp(`^${pattern}$`).test(group)) return true;
  }
  return false;
}

/** A required group that the key cannot currently reach. */
export interface UnreachableModel {
  group: string;
  configured: string;
  consumers: string[];
}

/**
 * The required groups that are NOT on the key's allowlist — i.e. every lane the
 * config declares but the key would be rejected on at auth.
 *
 * Returns [] for anything other than a `restricted` allowlist: an unrestricted
 * key reaches everything, and an `indeterminate` one (`all-team-models`) hides
 * its effective list behind a team row this module cannot read, so claiming a
 * lane is unreachable would be a fabrication. See {@link classifyAllowlist}.
 *
 * Membership is wildcard-aware ({@link allowlistCovers}), matching the proxy.
 * Stable first-seen order; never throws.
 */
export function unreachableModels(
  required: readonly RequiredKeyModel[],
  allowlist: readonly string[],
): UnreachableModel[] {
  if (classifyAllowlist(allowlist) !== "restricted") return [];
  const byGroup = new Map<string, UnreachableModel>();
  for (const r of required) {
    if (allowlistCovers(allowlist, r.group)) continue;
    const existing = byGroup.get(r.group);
    if (existing) {
      if (!existing.consumers.includes(r.consumer)) existing.consumers.push(r.consumer);
    } else {
      byGroup.set(r.group, {
        group: r.group,
        configured: r.configured,
        consumers: [r.consumer],
      });
    }
  }
  return [...byGroup.values()];
}

/**
 * The allowlist to write back, or null when the key already reaches everything
 * the config declares.
 *
 * UNION, never truncate. The key may legitimately carry groups switchroom does
 * not manage — an operator grant, another consumer sharing the key, a lane
 * mid-migration. Reconciliation's job is to guarantee the config-declared lanes
 * are reachable, not to assert exclusive ownership of the key. Truncating to
 * exactly the derived set would turn a routine `apply` into an outage for
 * whatever else was on it.
 *
 * (This is the one place this differs from the TEAM-binding reconciliation it
 * otherwise mirrors: a key has exactly one team, so config can be authoritative
 * there; a key has many models, so config can only be additive here.)
 *
 * Output is sorted for a stable, diffable request body.
 *
 * Returns null for an `indeterminate` (`all-team-models`) allowlist too, and
 * that one is load-bearing rather than merely cautious: the proxy REPLACES the
 * whole list with the team's before comparing
 * (`_resolve_key_models_for_auth_check`, `auth_checks.py:2940`), so appended
 * groups would be silently discarded — the write would report "granted" while
 * granting nothing.
 */
export function reconciledAllowlist(
  allowlist: readonly string[],
  required: readonly RequiredKeyModel[],
): string[] | null {
  if (classifyAllowlist(allowlist) !== "restricted") return null;
  const missing = unreachableModels(required, allowlist);
  if (missing.length === 0) return null;
  return [...new Set([...allowlist, ...missing.map((m) => m.group)])].sort();
}

/** Every lane one particular virtual key is required to be able to reach. */
export interface KeyDemand {
  /**
   * The api_key the config says these ops present, verbatim (possibly a
   * `vault:` reference). `null` ⇒ no op declared one, which is UNKNOWN rather
   * than the provisioned service key — see {@link RequiredKeyModel.apiKeyRef}.
   * Callers must warn on a `null` demand, not reconcile or fail another key.
   */
  apiKeyRef: string | null;
  /** Config paths that named this key, for the operator-facing message. */
  declaredBy: string[];
  /** The lanes this key must reach. */
  required: RequiredKeyModel[];
}

/**
 * Group derived lanes by the KEY that has to reach them.
 *
 * The reason this is not just `requiredKeyModels`: hindsight presents the
 * per-op `hindsight.llm.<op>.api_key` on a `provider: litellm` op, and only
 * falls back to the provisioned `litellm/hindsight/api-key` when config names
 * none. Reconciling or checking one key when the caller presents another is a
 * false OK on exactly the silent-unreachable-lane failure this module exists to
 * remove — so the unit of work is (key, lanes), not (lanes).
 *
 * Order is stable: fallback-key demand first if present, then by first
 * appearance. Never throws.
 */
export function requiredKeyDemands(required: readonly RequiredKeyModel[]): KeyDemand[] {
  const byKey = new Map<string | null, KeyDemand>();
  for (const r of required) {
    const existing = byKey.get(r.apiKeyRef);
    if (existing) {
      existing.required.push(r);
      if (!existing.declaredBy.includes(r.consumer)) existing.declaredBy.push(r.consumer);
    } else {
      byKey.set(r.apiKeyRef, {
        apiKeyRef: r.apiKeyRef,
        declaredBy: [r.consumer],
        required: [r],
      });
    }
  }
  return [...byKey.values()];
}
