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
  /** The path scanned, or `null` when no path resolved at all (env unset and
   *  no explicit override) — distinct from a resolved-but-absent file, so a
   *  consumer can never mistake an empty string for a real path. */
  path: string | null;
  findings: Finding[];
}

/** Resolve the config path: explicit arg (the CLI passes
 *  `fleet_health.litellm_config_path` from switchroom.yaml) → the
 *  `LITELLM_CONFIG_PATH` env → null. There is no hard-coded default (the real
 *  path embeds a deployment-identifying Coolify service id); the operator
 *  supplies it in host-local config, or via the env for a one-off run. */
export function resolveLitellmConfigPath(explicit?: string): string | null {
  return explicit ?? process.env[LITELLM_CONFIG_PATH_ENV] ?? null;
}

/**
 * Run the LiteLLM header-passthrough sensor. No configured path (neither
 * `fleet_health.litellm_config_path` nor the `LITELLM_CONFIG_PATH` env) →
 * `skipped` with a VISIBLE log notice naming what to set; an absent, unreadable
 * or unparseable file → likewise `skipped` with a VISIBLE notice (hermetic
 * CI/dev, or a host where the path moved). Neither case ever reports a silent
 * pass: `status` is `skipped`, never `ok`, so the difference between "checked
 * and clean" and "did not check" stays legible to the caller. Present
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
      `fleet-health: litellm-config sensor SKIPPED — no config path: set ` +
        `fleet_health.litellm_config_path in switchroom.yaml (or the ` +
        `${LITELLM_CONFIG_PATH_ENV} env) to the operator-maintained LiteLLM ` +
        `config path; the I2 OAuth-leak check does NOT run until you do. ` +
        `Hermetic CI/dev expected to skip.`,
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
