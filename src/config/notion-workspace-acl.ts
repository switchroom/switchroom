/**
 * Notion Workspace ACL predicates + load-time cross-validation —
 * RFC docs/rfcs/notion-integration.md.
 *
 * Mirrors `microsoft-workspace-acl.ts` shape where the model fits, with
 * two material differences:
 *
 *   1. **No per-account concept.** Notion has one integration token =
 *      one workspace per switchroom install. There is no
 *      `notion_accounts:` analog; the broker ACL on the vault key (set
 *      via `vault set --allow <agents>`) is the authoritative list of
 *      which agents may receive the token.
 *   2. **Per-DB allowlist.** The per-agent `databases:` field narrows
 *      which databases this agent may read/write within the
 *      integration's upstream-shared set. Enforced at the PreToolUse
 *      hook (PR 3) using `agentCanAccessNotionDB`.
 *
 * Pure module — no I/O, no side effects. Safe to import from anywhere.
 */

import type { SwitchroomConfig } from "./schema.js";

/**
 * Should agent `<agentName>` receive the Notion MCP entry in its
 * scaffolded `.mcp.json`?
 *
 * Two conditions: (1) the top-level `notion_workspace:` block exists,
 * (2) the agent has a `notion_workspace:` block (presence = opt-in;
 * absence = no Notion).
 *
 * Does NOT check broker ACL — that's a runtime broker concern, not
 * scaffold-time. The launcher fetching the token at runtime will get
 * a clean `E_BROKER_GRANT_DENIED` if the operator forgot to grant
 * access via `vault set --allow <agents>`. The doctor probe
 * `notion:vault-acl-aligned` (PR 4) surfaces the mismatch at config
 * time.
 *
 * Hard opt-out (`mcp_servers: { notion: false }`) handled by the
 * caller, not here.
 */
export function shouldEmitNotionMcp(
  agentName: string,
  config: SwitchroomConfig,
): boolean {
  if (!agentName) return false;
  if (!config.notion_workspace) return false;
  const agentConfig = config.agents?.[agentName];
  if (!agentConfig) return false;
  if (agentConfig.notion_workspace === undefined) return false;
  return true;
}

/**
 * Broker ACL predicate: would `<agentName>` be served the Notion
 * integration token vault key?
 *
 * Mirrors `isMicrosoftClientCredentialKeyForAgent` shape. Gated on
 * `shouldEmitNotionMcp` so the grant is coextensive with the set of
 * agents that get the MCP — the two predicates can never disagree.
 *
 * The vault key compared is the bare key string (no `vault:` prefix).
 * The default is `notion/integration-token`; the operator can override
 * via `notion_workspace.vault_key`.
 */
export function isNotionIntegrationTokenKeyForAgent(
  config: SwitchroomConfig,
  agentName: string,
  key: string,
): boolean {
  if (!agentName || !key) return false;
  if (!shouldEmitNotionMcp(agentName, config)) return false;

  const agentConfig = config.agents?.[agentName];
  if (
    (agentConfig?.mcp_servers as Record<string, unknown> | undefined)?.[
      "notion"
    ] === false
  ) {
    return false;
  }

  const configuredKey =
    config.notion_workspace?.vault_key ?? "notion/integration-token";
  return key === configuredKey;
}

/**
 * Normalize a Notion UUID to its undashed (32-hex) canonical form for
 * comparison. Notion accepts both dashed and undashed forms on
 * requests, but compares them after normalizing — so a tool call with
 * `parent.database_id: "a1b2c3d4e5f67890..."` and a config entry
 * `essays: "a1b2c3d4-e5f6-7890-..."` must compare equal.
 *
 * Returns null if the input isn't a syntactically valid UUID.
 */
export function normalizeNotionUuid(uuid: string | undefined | null): string | null {
  if (typeof uuid !== "string") return null;
  const stripped = uuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(stripped)) return null;
  return stripped;
}

/**
 * PreToolUse hook predicate (PR 3): may agent `<agentName>` access
 * the Notion database identified by `<dbUuid>`?
 *
 * Decision tree:
 *   - Agent has no `notion_workspace:` block → DENY.
 *   - Agent has `notion_workspace: {}` (no `databases:` filter) → ALLOW
 *     anything the upstream integration can see.
 *   - Agent has `notion_workspace.databases: [...]` → ALLOW only if
 *     `<dbUuid>` matches a resolved UUID in that list.
 *
 * UUIDs are compared after normalizing dashes (Notion's response
 * format is dashed; operators often paste un-dashed).
 */
