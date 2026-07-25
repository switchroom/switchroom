/**
 * I2 guard — LiteLLM `forward_client_headers_to_llm_api` scoping check.
 *
 * Design: `docs/model-routing.md` I2 ("Compliant metering") + the auth-broker
 * fix package PR4. The subscription OAuth `Authorization: Bearer` header is
 * forwarded straight through to Anthropic ONLY for subscription-Claude model
 * groups, via `forward_client_headers_to_llm_api: true` scoped to those groups.
 * A one-line misconfig — the flag set globally under `litellm_settings`, or on
 * any non-Claude / `*-openrouter` group — forwards that OAuth token to a third
 * party (OpenRouter/OpenAI). That is an OAuth leak.
 *
 * Since KEN-125 the config has a repo-managed source of truth
 * (`docker/litellm-proxy/litellm-config.yaml`), which the lint step ALWAYS
 * checks. This module is the pure detection core shared by two enforcement
 * points:
 *   1. the `scripts/check-litellm-config-guard.mjs` lint step, which checks the
 *      repo copy unconditionally (so it is no longer vacuous off-host) and the
 *      LIVE host copy additionally, where one is discoverable, and
 *   2. the load-bearing fleet-health sensor (`src/fleet-health/
 *      litellm-config-sensor.ts`) that runs where the live config actually
 *      lives and escalates a violation into the priority ledger.
 *
 * The detection functions are pure over already-parsed YAML so they are
 * trivially unit-testable and never touch the filesystem or network. The one
 * exception is `discoverLiveLitellmConfigPath` (filesystem lookup only, fully
 * injectable).
 */

import { existsSync, readdirSync } from "node:fs";

import { parse as parseYaml } from "yaml";

/** The passthrough flag under audit. */
export const FORWARD_HEADERS_FLAG = "forward_client_headers_to_llm_api";

/**
 * Where the LIVE (host) LiteLLM config is discovered.
 *
 * Deliberately NOT a hardcoded full path: the Coolify service directory is
 * named by a deployment-specific service id, and embedding this deployment's
 * id in a public repo is host-identifying. Instead the live copy is discovered
 * by scanning the Coolify services dir for the one service that owns a
 * `litellm-config.yaml` — so on-host enforcement keeps working with zero
 * operator action, and no deployment identifier ships in the repo.
 *
 * NOTE: `docs/model-routing.md` cites `/host/data/coolify/…` — that `/host`
 * prefix is ONLY valid inside the root-agent debugging container (which
 * bind-mounts the host root at `/host`). The real switchroom host path — where
 * the fleet-health sensor actually runs — has no `/host` prefix. Set
 * `LITELLM_CONFIG_PATH` to override discovery entirely (required when the
 * layout differs, or when discovery is ambiguous).
 */
export const COOLIFY_SERVICES_DIR = "/data/coolify/services";

/** Basename of the live proxy config inside its Coolify service dir. */
export const LIVE_LITELLM_CONFIG_BASENAME = "litellm-config.yaml";

/** Outcome of a live-config discovery attempt. `path` is non-null only for
 *  `"found"` — every other reason is a legitimate skip (hermetic CI/dev, or an
 *  ambiguous host that needs `LITELLM_CONFIG_PATH`). */
export interface LiveConfigDiscovery {
  path: string | null;
  reason: "found" | "no-services-dir" | "not-found" | "ambiguous";
  /** Every candidate found — length > 1 is what makes a host `"ambiguous"`. */
  candidates: string[];
}

/**
 * Discover the live LiteLLM config by scanning the Coolify services dir for
 * service dirs containing a `litellm-config.yaml`.
 *
 * Exactly one match → `found`. Zero → `not-found` (or `no-services-dir` when
 * the services dir itself is absent/unreadable, the CI/dev case). More than one
 * → `ambiguous` with `path: null`: guessing which proxy is authoritative would
 * be worse than skipping and telling the operator to set `LITELLM_CONFIG_PATH`.
 */
