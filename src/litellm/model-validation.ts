/**
 * Config-time validation: every LLM model referenced by a switchroom-managed
 * consumer must exist in the live LiteLLM proxy's model list (#3407).
 *
 * The 2026-07-19 outage: an operator edit to the Coolify-hosted LiteLLM
 * `model_list` ("degemini") removed the OpenRouter Gemini model groups, but the
 * shared `switchroom-hindsight` container's env still pinned
 * `openrouter/google/gemini-3.1-flash-lite` (`HINDSIGHT_API_LLM_MODEL` /
 * `ANTHROPIC_MODEL`). Every hindsight default-config LLM call then 400'd
 * ("Invalid model name") for ~2h. The proxy's model list and switchroom's model
 * references drifted apart with no deterministic check catching it.
 *
 * This module closes that gap. It is pure over its inputs except for one small
 * injectable HTTP fetch (`fetchProxyModels`), so the collection + validation
 * logic is trivially unit-testable and the doctor/validate path wires the real
 * proxy query + secret resolution in.
 *
 * Scope (deliberately conservative to avoid false positives):
 *   - Hindsight LLM config — `hindsight.llm.model` (global) and the per-op
 *     `retain`/`reflect`/`consolidation` `.model` overrides. These are explicit
 *     full model identifiers the hindsight container hands the proxy verbatim,
 *     so ALL of them are validated when the fleet carve-out (`litellm.enabled`)
 *     is on.
 *   - Agent model pins — `agents.<name>.model` / `fallback_model` — but ONLY
 *     values that are explicit litellm routes (contain a `/`, e.g.
 *     `openrouter/z-ai/glm-5.2`). Bare Claude aliases (`sonnet`/`opus`/`haiku`)
 *     are expanded by the `claude` CLI and served by the proxy's `/anthropic`
 *     passthrough, so flagging them against `/v1/models` would false-positive.
 *
 * Failure semantics (owned by the caller / doctor wiring):
 *   - A referenced model missing from `/v1/models` → FAIL, naming the model AND
 *     the consumer(s) referencing it. Loud, at validate/doctor time.
 *   - Proxy unreachable / non-200 → WARN, never a hard fail (mirrors the
 *     existing #2781 broker-unreachable degrade — an environment limitation,
 *     not a config error).
 *   - LiteLLM disabled, or no litellm-routable references → nothing to check.
 */

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckResult } from "../cli/doctor-memory.js";

/** A single model reference drawn from switchroom-managed config. */
export interface ModelReference {
  /** The model identifier as written in config (handed to the proxy verbatim). */
  model: string;
  /** Human-readable consumer that references it, e.g. `hindsight.llm.retain`. */
  consumer: string;
}

/**
 * Pure: is a model value an explicit litellm route we can validate against the
 * proxy model list? True for provider-prefixed ids (`openrouter/...`,
 * `anthropic/...`) — anything carrying a `/`. Bare CLI aliases (`sonnet`) are
 * intentionally excluded (passthrough-served; would false-positive).
 */
export function isExplicitLitellmRoute(model: string): boolean {
  return model.includes("/");
}

/**
 * Pure: collect every switchroom-managed model reference that should exist in
 * the LiteLLM proxy model list. Returns [] when the fleet carve-out is off
 * (`litellm.enabled` !== true) — with no proxy in the path there is nothing to
 * validate against. Never throws.
 */
export function collectReferencedModels(config: SwitchroomConfig): ModelReference[] {
  const refs: ModelReference[] = [];
  const litellmEnabled = config.litellm?.enabled === true;
  if (!litellmEnabled) return refs;

  // ── Hindsight LLM config — global + per-op. Validated verbatim (explicit
  // full model ids, not CLI aliases). Dedup by (model, consumer).
  const llm = config.hindsight?.llm;
  if (llm) {
    const push = (model: string | undefined, consumer: string) => {
      if (model) refs.push({ model, consumer });
    };
    push(llm.model, "hindsight.llm.model (global)");
    push(llm.retain?.model, "hindsight.llm.retain");
    push(llm.reflect?.model, "hindsight.llm.reflect");
    push(llm.consolidation?.model, "hindsight.llm.consolidation");
  }

  // ── Agent model pins — only explicit litellm routes (contain `/`), and only
  // for agents that actually route through the proxy (top-level enabled AND the
  // agent hasn't opted out with `litellm.enabled: false`).
  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    if (!agent) continue;
    const agentRoutes = agent.litellm?.enabled !== false; // inherits fleet-on
    if (!agentRoutes) continue;
    if (agent.model && isExplicitLitellmRoute(agent.model)) {
      refs.push({ model: agent.model, consumer: `agents.${name}.model` });
    }
    if (agent.fallback_model && isExplicitLitellmRoute(agent.fallback_model)) {
      refs.push({ model: agent.fallback_model, consumer: `agents.${name}.fallback_model` });
    }
  }

  return refs;
}

/** One missing model with every consumer that references it. */
export interface MissingModel {
  model: string;
  consumers: string[];
}

/**
 * Pure: validate references against the set of model ids the proxy advertises.
 * Returns the missing models grouped with their referencing consumers, in
 * stable (first-seen) order. `proxyModels` is the set of `id`s from
 * `/v1/models`. Never throws.
 */
export function validateModelReferences(
  refs: ModelReference[],
  proxyModels: Set<string>,
): MissingModel[] {
  const missing = new Map<string, string[]>();
  for (const { model, consumer } of refs) {
    if (proxyModels.has(model)) continue;
    const list = missing.get(model);
    if (list) {
      if (!list.includes(consumer)) list.push(consumer);
    } else {
      missing.set(model, [consumer]);
    }
  }
  return [...missing.entries()].map(([model, consumers]) => ({ model, consumers }));
}

