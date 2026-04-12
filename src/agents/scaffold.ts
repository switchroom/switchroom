import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  symlinkSync,
  copyFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { AgentConfig, ClerkConfig, TelegramConfig } from "../config/schema.js";
import { DEFAULT_PROFILE } from "../config/schema.js";
import {
  resolveAgentConfig,
  translateHooksToClaudeShape,
  usesClerkTelegramPlugin,
  deepMergeJson,
} from "../config/merge.js";
import {
  getProfilePath,
  getBaseProfilePath,
  renderTemplate,
  copyProfileSkills,
} from "./profiles.js";
import { getHindsightSettingsEntry, getClerkMcpSettingsEntry } from "../memory/scaffold-integration.js";
import type { McpServerConfig } from "../memory/hindsight.js";
import { loadTopicState } from "../telegram/state.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import {
  findExistingClaudeJson,
  copyOnboardingState,
  copyExistingCredentials,
  preTrustWorkspace,
  createMinimalClaudeConfig,
  loadUserConfig,
} from "../setup/onboarding.js";

export interface ScaffoldResult {
  agentDir: string;
  created: string[];
  skipped: string[];
}

/**
 * Resolve a bot token value. If it's a vault reference, try to resolve it
 * via CLERK_VAULT_PASSPHRASE or fall back to TELEGRAM_BOT_TOKEN env var.
 * Returns the resolved token or undefined if unresolvable.
 */
function resolveBotToken(rawToken: string): string | undefined {
  if (!isVaultReference(rawToken)) {
    return rawToken;
  }

  // Try vault resolution via passphrase
  const passphrase = process.env.CLERK_VAULT_PASSPHRASE;
  if (passphrase) {
    try {
      const { openVault } = require("../vault/vault.js") as typeof import("../vault/vault.js");
      const { resolvePath } = require("../config/loader.js") as typeof import("../config/loader.js");
      const vaultPath = resolvePath(process.env.CLERK_VAULT_PATH ?? "~/.clerk/vault.enc");
      const secrets = openVault(passphrase, vaultPath);
      const key = parseVaultReference(rawToken);
      if (secrets[key]) {
        return secrets[key];
      }
    } catch { /* vault not available */ }
  }

  // Fall back to TELEGRAM_BOT_TOKEN env var
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  return undefined;
}

/**
 * Set up plugin symlinks and config files in the agent's CLAUDE_CONFIG_DIR.
 *
 * Symlinks the official Telegram plugin marketplace from the user's global
 * ~/.claude/plugins/ and copies plugin config files if they exist.
 */
export function setupPlugins(agentDir: string): void {
  const home = process.env.HOME ?? "/root";
  const globalPluginsDir = join(home, ".claude", "plugins");
  const agentPluginsDir = join(agentDir, ".claude", "plugins");
  const agentMarketplacesDir = join(agentPluginsDir, "marketplaces");

  // Create plugin directories
  mkdirSync(agentMarketplacesDir, { recursive: true });

  // Symlink the official marketplace
  const globalMarketplace = join(globalPluginsDir, "marketplaces", "claude-plugins-official");
  const agentMarketplace = join(agentMarketplacesDir, "claude-plugins-official");

  if (existsSync(globalMarketplace) && !existsSync(agentMarketplace)) {
    try {
      symlinkSync(globalMarketplace, agentMarketplace);
    } catch { /* symlink may fail if target doesn't exist */ }
  }

  // Copy plugin config files if they exist
  const configFiles = ["installed_plugins.json", "known_marketplaces.json", "blocklist.json"];
  for (const file of configFiles) {
    const globalFile = join(globalPluginsDir, file);
    const agentFile = join(agentPluginsDir, file);
    if (existsSync(globalFile) && !existsSync(agentFile)) {
      try {
        copyFileSync(globalFile, agentFile);
      } catch { /* ignore copy failures */ }
    }
  }
}

/**
 * Pre-approved MCP tool names for the clerk enhanced Telegram plugin.
 * When channels.telegram.plugin is "clerk" we pre-approve these so the agent
 * never has to prompt for MCP tool permissions.
 */
const CLERK_TELEGRAM_MCP_TOOLS = [
  "mcp__clerk-telegram",
  "mcp__clerk-telegram__reply",
  "mcp__clerk-telegram__stream_reply",
  "mcp__clerk-telegram__react",
  "mcp__clerk-telegram__edit_message",
  "mcp__clerk-telegram__send_typing",
  "mcp__clerk-telegram__pin_message",
  "mcp__clerk-telegram__forward_message",
  "mcp__clerk-telegram__download_attachment",
];

/**
 * Pre-approved MCP tool names for the Hindsight memory server.
 * When the memory backend is hindsight we pre-approve the wildcard so
 * the agent can recall and store memories without prompting.
 */
const HINDSIGHT_MCP_TOOLS = [
  "mcp__hindsight",
  "mcp__hindsight__*",
];

/**
 * Pre-approved MCP tool names for the clerk management MCP server.
 * Lets agents call clerk_agent_*, clerk_auth_status, clerk_memory_search
 * etc. without prompting.
 */
const CLERK_MCP_TOOLS = [
  "mcp__clerk",
  "mcp__clerk__*",
];

/**
 * Built-in Claude Code tools. When `tools.allow: [all]` is set in
 * clerk.yaml, every one of these is pre-approved so the agent never
 * blocks on a permission prompt at runtime.
 *
 * Claude Code does NOT accept a literal "all" or "*" in permissions.allow,
 * which is why we have to enumerate. defaultMode: acceptEdits is also set
 * as a backstop, but it only auto-accepts file edits — Bash/Read/Write/
 * WebFetch all still prompt unless explicitly listed.
 */
