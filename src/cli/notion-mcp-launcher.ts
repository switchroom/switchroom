/**
 * `switchroom notion-mcp-launcher` — RFC docs/rfcs/notion-integration.md PR 2.
 *
 * Hidden CLI verb spawned by Claude Code (per the `.mcp.json` entry
 * emitted by `resolveNotionMcpEntry`). Runs inside the agent container
 * as the agent's UID. Acquires the Notion integration token from the
 * vault-broker, then execs `@notionhq/notion-mcp-server` (stdio mode)
 * with `NOTION_TOKEN` in env. Acts as a stdio bridge so Claude Code's
 * MCP client talks to notion-mcp-server transparently.
 *
 * **No refresh loop.** Unlike the m365 launcher, Notion's integration
 * token is long-lived (no OAuth expiry). The launcher is a one-shot
 * exec: vault fetch → env inject → spawn → bridge stdio for the
 * lifetime of the parent. Rotation is operator-initiated and requires
 * a launcher restart (`agent restart --graceful-restart` is enough —
 * no image change).
 *
 * **Heartbeat.** Writes `/state/agent/notion-launcher.heartbeat.json`
 * every 30 s. Doctor probe in PR 4 reads this to surface "launcher is
 * up" without forcing an API call to notion.com on every doctor run.
 *
 * **No HTTP-layer rate-bucket wrapping here.** RFC §7 prescribed
 * wrapping the MCP's HTTP layer with the broker's rate bucket. In
 * practice, that's a meaningful refactor — the upstream MCP issues
 * its own HTTP calls via its own `fetch`/`https.request`, and
 * intercepting them cleanly is fragile (relies on global module
 * monkey-patching or a local proxy). The narrow read of the burst
 * threat is that **the PreToolUse hook (PR 3) is the dominant source
 * of multi-request bursts** (DB resolver walks + search post-filter).
 * The bucket is reserved for the hook; the MCP server's own calls go
 * through unthrottled. This is a deliberate v1 deferral, documented
 * here so a future PR has the chain of reasoning.
 *
 * If production logs show >5% 429s from the MCP server's own calls
 * (vs from the hook), reopen this decision — `--http-proxy
 * unix:///path/to/broker.sock` style proxy is the natural follow-up.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";

import {
  NOTION_MCP_PACKAGE,
  NOTION_MCP_PINNED_VERSION,
  NOTION_TOKEN_ENV,
} from "../memory/scaffold-integration.js";

/** Heartbeat write interval. */
export const HEARTBEAT_WRITE_INTERVAL_MS = 30 * 1000;

/** Default heartbeat path inside the agent container. */
export const DEFAULT_HEARTBEAT_PATH =
  "/state/agent/notion-launcher.heartbeat.json";

/** Default config + sockets — wired by the scaffold env. */
export const DEFAULT_VAULT_KEY = "notion/integration-token";

export interface NotionLauncherOptions {
  /** Override the vault key to fetch. Defaults to `notion/integration-token`. */
  vaultKey?: string;
  /** Override the heartbeat file path. */
  heartbeatPath?: string;
  /** Override the npm package + version. */
  mcpVersion?: string;
}

export interface NotionLauncherRuntime {
  /** Injectable broker call — tests pass a stub. */
  fetchToken: () => Promise<string>;
  /** Injectable spawn — tests pass a fake. */
  spawnMcp: (env: NodeJS.ProcessEnv, args: string[]) => ChildProcess;
  /** Injectable timer — tests pass a fake. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Injectable filesystem — tests pass a fake. */
  writeHeartbeat?: (path: string, contents: string) => void;
  /** Injectable now() — tests pass a fake. */
  now?: () => number;
}

interface HeartbeatPayload {
  ts: number;
  pid: number;
  agent: string | undefined;
  mcp_package: string;
  mcp_version: string;
}

/**
 * Build the args for `npx -y <package>@<version>` (stdio mode, the
 * default for @notionhq/notion-mcp-server).
 */
export function buildNotionMcpArgs(opts: NotionLauncherOptions): string[] {
  const version = opts.mcpVersion ?? NOTION_MCP_PINNED_VERSION;
  return ["-y", `${NOTION_MCP_PACKAGE}@${version}`];
}

/**
 * Default heartbeat writer — durable, sync, atomic-enough for a
 * single-writer file. The doctor probe (PR 4) reads it stat() +
 * JSON-parse.
 */
function defaultWriteHeartbeat(path: string, contents: string): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, contents);
  } catch {
    // Heartbeat failures are best-effort — the launcher's primary
    // function is the stdio bridge, and a missing heartbeat is a
    // doctor signal, not a kill condition.
  }
}

/**
 * Core launcher loop. Exported for tests. Returns the process exit
 * code that the caller should pass to `process.exit`.
 *
 * Lifecycle:
 *   1. Fetch token (fail-fast with exit 1 if denied/unreachable).
 *   2. Spawn child MCP with `NOTION_TOKEN` env.
 *   3. Bridge stdio (parent ⇄ child, transparent passthrough).
 *   4. Write heartbeat every 30 s.
 *   5. On child exit, exit with the same code (caller's process is
 *      Claude Code's MCP supervisor — it will re-spawn if needed).
 *   6. On parent SIGTERM/SIGINT, forward to child and wait for exit.
 */
