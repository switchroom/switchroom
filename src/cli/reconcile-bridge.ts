/**
 * Reconcile bridge for the agent-config broker (switchroom #1163).
 *
 * `schedule_add` / `schedule_remove` write overlay YAML to
 * `~/.switchroom/agents/<name>/schedule.d/`. The on-disk write alone is
 * not enough — the running agent's cron scripts on the bind-mount must
 * also be regenerated so the next fire actually picks the change up.
 *
 * #1185 shipped `applyCronChangesHot` (cron-only hot-reload, no container
 * bounce). This bridge wires the broker write to that path: load config
 * (overlays applied), call `reconcileAgent`, then `applyCronChangesHot`
 * with the resulting `changes` list. All non-cron changes here would
 * indicate a logic bug — the broker's dry-run reconcile assertion
 * already gates that — so we treat them as `E_RECONCILE_FAILED`.
 *
 * The bridge is exported as a function so `agent-config-write.ts` can
 * accept it as a DI parameter (tests stub it).
 */

import { loadConfig, resolveAgentsDir } from "../config/loader.js";
import { reconcileAgent } from "../agents/scaffold.js";
import {
  applyCronChangesHot,
  classifyChangeKind,
} from "../agents/lifecycle.js";

export interface ReconcileBridgeResult {
  ok: true;
  changes: string[];
  cronScripts: string[];
}

export interface ReconcileBridgeError {
  ok: false;
  error: string;
}

/**
 * Reconcile a single agent's cron scripts and fire the hot-apply path.
 *
 * Returns a structured success/error result rather than throwing — the
 * write CLI needs the error message verbatim for the
 * `E_RECONCILE_FAILED` JSON envelope.
 */
export function reconcileAgentCronOnly(
  agent: string,
): ReconcileBridgeResult | ReconcileBridgeError {
  try {
    const config = loadConfig();
    const agentConfig = config.agents[agent];
    if (!agentConfig) {
      return { ok: false, error: `agent "${agent}" not in switchroom.yaml` };
    }
    const agentsDir = resolveAgentsDir(config);
    const result = reconcileAgent(
      agent,
      agentConfig,
      agentsDir,
      config.telegram,
      config,
      undefined,
      {},
    );
    const changes = [...result.changes];
    // Defensive: refuse to silently restart on non-cron changes — the
    // broker's contract is cron-only. If non-cron drift surfaces here,
    // that's a logic gap, not something we should paper over.
    const nonCron = changes.filter((p) => classifyChangeKind(p) !== "cron");
    if (nonCron.length > 0) {
      return {
        ok: false,
        error: `non-cron changes surfaced during cron-only reconcile: ${nonCron.join(", ")}`,
      };
    }
    const r = applyCronChangesHot(agent, changes);
    return { ok: true, changes, cronScripts: r.cronScripts };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
