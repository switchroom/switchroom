/**
 * Fleet Health — LiteLLM config sensor (I2 OAuth-leak guard, the load-bearing
 * enforcement point for PR4a).
 *
 * The `scripts/check-litellm-config-guard.mjs` lint step is near-vacuous:
 * off-host the operator-maintained config file is absent (CI/dev), so lint
 * skips. This sensor is where enforcement actually bites — it runs inside the
 * fleet-health scan, which executes where the config file lives and reads the
 * path named by the `LITELLM_CONFIG_PATH` env var. A violation escalates into
 * the priority ledger (→ GitHub issue) exactly like any other L0 finding.
 *
 * STRICTLY MODEL-FREE: reads one YAML file, runs the pure detection core, emits
 * a structured finding. No LLM, no network.
 */

import { readFileSync, existsSync } from "node:fs";

import type { Finding } from "./detect.js";
import {
  LITELLM_CONFIG_PATH_ENV,
  detectHeaderMisconfig,
  parseLitellmConfig,
} from "../litellm/header-passthrough-guard.js";

/** The pseudo-agent the litellm misconfig finding is attributed to. It is not a
 *  real switchroom agent — it names the shared LiteLLM proxy so the ledger's
 *  `reach` and occurrence pointers read sensibly. `isTestAgent` never matches
 *  it, and `runScan` injects it directly (not via the per-agent artifact loop),
 *  so it never collides with an agent directory. */
export const LITELLM_PROXY_PSEUDO_AGENT = "litellm-proxy";

export interface LitellmSensorOptions {
  /** Config path override. Defaults to the `LITELLM_CONFIG_PATH` env var;
   *  the sensor skips when neither is set. */
  path?: string;
  /** Injectable for tests. */
  existsFn?: (p: string) => boolean;
  readFn?: (p: string) => string;
  log?: (msg: string) => void;
  /** Timestamp for the finding (ISO). Defaults to now. */
  nowIso?: string;
}

export interface LitellmSensorResult {
  status: "ok" | "violation" | "skipped";
  path: string;
  findings: Finding[];
}

/** Resolve the config path: explicit arg → `LITELLM_CONFIG_PATH` env → null.
 *  There is no hard-coded default (the real path embeds a deployment-
 *  identifying Coolify service id); the operator sets the env on the host. */
export function resolveLitellmConfigPath(explicit?: string): string | null {
  return explicit ?? process.env[LITELLM_CONFIG_PATH_ENV] ?? null;
}

/**
 * Run the LiteLLM header-passthrough sensor. Absent file → `skipped` with a
 * VISIBLE log notice (hermetic CI/dev, or a host where the path moved). Present
 * file with a scoping violation → one `Finding` per violation, attributed to
 * the litellm-proxy pseudo-agent, so it escalates into the ledger.
 */
export function scanLitellmConfig(
  opts: LitellmSensorOptions = {},
): LitellmSensorResult {
  const path = resolveLitellmConfigPath(opts.path);
  const exists = opts.existsFn ?? existsSync;
  const read = opts.readFn ?? ((p: string) => readFileSync(p, "utf-8"));
  const log = opts.log ?? (() => {});
  const nowIso = opts.nowIso ?? new Date().toISOString();

  if (path == null) {
    log(
      `fleet-health: litellm-config sensor SKIPPED — ${LITELLM_CONFIG_PATH_ENV} unset ` +
        `(set it on the host to the operator-maintained LiteLLM config path; ` +
        `hermetic CI/dev expected to skip)`,
    );
    return { status: "skipped", path: "", findings: [] };
  }

  if (!exists(path)) {
    log(
      `fleet-health: litellm-config sensor SKIPPED — config file absent at ${path} ` +
        `(set LITELLM_CONFIG_PATH if it moved; hermetic CI/dev expected to skip)`,
    );
    return { status: "skipped", path, findings: [] };
  }

  let text: string;
  try {
    text = read(path);
  } catch (e) {
    log(`fleet-health: litellm-config sensor SKIPPED — ${path} unreadable: ${String(e)}`);
    return { status: "skipped", path, findings: [] };
  }

  const parsed = parseLitellmConfig(text);
  if (parsed == null) {
    log(`fleet-health: litellm-config sensor SKIPPED — ${path} unparseable YAML`);
    return { status: "skipped", path, findings: [] };
  }

  const violations = detectHeaderMisconfig(parsed);
  if (violations.length === 0) {
    log(`fleet-health: litellm-config sensor OK — header passthrough correctly scoped (${path})`);
    return { status: "ok", path, findings: [] };
  }

  const findings: Finding[] = violations.map((v, i) => {
    const where = v.scope === "global" ? "litellm_settings (global)" : `group '${v.group}'`;
    return {
      signal: "litellm-header-passthrough-misconfig",
      agent: LITELLM_PROXY_PSEUDO_AGENT,
      turn_id: `litellm-config:${v.scope}:${v.group ?? "global"}`,
      log_pointer: `${path}: ${where} — ${v.detail}`,
      ts: nowIso,
    };
  });
  for (const f of findings) {
    log(`fleet-health: litellm-config sensor VIOLATION — ${f.log_pointer}`);
  }
  return { status: "violation", path, findings };
}
