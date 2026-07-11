/**
 * vault-broker ACL — per-AGENT access control for vault key requests.
 *
 * ## Identity is the socket path, not a cgroup
 *
 * Since the Phase 2a Docker migration each agent connects to its OWN
 * per-agent Unix socket (`/run/switchroom/broker/<agent>/sock`, mounted
 * from a per-agent named volume — see `src/agents/compose.ts`). The
 * broker binds that socket and derives the calling agent's identity from
 * the *bind path* (`peercred.socketPathToAgent`), never from a wire
 * payload or a cgroup. Every real request therefore arrives with a
 * resolved agent name and is gated by `checkAclByAgent` below.
 *
 * ## ACL granularity is per-AGENT (per-cron-index gating removed)
 *
 * The ACL grants a key when it appears in the UNION of that agent's
 * `schedule[*].secrets[]` (plus the config-derived exceptions documented
 * on `checkAclByAgent`: google account slots, the OAuth client credential,
 * the agent's own bot_token, user-declared `mcp_servers.*.secrets[]`, and
 * the `agents.<name>.secrets[]` standing grant).
 *
 * There is deliberately NO per-cron-index gating. The pre-Phase-2a design
 * keyed the ACL on a systemd cron cgroup (`switchroom-<agent>-cron-<i>.
 * service`) so cron-A could be denied cron-B's key. That is gone: the
 * in-container scheduler injects cron turns via `inject_inbound` IPC into
 * the agent's single running session — it produces no per-cron systemd
 * cgroup, and the synthesized `meta.source="cron"` tag never reaches the
 * broker (it only sees the agent's socket). All of an agent's crons run in
 * one container/session, so per-cron-index isolation could only ever be
 * self-attested — restoring it would be security theatre. See issue #1192
 * (Option 1: drop the dead code and document honestly).
 *
 * ## Threat model
 *
 * The per-agent `secrets[]` union is MISCONFIGURATION PROTECTION (it keeps
 * an agent from reading keys the operator never granted it), NOT a security
 * boundary. Anyone who can edit an agent's cron scripts can also edit the
 * config to grant any key. If two of an agent's crons need genuinely
 * isolated secrets, split them into separate agents. See
 * `docs/architecture.md` for the full framing.
 *
 * Fail-closed everywhere: an unidentified caller (no resolved agent name)
 * is denied; a missing agent, missing schedule, or unlisted key is denied.
 */

import type { SwitchroomConfig } from "../../config/schema.js";
import type { VaultEntryScope } from "../vault.js";
import { isGoogleClientCredentialKeyForAgent } from "../../config/google-workspace-acl.js";

/**
 * Canonical vault keys webkite reads when running as an in-agent MCP.
 * Mirrors `WEBKITE_VAULT_KEYS` in profiles/_base/start.sh.hbs (the
 * shell loop that fetches them at agent boot and exports as env
 * vars). Kept in sync by the test pins at `src/vault/broker/acl.test.ts`
 * (canonical-3 allow + opt-out deny + non-canonical deny cases) and
 * `tests/scaffold.integration-registry.test.ts` (resolver shape).
 */
const WEBKITE_VAULT_KEYS = new Set<string>([
  "webkite/cloudflare-account-id",
  "webkite/cloudflare-api-token",
  "webkite/firecrawl-api-key",
]);

/**
 * Webkite is fleet-default — every agent reads these keys unless the
 * agent explicitly opted out via `mcp_servers.webkite: false`. Same
 * "framework-emits-entry-AND-ACL" shape as the gdrive client-secret
 * special case (see acl.ts: isGoogleClientCredentialKeyForAgent).
 */
function isWebkiteCredentialKeyForAgent(
  agentConfig: { mcp_servers?: Record<string, unknown> } | undefined,
  key: string,
): boolean {
  if (!WEBKITE_VAULT_KEYS.has(key)) return false;
  if ((agentConfig?.mcp_servers ?? {})["webkite"] === false) return false;
  return true;
}

export interface AclAllow {
  allow: true;
}

export interface AclDeny {
  allow: false;
  reason: string;
}

export type AclResult = AclAllow | AclDeny;