export async function runNotionMcpLauncher(
  opts: NotionLauncherOptions,
  runtime: NotionLauncherRuntime,
): Promise<number> {
  const heartbeatPath = opts.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH;
  const writeHeartbeat = runtime.writeHeartbeat ?? defaultWriteHeartbeat;
  const setTimer = runtime.setTimer ?? ((cb, ms) => setInterval(cb, ms));
  const clearTimer = runtime.clearTimer ?? clearInterval;
  const now = runtime.now ?? (() => Date.now());

  let token: string;
  try {
    token = await runtime.fetchToken();
  } catch (err) {
    process.stderr.write(
      `notion-mcp-launcher: failed to fetch token from vault-broker: ${
        (err as Error).message
      }\n`,
    );
    return 1;
  }

  if (!token || typeof token !== "string") {
    process.stderr.write(
      "notion-mcp-launcher: vault-broker returned an empty/invalid token.\n",
    );
    return 1;
  }

  // Spawn child with the token in env. Inherit everything else.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [NOTION_TOKEN_ENV]: token,
  };
  const args = buildNotionMcpArgs(opts);
  const child = runtime.spawnMcp(childEnv, args);

  if (child.stdin == null || child.stdout == null || child.stderr == null) {
    process.stderr.write(
      "notion-mcp-launcher: child stdio handles missing — aborting.\n",
    );
    return 1;
  }

  // Stdio bridge.
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  // Heartbeat.
  const writeOne = () => {
    const payload: HeartbeatPayload = {
      ts: now(),
      pid: process.pid,
      agent: process.env.SWITCHROOM_AGENT_NAME,
      mcp_package: NOTION_MCP_PACKAGE,
      mcp_version: opts.mcpVersion ?? NOTION_MCP_PINNED_VERSION,
    };
    writeHeartbeat(heartbeatPath, JSON.stringify(payload, null, 2));
  };
  writeOne();
  const heartbeatHandle = setTimer(writeOne, HEARTBEAT_WRITE_INTERVAL_MS);

  // Forward shutdown signals.
  const forward = (sig: NodeJS.Signals) => {
    try {
      child.kill(sig);
    } catch {
      // already dead — nothing to do
    }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));

  // Wait for child exit.
  const exitCode = await new Promise<number>((resolve) => {
    child.once("exit", (code, signal) => {
      clearTimer(heartbeatHandle);
      if (typeof code === "number") {
        resolve(code);
      } else if (signal) {
        // Convention: signal exit → 128 + signal number.
        const sigCode =
          { SIGTERM: 15, SIGINT: 2, SIGKILL: 9 }[signal as string] ?? 1;
        resolve(128 + sigCode);
      } else {
        resolve(1);
      }
    });
    child.once("error", (err) => {
      clearTimer(heartbeatHandle);
      process.stderr.write(
        `notion-mcp-launcher: child spawn error: ${err.message}\n`,
      );
      resolve(1);
    });
  });

  return exitCode;
}

/**
 * CLI registration. Hidden verb — not user-facing. Spawned by Claude
 * Code via the `.mcp.json` entry emitted by `resolveNotionMcpEntry`.
 */
export function registerNotionMcpLauncherCommand(program: Command): void {
  program
    .command("notion-mcp-launcher", { hidden: true })
    .option(
      "--vault-key <key>",
      "Override the vault key holding the Notion integration token. " +
        "Defaults to `notion/integration-token`.",
      DEFAULT_VAULT_KEY,
    )
    .option(
      "--mcp-version <semver>",
      "Override the @notionhq/notion-mcp-server version to spawn.",
    )
    .option(
      "--heartbeat-path <path>",
      "Override the heartbeat file path. Default: /state/agent/notion-launcher.heartbeat.json",
    )
    .description(
      "Internal — Notion MCP launcher. Fetches the integration token from the vault-broker and execs @notionhq/notion-mcp-server in stdio mode. RFC docs/rfcs/notion-integration.md PR 2.",
    )
    .action(
      async (opts: {
        vaultKey?: string;
        mcpVersion?: string;
        heartbeatPath?: string;
      }) => {
        const { getViaBrokerStructured } = await import(
          "../vault/broker/client.js"
        );

        const code = await runNotionMcpLauncher(opts, {
          fetchToken: async () => {
            const key = opts.vaultKey ?? DEFAULT_VAULT_KEY;
            const result = await getViaBrokerStructured(key);
            if (result.kind === "unreachable") {
              throw new Error(
                `vault-broker unreachable: ${result.msg}. Is the broker socket mounted?`,
              );
            }
            if (result.kind === "not_found") {
              throw new Error(
                `vault key ${key} is missing. Run \`switchroom vault put ${key}\` on the host to populate it.`,
              );
            }
            if (result.kind === "denied") {
              throw new Error(
                `vault-broker denied access to ${key}: ${result.msg}. Re-run \`switchroom vault acl add ${key} <agent>\` on the host.`,
              );
            }
            if (result.entry.kind !== "string") {
              throw new Error(
                `vault key ${key} is not a string entry — Notion expects an integration token string.`,
              );
            }
            return result.entry.value;
          },
          spawnMcp: (env, args) => {
            return spawn("npx", args, {
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
          },
        });
        process.exit(code);
      },
    );
}
