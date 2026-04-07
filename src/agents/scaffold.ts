import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentConfig, TelegramConfig } from "../config/schema.js";
import {
  getTemplatePath,
  getBaseTemplatePath,
  renderTemplate,
  copySkills,
} from "./templates.js";

export interface ScaffoldResult {
  agentDir: string;
  created: string[];
  skipped: string[];
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
): ScaffoldResult {
  const agentDir = resolve(agentsDir, name);
  const created: string[] = [];
  const skipped: string[] = [];

  const templatePath = getTemplatePath(agentConfig.template);
  const basePath = getBaseTemplatePath();

  // Build the template rendering context
  const context: Record<string, unknown> = {
    name,
    agentDir,
    topicId: agentConfig.topic_id,
    topicName: agentConfig.topic_name,
    topicEmoji: agentConfig.topic_emoji,
    soul: agentConfig.soul,
    tools: agentConfig.tools ?? { allow: [], deny: [] },
    memory: agentConfig.memory,
    model: agentConfig.model,
    mcpServers: agentConfig.mcp_servers,
    schedule: agentConfig.schedule,
    botToken: telegramConfig.bot_token,
    forumChatId: telegramConfig.forum_chat_id,
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
  );

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
    () => `TELEGRAM_BOT_TOKEN=${telegramConfig.bot_token}\n`,
    created,
    skipped,
  );

  // --- Telegram access.json ---
  writeIfMissing(
    join(agentDir, "telegram", "access.json"),
    () => buildAccessJson(agentConfig, telegramConfig),
    created,
    skipped,
  );

  // --- Copy skill files from template ---
  copySkills(templatePath, join(agentDir, "skills"));

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
): void {
  if (existsSync(filePath)) {
    skipped.push(filePath);
    return;
  }
  writeFileSync(filePath, contentFn(), "utf-8");
  created.push(filePath);
}

function buildAccessJson(
  agentConfig: AgentConfig,
  telegramConfig: TelegramConfig,
): string {
  const access: Record<string, unknown> = {
    forum_chat_id: telegramConfig.forum_chat_id,
  };
  if (agentConfig.topic_id !== undefined) {
    access.topic_id = agentConfig.topic_id;
  }
  return JSON.stringify(access, null, 2) + "\n";
}