/**
 * Evaluate a VaultEntry's per-entry scope against the calling agent slug.
 *
 * Called AFTER the agent-level ACL (`checkAclByAgent`) passes. Both checks
 * must pass before a secret is returned.
 *
 * Rules (fail-closed):
 *   - scope undefined/null                → allowed (back-compat, all callers)
 *   - agentSlug in scope.deny            → denied:scope-deny
 *   - scope.allow is non-empty AND
 *     agentSlug NOT in scope.allow       → denied:scope-allow
 *   - otherwise                          → allowed
 *
 * agentSlug may be null when the caller's agent identity could not be
 * resolved from the socket path (e.g. a legacy/operator connection). In
 * that edge case we treat the entry as scope-restricted and deny if any
 * allow list is present — fail-closed.
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
 * Agent-name-keyed ACL for the socket-path-as-identity model (Phase 2a).
 *
 * This is the ONLY ACL evaluator the broker consults for real requests.
 * The agent slug is derived from the listener's bind-time socket path
 * (`peercred.socketPathToAgent`) — no peercred, no cgroup inspection, no
 * wire-payload field can override it. There is no per-cron-index variant:
 * the in-container scheduler runs every cron in the agent's single session,
 * so the ACL granularity is per-AGENT (see the module header + issue #1192).
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
 *       · user-declared MCP-server secrets — any key listed under
 *         `mcp_servers.<name>.secrets[]` in the effective (post-cascade)
 *         config for this agent. Generalises the gdrive special-case
 *         above so operator-declared MCPs (perplexity, notion, etc.)
 *         can fetch their API keys at launcher spawn time without
 *         per-agent `vault grant` ceremony.
 *   - If the agent has no `schedule` array (or empty) AND no MCP-secret
 *     match above → deny: nothing is broker-accessible.
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

  // Webkite credentials — `webkite/cloudflare-account-id`,
  // `webkite/cloudflare-api-token`, `webkite/firecrawl-api-key`.
  //
  // Webkite is a fleet-default MCP scaffolded by
  // `resolveWebkiteMcpEntry` (src/agents/scaffold.ts) — every agent
  // gets it unless it opts out via `mcp_servers.webkite: false`. Same
  // shape as the gdrive client-secret special-case above: the
  // framework EMITS the entry, so the framework must EMIT the broker
  // ACL too (operator yaml never sees the webkite entry, so the
  // `effectiveMcp` cascade path below can't find it).
  //
  // Gated on per-agent opt-out so an explicitly-disabled webkite
  // agent can't read these keys. The keys themselves are operator-
  // populated by `switchroom vault set webkite/*` — when absent, the
  // broker returns UNKNOWN_KEY and webkite gracefully falls back to
  // cloakbrowser-only (which is fine for non-bot-gated sites).
  if (isWebkiteCredentialKeyForAgent(agentConfig, key)) {
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

  // User-declared MCP-server secrets (#1790 follow-up — generalises
  // the gdrive `google/client-secret` special-case above). Operators
  // declare an MCP server's vault dependencies inline:
  //
  //   defaults:
  //     mcp_servers:
  //       perplexity:
  //         command: /path/to/perplexity-mcp.sh
  //         secrets: [ perplexity/api-key ]
  //
  // The check consults the EFFECTIVE (post-cascade) mcp_servers map —
  // per-key shallow merge of defaults + extends-profile + per-agent
  // overrides, mirroring `src/config/merge.ts:resolveAgentConfig` (the
  // 3-layer pipeline at lines 168-211) and the field-level merge at
  // lines 391-397. The broker loads raw yaml without running the full
  // cascade pipeline (it pulls in env merges, deprecation-warn side
  // effects, and is too expensive per ACL request), so the
  // mcp_servers-only cascade is open-coded here.
  //
  // Layer order matches the canonical cascade:
  //   1. defaults.mcp_servers
  //   2. profiles.<agent.extends>.mcp_servers   (if extends is set)
  //   3. agents.<name>.mcp_servers
  //
  // Per-key shallow merge — a later layer's entry FULLY REPLACES an
  // earlier layer's entry at that key. `false` opt-outs survive the
  // merge as the literal value and are then skipped by the typeof
  // guard below.
  //
  // History:
  //   #1806 (v0.13.42) shipped per-agent-only read — defaults invisible.
  //   #1810 (this fix) added the defaults + profile cascade.
  //
  // Checked BEFORE the no-schedule early-deny below so an MCP-only
  // agent (no cron schedule) can still serve user-declared MCPs.
  const cfgWithProfiles = config as {
    defaults?: { mcp_servers?: Record<string, unknown> };
    profiles?: Record<string, { mcp_servers?: Record<string, unknown> }>;
  };
  const profileName = (agentConfig as { extends?: string }).extends;
  const profileMcp =
    profileName != null && profileName.length > 0
      ? (cfgWithProfiles.profiles?.[profileName]?.mcp_servers ?? {})
      : {};
  const effectiveMcp: Record<string, unknown> = {
    ...(cfgWithProfiles.defaults?.mcp_servers ?? {}),
    ...profileMcp,
    ...((agentConfig as { mcp_servers?: Record<string, unknown> })
      .mcp_servers ?? {}),
  };
  for (const mcpEntry of Object.values(effectiveMcp)) {
    if (!mcpEntry || typeof mcpEntry !== "object") continue;
    const declared = (mcpEntry as { secrets?: unknown }).secrets;
    if (Array.isArray(declared) && declared.includes(key)) {
      return { allow: true };
    }
  }

  // Operator-set STANDING grant — agents.<name>.secrets[] (cascaded
  // defaults -> profile -> agent, UNION). The clean home for "what this
  // agent may access", decoupled from a specific cron's schedule[].secrets[]
  // (which welds access to one schedule entry) and from MCP-server secrets.
  // Operator-controlled: agents cannot edit switchroom.yaml or self-grant
  // (reference/vision.md outcome 2 — "you hold the leash; only your tap
  // grants it"). Read directly from raw yaml here, same as the mcp_servers
  // cascade above, because the broker doesn't run the full merge pipeline
  // per request.
  const cfgSecrets = config as {
    defaults?: { secrets?: unknown };
    profiles?: Record<string, { secrets?: unknown }>;
  };
  const profileSecrets =
    profileName != null && profileName.length > 0
      ? cfgSecrets.profiles?.[profileName]?.secrets
      : undefined;
  const standingSecrets: string[] = [
    ...(Array.isArray(cfgSecrets.defaults?.secrets)
      ? (cfgSecrets.defaults!.secrets as string[])
      : []),
    ...(Array.isArray(profileSecrets) ? (profileSecrets as string[]) : []),
    ...(Array.isArray((agentConfig as { secrets?: unknown }).secrets)
      ? ((agentConfig as { secrets?: string[] }).secrets as string[])
      : []),
  ];
  if (standingSecrets.includes(key)) {
    return { allow: true };
  }

  const schedule = agentConfig.schedule ?? [];
  if (schedule.length === 0) {
    return {
      allow: false,
      reason: `agent '${agentName}' has no schedule entries declaring 'secrets', no mcp_servers.*.secrets[], and no agents.${agentName}.secrets[] standing grant declaring '${key}'; nothing is broker-accessible`,
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
