import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * Search for an existing .claude.json (onboarding state) from the user's
 * personal Claude installation. Returns the path if found, null otherwise.
 */
export function findExistingClaudeJson(): string | null {
  const home = process.env.HOME ?? "/root";

  const candidates = [
    resolve(home, ".claude-home", ".claude.json"),
    resolve(home, ".claude", ".claude.json"),
    resolve(home, ".claude-home", "config.json"),
    resolve(home, ".claude", "config.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Copy onboarding state (.claude.json or config.json) to the agent's
 * CLAUDE_CONFIG_DIR so it skips the onboarding wizard.
 */
export function copyOnboardingState(
  sourcePath: string,
  agentDir: string,
): void {
  const claudeDir = join(agentDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const destPath = join(claudeDir, "config.json");
  if (!existsSync(destPath)) {
    copyFileSync(sourcePath, destPath);
  }
}

/**
 * Build an access.json for an agent's telegram directory.
 * Includes the forum_chat_id, optional topic_id, allowed user IDs,
 * and DM chat allowFrom.
 */
export function buildAccessJson(
  userId: string,
  forumChatId: string,
  topicId?: number,
): string {
  const access: Record<string, unknown> = {
    forum_chat_id: forumChatId,
    allowed_users: [parseInt(userId, 10)],
    allowFrom: [
      parseInt(forumChatId, 10),
      parseInt(userId, 10),
    ],
  };

  if (topicId !== undefined) {
    access.topic_id = topicId;
  }

  return JSON.stringify(access, null, 2) + "\n";
}

/**
 * Try to copy .credentials.json from an existing Claude installation
 * to the agent's CLAUDE_CONFIG_DIR.
 */
export function copyExistingCredentials(agentDir: string): boolean {
  const home = process.env.HOME ?? "/root";
  const claudeDir = join(agentDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const candidates = [
    resolve(home, ".claude-home", ".credentials.json"),
    resolve(home, ".claude", ".credentials.json"),
  ];

  const destPath = join(claudeDir, ".credentials.json");
  if (existsSync(destPath)) {
    return true; // Already has credentials
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        copyFileSync(candidate, destPath);
        return true;
      } catch {
        // Continue trying other candidates
      }
    }
  }

  return false;
}

/**
 * Write the access.json file for an agent.
 */
export function writeAccessJson(
  agentDir: string,
  userId: string,
  forumChatId: string,
  topicId?: number,
): void {
  const telegramDir = join(agentDir, "telegram");
  mkdirSync(telegramDir, { recursive: true });

  const accessPath = join(telegramDir, "access.json");
  writeFileSync(accessPath, buildAccessJson(userId, forumChatId, topicId), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Write the .env file with the bot token for an agent.
 */
export function writeAgentEnv(agentDir: string, botToken: string): void {
  const telegramDir = join(agentDir, "telegram");
  mkdirSync(telegramDir, { recursive: true });

  const envPath = join(telegramDir, ".env");
  writeFileSync(envPath, `TELEGRAM_BOT_TOKEN=${botToken}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}