/** Injectable fetch — just the call signature we use (see litellm/provision.ts). */
export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

/** Result of probing the proxy's model list. */
export type ProxyModelsResult =
  | { kind: "ok"; models: string[] }
  | { kind: "unreachable"; msg: string };

/**
 * Query the LiteLLM proxy's OpenAI-format model list (`GET {base}/v1/models`),
 * authenticated with the master/admin key as a Bearer token. Returns the model
 * `id`s on success, or an `unreachable` result (network error, non-200, or
 * unparseable body) the caller degrades to a WARNING. Never throws.
 */
export async function fetchProxyModels(
  baseUrl: string,
  apiKey: string,
  fetchFn: FetchFn = fetch,
  timeoutMs = 8000,
): Promise<ProxyModelsResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      // AbortSignal is accepted by real fetch; the injectable type omits it to
      // stay minimal, so pass it through a widened cast.
      ...({ signal: controller.signal } as Record<string, unknown>),
    });
    if (!res.ok) {
      return { kind: "unreachable", msg: `proxy returned HTTP ${res.status} for ${url}` };
    }
    const body = (await res.json()) as unknown;
    const data = (body as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      return { kind: "unreachable", msg: `proxy ${url} response had no model \`data\` array` };
    }
    const models = data
      .map((m) => (m as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === "string");
    return { kind: "ok", models };
  } catch (err) {
    return { kind: "unreachable", msg: (err as Error).message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure: turn a missing-model list (from {@link validateModelReferences}) into a
 * single doctor `CheckResult`. FAIL when anything is missing, naming each model
 * and its consumer(s); OK otherwise. `refCount` is the number of references
 * actually validated, for the OK detail line.
 */
export function classifyModelReferences(
  missing: MissingModel[],
  refCount: number,
): CheckResult {
  if (missing.length === 0) {
    return {
      name: "litellm model routing",
      status: "ok",
      detail: `all ${refCount} referenced model(s) present in the proxy model_list`,
    };
  }
  const detail = missing
    .map((m) => `\`${m.model}\` (referenced by ${m.consumers.join(", ")})`)
    .join("; ");
  return {
    name: "litellm model routing",
    status: "fail",
    detail:
      `${missing.length} model reference(s) NOT in the LiteLLM proxy model_list: ` +
      `${detail} — every LLM call from that consumer will 400 ("Invalid model ` +
      `name") until the proxy lists it or the reference is corrected`,
    fix:
      "Either add the missing model group back to the LiteLLM proxy config " +
      "(the operator-maintained `litellm-config.yaml` `model_list`) and redeploy " +
      "the proxy, or repoint the consumer at a model the proxy DOES route " +
      "(`switchroom doctor` lists them via the proxy `/v1/models`). For " +
      "hindsight, then `switchroom memory --restart` so it re-verifies.",
  };
}

/** Options for {@link runLitellmModelChecks} — IO injected for testability. */
export interface LitellmModelCheckOpts {
  /**
   * Resolve the admin/master key: a literal string is returned as-is; a
   * `vault:<key>` reference is resolved to its secret value, or `null` when it
   * can't be read. The doctor wiring passes a vault-backed resolver.
   */
  resolveSecret: (ref: string) => string | null;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchFn?: FetchFn;
}

/**
 * Orchestrate the config-time model-reference check for `switchroom doctor` /
 * the validate path. Gate order:
 *   1. LiteLLM off or no litellm-routable references → [] (nothing to check).
 *   2. base_url / admin_key unresolved → single WARN (can't reach the proxy).
 *   3. Proxy unreachable → single WARN (environment limitation, never fatal).
 *   4. Otherwise → validate and return the FAIL/OK row.
 * Never throws.
 */
export async function runLitellmModelChecks(
  config: SwitchroomConfig,
  opts: LitellmModelCheckOpts,
): Promise<CheckResult[]> {
  const refs = collectReferencedModels(config);
  if (refs.length === 0) return [];

  const litellm = config.litellm;
  const baseUrl = litellm?.base_url;
  const adminKeyRef = litellm?.admin_key;
  if (!baseUrl || !adminKeyRef) {
    return [
      {
        name: "litellm model routing",
        status: "warn",
        detail:
          `${refs.length} model reference(s) to validate but litellm ` +
          `${!baseUrl ? "base_url" : "admin_key"} is unresolved — cannot query ` +
          `the proxy model_list`,
      },
    ];
  }

  const apiKey = opts.resolveSecret(adminKeyRef);
  if (!apiKey) {
    return [
      {
        name: "litellm model routing",
        status: "warn",
        detail:
          `could not resolve the litellm admin_key (\`${adminKeyRef}\`) to query ` +
          `the proxy model_list — ${refs.length} model reference(s) left unverified`,
      },
    ];
  }

  const probe = await fetchProxyModels(baseUrl, apiKey, opts.fetchFn);
  if (probe.kind === "unreachable") {
    return [
      {
        name: "litellm model routing",
        status: "warn",
        detail:
          `LiteLLM proxy unreachable (${probe.msg}) — ${refs.length} model ` +
          `reference(s) left unverified; not failing on an environment limitation`,
      },
    ];
  }

  const missing = validateModelReferences(refs, new Set(probe.models));
  return [classifyModelReferences(missing, refs.length)];
}
