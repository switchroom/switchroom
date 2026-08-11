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
 * with the resulting `changes` list. The reconcile is narrowed to the
 * cron surface by `skipNonCronWrites` (#4607); the post-hoc non-cron
 * check that remains is an invariant assertion over that narrowing, not
 * the narrowing itself.
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
      // skipProfileTemplates: this bridge runs INSIDE an agent container
      // where the bundled `profiles/` tree is not shipped (see
      // docker/Dockerfile.agent — only dist/cli/switchroom.js is copied,
      // not the `profiles/` sibling). The default reconcile path re-renders
      // start.sh + CLAUDE.md from those templates, which throws ENOENT
      // ('/profiles/_base/start.sh.hbs') here and rolls the overlay back.
      // A cron-only reconcile has no business re-rendering profile
      // templates anyway — schedule changes only mutate `schedule.d/` and
      // generated `cron.d/` scripts. See switchroom #1618.
      // skipNonCronWrites: the actual cron-only opt-out (#4607). Without
      // it this call ran the FULL reconcile and the guard below rejected
      // the result *after* the scaffold writers had already committed to
      // disk — so the first schedule_add/schedule_remove after any
      // scaffold drift returned E_RECONCILE_FAILED having mutated both
      // the overlay and the scaffold, and only the retry succeeded
      // (content-gated writers make the second render a no-op). The flag
      // suppresses every non-cron writer instead of detecting it late;
      // see ReconcileOptions.skipNonCronWrites for the gated set.
      { skipProfileTemplates: true, skipNonCronWrites: true },
    );
    const changes = [...result.changes];
    // Invariant assertion, not a filter. `skipNonCronWrites` gates every
    // known non-cron writer that reports into `changes`, so a non-cron
    // entry HERE means a new `changes.push` writer was added without a
    // gate. Keeping the check makes that regression loud at the first
    // call instead of silently widening the cron-only contract.
    //
    // Note the reach: this can only see writes that surface in `changes`.
    // A non-cron writer that pushes nothing is invisible to it — which is
    // why the gate, not this check, is the fix for #4607, and why the
    // remaining ungated `changes`-invisible writes on this path are
    // tracked as a follow-up rather than assumed absent.
    const nonCron = changes.filter((p) => classifyChangeKind(p) !== "cron");
    if (nonCron.length > 0) {
      return {
        ok: false,
        error:
          `non-cron changes surfaced during cron-only reconcile ` +
          `(ungated writer — see ReconcileOptions.skipNonCronWrites): ${nonCron.join(", ")}`,
      };
    }
    const r = applyCronChangesHot(agent, changes);
    return { ok: true, changes, cronScripts: r.cronScripts };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
