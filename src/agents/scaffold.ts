import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentConfig, ClerkConfig, TelegramConfig } from "../config/schema.js";
import {
  getTemplatePath,
  getBaseTemplatePath,
  renderTemplate,
  copySkills,
} from "./templates.js";
import { getHindsightSettingsEntry, getClerkMcpSettingsEntry } from "../memory/scaffold-integration.js";
import { loadTopicState } from "../telegram/state.js";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";

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
 * Scaffold (or reconcile) the directory structure for a single agent.
 *
 * Idempotent: creates missing files and directories but never overwrites
 * existing ones.
 */
export function scaffoldAgent(
  name: string,
  agentConfig: AgentConfig,
  agentsDir: string,
  telegramConfig: TelegramConfig,
  clerkConfig?: ClerkConfig,
): ScaffoldResult {
  const agentDir = resolve(agentsDir, name);
  const created: string[] = [];
  const skipped: string[] = [];

  const templatePath = getTemplatePath(agentConfig.template);
  const basePath = getBaseTemplatePath();

  // Resolve topic ID: config takes priority, then topics.json state file
  let topicId = agentConfig.topic_id;
  if (topicId === undefined) {
    try {
      const topicState = loadTopicState();
      topicId = topicState.topics?.[name]?.topic_id;
    } catch { /* no state file yet */ }
  }

  // Resolve bot token from vault or env
  const resolvedBotToken = resolveBotToken(telegramConfig.bot_token);

  // Build the template rendering context
  const context: Record<string, unknown> = {
    name,
    agentDir,
    topicId,
    topicName: agentConfig.topic_name,
    topicEmoji: agentConfig.topic_emoji,
    soul: agentConfig.soul,
    tools: agentConfig.tools ?? { allow: [], deny: [] },
    memory: agentConfig.memory,
    model: agentConfig.model,
    mcpServers: agentConfig.mcp_servers,
    schedule: agentConfig.schedule,
    botToken: resolvedBotToken ?? telegramConfig.bot_token,
    forumChatId: telegramConfig.forum_chat_id,
    dangerousMode: agentConfig.dangerous_mode === true,
    skipPermissionPrompt: agentConfig.skip_permission_prompt === true,
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

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
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
    () => buildAccessJson(agentConfig, telegramConfig, topicId),
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
): string {
  const access: Record<string, unknown> = {
    forum_chat_id: telegramConfig.forum_chat_id,
  };
  if (resolvedTopicId !== undefined) {
    access.topic_id = resolvedTopicId;
  }
  return JSON.stringify(access, null, 2) + "\n";
}
