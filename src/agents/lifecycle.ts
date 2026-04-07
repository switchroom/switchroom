import { execSync, spawn } from "node:child_process";
import type { ClerkConfig } from "../config/schema.js";

export interface AgentStatus {
  active: string;
  uptime: string | null;
  memory: string | null;
  pid: number | null;
}

function serviceName(name: string): string {
  return `clerk-${name}`;
}

function systemctl(args: string): string {
  return execSync(`systemctl --user ${args}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function startAgent(name: string): void {
  try {
    systemctl(`start ${serviceName(name)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start agent "${name}": ${message}`);
  }
}

export function stopAgent(name: string): void {
  try {
    systemctl(`stop ${serviceName(name)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stop agent "${name}": ${message}`);
  }
}

export function restartAgent(name: string): void {
  try {
    systemctl(`restart ${serviceName(name)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to restart agent "${name}": ${message}`);
  }
}

export function enableAgent(name: string): void {
  try {
    systemctl(`enable ${serviceName(name)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to enable agent "${name}": ${message}`);
  }
}

export function disableAgent(name: string): void {
  try {
    systemctl(`disable ${serviceName(name)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to disable agent "${name}": ${message}`);
  }
}

export function getAgentStatus(name: string): AgentStatus {
  const service = serviceName(name);

  let active = "unknown";
  try {
    active = systemctl(`is-active ${service}`);
  } catch {
    active = "inactive";
  }

  let uptime: string | null = null;
  let memory: string | null = null;
  let pid: number | null = null;

  try {
    const output = systemctl(
      `show ${service} --property=ActiveEnterTimestamp,MemoryCurrent,MainPID`
    );

    for (const line of output.split("\n")) {
      const [key, ...rest] = line.split("=");
      const value = rest.join("=").trim();

      switch (key?.trim()) {
        case "ActiveEnterTimestamp":
          uptime = value || null;
          break;
        case "MemoryCurrent":
          if (value && value !== "[not set]") {
            const bytes = parseInt(value, 10);
            if (!isNaN(bytes)) {
              memory = `${Math.round(bytes / 1024 / 1024)}MB`;
            }
          }
          break;
        case "MainPID":
          if (value && value !== "0") {
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed > 0) {
              pid = parsed;
            }
          }
          break;
      }
    }
  } catch {
    // Status details unavailable — return what we have
  }

  return { active, uptime, memory, pid };
}

export function getAllAgentStatuses(
  config: ClerkConfig
): Record<string, AgentStatus> {
  const statuses: Record<string, AgentStatus> = {};
  for (const agentName of Object.keys(config.agents)) {
    statuses[agentName] = getAgentStatus(agentName);
  }
  return statuses;
}

export function attachAgent(name: string): void {
  const session = `clerk-${name}`;
  const child = spawn("tmux", ["attach", "-t", session], {
    stdio: "inherit",
  });

  child.on("error", (err) => {
    throw new Error(
      `Failed to attach to agent "${name}" (tmux session ${session}): ${err.message}`
    );
  });
}

export function getAgentLogs(name: string, follow: boolean): void {
  const service = serviceName(name);
  const args = ["--user", "-u", service];
  if (follow) {
    args.push("-f");
  }

  const child = spawn("journalctl", args, {
    stdio: "inherit",
  });

  child.on("error", (err) => {
    throw new Error(
      `Failed to get logs for agent "${name}": ${err.message}`
    );
  });
}
