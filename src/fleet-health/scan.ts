/**
 * Fleet Health — the scan orchestration (I/O boundary). Iterates every agent
 * under `~/.switchroom/agents/*`, reads each agent's `turns.jsonl` +
 * `../logs/<agent>/gateway-supervisor.log`, runs the model-free L0 detectors,
 * aggregates into the priority ledger, and (optionally) writes it +
 * synchronizes GitHub issues.
 *
 * Design: `reference/rfcs/fleet-health.md`. Defensive: an agent with a missing
 * or malformed `turns.jsonl` is skipped with a warning, never crashes the whole
 * scan.
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

import type { FleetHealthLedger } from "../web/fleet-health-read.js";
import { fleetHealthLedgerPath } from "../web/fleet-health-read.js";
import { scanAgent, type Finding, type AgentScanResult } from "./detect.js";
import { buildLedger } from "./ledger.js";
import { isTestAgent } from "./test-agents.js";
import { scanLitellmConfig } from "./litellm-config-sensor.js";
import { scanHindsightGpuDrift } from "./hindsight-gpu-drift-sensor.js";
import type { HindsightGpuDriftDeps } from "../setup/hindsight-gpu-drift.js";

/**
 * Resolve the `.switchroom` base dir, matching the read-side
 * (`SWITCHROOM_HOME` → `HOME` → os.homedir()). The agents live under
 * `<base>/.switchroom/agents` and logs under `<base>/.switchroom/logs`.
 */
export function resolveSwitchroomBase(
  home: string = process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(),
): string {
  return resolve(home, ".switchroom");
}

export interface ScanOptions {
  base?: string;
  ownerAgent?: string;
  now?: Date;
  windowDays?: number;
  log?: (msg: string) => void;
  /** Override the silent-no-op windowing floor (unix seconds). Defaults to
   *  `SILENT_NOOP_FLOOR_TS`. Exposed for tests / future re-baselining. */
  silentNoopFloorTs?: number;
  /** Override the LiteLLM config path the I2 header-passthrough sensor reads.
   *  Defaults to `LITELLM_CONFIG_PATH` env → the host-correct default. Exposed
   *  for tests; absent file → the sensor skips with a visible notice. */
  litellmConfigPath?: string;
  /** I/O seams for the hindsight GPU-drift sensor (host probe / caps read /
   *  docker inspect). Exposed for tests so the scan never depends on a real
   *  GPU or a running container; absent → the sensor runs the real probes and
   *  degrades to a no-op when docker/nvidia are unavailable. */
  hindsightGpuDeps?: HindsightGpuDriftDeps;
}

export interface ScanResult {
  ledger: FleetHealthLedger;
  perAgent: AgentScanResult[];
  agentsScanned: number;
  agentsSkipped: string[];
  /** Test/synthetic agents (e.g. `test-harness`) deliberately excluded from
   *  the production drift ledger — their findings never enter frequency/reach.
   *  See `isTestAgent` for the rule. */
  agentsExcluded: string[];
}

/** List agent slugs under `<base>/agents` (directories only). */
export function listAgents(base: string): string[] {
  const dir = resolve(base, "agents");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Run the full fleet scan. Pure of side effects except reading the agent
 * artifacts — it does NOT write the ledger or touch GitHub (the CLI does that,
 * gated behind flags).
 */
export function runScan(opts: ScanOptions = {}): ScanResult {
  const base = opts.base ?? resolveSwitchroomBase();
  const log = opts.log ?? (() => {});
  const agents = listAgents(base);

  const findings: Finding[] = [];
  const perAgent: AgentScanResult[] = [];
  const skipped: string[] = [];
  const excluded: string[] = [];
  let scanned = 0;

  for (const agent of agents) {
    // Test/synthetic agents (test-harness et al.) deliberately exercise the
    // failure paths this scanner watches (represent/obligation escalation,
    // killed turns, silent no-ops) on every UAT run. Counting them as
    // production drift inflates frequency/reach and buries the real signal, so
    // they are excluded from the ledger entirely.
    if (isTestAgent(agent)) {
      excluded.push(agent);
      log(`fleet-health: excluding test/synthetic agent ${agent} from drift counts`);
      continue;
    }
    const turnsPath = resolve(base, "agents", agent, "turns.jsonl");
    const gwPath = resolve(base, "logs", agent, "gateway-supervisor.log");
    let turnsText = "";
    let gwText = "";
    let sawArtifact = false;
    try {
      if (existsSync(turnsPath)) {
        turnsText = readFileSync(turnsPath, "utf-8");
        sawArtifact = true;
      }
    } catch (e) {
      log(`fleet-health: WARN skipping ${agent} turns.jsonl unreadable: ${String(e)}`);
    }
    try {
      if (existsSync(gwPath)) {
        gwText = readFileSync(gwPath, "utf-8");
        sawArtifact = true;
      }
    } catch (e) {
      log(`fleet-health: WARN ${agent} gateway log unreadable: ${String(e)}`);
    }
    if (!sawArtifact) {
      skipped.push(agent);
      continue;
    }
    try {
      const res = scanAgent(agent, turnsText, gwText, {
        silentNoopFloorTs: opts.silentNoopFloorTs,
      });
      perAgent.push(res);
      findings.push(...res.findings);
      scanned++;
    } catch (e) {
      log(`fleet-health: WARN scan failed for ${agent}: ${String(e)}`);
      skipped.push(agent);
    }
  }

  // Standalone config sensor (I2 OAuth-leak guard). Runs where the scan runs —
  // the load-bearing enforcement point for the LIVE host config (since KEN-125
  // the lint step covers the repo-managed copy unconditionally, but can only
  // reach the live copy on-host). Unresolvable/absent live config → skips with a
  // visible notice; a scoping violation escalates into the ledger like any
  // agent finding.
  const litellm = scanLitellmConfig({ path: opts.litellmConfigPath, log });
  findings.push(...litellm.findings);

  // Standalone live-state sensor: the hindsight container running CPU-only on a
  // GPU host (#4459). Same division of labour as the litellm sensor — it runs
  // where the scan runs (on-host, where docker + the GPU actually are), reads
  // the LIVE container's device state, and escalates only a PROVABLE drift into
  // the ledger. docker/nvidia unavailable → it degrades to a no-op, never a
  // false finding. The doctor check is the interactive counterpart.
  const gpuDrift = scanHindsightGpuDrift({ deps: opts.hindsightGpuDeps, log });
  findings.push(...gpuDrift.findings);

  const prior = readLedgerIfPresent(base);
  const ledger = buildLedger(findings, {
    ownerAgent: opts.ownerAgent,
    now: opts.now,
    windowDays: opts.windowDays,
    prior,
  });

  return {
    ledger,
    perAgent,
    agentsScanned: scanned,
    agentsSkipped: skipped,
    agentsExcluded: excluded,
  };
}

/** Read the existing ledger (for GH-number carry-forward + count-drop), or
 *  null if absent/unreadable. */
export function readLedgerIfPresent(base: string): FleetHealthLedger | null {
  const path = ledgerPathForBase(base);
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as FleetHealthLedger;
  } catch {
    return null;
  }
}

/** The ledger path for a given base dir (`<base>/fleet-health/ledger.json`).
 *  Delegates to the read-side resolver so writer + reader can never diverge. */
export function ledgerPathForBase(base: string): string {
  return fleetHealthLedgerPath(dirname(base));
}

/** Write the ledger to disk (creating the dir), pretty-printed. */
export function writeLedger(base: string, ledger: FleetHealthLedger): string {
  const path = ledgerPathForBase(base);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n", "utf-8");
  return path;
}
