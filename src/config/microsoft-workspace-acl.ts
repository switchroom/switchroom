/**
 * Microsoft Workspace ACL predicates — RFC #1873 PR 3.
 *
 * Mirrors `google-workspace-acl.ts` byte-for-byte (s/google/microsoft/,
 * s/gdrive/ms-365/). Same dependency-free contract: pure, types-only
 * import, shared by scaffold (decides whether to emit the `ms-365` MCP
 * entry) and broker ACL (decides whether to serve the OAuth client
 * credential to that agent).
 */

import type { SwitchroomConfig } from "./schema.js";

/**
 * Shared gate: should agent `<agentName>` receive the `ms-365` MCP
 * entry (and equivalently be served the Microsoft OAuth client
 * credential by the vault-broker)?
 *
 * MUST agree with the auth-broker's account-selection + ACL logic
 * (`server.ts:opMicrosoftGetCredentials`): broker returns a Microsoft
 * account iff `agents.<name>.microsoft_workspace.account` is set AND
 * that account is in `microsoft_accounts.<account>.enabled_for[]`
 * with `<name>` listed. Scaffold + broker call this one predicate so
 * they can never disagree.
 *
 * Hard opt-out (`mcp_servers: { ms-365: false }`) handled by the
 * caller, not here.
 */
export function shouldEmitMs365Mcp(
  agentName: string,
  agentMicrosoftAccount: string | undefined,
  microsoftAccounts:
    | Record<string, { enabled_for?: string[] } | undefined>
    | undefined,
): boolean {
  if (!agentMicrosoftAccount) return false;
  const account = agentMicrosoftAccount.trim().toLowerCase();
  if (account.length === 0) return false;
  const acctEntry = microsoftAccounts?.[account];
  if (!acctEntry) return false;
  const enabledFor = acctEntry.enabled_for ?? [];
  return enabledFor.includes(agentName);
}

/**
 * Extract the bare vault key from a config value that may be a `vault:`
 * ref. Returns null when not a vault ref. Strips any `#`-scope suffix.
 */
export function vaultRefKey(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("vault:")) return null;
  const key = value.slice("vault:".length).split("#")[0];
  return key.length > 0 ? key : null;
}

/**
 * Broker ACL predicate: may `<agentName>` read vault `<key>` because it
 * is the Microsoft OAuth client credential bound to this agent's
 * `ms-365` MCP?
 *
 * Mirrors `isGoogleClientCredentialKeyForAgent` exactly. Gated by
 * `shouldEmitMs365Mcp` so the grant is coextensive with the set of
 * agents that get the MCP.
 *
 * `microsoft_client_secret` is OPTIONAL for public-client apps — when
 * absent, this predicate returns false for the secret key but the
 * launcher still works (uses public-client + PKCE flow).
 */
export function isMicrosoftClientCredentialKeyForAgent(
  config: SwitchroomConfig,
  agentName: string,
  key: string,
): boolean {
  if (!agentName || !key) return false;

  const agentConfig = config.agents?.[agentName];
  if (!agentConfig) return false;

  if (
    (agentConfig.mcp_servers as Record<string, unknown> | undefined)?.[
      "ms-365"
    ] === false
  ) {
    return false;
  }

  const account = agentConfig.microsoft_workspace?.account;
  if (!shouldEmitMs365Mcp(agentName, account, config.microsoft_accounts)) {
    return false;
  }

  const mw = config.microsoft_workspace;
  if (!mw) return false;
  for (const ref of [mw.microsoft_client_id, mw.microsoft_client_secret]) {
    if (vaultRefKey(ref) === key) return true;
  }
  return false;
}
