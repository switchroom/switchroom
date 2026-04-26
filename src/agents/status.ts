/**
 * Agent health status — the data model behind `switchroom agent status <name>`.
 *
 * This module answers the question "is my agent alive and healthy?" without
 * the operator having to assemble it from ps + tail + curl. Each check is a
 * pure function that consumes filesystem + HTTP inputs and returns a
 * structured `CheckResult`. The CLI command composes them and formats them
 * for stdout. Structuring it this way keeps the checks testable in
 * isolation — mock the fs reads and HTTP calls, assert on the result shape.
 *
 * All checks are resilient: a missing file, an unreachable daemon, or an
 * unparseable timestamp returns a `fail` result with a human-readable
 * reason, never throws. The CLI rolls the results up into a single exit
 * code: 0 if every check is `ok`, 1 if any check is `fail`.
 *
 * See reference/onboarding-gap-analysis.md §3 for the gap this closes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export type CheckState = "ok" | "fail" | "warn";

export interface CheckResult {
  name: string;
  state: CheckState;
  detail: string;
}

export interface ClaudeProcessStatus {
  state: CheckState;
  pid: number | null;
  uptimeSeconds: number | null;
  detail: string;
}

export interface GatewayProcessStatus {
  state: CheckState;
  pid: number | null;
  detail: string;
}

export interface HindsightStatus {
  /** ok = reachable AND bank exists; warn = reachable but bank missing; fail = unreachable */
  state: CheckState;
  detail: string;
}

export interface PollingStatus {
  state: CheckState;
  botHandle: string | null;
  detail: string;
}

export interface LastMessageStatus {
  /** ok when both timestamps are present. warn when the DB is empty (new agent). */
  state: CheckState;
  lastInboundTs: number | null;
  lastOutboundTs: number | null;
  detail: string;
}

export interface AgentStatusReport {
  name: string;
  claude: ClaudeProcessStatus;
  gateway: GatewayProcessStatus;
  hindsight: HindsightStatus;
  polling: PollingStatus;
  messages: LastMessageStatus;
  /** Roll-up: ok if every check is ok or warn; fail if any check is fail. */
  overallState: CheckState;
}

/**
 * Inputs needed to build a status report. Everything is injectable so tests
 * can run without filesystems, systemd, or real HTTP.
 */
export interface StatusInputs {
  agentName: string;
  /** Path to the agent workspace, e.g. ~/.switchroom/agents/foo */
  agentDir: string;
  /** Hindsight MCP URL; null if Hindsight is not enabled for this agent. */
  hindsightApiUrl: string | null;
  /** Bank ID for Hindsight; usually equals the agent name. */
  hindsightBankId: string;
  /**
   * Function that fetches Claude process info for the agent. Returns null if
   * the process isn't running. Real implementation calls systemctl show.
   */
  getClaudeProcess: () => { pid: number | null; activeEnterTs: number | null; active: string };
  /** Same shape, for the gateway unit. */
  getGatewayProcess: () => { pid: number | null; activeEnterTs: number | null; active: string };
  /** Called to probe Hindsight; returns bank presence + reachability. */
  probeHindsight: (apiUrl: string, bankId: string) => Promise<HindsightProbeResult>;
  /** Query the telegram history DB for latest inbound+outbound timestamps. */
  getLastMessages: (historyDbPath: string) => LastMessagesResult;
  /** Read N lines of gateway.log (or equivalent) to extract polling state. */
  readGatewayLog: (logPath: string) => string | null;
}

export interface HindsightProbeResult {
  reachable: boolean;
  bankExists: boolean;
  reason?: string;
}

