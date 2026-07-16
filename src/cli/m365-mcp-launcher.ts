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
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";

import {
  MICROSOFT_WORKSPACE_MCP_PACKAGE,
  MICROSOFT_WORKSPACE_MCP_PINNED_VERSION,
} from "../memory/scaffold-integration.js";
import { microsoftAccountSlug } from "../config/microsoft-workspace-acl.js";

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

/**
 * Crash-loop backoff (issue #2586). When softeria exits unexpectedly the
 * launcher used to propagate the exit and die, which made Claude Code respawn
 * the whole MCP server — and each respawn issued a fresh `get-credentials`
 * broker call. A crash-looping softeria therefore produced a tight
 * `get-credentials` retry-storm (14.7k fetches/7d, ~96% of all cred fetches).
 *
 * Instead, while the cached access token is still valid the launcher now
 * re-spawns softeria in-process with the SAME token — no broker call — using
 * exponential backoff between attempts. Only when the token has expired (a
 * genuine refresh is due) or the restart budget is exhausted does the launcher
 * exit and defer to Claude Code / the operator.
 */
export const SOFTERIA_RESTART_BASE_MS = 1000; // first backoff
export const SOFTERIA_RESTART_MAX_MS = 30 * 1000; // backoff ceiling
/**
 * If softeria stays up at least this long, the crash-loop counter resets — a
 * one-off death after a healthy run shouldn't inherit prior backoff.
 */
export const SOFTERIA_STABLE_MS = 60 * 1000;
/**
 * Max consecutive rapid restarts before the launcher gives up and exits (so a
 * genuinely broken softeria doesn't spin forever with no operator signal).
 */
export const SOFTERIA_MAX_RESTARTS = 6;

/**
 * Exponential backoff for the Nth consecutive crash-loop restart (0-indexed),
 * capped at `SOFTERIA_RESTART_MAX_MS`. Exported for tests.
 */
export function computeRestartBackoffMs(attempt: number): number {
  const raw = SOFTERIA_RESTART_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(raw, SOFTERIA_RESTART_MAX_MS);
}

export interface LauncherOptions {
  /** Whether to pass `--org-mode` to softeria (Teams/SharePoint). */
  orgMode?: boolean;
  /**
   * The Microsoft account this launcher instance serves (multi-account
   * form). Threaded to the broker as `getCredentials("microsoft", account)`
   * and used to key the per-account heartbeat file. Omitted → single-
   * account back-compat (broker derives the account from config).
   */
  account?: string;
  /**
   * Per-account tool allowlist regex → softeria `--enabled-tools`. Already
   * joined (e.g. `list-mail-messages|get-mail-message`). Omitted = all tools.
   */
  enabledTools?: string;
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
  if (opts.enabledTools && opts.enabledTools.length > 0) {
    args.push("--enabled-tools", opts.enabledTools);
  }
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
  account?: string,
): void {
  const path = heartbeatPath(agentName, account);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o644 });
  } catch {
    // Heartbeat is observability-only; never fail the launcher because
    // we couldn't write it.
  }
}

/**
 * Heartbeat path — in-container at `/state/agent/m365-launcher.heartbeat.json`.
 *
 * **Critical**: PR 5's doctor probe runs ON THE HOST (`switchroom doctor`).
 * `/state/agent/` is bind-mounted to `~/.switchroom/agents/<name>/`
 * by compose.ts, so the host can read this file directly without
 * `docker exec` — parallel to how `scheduler.jsonl` surfaces. Path
 * deliberately NOT `/tmp` (container-local tmpfs, invisible to host
 * doctor).
 *
 * Test override: if `SWITCHROOM_M365_HEARTBEAT_DIR` is set, write
 * there instead. Lets tests use a per-test tmpdir without poking
 * `/state/agent/`.
 *
 * **Per-account (multi-account form):** when `account` is set, the file
 * is keyed by the account slug so N launchers don't clobber each other:
 * `m365-launcher-<slug>.heartbeat.json`. Single-account launchers (no
 * `account`) keep the bare path for back-compat. The doctor probe globs
 * `m365-launcher*.heartbeat.json` to read all of them.
 */
