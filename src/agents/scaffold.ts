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
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { AgentConfig, ClerkConfig, TelegramConfig } from "../config/schema.js";
import { DEFAULT_TEMPLATE } from "../config/schema.js";
import {
  mergeAgentConfig,
  translateHooksToClaudeShape,
  usesClerkTelegramPlugin,
} from "../config/merge.js";
import {
  getTemplatePath,
  getBaseTemplatePath,
  renderTemplate,
  copySkills,
} from "./templates.js";
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
 * When use_clerk_plugin is enabled we pre-approve these so the agent
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
  // Apply global defaults → per-agent cascade. When clerk.yaml has no
  // `defaults:` block, the result is identical to agentConfigRaw, so
  // existing behavior is preserved. See src/config/merge.ts.
  const agentConfig = mergeAgentConfig(clerkConfig?.defaults, agentConfigRaw);

  const agentDir = resolve(agentsDir, name);
  const created: string[] = [];
  const skipped: string[] = [];

  const templatePath = getTemplatePath(agentConfig.template ?? DEFAULT_TEMPLATE);
  const basePath = getBaseTemplatePath();

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
  //   - If use_clerk_plugin is enabled, pre-approve the clerk-telegram
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
    // entries win on conflict (explicit beats channel default).
    userEnv: (() => {
      const combined = { ...channelsToEnv(agentConfig), ...(agentConfig.env ?? {}) };
      return Object.keys(combined).length > 0 ? combined : undefined;
    })(),
    systemPromptAppendShellQuoted: agentConfig.system_prompt_append
      ? shellSingleQuote(agentConfig.system_prompt_append)
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

      // Clean up the legacy hooks.UserPromptSubmit shell hook entry from
      // any prior scaffolds. The plugin owns this hook now.
      if (settings.hooks?.UserPromptSubmit) {
        const filtered = (settings.hooks.UserPromptSubmit as Array<{
          hooks?: Array<{ command?: string }>
        }>).filter((group) =>
          !(group.hooks ?? []).some((h) => (h.command ?? "").includes("auto-recall.sh"))
        );
        if (filtered.length === 0) {
          delete settings.hooks.UserPromptSubmit;
          if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        } else {
          settings.hooks.UserPromptSubmit = filtered;
        }
      }

      // --- Phase 2: user-declared hooks and model ---
      //
      // Hooks from clerk.yaml (merged with defaults) are translated from
      // clerk's flat shape to Claude Code's nested shape and merged into
      // settings.hooks. Plugin-installed hooks (hindsight) live in the
      // plugin's own hooks.json and are loaded via --plugin-dir, so they
      // don't collide with settings.hooks — Claude Code merges them at
      // runtime.
      const userHooks = translateHooksToClaudeShape(agentConfig.hooks);
      if (userHooks) {
        settings.hooks = { ...(settings.hooks ?? {}), ...userHooks };
      }
      // Explicit model override: written to settings.model so the user
      // doesn't have to pass --model on every invocation.
      if (agentConfig.model !== undefined) {
        settings.model = agentConfig.model;
      }

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    }
  }

  // --- Write project-level .mcp.json for clerk-telegram development channel ---
  //
  // When use_clerk_plugin is enabled, Claude Code's
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
    const srcPath = join(templatePath, src);
    if (existsSync(srcPath)) {
      writeIfMissing(
        join(agentDir, dest),
        () => renderTemplate(srcPath, context),
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
  copySkills(templatePath, join(agentDir, "skills"));

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
 *   - .mcp.json (when use_clerk_plugin is true)
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
  // Apply global defaults → per-agent cascade (same semantics as
  // scaffoldAgent). Every downstream read uses the merged config.
  const agentConfig = mergeAgentConfig(clerkConfig.defaults, agentConfigRaw);

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
    const basePath = getBaseTemplatePath();
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
      // Phase 2 + 3 — user env merged with channel-derived env.
      userEnv: (() => {
        const combined = { ...channelsToEnv(agentConfig), ...(agentConfig.env ?? {}) };
        return Object.keys(combined).length > 0 ? combined : undefined;
      })(),
      model: agentConfig.model,
      systemPromptAppendShellQuoted: agentConfig.system_prompt_append
        ? shellSingleQuote(agentConfig.system_prompt_append)
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
    const templatePath = getTemplatePath(agentConfig.template ?? DEFAULT_TEMPLATE);
    const claudeMdSrc = join(templatePath, "CLAUDE.md.hbs");
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

    // Clean up any leftover legacy shell hook entries from prior
    // scaffolds. The vendored plugin owns UserPromptSubmit now.
    if (settings.hooks?.UserPromptSubmit) {
      const filtered = (settings.hooks.UserPromptSubmit as Array<{
        hooks?: Array<{ command?: string }>
      }>).filter((group) =>
        !(group.hooks ?? []).some((h) => (h.command ?? "").includes("auto-recall.sh"))
      );
      if (filtered.length === 0) {
        delete settings.hooks.UserPromptSubmit;
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      } else {
        settings.hooks.UserPromptSubmit = filtered;
      }
    }

    // --- Phase 2: reconcile user hooks and model ---
    //
    // Reconcile treats clerk.yaml as source of truth for user hooks:
    // the merged `agentConfig.hooks` value fully replaces any previously
    // written user hooks under the events it mentions. Events not in
    // the merged config are left untouched (e.g. the legacy cleanup
    // above). Clerk-owned keys (UserPromptSubmit auto-recall) are
    // already filtered before this runs.
    const userHooks = translateHooksToClaudeShape(agentConfig.hooks);
    if (userHooks) {
      settings.hooks = { ...(settings.hooks ?? {}), ...userHooks };
    } else if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    if (agentConfig.model !== undefined) {
      settings.model = agentConfig.model;
    } else if ("model" in settings) {
      delete settings.model;
    }

    const after = JSON.stringify(settings, null, 2) + "\n";
    if (after !== before) {
      writeFileSync(settingsPath, after, { encoding: "utf-8", mode: 0o600 });
      changes.push(settingsPath);
    }
  }

  // --- Reconcile .mcp.json (use_clerk_plugin agents only) ---
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
