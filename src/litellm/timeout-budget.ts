/**
 * Paired timeout budgets for the LiteLLM proxy chain — DERIVED, never hand-set.
 *
 * ── The bug this exists to make impossible ──────────────────────────────────
 *
 * A hindsight LLM call crosses three deadlines stacked inside each other:
 *
 *   plugin ──POST /retain──▶ hindsight ──chat/completions──▶ litellm ──▶ upstream
 *          (client deadline)          (per-call LLM timeout)      (per-deployment
 *                                                                  timeout, ×2:
 *                                                                  local then
 *                                                                  fallback)
 *
 * LiteLLM's router fallback is *inside* one client request: hindsight issues a
 * single POST with a single timeout, and litellm may spend `localTimeoutS` on
 * the primary group, fail, and then spend `fallbackTimeoutS` on the fallback
 * group — all under that one client deadline. So the invariant is not
 * `local < client`, it is:
 *
 *   localTimeoutS + fallbackTimeoutS + MARGIN  <=  clientBudgetS
 *
 * Violate it and the fallback hop can NEVER complete: the client hangs up
 * mid-fallback, every failover becomes a guaranteed error, and litellm keeps
 * the upstream slot (and, on a metered provider, the meter) running against a
 * request nobody is waiting for.
 *
 * This has now happened twice, in both directions:
 *
 *  - **2026-07-25 (#3611)** moved the retain CLIENT budget to a derived value
 *    (`ceil(16384 / 80.6) = 204s`) without moving the litellm-side halves,
 *    which were `local 200 + fallback 90 = 290`. 290 > 204: the retain
 *    OpenRouter fallback had 4s of headroom and could never finish.
 *  - **2026-07-26** raised the interactive fallback hop 25s → 60s, giving
 *    `local 90 + fallback 60 = 150` against hindsight's 120s default client
 *    timeout (`DEFAULT_LLM_TIMEOUT`, `hindsight_api/config.py:733`). Same
 *    defect, other lane.
 *
 * Both times the config carried a correct comment saying "both halves must
 * move together" and both times a half moved alone. A comment is not a
 * mechanism. {@link assertClientBudget} is.
 *
 * ── Source of truth ─────────────────────────────────────────────────────────
 *
 * The per-deployment timeouts live in the operator-maintained LiteLLM proxy
 * config, which is OUTSIDE this repo at runtime
 * (`/data/coolify/services/<id>/litellm-config.yaml`; the repo copy at
 * `docker/litellm-proxy/litellm-config.yaml` is the reviewed upstream of it).
 * Nothing in a container can read that file, so the derivation cannot read it
 * either.
 *
 * Therefore: **switchroom declares the tiers here, and this declaration is
 * authoritative.** Every client budget switchroom emits is computed from it, so
 * the two halves are one number by construction. Drift between this declaration
 * and the live proxy config is caught separately and loudly by
 * {@link detectLitellmTimeoutDrift}, wired into the on-host fleet-health
 * sensor — the same division of labour CLAUDE.md documents for the I2
 * OAuth-leak guard (an in-repo check that is vacuous off-host, plus an on-host
 * sensor that is load-bearing).
 *
 * Changing a timeout in the live proxy config WITHOUT changing the matching
 * number here is a supported operation in the sense that it will not silently
 * break: the sensor reports it. It is not supported in the sense that it should
 * ever be left that way.
 */

/**
 * Slack added on top of the litellm chain before the client may hang up.
 *
 * The chain arithmetic (`local + fallback`) accounts only for time spent
 * waiting on upstreams. It does not account for litellm's own work inside the
 * request: routing/deployment selection, connection setup on the fallback hop,
 * response assembly, and logging callbacks. 10s covers that on the observed
 * fleet and keeps the derived budgets at round, reviewable numbers.
 *
 * Corroboration that 10 is the right size, not a guess: it is the value that
 * makes the interactive lane derive to exactly 160s (90 + 60 + 10), which is
 * independently the budget Ken set for that lane on 2026-07-26.
 *
 * NOT covered, and deliberately so: the fleet pacer's admission delay. The
 * pacer (`docker/litellm-pacer/custom_pacing.py`) holds a request only when its
 * model group matches `PACE_MODEL_GROUPS` — default `claude-*,sonnet,fable` —
 * and no `gpt-oss-20b*` group in {@link LITELLM_TIMEOUT_TIERS} matches it, so
 * no tier declared here is ever paced. That is load-bearing rather than
 * incidental: `PACE_MAX_WAIT_S` alone defaults to 20s, twice this margin, and
 * the hard backstop is clamped as high as `_PACE_WATCHDOG_SAFE_CEILING_S`
 * (280s). If a `gpt-oss-*` group is ever added to that allowlist, this margin
 * is no longer sufficient and every tier below has to grow to cover the hold.
 */