export function discoverLiveLitellmConfigPath(opts?: {
  servicesDir?: string;
  readdirFn?: (p: string) => string[];
  existsFn?: (p: string) => boolean;
}): LiveConfigDiscovery {
  const servicesDir = opts?.servicesDir ?? COOLIFY_SERVICES_DIR;
  const readdir = opts?.readdirFn ?? ((p: string) => readdirSync(p));
  const exists = opts?.existsFn ?? existsSync;

  let entries: string[];
  try {
    entries = readdir(servicesDir);
  } catch {
    return { path: null, reason: "no-services-dir", candidates: [] };
  }

  const candidates: string[] = [];
  for (const entry of [...entries].sort()) {
    const candidate = `${servicesDir}/${entry}/${LIVE_LITELLM_CONFIG_BASENAME}`;
    if (exists(candidate)) candidates.push(candidate);
  }

  if (candidates.length === 1) {
    return { path: candidates[0], reason: "found", candidates };
  }
  if (candidates.length === 0) {
    return { path: null, reason: "not-found", candidates };
  }
  return { path: null, reason: "ambiguous", candidates };
}

/**
 * A subscription-Claude group is allowed to forward the OAuth header. Mirrors
 * `docs/model-routing.md:66-68`: `claude-*` (covers `claude-opus-*`,
 * `claude-sonnet-*`, `claude-haiku-*`, `claude-fable-5`), plus the bare aliases
 * `sonnet` and `fable`. `*-openrouter` groups are EXCLUDED even though they may
 * match `claude-*` (e.g. `claude-sonnet-5-openrouter`) — those route to
 * OpenRouter, a third party that must never see the subscription token.
 */
export function isClaudeAllowlistedGroup(name: string): boolean {
  if (name.endsWith("-openrouter")) return false;
  return name.startsWith("claude-") || name === "sonnet" || name === "fable";
}

/** A header-passthrough scoping violation (an OAuth-leak surface). */
export interface HeaderMisconfigViolation {
  scope: "global" | "model_group";
  /** The offending model-group name (absent for the global master-switch). */
  group?: string;
  detail: string;
}

/** A 4b advisory: retry churn with no fallback chain (WARN, not a violation). */
export interface RetryFallbackWarning {
  group: string;
  numRetries: number;
  detail: string;
}

/** YAML truthiness for the boolean flag — accepts `true` and the string
 *  `"true"` (a quoted YAML scalar), nothing else. */
function flagTruthy(v: unknown): boolean {
  return v === true || v === "true";
}

/**
 * Iterate `model_group_settings` as `[groupName, settings]` pairs. LiteLLM
 * configs express this either as a map (`{claude-opus: {...}}`) or a list of
 * objects each naming its group (`- model_group: claude-opus`); handle both so
 * a format the operator legitimately uses is never silently skipped.
 */
function* iterGroups(
  mgs: unknown,
): Generator<[string, Record<string, unknown>]> {
  if (!mgs || typeof mgs !== "object") return;
  if (Array.isArray(mgs)) {
    for (const entry of mgs) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const name =
        (typeof e.model_group === "string" && e.model_group) ||
        (typeof e.group_name === "string" && e.group_name) ||
        (typeof e.model_name === "string" && e.model_name) ||
        null;
      if (name) yield [name, e];
    }
    return;
  }
  for (const [name, settings] of Object.entries(
    mgs as Record<string, unknown>,
  )) {
    if (settings && typeof settings === "object") {
      yield [name, settings as Record<string, unknown>];
    }
  }
}

/** Collect every group name referenced by any `fallbacks` chain in the config
 *  (litellm_settings.fallbacks or router_settings.fallbacks), so 4b can tell
 *  whether a retrying group has a failover route. Fallbacks are lists of
 *  `{<group>: [<targets>]}` maps in LiteLLM. */
