/**
 * `switchroom m365-mcp-launcher` — RFC #1873 PR 3.
 *
 * Hidden CLI verb spawned by Claude Code (per the `.mcp.json` entry
 * emitted by `resolveMs365McpEntry`). Runs inside the agent container
 * as the agent's UID. Acquires a fresh Microsoft access token from
 * the auth-broker, then execs `softeria/ms-365-mcp-server` (BYOT mode)
 * with `MS365_MCP_OAUTH_TOKEN` in env. Acts as a stdio bridge so
 * Claude Code's MCP client talks to softeria transparently.
 *
 * **Refresh design** — combines the "launcher + sidecar" RFC §5.3
 * pattern into a single process. The launcher itself runs a refresh
 * timer that fires ~5min before token expiry, mints a fresh AT via
 * the broker, kills the softeria child, and respawns it with the new
 * env. Claude Code's MCP client sees a brief stdio disconnect and
 * reconnects on the next tool call. Equivalent to a separate sidecar
 * but simpler to reason about (single PID per agent, no IPC between
 * launcher and refresher).
 *
 * **Why not workspace-mcp-style `--single-user --refresh-token-mode`**:
 * softeria does not implement that mode. RFC §5.3 documents the
 * fork-or-contribute v1.5 path; until then, the launcher carries the
 * refresh loop.
 *
 * **Why combine launcher + refresher**: the RFC drafted a two-process
 * design but on implementation the cleaner shape is one process —
 * fewer PIDs to monitor, simpler stdio bridging, doctor probe just
 * needs to verify the launcher's last-refresh timestamp instead of
 * checking two PIDs. The functional contract is identical.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";

import {
  MICROSOFT_WORKSPACE_MCP_PACKAGE,
  MICROSOFT_WORKSPACE_MCP_PINNED_VERSION,
} from "../memory/scaffold-integration.js";

/**
 * The env var softeria reads at startup to receive a pre-acquired
 * access token (BYOT mode). Confirmed via PR 1 validation pass
 * against softeria's README.
 */
export const SOFTERIA_TOKEN_ENV = "MS365_MCP_OAUTH_TOKEN";

/**
 * Default refresh lead time — minutes before expiry to mint a fresh
 * token + restart softeria. Microsoft tokens are 60min lifetime;
 * 5min lead gives a 55min refresh cadence with safety margin.
 */
export const DEFAULT_REFRESH_LEAD_MS = 5 * 60 * 1000;

/**
 * Hard cap on refresh-loop interval — if the broker returns an unusual
 * expiry (e.g. 24h), we still tick at most this often to keep operator
 * visibility into refresh health. Also caps the upper bound for setTimeout
 * (Node's max is ~24.8 days, so this is well within range).
 */
export const MAX_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1h

export interface LauncherOptions {
  /** Whether to pass `--org-mode` to softeria (Teams/SharePoint). */
  orgMode?: boolean;
}

export interface LauncherRuntime {
  /** Injectable broker call — tests pass a stub. */
  fetchCreds: () => Promise<{
    accessToken: string;
    expiresAt: number;
  }>;
  /** Injectable spawn — tests pass a fake. */
  spawnSofteria: (env: NodeJS.ProcessEnv) => ChildProcess;
  /** Injectable timer — tests can advance synthetically. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Injectable now() — tests can pin time. */
  now?: () => number;
  /** Where to write log lines. Defaults to process.stderr. */
  log?: (msg: string) => void;
}

/**
 * Build the softeria spawn arguments. `npx -y` so the package is
 * fetched if missing, version-pinned so we don't drift mid-deploy.
 */
export function buildSofteriaArgs(opts: LauncherOptions = {}): string[] {
  const pkg = `${MICROSOFT_WORKSPACE_MCP_PACKAGE}@${MICROSOFT_WORKSPACE_MCP_PINNED_VERSION}`;
  const args = ["-y", pkg];
  if (opts.orgMode) args.push("--org-mode");
  return args;
}

/**
 * Build the env passed to softeria. Inherits the parent's env minus
 * any prior MS365_MCP_OAUTH_TOKEN (so test runs don't leak), then
 * overrides with the freshly-acquired access token.
 */
