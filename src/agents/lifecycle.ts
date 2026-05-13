import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { connect } from "node:net";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveStatePath } from "../config/paths.js";
import { resolveAgentConfig } from "../config/merge.js";
import { loadConfig } from "../config/loader.js";
import { sendAgentInterrupt } from "./tmux.js";
import { resolveSwitchroomHome } from "./docker-fleet.js";

/**
 * Resolve the per-agent gateway clean-shutdown marker path.
 *
 * Mirrors `GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH` in
 * `telegram-plugin/gateway/gateway.ts` — the gateway runs with
 * `TELEGRAM_STATE_DIR=<agentDir>/telegram` and writes the marker as
 * `clean-shutdown.json` inside that directory. Callers that want to
 * stamp WHY a restart happened (so the next greeting card can show it)
 * write to the same path BEFORE issuing the restart.
 */
export function cleanShutdownMarkerPathForAgent(name: string): string {
  const agentsDir = process.env.SWITCHROOM_AGENTS_DIR ?? resolveStatePath("agents");
  return join(agentsDir, name, "telegram", "clean-shutdown.json");
}

/**
 * Atomically write a clean-shutdown marker for `name` annotated with a
 * human-readable `reason`. Intended for the CLI/watchdog/IPC paths that
 * initiate a restart — they call this BEFORE the restart so the file is
 * on disk by the time the next gateway/agent boots.
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

/**
 * Compose project name. Matches what `bringUpAgentService` uses — we
 * pass the same `-p` and `-f` flags so `docker compose` joins the
 * already-running fleet rather than spawning a parallel project.
 */
const COMPOSE_PROJECT = "switchroom";

/** Container name for an agent (set via `container_name:` in compose.ts). */
function containerName(name: string): string {
  return `switchroom-${name}`;
}

/** Compose service name (the YAML key under `services:`). */
function serviceKey(name: string): string {
  return `agent-${name}`;
}

/**
 * Resolve the compose file path. Allows `SWITCHROOM_COMPOSE_FILE` to
 * override for tests / non-default installs.
 */
function composeFilePath(): string {
  const override = process.env.SWITCHROOM_COMPOSE_FILE;
  if (override && override.length > 0) return override;
  return resolve(resolveSwitchroomHome(), "compose", "docker-compose.yml");
}

/**
 * Run `docker` synchronously, capturing stdout. Throws with stderr
 * included on non-zero exit so callers see honest failure reasons.
 */
function dockerSync(args: string[]): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString().trim() : "";
    const base = e.message ?? String(err);
    throw new Error(stderr ? `${base}: ${stderr}` : base);
  }
}

/**
 * Build a `docker compose -p <project> -f <file>` argv prefix.
 */
function composeArgs(extra: string[]): string[] {
  return ["compose", "-p", COMPOSE_PROJECT, "-f", composeFilePath(), ...extra];
}

/**
 * Returns true if the agent's container exists (running or stopped).
 */
function containerExists(name: string): boolean {
  try {
    const out = dockerSync(["ps", "-a", "--format", "{{.Names}}", "--filter", `name=^${containerName(name)}$`]);
    return out.split("\n").some((l) => l.trim() === containerName(name));
  } catch {
    return false;
  }
}