export interface LastMessagesResult {
  lastInboundTs: number | null;
  lastOutboundTs: number | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Individual check builders. Each takes the relevant slice of StatusInputs
// and returns a typed *Status object. Pure, no side effects.
// ---------------------------------------------------------------------------

export function buildClaudeStatus(
  info: { pid: number | null; activeEnterTs: number | null; active: string },
): ClaudeProcessStatus {
  if (!info.pid || info.active !== "active") {
    return {
      state: "fail",
      pid: null,
      uptimeSeconds: null,
      detail: `claude process not running (state=${info.active})`,
    };
  }
  const uptimeSeconds = info.activeEnterTs
    ? Math.max(0, Math.floor((Date.now() - info.activeEnterTs) / 1000))
    : null;
  return {
    state: "ok",
    pid: info.pid,
    uptimeSeconds,
    detail: `pid=${info.pid} uptime=${uptimeSeconds !== null ? formatUptime(uptimeSeconds) : "?"}`,
  };
}

export function buildGatewayStatus(
  info: { pid: number | null; activeEnterTs: number | null; active: string },
): GatewayProcessStatus {
  if (!info.pid || info.active !== "active") {
    return {
      state: "fail",
      pid: null,
      detail: `gateway not running (state=${info.active})`,
    };
  }
  return {
    state: "ok",
    pid: info.pid,
    detail: `pid=${info.pid}`,
  };
}

export function buildHindsightStatus(probe: HindsightProbeResult): HindsightStatus {
  if (!probe.reachable) {
    return {
      state: "fail",
      detail: `unreachable${probe.reason ? ` (${probe.reason})` : ""}`,
    };
  }
  if (!probe.bankExists) {
    return {
      state: "fail",
      detail: "reachable but bank does not exist — run: switchroom agent reconcile <name>",
    };
  }
  return {
    state: "ok",
    detail: "reachable, bank ready",
  };
}

export function buildPollingStatus(logContent: string | null): PollingStatus {
  if (logContent == null) {
    return {
      state: "fail",
      botHandle: null,
      detail: "gateway.log not found",
    };
  }
  // Match the most recent "polling as @<handle>" line — both the server.ts
  // and gateway.ts variants write this format. Take the last occurrence
  // (most recent polling start), since the log is append-only and a
  // restart produces a new line.
  const matches = [...logContent.matchAll(/polling as @([A-Za-z0-9_]+)/g)];
  if (matches.length === 0) {
    return {
      state: "fail",
      botHandle: null,
      detail: "no 'polling as @bot' line found in gateway.log",
    };
  }
  // Check that "polling failed" doesn't appear AFTER the last polling start.
  const last = matches[matches.length - 1];
  const lastIdx = last.index ?? 0;
  const tail = logContent.slice(lastIdx);
  const failed = /polling failed/.test(tail);
  if (failed) {
    return {
      state: "fail",
      botHandle: last[1],
      detail: `@${last[1]} — polling reported failure after last start`,
    };
  }
  return {
    state: "ok",
    botHandle: last[1],
    detail: `@${last[1]}`,
  };
}

export function buildMessageStatus(res: LastMessagesResult): LastMessageStatus {
  if (res.error) {
    return {
      state: "fail",
      lastInboundTs: null,
      lastOutboundTs: null,
      detail: res.error,
    };
  }
  if (res.lastInboundTs == null && res.lastOutboundTs == null) {
    return {
      state: "warn",
      lastInboundTs: null,
      lastOutboundTs: null,
      detail: "history.db has no messages yet",
    };
  }
  const parts: string[] = [];
  if (res.lastInboundTs != null) {
    parts.push(`in=${formatTs(res.lastInboundTs)}`);
  } else {
    parts.push("in=—");
  }
  if (res.lastOutboundTs != null) {
    parts.push(`out=${formatTs(res.lastOutboundTs)}`);
  } else {
    parts.push("out=—");
  }
  return {
    state: "ok",
    lastInboundTs: res.lastInboundTs,
    lastOutboundTs: res.lastOutboundTs,
    detail: parts.join(" "),
  };
}

function formatTs(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Compose all checks into a single report. Returns synchronously except for
 * the Hindsight HTTP probe, which requires an async call.
 */
export async function buildAgentStatusReport(
  inputs: StatusInputs,
): Promise<AgentStatusReport> {
  const claudeInfo = inputs.getClaudeProcess();
  const gatewayInfo = inputs.getGatewayProcess();
  const claude = buildClaudeStatus(claudeInfo);
  const gateway = buildGatewayStatus(gatewayInfo);

  // Hindsight
  let hindsight: HindsightStatus;
  if (inputs.hindsightApiUrl == null) {
    hindsight = {
      state: "ok",
      detail: "hindsight not configured for this agent",
    };
  } else {
    try {
      const probe = await inputs.probeHindsight(
        inputs.hindsightApiUrl,
        inputs.hindsightBankId,
      );
      hindsight = buildHindsightStatus(probe);
    } catch (err) {
      hindsight = {
        state: "fail",
        detail: `probe threw: ${String(err)}`,
      };
    }
  }

  // Polling (from gateway.log)
  const logPath = join(inputs.agentDir, "telegram", "gateway.log");
  const logContent = inputs.readGatewayLog(logPath);
  const polling = buildPollingStatus(logContent);

  // Last inbound + outbound from history.db
  const historyDbPath = join(inputs.agentDir, "telegram", "history.db");
  const messagesResult = inputs.getLastMessages(historyDbPath);
  const messages = buildMessageStatus(messagesResult);

  // Roll up. Any fail → overall fail. Otherwise ok.
  const checks: CheckState[] = [
    claude.state,
    gateway.state,
    hindsight.state,
    polling.state,
    messages.state,
  ];
  const overallState: CheckState = checks.includes("fail") ? "fail" : "ok";

  return {
    name: inputs.agentName,
    claude,
    gateway,
    hindsight,
    polling,
    messages,
    overallState,
  };
}

/**
 * Poll `buildAgentStatusReport` until every component relevant to readiness
 * is `ok`, or until the timeout elapses. This backs the B1 readiness gate
 * on `switchroom agent start|restart`: instead of returning success the
 * moment a process is spawned, callers can wait for the agent to be
 * actually serveable.
 *
 * "Ready" here means the same thing `formatStatusText` calls green:
 *   - claude systemd unit active with a pid
 *   - gateway systemd unit active with a pid
 *   - Hindsight reachable AND its bank exists (when configured for this agent)
 *   - Telegram gateway has logged `polling as @<bot>` without a later failure
 *
 * The `messages` check is intentionally excluded — a fresh agent with an
 * empty history.db should still be considered ready.
 *
 * Returns once ready (`ready: true`) or the deadline passes
 * (`ready: false`, with `notReady` naming which components are still not ok
 * and `report` holding the final status for formatting). Errors from the
 * underlying probes are surfaced via the report itself; they do not throw.
 */
export interface WaitForAgentReadyResult {
  ready: boolean;
  elapsedMs: number;
  report: AgentStatusReport;
  /** Components that are still not ok at the moment of return. */
  notReady: string[];
}

export interface WaitForAgentReadyOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Injectable sleep so tests can advance a fake clock instead of waiting
   * in real time.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable clock for the same reason. Defaults to `Date.now`.
   */
  now?: () => number;
}

export async function waitForAgentReady(
  inputs: StatusInputs,
  options: WaitForAgentReadyOptions = {},
): Promise<WaitForAgentReadyResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  let report = await buildAgentStatusReport(inputs);
  let notReady = readinessGaps(report);

