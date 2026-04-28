/**
 * vault-broker ACL — per-cron access control for vault key requests.
 *
 * The broker is for cron-driven access. Interactive `switchroom vault get`
 * runs against the vault file directly with the user's passphrase — it
 * does not need (and never had a real reason to use) the broker. Issue #129
 * dropped the broker's interactive fallback for this reason: the symlink-
 * fragile `peer.exe == bunBinDir/switchroom` check it relied on was both
 * easy to bypass (npx, wrappers, $PATH) and easy to break (rename, move,
 * different package manager).
 *
 * Identity is established via cgroup membership. When systemd starts a
 * cron unit (`switchroom-<agent>-cron-<i>.service`), it places the process
 * in a dedicated cgroup that it writes as root. Processes cannot move
 * themselves between cgroups from userspace, making the unit name
 * unspoofable.
 *
 * Logic (fail-closed on any error):
 *
 *   1. UID must equal the broker's own UID. (Enforced by peercred before
 *      ACL is consulted; documented here for clarity.)
 *
 *   2. If `peer.systemdUnit` matches `switchroom-<agent>-cron-<i>.service`:
 *      `<agent>` and `<i>` are parsed from the unit name. Then
 *      `config.agents[<agent>].schedule[<i>].secrets` is looked up.
 *      If the requested key appears in that array, access is granted.
 *      Otherwise: deny.
 *
 *   3. Otherwise: deny. Use `switchroom vault get --no-broker` to read
 *      directly from the vault file with your passphrase.
 *
 * Note on threat model: the per-cron `secrets[]` allowlist is
 * misconfiguration protection (a typo lets cron-A read cron-B's keys),
 * not a security boundary. Anyone who can edit cron scripts can also edit
 * the config to grant any key. See [docs/architecture.md] for the full
 * framing.
 */

import type { SwitchroomConfig } from "../../config/schema.js";
import type { PeerInfo } from "./peercred.js";
import type { VaultEntryScope } from "../vault.js";

export interface AclAllow {
  allow: true;
}

export interface AclDeny {
  allow: false;
  reason: string;
}

export type AclResult = AclAllow | AclDeny;

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
 * Extract the agent slug from a PeerInfo's systemd unit name.
 *
 * For a cron unit "switchroom-clerk-cron-0.service", returns "clerk".
 * Returns null when the peer is not a recognised cron unit (systemdUnit is
 * null, or the name doesn't parse — same input as parseCronUnit).
 *
 * This is the canonical place to go from PeerInfo → agent slug; keep it
 * pure so tests can call it without starting a broker.
 */
export function agentSlugFromPeer(peer: PeerInfo): string | null {
  if (peer.systemdUnit === null) return null;
  const parsed = parseCronUnit(peer.systemdUnit);
  return parsed?.agentName ?? null;
}

/**
 * Evaluate a VaultEntry's per-entry scope against the calling agent slug.
 *
 * Called AFTER the existing checkAcl() cron-unit ACL passes. Both checks
 * must pass before a secret is returned.
 *
 * Rules (fail-closed):
 *   - scope undefined/null                → allowed (back-compat, all callers)
 *   - agentSlug in scope.deny            → denied:scope-deny
 *   - scope.allow is non-empty AND
 *     agentSlug NOT in scope.allow       → denied:scope-allow
 *   - otherwise                          → allowed
 *
 * agentSlug may be null when the caller is a cron unit whose name parses
 * correctly but agentSlugFromPeer returned null for another reason. In that
 * edge case we treat the entry as scope-restricted and deny if any allow
 * list is present — fail-closed.
 */
export function checkEntryScope(
  scope: VaultEntryScope | undefined,
  agentSlug: string | null,
): AclResult {
  if (scope === undefined || scope === null) {
    return { allow: true };
  }

  const deny = scope.deny ?? [];
  const allow = scope.allow ?? [];

  if (agentSlug !== null && deny.includes(agentSlug)) {
    return {
      allow: false,
      reason: `agent '${agentSlug}' is in the entry's deny list (scope-deny)`,
    };
  }

  if (allow.length > 0) {
    if (agentSlug === null || !allow.includes(agentSlug)) {
      return {
        allow: false,
        reason: agentSlug === null
          ? "caller agent slug could not be determined; entry has a non-empty allow list (scope-allow)"
          : `agent '${agentSlug}' is not in the entry's allow list (scope-allow)`,
      };
    }
  }

  return { allow: true };
}

/**
 * Check whether a caller identified by PeerInfo may access a vault key.
 *
 * @param peer    Caller identity from peercred.identify()
 * @param config  The loaded SwitchroomConfig
 * @param key     The vault key being requested
 */
export function checkAcl(
  peer: PeerInfo,
  config: SwitchroomConfig,
  key: string,
): AclResult {
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
        reason: `key '${key}' not in ACL for ${agentName}/schedule[${index}]`,
      };
    }

    return { allow: true };
  }

  // ── Non-cron callers are not served by the broker ──────────────────────
  // Use `switchroom vault get --no-broker` for interactive access.
  return {
    allow: false,
    reason: "caller is not a switchroom cron unit; use 'switchroom vault get --no-broker' for interactive access",
  };
}
