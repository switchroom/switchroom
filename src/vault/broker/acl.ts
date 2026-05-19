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
import { isGoogleClientCredentialKeyForAgent } from "../../config/google-workspace-acl.js";

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

/**
 * Phase 2a — agent-name-keyed ACL for the socket-path-as-identity model.
 *
 * Where checkAcl() (above) is keyed on `peer.systemdUnit` (a cron-specific
 * cgroup name like switchroom-<agent>-cron-<i>.service), this variant keys
 * on a plain agent slug derived from the listener's socket path. The agent
 * identity is established by the broker container at bind time — no
 * peercred, no cgroup inspection. See peercred.socketPathToAgent.
 *
 * Allowlist semantics — fail-closed:
 *   - If config.agents[agentName] is missing → deny.
 *   - Config-derived identity-bound exceptions (checked BEFORE the
 *     schedule.secrets allowlist, because they are auth-boundary access
 *     to the single key the config binds to THIS agent, not cron-
 *     misconfiguration protection):
 *       · `google:<account>:*` account slots → gated by
 *         `google_accounts.<account>.enabled_for[]` (RFC G §4.4).
 *       · the Google OAuth client credential
 *         (`google_workspace.google_client_{id,secret}` vault refs) →
 *         gated by the same `shouldEmitGdriveMcp` predicate the scaffold
 *         uses (config/google-workspace-acl.ts).
 *       · the agent's own effective `bot_token` vault ref.
 *   - If the agent has no `schedule` array (or empty) → deny: there's no
 *     declared per-cron secrets[] to consult. Long-running agent-direct
 *     access is opted in only via populated `schedule[i].secrets`.
 *   - If `key` appears in ANY schedule entry's secrets[] → allow. We
 *     deliberately do not require the caller to identify which schedule
 *     index they are; the broker container has no way to know that, and
 *     the per-cron `secrets[]` allowlist is misconfiguration protection,
 *     not a security boundary (see acl.ts header comment).
 *   - Otherwise → deny.
 */
export function checkAclByAgent(
  config: SwitchroomConfig,
  agentName: string,
  key: string,
): AclResult {
  if (!agentName) {
    return { allow: false, reason: "agent name unresolved" };
  }

  const agentConfig = config.agents?.[agentName];
  if (!agentConfig) {
    return { allow: false, reason: `agent '${agentName}' not found in config` };
  }

  // ── RFC G §4.4 — google: slots are gated by google_accounts[].enabled_for,
  // not by per-cron schedule.secrets. The shared-token-with-per-agent-ACL
  // model exists exactly to bypass the per-agent allowlist that would
  // otherwise prevent two agents from reading the same Google account.
  // Match shape: `google:<account>:*`. The account email is extracted
  // from the slot key directly.
  const googleSlot = parseGoogleAccountSlotKey(key);
  if (googleSlot !== null) {
    return checkGoogleAccountAcl(config, agentName, googleSlot.account, key);
  }

  // RFC G §4.4, completed — the OAuth *client credential*.
  // The google: account slots above bypass schedule.secrets because the
  // Google account is the unit of trust (enabled_for[]), not a per-cron
  // allowlist. The OAuth client_id/client_secret are the one remaining
  // piece of the SAME Drive auth flow that the original RFC G ACL left
  // out: they're referenced from config (`google_workspace.
  // google_client_{id,secret}`), commonly as `vault:` refs (the
  // documented `switchroom auth google connect` shape). Without this
  // clause the `gdrive` MCP is dead on arrival fleet-wide — the launcher
  // is broker-denied the client secret before it can spawn, even though
  // every other layer (account slot, scaffold, MCP trust) is correctly
  // wired. This is identity-bound access to the single credential the
  // config binds to THIS agent's gdrive MCP — NOT cross-agent access —
  // exactly analogous to the bot_token clause below, and gated by the
  // SAME `shouldEmitGdriveMcp` predicate the scaffold uses to decide
  // whether to emit the entry at all, so broker and scaffold can never
  // disagree. See config/google-workspace-acl.ts.
  if (isGoogleClientCredentialKeyForAgent(config, agentName, key)) {
    return { allow: true };
  }

  // An agent legitimately needs to read its OWN configured bot token.
  // The gateway resolves `agents.<name>.bot_token` (per-agent override,
  // wins) or the global `telegram.bot_token` — see
  // materialize-bot-token.ts:getEffectiveBotToken. That is
  // identity-bound access to the single key the config assigns to THIS
  // agent (path-as-identity already proved who the caller is) — NOT
  // cross-agent secret access — so it must not be gated behind
  // schedule[].secrets[] (which is cron-misconfiguration protection,
  // not the auth boundary). Without this, a per-agent bot token added
  // via the documented `switchroom vault set telegram-<agent>-bot-token`
  // + uncomment flow is broker-ACL-denied to its own agent
  // (install-validation 2026-05-18; #31/#1428-adjacent). The global
  // token historically only "worked" via the <agent>/telegram/.env
  // materialization side-channel, which never fires for a hand-added
  // per-agent agent.
  // Exactly mirror materialize-bot-token.ts:getEffectiveBotToken —
  // the per-agent override is preferred only when it's a NON-EMPTY
  // string (an empty-string `bot_token` falls back to the global,
  // same as the gateway does), so the ACL can never deny the very
  // key the gateway will actually try to use.
  const agentBot = (agentConfig as { bot_token?: string }).bot_token;
  const botRef =
    agentBot && agentBot.length > 0 ? agentBot : config.telegram?.bot_token;
  if (typeof botRef === "string" && botRef.startsWith("vault:")) {
    const botKey = botRef.slice("vault:".length).split("#")[0];
    if (botKey.length > 0 && botKey === key) {
      return { allow: true };
    }
  }

  const schedule = agentConfig.schedule ?? [];
  if (schedule.length === 0) {
    return {
      allow: false,
      reason: `agent '${agentName}' has no schedule entries declaring 'secrets'; nothing is broker-accessible`,
    };
  }

  for (const entry of schedule) {
    const allowed: string[] = entry?.secrets ?? [];
    if (allowed.includes(key)) {
      return { allow: true };
    }
  }

  return {
    allow: false,
    reason: `key '${key}' not in ACL for agent '${agentName}'`,
  };
}