  while (notReady.length > 0) {
    if (now() >= deadline) {
      return {
        ready: false,
        elapsedMs: now() - startedAt,
        report,
        notReady,
      };
    }
    await sleep(pollIntervalMs);
    report = await buildAgentStatusReport(inputs);
    notReady = readinessGaps(report);
  }

  return {
    ready: true,
    elapsedMs: now() - startedAt,
    report,
    notReady: [],
  };
}

/**
 * Return the list of component names that are not ok for readiness
 * purposes. `messages` is excluded deliberately (see waitForAgentReady).
 */
export function readinessGaps(report: AgentStatusReport): string[] {
  const gaps: string[] = [];
  if (report.claude.state !== "ok") gaps.push("claude");
  if (report.gateway.state !== "ok") gaps.push("gateway");
  if (report.hindsight.state !== "ok") gaps.push("hindsight");
  if (report.polling.state !== "ok") gaps.push("polling");
  return gaps;
}

/**
 * Grep-stable text formatter. Each line is `key: value`, where `key` is
 * a stable short identifier (no colors, no box drawing) so shell scripts
 * can `| grep ^claude:` reliably.
 *
 * Returns the text. Exit-code decision is left to the caller.
 */
export function formatStatusText(report: AgentStatusReport): string {
  const lines: string[] = [];
  lines.push(`agent: ${report.name}`);
  lines.push(`overall: ${report.overallState}`);
  lines.push(`claude: ${report.claude.state} ${report.claude.detail}`);
  lines.push(`gateway: ${report.gateway.state} ${report.gateway.detail}`);
  lines.push(`hindsight: ${report.hindsight.state} ${report.hindsight.detail}`);
  lines.push(`polling: ${report.polling.state} ${report.polling.detail}`);
  lines.push(`messages: ${report.messages.state} ${report.messages.detail}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Production adapter functions. These are the real implementations that the
// CLI wires into StatusInputs. Kept in the same module so tests can either
// use them end-to-end or swap them out completely.
// ---------------------------------------------------------------------------

/**
 * Read process info via `systemctl --user show <service>`. Returns parsed
 * PID + ActiveEnterTimestamp.
 */
export function readSystemdUnit(
  serviceName: string,
): { pid: number | null; activeEnterTs: number | null; active: string } {
  let active = "unknown";
  try {
    active = execFileSync("systemctl", ["--user", "is-active", serviceName], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    // `is-active` exits 3 for inactive — still have a useful answer in stdout
    const stdout = (err as { stdout?: Buffer | string }).stdout;
    if (stdout) {
      active = String(stdout).trim();
    } else {
      active = "inactive";
    }
  }

  let pid: number | null = null;
  let activeEnterTs: number | null = null;
  try {
    const output = execFileSync(
      "systemctl",
      ["--user", "show", serviceName, "--property=MainPID,ActiveEnterTimestamp"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    for (const line of output.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "MainPID" && value && value !== "0") {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed) && parsed > 0) pid = parsed;
      } else if (key === "ActiveEnterTimestamp" && value) {
        activeEnterTs = parseSystemdTimestamp(value);
      }
    }
  } catch {
    // Unit not installed or systemctl unavailable — return what we have.
  }

  return { pid, activeEnterTs, active };
}

/**
 * Read the tail of a text file — we only need the polling line, which is
 * typically near the top of a freshly-started gateway's log, but we read
 * the whole file (capped at 256KB) to catch restarts.
 */
/**
 * Parse a systemd timestamp like "Tue 2026-04-21 16:38:48 AEST" into ms-
 * since-epoch. Date.parse on this input returns NaN on V8 because of the
 * leading weekday + trailing zone abbreviation. We strip the weekday and
 * hand the rest to Date.parse, which is lenient enough for all zone
 * abbreviations systemd emits (AEST, UTC, PDT, etc.). Returns null on
 * parse failure.
 *
 * Exported for unit tests.
 */
export function parseSystemdTimestamp(raw: string): number | null {
  if (!raw) return null;
  // Strip leading weekday abbreviation like "Tue " if present.
  const stripped = raw.replace(/^[A-Z][a-z]{2}\s+/, "");
  let ms = Date.parse(stripped);
  if (!isNaN(ms)) return ms;
  // Fallback: try the raw value.
  ms = Date.parse(raw);
  if (!isNaN(ms)) return ms;
  // Last resort: parse "YYYY-MM-DD HH:MM:SS" (assume local time) and drop
  // the zone — better a slightly-off uptime than a null one.
  const m = stripped.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) {
    ms = Date.parse(`${m[1]}T${m[2]}`);
    if (!isNaN(ms)) return ms;
  }
  return null;
}

export function readLogFile(logPath: string): string | null {
  if (!existsSync(logPath)) return null;
  try {
    const stat = statSync(logPath);
    const cap = 256 * 1024;
    if (stat.size <= cap) {
      return readFileSync(logPath, "utf-8");
    }
    // Read last 256KB
    const fs = require("node:fs") as typeof import("node:fs");
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(cap);
      fs.readSync(fd, buf, 0, cap, stat.size - cap);
      return buf.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Query the telegram-plugin history SQLite for the most recent inbound +
 * outbound message timestamps. Returns nulls if the DB is absent / empty.
 *
 * The switchroom CLI itself typically runs under Node, but every switchroom
 * host already has `bun` on PATH (the gateway + plugin depend on
 * `bun:sqlite`). Prefer shelling out to a one-off bun invocation so we
 * don't add a native Node dep. Fall back to the `sqlite3` CLI if present,
 * and surface a clear error otherwise.
 */
export function readLastMessages(historyDbPath: string): LastMessagesResult {
  if (!existsSync(historyDbPath)) {
    return {
      lastInboundTs: null,
      lastOutboundTs: null,
      error: `history.db not found at ${historyDbPath}`,
    };
  }

  // Attempt 1: bun -e with bun:sqlite. Works on every switchroom host by
  // construction.
  try {
    const out = execFileSync(
      "bun",
      [
        "-e",
        `const { Database } = require("bun:sqlite"); ` +
          `const db = new Database(${JSON.stringify(historyDbPath)}, { readonly: true }); ` +
          `const rows = db.prepare("SELECT role, MAX(ts) as ts FROM messages GROUP BY role").all(); ` +
          `for (const r of rows) console.log(r.role + "|" + r.ts); ` +
          `db.close();`,
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseSqliteRoleTsOutput(out);
  } catch {
    // Fall through.
  }

  // Attempt 2: sqlite3 CLI.
  try {
    const out = execFileSync(
      "sqlite3",
      [
        historyDbPath,
        "SELECT role, MAX(ts) FROM messages GROUP BY role;",
      ],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return parseSqliteRoleTsOutput(out);
  } catch (err) {
    return {
      lastInboundTs: null,
      lastOutboundTs: null,
      error: `no sqlite reader available (tried bun, sqlite3): ${(err as Error).message}`,
    };
  }
}

function parseSqliteRoleTsOutput(out: string): LastMessagesResult {
  let lastInboundTs: number | null = null;
  let lastOutboundTs: number | null = null;
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const [role, tsStr] = line.split("|");
    const ts = parseInt(tsStr, 10);
    if (isNaN(ts)) continue;
    if (role === "user") lastInboundTs = ts;
    else if (role === "assistant") lastOutboundTs = ts;
  }
  return { lastInboundTs, lastOutboundTs };
}

/**
 * Probe Hindsight for reachability AND bank existence.
 *
 * Two-step: initialize an MCP session, then call list_banks to confirm the
 * specific bank is present. Distinguishing unreachable from missing-bank
 * requires seeing the list — a 200 OK on the MCP endpoint only tells us
 * the daemon is up.
 *
 * Timeouts default to 3s; this runs on a human-facing CLI so we want it
 * snappy.
 */
export async function probeHindsight(
  apiUrl: string,
  bankId: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<HindsightProbeResult> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 3000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const initResp = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "switchroom-status", version: "0.1" },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!initResp.ok) {
      return { reachable: false, bankExists: false, reason: `HTTP ${initResp.status}` };
    }
    const sessionId = initResp.headers.get("mcp-session-id");
    if (!sessionId) {
      return { reachable: false, bankExists: false, reason: "no session id" };
    }

    // list_banks → look for bankId
    const timeout2 = setTimeout(() => controller.abort(), timeoutMs);
    const listResp = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "X-Bank-Id": bankId,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_banks", arguments: {} },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout2);

    if (!listResp.ok) {
      // Daemon is up (init succeeded) but list failed — report reachable
      // but uncertain about the bank.
      return { reachable: true, bankExists: false, reason: `list_banks HTTP ${listResp.status}` };
    }

    const text = await listResp.text();
    // Body is either SSE ("data: <json>") or raw JSON. Do the same split
    // as parseSseOrJson in hindsight.ts.
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    const payload = dataLine ? dataLine.slice("data: ".length) : text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { reachable: true, bankExists: false, reason: "unparseable list_banks response" };
    }
    // Hindsight returns { result: { content: [{ text: "bank1\nbank2" }] } }
    // Parse the structured response to check for an exact bank name match.
    // Falling back to line-by-line text search avoids false positives where
    // the bank ID is a substring of another field value.
    let bankExists = false;
    const result = (parsed as Record<string, unknown>)?.result;
    const content = (result as Record<string, unknown>)?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const text = (item as Record<string, unknown>)?.text;
        if (typeof text === "string") {
          bankExists = text.split("\n").map((l) => l.trim()).includes(bankId);
          if (bankExists) break;
        }
      }
    }
    return { reachable: true, bankExists };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { reachable: false, bankExists: false, reason: "timeout" };
    }
    const msg = String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("fetch failed") ||
      msg.includes("ENOTFOUND")
    ) {
      return { reachable: false, bankExists: false, reason: "daemon not running" };
    }
    return { reachable: false, bankExists: false, reason: msg };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compose the default (production) StatusInputs for a given agent.
 * Resolves systemd unit names, log path, history path, and the Hindsight
 * URL from config.
 */
export function defaultStatusInputs(params: {
  agentName: string;
  agentDir: string;
  hindsightApiUrl: string | null;
  hindsightBankId: string;
}): StatusInputs {
  const service = `switchroom-${params.agentName}`;
  const gatewayService = `switchroom-${params.agentName}-gateway`;

  return {
    agentName: params.agentName,
    agentDir: params.agentDir,
    hindsightApiUrl: params.hindsightApiUrl,
    hindsightBankId: params.hindsightBankId,
    getClaudeProcess: () => readSystemdUnit(service),
    getGatewayProcess: () => readSystemdUnit(gatewayService),
    probeHindsight: (url, id) => probeHindsight(url, id),
    readGatewayLog: (path) => readLogFile(path),
    getLastMessages: (path) => readLastMessages(path),
  };
}

// Keep `resolve` used — sanity import guard so we don't break bundling if
// the function above is later split out.
export const _unusedResolveGuard = resolve;
