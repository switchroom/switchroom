import type { SwitchroomConfig } from "../config/schema.js";
import {
  generateHindsightMcpConfig,
  getCollectionForAgent,
  type McpServerConfig,
} from "./hindsight.js";

/**
 * Return the MCP server entry for Hindsight to merge into an agent's
 * settings.json during scaffolding.
 *
 * Returns null if the memory backend is not hindsight.
 */
export function getHindsightSettingsEntry(
  agentName: string,
  config: SwitchroomConfig,
): { key: string; value: McpServerConfig } | null {
  const memoryConfig = config.memory;
  if (!memoryConfig || memoryConfig.backend !== "hindsight") {
    return null;
  }

  const collection = getCollectionForAgent(agentName, config);
  const mcpConfig = generateHindsightMcpConfig(collection, memoryConfig);

  return { key: "hindsight", value: mcpConfig };
}

/**
 * Return the MCP server entry for the Playwright browser automation server.
 *
 * The @playwright/mcp server is Microsoft's official browser automation MCP,
 * launched on demand via npx. It exposes browser_navigate, browser_snapshot
 * (accessibility-tree mode — token-cheap), browser_click, browser_type, and
 * related tools. Included as a built-in default so agents and skills can drive
 * web UIs without installing Playwright locally.
 *
 * Agents that don't need browser access can opt out by setting
 * `mcp_servers: { playwright: false }` in their switchroom.yaml config.
 */
export function getPlaywrightMcpSettingsEntry(): { key: string; value: McpServerConfig } {
  return {
    key: "playwright",
    value: {
      command: "npx",
      // Pinned: Microsoft ships breaking changes without major-version bumps.
      // Bump deliberately when validating against a newer release.
      args: ["-y", "@playwright/mcp@0.0.71", "--snapshot"],
    },
  };
}

/**
 * Allowed `tier` values per RFC G §4.2 — kept here as a string-literal
 * union (rather than importing from src/config/schema) to avoid a memory
 * → config import dependency. The schema and this set must agree; the
 * unit test in scaffold-integration.test.ts pins the alignment.
 */
export type GdriveMcpTier = "core" | "extended" | "complete";

/**
 * Pinned upstream commit SHA for `taylorwilsdon/google_workspace_mcp`.
 *
 * Specific commit SHA — bump deliberately. Pinning to a 40-char commit
 * SHA (not the moving tag ref) means upstream history rewrites can't
 * change what we run, while still tracking a tagged release. This SHA
 * is the commit annotated tag `v1.20.4` dereferences to
 * (`gh api repos/taylorwilsdon/google_workspace_mcp/git/refs/tags/v1.20.4`
 * → tag obj → `.object.sha`). v1.20.4 (2026-05-07) supersedes the prior
 * pin v1.20.3 (`f3c7dc5…`): it hardens the `--single-user` stdio OAuth
 * callback path switchroom depends on (upstream PR #762, "missing state
 * parameter fallback for single-user stdio OAuth callbacks"). The
 * `workspace-mcp` entrypoint is unchanged at this tag (pyproject
 * `[project.scripts]` still defines `workspace-mcp = "main:main"` —
 * the bug-6 guard). Validated end-to-end in a real agent container at
 * this SHA: MCP starts and a real Drive call authenticates the seeded
 * single-user account. When bumping: re-deref a NEW tag to its commit
 * SHA, confirm the entrypoint, and re-run the docker pin-smoke test.
 *
 * Exported as the single source of truth: the scaffold MCP entry and
 * the in-container `drive-mcp-launcher` both reference this constant so
 * the spawned upstream revision is identical on both code paths.
 */
export const GOOGLE_WORKSPACE_MCP_PINNED_SHA =
  "9d69115b63e6bc2ef0d4b5d7a3b962396382b44c";

