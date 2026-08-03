/**
 * `switchroom doctor` probe for a DEAD `session_continuity.briefing: gateway`
 * flag (#4244, follow-up to #4214 adversarial review low #3).
 *
 * ## Why this exists
 *
 * `briefing: gateway` moves the fresh-session reorientation briefing off the
 * Stop-hook `.handoff.md` / `handoff-briefing.sh --append-system-prompt` path
 * and onto the gateway daemon, which assembles it at boot from the durable
 * `history.db` and injects it as a `<channel source="boot_briefing">` inbound.
 * That path has PREREQUISITES the flag itself does not enforce, and when one is
 * missing NEITHER path produces a briefing — the legacy path is disabled
 * (start.sh skips `handoff-briefing.sh` whenever the mode is `gateway`, see
 * `profiles/_base/start.sh.hbs`), and the gateway path never fires. The
 * operator sees `briefing: gateway` in their YAML and believes reorientation is
 * on; it silently does nothing. This probe gives that dead combination a
 * standing, named signal.
 *
 * ## The dead combinations, and why each kills the briefing
 *
 *  1. `channels.telegram.enabled: false` — start.sh skips the gateway supervise
 *     loop entirely (smoke-test / offline-dev posture). No gateway → no
 *     boot-briefing builder ever runs.
 *  2. `channels.telegram.plugin: official` — the upstream marketplace plugin is
 *     basic send/receive; it has no gateway daemon, no `history.db`, and no
 *     boot-briefing builder. The flag has nothing to act on.
 *  3. Non-docker runtime — the ONLY place `SWITCHROOM_SESSION_BRIEFING` is
 *     threaded to the gateway is start.sh's docker OUTER pass, which exports it
 *     *before* forking the gateway (the env-fork landmine the
 *     scaffold.gateway-env-order tests pin). Under the host/systemd runtime the
 *     gateway is a sibling unit that never receives that export, so the builder
 *     reads the mode as unset (`legacy`) and stays silent.
 *  4. `historyEnabled: false` in the agent's `access.json` — the gateway gates
 *     `initHistory` and the whole briefing on `HISTORY_ACCESS.historyEnabled
 *     !== false` (gateway.ts). With history off there is no `history.db` to
 *     source the briefing from.
 *
 * ## Signal shape
 *
 * Narrow: only agents that actually set `briefing: gateway` are considered.
 * Such an agent earns exactly one row —
 *   - all prerequisites satisfied → `ok` (positive confirmation the feature is
 *     live, which is the whole point given the SILENT failure mode this closes);
 *   - one or more prerequisites missing → `warn`, listing every reason.
 * `warn`, not `fail`: the flag is a misconfiguration the operator can fix, not a
 * broken invariant — and `fail` would set `switchroom doctor`'s exit non-zero on
 * a state that still boots fine (just without a briefing).
 *
 * Runtime (docker vs host) and `access.json` reads are dependency-injected so
 * the unit tests drive every branch without a real scaffold tree or a live
 * container environment.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { isDockerMode } from "./doctor-docker.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface BootBriefingProbeDeps {
  /** Whether the fleet runs under the docker runtime (the only runtime that
   *  threads SWITCHROOM_SESSION_BRIEFING to the gateway). */
  isDocker: () => boolean;
  /** Read an agent's `access.json` text, or throw (ENOENT when absent). */
  readAccess: (path: string) => string;
  /** Override the agents dir (else derived from config). */
  agentsDir?: string;
}

const defaultDeps: BootBriefingProbeDeps = {
  isDocker: () => isDockerMode(),
  readAccess: (p) => readFileSync(p, "utf-8"),
};

/**
 * Read `historyEnabled` from an agent's access.json.
 *
 * Returns `false` ONLY when the file exists and explicitly sets
 * `historyEnabled: false` — matching the gateway's own gate
 * (`HISTORY_ACCESS.historyEnabled !== false`). A missing file, an unreadable
 * file, corrupt JSON, or an absent key all read as "not disabled" (the default
 * is on): this probe must not cry "history off" on an agent that simply has not
 * been scaffolded yet, and access.json is agent-UID-owned so the host operator
 * may not be able to read it.
 */
export function historyExplicitlyDisabled(
  readAccess: (path: string) => string,
  accessPath: string,
): boolean {
  let text: string;
  try {
    text = readAccess(accessPath);
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (parsed == null || typeof parsed !== "object") return false;
  return (parsed as Record<string, unknown>).historyEnabled === false;
}

export function runBootBriefingChecks(
  config: SwitchroomConfig,
  deps: BootBriefingProbeDeps = defaultDeps,
): CheckResult[] {
  const results: CheckResult[] = [];
  const agents = Object.keys(config.agents ?? {});
  if (agents.length === 0) return results;

  let agentsDir = deps.agentsDir;
  if (agentsDir === undefined) {
    try {
      agentsDir = resolveAgentsDir(config);
    } catch {
      agentsDir = undefined;
    }
  }

  const docker = deps.isDocker();

  for (const agent of agents.sort()) {
    const raw = config.agents[agent];
    if (!raw) continue;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, raw);
    const briefing = resolved.session_continuity?.briefing;
    if (briefing !== "gateway") continue; // only the gateway flag has prerequisites

    const tg = resolved.channels?.telegram;
    const reasons: string[] = [];

    if (tg?.enabled === false) {
      reasons.push(
        "`channels.telegram.enabled: false` — start.sh skips the gateway " +
          "supervise loop, so the boot-briefing builder never runs",
      );
    }
    if (tg?.plugin === "official") {
      reasons.push(
        "`channels.telegram.plugin: official` — the upstream plugin has no " +
          "gateway daemon or history.db, so it cannot assemble the briefing",
      );
    }
    if (!docker) {
      reasons.push(
        "the runtime is not docker — SWITCHROOM_SESSION_BRIEFING is threaded " +
          "to the gateway only by start.sh's docker outer pass (before the " +
          "gateway fork); a host/systemd gateway unit never receives it and " +
          "reads the mode as unset (legacy)",
      );
    }
    if (agentsDir !== undefined) {
      const accessPath = resolve(agentsDir, agent, "telegram", "access.json");
      if (historyExplicitlyDisabled(deps.readAccess, accessPath)) {
        reasons.push(
          "`historyEnabled: false` in access.json — the gateway gates the " +
            "briefing on history being on, so there is no history.db to source " +
            "it from",
        );
      }
    }

    const name = `boot-briefing: ${agent}`;
    if (reasons.length === 0) {
      results.push({
        name,
        status: "ok",
        detail:
          "`briefing: gateway` is fully wired (telegram gateway on, switchroom " +
          "plugin, docker runtime, history enabled)",
      });
      continue;
    }

    results.push({
      name,
      status: "warn",
      detail:
        "`session_continuity.briefing: gateway` is set but does NOTHING here — " +
        "the legacy handoff-briefing path is disabled for this mode AND the " +
        "gateway path is unreachable: " +
        reasons.map((r) => `\n    • ${r}`).join(""),
      fix:
        "Either fix the prerequisite(s) above, or drop " +
        "`session_continuity.briefing` back to `legacy` (the default) so the " +
        "Stop-hook handoff briefing runs instead. Restart the agent after the " +
        "change — the briefing mode is read once at boot.",
    });
  }

  return results;
}
