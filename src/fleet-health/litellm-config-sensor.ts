/**
 * Fleet Health — LiteLLM config sensor (I2 OAuth-leak guard, the load-bearing
 * enforcement point for PR4a).
 *
 * The `scripts/check-litellm-config-guard.mjs` lint step covers the
 * repo-managed config (`docker/litellm-proxy/litellm-config.yaml`, KEN-125) but
 * can only reach the LIVE host copy where that copy exists — off-host it is
 * absent (CI/dev). This sensor is where enforcement bites for the LIVE file: it
 * runs inside the fleet-health scan, which executes where the config actually
 * lives and can read `/data/coolify/services/<service>/litellm-config.yaml`
 * (discovered — see `discoverLiveLitellmConfigPath`). A violation escalates
 * into the priority ledger (→ GitHub issue) exactly like any other L0 finding.
 *
 * STRICTLY MODEL-FREE: reads one YAML file, runs the pure detection core, emits
 * a structured finding. No LLM, no network.
 */

import { readFileSync, existsSync } from "node:fs";

import type { Finding } from "./detect.js";
import {
  COOLIFY_SERVICES_DIR,
  detectHeaderMisconfig,
  discoverLiveLitellmConfigPath,
  parseLitellmConfig,
} from "../litellm/header-passthrough-guard.js";

/** The pseudo-agent the litellm misconfig finding is attributed to. It is not a
 *  real switchroom agent — it names the shared LiteLLM proxy so the ledger's
 *  `reach` and occurrence pointers read sensibly. `isTestAgent` never matches
 *  it, and `runScan` injects it directly (not via the per-agent artifact loop),
 *  so it never collides with an agent directory. */
export const LITELLM_PROXY_PSEUDO_AGENT = "litellm-proxy";

export interface LitellmSensorOptions {
  /** Config path override. Defaults to `LITELLM_CONFIG_PATH` env → discovery
   *  under the Coolify services dir. */
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
  /** The live config path that was scanned, or null when none was resolvable
   *  (hermetic CI/dev, or an ambiguous host needing `LITELLM_CONFIG_PATH`). */
  path: string | null;
  findings: Finding[];
}

/**
 * Resolve the live config path: explicit arg → `LITELLM_CONFIG_PATH` env →
 * discovery under the Coolify services dir. Returns null when the live copy is
 * not resolvable, which the caller treats as a visible skip — never a pass.
 */
export function resolveLitellmConfigPath(explicit?: string): string | null {
  if (explicit) return explicit;
  const fromEnv = process.env.LITELLM_CONFIG_PATH;
  if (fromEnv) return fromEnv;
  return discoverLiveLitellmConfigPath().path;
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

  if (path === null) {
    log(
      `fleet-health: litellm-config sensor SKIPPED — no live config discoverable under ` +
        `${COOLIFY_SERVICES_DIR}/*/litellm-config.yaml (hermetic CI/dev expected to skip; ` +
        `set LITELLM_CONFIG_PATH explicitly if the layout differs or several proxies exist)`,
    );
    return { status: "skipped", path: null, findings: [] };
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
