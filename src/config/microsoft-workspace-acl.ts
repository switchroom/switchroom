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
 * The normalized shape of ONE Microsoft account binding, produced by
 * `normalizeMicrosoftBindings`. Both the singular `account` form and the
 * plural `accounts[]` form collapse to a list of these so every consumer
 * (broker, scaffold, launcher, ACL) has a single representation and the
 * two config forms can never drift.
 */
export interface MicrosoftBinding {
  account: string;
  tools?: string[];
  org_mode?: boolean;
}

/** The raw `microsoft_workspace` block, singular OR plural form. */
export interface MicrosoftWorkspaceLike {
  account?: string;
  tools?: string[];
  org_mode?: boolean;
  accounts?: Array<{ account: string; tools?: string[]; org_mode?: boolean }>;
}

/**
 * Collapse a `microsoft_workspace` block (singular `account` OR plural
 * `accounts[]`) into a single list of bindings. The singular form maps to
 * a one-element list `[{ account, tools?, org_mode? }]` so downstream code
 * has exactly one code path. Returns `[]` when the block is absent or
 * binds no account.
 *
 * This is THE shared normalizer — every consumer calls it so the singular
 * and plural forms can never drift.
 */
export function normalizeMicrosoftBindings(
  mw: MicrosoftWorkspaceLike | undefined,
): MicrosoftBinding[] {
  if (!mw) return [];
  if (mw.accounts !== undefined) {
    return mw.accounts
      .filter((b) => b && typeof b.account === "string" && b.account.length > 0)
      .map((b) => ({
        account: b.account.trim().toLowerCase(),
        tools: b.tools,
        org_mode: b.org_mode,
      }));
  }
  if (typeof mw.account === "string" && mw.account.length > 0) {
    return [
      {
        account: mw.account.trim().toLowerCase(),
        tools: mw.tools,
        org_mode: mw.org_mode,
      },
    ];
  }
  return [];
}

/**
 * Whether an agent's `microsoft_workspace` binds more than one account
 * (i.e. uses the plural multi-account form with 2+ accounts). Single or
 * zero bindings keep the back-compat bare `ms-365` MCP key.
 */
export function isMultiAccount(mw: MicrosoftWorkspaceLike | undefined): boolean {
  return normalizeMicrosoftBindings(mw).length > 1;
}

/**
 * Deterministic short, filesystem/MCP-key-safe slug for a Microsoft
 * account email. `<local-part sanitized to [a-z0-9-]>-<4-hex hash>` where
 * the hash is a stable digest of the FULL lowercased email — so two
 * different emails that sanitize to the same local part (e.g.
 * `lisa@a.com` vs `lisa@b.com`) never collide.
 *
 * Pure (no crypto import) so this file stays dependency-free and shared
 * by scaffold, launcher, heartbeat, and the pretool doctor.
 */
export function microsoftAccountSlug(account: string): string {
  const email = account.trim().toLowerCase();
  const local = email.split("@")[0] ?? email;
  let base = local.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (base.length === 0) base = "acct";
  if (base.length > 24) base = base.slice(0, 24).replace(/-+$/g, "");
  // FNV-1a 32-bit over the full email for a stable collision-resistant tail.
  let h = 0x811c9dc5;
  for (let i = 0; i < email.length; i++) {
    h ^= email.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
  return `${base}-${hex}`;
}

/**
 * The MCP server key for a binding on an agent. Single-account agents keep
 * the bare `ms-365` key (back-compat — tools stay `mcp__ms-365__*`).
 * Multi-account agents get `ms-365-<slug>` per binding.
 */
export function ms365McpKeyForBinding(
  mw: MicrosoftWorkspaceLike | undefined,
  account: string,
): string {
  if (isMultiAccount(mw)) return `ms-365-${microsoftAccountSlug(account)}`;
  return "ms-365";
}

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
 * Plural sibling of `shouldEmitMs365Mcp`: the subset of an agent's
 * Microsoft account bindings that pass the twin-key gate (account listed
 * in `microsoft_accounts.<account>.enabled_for[]` with this agent). The
 * scaffold emits exactly one MCP entry per returned binding — a binding
 * whose ACL is missing produces no entry (same "emit iff enabled"
 * semantics as the singular path, applied per account).
 */
export function bindingsForAgent(
  agentName: string,
  mw: MicrosoftWorkspaceLike | undefined,
  microsoftAccounts:
    | Record<string, { enabled_for?: string[] } | undefined>
    | undefined,
): MicrosoftBinding[] {
  return normalizeMicrosoftBindings(mw).filter((b) =>
    shouldEmitMs365Mcp(agentName, b.account, microsoftAccounts),
  );
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

  // Grant the client credential iff AT LEAST ONE of the agent's bindings
  // passes the twin-key gate (singular or plural form via the shared
  // normalizer). The credential is the same top-level app-reg for every
  // account, so one passing binding is sufficient.
  if (
    bindingsForAgent(agentName, agentConfig.microsoft_workspace, config.microsoft_accounts)
      .length === 0
  ) {
    return false;
  }

  const mw = config.microsoft_workspace;
  if (!mw) return false;
  for (const ref of [mw.microsoft_client_id, mw.microsoft_client_secret]) {
    if (vaultRefKey(ref) === key) return true;
  }
  return false;
}
