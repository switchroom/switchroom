/**
 * `switchroom status` — one-shot fleet snapshot.
 *
 * Closes the gap from #1837: the existing `switchroom agent list`
 * shows uptime/template/scheduler but nothing about MCP connection
 * state or active-account quota. Operators (and the Telegram
 * `/status` skill that wraps this) want a single command that
 * surfaces:
 *
 *   1. Fleet — per-agent uptime + scheduler state (reuses the
 *      existing agent-list data).
 *   2. Accounts — known auth accounts + active + fallback order
 *      (reuses the existing auth-list broker call).
 *   3. MCPs — per-agent MCP connection state, fetched in parallel
 *      via `docker exec <agent> claude mcp list`. Reports
 *      "connected" / "Failed to connect" per server.
 *
 * Future iterations (#1837 follow-up):
 *   - Live quota probe per account (5h % + reset time, 7d % + reset).
 *   - Hindsight detailed bank stats (obs count, last retain/recall).
 *   - Per-agent recent message count from SQLite history.
 *
 * `--json` flag emits structured output for the Telegram skill to
 * re-render, and for any operator scripting.
 *
 * Time budget: targets <3s on a 9-agent fleet. The MCP probe is the
 * dominant cost (~500ms-1s per agent), so it runs in parallel.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

import { getAllAgentStatuses } from "../agents/lifecycle.js";
import { getSchedulerState, formatSchedulerState } from "../agents/scheduler-state.js";
import { withConfigError, getConfig } from "./helpers.js";
import { brokerCall } from "./broker-call.js";

const execFileP = promisify(execFile);

// Per-agent `claude mcp list` probe timeout. The probe does a real
// handshake against every MCP server the agent has wired (typically 5-6
// servers @ ~1s each), so a single agent's probe takes 6-10s. Under
// fleet-wide parallelism (9 concurrent docker exec calls) the per-
// probe time roughly doubles due to docker daemon + auth-broker
// contention. 20s buys headroom while keeping the worst-case status
// runtime <25s on a 9-agent fleet.
const MCP_PROBE_TIMEOUT_MS = 20_000;

export interface McpServerState {
  name: string;
  connected: boolean;
  /** Verbatim status string from `claude mcp list` (e.g. "✓ Connected"
   *  or "✗ Failed to connect"). Null when the probe itself failed
   *  (docker exec error, agent not running, etc.). */
  status: string | null;
}

export interface PerAgentMcpProbe {
  agent: string;
  /** True iff the docker exec + parse round-trip succeeded. */
  ok: boolean;
  /** Reason the probe failed when ok === false. Examples: "agent
   *  container not running", "claude mcp list exited 1", "probe
   *  timed out after 8s". */
  reason?: string;
  servers: McpServerState[];
}

/**
 * Probe `claude mcp list` inside an agent's container and return
 * the parsed connection state. Fails open: any error path returns
 * `{ok: false, reason}` rather than throwing.
 *
 * `claude mcp list` outputs (when run from the agent's cwd):
 *   Checking MCP server health…
 *
 *   switchroom-telegram: bun run ... - ✓ Connected
 *   agent-config: /usr/local/bin/... - ✓ Connected
 *   gdrive: /usr/local/bin/... - ✓ Connected
 *   perplexity: /home/.../perplexity-mcp.sh - ✗ Failed to connect
 *
 * Parser is forgiving — any line matching `<name>: <command> - <status>`
 * counts; `✓ Connected` is the success marker, anything else is treated
 * as a failure with the verbatim status preserved.
 */
