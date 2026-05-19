/**
 * Google Workspace / Drive ACL predicates — pure, zero-dependency.
 *
 * This module is imported by BOTH the agent scaffold
 * (`src/agents/scaffold.ts` via `src/memory/scaffold-integration.ts`'s
 * neighbours) AND the vault-broker ACL (`src/vault/broker/acl.ts`). The
 * broker's `acl.ts` is deliberately pure (it only imports types) so its
 * ACL logic can be unit-tested without standing up a broker; that is why
 * these predicates live here and not in `scaffold-integration.ts` (which
 * pulls in the hindsight memory layer). Keep this file dependency-free —
 * type-only imports from the config schema, nothing else.
 *
 * The whole point of co-locating the gate predicate is that the scaffold
 * (which decides whether to *emit* the `gdrive` MCP entry) and the broker
 * (which decides whether to *serve* the OAuth client secret to that same
 * agent) call the SAME function, so they can never disagree and leave an
 * agent with a `gdrive` MCP whose launcher is broker-denied at spawn.
 */

import type { SwitchroomConfig } from "./schema.js";

/**
 * The shared gate predicate: should agent `<agentName>` receive the
 * `gdrive` MCP entry (and, equivalently, be served the Google OAuth
 * client credential by the vault-broker)?
 *
 * This MUST agree with the auth-broker's account-selection + ACL logic
 * (`src/auth/broker/server.ts` opGoogleGetCredentials): the broker
 * returns a Google account iff `agents.<name>.google_workspace.account`
 * is set AND that account is a key in top-level `google_accounts` with
 * `<name>` in its `enabled_for[]`. If the scaffold emitted the entry
 * under looser conditions, the agent would get a `gdrive` MCP whose
 * launcher fails at spawn (broker returns FORBIDDEN/ACCOUNT_NOT_FOUND) —
 * a broken tool surface. So both sides call this one predicate.
 *
 * Hard opt-out (`mcp_servers: { gdrive: false }`) is handled by the
 * caller (same shape as every other built-in default), NOT here — this
 * predicate answers only "is this agent broker-authorized for Google".
 *
 * Account-name comparison is case-insensitive + trimmed because the
 * config schema normalizes both the per-agent `google_workspace.account`
 * and the `google_accounts` keys to lowercase; the broker compares the
 * post-normalization strings. We re-normalize here defensively so a
 * test or caller that hand-builds an un-normalized config still gets
 * the same answer the broker would.
 */
export function shouldEmitGdriveMcp(
  agentName: string,
  agentGoogleAccount: string | undefined,
  googleAccounts:
    | Record<string, { enabled_for?: string[] } | undefined>
    | undefined,
): boolean {
  if (!agentGoogleAccount) return false;
  const account = agentGoogleAccount.trim().toLowerCase();
  if (account.length === 0) return false;
  const acctEntry = googleAccounts?.[account];
  if (!acctEntry) return false;
  const enabledFor = acctEntry.enabled_for ?? [];
  return enabledFor.includes(agentName);
}

/**
 * Extract the bare vault key from a config value that may be a `vault:`
 * reference. Returns null when the value is absent, not a string, or not
 * a `vault:` ref (i.e. a literal secret — no broker access is needed for
 * a literal, the launcher reads it straight from config).
 *
 * Mirrors the bot_token clause in `acl.ts:checkAclByAgent` exactly,
 * including the `#`-scope strip, so the key the broker authorizes can
 * never diverge from the key the launcher actually requests.
 */
export function vaultRefKey(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("vault:")) return null;
  const key = value.slice("vault:".length).split("#")[0];
  return key.length > 0 ? key : null;
}

/**
 * Broker ACL predicate: may `<agentName>` read vault `<key>` because it
 * is the Google OAuth client credential (`google_client_id` /
 * `google_client_secret`) that the config assigns to this agent's Drive
 * integration?
 *
 * This is identity-bound access to the single credential the config
 * binds to THIS agent's `gdrive` MCP — NOT cross-agent secret access —
 * exactly analogous to the per-agent bot_token clause in `acl.ts`. It
 * deliberately bypasses the per-cron `schedule[].secrets[]` allowlist
 * (which is cron-misconfiguration protection, not the auth boundary):
 *
 *   - RFC G §4.4 already gates the Google *account* slots
 *     (`google:<account>:*`) by `google_accounts.<account>.enabled_for[]`
 *     rather than schedule.secrets. The OAuth *client secret* is the one
 *     remaining piece of the same Drive auth flow that was left out of
 *     that model — without this, the `gdrive` MCP is dead on arrival on
 *     every install that stores the client secret as a `vault:` ref
 *     (the documented `switchroom auth google connect` shape), because
 *     the launcher is broker-denied the secret before it can spawn.
 *   - The grant is gated by `shouldEmitGdriveMcp` — the SAME predicate
 *     the scaffold uses to decide whether to emit the entry at all — so
 *     only agents that actually receive the `gdrive` MCP can read the
 *     credential, and the two can never disagree.
 *
 * Honours the `mcp_servers: { gdrive: false }` hard opt-out so the grant
 * stays exactly coextensive with the set of agents that get the MCP.
 *
 * Client id/secret are top-level-only per the config schema
 * (`google_client_id/secret are not per-agent`), so we read them off
 * `config.google_workspace`. The Drive-enabled gate uses the per-agent
 * `google_workspace.account` + top-level `google_accounts`, mirroring
 * `scaffold.ts:resolveGdriveMcpEntry`.
 */
export function isGoogleClientCredentialKeyForAgent(
  config: SwitchroomConfig,
  agentName: string,
  key: string,
): boolean {
  if (!agentName || !key) return false;

  const agentConfig = config.agents?.[agentName];
  if (!agentConfig) return false;

  // Hard opt-out: an agent with the gdrive MCP suppressed never spawns
  // the launcher, so it must not be granted the credential either.
  if (
    (agentConfig.mcp_servers as Record<string, unknown> | undefined)?.[
      "gdrive"
    ] === false
  ) {
    return false;
  }

  const account = agentConfig.google_workspace?.account;
  if (!shouldEmitGdriveMcp(agentName, account, config.google_accounts)) {
    return false;
  }

  const gw = config.google_workspace;
  if (!gw) return false;
  for (const ref of [gw.google_client_id, gw.google_client_secret]) {
    if (vaultRefKey(ref) === key) return true;
  }
  return false;
}