export function heartbeatPath(agentName: string, account?: string): string {
  const slug = account ? microsoftAccountSlug(account) : undefined;
  const override = process.env.SWITCHROOM_M365_HEARTBEAT_DIR;
  if (override) {
    const base = slug
      ? `m365-launcher-${agentName}-${slug}`
      : `m365-launcher-${agentName}`;
    return join(override, `${base}.heartbeat.json`);
  }
  return slug
    ? `/state/agent/m365-launcher-${slug}.heartbeat.json`
    : "/state/agent/m365-launcher.heartbeat.json";
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
    let killTimer: NodeJS.Timeout | null = null;
    const onExit = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      resolve();
    };
    child.once("exit", onExit);
    try {
      child.kill("SIGTERM");
    } catch {
      resolve();
      return;
    }
    killTimer = setTimeout(() => {
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
  let restartTimer: NodeJS.Timeout | null = null;
  let restartingForRefresh = false;
  let shuttingDown = false;
  let resolveLauncher: ((code: number) => void) | null = null;
  // Cached access token + expiry, updated on every successful fetch. Lets the
  // crash-loop backoff re-spawn softeria WITHOUT a fresh broker call (#2586).
  let currentCreds: { accessToken: string; expiresAt: number } | null = null;
  let restartAttempts = 0;
  let lastSpawnMs = 0;

  const exitLauncher = (code: number): void => {
    shuttingDown = true;
    if (refreshTimer) {
      clearTimer(refreshTimer);
      refreshTimer = null;
    }
    if (restartTimer) {
      clearTimer(restartTimer);
      restartTimer = null;
    }
    if (resolveLauncher) {
      const r = resolveLauncher;
      resolveLauncher = null;
      r(code);
    }
  };

  const launchChild = (accessToken: string): ChildProcess => {
    const env = buildSofteriaEnv(accessToken);
    const child = rt.spawnSofteria(env);
    lastSpawnMs = now();
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
      const resolved = code ?? (signal ? 128 : 0);

      // Crash-loop backoff (#2586). A *crash* (non-zero exit / signal) while the
      // cached token is still valid means softeria fell over for reasons
      // unrelated to auth — re-spawn it in-process with the SAME token rather
      // than exiting, so Claude Code doesn't respawn the launcher and issue a
      // fresh get-credentials broker call on every crash. A clean exit (code 0)
      // is an intentional shutdown and is propagated as before.
      // If we're already tearing down (SIGTERM/SIGINT or exitLauncher), never
      // start a fresh softeria — the launcher is on its way out. Relying on
      // event-loop ordering for this was fragile; the flag is authoritative.
      if (shuttingDown) return;

      const crashed = resolved !== 0;
      const tokenValid = currentCreds != null && currentCreds.expiresAt > now();
      if (crashed && tokenValid) {
        // Reset the counter if softeria stayed up long enough to be "stable".
        if (now() - lastSpawnMs >= SOFTERIA_STABLE_MS) restartAttempts = 0;

        if (restartAttempts < SOFTERIA_MAX_RESTARTS) {
          const delayMs = computeRestartBackoffMs(restartAttempts);
          restartAttempts += 1;
          // Null out the dead child BEFORE scheduling the backoff re-spawn.
          // Otherwise a refresh tick that fires during the backoff window would
          // call killChild(dead-child) (a no-op) and then spawn its own fresh
          // child — and when restartTimer later fires it would spawn a SECOND
          // child, orphaning the first with its exit handler still wired →
          // multiplying parallel softeria processes (worse than the storm this
          // fixes). See PR #2997 review. The refresh callback also clears any
          // pending restartTimer as belt-and-suspenders.
          currentChild = null;
          log(
            `m365-launcher: softeria exited (code=${resolved} signal=${signal}); re-spawning with cached token in ${Math.round(delayMs / 1000)}s (attempt ${restartAttempts}/${SOFTERIA_MAX_RESTARTS}, no broker call)`,
          );
          restartTimer = setTimer(() => {
            restartTimer = null;
            if (shuttingDown) return;
            if (currentCreds != null && currentCreds.expiresAt > now()) {
              currentChild = launchChild(currentCreds.accessToken);
            } else {
              // Token expired during backoff — defer to the refresh path /
              // Claude Code respawn for fresh creds.
              log("m365-launcher: cached token expired during backoff — exiting for fresh creds");
              exitLauncher(resolved);
            }
          }, delayMs);
          return;
        }
        log(
          `m365-launcher: softeria crash-looped ${restartAttempts}x within ${Math.round(SOFTERIA_STABLE_MS / 1000)}s — giving up, exiting`,
        );
        exitLauncher(resolved);
        return;
      }

      // Token expired (a refresh is genuinely due) — propagate up to claude so
      // it respawns the launcher and pulls fresh credentials.
      log(`m365-launcher: softeria exited unexpectedly code=${resolved} signal=${signal}`);
      exitLauncher(resolved);
    });
    return child;
  };

  const scheduleRefresh = (expiresAtMs: number) => {
    const delayMs = computeRefreshDelayMs(expiresAtMs, now());
    const nextRefreshMs = now() + delayMs;
    writeRefreshHeartbeat(
      agentName,
      {
        lastRefreshMs: now(),
        nextRefreshMs,
        expiresAtMs,
      },
      opts.account,
    );
    log(
      `m365-launcher: scheduled refresh in ${Math.round(delayMs / 1000)}s (token expires at ${new Date(expiresAtMs).toISOString()})`,
    );
    refreshTimer = setTimer(async () => {
      try {
        log("m365-launcher: refreshing token + restarting softeria");
        // Cancel any pending crash-loop backoff re-spawn. The refresh path is
        // about to kill + respawn softeria with fresh creds; if a backoff timer
        // fired afterwards it would spawn a SECOND child, orphaning this one.
        // See PR #2997 review (double-spawn / process fan-out).
        if (restartTimer) {
          clearTimer(restartTimer);
          restartTimer = null;
        }
        // Order matters: set the flag BEFORE awaiting fetchCreds. If
        // we awaited first and the child happened to die during the
        // await, the exit handler would treat it as unexpected and
        // propagate a non-zero exit — wrong for a controlled refresh.
        restartingForRefresh = true;
        // Pause incoming stdin so bytes intended for the current
        // softeria child don't EPIPE into a closing stdin during the
        // SIGTERM→SIGKILL grace window. Resumed after wireStdio
        // attaches to the new child below.
        try {
          process.stdin.pause();
        } catch {
          /* ignore */
        }
        const fresh = await rt.fetchCreds();
        if (currentChild) {
          await killChild(currentChild);
        }
        restartingForRefresh = false;
        currentCreds = fresh;
        restartAttempts = 0;
        currentChild = launchChild(fresh.accessToken);
        try {
          process.stdin.resume();
        } catch {
          /* ignore */
        }
        scheduleRefresh(fresh.expiresAt);
      } catch (err) {
        // CRITICAL: reset the flag FIRST. If fetchCreds threw, the
        // existing child is still alive — if it later exits on its
        // own (network drop, OOM, etc.) the exit handler must
        // propagate that as an unexpected exit, not silently swallow
        // it as "expected refresh". Bug found by PR 3 R1 reviewer.
        restartingForRefresh = false;
        try {
          process.stdin.resume();
        } catch {
          /* ignore */
        }
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
  currentCreds = initial;
  currentChild = launchChild(initial.accessToken);
  scheduleRefresh(initial.expiresAt);

  // Parent signal forwarding — kill child + resolve immediately.
  const onSignal = (signal: NodeJS.Signals) => {
    log(`m365-launcher: received ${signal}, shutting down`);
    if (currentChild) {
      try {
        currentChild.kill(signal);
      } catch {
        /* ignore */
      }
    }
    // Resolve with conventional signal exit code (128 + sig#); 143 for
    // SIGTERM, 130 for SIGINT.
    const sigCode = signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 0;
    exitLauncher(sigCode);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Wait for the launcher to be told to exit. Resolved by either:
  //   - child exit handler (unexpected softeria death)
  //   - SIGINT/SIGTERM handler
  return new Promise<number>((resolve) => {
    resolveLauncher = resolve;
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
    .option(
      "--account <email>",
      "Microsoft account this launcher serves (multi-account form). Fetches THAT account's token from the broker and keys a per-account heartbeat. Omitted → single-account back-compat.",
    )
    .option(
      "--enabled-tools <pattern>",
      "Per-account tool allowlist regex forwarded to softeria --enabled-tools (tokens joined with |). Omitted = all tools.",
    )
    .description(
      "Internal — Microsoft 365 MCP launcher. Acquires a fresh access token from the auth-broker and execs softeria/ms-365-mcp-server in BYOT mode, restarting it ~55min before token expiry. RFC #1873 PR 3.",
    )
    .action(async (opts: { orgMode?: boolean; account?: string; enabledTools?: string }) => {
      const { brokerCall } = await import("./broker-call.js");

      const code = await runMs365McpLauncher(opts, {
        fetchCreds: async () => {
          return await brokerCall(async (client) => {
            const data = await client.getCredentials("microsoft", opts.account);
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
