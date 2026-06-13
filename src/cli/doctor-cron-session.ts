/**
 * Tier-1 cron-session bridge doctor check (#2307).
 *
 * The Tier-1 cheap-cron session forks a SECOND `claude` (`<agent>-cron` bridge)
 * at agent boot — there is no lazy respawn. If that session wedges (an unseeded
 * config dir, a crash) the `<agent>-cron` bridge never registers and every
 * Tier-1 cron fire silently falls back to the (expensive) main session, saving
 * nothing. The boot wedge is invisible: the only symptom is a cost that never
 * drops.
 *
 * This probe makes it visible. For every agent the value-gate routes to a cron
 * session (`cronSessionEnabled`), it asserts the cron bridge's liveness file
 * (`telegram/.bridge-alive-cron`, written by the cron bridge with
 * SWITCHROOM_BRIDGE_ALIVE_PATH — distinct from the main bridge's `.bridge-alive`
 * so neither masks the other) is fresh:
 *   - fresh   → ok
 *   - stale/absent while cronSessionEnabled → FAIL (the session is wedged/down)
 *   - the file is agent-UID-owned 0600; an EACCES from the host operator reads
 *     as `skip`, never `fail` (mirrors the webkite/drive probes).
 * Agents with no cron session produce no result (the fleet-wide case today).
 *
 * Filesystem access is dependency-injected so unit tests drive every branch
 * without a real scaffold tree.
 */

import { statSync as realStatSync } from "node:fs";
import { resolve } from "node:path";

import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { scheduleNeedsCronSession } from "../scheduler/cron-routing.js";
import { applyDefaultTier } from "../scheduler/tier-selector.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface CronSessionProbeDeps {
  /** stat seam — returns mtimeMs, or throws (ENOENT / EACCES). */
  statMtimeMs: (path: string) => number;
  now: () => number;
}

const defaultDeps: CronSessionProbeDeps = {
  statMtimeMs: (p) => realStatSync(p).mtimeMs,
  now: () => Date.now(),
};

/**
 * Whether the value-gate routes any of this agent's schedule entries to a cron
 * session — the same computation `buildCronSessionContext` does in scaffold.ts
 * (applyDefaultTier → scheduleNeedsCronSession). Cheap-cron is treated as on
 * (the default); the cron session only actually runs when it's enabled at
 * runtime, but the scaffold renders the fork whenever the schedule routes to it.
 */
function agentRunsCronSession(config: SwitchroomConfig, agent: string): boolean {
  const raw = config.agents[agent];
  if (!raw) return false;
  const resolved = resolveAgentConfig(config.defaults, config.profiles, raw);
  const entries = (resolved.schedule ?? []).map((e) =>
    applyDefaultTier({ cron: e.cron, kind: e.kind, model: e.model, context: e.context }),
  );
  return scheduleNeedsCronSession(entries, { cheapCronEnabled: true });
}

const MAX_AGE_MS = 30_000;

export function runCronSessionChecks(
  config: SwitchroomConfig,
  deps: CronSessionProbeDeps = defaultDeps,
): CheckResult[] {
  const agentsDir = resolveAgentsDir(config);
  const results: CheckResult[] = [];

  for (const agent of Object.keys(config.agents).sort()) {
    if (!agentRunsCronSession(config, agent)) continue; // no cron session → nothing to check

    const name = `cron-session: ${agent}`;
    const alivePath = resolve(agentsDir, agent, "telegram", ".bridge-alive-cron");
    let mtimeMs: number;
    try {
      mtimeMs = deps.statMtimeMs(alivePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        results.push({
          name,
          status: "skip",
          detail: "cron-bridge liveness file present but unreadable by the operator — re-run doctor without sudo",
        });
        continue;
      }
      // ENOENT (or anything else): the cron bridge has never written its
      // liveness file → it never registered. With a cron session expected,
      // that's a wedged boot.
      results.push({
        name,
        status: "fail",
        detail: `<${agent}-cron> bridge not registered — no liveness file at ${alivePath}. Tier-1 cron fires are falling back to the (expensive) main session.`,
        fix: `Restart the agent (\`switchroom agent restart ${agent} --wait --force\`) and check /var/log/switchroom/cron-session.log for a wizard wedge.`,
      });
      continue;
    }

    const ageMs = deps.now() - mtimeMs;
    if (ageMs <= MAX_AGE_MS) {
      results.push({ name, status: "ok", detail: `<${agent}-cron> bridge live (heartbeat ${Math.round(ageMs / 1000)}s ago)` });
    } else {
      results.push({
        name,
        status: "fail",
        detail: `<${agent}-cron> bridge heartbeat is stale (${Math.round(ageMs / 1000)}s > ${MAX_AGE_MS / 1000}s) — the cron session registered then died. Tier-1 fires are falling back to main.`,
        fix: `Restart the agent (\`switchroom agent restart ${agent} --wait --force\`) and check /var/log/switchroom/cron-session.log.`,
      });
    }
  }

  return results;
}
