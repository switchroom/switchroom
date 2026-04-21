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

/**
 * The agent has TWO systemd units: the agent itself (`switchroom-<name>`),
 * which spawns the Claude CLI on demand, and the long-running telegram
 * gateway (`switchroom-<name>-gateway`) which holds the Telegram connection
 * and IPC server.
 *
 * Changes to `telegram-plugin/*` code only take effect when the gateway
 * unit restarts, because bun loads the source at process start. If the CLI
 * only cycles the agent unit, telegram-plugin code changes silently stay
 * stale on a user's machine for hours or days until something else triggers
 * a gateway restart (crash, reboot, manual intervention).
 *
 * Make start/stop/restart always cycle BOTH units so the user never has to
 * reason about "did the gateway also need a kick." Ordering: stop gateway
 * last (so it can accept the agent's final heartbeat); start gateway first
 * (so the agent has someone to talk to on wake).
 */
function gatewayServiceName(name: string): string {
  return `switchroom-${name}-gateway`;
}

function systemctl(args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Silent-ok wrapper for units that may not exist on this host (e.g. a
 * reconfigured agent with a different plugin set, or a non-telegram agent).
 * We want "always cycle both if they exist" semantics, not "fail the whole
 * restart because one unit is absent."
 *
 * Earlier implementation used `list-unit-files --no-legend <unit>` to gate
 * the action, but the unit-name match required `.service` suffix to appear
 * in the output. Passing `switchroom-clerk-gateway` returned empty and the
 * gated restart silently no-op'd. Observed on Pixsoul 2026-04-21: gateway
 * services never actually restarted via `switchroom agent restart`.
 *
 * Simpler fix: just try the action and swallow failures. systemctl exits
 * non-zero with a clear stderr message for missing units; we catch and
 * continue. Safer for the "always cycle both" intent.
 */
function systemctlIfExists(action: string, unit: string): void {
  try {
    // systemctl accepts both `switchroom-x` and `switchroom-x.service` forms.
    // No explicit existence probe; just fire. Missing unit -> throws -> swallow.
    systemctl([action, unit]);
  } catch {
    // Absent or inactive is fine for start/stop; restart on a non-existent
    // unit is a no-op. We swallow instead of throwing because the caller
    // wants "make the right thing happen" not "diagnose per-unit state."
  }
}

export function startAgent(name: string): void {
  try {
    // Gateway first so the agent has someone to IPC to on wake.
    systemctlIfExists("start", gatewayServiceName(name));
    systemctl(["start", serviceName(name)]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start agent "${name}": ${message}`);
  }
}

export function stopAgent(name: string): void {
  try {
    // Agent first so it can flush handoff via gateway IPC before the gateway dies.
    systemctl(["stop", serviceName(name)]);
    systemctlIfExists("stop", gatewayServiceName(name));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stop agent "${name}": ${message}`);
  }
}

export function restartAgent(name: string): void {
  try {
    // Gateway owns the long-running Telegram connection and loads
    // telegram-plugin code at process start. Restart it alongside the agent
    // so code changes in telegram-plugin/*.ts always propagate on user
    // action, not silently 6 hours later. Gateway first so the fresh gateway
    // is ready when the agent wakes.
    systemctlIfExists("restart", gatewayServiceName(name));
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
    // Gateway socket is in the agent's telegram directory
    // (set via TELEGRAM_STATE_DIR in the gateway service unit)
    const agentsDir = process.env.SWITCHROOM_AGENTS_DIR ?? resolveStatePath("agents");
    const agentDir = resolve(agentsDir, name);
    const socketPath = process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(agentDir, "telegram", "gateway.sock");

    if (!existsSync(socketPath)) {
      reject(new Error("Gateway socket not found. Is the gateway running?"));
      return;
    }

    const client = connect({ path: socketPath });
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
            client.destroy();

            if (response.success) {
              resolve({
                restartedImmediately: response.restartedImmediately ?? false,
                waitingForTurn: response.waitingForTurn ?? false,
              });
            } else {
              reject(new Error(response.error || "Graceful restart failed"));
            }
            return;
          }
        } catch (err) {
          // Ignore JSON parse errors, wait for more data
        }
      }
    });

    client.on("error", (err) => {
      if (!responseReceived) {
        reject(new Error(`Failed to connect to gateway: ${err.message}`));
      }
    });

    client.on("close", () => {
      if (!responseReceived) {
        reject(new Error("Gateway closed connection without responding"));
      }
    });

    // Timeout after 5 seconds
    const timeout = setTimeout(() => {
      if (!responseReceived) {
        responseReceived = true;
        client.destroy();
        reject(new Error("Graceful restart request timed out"));
      }
    }, 5000);

    // Clean up timeout if we get a response
    client.once("data", () => {
      if (timeout) clearTimeout(timeout);
    });
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
