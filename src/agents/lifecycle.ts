import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { connect } from "node:net";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveStatePath } from "../config/paths.js";

/**
 * Resolve the per-agent gateway clean-shutdown marker path.
 *
 * Mirrors `GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH` in
 * `telegram-plugin/gateway/gateway.ts` — the gateway runs with
 * `TELEGRAM_STATE_DIR=<agentDir>/telegram` and writes the marker as
 * `clean-shutdown.json` inside that directory. Callers that want to
 * stamp WHY a restart happened (so the next greeting card can show it)
 * write to the same path BEFORE issuing systemctl restart.
 */
export function cleanShutdownMarkerPathForAgent(name: string): string {
  const agentsDir = process.env.SWITCHROOM_AGENTS_DIR ?? resolveStatePath("agents");
  return join(agentsDir, name, "telegram", "clean-shutdown.json");
}

/**
 * Atomically write a clean-shutdown marker for `name` annotated with a
 * human-readable `reason`. Intended for the CLI/watchdog/IPC paths that
 * initiate a restart — they call this BEFORE the systemctl restart so
 * the file is on disk by the time the next gateway/agent boots.
 *
 * Best-effort: if the directory doesn't exist or the write fails, we
 * swallow. The restart still proceeds; the next greeting will just omit
 * the Restarted row (the same as a cold start).
 */
export function writeRestartReasonMarker(
  name: string,
  reason: string,
  opts: { preserveExisting?: boolean } = {},
): void {
  const path = cleanShutdownMarkerPathForAgent(name);
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    // Cooperative race guard. The gateway's user-/restart path writes a
    // marker with reason="user: /restart from chat" BEFORE spawning the
    // detached `switchroom agent restart --force` CLI. When that CLI
    // then tries to write its own `cli: restart` marker, we'd blow away
    // the user attribution. `preserveExisting: true` means: if a marker
    // already exists on disk that's younger than a few seconds, leave it.
    if (opts.preserveExisting && existsSync(path)) {
      try {
        const prev = JSON.parse(readFileSync(path, "utf-8")) as {
          ts?: number;
          reason?: string;
        };
        if (prev && typeof prev.ts === "number" && Date.now() - prev.ts < 30_000 && prev.reason) {
          return;
        }
      } catch {
        /* fall through and overwrite */
      }
    }
    const marker = { ts: Date.now(), signal: "SIGTERM", reason };
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(marker), "utf-8");
    renameSync(tmp, path);
  } catch {
    /* best effort — restart proceeds even if we can't stamp the reason */
  }
}

/**
 * Build a deploy-aware "cli: …" reason for `switchroom agent restart`.
 *
 *   - When the running build's commit (BUILD_COMMIT) differs from the
 *     repo's current HEAD, the user is restarting to ship new code →
 *     `cli: deploying <sha-short> <subject>`.
 *   - Otherwise (or when commit info is unavailable) → `cli: restart`.
 *
 * The commit lookup is best-effort: if we can't read git, we degrade to
 * the plain reason rather than crash the restart path.
 */
export function buildCliRestartReason(opts: {
  buildCommit: string | null;
  cwd?: string;
}): string {
  const { buildCommit, cwd } = opts;
  if (!buildCommit) return "cli: restart";
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const headShort = head.slice(0, 7);
    const buildShort = buildCommit.slice(0, 7);
    if (headShort === buildShort) return "cli: restart";
    let subject = "";
    try {
      subject = execFileSync(
        "git",
        ["log", "-1", "--pretty=%s", head],
        {
          cwd: cwd ?? process.cwd(),
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      /* subject is optional */
    }
    // Trim aggressively: the greeting card row gets long fast.
    if (subject.length > 60) subject = `${subject.slice(0, 57)}…`;
    return subject ? `cli: deploying ${headShort} ${subject}` : `cli: deploying ${headShort}`;
  } catch {
    return "cli: restart";
  }
}

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

export function restartAgent(name: string, reason?: string): void {
  // Stamp WHY before killing so the next agent boot can render it in the
  // greeting card. cleanShutdownMarkerPathForAgent matches the gateway's
  // own path resolution; writeRestartReasonMarker is a best-effort no-op
  // if the dir is missing.
  if (reason) writeRestartReasonMarker(name, reason);
  try {
    // ORDERING (#177): agent first, gateway second.
    //
    // When this function runs inside a child spawned from the gateway
    // (e.g. /new from Telegram → spawnSwitchroomDetached → here), the
    // child can be in the gateway's cgroup. If we restart the gateway
    // FIRST (the previous order) and the cgroup escape (systemd-run
    // --scope wrapper) is missing or fails, the child gets cgroup-
    // killed mid-flight before reaching the second `systemctl` call,
    // and the agent service is never actually restarted — the user
    // says "/new" and sees the gateway bounce but their session
    // doesn't actually rotate.
    //
    // With the agent service restarted first, even a worst-case
    // cgroup kill on the second call still leaves the user's session
    // rotated. Gateway restart is purely about picking up
    // telegram-plugin code changes; missing it is annoying but not
    // user-visible the way "session didn't rotate" is.
    systemctl(["restart", serviceName(name)]);
    systemctlIfExists("restart", gatewayServiceName(name));
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
  return new Promise((resolvePromise, reject) => {
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
              resolvePromise({
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

/**
 * Parse the SWITCHROOM_AGENT_START_SHA value out of `systemctl show
 * --property=Environment` output. Exported so tests can exercise the parser
 * directly without shelling out to systemctl.
 *
 * Returns null when no Environment= line carries the key.
 */
export function parseAgentStartShaFromSystemctl(output: string): string | null {
  // The output looks like:
  //   Environment=VAR1=val1 VAR2=val2 SWITCHROOM_AGENT_START_SHA=abc1234 TZ=UTC
  // Each word may itself contain = so we need to split carefully.
  for (const line of output.split("\n")) {
    if (!line.startsWith("Environment=")) continue;
    const envBlock = line.slice("Environment=".length);
    // Split on whitespace boundaries between KEY= tokens. \S+ is safe here
    // because the value is always a hex git SHA (no whitespace, no quotes) —
    // generateUnit emits it literally without quoting. If the value format
    // ever changes to embed spaces, this regex must change to handle
    // systemd's quoted-value syntax.
    const match = envBlock.match(/(?:^|\s)SWITCHROOM_AGENT_START_SHA=(\S+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Read the SWITCHROOM_AGENT_START_SHA from the running unit's environment.
 *
 * systemd stores the unit's baked-in Environment= lines and can return them
 * via `systemctl --user show --property=Environment`.
 *
 * Returns null if the unit isn't running, the env var isn't set (pre-#66
 * units), or parsing fails.
 */
export function getAgentStartSha(name: string): string | null {
  const service = serviceName(name);
  try {
    const output = systemctl(["show", service, "--property=Environment"]);
    return parseAgentStartShaFromSystemctl(output);
  } catch {
    return null;
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