export function agentCanAccessNotionDB(
  config: SwitchroomConfig,
  agentName: string,
  dbUuid: string,
): boolean {
  if (!shouldEmitNotionMcp(agentName, config)) return false;

  const targetNorm = normalizeNotionUuid(dbUuid);
  if (targetNorm === null) return false;

  const agentConfig = config.agents?.[agentName];
  const allowedNames = agentConfig?.notion_workspace?.databases;
  if (allowedNames === undefined || allowedNames.length === 0) {
    // No databases filter = full access (within upstream-shared set).
    // The `length === 0` branch is defensive — schema rejects empty
    // lists at load time, but defending against a partially-validated
    // SwitchroomConfig shape is cheap.
    return true;
  }

  const dbMap = config.notion_workspace?.databases ?? {};
  for (const name of allowedNames) {
    const uuid = dbMap[name];
    if (!uuid) continue;
    if (normalizeNotionUuid(uuid) === targetNorm) return true;
  }
  return false;
}

/**
 * Reverse lookup: given a UUID, return its operator-assigned friendly
 * name if present in the top-level DB map. Used by the approval card
 * UI (PR 3) to surface "tasks" instead of a UUID in the operator-
 * facing approval message.
 *
 * Returns null when the UUID doesn't appear in the map — the caller
 * should fall back to displaying the bare UUID.
 */
export function resolveDbNameFromUuid(
  config: SwitchroomConfig,
  dbUuid: string,
): string | null {
  const targetNorm = normalizeNotionUuid(dbUuid);
  if (targetNorm === null) return null;

  const dbMap = config.notion_workspace?.databases ?? {};
  for (const [name, uuid] of Object.entries(dbMap)) {
    if (normalizeNotionUuid(uuid) === targetNorm) return name;
  }
  return null;
}

/**
 * Load-time cross-validation — called from `loader.ts` after the zod
 * schema accepts the YAML. Catches typos the schema can't (it doesn't
 * see across keys).
 *
 * Currently catches one class of error:
 *   - Per-agent `notion_workspace.databases: [<name>]` references a
 *     friendly name not present in top-level
 *     `notion_workspace.databases`.
 *
 * Returns the list of error strings (formatted ready for ConfigError
 * inclusion). Empty array = config is valid.
 *
 * Runtime-state checks (vault key present, broker ACL alignment) are
 * deliberately deferred to the doctor probes (PR 4) — they need
 * broker-daemon state, not just YAML.
 */
export function validateNotionWorkspaceConfig(
  config: SwitchroomConfig,
): string[] {
  const issues: string[] = [];
  const dbMap = config.notion_workspace?.databases ?? {};
  const known = new Set(Object.keys(dbMap));

  for (const [agentName, agentRaw] of Object.entries(config.agents ?? {})) {
    if (!agentRaw) continue;
    const dbFilter = agentRaw.notion_workspace?.databases;
    if (dbFilter === undefined) continue;

    // Schema already rejects empty lists, but we defend against a
    // partially-validated shape (e.g. cascade-resolved configs in
    // tests). An empty list reaching here is a programming error,
    // not a YAML one.
    if (dbFilter.length === 0) {
      issues.push(
        `  agents.${agentName}.notion_workspace.databases is an empty ` +
        `list. Delete the entire notion_workspace block to remove Notion ` +
        `access, or list at least one database friendly name.`,
      );
      continue;
    }

    if (config.notion_workspace === undefined) {
      issues.push(
        `  agents.${agentName}.notion_workspace is set but the top-level ` +
        `notion_workspace block is missing. Configure the integration ` +
        `globally first (vault_key + databases map), then grant per-agent ` +
        `access.`,
      );
      continue;
    }

    for (const name of dbFilter) {
      if (!known.has(name)) {
        issues.push(
          `  agents.${agentName}.notion_workspace.databases references ` +
          `unknown database "${name}". Add it to top-level ` +
          `notion_workspace.databases (run \`switchroom notion list-dbs\` ` +
          `to see the UUIDs the integration can read), or remove the ` +
          `reference.`,
        );
      }
    }
  }

  return issues;
}
