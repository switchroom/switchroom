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

import { readFileSync } from "node:fs";
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

/**
 * Verify the local tzdata database still says UTC is UTC.
 *
 * This is the loud detector for the `/etc/localtime` bind-mount defect.
 * The compose generator mounts the agent's zonefile onto
 * `/etc/localtime`; Docker resolves a bind mount's destination through
 * symlinks in the container rootfs BEFORE mounting, and stock Debian
 * tzdata ships `/etc/localtime -> /usr/share/zoneinfo/Etc/UTC` — so on
 * any image built before the `Dockerfile.agent` de-symlink step, the
 * daemon wrote the LOCAL zonefile over `Etc/UTC`. Every by-name UTC
 * lookup in the tzdata DB then returns local time: `TZ=UTC date`,
 * Python `zoneinfo.ZoneInfo("UTC")`, and any Go/Java/Rust binary reading
 * the OS zoneinfo DB. Node is immune (bundled full-ICU), which is
 * exactly why nothing ever surfaced an error.
 *
 * `fail`, not `warn`: a wrong UTC is a silent multi-hour correctness
 * bug, not a posture preference. There is no legitimate configuration in
 * which `Etc/UTC` carries a non-zero offset.
 *
 * Reads the zonefile bytes directly rather than going through `Intl` —
 * Node's bundled ICU reports a correct UTC even on a corrupted host, so
 * an `Intl`-based check would mask the very defect this row exists to
 * catch.
 *
 * Scope note: this inspects the filesystem `switchroom doctor` is
 * RUNNING on. On the host that is a near-certain pass (the host is not
 * where the mount lands), so it is cheap insurance rather than the
 * primary per-agent detector — that is the `tzdata` probe in hostd's
 * `agent_smoke` battery (`src/host-control/server.ts`), which runs
 * inside each container. This row is what catches it when `doctor` runs
 * in-container (the CLI is baked into the agent image at
 * `/usr/local/bin/switchroom`).
 *
 * Exported for unit testing. `zoneinfoRoot` is injectable so a test can
 * point at a fixture tree without mutating the host's /usr/share.
 */
export function checkZoneinfoIntegrity(
  zoneinfoRoot = "/usr/share/zoneinfo",
): CheckResult {
  const name = "tzdata Etc/UTC integrity";
  const path = `${zoneinfoRoot}/Etc/UTC`;
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    // No tzdata at all (exotic/minimal host). Nothing to verify and
    // nothing is being corrupted — report skip, never fail.
    return {
      name,
      status: "skip",
      detail: `${path} not present — no tzdata to verify`,
    };
  }

  const offset = readTzifGmtOffset(buf);
  if (offset === undefined) {
    return {
      name,
      status: "skip",
      detail: `${path} is not a parseable TZif file — cannot verify`,
    };
  }
  if (offset === 0) {
    return { name, status: "ok", detail: `${path} decodes to UTC+00:00` };
  }

  // Report the raw seconds, not a derived hour count: on a clobbered
  // file the first ttinfo is the source zone's LMT record (e.g. +34792
  // for Australia/Melbourne), which is NOT that zone's current offset.
  // Claiming "10 hours out" from it would be pseudo-precise.
  return {
    name,
    status: "fail",
    detail:
      `${path} is not UTC — its first UT offset is ${offset}s, not 0. ` +
      "Some other zone's data has been written over it. Every by-name UTC " +
      "lookup in the tzdata DB (TZ=UTC date, Python " +
      'zoneinfo.ZoneInfo("UTC"), Go/Java/Rust) returns that zone\'s local ' +
      "time here, silently and with no error. Node is unaffected (bundled " +
      "full-ICU), so nothing else will report this.",
    fix:
      "Almost always the /etc/localtime bind mount landing on the symlink's " +
      "target: this container's image predates the Dockerfile.agent " +
      "de-symlink step. Rebuild the agent image and recreate the container " +
      "(`switchroom apply`). Verify with `ls -la /etc/localtime` — it must " +
      "be a regular file, not a symlink into /usr/share/zoneinfo.",
  };
}

/**
 * Read the first ttinfo UT offset from a TZif buffer, in seconds.
 * Returns undefined when the buffer is not a TZif file or carries no
 * ttinfo record.
 *
 * TZif layout (RFC 8536 §3.1): magic[4] "TZif", version[1],
 * reserved[15], then six 4-byte big-endian counts — isutcnt, isstdcnt,
 * leapcnt, timecnt, typecnt, charcnt — at offsets 20, 24, 28, 32, 36,
 * 40. The v1 data block starts at 44 with `timecnt` 4-byte transition
 * times, then `timecnt` 1-byte type indices, then `typecnt` 6-byte
 * ttinfo records whose first 4 bytes are the signed UT offset. A real
 * UTC zonefile has no transitions and exactly one ttinfo at offset 0.
 */
function readTzifGmtOffset(buf: Buffer): number | undefined {
  if (buf.length < 44 || buf.subarray(0, 4).toString("latin1") !== "TZif") {
    return undefined;
  }
  const timecnt = buf.readUInt32BE(32);
  const typecnt = buf.readUInt32BE(36);
  if (typecnt === 0) return undefined;
  const ttinfoStart = 44 + timecnt * 4 + timecnt * 1;
  if (buf.length < ttinfoStart + 6) return undefined;
  return buf.readInt32BE(ttinfoStart);
}

/** Section entry point for doctor.ts — returns the timezone rows. */
export function runTimezoneChecks(
  config: SwitchroomConfig,
  tzOpts: ResolveTimezoneOpts = {},
): CheckResult[] {
  return [checkTimezone(config, tzOpts), checkZoneinfoIntegrity()];
}
