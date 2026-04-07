import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { ClerkConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";

export interface AuthStatus {
  authenticated: boolean;
  subscriptionType?: string;
  expiresAt?: number;
  timeUntilExpiry?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export function formatTimeUntilExpiry(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "expired";

  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function getAuthStatus(name: string, agentDir: string): AuthStatus {
  const credPath = resolve(agentDir, ".claude", ".credentials.json");

  if (!existsSync(credPath)) {
    return { authenticated: false };
  }

  let creds: CredentialsFile;
  try {
    creds = JSON.parse(readFileSync(credPath, "utf-8"));
  } catch {
    return { authenticated: false };
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    return { authenticated: false };
  }

  const expiresAt = oauth.expiresAt;
  const isExpired = expiresAt != null && expiresAt <= Date.now();

  return {
    authenticated: !isExpired,
    subscriptionType: oauth.subscriptionType,
    expiresAt: oauth.expiresAt,
    timeUntilExpiry: expiresAt != null ? formatTimeUntilExpiry(expiresAt) : undefined,
    rateLimitTier: oauth.rateLimitTier,
  };
}

export function getAllAuthStatuses(
  config: ClerkConfig
): Record<string, AuthStatus> {
  const agentsDir = resolveAgentsDir(config);
  const statuses: Record<string, AuthStatus> = {};

  for (const name of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, name);
    statuses[name] = getAuthStatus(name, agentDir);
  }

  return statuses;
}

export function loginAgent(
  name: string,
  agentDir: string
): { success: boolean } {
  const claudeConfigDir = resolve(agentDir, ".claude");

  const result = spawnSync("claude", ["auth", "login"], {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
  });

  return { success: result.status === 0 };
}

export function loginAllAgents(
  config: ClerkConfig
): Record<string, { success: boolean }> {
  const agentsDir = resolveAgentsDir(config);
  const results: Record<string, { success: boolean }> = {};

  for (const name of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, name);
    results[name] = loginAgent(name, agentDir);
  }

  return results;
}

export function refreshAgent(
  name: string,
  agentDir: string
): { success: boolean } {
  // Re-login is the simplest way to force a token refresh
  return loginAgent(name, agentDir);
}
