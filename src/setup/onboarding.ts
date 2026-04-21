import { existsSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveStatePath } from "../config/paths.js";

/**
 * Search for an existing .claude.json (onboarding state) from the user's
 * personal Claude installation. Returns the path if found, null otherwise.
 * Prints clear instructions if no config is found.
 */
export function findExistingClaudeJson(): string | null {
  const home = process.env.HOME ?? "/root";

  // Modern Claude Code (2.x) writes onboarding state to ~/.claude.json
  // directly — the `~/.claude/` directory holds credentials and projects
  // but not the onboarding config. Earlier candidates (~/.claude-home/,
  // ~/.claude/.claude.json) are kept for users upgrading from older
  // layouts or using CLAUDE_HOME overrides. Ordered modern-first so the
  // canonical path wins when multiple exist.
  const candidates = [
    resolve(home, ".claude.json"),
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

  console.warn(
    "WARNING: No existing Claude Code config found (~/.claude/ or ~/.claude-home/)."
  );
  console.warn(
    "  Claude Code has not been set up on this machine yet."
  );
  console.warn(
    "  Run `claude` in a terminal first to complete initial setup, then run `switchroom setup` again."
  );
  console.warn(
    "  Alternatively, agents can be onboarded individually via `switchroom agent attach <name>`."
  );

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

  // Claude Code reads onboarding state from .claude.json (with leading dot)
  // inside the CLAUDE_CONFIG_DIR
  const destPath = join(claudeDir, ".claude.json");
  if (!existsSync(destPath)) {
    copyFileSync(sourcePath, destPath);
  }
}

/**
 * Build an access.json for an agent's telegram directory.
 * Uses the official Telegram plugin format with dmPolicy, allowFrom,
 * and groups sections.
 */
export function buildAccessJson(
  userId: string,
  forumChatId: string,
  topicId?: number,
): string {
  const access: Record<string, unknown> = {
    dmPolicy: "allowlist",
    allowFrom: [userId],
    groups: {
      [forumChatId]: {
        requireMention: false,
        allowFrom: [],
      },
    },
  };

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

// ─── User Config Persistence ────────────────────────────────────────────────

export interface UserConfig {
  userId?: string;
  username?: string;
}

function userConfigPath(): string {
  return resolveStatePath("user.json");
}

/**
 * Save the user's Telegram ID and optional username to ~/.switchroom/user.json.
 */
export function saveUserConfig(userId: string, username?: string): void {
  const configPath = userConfigPath();
  const dir = join(configPath, "..");
  mkdirSync(dir, { recursive: true });

  const config: UserConfig = { userId };
  if (username) {
    config.username = username;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Load the user config from ~/.switchroom/user.json.
 * Returns the config object or null if the file doesn't exist or is invalid.
 */
export function loadUserConfig(): UserConfig | null {
  const configPath = userConfigPath();

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as UserConfig;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Pre-trust Workspace ────────────────────────────────────────────────────

/**
 * Add the agent's working directory to the projects map in .claude.json
 * with hasTrustDialogAccepted: true, so the agent doesn't prompt for trust.
 */
export function preTrustWorkspace(agentDir: string): void {
  const configPath = join(agentDir, ".claude", ".claude.json");

  if (!existsSync(configPath)) {
    return;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (!config.projects) {
      config.projects = {};
    }

    const absDir = resolve(agentDir);
    if (!config.projects[absDir]) {
      config.projects[absDir] = {
        hasTrustDialogAccepted: true,
        allowedTools: [],
      };
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // If we can't read/parse the config, skip silently
  }
}

/**
 * Create a minimal .claude config.json when no existing Claude installation
 * is available. The agent will need to complete onboarding via `switchroom agent attach`.
 */
export function createMinimalClaudeConfig(agentDir: string): void {
  const claudeDir = join(agentDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const configPath = join(claudeDir, ".claude.json");
  if (!existsSync(configPath)) {
    const minimal = {
      hasCompletedOnboarding: false,
      numStartups: 0,
    };
    writeFileSync(configPath, JSON.stringify(minimal, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    console.warn(
      `  WARNING: Created minimal config for ${agentDir}. Complete onboarding via \`switchroom agent attach\`.`
    );
  }
}