/** Stable de-duplication preserving first-seen order. */
function dedupe<T>(items: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * POSIX-safe single-quote wrapping for embedding a user-supplied string
 * in a generated shell script. Every embedded single-quote is replaced
 * with the `'"'"'` sequence, which closes the current single-quoted
 * literal, emits a double-quoted single quote, and reopens a new
 * single-quoted literal. Works with arbitrary bytes including
 * newlines, backticks, and dollar signs — the shell never interprets
 * the content.
 */
function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Resolve the global clerk skills pool directory. Honors the optional
 * `clerk.skills_dir` override in clerk.yaml and falls back to
 * `~/.clerk/skills`. Expands a leading `~/` against $HOME.
 */
function resolveSkillsPoolDir(override: string | undefined): string {
  const raw = override ?? "~/.clerk/skills";
  if (raw.startsWith("~/")) {
    return resolve(process.env.HOME ?? "/root", raw.slice(2));
  }
  return resolve(raw);
}

/**
 * Sync the set of global-skill symlinks in an agent's skills/ directory
 * against the user's declared `skills:` list (already merged with
 * defaults). Idempotent and safe to call on reconcile:
 *
 *   - Missing links for declared skills are created.
 *   - Stale links whose target no longer appears in the list are
 *     removed. Only symlinks are ever removed — real files/directories
 *     from the template's copySkills pass are untouched.
 *   - Missing pool entries (user listed a skill that doesn't exist at
 *     <skills_dir>/<name>) produce a warning but don't throw — this is
 *     a non-fatal configuration lint.
 */
function syncGlobalSkills(
  agentDir: string,
  declared: string[],
  skillsDirOverride: string | undefined,
): void {
  const skillsPool = resolveSkillsPoolDir(skillsDirOverride);
  const agentSkillsDir = join(agentDir, "skills");
  mkdirSync(agentSkillsDir, { recursive: true });

  // Create symlinks for each declared skill. Skip entries that are
  // already correct; replace ones pointing at the wrong target.
  for (const name of declared) {
    if (!name || name.includes("/") || name === "." || name === "..") {
      console.warn(`  WARNING: invalid skill name "${name}" — skipping`);
      continue;
    }
    const src = join(skillsPool, name);
    const dest = join(agentSkillsDir, name);
    if (!existsSync(src)) {
      console.warn(
        `  WARNING: skill "${name}" not found in pool (${skillsPool}) — skipping`,
      );
      continue;
    }
    // If dest exists and is a symlink to the right target, leave it.
    // If dest exists as a real file/dir (e.g. from profile copySkills),
    // also leave it — profile-bundled skills take priority over the
    // pool to avoid silent surprises. Use lstatSync so broken symlinks
    // are detected (statSync would follow them and throw, falsely
    // indicating the path is free).
    let linkStat;
    try {
      linkStat = lstatSync(dest);
    } catch {
      linkStat = null;
    }
    if (linkStat) {
      // Broken symlink into the pool: replace it (the old target is
      // gone, so we can safely recreate). Anything else: leave alone.
      if (linkStat.isSymbolicLink()) {
        let target: string | null = null;
        try {
          target = readlinkSync(dest);
        } catch { /* unreadable; leave alone */ }
        if (target && target.startsWith(skillsPool)) {
          try {
            rmSync(dest, { force: true });
          } catch { /* best effort */ }
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
    try {
      symlinkSync(src, dest);
    } catch (err) {
      console.warn(
        `  WARNING: failed to symlink skill "${name}": ${(err as Error).message}`,
      );
    }
  }

  // Clean up stale symlinks — ones that point into the skills pool but
  // aren't in the current declared set. Real files and symlinks that
  // point elsewhere are left untouched.
  const declaredSet = new Set(declared);
  for (const entry of readdirSync(agentSkillsDir)) {
    if (declaredSet.has(entry)) continue;
    const entryPath = join(agentSkillsDir, entry);
    let linkTarget: string | null = null;
    try {
      linkTarget = readlinkSync(entryPath);
    } catch {
      continue; // not a symlink
    }
    if (linkTarget && linkTarget.startsWith(skillsPool)) {
      rmSync(entryPath, { force: true });
    }
  }
}

/**
 * Translate per-channel YAML fields into env vars the telegram-plugin
 * will read at startup. Today: CLERK_TG_FORMAT and CLERK_TG_RATE_LIMIT_MS.
 *
 * Returns an object that can be merged into the user env. User-declared
 * env vars with the same key take precedence (see the call site) since
 * an explicit `env:` entry is a more precise signal than a channel
 * default.
 */
function channelsToEnv(agent: AgentConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const tg = agent.channels?.telegram;
  if (!tg) return out;
  if (tg.format !== undefined) out.CLERK_TG_FORMAT = tg.format;
  if (tg.rate_limit_ms !== undefined) {
    out.CLERK_TG_RATE_LIMIT_MS = String(tg.rate_limit_ms);
  }
  return out;
}

/**
 * Top-level settings.json keys that clerk's scaffold/reconcile
 * pipeline owns and rebuilds on every run. When the settings_raw
 * escape hatch injects additional top-level keys (e.g. `effort`,
 * `apiKeyHelper`), they're tracked via the `_clerkManagedRawKeys`
 * side-car so reconcile can retract them if the user removes them
 * from clerk.yaml. Keys in this set are never retracted because the
 * scaffold path rebuilds them deterministically from clerk.yaml.
 */
const CLERK_OWNED_SETTINGS_KEYS = new Set<string>([
  "permissions",
  "mcpServers",
  "enabledPlugins",
  "autoMemoryEnabled",
  "skipDangerousModePermissionPrompt",
  "hooks",
  "model",
]);

const ALL_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillBash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "ExitPlanMode",
];

/**
 * Recursively copy a directory tree, overwriting existing files. Used to
 * deploy vendored plugin files into each agent's .claude/plugins/ dir.
 */
function copyDirRecursive(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const s = statSync(srcPath);
    if (s.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
      // Preserve executable bit for hook scripts (cleared on copy by default)
      if (s.mode & 0o100) {
        chmodSync(destPath, s.mode);
      }
    }
  }
}

/**
 * Vendored hindsight-memory plugin location inside the clerk repo.
 * Pinned to the version we ship; updated by `clerk update`.
 */
function resolveHindsightVendorPath(): string {
  return resolve(import.meta.dirname, "../../vendor/hindsight-memory");
}

/**
 * Result of installing the vendored hindsight-memory plugin into an agent.
 */
export interface HindsightPluginInstall {
  pluginDir: string;
  apiBaseUrl: string;
  bankId: string;
}

/**
 * Install (or refresh) the vendored hindsight-memory plugin for an agent.
 *
 * Copies the plugin tree into <agentDir>/.claude/plugins/hindsight-memory/
 * and returns the metadata needed by the start.sh template to set
 * env vars and the --plugin-dir flag.
 *
 * Returns null when:
 *  - clerk.yaml memory backend is not hindsight
 *  - the agent has memory.auto_recall: false
 *  - the vendored plugin source isn't present (e.g., bare clerk install
 *    without the vendor dir)
 *
 * The plugin reads its config from environment variables (HINDSIGHT_*)
 * which start.sh exports — see templates/_base/start.sh.hbs.
 */
export function installHindsightPlugin(
  agentName: string,
  agentDir: string,
  clerkConfig: ClerkConfig | undefined,
): HindsightPluginInstall | null {
  if (!clerkConfig) return null;
  const memory = clerkConfig.memory;
  if (memory?.backend !== "hindsight") return null;

  const agentMemory = clerkConfig.agents[agentName]?.memory;
  if (agentMemory?.auto_recall === false) return null;

  const sourcePath = resolveHindsightVendorPath();
  if (!existsSync(sourcePath)) {
    return null;
  }

  // Copy the vendored plugin into the agent's .claude/plugins dir.
  // Force overwrite on every reconcile so plugin updates from
  // `clerk update` propagate.
  const destPath = join(agentDir, ".claude", "plugins", "hindsight-memory");
  if (existsSync(destPath)) {
    rmSync(destPath, { recursive: true, force: true });
  }
  copyDirRecursive(sourcePath, destPath);

  // Resolve the agent's bank/collection name and the Hindsight REST URL.
  // The plugin's hooks expect HINDSIGHT_API_URL (the REST base), not the
  // /mcp/ MCP endpoint URL — strip the suffix.
  const bankId = agentMemory?.collection ?? agentName;
  const mcpUrl = (memory.config?.url as string | undefined)
    ?? "http://127.0.0.1:8888/mcp/";
  const apiBaseUrl = mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");

  return { pluginDir: destPath, apiBaseUrl, bankId };
}

/**
 * Attempt to locate the clerk CLI binary. Used to populate CLERK_CLI_PATH
 * in the .mcp.json env for the clerk-telegram MCP server. Falls back to
 * the literal string "clerk" if `which clerk` is unavailable.
 */
function resolveClerkCliPath(): string {
  try {
    const result = execSync("which clerk", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (result) {
      return result;
    }
  } catch {
    /* clerk not on PATH */
  }
  return "clerk";
}

/**
 * Scaffold (or reconcile) the directory structure for a single agent.
 *
 * Idempotent: creates missing files and directories but never overwrites
 * existing ones.
 */
export function scaffoldAgent(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  clerkConfig?: ClerkConfig,
  userIdOverride?: string,
  clerkConfigPath?: string,
): ScaffoldResult {
  // Apply the full cascade: global defaults → inline profile (from
  // `extends:`) → per-agent config. When clerk.yaml has no `defaults:`
  // or `profiles:` and no `extends:` on the agent, the result is
  // identical to agentConfigRaw so existing behavior is preserved.
  const agentConfig = resolveAgentConfig(
    clerkConfig?.defaults,
    clerkConfig?.profiles,
    agentConfigRaw,
  );

  const agentDir = resolve(agentsDir, name);
  const created: string[] = [];
  const skipped: string[] = [];

  const profilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
  const basePath = getBaseProfilePath();

  // Load user config for Telegram user ID
  const userConfig = loadUserConfig();
  const userId = userIdOverride ?? userConfig?.userId;

  // Resolve topic ID: config takes priority, then topics.json state file
  let topicId = agentConfig.topic_id;
  if (topicId === undefined) {
    try {
      const topicState = loadTopicState();
      topicId = topicState.topics?.[name]?.topic_id;
    } catch { /* no state file yet */ }
  }

  // Resolve bot token: per-agent token takes priority, then global telegram token
  const rawBotToken = agentConfig.bot_token ?? telegramConfig.bot_token;
  const resolvedBotToken = resolveBotToken(rawBotToken);

  // Compute the effective permissions.allow list for settings.json.
  //
  // Special handling:
  //   - If the user writes `tools.allow: [all]`, Claude Code rejects the
  //     literal string "all" in the permissions.allow list. The correct
  //     equivalent is to use defaultMode: "acceptEdits" with an empty
  //     allow list.
  //   - If channels.telegram.plugin is "clerk", pre-approve the clerk-telegram
  //     MCP tool names so the agent never has to confirm MCP tool
  //     permissions at runtime.
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  const baseAllow = hasAllWildcard
    ? ALL_BUILTIN_TOOLS
    : rawAllow.filter((t) => t !== "all");
  const memoryBackend = clerkConfig?.memory?.backend;
  const hindsightEnabled = memoryBackend === "hindsight";
  const permissionAllow = dedupe([
    ...baseAllow,
    ...(usesClerkTelegramPlugin(agentConfig) ? CLERK_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
    ...CLERK_MCP_TOOLS,
  ]);

  // Compute Hindsight plugin context for the start.sh + settings.json
  // templates. Mirrors installHindsightPlugin's gating logic so the
  // template only emits the env vars and --plugin-dir flag when the
  // plugin will actually be installed.
  const hindsightAutoRecallEnabled = hindsightEnabled
    && agentConfig.memory?.auto_recall !== false;
  const hindsightBankId = agentConfig.memory?.collection ?? name;
  const hindsightApiBaseUrl = (clerkConfig?.memory?.config?.url as string | undefined)
    ? (clerkConfig!.memory!.config!.url as string).replace(/\/mcp\/?$/, "").replace(/\/$/, "")
    : "http://127.0.0.1:8888";

  // Build the template rendering context
  const context: Record<string, unknown> = {
    name,
    agentDir,
    topicId,
    topicName: agentConfig.topic_name,
    topicEmoji: agentConfig.topic_emoji,
    soul: agentConfig.soul,
    tools,
    permissionAllow,
    defaultModeAcceptEdits: hasAllWildcard,
    memory: agentConfig.memory,
    model: agentConfig.model,
    mcpServers: agentConfig.mcp_servers,
    schedule: agentConfig.schedule,
    botToken: resolvedBotToken ?? rawBotToken,
    forumChatId: telegramConfig.forum_chat_id,
    dangerousMode: agentConfig.dangerous_mode === true,
    skipPermissionPrompt: agentConfig.skip_permission_prompt === true,
    useClerkPlugin: usesClerkTelegramPlugin(agentConfig),
    hindsightEnabled: hindsightAutoRecallEnabled,
    hindsightBankId,
    hindsightApiBaseUrl,
    // Phase 2 + 3 — user env merged with channel-derived env. User
    // entries win on conflict (explicit beats channel default). Each
    // value is POSIX-single-quoted at build time so `&`, `$`, backtick,
    // newline, and embedded quotes all survive shell parsing. The
    // template emits `export KEY={{{value}}}` with triple braces to
    // avoid Handlebars HTML-escaping the already-quoted string.
    userEnvQuoted: (() => {
      const combined = { ...channelsToEnv(agentConfig), ...(agentConfig.env ?? {}) };
      if (Object.keys(combined).length === 0) return undefined;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(combined)) {
        out[k] = shellSingleQuote(v);
      }
      return out;
    })(),
    systemPromptAppendShellQuoted: agentConfig.system_prompt_append
      ? shellSingleQuote(agentConfig.system_prompt_append)
      : undefined,
    // Phase 5 — cli_args escape hatch. Pre-joined here so the template
    // can dump it verbatim. Each arg is POSIX-single-quoted so arbitrary
    // user input (including flag values with spaces) reaches claude
    // intact. Leading space lets the template concat without a gap.
    extraCliArgs: agentConfig.cli_args && agentConfig.cli_args.length > 0
      ? " " + agentConfig.cli_args.map(shellSingleQuote).join(" ")
      : undefined,
  };

  // --- Create directory structure ---
  const dirs = [
    agentDir,
    join(agentDir, ".claude"),
    join(agentDir, "memory"),
    join(agentDir, "skills"),
    join(agentDir, "telegram"),
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // --- Render and write base templates ---
  writeIfMissing(
    join(agentDir, "start.sh"),
    () => renderTemplate(join(basePath, "start.sh.hbs"), context),
    created,
    skipped,
  );
  // Make start.sh executable
  if (existsSync(join(agentDir, "start.sh"))) {
    chmodSync(join(agentDir, "start.sh"), 0o755);
  }

  writeIfMissing(
    join(agentDir, ".claude", "settings.json"),
    () => renderTemplate(join(basePath, "settings.json.hbs"), context),
    created,
    skipped,
    0o600,
  );

  // --- Merge MCP configs into settings.json ---
  if (clerkConfig) {
    const settingsPath = join(agentDir, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (!settings.mcpServers) {
        settings.mcpServers = {};
      }

      // Hindsight memory MCP
      const hindsightEntry = getHindsightSettingsEntry(name, clerkConfig);
      if (hindsightEntry && !settings.mcpServers[hindsightEntry.key]) {
        settings.mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }

      // Clerk management MCP
      const clerkMcpEntry = getClerkMcpSettingsEntry();
      if (!settings.mcpServers[clerkMcpEntry.key]) {
        settings.mcpServers[clerkMcpEntry.key] = clerkMcpEntry.value;
      }

      // Hindsight memory plugin install (replaces our old shell hook).
      // The vendored plugin's own hooks.json wires SessionStart /
      // UserPromptSubmit / Stop / SessionEnd via Claude Code's plugin
      // loader once start.sh passes --plugin-dir.
      installHindsightPlugin(name, agentDir, clerkConfig);

      // Disable Claude Code's built-in auto-memory so the model doesn't
      // get dueling instructions (write to local .md files vs use
      // Hindsight). The settings flag gates the memory system-prompt
      // block at the source.
      const hindsightOn = clerkConfig.memory?.backend === "hindsight"
        && clerkConfig.agents[name]?.memory?.auto_recall !== false;
      if (hindsightOn) {
        settings.autoMemoryEnabled = false;
      }

      // --- Phase 2: user-declared hooks and model ---
      //
      // Hooks from clerk.yaml (merged with defaults) are translated from
      // clerk's flat shape to Claude Code's nested shape and assigned
      // wholesale to settings.hooks. Clerk owns the entire settings.hooks
      // object — plugin-installed hooks (hindsight) live in the plugin's
      // own hooks.json and are loaded via --plugin-dir, so they're not
      // affected by this and Claude Code merges them at runtime.
      const userHooks = translateHooksToClaudeShape(agentConfig.hooks);
      if (userHooks) {
        settings.hooks = userHooks;
      } else {
        delete settings.hooks;
      }
      // Explicit model override: written to settings.model so the user
      // doesn't have to pass --model on every invocation.
      if (agentConfig.model !== undefined) {
        settings.model = agentConfig.model;
      }

      // --- Phase 5: settings_raw escape hatch ---
      //
      // Final step before writing: deep-merge any user-declared raw
      // settings onto the computed object. This lets power users reach
      // Claude Code settings keys clerk doesn't wrap directly (e.g.
      // `effort`, `apiKeyHelper`, future keys). Happens last so clerk's
      // typed fields can be overridden — that's the point of the hatch.
      // Also stamp the `_clerkManagedRawKeys` side-car so reconcile can
      // retract non-clerk-owned keys if the user removes them later.
      const mergedSettings = agentConfig.settings_raw
        ? (deepMergeJson(settings, agentConfig.settings_raw) as Record<string, unknown>)
        : settings;
      if (agentConfig.settings_raw && Object.keys(agentConfig.settings_raw).length > 0) {
        mergedSettings._clerkManagedRawKeys = Object.keys(agentConfig.settings_raw);
      }

      writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2) + "\n", "utf-8");
    }
  }

  // --- Write project-level .mcp.json for clerk-telegram development channel ---
  //
  // When channels.telegram.plugin is "clerk", Claude Code's
  // `--dangerously-load-development-channels server:NAME` flag resolves
  // the MCP server definition from the project-level .mcp.json in the
  // working directory — NOT from settings.json mcpServers. Write it here
  // so the enhanced Telegram plugin can be launched as a dev channel.
  if (usesClerkTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    if (!existsSync(mcpJsonPath)) {
      const pluginDir = resolve(import.meta.dirname, "../../telegram-plugin");
      const clerkCliPath = resolveClerkCliPath();
      const resolvedConfigPath = clerkConfigPath
        ? resolve(clerkConfigPath)
        : resolve(process.cwd(), "clerk.yaml");

      const mcpServers: Record<string, McpServerConfig> = {
        "clerk-telegram": {
          command: "bun",
          args: ["run", "--cwd", pluginDir, "--shell=bun", "--silent", "start"],
          env: {
            TELEGRAM_STATE_DIR: join(agentDir, "telegram"),
            CLERK_CONFIG: resolvedConfigPath,
            CLERK_CLI_PATH: clerkCliPath,
          },
        },
      };

      // Add hindsight memory MCP if configured
      if (hindsightEnabled && clerkConfig) {
        const hindsightEntry = getHindsightSettingsEntry(name, clerkConfig);
        if (hindsightEntry) {
          mcpServers[hindsightEntry.key] = hindsightEntry.value;
        }
      }

      const mcpJson = { mcpServers };

      writeFileSync(
        mcpJsonPath,
        JSON.stringify(mcpJson, null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
      created.push(mcpJsonPath);
    }
  }

  // --- Render template-specific files ---
  const templateFiles: Array<{ src: string; dest: string }> = [
    { src: "CLAUDE.md.hbs", dest: "CLAUDE.md" },
    { src: "SOUL.md.hbs", dest: "SOUL.md" },
  ];

  for (const { src, dest } of templateFiles) {
    const srcPath = join(profilePath, src);
    if (existsSync(srcPath)) {
      writeIfMissing(
        join(agentDir, dest),
        () => {
          let rendered = renderTemplate(srcPath, context);
          // Phase 5: append claude_md_raw escape hatch on initial
          // scaffold. CLAUDE.md is user-protected afterwards so the
          // hatch is one-shot — users who edit CLAUDE.md after scaffold
          // keep their edits through subsequent reconciles.
          if (dest === "CLAUDE.md" && agentConfig.claude_md_raw) {
            rendered = rendered.trimEnd() + "\n\n" + agentConfig.claude_md_raw + "\n";
          }
          return rendered;
        },
        created,
        skipped,
      );
    }
  }

  // --- Claude Code config (onboarding state) ---
  // Try to copy from existing Claude installation; fall back to minimal config
  const existingClaudeJson = findExistingClaudeJson();
  if (existingClaudeJson) {
    copyOnboardingState(existingClaudeJson, agentDir);
    copyExistingCredentials(agentDir);
    if (!existsSync(join(agentDir, ".claude", "config.json"))) {
      // copyOnboardingState didn't write (file existed), write default
      writeIfMissing(
        join(agentDir, ".claude", "config.json"),
        () =>
          JSON.stringify(
            { hasCompletedOnboarding: true, numStartups: 1 },
            null,
            2,
          ) + "\n",
        created,
        skipped,
        0o600,
      );
    }
  } else {
    // No existing Claude install — create minimal config
    createMinimalClaudeConfig(agentDir);
  }

  // Pre-trust the agent's workspace directory
  preTrustWorkspace(agentDir);

  // --- Memory index ---
  writeIfMissing(
    join(agentDir, "memory", "MEMORY.md"),
    () => "# Memory Index\n\nThis file is auto-maintained. Do not edit manually.\n",
    created,
    skipped,
  );

  // --- Telegram .env ---
  writeIfMissing(
    join(agentDir, "telegram", ".env"),
    () => {
      if (resolvedBotToken) {
        return `TELEGRAM_BOT_TOKEN=${resolvedBotToken}\n`;
      }
      return `# Set your bot token: TELEGRAM_BOT_TOKEN=your-token-here\n`;
    },
    created,
    skipped,
    0o600,
  );

  // --- Telegram access.json ---
  writeIfMissing(
    join(agentDir, "telegram", "access.json"),
    () => buildAccessJson(agentConfig, telegramConfig, topicId, userId),
    created,
    skipped,
    0o600,
  );

  // --- Copy skill files from template ---
  copyProfileSkills(profilePath, join(agentDir, "skills"));

  // --- Symlink global skills from clerk.skills_dir ---
  //
  // Skills named in `agents.x.skills: [name1, name2]` (merged with
  // defaults.skills) are resolved to <skills_dir>/<name> and symlinked
  // into <agentDir>/skills/<name>. This decouples skill authoring from
  // template authoring — add a skill to the pool once, opt-in per agent.
  if (agentConfig.skills && agentConfig.skills.length > 0) {
    syncGlobalSkills(
      agentDir,
      agentConfig.skills,
      clerkConfig?.clerk?.skills_dir,
    );
  }

  // --- Set up plugin symlinks ---
  setupPlugins(agentDir);

  return { agentDir, created, skipped };
}

/**
 * Result of reconciling an existing agent against the current clerk.yaml.
 */
export interface ReconcileResult {
  agentDir: string;
  changes: string[];
}

/**
 * Re-apply clerk.yaml-derived state to an existing agent without touching
 * user-edited files (CLAUDE.md, SOUL.md, telegram/.env, etc.).
 *
 * Specifically rewrites:
 *   - start.sh (purely template-driven, safe to overwrite)
 *   - .mcp.json (when channels.telegram.plugin is "clerk")
 *   - .claude/settings.json mcpServers
 *   - .claude/settings.json permissions.allow / .deny / defaultMode
 *   - .claude/plugins/hindsight-memory/ (vendored plugin tree)
 *
 * Does NOT touch CLAUDE.md, SOUL.md, telegram/.env, or any user content.
 *
 * This is the operation a non-developer needs after editing clerk.yaml —
 * e.g., adding a new MCP server, enabling memory, changing the tool
 * allowlist. It is the lifecycle gap between `clerk agent create` (which
 * scaffolds once) and a full re-scaffold (which would clobber CLAUDE.md).
 *
 * Throws if the agent directory does not exist.
 */
export interface ReconcileOptions {
  /**
   * If true, also re-render CLAUDE.md from the template.
   * Default false (CLAUDE.md is user-protected). Use this when the
   * template itself has changed and you want to force the new version
   * onto an existing agent — e.g., after a `clerk update` that ships
   * a template fix.
   */
  forceClaudeMd?: boolean;
}

export function reconcileAgent(
  name: string,
  agentConfigRaw: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  clerkConfig: ClerkConfig,
  clerkConfigPath?: string,
  options: ReconcileOptions = {},
): ReconcileResult {
  // Apply the full defaults → profile → agent cascade (same semantics
  // as scaffoldAgent). Every downstream read uses the resolved config.
  const agentConfig = resolveAgentConfig(
    clerkConfig.defaults,
    clerkConfig.profiles,
    agentConfigRaw,
  );

  const agentDir = resolve(agentsDir, name);
  const changes: string[] = [];

  if (!existsSync(agentDir)) {
    throw new Error(
      `Agent directory does not exist: ${agentDir}. Run \`clerk agent create ${name}\` first.`,
    );
  }

  // Compute the desired permissions.allow list from current config
  const tools = agentConfig.tools ?? { allow: [], deny: [] };
  const rawAllow = tools.allow ?? [];
  const hasAllWildcard = rawAllow.includes("all");
  const baseAllow = hasAllWildcard
    ? ALL_BUILTIN_TOOLS
    : rawAllow.filter((t) => t !== "all");
  const memoryBackend = clerkConfig.memory?.backend;
  const hindsightEnabled = memoryBackend === "hindsight";
  const desiredAllow = dedupe([
    ...baseAllow,
    ...(usesClerkTelegramPlugin(agentConfig) ? CLERK_TELEGRAM_MCP_TOOLS : []),
    ...(hindsightEnabled ? HINDSIGHT_MCP_TOOLS : []),
    ...CLERK_MCP_TOOLS,
  ]);
  const desiredDeny = tools.deny ?? [];

  // Resolve telegram + hindsight context for the start.sh template
  const rawBotToken = agentConfig.bot_token ?? telegramConfig.bot_token;
  const resolvedBotToken = resolveBotToken(rawBotToken);
  const hindsightAutoRecallEnabled = hindsightEnabled
    && agentConfig.memory?.auto_recall !== false;
  const hindsightBankId = agentConfig.memory?.collection ?? name;
  const hindsightApiBaseUrl = (clerkConfig.memory?.config?.url as string | undefined)
    ? (clerkConfig.memory!.config!.url as string).replace(/\/mcp\/?$/, "").replace(/\/$/, "")
    : "http://127.0.0.1:8888";

  // --- Reconcile start.sh (purely template-driven, safe to overwrite) ---
  const startShPath = join(agentDir, "start.sh");
  if (existsSync(startShPath)) {
    const basePath = getBaseProfilePath();
    const startShContext: Record<string, unknown> = {
      name,
      agentDir,
      botToken: resolvedBotToken ?? rawBotToken,
      forumChatId: telegramConfig.forum_chat_id,
      dangerousMode: agentConfig.dangerous_mode === true,
      useClerkPlugin: usesClerkTelegramPlugin(agentConfig),
      hindsightEnabled: hindsightAutoRecallEnabled,
      hindsightBankId,
      hindsightApiBaseUrl,
      // Phase 2 + 3 — user env merged with channel-derived env,
      // pre-quoted so shell-sensitive bytes survive.
      userEnvQuoted: (() => {
        const combined = { ...channelsToEnv(agentConfig), ...(agentConfig.env ?? {}) };
        if (Object.keys(combined).length === 0) return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(combined)) {
          out[k] = shellSingleQuote(v);
        }
        return out;
      })(),
      model: agentConfig.model,
      systemPromptAppendShellQuoted: agentConfig.system_prompt_append
        ? shellSingleQuote(agentConfig.system_prompt_append)
        : undefined,
      extraCliArgs: agentConfig.cli_args && agentConfig.cli_args.length > 0
        ? " " + agentConfig.cli_args.map(shellSingleQuote).join(" ")
        : undefined,
    };
    const beforeStartSh = readFileSync(startShPath, "utf-8");
    const afterStartSh = renderTemplate(join(basePath, "start.sh.hbs"), startShContext);
    if (afterStartSh !== beforeStartSh) {
      writeFileSync(startShPath, afterStartSh, "utf-8");
      chmodSync(startShPath, 0o755);
      changes.push(startShPath);
    }
  }

  // --- Force-reconcile CLAUDE.md (only when --force-claude-md given) ---
  // CLAUDE.md is normally user-protected because users hand-edit it for
  // persona/behavior tuning. The --force flag lets `clerk update` push
  // template fixes through (e.g., the {{memory}} → [object Object] bug
  // we shipped earlier). Same context as scaffold's CLAUDE.md render.
  if (options.forceClaudeMd) {
    const profilePath = getProfilePath(agentConfig.extends ?? DEFAULT_PROFILE);
    const claudeMdSrc = join(profilePath, "CLAUDE.md.hbs");
    const claudeMdDest = join(agentDir, "CLAUDE.md");
    if (existsSync(claudeMdSrc) && existsSync(claudeMdDest)) {
      const claudeContext: Record<string, unknown> = {
        name,
        agentDir,
        topicName: agentConfig.topic_name,
        topicEmoji: agentConfig.topic_emoji,
        soul: agentConfig.soul,
        tools: agentConfig.tools ?? { allow: [], deny: [] },
        memory: agentConfig.memory,
        model: agentConfig.model,
        schedule: agentConfig.schedule,
        useClerkPlugin: usesClerkTelegramPlugin(agentConfig),
      };
      const beforeMd = readFileSync(claudeMdDest, "utf-8");
      const afterMd = renderTemplate(claudeMdSrc, claudeContext);
      if (afterMd !== beforeMd) {
        writeFileSync(claudeMdDest, afterMd, "utf-8");
        changes.push(claudeMdDest);
      }
    }
  }

  // --- Reconcile settings.json ---
  const settingsPath = join(agentDir, ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    const before = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(before);

    // Permissions: clerk-managed keys are allow, deny, defaultMode.
    // Preserve any other keys the user may have added under permissions.
    settings.permissions = settings.permissions ?? {};
    settings.permissions.allow = desiredAllow;
    settings.permissions.deny = desiredDeny;
    if (hasAllWildcard) {
      settings.permissions.defaultMode = "acceptEdits";
    } else {
      delete settings.permissions.defaultMode;
    }

    // mcpServers: rebuild from current clerk.yaml. Preserves user-defined
    // mcp_servers from agentConfig.mcp_servers in addition to the built-ins.
    const mcpServers: Record<string, unknown> = {};

    // Hindsight first (so it's the most visible to a reader)
    const hindsightEntry = getHindsightSettingsEntry(name, clerkConfig);
    if (hindsightEntry) {
      mcpServers[hindsightEntry.key] = hindsightEntry.value;
    }

    // Clerk management MCP
    const clerkMcpEntry = getClerkMcpSettingsEntry(clerkConfigPath);
    mcpServers[clerkMcpEntry.key] = clerkMcpEntry.value;

    // User-defined extras from clerk.yaml agents.<name>.mcp_servers
    if (agentConfig.mcp_servers) {
      for (const [key, value] of Object.entries(agentConfig.mcp_servers)) {
        mcpServers[key] = value;
      }
    }

    settings.mcpServers = mcpServers;

    // Hindsight memory plugin: vendored from vectorize-io/hindsight,
    // copied into <agentDir>/.claude/plugins/hindsight-memory/. The
    // plugin's own hooks.json registers SessionStart / UserPromptSubmit /
    // Stop / SessionEnd hooks via Claude Code's plugin loader. Always
    // re-copy on reconcile so plugin updates propagate via
    // `clerk update` → reconcile.
    installHindsightPlugin(name, agentDir, clerkConfig);

    // Disable Claude Code's built-in auto-memory when Hindsight is on.
    // This stops the dueling-instruction problem (see research notes
    // for cli.js bl8() and the autoMemoryEnabled settings key).
    if (hindsightEnabled) {
      settings.autoMemoryEnabled = false;
    } else if (settings.autoMemoryEnabled === false) {
      // Memory backend was disabled — restore the default
      delete settings.autoMemoryEnabled;
    }

    // --- Phase 5: drop non-clerk-owned top-level keys from a prior
    // settings_raw run before rewriting. Reconcile tracks which keys
    // were injected last time via a `_clerkManagedRawKeys` side-car
    // and removes them here so removed clerk.yaml entries don't leave
    // stale drift behind. Keys that are also clerk-owned (permissions,
    // mcpServers, hooks, model, etc) are left alone because the
    // scaffold rebuild below re-derives them from clerk.yaml anyway.
    const META_KEY = "_clerkManagedRawKeys";
    const priorRawKeys = Array.isArray(settings[META_KEY])
      ? (settings[META_KEY] as string[])
      : [];
    for (const k of priorRawKeys) {
      if (!CLERK_OWNED_SETTINGS_KEYS.has(k) && k in settings) {
        delete settings[k];
      }
    }
    delete settings[META_KEY];

    // --- Phase 2: reconcile user hooks (replace, don't merge) ---
    //
    // Fully replace settings.hooks from clerk.yaml each reconcile, so
    // removing a hook event from clerk.yaml also removes it from
    // settings.json. Plugin-installed hooks (hindsight) live in the
    // plugin's own hooks.json and are loaded via --plugin-dir, so
    // they're not affected by this. Clerk-owned.
    const userHooks = translateHooksToClaudeShape(agentConfig.hooks);
    if (userHooks) {
      settings.hooks = userHooks;
    } else {
      delete settings.hooks;
    }
    if (agentConfig.model !== undefined) {
      settings.model = agentConfig.model;
    } else if ("model" in settings) {
      delete settings.model;
    }

    // --- Phase 5: settings_raw escape hatch ---
    //
    // Apply fresh after the scaffold-rebuild of clerk-owned fields.
    // Stamp the new META_KEY so the next reconcile knows which keys
    // to retract if the user removes them from clerk.yaml.
    const mergedSettings = agentConfig.settings_raw
      ? (deepMergeJson(settings, agentConfig.settings_raw) as Record<string, unknown>)
      : settings;
    if (agentConfig.settings_raw && Object.keys(agentConfig.settings_raw).length > 0) {
      mergedSettings[META_KEY] = Object.keys(agentConfig.settings_raw);
    }

    const after = JSON.stringify(mergedSettings, null, 2) + "\n";
    if (after !== before) {
      writeFileSync(settingsPath, after, { encoding: "utf-8", mode: 0o600 });
      changes.push(settingsPath);
    }
  }

  // --- Reconcile global skills pool symlinks ---
  //
  // Mirrors the scaffold syncGlobalSkills call so reconcile picks up
  // added/removed entries in clerk.yaml.
  if (agentConfig.skills) {
    syncGlobalSkills(agentDir, agentConfig.skills, clerkConfig.clerk.skills_dir);
  }

  // --- Reconcile .mcp.json (clerk-telegram plugin agents only) ---
  if (usesClerkTelegramPlugin(agentConfig)) {
    const mcpJsonPath = join(agentDir, ".mcp.json");
    const pluginDir = resolve(import.meta.dirname, "../../telegram-plugin");
    const clerkCliPath = resolveClerkCliPath();
    const resolvedConfigPath = clerkConfigPath
      ? resolve(clerkConfigPath)
      : resolve(process.cwd(), "clerk.yaml");

    const mcpServers: Record<string, McpServerConfig> = {
      "clerk-telegram": {
        command: "bun",
        args: ["run", "--cwd", pluginDir, "--shell=bun", "--silent", "start"],
        env: {
          TELEGRAM_STATE_DIR: join(agentDir, "telegram"),
          CLERK_CONFIG: resolvedConfigPath,
          CLERK_CLI_PATH: clerkCliPath,
        },
      },
    };

    if (hindsightEnabled) {
      const hindsightEntry = getHindsightSettingsEntry(name, clerkConfig);
      if (hindsightEntry) {
        mcpServers[hindsightEntry.key] = hindsightEntry.value;
      }
    }

    const mcpJson = { mcpServers };
    const after = JSON.stringify(mcpJson, null, 2) + "\n";
    const before = existsSync(mcpJsonPath)
      ? readFileSync(mcpJsonPath, "utf-8")
      : "";
    if (after !== before) {
      writeFileSync(mcpJsonPath, after, { encoding: "utf-8", mode: 0o600 });
      changes.push(mcpJsonPath);
    }
  }

  return { agentDir, changes };
}

/**
 * Write a file only if it doesn't already exist.
 * Tracks what was created vs skipped for reporting.
 */
function writeIfMissing(
  filePath: string,
  contentFn: () => string,
  created: string[],
  skipped: string[],
  mode?: number,
): void {
  if (existsSync(filePath)) {
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, contentFn(), mode !== undefined ? { encoding: "utf-8", mode } : "utf-8");
  created.push(filePath);
}

function buildAccessJson(
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
  resolvedTopicId?: number,
  userId?: string,
): string {
  const allowFrom = userId ? [userId] : [];
  if (allowFrom.length === 0) {
    console.warn(
      "  WARNING: No user ID available for access.json allowFrom. " +
      "DM the bot /start and run `clerk setup` again to pair your Telegram account."
    );
  }
  const access: Record<string, unknown> = {
    dmPolicy: "allowlist",
    allowFrom,
    groups: {
      [telegramConfig.forum_chat_id]: {
        requireMention: false,
        allowFrom,
      },
    },
  };
  return JSON.stringify(access, null, 2) + "\n";
}