export function buildSofteriaEnv(
  accessToken: string,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  env[SOFTERIA_TOKEN_ENV] = accessToken;
  return env;
}

/**
 * Compute the delay until the next refresh tick, in ms. Returns 0 if
 * we're already past the lead-time threshold (refresh immediately).
 * Capped at `MAX_REFRESH_INTERVAL_MS` to ensure tick visibility on
 * unusual expiry values.
 */
export function computeRefreshDelayMs(
  expiresAt: number,
  now: number,
  leadMs: number = DEFAULT_REFRESH_LEAD_MS,
): number {
  const remaining = expiresAt - now - leadMs;
  if (remaining <= 0) return 0;
  return Math.min(remaining, MAX_REFRESH_INTERVAL_MS);
}

/**
 * Write a heartbeat file recording the last successful refresh +
 * planned next refresh time. PR 5's doctor probe reads this to verify
 * the launcher is alive and refreshing on schedule.
 */
export function writeRefreshHeartbeat(
  agentName: string,
  data: { lastRefreshMs: number; nextRefreshMs: number; expiresAtMs: number },
): void {
  const path = heartbeatPath(agentName);
  try {
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o644 });
  } catch {
    // Heartbeat is observability-only; never fail the launcher because
    // we couldn't write it.
  }
}

export function heartbeatPath(agentName: string): string {
  return join(tmpdir(), `m365-launcher-${agentName}.heartbeat.json`);
}

/**
 * Wire stdio between this process (the launcher) and the softeria
 * child. Parent stdin → child stdin, child stdout → parent stdout,
 * child stderr → parent stderr. Cleaned up before spawning a fresh
 * child on refresh.
 *
 * Returns a teardown function the caller invokes before respawning.
 */
function wireStdio(child: ChildProcess): () => void {
  // Parent → child
  const onParentStdin = (chunk: Buffer) => {
    try {
      child.stdin?.write(chunk);
    } catch {
      /* child may be exiting; ignore */
    }
  };
  process.stdin.on("data", onParentStdin);

  // Child → parent
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });

  return () => {
    process.stdin.off("data", onParentStdin);
    try {
      child.stdout?.unpipe(process.stdout);
      child.stderr?.unpipe(process.stderr);
    } catch {
      /* ignore */
    }
  };
}

/**
 * Kill the softeria child with a graceful escalation: SIGTERM, wait
 * up to gracefulMs, then SIGKILL. Resolves once the child is dead.
 */
async function killChild(
  child: ChildProcess,
  gracefulMs: number = 3000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  return new Promise<void>((resolve) => {
    const onExit = () => resolve();
    child.once("exit", onExit);
    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
      return;
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, gracefulMs);
  });
}

/**
 * Main launcher loop. Spawns softeria with initial creds, then runs
 * the refresh timer indefinitely. Exits when softeria exits (other
 * than during a controlled refresh) or when the parent receives a
 * termination signal.
 *
 * Factored out for testability — accepts injectable runtime hooks
 * (broker call, spawn, timer, now). The CLI `action` callback wires
 * the real implementations.
 */