export interface GdriveMcpEntryOptions {
  /**
   * Which upstream `--tool-tier` to expose. When `undefined` (the Phase 1
   * default), no `--tool-tier` flag is passed and the upstream MCP runs at
   * its native default (full ~60+ tool surface). This preserves shipped
   * v0.6.0 behaviour for operators who haven't opted into a tier yet.
   *
   * When set, plumbs through as `--tool-tier <value>` on the spawn args.
   * Operators opt in via top-level or per-agent
   * `google_workspace.tier: core | extended | complete` per RFC G §4.2.
   *
   * A future major-version cleanup will make `core` the default (per RFC
   * G §4.2 "the validated 16-tool surface") — that's a documented breaking
   * change, not Phase 1's job.
   */
  tier?: GdriveMcpTier;
}

/**
 * Return the MCP server entry for the Google Workspace MCP (Drive + Docs +
 * Sheets + Calendar + optionally Gmail) per RFC C §2 / RFC G.
 *
 * The entry's `command` is the switchroom CLI's hidden
 * `drive-mcp-launcher` verb, NOT a bare `uvx`. The launcher (see
 * `src/cli/drive-mcp-launcher.ts`) runs INSIDE the agent container as the
 * agent UID and, at spawn time:
 *
 *   1. pulls a Google refresh token from the auth-broker (path-as-identity
 *      per-agent socket; broker enforces `google_accounts.<acct>.enabled_for`),
 *   2. resolves the OAuth client_secret from config / vault-broker,
 *   3. pre-seeds a credentials file (`{token:null, refresh_token, ...,
 *      expiry:null}`) into a per-agent `WORKSPACE_MCP_CREDENTIALS_DIR`,
 *   4. `exec`s `uvx --from git+...@<pinned-sha> workspace-mcp
 *      --single-user [--tool-tier <tier>]` (the upstream package's
 *      MCP-server entrypoint is `workspace-mcp`, not
 *      `google-workspace-mcp`).
 *
 * The `--single-user` + pre-seeded-file shape is what makes upstream run
 * browserless: token/expiry null forces the refresh branch, no OAuth
 * device flow. The launcher pins the upstream revision to
 * `GOOGLE_WORKSPACE_MCP_PINNED_SHA` (same constant referenced here so the
 * two paths can never drift).
 *
 * No `env` block: the old `GOOGLE_OAUTH_TOKEN_FROM_VAULT` /
 * `GOOGLE_OAUTH_REFRESH_TOKEN` injection idea is dead — credentials are
 * delivered via the seeded file the launcher writes, never via env.
 *
 * Default OFF for an agent — the scaffold only emits this entry when the
 * agent has `google_workspace.account` set AND that account lists the
 * agent in `google_accounts.<account>.enabled_for[]` (see
 * `shouldEmitGdriveMcp`). Agents can still hard opt-out with
 * `mcp_servers: { gdrive: false }`.
 *
 * @param switchroomCliPath  Absolute path to the in-container switchroom
 *                           CLI (`/usr/local/bin/switchroom`), matching
 *                           how the other switchroom-internal MCP entries
 *                           (agent-config, hostd) are spawned.
 */
export function getGdriveMcpSettingsEntry(
  switchroomCliPath: string,
  options: GdriveMcpEntryOptions = {},
): { key: string; value: McpServerConfig } {
  // The launcher reads the tier itself from config; we still thread it
  // through here so the resolved choice is visible in settings.json
  // (doctor/debug surfaces) and so a future caller without config in
  // scope can pin it explicitly.
  const tierArgs = options.tier ? ["--tier", options.tier] : [];
  return {
    key: "gdrive",
    value: {
      command: switchroomCliPath,
      args: ["drive-mcp-launcher", ...tierArgs],
    },
  };
}

/**
 * The shared gate predicate: should agent `<agentName>` receive the
 * `gdrive` MCP entry?
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
 * Describes a single built-in default MCP entry.
 *
 * - `key`: the mcpServers key in settings.json (e.g. "playwright")
 * - `value`: the MCP server config object to write
 * - `optOutKey`: the key in `mcp_servers` that an agent uses to opt out
 *   (currently always the same as `key`, but kept explicit so the type is
 *   self-documenting and future entries can differ)
 */