function fallbackGroups(root: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const sources = [
    (root.litellm_settings as Record<string, unknown> | undefined)?.fallbacks,
    (root.router_settings as Record<string, unknown> | undefined)?.fallbacks,
  ];
  for (const fb of sources) {
    if (!Array.isArray(fb)) continue;
    for (const entry of fb) {
      if (!entry || typeof entry !== "object") continue;
      for (const [src, targets] of Object.entries(
        entry as Record<string, unknown>,
      )) {
        out.add(src);
        if (Array.isArray(targets)) {
          for (const t of targets) if (typeof t === "string") out.add(t);
        }
      }
    }
  }
  return out;
}

/**
 * Detect OAuth-leak header-passthrough misconfigs in a parsed LiteLLM config.
 * Two violation classes (both would forward the subscription token to a third
 * party):
 *   - the flag set globally under `litellm_settings` (the Boolean master
 *     switch — forwards for ALL upstreams, OpenRouter included), and
 *   - the flag on any `model_group_settings` group NOT in the Claude allowlist
 *     (a non-Claude / `*-openrouter` group).
 */
export function detectHeaderMisconfig(
  parsed: unknown,
): HeaderMisconfigViolation[] {
  const violations: HeaderMisconfigViolation[] = [];
  if (!parsed || typeof parsed !== "object") return violations;
  const root = parsed as Record<string, unknown>;

  const ls = root.litellm_settings;
  if (ls && typeof ls === "object" && flagTruthy((ls as Record<string, unknown>)[FORWARD_HEADERS_FLAG])) {
    violations.push({
      scope: "global",
      detail:
        `${FORWARD_HEADERS_FLAG}: true under litellm_settings — the GLOBAL ` +
        `master switch forwards the subscription OAuth Authorization header ` +
        `to EVERY upstream (OpenRouter/OpenAI included). Scope it to Claude ` +
        `groups only.`,
    });
  }

  for (const [group, settings] of iterGroups(root.model_group_settings)) {
    if (flagTruthy(settings[FORWARD_HEADERS_FLAG]) && !isClaudeAllowlistedGroup(group)) {
      violations.push({
        scope: "model_group",
        group,
        detail:
          `${FORWARD_HEADERS_FLAG}: true on non-Claude group '${group}' — ` +
          `forwards the subscription OAuth Authorization header to a ` +
          `non-subscription upstream. Remove it from this group.`,
      });
    }
  }

  return violations;
}

/**
 * 4b advisory (WARN only): an allowlisted Claude group configured with
 * `num_retries > 1` but no `fallbacks` chain. The auth broker's
 * mark-exhausted / failover is the retry authority for subscription accounts;
 * LiteLLM-side retry churn without a fallback route just re-hammers the same
 * walled account. Recommended shape (documented in model-routing.md Known
 * Gaps): a `fallbacks` chain claude-opus→claude-sonnet with `num_retries: 1`.
 */
export function detectRetryFallbackGaps(
  parsed: unknown,
): RetryFallbackWarning[] {
  const warnings: RetryFallbackWarning[] = [];
  if (!parsed || typeof parsed !== "object") return warnings;
  const root = parsed as Record<string, unknown>;
  const hasFallbackFor = fallbackGroups(root);
  for (const [group, settings] of iterGroups(root.model_group_settings)) {
    if (!isClaudeAllowlistedGroup(group)) continue;
    const nr = settings.num_retries;
    const numRetries = typeof nr === "number" ? nr : Number(nr);
    if (Number.isFinite(numRetries) && numRetries > 1 && !hasFallbackFor.has(group)) {
      warnings.push({
        group,
        numRetries,
        detail:
          `Claude group '${group}' sets num_retries: ${numRetries} with no ` +
          `fallbacks chain. The auth broker owns failover — prefer ` +
          `num_retries: 1 plus a fallbacks chain (see model-routing.md Known Gaps).`,
      });
    }
  }
  return warnings;
}

/** Parse LiteLLM config YAML text; returns null on unparseable input (never
 *  throws — the caller decides whether an unparseable config is fatal). */
export function parseLitellmConfig(text: string): unknown {
  try {
    return parseYaml(text);
  } catch {
    return null;
  }
}
