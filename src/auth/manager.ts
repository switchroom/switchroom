import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";

// TODO: Fetch subscriptionType / rateLimitTier from Anthropic's profile/me
// endpoint after OAuth token exchange. When users run `switchroom auth` manually
// (instead of `claude auth login`), the resulting .credentials.json is
// missing subscriptionType and rateLimitTier — Claude Code normally
// populates these by calling Anthropic's profile/me endpoint after the
// token exchange. We should replicate that call and write the real values
// into the credentials file. Do NOT hardcode "max" — use whatever the API
// returns. Until this is implemented, users running switchroom auth manually
// may need to add these fields to .credentials.json by hand.

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
    timeUntilExpiry:
      expiresAt != null ? formatTimeUntilExpiry(expiresAt) : undefined,
    rateLimitTier: oauth.rateLimitTier,
  };
}

export function getAllAuthStatuses(
  config: SwitchroomConfig,
): Record<string, AuthStatus> {
  const agentsDir = resolveAgentsDir(config);
  const statuses: Record<string, AuthStatus> = {};

  for (const name of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, name);
    statuses[name] = getAuthStatus(name, agentDir);
  }

  return statuses;
}

/**
 * Display instructions for completing Claude Code onboarding for an agent.
 *
 * Claude Code handles its own OAuth during onboarding. The flow is:
 * 1. Start the agent: switchroom agent start <name>
 * 2. Attach to the session: switchroom agent attach <name>
 * 3. Complete Claude Code onboarding (theme, login, trust)
 * 4. Detach from tmux (Ctrl+B, D)
 * 5. The agent is now running and authenticated
 */
export function loginAgent(
  name: string,
  agentDir: string,
): { instructions: string[] } {
  const status = getAuthStatus(name, agentDir);

  if (status.authenticated) {
    return {
      instructions: [
        `Agent "${name}" is already authenticated.`,
        `  Subscription: ${status.subscriptionType ?? "unknown"}`,
        `  Expires in: ${status.timeUntilExpiry ?? "unknown"}`,
      ],
    };
  }

  return {
    instructions: [
      `To authenticate agent "${name}", complete Claude Code's onboarding:`,
      ``,
      `  1. Start the agent:    switchroom agent start ${name}`,
      `  2. Attach to session:  switchroom agent attach ${name}`,
      `  3. Complete onboarding (select theme, log in, trust project)`,
      `  4. Detach from tmux:   Ctrl+B, then D`,
      ``,
      `The agent will be authenticated and running after onboarding.`,
      `Claude Code manages its own OAuth tokens automatically.`,
    ],
  };
}

export function refreshAgent(
  name: string,
  agentDir: string,
): { instructions: string[] } {
  return {
    instructions: [
      `To refresh auth for agent "${name}", attach and re-authenticate:`,
      ``,
      `  1. switchroom agent attach ${name}`,
      `  2. Run /login or restart the session`,
      `  3. Detach: Ctrl+B, then D`,
    ],
  };
}