/**
 * Parse a `google:<account>:<field>` slot key into its account + field
 * components. Returns null if the key doesn't match the shape.
 *
 * Pattern: literal `google:`, then account email (`[^:]+`), then literal
 * `:`, then field name (`[a-z_]+`). The account-email regex is lenient
 * here — strict validation lives at the schema layer where operators see
 * the error. Broker just needs to extract the account.
 */
export function parseGoogleAccountSlotKey(
  key: string,
): { account: string; field: string } | null {
  const match = key.match(/^google:([^:]+):([a-z_]+)$/);
  if (!match) return null;
  return { account: match[1], field: match[2] };
}

/**
 * RFC G §4.4 — check whether an agent is in `google_accounts.<account>.
 * enabled_for[]`. Fail-closed:
 *   - account not in google_accounts → deny.
 *   - enabled_for missing or empty → deny.
 *   - agent not in enabled_for → deny.
 *   - otherwise → allow.
 *
 * Pattern matches `share-auth-across-the-fleet.md`'s account-with-ACL
 * model — the account is the unit of trust, the agent is the consumer.
 */
function checkGoogleAccountAcl(
  config: SwitchroomConfig,
  agentName: string,
  account: string,
  key: string,
): AclResult {
  const accounts = config.google_accounts ?? {};
  // Match against normalized (lowercase) account email — schema accepts
  // any case but vault slots are written under the normalized form.
  const accountKey = account.toLowerCase();
  const accountEntry = accounts[accountKey] ?? accounts[account];
  if (!accountEntry) {
    return {
      allow: false,
      reason: `google_accounts['${account}'] not configured (key '${key}')`,
    };
  }
  const enabled = accountEntry.enabled_for ?? [];
  if (enabled.length === 0) {
    return {
      allow: false,
      reason: `google_accounts['${account}'].enabled_for is empty (key '${key}')`,
    };
  }
  if (!enabled.includes(agentName)) {
    return {
      allow: false,
      reason: `agent '${agentName}' not in google_accounts['${account}'].enabled_for (key '${key}')`,
    };
  }
  return { allow: true };
}