export interface BuiltinMcpEntry {
  key: string;
  value: McpServerConfig;
  /** The key an agent sets to `false` in `mcp_servers` to suppress this default. */
  optOutKey: string;
}

/**
 * Return the complete list of built-in default MCP entries that every agent
 * should receive unless explicitly opted out.
 *
 * This is the single source of truth consumed by both:
 *   - `scaffoldAgent` / `reconcileAgent` (scaffold.ts) — at agent creation and
 *     on every `switchroom agent reconcile` run
 *   - `reconcileDefaultMcps` (update.ts) — at `switchroom update` time, so
 *     agents created before a default was introduced pick it up automatically
 *
 * To add a new built-in default: add an entry here. Both scaffold and update
 * paths will pick it up automatically.
 *
 * Agents can opt out of any entry by setting
 * `mcp_servers: { <optOutKey>: false }` in their switchroom.yaml config.
 */
export function getBuiltinDefaultMcpEntries(): BuiltinMcpEntry[] {
  const playwright = getPlaywrightMcpSettingsEntry();
  return [
    { key: playwright.key, value: playwright.value, optOutKey: playwright.key },
  ];
}

/**
 * Describes a single built-in default skill entry.
 *
 * - `key`: directory name in the bundled `skills/` pool (also the name
 *   used inside `<agentDir>/.claude/skills/`).
 * - `optOutKey`: key in `defaults.bundled_skills` (or per-agent
 *   `bundled_skills`) that the operator sets to `false` to suppress
 *   this default. Currently always equal to `key`, kept explicit so the
 *   type self-documents and a future rename can stay backward-compatible.
 * - `source`: where the skill was sourced from. "anthropic" entries are
 *   vendored from anthropics/skills (see each skill's VENDORED.md);
 *   "switchroom" entries are first-party operator skills bundled in this
 *   repo under skills/switchroom-*.
 */
export interface BuiltinSkillEntry {
  key: string;
  optOutKey: string;
  source: "anthropic" | "switchroom";
}

/**
 * Built-in default skills that ship enabled on every Switchroom agent
 * regardless of role, unless explicitly opted out via
 * `defaults.bundled_skills: { <key>: false }` (or per-agent
 * `bundled_skills`).
 *
 * Two source pools:
 *
 *   - **Anthropic vendored** (`source: "anthropic"`): MIT-licensed skills
 *     from https://github.com/anthropics/skills, vendored under
 *     `skills/<name>/` with a `VENDORED.md` recording the pin commit.
 *   - **Switchroom core** (`source: "switchroom"`): the slim operator
 *     surface every agent benefits from — log tailing, status checks,
 *     "something is broken" diagnostics. The fuller operator set
 *     (switchroom-install / switchroom-manage / switchroom-architecture)
 *     stays foreman-only and is still gated inside `installSwitchroomSkills`.
 *
 * To add a new universal default: add an entry here. Both the scaffold
 * path and the `switchroom update` reconcile path pick it up automatically.
 */
export function getBuiltinDefaultSkillEntries(): BuiltinSkillEntry[] {
  const anthropic = [
    "skill-creator",
    "mcp-builder",
    "webapp-testing",
    "pdf",
    "docx",
    "xlsx",
    "pptx",
  ] as const;
  const switchroomCore = [
    "switchroom-cli",
    "switchroom-status",
    "switchroom-health",
    "switchroom-runtime",
  ] as const;
  return [
    ...anthropic.map((key) => ({ key, optOutKey: key, source: "anthropic" as const })),
    ...switchroomCore.map((key) => ({ key, optOutKey: key, source: "switchroom" as const })),
  ];
}

// #235: getSwitchroomMcpSettingsEntry removed. The switchroom-mcp server's
// 4 tools (switchroom_memory_*, workspace_memory_*) had zero production
// callers and were subsumed by Hindsight's MCP (`mcp__hindsight__*`) +
// Claude Code's built-in Read/Grep. Reconcile in scaffold.ts now actively
// retracts any stale `settings.mcpServers.switchroom` entry from
// pre-existing agents.
