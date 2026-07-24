/**
 * `switchroom doctor` section: generated-surface drift (KEN-130).
 *
 * Compares every generated/synced surface against what the current
 * config + installed switchroom would render — compose file, settings
 * hooks, template stamp (start.sh / CLAUDE.md / .mcp.json + config &
 * version staleness), skills sync, and the hook scripts baked into the
 * agent image. Detectors live in src/agents/drift.ts; this module maps
 * findings to doctor rows and persists the per-agent report file the
 * gateway boot-card probe reads.
 *
 * Status contract: rows are `ok` / `warn` / `skip` ONLY — drift never
 * fails doctor, so exit codes for an otherwise-OK install are unchanged.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import { DEFAULT_COMPOSE_PATH } from "./apply.js";
import type { CheckResult } from "./doctor.js";
import {
  detectAgentDrift,
  detectComposeDrift,
  writeDriftReport,
  type DriftFinding,
  type ExecImpl,
} from "../agents/drift.js";
import { computeComposeContent } from "./write-compose.js";

export interface DriftCheckOpts {
  /** Skip docker-exec container probes (doctor --fast). */
  fast?: boolean;
  /** Suppress writing per-agent .switchroom-drift.json reports (tests). */
  writeReports?: boolean;
  /** Test injection: compose render. */
  composeCompute?: Parameters<typeof detectComposeDrift>[0]["compute"];
  /** Test injection: docker exec for the hook-script probe. */
  execImpl?: ExecImpl;
  /** Test injection: installed bin/ dir for the hook-script probe. */
  binDir?: string;
  /** Test injection: report writer. */
  reportWriter?: (agentDir: string, findings: DriftFinding[]) => void;
}

/** Render one finding as a doctor WARN row. */
function toRow(f: DriftFinding): CheckResult {
  const scope = f.agent ? `${f.agent}: ` : "";
  return {
    name: `drift: ${scope}${f.surface}`,
    status: "warn",
    detail: f.detail,
    ...(f.fix ? { fix: f.fix } : {}),
  };
}

export async function runGeneratedSurfaceDriftChecks(
  config: SwitchroomConfig,
  configPath: string | undefined,
  opts: DriftCheckOpts = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const agentsDir = resolveAgentsDir(config);
  const writeReports = opts.writeReports ?? true;
  const reportWriter = opts.reportWriter ?? writeDriftReport;

  // Surface 1 — compose (fleet-level).
  const composePath = DEFAULT_COMPOSE_PATH;
  const composeCompute =
    opts.composeCompute ??
    (async () => {
      const r = await computeComposeContent({
        config,
        composePath,
        switchroomConfigPath: configPath,
      });
      return {
        content: r.content,
        previous: r.previous,
        imageTag: r.imageTag,
        previousImageTag: r.previousImageTag,
      };
    });
  let composeFindings: DriftFinding[] = [];
  if (existsSync(composePath) || opts.composeCompute) {
    composeFindings = await detectComposeDrift({ compute: composeCompute });
    results.push(...composeFindings.map(toRow));
  }

  // Surfaces 2-6 — per agent.
  let cleanAgents = 0;
  const agentNames = Object.keys(config.agents ?? {});
  for (const name of agentNames) {
    const agentDir = resolve(agentsDir, name);
    if (!existsSync(agentDir)) continue; // never scaffolded — not drift
    let findings: DriftFinding[] = [];
    try {
      findings = detectAgentDrift(
        name,
        config.agents[name],
        agentsDir,
        config,
        configPath,
        {
          execImpl: opts.execImpl,
          binDir: opts.binDir,
          skipContainerProbes: opts.fast === true,
        },
      );
    } catch (err) {
      results.push({
        name: `drift: ${name}`,
        status: "skip",
        detail: `not checkable: ${(err as Error).message}`,
      });
      continue;
    }
    // Persist for the boot-card probe — ALWAYS, so a healed agent's
    // stale report reads clean again. Compose drift is fleet-level but
    // affects every agent's env, so it rides along in each report.
    if (writeReports) {
      reportWriter(agentDir, [...composeFindings, ...findings]);
    }
    if (findings.length === 0) {
      cleanAgents++;
    } else {
      results.push(...findings.map(toRow));
    }
  }

  if (results.length === 0) {
    results.push({
      name: "generated surfaces",
      status: "ok",
      detail: `in sync (${cleanAgents} agent${cleanAgents === 1 ? "" : "s"} checked)`,
    });
  }

  return results;
}
