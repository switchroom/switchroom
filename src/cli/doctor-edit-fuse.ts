/**
 * Doctor probe: WARN when the Telegram edit-flood fuse is disabled.
 *
 * ## Why this exists
 *
 * `SWITCHROOM_EDIT_FUSE=0` turns off the edit-flood fuse
 * (`telegram-plugin/edit-flood-fuse.ts`) — the only outbound layer whose
 * per-class ceilings sit BELOW Telegram's ban threshold (the ceilings in
 * `edit-flood-fuse.ts:56-66`). With it off, the remaining pacing (the 20s /
 * per-turn `progress_update` floor and `robustApiCall`'s post-hoc 429 backoff)
 * is a single ban-capable layer: it slows the outbound stream but nothing keeps
 * cadence under the threshold that earns an escalating flood ban.
 *
 * The kill-switch is meant for short local debugging. The failure mode is an
 * operator who flips it to debug something, forgets, and re-exposes ban-capable
 * edit cadence with no standing signal. This probe is that signal.
 *
 * ## What it reads
 *
 * The fuse runs inside each agent's gateway process, reading `process.env`; the
 * container's environment is projected from the cascade-resolved `env:` block in
 * `switchroom.yaml` (`src/agents/compose.ts` → compose `environment:`). So the
 * doctor's own `process.env` is NOT authoritative — the per-agent resolved
 * config is. This iterates agents, resolves each one's effective env, and asks
 * the SAME function the runtime uses (`editFloodFuseConfigFromEnv`) whether the
 * fuse would be disabled, so doctor and runtime can never disagree.
 */

import { resolveAgentConfig } from "../config/merge.js";
import { editFloodFuseConfigFromEnv } from "../../telegram-plugin/edit-flood-fuse.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

const ENV_KEY = "SWITCHROOM_EDIT_FUSE";

/**
 * For each configured agent, resolve its effective env and flag the ones whose
 * `SWITCHROOM_EDIT_FUSE` value disables the fuse. Silent (no row) when every
 * agent keeps the fuse on — this section reports problems only, matching the
 * flood-pressure section's posture.
 */
export function runEditFuseChecks(config: SwitchroomConfig): CheckResult[] {
  const disabled: string[] = [];
  for (const [name, agentConfig] of Object.entries(config.agents ?? {})) {
    const resolved = resolveAgentConfig(
      config.defaults,
      config.profiles,
      agentConfig,
    );
    const value = resolved.env?.[ENV_KEY];
    if (value === undefined) continue;
    // Decide disabled/enabled through the runtime's own parser so this probe
    // can never diverge from what the gateway actually does with the value.
    if (!editFloodFuseConfigFromEnv({ [ENV_KEY]: value }).enabled) {
      disabled.push(name);
    }
  }

  if (disabled.length === 0) return [];

  return [
    {
      name: "edit-flood fuse enabled",
      status: "warn",
      detail:
        `${ENV_KEY} is disabled for ${disabled.length} agent(s): ${disabled.join(", ")} — ` +
        `flood protection is reduced to a single ban-capable layer. The edit-flood ` +
        `fuse is the only layer whose ceilings sit below Telegram's flood-ban ` +
        `threshold (edit-flood-fuse.ts:56-66); with it off, an escalating flood ban ` +
        `can recur.`,
      fix:
        `Remove ${ENV_KEY} (or set it to 1) from each agent's env block in ` +
        `switchroom.yaml, then restart the agent. The kill-switch is for short ` +
        `debugging only — left off it re-exposes ban-capable edit cadence.`,
    },
  ];
}