export async function probeAgentMcps(
  agentName: string,
  opts: { execImpl?: typeof execFile; timeoutMs?: number } = {},
): Promise<PerAgentMcpProbe> {
  const timeoutMs = opts.timeoutMs ?? MCP_PROBE_TIMEOUT_MS;
  const exec = opts.execImpl
    ? promisify(opts.execImpl)
    : execFileP;
  try {
    const { stdout } = await exec(
      "docker",
      [
        "exec",
        `switchroom-${agentName}`,
        "sh",
        "-lc",
        "cd /state/agent && claude mcp list 2>&1",
      ],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    const servers = parseClaudeMcpList(stdout);
    return { agent: agentName, ok: true, servers };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish "container not running" (no such container, exit 1
    // from docker) from a real claude error.
    const reason =
      msg.includes("No such container") || msg.includes("is not running")
        ? "agent container not running"
        : msg.includes("ETIMEDOUT") || msg.includes("timed out")
          ? `probe timed out after ${timeoutMs}ms`
          : `mcp list failed: ${msg.split("\n")[0].slice(0, 120)}`;
    return { agent: agentName, ok: false, reason, servers: [] };
  }
}

/** Parse `claude mcp list` stdout into per-server state. Exported for tests. */
export function parseClaudeMcpList(stdout: string): McpServerState[] {
  // Each interesting line looks like:
  //   <name>: <command-or-url> - ✓ Connected
  //   <name>: <command-or-url> - ✗ Failed to connect
  // The dash + status is the discriminator.
  const out: McpServerState[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    // Skip the header banner and any pre-amble. The data lines all
    // contain " - " between the command/url and the status.
    const dashIdx = line.lastIndexOf(" - ");
    if (dashIdx < 0) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0 || colonIdx > dashIdx) continue;
    const name = line.slice(0, colonIdx).trim();
    const status = line.slice(dashIdx + 3).trim();
    if (name.length === 0) continue;
    const connected = status.includes("Connected") && !status.includes("Failed");
    out.push({ name, connected, status });
  }
  return out;
}

interface AccountSnapshot {
  label: string;
  active: boolean;
  available: boolean;
  exhausted: boolean;
  /** Seconds until the OAuth credentials expire. */
  expiresInSec?: number | null;
  /** Live quota reset time if the broker has probed recently. */
  quotaResetAt?: string | null;
}

/**
 * Fetch the broker's account state. Returns null when the broker is
 * unreachable (uncommon in production but a common dev state).
 */
async function fetchAccounts(): Promise<{ active: string | null; accounts: AccountSnapshot[] } | null> {
  try {
    const state = await brokerCall((client) => client.listState()) as {
      active?: string;
      accounts?: Array<{
        label: string;
        exhausted?: boolean;
        expiresInSec?: number | null;
        quotaResetAt?: string | null;
      }>;
    };
    const active = state.active ?? null;
    const accounts = (state.accounts ?? []).map((a) => ({
      label: a.label,
      active: a.label === active,
      available: !a.exhausted,
      exhausted: a.exhausted ?? false,
      expiresInSec: a.expiresInSec ?? null,
      quotaResetAt: a.quotaResetAt ?? null,
    }));
    return { active, accounts };
  } catch {
    return null;
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "One-shot fleet snapshot — per-agent uptime + scheduler, " +
      "auth accounts, MCP connection state. Wrapped by the Telegram " +
      "`/status` skill. Use `--json` for programmatic output.",
    )
    .option("--json", "Output JSON")
    .option(
      "--no-mcp",
      "Skip the per-agent MCP probe (faster — avoids the docker exec round-trip)",
    )
    .option(
      "--mcp-timeout <ms>",
      `MCP probe per-agent timeout in ms (default ${MCP_PROBE_TIMEOUT_MS})`,
      (v) => Number.parseInt(v, 10),
      MCP_PROBE_TIMEOUT_MS,
    )
    .action(
      withConfigError(async (opts: { json?: boolean; mcp?: boolean; mcpTimeout?: number }) => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents ?? {}).sort();

        // ── Fleet section: reuse the existing agent-list data ──────────
        const statuses = getAllAgentStatuses(config);
        const logsDir = join(homedir(), ".switchroom", "logs");
        const schedulerStates = Object.fromEntries(
          agentNames.map((n) => [n, getSchedulerState(n, logsDir)] as const),
        );

        // ── Accounts section: broker.listState ─────────────────────────
        const accountsP = fetchAccounts();

        // ── MCPs section: parallel docker exec ─────────────────────────
        const mcpEnabled = opts.mcp !== false;
        const mcpTimeoutMs = opts.mcpTimeout ?? MCP_PROBE_TIMEOUT_MS;
        const mcpsP = mcpEnabled
          ? Promise.all(
              agentNames.map((n) => probeAgentMcps(n, { timeoutMs: mcpTimeoutMs })),
            )
          : Promise.resolve<PerAgentMcpProbe[]>([]);

        const [accounts, mcps] = await Promise.all([accountsP, mcpsP]);

        if (opts.json) {
          const data = {
            fleet: agentNames.map((name) => {
              const agentConfig = config.agents?.[name];
              const status = statuses[name];
              const sched = schedulerStates[name];
              return {
                name,
                status: status?.active ?? "unknown",
                // ISO-timestamp of container start (matches
                // AgentStatus.uptime shape); consumers compute the
                // delta themselves.
                started_at: status?.uptime ?? null,
                topic: agentConfig?.topic_name ?? null,
                scheduler: sched,
              };
            }),
            accounts: accounts ?? { active: null, accounts: [] },
            mcps: mcpEnabled ? mcps : { skipped: true },
          };
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        // ── Human-readable rendering ───────────────────────────────────
        console.log();
        console.log(chalk.bold("Fleet"));
        for (const name of agentNames) {
          const status = statuses[name];
          const sched = schedulerStates[name];
          const isUp = status?.active === "active";
          const dot = isUp ? chalk.green("●") : chalk.gray("○");
          const uptime = formatUptimeShort(status?.uptime ?? null);
          const schedStr = sched ? formatSchedulerState(sched) : "?";
          console.log(
            `  ${dot} ${name.padEnd(16)} ${chalk.dim(uptime.padEnd(8))} ${chalk.dim(schedStr)}`,
          );
        }

        console.log();
        console.log(chalk.bold("Accounts"));
        if (accounts == null) {
          console.log(chalk.gray("  (broker unreachable — run `switchroom auth list` for details)"));
        } else if (accounts.accounts.length === 0) {
          console.log(chalk.gray("  (no accounts configured)"));
        } else {
          for (const acc of accounts.accounts) {
            const marker = acc.active
              ? chalk.green("●")
              : acc.exhausted
                ? chalk.red("✗")
                : chalk.gray("○");
            const tag = acc.active
              ? chalk.green("active")
              : acc.exhausted
                ? chalk.red("exhausted")
                : chalk.gray("available");
            const reset = acc.quotaResetAt ? `  reset=${acc.quotaResetAt}` : "";
            console.log(`  ${marker} ${acc.label.padEnd(35)} ${tag}${reset}`);
          }
        }

        if (mcpEnabled) {
          console.log();
          console.log(chalk.bold("MCPs"));
          for (const probe of mcps) {
            if (!probe.ok) {
              console.log(
                `  ${chalk.red("✗")} ${probe.agent.padEnd(16)} ${chalk.dim(probe.reason ?? "probe failed")}`,
              );
              continue;
            }
            if (probe.servers.length === 0) {
              console.log(
                `  ${chalk.gray("○")} ${probe.agent.padEnd(16)} ${chalk.dim("no MCPs configured")}`,
              );
              continue;
            }
            const parts = probe.servers.map((s) =>
              s.connected
                ? chalk.green(`✓ ${s.name}`)
                : chalk.red(`✗ ${s.name}`),
            );
            console.log(`  ${probe.agent.padEnd(16)} ${parts.join("  ")}`);
          }
        }
        console.log();
      }),
    );
}

/**
 * Compact uptime from an ISO timestamp (the shape `AgentStatus.uptime`
 * carries — container-start time). Returns "44m", "2h 3m", "5d 2h", or
 * "—" for null / malformed / non-positive. Mirrors the format used by
 * `switchroom agent list` (intentionally identical so the two outputs
 * align side-by-side).
 */
export function formatUptimeShort(timestamp: string | null): string {
  if (!timestamp) return "—";
  const start = new Date(timestamp).getTime();
  if (Number.isNaN(start)) return "—";
  const seconds = Math.floor((Date.now() - start) / 1000);
  if (seconds <= 0) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