export const LITELLM_ROUTER_MARGIN_S = 10;

/**
 * One role's litellm routing tier: the primary model group and the
 * router-level fallback it hops to, with the per-deployment timeout on each.
 *
 * `localTimeoutS` is named for the common case (the primary group is the pair
 * of local Ollama boxes) but is simply "the timeout on the primary group" — it
 * is correct even when the primary is remote.
 */
export interface LitellmTimeoutTier {
  /** Primary model group name, as it appears in `model_list[].model_name`. */
  readonly group: string;
  /** Per-deployment `timeout` on every deployment in {@link group}. */
  readonly localTimeoutS: number;
  /**
   * Router-level fallback target for {@link group}, from
   * `router_settings.fallbacks`. `null` when the group has no fallback — the
   * chain is then just {@link localTimeoutS}.
   */
  readonly fallbackGroup: string | null;
  /** Per-deployment `timeout` on the fallback group. 0 when there is none. */
  readonly fallbackTimeoutS: number;
}

/**
 * The declared tiers, vendored from the live LiteLLM config on 2026-07-26.
 *
 * Each number is cited to the reasoning that produced it. None of them is a
 * value this module chose — they are the operator's routing decisions, recorded
 * here so the client budgets can be derived from them.
 */
export const LITELLM_TIMEOUT_TIERS = {
  /**
   * Interactive lane — `recall`, `reflect`, and the default hindsight LLM
   * config. A person is waiting, so it fails fast.
   *
   * local 90s: the largest value that is both above the observed local max
   * (72.1s, n=77, 2026-07-25) and inside the fallback budget. 45s was tried on
   * 2026-07-25 and reverted — it severed ~8% of calls that were succeeding.
   *
   * fallback 60s: raised from 25s on 2026-07-26. At 25s the tier NEVER
   * completed (5,184 read timeouts in 24h). 60s was chosen over dropping the
   * local half to 60 because measured interactive reflect durations (n=36 over
   * 24h) are p95 82.9s / p99 95.5s / max 118.2s — 19.4% exceed 60s, so a 60s
   * local half would break reflect for a fifth of calls.
   */
  interactive: {
    group: "gpt-oss-20b",
    localTimeoutS: 90,
    fallbackGroup: "gpt-oss-20b-openrouter",
    fallbackTimeoutS: 60,
  },

  /**
   * Retain lane — background fact extraction over a session transcript. No
   * person is waiting, and a full-length extraction legitimately needs ~190s
   * at the measured local floor of 80.6 tok/s against the 16384-token cap.
   *
   * local 200s: ~1.05x that 190s worst case. Deliberately not larger — it must
   * still cut a genuine runaway, and the token cap is what bounds the worst
   * case.
   *
   * fallback 90s: this hop only runs after a local attempt has already burned
   * up to 200s, and an extraction that needs 190s locally will not finish in
   * the interactive lane's 25s anywhere. Measured retain-fallback durations
   * (LiteLLM_SpendLogs, `gpt-oss-20b-retain-openrouter`, 7d, n=58 successes)
   * are p50 28.1s / p95 132.4s, so this hop is not generous.
   */
  retain: {
    group: "gpt-oss-20b-retain",
    localTimeoutS: 200,
    fallbackGroup: "gpt-oss-20b-retain-openrouter",
    fallbackTimeoutS: 90,
  },

  /**
   * Consolidation lane — same shape and same rationale as retain: a background
   * batch job whose fallback hop only runs after 200s has already been spent
   * locally.
   */
  consolidation: {
    group: "gpt-oss-20b-consolidation",
    localTimeoutS: 200,
    fallbackGroup: "gpt-oss-20b-consolidation-openrouter",
    fallbackTimeoutS: 90,
  },
} as const satisfies Record<string, LitellmTimeoutTier>;

/** The role names {@link LITELLM_TIMEOUT_TIERS} declares a tier for. */
export type LitellmTimeoutRole = keyof typeof LITELLM_TIMEOUT_TIERS;

