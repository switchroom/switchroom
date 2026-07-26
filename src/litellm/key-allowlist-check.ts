/**
 * Doctor check: every model group `switchroom.yaml` declares for hindsight
 * must be REACHABLE by the virtual key hindsight actually presents.
 *
 * ── Why this exists as a separate, loud check ───────────────────────────────
 *
 * #3407 already validates that a config-referenced model EXISTS in the proxy's
 * `model_list`. That is necessary and not sufficient. A group can exist, be
 * healthy, and still be unreachable by the one caller that needs it, because
 * LiteLLM enforces a per-KEY `models` allowlist at request auth
 * (`can_key_call_model`, `litellm/proxy/auth/auth_checks.py:2959`, reached from
 * `user_api_key_auth.py:2690`). Existence lives in `litellm-config.yaml`;
 * reachability lives in a Postgres row. Nothing compared the two.
 *
 * The resulting failure mode is the worst kind: SILENT. On 2026-07-26
 * `gpt-oss-20b-retain` and `gpt-oss-20b-consolidation` were declared, deployed
 * and serving — and had recorded ZERO calls since creation, because every
 * request was rejected at auth before reaching a deployment. Nobody noticed for
 * weeks; there is no error to notice when a lane simply never gets used.
 * `switchroom apply` now reconciles this automatically, but a deterministic
 * check beats hoping the reconciliation ran: this FAILs at doctor time, by
 * name, with the config key that declared the lane.
 *
 * ── Availability discipline ─────────────────────────────────────────────────
 *
 * Same posture as #3407's model check, for the same reason: an unreachable
 * proxy, an unresolvable secret, or a key the proxy does not recognise are
 * ENVIRONMENT limitations, not config defects. Those WARN. Only "the proxy
 * answered, the key is real, and it cannot reach a lane the config declares"
 * FAILs — the one condition that is unambiguously a bug in the fleet's state.
 *
 * ── Which key gets checked ──────────────────────────────────────────────────
 *
 * The one the caller actually presents, which is NOT the provisioned service
 * key. A `provider: litellm` op sends `hindsight.llm.<op>.api_key` (emitted as
 * `HINDSIGHT_API_<OP>_LLM_API_KEY`); the vault entry
 * `litellm/hindsight/api-key` authenticates the claude-code passthrough
 * instead, and nothing keeps the two equal. Checking the vault key while the
 * container presents a config key would report OK on an unreachable lane — the
 * precise false negative this check exists to remove — so the check is emitted
 * once per DISTINCT key (`requiredKeyDemands`).
 *
 * An op that declares NO `api_key` is a THIRD case, not a synonym for the
 * service key: switchroom emits no global `HINDSIGHT_API_LLM_API_KEY`, and
 * hindsight reads that name as a bare `os.getenv` with no default, so the lane
 * presents no credential this check can identify. Verifying the service key on
 * its behalf would produce an OK or a FAIL about a key that lane never sends —
 * the same false attribution, pointed the other way. It WARNs.
 */

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckResult } from "../cli/doctor-memory.js";
import { fetchProxyModels, type FetchFn } from "./model-validation.js";
import { validateKey } from "./provision.js";
import {
  requiredKeyModels,
  requiredKeyDemands,
  unreachableModels,
  classifyAllowlist,
  type KeyDemand,
} from "./key-allowlist.js";

/** The vault path the hindsight service key is provisioned to (see apply.ts). */
export const HINDSIGHT_KEY_VAULT_REF = "litellm/hindsight/api-key";

const CHECK_NAME = "litellm key allowlist";

export interface LitellmKeyAllowlistCheckOpts {
  /**
   * Resolve a `vault:`-style reference (or return a literal verbatim) to its
   * secret value. `null` when it cannot be resolved — which WARNs, never fails.
   */
  resolveSecret: (ref: string) => string | null;
  fetchFn?: FetchFn;
}

/**
 * Run the reachability check. Returns [] when there is nothing to say (no
 * proxy, no hindsight backend, no declared lanes) so doctor does not grow a
 * section for fleets that do not use the carve-out.
 */
