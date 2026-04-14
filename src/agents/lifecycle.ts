import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveStatePath } from "../config/paths.js";

export interface AgentStatus {
  active: string;
  uptime: string | null;
  memory: string | null;
  pid: number | null;
}

function serviceName(name: string): string {
  return `switchroom-${name}`;
}

function systemctl(args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function startAgent(name: string): void {
  try {
    systemctl(["start", serviceName(name)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start agent "${name}": ${message}`);
  }
}

export function stopAgent(name: string): void {
  try {
    systemctl(["stop", serviceName(name)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stop agent "${name}": ${message}`);
  }
}

export function restartAgent(name: string): void {
  try {
    systemctl(["restart", serviceName(name)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to restart agent "${name}": ${message}`);
  }
}

export function enableAgent(name: string): void {
  try {
    systemctl(["enable", serviceName(name)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to enable agent "${name}": ${message}`);
  }
}

export function disableAgent(name: string): void {
  try {
    systemctl(["disable", serviceName(name)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to disable agent "${name}": ${message}`);
  }
}

export function getAgentStatus(name: string): AgentStatus {
  const service = serviceName(name);

  let active = "unknown";
  try {
    active = systemctl(["is-active", service]);
  } catch {
    active = "inactive";
  }

  let uptime: string | null = null;
  let memory: string | null = null;
  let pid: number | null = null;

  try {
    const output = systemctl(
      ["show", service, "--property=ActiveEnterTimestamp,MemoryCurrent,MainPID"]
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
  config: SwitchroomConfig
): Record<string, AgentStatus> {
  const statuses: Record<string, AgentStatus> = {};
  for (const agentName of Object.keys(config.agents)) {
    statuses[agentName] = getAgentStatus(agentName);
  }
  return statuses;
}

export function attachAgent(name: string): void {
  const agentsDir = process.env.SWITCHROOM_AGENTS_DIR ?? resolveStatePath("agents");
  const logFile = resolve(agentsDir, name, "service.log");

  if (!existsSync(logFile)) {
    throw new Error(
      `No service log found for agent "${name}" at ${logFile}. Is the agent running?`
    );
  }

  // Tail the service log interactively
  const result = spawnSync("tail", ["-f", logFile], {
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`Failed to tail logs for agent "${name}": ${result.error.message}`);
  }
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