/**
 * Worst-case wall time litellm may spend inside ONE client request for this
 * tier: the full primary timeout, then the full fallback timeout.
 *
 * This is deliberately the worst case and not an expected case. The client
 * budget has to cover the failover path or the failover path does not exist.
 */
export function litellmChainSeconds(tier: LitellmTimeoutTier): number {
  assertPositive(tier.localTimeoutS, `${tier.group} localTimeoutS`);
  if (tier.fallbackGroup === null) return tier.localTimeoutS;
  assertPositive(tier.fallbackTimeoutS, `${tier.fallbackGroup} fallbackTimeoutS`);
  return tier.localTimeoutS + tier.fallbackTimeoutS;
}

/**
 * The minimum client budget this tier can be served under:
 * `local + fallback + margin`. Below this the fallback hop cannot complete.
 */
export function minimumClientBudgetSeconds(
  tier: LitellmTimeoutTier,
  marginS: number = LITELLM_ROUTER_MARGIN_S,
): number {
  return litellmChainSeconds(tier) + marginS;
}

/**
 * The client budget to emit for a tier.
 *
 * `max(floorS, local + fallback + margin)` — NOT a replacement for whatever
 * derivation produced `floorS`.
 *
 * The `floorS` argument is how #3611's reasoning survives. That change derived
 * the retain budget from the output-token cap and the measured generation rate
 * (`ceil(16384 / 80.6) = 204s`) so a legitimately full-length extraction is
 * never starved by its own deadline. That remains a real lower bound and is
 * passed in here. The chain arithmetic is a second, independent lower bound.
 * The budget has to satisfy both, so it is the larger.
 *
 * Note what taking the max does NOT do: it does not reopen the 767.6s runaway
 * #3611 fixed. Runaway generation is cut by the output cap
 * (`HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS`) and by litellm's own
 * per-deployment `timeout` upstream of the client — a longer CLIENT budget
 * cannot let an upstream call run past `localTimeoutS`, it only stops the
 * client abandoning a fallback that is still legitimately in flight.
 */
export function clientBudgetSeconds(
  tier: LitellmTimeoutTier,
  floorS = 0,
  marginS: number = LITELLM_ROUTER_MARGIN_S,
): number {
  return Math.max(Math.ceil(floorS), minimumClientBudgetSeconds(tier, marginS));
}

/**
 * Fail loudly, at config-emit time, on a client budget that cannot cover its
 * tier's fallback hop.
 *
 * Called from the hindsight env emit paths, so an inconsistent budget can never
 * reach a container — the same "assert at emit time" precedent
 * `assertHindsightRetainBudget` set in #3611.
 */
export function assertClientBudget(args: {
  role: string;
  tier: LitellmTimeoutTier;
  clientBudgetS: number;
  marginS?: number;
}): void {
  const { role, tier, clientBudgetS } = args;
  const marginS = args.marginS ?? LITELLM_ROUTER_MARGIN_S;
  const required = minimumClientBudgetSeconds(tier, marginS);
  if (clientBudgetS < required) {
    const chain =
      tier.fallbackGroup === null
        ? `${tier.localTimeoutS}s`
        : `${tier.localTimeoutS}s (${tier.group}) + ${tier.fallbackTimeoutS}s (${tier.fallbackGroup})`;
    throw new Error(
      `litellm timeout budget [${role}]: client budget ${clientBudgetS}s is below the ` +
        `${required}s the routing chain needs (${chain} + ${marginS}s margin = ${required}s). ` +
        `The fallback hop can never complete under this budget: the client hangs up ` +
        `mid-failover, every failover becomes a guaranteed error, and litellm keeps the ` +
        `upstream slot held against a request nobody is waiting for. Raise the client ` +
        `budget, or lower localTimeoutS/fallbackTimeoutS for '${tier.group}' in ` +
        `src/litellm/timeout-budget.ts AND in the live litellm-config.yaml together.`,
    );
  }
}

/** A disagreement between a declared tier and the live proxy config. */
export interface LitellmTimeoutDrift {
  /** Role whose tier disagrees. */
  role: string;
  /** Model group the disagreement is on. */
  group: string;
  /** What `LITELLM_TIMEOUT_TIERS` says. */
  declaredS: number;
  /** What the live config says. `null` ⇒ the group carries no `timeout` at all. */
  actualS: number | null;
  /** Human-readable explanation, safe to put in an operator alert. */
  detail: string;
}

