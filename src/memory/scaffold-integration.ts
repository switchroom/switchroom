import { resolveAgentConfig } from "../config/merge.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  generateHindsightMcpConfig,
  getCollectionForAgent,
  isHindsightEnabled,
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
  // Honors SWITCHROOM_MEMORY_BACKEND=none like every other hindsight
  // gate (install-validation 2026-05-17, R2 review round 3). Guarding
  // INSIDE this function makes every caller correct — including the
  // un-gated scaffold/reconcile settings.json merge sites — so a
  // `none` install no longer writes the hindsight MCP server entry.
  const memoryConfig = config.memory;
  if (!isHindsightEnabled(config)) {
    return null;
  }
  // isHindsightEnabled true ⇒ memory.backend === "hindsight" ⇒ defined.
  if (!memoryConfig) {
    return null;
  }

  const collection = getCollectionForAgent(agentName, config);
  // Resolve the per-agent memory cascade (defaults → profile → agent) so the
  // reflect_budget / reflect_max_tokens overrides thread into the shim env.
  const resolved = resolveAgentConfig(
    config.defaults,
    config.profiles,
    config.agents[agentName] ?? {},
  );
  const mcpConfig = generateHindsightMcpConfig(collection, memoryConfig, {
    reflectBudget: resolved.memory?.reflect_budget,
    reflectMaxTokens: resolved.memory?.reflect_max_tokens,
  });

  // Defer hindsight's 32 MCP tools via tool search. Auto-recall (recall.py
  // via UserPromptSubmit hook) and auto-retain (retain.py via Stop hook) call
  // Hindsight directly over HTTP at 127.0.0.1:18888 — they do NOT go through
  // the MCP server. Only the agent's interactive mcp__hindsight__* calls use
  // the MCP server, and those load on demand. Live-validated: /health → 200,
  // bank read works, recall/retain are urllib calls over the HTTP API.
  // Deferring reclaims ~32 tool schemas (~8k tokens) from the always-on budget.
  return { key: "hindsight", value: { ...mcpConfig, alwaysLoad: false } };
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
 * is the commit annotated tag `v1.23.1` dereferences to
 * (`gh api repos/taylorwilsdon/google_workspace_mcp/git/refs/tags/v1.23.1`
 * → tag obj → `.object.sha`, i.e. the `v1.23.1^{}` peel). v1.23.1
 * (2026-08-02) supersedes the prior pin v1.20.4 (`9d69115…`): it carries
 * an auth/server refactor (request-scoped auth upstream #992, late-bind
 * port fallback #768 via the new `auth/port_resolver.py`) plus docs/
 * sheets/forms bug fixes and new import tools. The `--single-user`
 * seeded-credentials refresh branch switchroom depends on is unchanged
 * (upstream still reads `WORKSPACE_MCP_CREDENTIALS_DIR`, preferred, in
 * `auth/google_auth.py`, and takes the refresh path on a `token:null`
 * seed — no browser), and the new `--permissions` flag is additive and
 * mutually exclusive only with `--read-only`/`--tools`, which the
 * launcher never combines with it. The `workspace-mcp` entrypoint is
 * unchanged at this tag (pyproject `[project.scripts]` still defines
 * `workspace-mcp = "main:main"` — the bug-6 guard) and `WORKSPACE_MCP_PORT`
 * is still honored. Validated at this SHA via the stdio JSON-RPC smoke
 * test: `initialize` completes and `tools/list` registers the complete
 * tier (incl. `insert_doc_image` / `batch_update_doc` /
 * `inspect_doc_structure`); the four launcher flags `--single-user /
 * --tools / --tool-tier / --read-only` all still parse in `main.py`.
 * When bumping: re-deref a NEW tag to its commit SHA, confirm the
 * entrypoint, and re-run the docker pin-smoke test.
 *
 * Exported as the single source of truth: the scaffold MCP entry and
 * the in-container `drive-mcp-launcher` both reference this constant so
 * the spawned upstream revision is identical on both code paths.
 */
export const GOOGLE_WORKSPACE_MCP_PINNED_SHA =
  "db6212992738d4380a94fb6940140bcebf5d861d";

/**
 * Pinned softeria/ms-365-mcp-server version — RFC #1873 PR 3.
 *
 * Use `npx -y ms-365-mcp-server@<version>` to spawn; pinning by npm
 * version (vs Google's SHA pinning) because softeria publishes
 * semantic releases to npm. Bumping discipline: pin to a tagged
 * release that has passed the docker pin-smoke test (PR 5 UAT).
 *
 * Why softeria — see RFC §3 and the 2026-05-27 validation pass: it's
 * the only candidate with stdio + Node + personal MSA + 200+ tools
 * + active maintenance + MIT license. BYOT mode is access-token-only
 * (no refresh-token-in mode in the M365 ecosystem yet) — the
 * launcher handles refresh internally.
 *
 * Exported as the single source of truth so the scaffold MCP entry
 * and the in-container `m365-mcp-launcher` reference identical bits.
 */
export const MICROSOFT_WORKSPACE_MCP_PINNED_VERSION = "0.113.0";

/** npm package name for the pinned spawn. */
export const MICROSOFT_WORKSPACE_MCP_PACKAGE = "@softeria/ms-365-mcp-server";

/**
 * Pinned `@notionhq/notion-mcp-server` version — RFC
 * reference/rfcs/notion-integration.md PR 2.
 *
 * Notion ships its MCP server as an npm package; pinning by semver
 * version (same discipline as softeria). Bumping discipline: pin to a
 * tagged release that passes the docker pin-smoke test (PR 5 UAT).
 *
 * Notion's integration token is long-lived (no OAuth refresh), so the
 * launcher does NOT carry a refresh loop — it spawns the MCP server
 * once with `NOTION_TOKEN` in env and bridges stdio for the lifetime
 * of the parent process.
 *
 * Operator override path: `notion_workspace.mcp_version: "<semver>"`
 * in switchroom.yaml.
 */
export const NOTION_MCP_PINNED_VERSION = "1.8.1";

/** npm package name for the pinned spawn. */
export const NOTION_MCP_PACKAGE = "@notionhq/notion-mcp-server";

/**
 * The env var Notion's MCP server reads at startup to receive the
 * integration token. Confirmed via the package's README and
 * `src/index.ts` of @notionhq/notion-mcp-server@1.8.x.
 */
export const NOTION_TOKEN_ENV = "NOTION_TOKEN";

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
  /**
   * Per-account service selection (v1 read-only scope model) from the
   * persisted `google_accounts.<email>.services` record. When set,
   * threaded as `--services a,b,c` so the launcher narrows upstream to
   * those services (upstream `--tools`). Short tokens: cal, drive,
   * docs, sheets, slides. The launcher re-reads the record from config
   * and is authoritative; threading makes the resolved choice visible
   * in settings.json (mirrors `tier`).
   */
  services?: string[];
  /**
   * Per-account read-only selection from the persisted
   * `google_accounts.<email>.readonly` record. When true, threaded as
   * `--read-only` (upstream requests readonly scopes and does not
   * register write tools). Same visibility rationale as `services`.
   */
  readOnly?: boolean;
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
 * `shouldEmitGdriveMcp` in `config/google-workspace-acl.ts`). Agents can
 * still hard opt-out with
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
  const servicesArgs =
    options.services && options.services.length > 0
      ? ["--services", options.services.join(",")]
      : [];
  const readOnlyArgs = options.readOnly ? ["--read-only"] : [];
  return {
    key: "gdrive",
    value: {
      command: switchroomCliPath,
      args: [
        "drive-mcp-launcher",
        ...tierArgs,
        ...servicesArgs,
        ...readOnlyArgs,
      ],
    },
  };
}

