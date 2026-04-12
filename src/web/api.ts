import { execFileSync } from "node:child_process";
import type { ClerkConfig } from "../config/schema.js";
import {
  getAllAgentStatuses,
  startAgent,
  stopAgent,
  restartAgent,
} from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getCollectionForAgent } from "../memory/hindsight.js";

export interface AgentInfo {
  name: string;
  active: string;
  uptime: string | null;
  memory: string | null;
  template: string;
  topic_name: string;
  topic_emoji?: string;
  auth: {
    authenticated: boolean;
    subscriptionType?: string;
    timeUntilExpiry?: string;
    expiresAt?: number;
  };
  memoryCollection: string;
}

export function handleGetAgents(config: ClerkConfig): AgentInfo[] {
  const statuses = getAllAgentStatuses(config);
  const authStatuses = getAllAuthStatuses(config);
  const agents: AgentInfo[] = [];

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const status = statuses[name];
    const auth = authStatuses[name];
    const collection = getCollectionForAgent(name, config);

    agents.push({
      name,
      active: status?.active ?? "unknown",
      uptime: status?.uptime ?? null,
      memory: status?.memory ?? null,
      template: agentConfig.template ?? "default",
      topic_name: agentConfig.topic_name,
      topic_emoji: agentConfig.topic_emoji,
      auth: {
        authenticated: auth?.authenticated ?? false,
        subscriptionType: auth?.subscriptionType,
        timeUntilExpiry: auth?.timeUntilExpiry,
        expiresAt: auth?.expiresAt,
      },
      memoryCollection: collection,
    });
  }

  return agents;
}

export function handleStartAgent(name: string): { ok: boolean; error?: string } {
  try {
    startAgent(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleStopAgent(name: string): { ok: boolean; error?: string } {
  try {
    stopAgent(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleRestartAgent(name: string): { ok: boolean; error?: string } {
  try {
    restartAgent(name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleGetLogs(
  name: string,
  lines: number = 50
): { ok: boolean; logs?: string; error?: string } {
  try {
    const output = execFileSync(
      "journalctl",
      ["--user", "-u", `clerk-${name}`, "--no-pager", "-n", String(lines)],
      { encoding: "utf-8", timeout: 5000 }
    );
    return { ok: true, logs: output };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