/**
 * Compare the declared tiers against per-group timeouts read out of a live
 * LiteLLM config, and report every disagreement.
 *
 * Pure over its inputs: the caller supplies `actualTimeouts` (group name → the
 * per-deployment `timeout`, or `null` when the group's deployments carry none
 * and therefore inherit `litellm_settings.request_timeout`). Parsing the YAML
 * and locating the file is the on-host sensor's job, not this module's.
 *
 * A group that is absent from `actualTimeouts` entirely is NOT reported: the
 * proxy may legitimately be running a config where that lane does not exist
 * yet, and "the lane is missing" is a different signal with a different owner
 * (`src/litellm/model-validation.ts`, #3407). This function reports only
 * `declared !== actual` for groups that DO exist — the drift that silently
 * breaks the budget while everything appears configured.
 */
export function detectLitellmTimeoutDrift(
  actualTimeouts: ReadonlyMap<string, number | null>,
  tiers: Record<string, LitellmTimeoutTier> = LITELLM_TIMEOUT_TIERS,
): LitellmTimeoutDrift[] {
  const drifts: LitellmTimeoutDrift[] = [];
  for (const [role, tier] of Object.entries(tiers)) {
    const check = (group: string | null, declaredS: number) => {
      if (group === null) return;
      if (!actualTimeouts.has(group)) return;
      const actualS = actualTimeouts.get(group) ?? null;
      if (actualS === declaredS) return;
      drifts.push({
        role,
        group,
        declaredS,
        actualS,
        detail:
          actualS === null
            ? `litellm group '${group}' carries NO per-deployment timeout (it inherits ` +
              `litellm_settings.request_timeout), but switchroom derives the ${role} client ` +
              `budget assuming ${declaredS}s. Every client budget for this lane is wrong.`
            : `litellm group '${group}' has timeout ${actualS}s but switchroom declares ` +
              `${declaredS}s (src/litellm/timeout-budget.ts). The ${role} client budget was ` +
              `derived from ${declaredS}s, so the paired budgets have drifted apart — this ` +
              `is exactly the 2026-07-25/26 defect class. Update the declaration and re-apply, ` +
              `or revert the proxy config.`,
      });
    };
    check(tier.group, tier.localTimeoutS);
    check(tier.fallbackGroup, tier.fallbackTimeoutS);
  }
  return drifts;
}

/**
 * Read per-group `timeout` values out of a parsed LiteLLM config's `model_list`.
 *
 * Returns group name → the timeout the WORST-CASE deployment in that group
 * carries. "Worst case" because a group is a load-balanced set and the router
 * may pick any deployment in it, so the budget has to survive the slowest:
 *
 *  - any deployment missing `timeout` ⇒ `null` (that deployment inherits
 *    `litellm_settings.request_timeout`, typically 600s, which blows every
 *    budget on the lane — the single most dangerous shape, so it wins);
 *  - otherwise the maximum of the deployments' timeouts.
 *
 * Groups present in `model_list` but with an unparseable/non-positive timeout
 * are treated as `null` for the same reason: an unreadable bound is not a bound.
 *
 * Pure; never throws. Feed the result to {@link detectLitellmTimeoutDrift}.
 */
export function extractGroupTimeouts(parsed: unknown): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!parsed || typeof parsed !== "object") return out;
  const list = (parsed as Record<string, unknown>).model_list;
  if (!Array.isArray(list)) return out;

  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = e.model_name;
    if (typeof name !== "string" || name.length === 0) continue;

    const params = e.litellm_params;
    const rawTimeout =
      params && typeof params === "object"
        ? (params as Record<string, unknown>).timeout
        : undefined;
    const n = typeof rawTimeout === "number" ? rawTimeout : Number(rawTimeout);
    const timeout = Number.isFinite(n) && n > 0 ? n : null;

    if (!out.has(name)) {
      out.set(name, timeout);
      continue;
    }
    const prev = out.get(name) ?? null;
    // null (unbounded) always wins; otherwise keep the larger bound.
    out.set(name, prev === null || timeout === null ? null : Math.max(prev, timeout));
  }
  return out;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`litellm timeout budget: ${label} must be a positive number, got ${value}`);
  }
}
