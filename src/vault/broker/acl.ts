/**
 * vault-broker ACL — per-cron access control for vault key requests.
 *
 * Logic (fail-closed on any error):
 *
 *   1. UID must equal the broker's own UID. (Enforced by peercred before
 *      ACL is consulted; documented here for clarity.)
 *
 *   2. The caller's exe is matched against the cron script convention:
 *        ~/.switchroom/agents/<agent>/telegram/cron-<i>.sh
 *      `<agent>` and `<i>` are parsed from the path.
 *
 *   3. `config.agents[<agent>].schedule[<i>].secrets` (added by PR 1) is
 *      looked up. If the requested key appears in that array, access is
 *      granted.
 *
 *   4. Interactive fallback: if `config.vault.broker.allow_interactive` is
 *      true AND the exe matches the installed `switchroom` CLI binary
 *      (<bunBinDir>/switchroom), access is granted. Default: false.
 *
 *   5. Otherwise: deny.
 *
 * allow_interactive is gated off by default so ordinary users can't use
 * `switchroom vault get <key>` to read any key without being in an explicit
 * ACL. Operators who want an interactive shell workflow enable it explicitly.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { SwitchroomConfig } from "../../config/schema.js";
import type { PeerInfo } from "./peercred.js";

export interface AclAllow {
  allow: true;
}

export interface AclDeny {
  allow: false;
  reason: string;
}

export type AclResult = AclAllow | AclDeny;

/**
 * Options for ACL checking, injectable for tests.
 */
export interface AclOpts {
  /** Override for the home directory (default: os.homedir()) */
  homeDir?: string;
  /** Override for the bun bin directory (default: ~/.bun/bin) */
  bunBinDir?: string;
}

/**
 * Resolve the agents base directory from config or default.
 */
function agentsDir(config: SwitchroomConfig, homeDir: string): string {
  const raw = config.switchroom?.agents_dir ?? "~/.switchroom/agents";
  return raw.startsWith("~/") ? join(homeDir, raw.slice(2)) : resolve(raw);
}

/**
 * Parse an exe path as a cron script under the agents dir.
 * Returns { agentName, index } or null if not a recognized cron script.
 *
 * Expected convention (from scaffold.ts buildCronScript):
 *   <agentsDir>/<agentName>/telegram/cron-<index>.sh
 */
function parseCronExe(
  exe: string,
  baseAgentsDir: string,
): { agentName: string; index: number } | null {
  // Normalize both paths to eliminate trailing slashes and relative segments
  const normalizedAgentsDir = resolve(baseAgentsDir);
  const normalizedExe = resolve(exe);

  // exe must be under <agentsDir>/
  if (!normalizedExe.startsWith(normalizedAgentsDir + "/")) return null;

  // Relative portion: <agentName>/telegram/cron-<index>.sh
  const rel = normalizedExe.slice(normalizedAgentsDir.length + 1);
  const m = rel.match(/^([^/]+)\/telegram\/cron-(\d+)\.sh$/);
  if (!m) return null;

  return { agentName: m[1], index: parseInt(m[2], 10) };
}

/**
 * Check whether a caller identified by PeerInfo may access a vault key.
 *
 * @param peer    Caller identity from peercred.identify()
 * @param config  The loaded SwitchroomConfig
 * @param key     The vault key being requested
 * @param opts    Overrides for home/bunBinDir (for tests)
 */
export function checkAcl(
  peer: PeerInfo,
  config: SwitchroomConfig,
  key: string,
  opts: AclOpts = {},
): AclResult {
  const homeDir = opts.homeDir ?? homedir();
  const bunBinDir = opts.bunBinDir ?? join(homeDir, ".bun", "bin");

  // ── Allow interactive: the installed switchroom CLI ────────────────────
  const allowInteractive = config.vault?.broker?.allow_interactive ?? false;
  if (allowInteractive) {
    const switchroomCli = join(bunBinDir, "switchroom");
    if (peer.exe === switchroomCli || peer.exe.startsWith(switchroomCli + " ")) {
      return { allow: true };
    }
  }

  // ── Cron script path matching ──────────────────────────────────────────
  const base = agentsDir(config, homeDir);
  const parsed = parseCronExe(peer.exe, base);

  if (parsed === null) {
    return {
      allow: false,
      reason: `exe '${peer.exe}' is not a recognized switchroom cron script`,
    };
  }

  const { agentName, index } = parsed;

  const agentConfig = config.agents?.[agentName];
  if (!agentConfig) {
    return { allow: false, reason: `agent '${agentName}' not found in config` };
  }

  const schedule = agentConfig.schedule ?? [];
  if (index >= schedule.length || index < 0) {
    return {
      allow: false,
      reason: `schedule index ${index} out of range for agent '${agentName}' (${schedule.length} entries)`,
    };
  }

  const entry = schedule[index];
  const allowedKeys: string[] = entry.secrets ?? [];

  if (!allowedKeys.includes(key)) {
    return {
      allow: false,
      reason: `key '${key}' not in ACL for ${agentName}/schedule[${index}] (allowed: [${allowedKeys.join(", ")}])`,
    };
  }

  return { allow: true };
}