export async function runMs365McpLauncher(
  opts: LauncherOptions,
  rt: LauncherRuntime,
): Promise<number> {
  const setTimer = rt.setTimer ?? setTimeout;
  const clearTimer = rt.clearTimer ?? clearTimeout;
  const now = rt.now ?? Date.now;
  const log = rt.log ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const agentName = process.env.SWITCHROOM_AGENT_NAME ?? "unknown";

  let currentChild: ChildProcess | null = null;
  let teardownStdio: (() => void) | null = null;
  let refreshTimer: NodeJS.Timeout | null = null;
  let exitCode: number | null = null;
  let restartingForRefresh = false;

  const launchChild = (accessToken: string): ChildProcess => {
    const env = buildSofteriaEnv(accessToken);
    const child = rt.spawnSofteria(env);
    teardownStdio = wireStdio(child);
    child.once("exit", (code, signal) => {
      if (teardownStdio) {
        teardownStdio();
        teardownStdio = null;
      }
      if (restartingForRefresh) {
        // Expected — refresh tick killed the child to swap creds.
        return;
      }
      // Unexpected child exit — propagate up to claude.
      const resolved = code ?? (signal ? 128 : 0);
      log(`m365-launcher: softeria exited unexpectedly code=${resolved} signal=${signal}`);
      exitCode = resolved;
      if (refreshTimer) clearTimer(refreshTimer);
    });
    return child;
  };

  const scheduleRefresh = (expiresAtMs: number) => {
    const delayMs = computeRefreshDelayMs(expiresAtMs, now());
    const nextRefreshMs = now() + delayMs;
    writeRefreshHeartbeat(agentName, {
      lastRefreshMs: now(),
      nextRefreshMs,
      expiresAtMs,
    });
    log(
      `m365-launcher: scheduled refresh in ${Math.round(delayMs / 1000)}s (token expires at ${new Date(expiresAtMs).toISOString()})`,
    );
    refreshTimer = setTimer(async () => {
      try {
        log("m365-launcher: refreshing token + restarting softeria");
        restartingForRefresh = true;
        const fresh = await rt.fetchCreds();
        if (currentChild) {
          await killChild(currentChild);
        }
        restartingForRefresh = false;
        currentChild = launchChild(fresh.accessToken);
        scheduleRefresh(fresh.expiresAt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`m365-launcher: refresh failed — ${msg}`);
        // Don't tear down softeria — the existing token may still have
        // some validity. Try again in 30s.
        refreshTimer = setTimer(() => {
          // Re-trigger by re-scheduling with a fake "expires soon"
          scheduleRefresh(now() + 60_000);
        }, 30_000);
      }
    }, delayMs);
  };

  // Initial creds + spawn
  let initial: { accessToken: string; expiresAt: number };
  try {
    initial = await rt.fetchCreds();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`m365-launcher: initial broker call failed — ${msg}`);
    return 1;
  }
  currentChild = launchChild(initial.accessToken);
  scheduleRefresh(initial.expiresAt);

  // Parent signal forwarding
  const onSignal = (signal: NodeJS.Signals) => {
    log(`m365-launcher: received ${signal}, shutting down`);
    if (refreshTimer) clearTimer(refreshTimer);
    if (currentChild) {
      try {
        currentChild.kill(signal);
      } catch {
        /* ignore */
      }
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Wait for the launcher to be told to exit (either softeria died or
  // a signal was received).
  return new Promise<number>((resolve) => {
    const tick = () => {
      if (exitCode !== null) {
        resolve(exitCode);
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

/**
 * CLI registration. Hidden verb — not user-facing. Spawned by Claude
 * Code via the `.mcp.json` entry emitted by `resolveMs365McpEntry`.
 */
export function registerM365McpLauncherCommand(program: Command): void {
  program
    .command("m365-mcp-launcher", { hidden: true })
    .option(
      "--org-mode",
      "Pass --org-mode to softeria (Teams/SharePoint tools).",
      false,
    )
    .description(
      "Internal — Microsoft 365 MCP launcher. Acquires a fresh access token from the auth-broker and execs softeria/ms-365-mcp-server in BYOT mode, restarting it ~55min before token expiry. RFC #1873 PR 3.",
    )
    .action(async (opts: { orgMode?: boolean }) => {
      const { brokerCall } = await import("./broker-call.js");

      const code = await runMs365McpLauncher(opts, {
        fetchCreds: async () => {
          return await brokerCall(async (client) => {
            const data = await client.getCredentials("microsoft");
            const mc = (data.credentials as {
              microsoftOauth?: { accessToken?: string; expiresAt?: number };
            }) ?? {};
            const accessToken = mc.microsoftOauth?.accessToken;
            const expiresAt = mc.microsoftOauth?.expiresAt;
            if (!accessToken || typeof expiresAt !== "number") {
              throw new Error(
                "auth-broker returned credentials without microsoftOauth.accessToken or .expiresAt",
              );
            }
            return { accessToken, expiresAt };
          });
        },
        spawnSofteria: (env) => {
          // softeria is published to npm — `npx -y` fetches if missing,
          // pinned version means deterministic spawn. Pipe stdio so we
          // can manually wire it.
          return spawn("npx", buildSofteriaArgs(opts), {
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
        },
      });
      process.exit(code);
    });
}