export async function runLitellmKeyAllowlistChecks(
  config: SwitchroomConfig,
  opts: LitellmKeyAllowlistCheckOpts,
): Promise<CheckResult[]> {
  const litellm = config.litellm;
  if (litellm?.enabled !== true) return [];
  if (config.memory?.backend !== "hindsight") return [];
  if (!config.hindsight?.llm) return [];

  const baseUrl = litellm.base_url;
  const adminKeyRef = litellm.admin_key;
  if (!baseUrl || !adminKeyRef) {
    return [
      {
        name: CHECK_NAME,
        status: "warn",
        detail:
          `litellm ${!baseUrl ? "base_url" : "admin_key"} is unresolved — cannot ` +
          `check whether the hindsight key can reach its declared model groups`,
      },
    ];
  }

  const masterKey = opts.resolveSecret(adminKeyRef);
  if (!masterKey) {
    return [
      {
        name: CHECK_NAME,
        status: "warn",
        detail:
          `could not resolve the litellm admin_key (\`${adminKeyRef}\`) — the ` +
          `hindsight key's model allowlist is left unverified`,
      },
    ];
  }

  const probe = await fetchProxyModels(baseUrl, masterKey, opts.fetchFn);
  if (probe.kind === "unreachable") {
    return [
      {
        name: CHECK_NAME,
        status: "warn",
        detail:
          `LiteLLM proxy unreachable (${probe.msg}) — hindsight key allowlist ` +
          `left unverified; not failing on an environment limitation`,
      },
    ];
  }

  const required = requiredKeyModels(config, new Set(probe.models));
  if (required.length === 0) {
    return [
      {
        name: CHECK_NAME,
        status: "ok",
        detail: "no litellm-routed hindsight model groups declared",
      },
    ];
  }

  // One result per KEY, not per fleet: a `provider: litellm` op presents its own
  // `hindsight.llm.<op>.api_key`, and an op that declares none presents a key
  // this check cannot name at all. Checking one key while the caller presents
  // another is a false OK on the exact defect this check exists for.
  const results: CheckResult[] = [];
  for (const demand of requiredKeyDemands(required)) {
    results.push(
      await checkOneKey(demand, { baseUrl, masterKey, opts }),
    );
  }
  return results;
}

/** Verify a single virtual key against the lanes the config says it must reach. */
async function checkOneKey(
  demand: KeyDemand,
  ctx: {
    baseUrl: string;
    masterKey: string;
    opts: LitellmKeyAllowlistCheckOpts;
  },
): Promise<CheckResult> {
  const { baseUrl, masterKey, opts } = ctx;
  const groups = [...new Set(demand.required.map((r) => r.group))];
  const name = `${CHECK_NAME} (${demand.declaredBy.join(", ")})`;

  // A litellm-routed lane that names no `api_key` presents no credential this
  // check can identify, and there is no service-key fallback to substitute (see
  // RequiredKeyModel.apiKeyRef). Checking `litellm/hindsight/api-key` on its
  // behalf would attribute that key's allowlist to a lane that never sends it —
  // an OK or a FAIL, either way about the wrong key. WARN is the only honest
  // answer, and it names the fix.
  if (demand.apiKeyRef === null) {
    return {
      name,
      status: "warn",
      detail:
        `${demand.declaredBy.join(", ")} route through litellm but declare no ` +
        `\`api_key\`, so switchroom cannot tell which virtual key they present ` +
        `and cannot verify that ${groups.join(", ")} are reachable. Note the ` +
        `provisioned \`${HINDSIGHT_KEY_VAULT_REF}\` is NOT the fallback — it is ` +
        `injected only as the claude-code passthrough bearer. Set ` +
        `\`hindsight.llm.<op>.api_key\` to make this lane checkable.`,
    };
  }

  const keyLabel = `the key at ${demand.declaredBy.map((c) => `${c}.api_key`).join(" / ")}`;
  const key = opts.resolveSecret(demand.apiKeyRef);
  if (!key) {
    return {
      name,
      status: "warn",
      detail: `could not resolve ${keyLabel} — allowlist left unverified for ${groups.join(", ")}`,
    };
  }

  const info = await validateKey({ baseUrl, masterKey, key }, opts.fetchFn);
  if (info.kind === "unreachable") {
    return {
      name,
      status: "warn",
      detail: `could not read the allowlist of ${keyLabel} (${info.detail}) — left unverified`,
    };
  }
  if (info.kind === "unknown") {
    // The stored key is not in the proxy DB at all. That is a REAL defect, but
    // it belongs to the key-provisioning check, which has the right message and
    // the right remedy. Saying it twice, in two vocabularies, is worse than
    // saying it once.
    return {
      name,
      status: "warn",
      detail:
        `the proxy does not recognise ${keyLabel} — re-provision it ` +
        `(\`switchroom apply\`); allowlist not checked`,
    };
  }

  const posture = classifyAllowlist(info.models);
  if (posture === "unrestricted") {
    return {
      name,
      status: "ok",
      detail: `${keyLabel} is unrestricted — all ${groups.length} declared model group(s) reachable`,
    };
  }
  if (posture === "indeterminate") {
    // `all-team-models`: the effective list is the TEAM's, which lives on a row
    // this check does not read. Neither OK nor FAIL is honest.
    return {
      name,
      status: "warn",
      detail:
        `${keyLabel} carries \`all-team-models\`, so its effective allowlist is ` +
        `its TEAM's and cannot be determined from the key — reachability of ` +
        `${groups.join(", ")} left unverified`,
    };
  }

  const missing = unreachableModels(demand.required, info.models);
  if (missing.length === 0) {
    return {
      name,
      status: "ok",
      detail: `all ${groups.length} declared model group(s) reachable by ${keyLabel}`,
    };
  }

  const lines = missing
    .map((m) => `${m.group} (declared at ${m.consumers.join(", ")})`)
    .join("; ");
  return {
    name,
    status: "fail",
    detail:
      `${missing.length} declared model group(s) are UNREACHABLE by ${keyLabel} ` +
      `— every request to them is rejected at auth with ` +
      `"key not allowed to access model", so the lane records no traffic and ` +
      `no error: ${lines}. Fix: \`switchroom apply\` reconciles the key's ` +
      `allowlist from config.`,
  };
}