export function startAgent(name: string): void {
  try {
    // Always `up -d --force-recreate --no-deps`. See restartAgent's
    // comment for the rationale on each flag (#932 / #944). Same logic
    // applies here: an operator running `agent start` after `agent
    // stop` + a yaml edit + `apply` reasonably expects the new env
    // block / mount changes to take effect. `compose start` (no
    // recreate) silently reuses the existing container with its
    // create-time env, which was the operator-reported symptom in
    // #1018. Force-recreate covers both the "first ever boot" case
    // (no existing container, recreate is a no-op cost) and the
    // "stop → edit → start" case — the only cost is a fresh container
    // spin-up (~1-2s), cheap relative to the surprise of stale env.
    dockerSync(composeArgs(["up", "-d", "--force-recreate", "--no-deps", serviceKey(name)]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to start agent "${name}": ${message}`);
  }
}

export function stopAgent(name: string): void {
  try {
    dockerSync(composeArgs(["stop", serviceKey(name)]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stop agent "${name}": ${message}`);
  }
}

export function restartAgent(name: string, reason?: string): void {
  // Stamp WHY before killing so the next agent boot can render it in
  // the greeting card. Best-effort — if the dir is missing we swallow.
  //
  // Issue #1118: ALWAYS write a marker (default reason "cli: restart")
  // even when the caller didn't pass one. Pre-#1118 the seven in-tree
  // callers that called `restartAgent(name)` bare (auth.ts after token
  // rotation, agent.ts reconcile paths, web/api.ts, etc.) left the
  // next boot to read whatever stale marker was on disk from an older
  // /restart — almost always >5 min stale, so the boot-reason
  // classifier fell through to 'crash' and posted a misleading
  // "💥 agent-crashed" card on every legitimate operator action.
  //
  // preserveExisting:true keeps the cooperative-race contract intact:
  // when the gateway /new handler writes "user: /new from chat" then
  // spawns `switchroom agent restart`, the CLI's default "cli: restart"
  // must NOT clobber the still-fresh user attribution (see
  // writeRestartReasonMarker's 30s freshness window).
  writeRestartReasonMarker(name, reason ?? "cli: restart", { preserveExisting: true });
  try {
    // `up -d --force-recreate --no-deps` not `restart` (#932). All
    // three flags are load-bearing — DO NOT strip any without
    // updating the surrounding callers:
    //
    // - `up -d` (vs `restart`): `restart` only stops + starts the
    //   existing container with its EXISTING volume mounts; it does
    //   NOT recreate. So if `apply` regenerated the compose with new
    //   bind-mounts (e.g. #912's skills/credentials mounts), `restart`
    //   leaves the container with the OLD mounts. Same lesson as
    //   #857 / #916 where this got swapped in test code first.
    //
    // - `--force-recreate`: without it, `up -d` no-ops when the
    //   compose entry is byte-identical (the common case after
    //   scaffold-CONTENT changes — settings.json / .mcp.json /
    //   start.sh / SOUL.md / CLAUDE.md — which the agent's bind-
    //   mounted dir holds but the compose entry doesn't reference
    //   per-file). claude reads those at process start, so picking
    //   up edits requires a process bounce. Several callers depend
    //   on this always-bounce semantics: auth.ts (restart after
    //   token write), agent.ts grant/dangerous (restart after
    //   reconcile), restart.ts (the canonical bounce-this-agent
    //   verb). CLAUDE.md ~298 promises "restart is also a mini-
    //   deploy of any scaffold changes" — that contract requires
    //   --force-recreate. Caught by the #944 reviewer; keep this.
    //
    // - `--no-deps`: prevents recreating sibling services (broker /
    //   kernel / other agents) that this restart shouldn't touch.
    dockerSync(composeArgs(["up", "-d", "--force-recreate", "--no-deps", serviceKey(name)]));
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

    const timeout = setTimeout(() => {
      if (!responseReceived) {
        responseReceived = true;
        client.destroy();
        reject(new Error("Graceful restart request timed out"));
      }
    }, 5000);

    client.once("data", () => {
      if (timeout) clearTimeout(timeout);
    });
  });
}

/**
 * Send SIGINT to the agent currently running its turn. Used by the
 * `!`-prefix Telegram interrupt marker and the `switchroom agent
 * interrupt` CLI.
 *
 * Docker mode policy:
 *   - tmux supervisor (default): try `sendAgentInterrupt` (host-side
 *     tmux send-keys via the host-mounted socket if available). If that
 *     fails, fall back to `docker kill --signal=SIGINT <container>`,
 *     which delivers SIGINT to PID 1 inside the container — tini, which
 *     forwards to its child (claude/tmux supervisor).
 *   - legacy_pty: skip tmux send-keys, go straight to `docker kill`.
 */
