/**
 * Timezone health check for `switchroom doctor` (#2483).
 *
 * A fresh `switchroom setup` never sets `switchroom.timezone`, so
 * `resolveTimezone()` falls through to `detectServerTimezone()`, which
 * returns "UTC" on a bare cloud VM. Compose then stamps `TZ=UTC` and
 * cron is evaluated in UTC — `0 8 * * *` fires hours off the operator's
 * actual local time. This is a correctness bug, not cosmetic.
 *
 * The setup wizard now prompts/writes an explicit zone, and apply prints
 * a one-off warning. But installs that bypassed the wizard (hand-written
 * config, restored backup, pre-#2483 fleet) still silently run UTC. This
 * doctor check is the durable surface that catches them: it reuses the
 * exact `classifyTimezoneSource()` + `resolveTimezone()` cascade the
 * runtime uses, and WARNs (never fails — a legitimately-UTC fleet is
 * valid) when the resolved zone is UTC purely because it fell through to
 * server detection with no explicit value at any layer.
 *
 * Pure renderer over the config — no I/O beyond the cheap server probe
 * the resolver already does. Mirrors the shape/registration of the other
 * `doctor-*.ts` modules.
 */

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";
import { resolveAgentConfig } from "../config/merge.js";
import {
  classifyTimezoneSource,
  resolveTimezone,
  type ResolveTimezoneOpts,
} from "../config/timezone.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/**
 * One doctor row for the fleet's timezone posture.
 *
 * The cascade (agent → profile/defaults → switchroom.timezone → server
 * detection) is per-agent, but the only failure mode worth surfacing is
 * fleet-wide: NO explicit zone anywhere AND server detection landed on
 * UTC. When that holds, every agent that lacks an explicit override
 * resolves to UTC-by-accident. We pick any agent (they all share the
 * global + detection layers) — or, with no agents, classify against an
 * empty agent so the global-vs-detected distinction still holds.
 *
 * `tzOpts` injects the server-detection probes (so a test can force the
 * detected-UTC condition without depending on the host's /etc);
 * production callers omit it and the real /etc probes run.
 *
 * Exported for unit testing.
 */
export function checkTimezone(
  config: SwitchroomConfig,
  tzOpts: ResolveTimezoneOpts = {},
): CheckResult {
  const agentEntries = Object.entries(config.agents ?? {});

  // Resolve against a representative agent. Any agent shares the global
  // + server-detection tail of the cascade; an agent-level override only
  // makes the verdict *better* (source !== "detected"), so if even one
  // agent has no override and we land on detected-UTC, that's the case
  // we want to flag. Check every agent and warn if ANY resolves to
  // detected-UTC; report the explicit global when one is set.
  if (agentEntries.length === 0) {
    // No agents yet (fresh bootstrap). Classify the bare cascade so the
    // operator still sees whether a global zone is set.
    const emptyAgent = {} as Parameters<typeof resolveTimezone>[1];
    const source = classifyTimezoneSource(config, emptyAgent);
    const resolved = resolveTimezone(config, emptyAgent, tzOpts);
    return timezoneVerdict(source, resolved);
  }

  let detectedUtcAgents = 0;
  let explicitGlobal: string | undefined;
  let sampleResolved = "UTC";
  for (const [, agentConfigRaw] of agentEntries) {
    const agentConfig = resolveAgentConfig(
      config.defaults,
      config.profiles,
      agentConfigRaw,
    );
    const source = classifyTimezoneSource(config, agentConfig);
    const resolved = resolveTimezone(config, agentConfig, tzOpts);
    if (source === "detected" && resolved === "UTC") {
      detectedUtcAgents++;
    }
    if (source === "global") explicitGlobal = resolved;
    sampleResolved = resolved;
  }

  if (detectedUtcAgents > 0) {
    return {
      name: "timezone configured",
      status: "warn",
      detail:
        `${detectedUtcAgents} agent(s) resolve to UTC via server detection — ` +
        "no explicit timezone at any config layer. The host has no local zone " +
        "(typical bare cloud VM), so agents' per-turn time hint and cron " +
        "evaluation run in UTC, often hours off the operator's real time.",
      fix:
        "Set `switchroom.timezone: <Region/City>` (e.g. \"Australia/Melbourne\") " +
        "in switchroom.yaml, then `switchroom apply`. Per-agent overrides go " +
        "under agents.<name>.timezone.",
    };
  }

  if (explicitGlobal) {
    return {
      name: "timezone configured",
      status: "ok",
      detail: `switchroom.timezone: ${explicitGlobal}`,
    };
  }

  return {
    name: "timezone configured",
    status: "ok",
    detail: `resolved to ${sampleResolved}`,
  };
}

/** Render a verdict from a pre-computed source + resolved zone (no-agents path). */
function timezoneVerdict(
  source: "agent" | "global" | "detected",
  resolved: string,
): CheckResult {
  if (source === "detected" && resolved === "UTC") {
    return {
      name: "timezone configured",
      status: "warn",
      detail:
        "no explicit timezone set and server detection resolved to UTC — " +
        "agents will run in UTC (often hours off the operator's real time).",
      fix:
        "Set `switchroom.timezone: <Region/City>` (e.g. \"Australia/Melbourne\") " +
        "in switchroom.yaml, then `switchroom apply`.",
    };
  }
  return {
    name: "timezone configured",
    status: "ok",
    detail:
      source === "global"
        ? `switchroom.timezone: ${resolved}`
        : `resolved to ${resolved}`,
  };
}

/** Section entry point for doctor.ts — returns the single timezone row. */
export function runTimezoneChecks(
  config: SwitchroomConfig,
  tzOpts: ResolveTimezoneOpts = {},
): CheckResult[] {
  return [checkTimezone(config, tzOpts)];
}
