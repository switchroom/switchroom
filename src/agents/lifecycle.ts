import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { connect } from "node:net";
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

/**
 * Schedule a graceful restart via the gateway IPC. If the agent is idle,
 * restart immediately. If a turn is in flight, wait for completion then restart.
 */
export function gracefulRestartAgent(name: string): Promise<{ restartedImmediately: boolean; waitingForTurn: boolean }> {
  return new Promise((resolve, reject) => {
    const stateDir = process.env.SWITCHROOM_STATE_DIR ?? resolveStatePath("");
    const socketPath = join(stateDir, "gateway.sock");

    if (!existsSync(socketPath)) {
      reject(new Error("Gateway socket not found. Is the gateway running?"));
      return;
    }

    const client = connect(socketPath);
    let buffer = "";
    let responseReceived = false;

    client.on("connect", () => {
      const msg = {
        type: "schedule_restart",
        agentName: name,
      };
      client.write(JSON.stringify(msg) + "\n");
    });

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.type === "schedule_restart_result") {
            responseReceived = true;
            client.end();

            if (response.success) {
              resolve({
                restartedImmediately: response.restartedImmediately ?? false,
                waitingForTurn: response.waitingForTurn ?? false,
              });
            } else {
              reject(new Error(response.error || "Graceful restart failed"));
            }
          }
        } catch (err) {
          // Ignore JSON parse errors, wait for more data
        }
      }
    });

    client.on("error", (err) => {
      reject(new Error(`Failed to connect to gateway: ${err.message}`));
    });

    client.on("close", () => {
      if (!responseReceived) {
        reject(new Error("Gateway closed connection without responding"));
      }
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      if (!responseReceived) {
        client.end();
        reject(new Error("Graceful restart request timed out"));
      }
    }, 5000);
  });
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

export function interruptAgent(name: string): { pid: number } {
  const status = getAgentStatus(name);
  if (!status.pid) {
    throw new Error(
      `Agent "${name}" has no running PID (status: ${status.active})`
    );
  }
  try {
    systemctl(["kill", "--signal=INT", serviceName(name)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to send SIGINT to agent "${name}": ${message}`
    );
  }
  return { pid: status.pid };
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