export function interruptAgent(
  name: string,
  opts: { config?: SwitchroomConfig } = {},
): { pid: number } {
  const status = getAgentStatus(name);
  if (!status.pid) {
    throw new Error(
      `Agent "${name}" has no running PID (status: ${status.active})`
    );
  }

  let useTmuxSendKeys = false;
  try {
    const config = opts.config ?? loadConfig();
    const agentDef = config.agents[name];
    if (agentDef) {
      const resolved = resolveAgentConfig(
        config.defaults,
        config.profiles,
        agentDef,
      );
      useTmuxSendKeys = resolved.experimental?.legacy_pty !== true;
    }
  } catch {
    useTmuxSendKeys = false;
  }

  if (useTmuxSendKeys) {
    const sendResult = sendAgentInterrupt({ agentName: name });
    if ("ok" in sendResult) {
      console.log(
        `[interrupt] ${name}: delivered SIGINT via tmux send-keys C-c`,
      );
      return { pid: status.pid };
    }
    console.error(
      `[interrupt] ${name}: tmux send-keys failed (${sendResult.error}); ` +
        `falling back to docker kill --signal=SIGINT`,
    );
  }

  try {
    dockerSync(["kill", "--signal=SIGINT", containerName(name)]);
    console.log(
      `[interrupt] ${name}: delivered SIGINT via docker kill --signal=SIGINT`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to send SIGINT to agent "${name}": ${message}`
    );
  }
  return { pid: status.pid };
}

/**
 * Parse a `KEY=VALUE` env array (the shape `docker inspect
 * --format '{{json .Config.Env}}'` returns) for SWITCHROOM_AGENT_START_SHA.
 */
export function parseAgentStartShaFromEnv(env: string[]): string | null {
  for (const entry of env) {
    if (!entry.startsWith("SWITCHROOM_AGENT_START_SHA=")) continue;
    const v = entry.slice("SWITCHROOM_AGENT_START_SHA=".length).trim();
    if (v.length > 0) return v;
  }
  return null;
}

/**
 * Read the agent's start SHA from the running container. Resolution order:
 *
 *   1. Container env var SWITCHROOM_AGENT_START_SHA (set in compose.ts at
 *      install time once #850-style wiring lands).
 *   2. Container label `switchroom.commit` (compose-level override).
 *   3. Image label `org.opencontainers.image.revision` (the standard
 *      OCI "what git ref was this image built from" label, set by the
 *      GHCR publish workflow).
 *
 * Returns null if none are present (or the container isn't running).
 * Logs a one-line warning to stderr on the null path so operators can
 * correlate "? in version output" with the missing-label state.
 */
export function getAgentStartSha(name: string): string | null {
  const cn = containerName(name);

  // 1. container env
  try {
    const out = dockerSync([
      "inspect",
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
      cn,
    ]);
    const env = out.split("\n").map((s) => s.trim()).filter(Boolean);
    const fromEnv = parseAgentStartShaFromEnv(env);
    if (fromEnv) return fromEnv;
  } catch {
    // container missing — nothing more to try
    return null;
  }

  // 2. container labels
  try {
    const labelVal = dockerSync([
      "inspect",
      "--format",
      "{{index .Config.Labels \"switchroom.commit\"}}",
      cn,
    ]);
    if (labelVal && labelVal !== "<no value>") return labelVal;
  } catch {
    /* fall through */
  }

  // 3. image label (org.opencontainers.image.revision)
  try {
    const image = dockerSync(["inspect", "--format", "{{.Config.Image}}", cn]);
    if (image) {
      const rev = dockerSync([
        "inspect",
        "--format",
        "{{index .Config.Labels \"org.opencontainers.image.revision\"}}",
        image,
      ]);
      if (rev && rev !== "<no value>") return rev;
    }
  } catch {
    /* fall through */
  }

  process.stderr.write(
    `[switchroom] getAgentStartSha: no SWITCHROOM_AGENT_START_SHA env, ` +
      `no switchroom.commit label, and no org.opencontainers.image.revision ` +
      `label found for container=${cn}; version row will show "?"\n`,
  );
  return null;
}

/**
 * Resolve the agent process PID inside its container.
 *
 * `docker inspect --format '{{.State.Pid}}'` returns the host-namespace
 * PID of the container's PID 1 (tini under our docker image). Good enough
 * for "is the agent up" — we don't try to reach into the container's PID
 * namespace to find the heaviest-RSS claude process. Returns null if the
 * container is missing; returns 0 if the container exists but is stopped.
 */
export function resolveAgentPid(name: string): number {
  try {
    const out = dockerSync([
      "inspect",
      "--format",
      "{{.State.Pid}}",
      containerName(name),
    ]);
    const parsed = parseInt(out, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  } catch {
    return 0;
  }
}

/**
 * Per-agent status row used by `switchroom version` and the web
 * dashboard.
 *
 *   - `active`: docker container State.Status, normalised so
 *     "running" → "active" (preserves the convention downstream
 *     `s.active === "active"` checks rely on). Other statuses pass
 *     through verbatim ("exited", "restarting", "paused", "created",
 *     "dead", "inactive").
 *   - `uptime`: container State.StartedAt (ISO-8601); CLI/web format
 *     into "5m" / "4h" / "2d".
 *   - `memory`: usage from `docker stats --no-stream` (best-effort —
 *     null if stats are unavailable, e.g. container stopped).
 *   - `pid`: container PID 1 in host namespace, via State.Pid.
 */
export function getAgentStatus(name: string): AgentStatus {
  const cn = containerName(name);

  let active = "inactive";
  let uptime: string | null = null;
  let pid: number | null = null;

  try {
    // Bundle the inspect into a single call for speed.
    const out = dockerSync([
      "inspect",
      "--format",
      "{{.State.Status}}|{{.State.StartedAt}}|{{.State.Pid}}",
      cn,
    ]);
    const [status, startedAt, pidStr] = out.split("|");
    if (status) {
      active = status === "running" ? "active" : status;
    }
    if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
      uptime = startedAt;
    }
    if (pidStr) {
      const parsed = parseInt(pidStr, 10);
      if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
    }
  } catch {
    // No container — return inactive shell.
    return { active: "inactive", uptime: null, memory: null, pid: null };
  }

  let memory: string | null = null;
  if (active === "active") {
    try {
      const stats = dockerSync([
        "stats",
        "--no-stream",
        "--format",
        "{{.MemUsage}}",
        cn,
      ]);
      // docker stats prints e.g. "12.34MiB / 4GiB" — take the first token.
      const first = stats.split("/")[0]?.trim();
      if (first) {
        // Normalise "12.34MiB" → "12MB".
        const m = first.match(/([\d.]+)\s*([KMG]i?B)/i);
        if (m) {
          const val = parseFloat(m[1]);
          const unit = m[2].toUpperCase();
          let mb = val;
          if (unit.startsWith("K")) mb = val / 1024;
          else if (unit.startsWith("G")) mb = val * 1024;
          memory = `${Math.round(mb)}MB`;
        } else {
          memory = first;
        }
      }
    } catch {
      // stats unavailable — leave null
    }
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

/**
 * Attach to the agent — under docker this means dropping into the
 * container's tmux session (the supervisor case) or tailing
 * `docker logs -f` (legacy_pty).
 */
export function attachAgent(name: string, tmuxSupervisor = true): void {
  if (tmuxSupervisor) {
    const tmuxSocket = `switchroom-${name}`;
    const result = spawnSync(
      "docker",
      [
        "exec",
        "-it",
        containerName(name),
        "tmux",
        "-L",
        tmuxSocket,
        "attach",
        "-t",
        name,
      ],
      { stdio: "inherit" },
    );
    if (result.error) {
      throw new Error(`Failed to attach to agent "${name}": ${result.error.message}`);
    }
    return;
  }

  const result = spawnSync("docker", ["logs", "-f", containerName(name)], {
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`Failed to tail logs for agent "${name}": ${result.error.message}`);
  }
}

export function getAgentLogs(name: string, follow: boolean): void {
  const args = ["logs"];
  if (follow) args.push("-f");
  args.push(containerName(name));

  const child = spawn("docker", args, { stdio: "inherit" });
  child.on("error", (err) => {
    throw new Error(
      `Failed to get logs for agent "${name}": ${err.message}`
    );
  });
}

/**
 * Coarse classification of a reconcile change-path used by Phase F to
 * decide whether a config edit can be applied without bouncing the
 * agent container.
 *
 * The categories intentionally collapse together:
 *   - "cron"     — `telegram/cron-*.sh` script regeneration. The script
 *                  file lives on the host bind-mount, so a rewrite is
 *                  visible to the in-container agent-scheduler on its
 *                  next fire without any container touch.
 *   - "skill"    — `.claude/skills/` symlinks / payload. Phase C will
 *                  build hot-reload for these; for now they still need
 *                  a restart, but we tag them so #1163's Phase C can
 *                  upgrade the decision in one place.
 *   - "settings" — `.claude/settings.json`, `.mcp.json` — claude-code
 *                  reads these at process start; restart-required.
 *   - "hooks"    — `.claude/hooks/*` — same lifecycle as settings.
 *   - "infra"    — `start.sh`, compose-adjacent files; restart-required.
 *   - "other"    — anything we can't pattern-match; conservatively
 *                  treated as restart-required by the caller.
 */
export type ChangeKind = "cron" | "skill" | "settings" | "hooks" | "infra" | "other";

export function classifyChangeKind(path: string): ChangeKind {
  // Use substring matches so callers don't have to pass paths relative
  // to agentDir — scaffold.ts pushes absolute paths into `changes`.
  if (/\/telegram\/cron-\d+\.sh$/.test(path)) return "cron";
  if (path.includes("/.claude/skills/")) return "skill";
  if (path.endsWith("/.claude/settings.json")) return "settings";
  if (path.endsWith("/.mcp.json")) return "settings";
  if (path.includes("/.claude/hooks/")) return "hooks";
  if (path.endsWith("/start.sh")) return "infra";
  return "other";
}

export interface ApplyCronChangesHotResult {
  /** Cron script paths that were rewritten by reconcileAgent. */
  cronScripts: string[];
  /**
   * If a host-side agent-scheduler IPC reload channel becomes available
   * (per the Phase F design plan in switchroom#1163), this will flip
   * true once that signal is delivered. Today it's always false — the
   * host has no scheduler-reload socket; the scheduler lives inside the
   * container and reads its schedule at boot. Cron-script CONTENT edits
   * are picked up on the next fire (bind-mount + exec). Cron-EXPRESSION
   * edits in switchroom.yaml require the next natural container restart
   * to be observed, which is the documented trade for not killing the
   * running session on every prompt tweak.
   */
  ipcSignalled: boolean;
}

/**
 * Apply cron-only reconcile changes without restarting the agent
 * container. `reconcileAgent` has already rewritten the per-task
 * `telegram/cron-<i>.sh` scripts on the host bind-mount, so the
 * in-container scheduler sees the new content on its next fire.
 *
 * This helper exists as a named seam so:
 *   1. Phase F's decision in `reconcileAndRestartAgent` has a single
 *      symbol to call instead of duplicating the "do nothing destructive"
 *      branch inline, and
 *   2. A future host→scheduler IPC reload (for cron-expression edits)
 *      can plug in here without touching the caller.
 *
 * Returns the set of cron scripts we observed in `changes` so the
 * caller can log a precise summary line.
 */
export function applyCronChangesHot(
  name: string,
  changes: string[],
): ApplyCronChangesHotResult {
  const cronScripts = changes.filter((p) => classifyChangeKind(p) === "cron");
  // No host-side cron systemd units exist in this codebase — scheduling
  // is internal to the agent container (see src/agent-scheduler/). The
  // bind-mount carrying the agent dir makes the rewritten scripts live
  // immediately. Intentionally no docker / systemctl call here: that's
  // the whole point of the hot-cron-reload path. `name` is accepted for
  // symmetry with restartAgent / future IPC plumbing.
  void name;
  return { cronScripts, ipcSignalled: false };
}