export interface Ms365McpEntryOptions {
  /**
   * Whether to pass `--org-mode` to softeria, lighting up Teams/SharePoint
   * tools. Resolved by `resolveMs365McpEntry` from per-agent or top-level
   * `microsoft_workspace.org_mode` (per-agent wins). The launcher also
   * re-reads from config at spawn time — threading it here just makes the
   * resolved choice visible in settings.json.
   */
  orgMode?: boolean;
  /**
   * The MCP server key. Single-account agents keep the bare `ms-365`
   * (back-compat); multi-account agents get `ms-365-<slug>` per binding.
   * Defaults to `ms-365`.
   */
  key?: string;
  /**
   * The Microsoft account this entry binds. When set, threaded to the
   * launcher as `--account <email>` so it fetches THAT account's token
   * from the broker. Omitted (singular back-compat) → no `--account`.
   */
  account?: string;
  /**
   * Per-account tool allowlist → softeria `--enabled-tools <regex>`
   * (tokens joined with `|`). Omitted = all tools for this account.
   */
  enabledTools?: string[];
}

/**
 * MCP server entry for the Microsoft 365 launcher — RFC #1873 PR 3.
 *
 * Spawns `<switchroom> m365-mcp-launcher [--org-mode]` which in turn
 * acquires a fresh access token from the auth-broker and execs the
 * pinned softeria `ms-365-mcp-server`. The launcher handles refresh
 * internally (combined launcher+refresher, simpler than the RFC's
 * two-process design).
 */
export function getMs365McpSettingsEntry(
  switchroomCliPath: string,
  options: Ms365McpEntryOptions = {},
): { key: string; value: McpServerConfig } {
  const args: string[] = ["m365-mcp-launcher"];
  if (options.orgMode) args.push("--org-mode");
  if (options.account) args.push("--account", options.account);
  if (options.enabledTools && options.enabledTools.length > 0) {
    args.push("--enabled-tools", options.enabledTools.join("|"));
  }
  return {
    key: options.key ?? "ms-365",
    value: {
      command: switchroomCliPath,
      args,
    },
  };
}

/**
 * MCP server entry for the Notion launcher — RFC
 * reference/rfcs/notion-integration.md PR 2.
 *
 * Spawns `<switchroom> notion-mcp-launcher` which in turn fetches the
 * integration token from the vault-broker and execs
 * `@notionhq/notion-mcp-server`. No refresh loop — Notion's
 * integration token is long-lived.
 *
 * Tool surface restrictions (create_database denied, standalone-page
 * writes denied) are enforced by the PreToolUse hook in PR 3, NOT by
 * filtering the MCP's tool list. The hook's allowlist gate sees every
 * tool call and rejects per RFC §8.1.
 */
export function getNotionMcpSettingsEntry(
  switchroomCliPath: string,
  options: { mcpVersion?: string; vaultKey?: string } = {},
): { key: string; value: McpServerConfig } {
  const args: string[] = ["notion-mcp-launcher"];
  if (options.vaultKey) args.push("--vault-key", options.vaultKey);
  if (options.mcpVersion) args.push("--mcp-version", options.mcpVersion);
  return {
    key: "notion",
    value: {
      command: switchroomCliPath,
      args,
    },
  };
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
    "mental-model-curator",
    "dev-protocol",
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
