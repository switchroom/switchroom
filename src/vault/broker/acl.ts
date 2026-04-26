/**
 * vault-broker ACL — per-cron access control for vault key requests.
 *
 * Identity is established via cgroup membership, not the exe path. When
 * systemd starts a cron unit (`switchroom-<agent>-cron-<i>.service`), it
 * places the process in a dedicated cgroup that it writes as root. Processes
 * cannot move themselves between cgroups from userspace, making the unit name
 * unspoofable.
 *
 * Logic (fail-closed on any error):
 *
 *   1. UID must equal the broker's own UID. (Enforced by peercred before
 *      ACL is consulted; documented here for clarity.)
 *
 *   2. If `peer.systemdUnit` matches `switchroom-<agent>-cron-<i>.service`:
 *      `<agent>` and `<i>` are parsed from the unit name. Then
 *      `config.agents[<agent>].schedule[<i>].secrets` (added by PR 1) is
 *      looked up. If the requested key appears in that array, access is
 *      granted. Otherwise: deny.
 *
 *   3. Interactive fallback: if `config.vault.broker.allow_interactive` is
 *      true AND `peer.exe` matches the installed `switchroom` CLI binary
 *      (<bunBinDir>/switchroom), access is granted. Default: false.
 *
 *   4. Otherwise: deny.
 *
 * allow_interactive is gated off by default so ordinary users can't use
 * `switchroom vault get <key>` to read any key without being in an explicit
 * ACL. Operators who want an interactive shell workflow enable it explicitly.
 */

import { resolve, join } from "node:path";
import { homedir } from "node:os";
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
 * Parse a systemd unit name as a switchroom cron unit.
 * Returns { agentName, index } or null if not a recognized cron unit.
 *
 * Expected format: switchroom-<agent>-cron-<index>.service
 * where <agent> consists of [a-zA-Z0-9_-]+ characters.
 *
 * Note: agent names may themselves contain hyphens, so we match greedily
 * from the left up to the last `-cron-<digits>.service` suffix.
 */
export function parseCronUnit(
  unitName: string,
): { agentName: string; index: number } | null {
  // Match: switchroom-<agent>-cron-<N>.service
  // The agent name can contain hyphens, so use a greedy match up to the
  // last occurrence of -cron-<digits>.service
  const m = unitName.match(/^switchroom-([a-zA-Z0-9_-]+)-cron-(\d+)\.service$/);
  if (!m) return null;

  // The above regex is greedy, so m[1] will consume the agent name including
  // any hyphens. We need to strip the trailing "-cron-<N>" that may have been
  // captured as part of the agent name if the agent itself contains "cron".
  // Since the regex anchors at -cron-<digits>.service at the end, m[1] is
  // everything between "switchroom-" and "-cron-<N>.service".
  const agentName = m[1];
  const index = parseInt(m[2], 10);

  if (!agentName) return null;

  return { agentName, index };
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

  // ── Cgroup-based cron identity ─────────────────────────────────────────
  if (peer.systemdUnit !== null) {
    const parsed = parseCronUnit(peer.systemdUnit);

    if (parsed === null) {
      return {
        allow: false,
        reason: `systemd unit '${peer.systemdUnit}' does not match switchroom cron unit naming convention`,
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

  // ── Allow interactive: the installed switchroom CLI ────────────────────
  // Only reached when systemdUnit is null (caller is not a cron unit).
  // /proc/<pid>/exe always resolves to a bare binary path with no args.
  const allowInteractive = config.vault?.broker?.allow_interactive ?? false;
  if (allowInteractive) {
    const switchroomCli = join(bunBinDir, "switchroom");
    if (peer.exe === switchroomCli) {
      return { allow: true };
    }
  }

  return {
    allow: false,
    reason: `caller is not a switchroom cron unit (no cgroup match) and allow_interactive is disabled`,
  };
}
