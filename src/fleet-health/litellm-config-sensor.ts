/**
 * Fleet Health — LiteLLM config sensor. Two invariants, one file read:
 *   1. the I2 OAuth-leak guard (header passthrough scoping) — the load-bearing
 *      enforcement point for PR4a;
 *   2. paired-timeout-budget drift — the live per-deployment `timeout` values
 *      vs the tiers `src/litellm/timeout-budget.ts` derives every hindsight
 *      client budget from. A half that moves alone breaks the router's fallback
 *      hop silently; this is what makes it loud.
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
import { dirname, join } from "node:path";

import type { Finding } from "./detect.js";
import type { LiveConfigDiscovery } from "../litellm/header-passthrough-guard.js";
import {
  COOLIFY_SERVICES_DIR,
  detectHeaderMisconfig,
  discoverLiveLitellmConfigPath,
  parseLitellmConfig,
} from "../litellm/header-passthrough-guard.js";
import {
  detectLitellmTimeoutDrift,
  extractGroupTimeouts,
} from "../litellm/timeout-budget.js";
import {
  LIVE_COMPOSE_BASENAME,
  canReadComposeMounts,
  detectMissingCallbackMounts,
} from "../litellm/callback-mount-guard.js";

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
  /** Live-config discovery, injectable so tests never depend on the host's
   *  real `/data/coolify/services` tree (see `DiscoverFn`). */
  discoverFn?: DiscoverFn;
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
 * Live-config discovery seam. Defaults to the real filesystem scan; tests
 * inject a stub so they assert the resolution LOGIC instead of the host's
 * filesystem. A test that reads the real `/data/coolify/services` passes in
 * hermetic CI and FAILS on any host where a live proxy config genuinely
 * exists — a host-dependent test is a real defect, fixed by injecting here.
 */
export type DiscoverFn = () => LiveConfigDiscovery;

/**
 * Resolve the live config path: explicit arg → `LITELLM_CONFIG_PATH` env →
 * discovery under the Coolify services dir. Returns null when the live copy is
 * not resolvable, which the caller treats as a visible skip — never a pass.
 */
export function resolveLitellmConfigPath(
  explicit?: string,
  discoverFn: DiscoverFn = () => discoverLiveLitellmConfigPath(),
): string | null {
  if (explicit) return explicit;
  const fromEnv = process.env.LITELLM_CONFIG_PATH;
  if (fromEnv) return fromEnv;
  return discoverFn().path;
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
  const path = resolveLitellmConfigPath(opts.path, opts.discoverFn);
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

  const findings: Finding[] = [];

  const violations = detectHeaderMisconfig(parsed);
  if (violations.length === 0) {
    log(`fleet-health: litellm-config sensor OK — header passthrough correctly scoped (${path})`);
  }
  for (const v of violations) {
    const where = v.scope === "global" ? "litellm_settings (global)" : `group '${v.group}'`;
    findings.push({
      signal: "litellm-header-passthrough-misconfig",
      agent: LITELLM_PROXY_PSEUDO_AGENT,
      turn_id: `litellm-config:${v.scope}:${v.group ?? "global"}`,
      log_pointer: `${path}: ${where} — ${v.detail}`,
      ts: nowIso,
    });
  }

  // Paired-timeout-budget drift: the live per-deployment timeouts vs the tiers
  // switchroom derives every hindsight client budget from
  // (`src/litellm/timeout-budget.ts`). The in-repo vitest asserts the invariant
  // over the DECLARATION and is fully deterministic in CI; only this sensor can
  // see whether the live proxy still agrees with that declaration. Same division
  // of labour as the I2 guard above.
  const drifts = detectLitellmTimeoutDrift(extractGroupTimeouts(parsed));
  if (drifts.length === 0) {
    log(
      `fleet-health: litellm-config sensor OK — per-deployment timeouts match the declared ` +
        `tiers in src/litellm/timeout-budget.ts (${path})`,
    );
  }
  for (const d of drifts) {
    findings.push({
      signal: "litellm-timeout-budget-drift",
      agent: LITELLM_PROXY_PSEUDO_AGENT,
      turn_id: `litellm-timeout:${d.role}:${d.group}`,
      log_pointer: `${path}: group '${d.group}' — ${d.detail}`,
      ts: nowIso,
    });
  }

  // Custom-callback mount coherence: a callback the config names but the
  // deployed compose does not mount is a hard startup abort, not a degraded
  // mode (2026-08-09 fleet outage — the v1.95.0 image bump regenerated the
  // compose from Coolify's `docker_compose_raw` and dropped the pacer mount
  // that only ever existed as a hand edit to the generated file). Only this
  // sensor can see the LIVE pairing, same division of labour as the checks
  // above. The compose sits beside the config in the Coolify service dir.
  const composePath = join(dirname(path), LIVE_COMPOSE_BASENAME);
  let composeText: string | null = null;
  if (exists(composePath)) {
    try {
      composeText = read(composePath);
    } catch (e) {
      log(
        `fleet-health: litellm-config sensor — callback-mount check SKIPPED, ` +
          `${composePath} unreadable: ${String(e)}`,
      );
    }
  } else {
    log(
      `fleet-health: litellm-config sensor — callback-mount check SKIPPED, ` +
        `no ${LIVE_COMPOSE_BASENAME} beside ${path}`,
    );
  }

  const missingMounts = detectMissingCallbackMounts(parsed, composeText);
  if (composeText !== null && !canReadComposeMounts(composeText)) {
    // Parsed to nothing usable (bad YAML, or no `services` mapping). Judging
    // this a pass would be the silent-green failure the sensor exists to catch.
    log(
      `fleet-health: litellm-config sensor — callback-mount check SKIPPED, ` +
        `${composePath} has no readable services/volumes mapping`,
    );
  } else if (composeText !== null && missingMounts.length === 0) {
    log(
      `fleet-health: litellm-config sensor OK — every custom callback module is ` +
        `bind-mounted by ${composePath}`,
    );
  }
  for (const m of missingMounts) {
    findings.push({
      signal: "litellm-callback-mount-missing",
      agent: LITELLM_PROXY_PSEUDO_AGENT,
      turn_id: `litellm-callback-mount:${m.module}`,
      log_pointer: `${composePath}: ${m.detail}`,
      ts: nowIso,
    });
  }

  if (findings.length === 0) return { status: "ok", path, findings: [] };
  for (const f of findings) {
    log(`fleet-health: litellm-config sensor VIOLATION — ${f.log_pointer}`);
  }
  return { status: "violation", path, findings };
}
