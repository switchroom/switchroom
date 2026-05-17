/**
 * Reader / formatter for the hostd audit log
 * (~/.switchroom/host-control-audit.log).
 *
 * The log is written by {@link HostControlServer.writeAudit} as
 * append-only JSONL. Each row captures one privileged verb invocation:
 *
 *   {ts, op, caller:{kind,name?}, request_id, result, exit_code,
 *    duration_ms, error?}
 *
 * Pure functions only — the CLI verb at `src/cli/audit.ts` and the
 * Telegram `/audit hostd` handler in the gateway both depend on this
 * module to share parsing + filtering semantics.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface AuditEntry {
  ts: string;
  op: string;
  caller: { kind: "agent"; name: string } | { kind: "operator" };
  request_id: string;
  result: string;
  exit_code: number | null;
  duration_ms: number;
  error?: string;
  /** "terminal" on the durable async-mutation outcome row written by
   *  hostd's spawn-completion handler. Absent on the synchronous
   *  request-path rows. */
  phase?: string;
  stdout_tail?: string;
  stderr_tail?: string;
  // ─── Update-flow enrichment (PR B) ─────────────────────────────────
  /** Resolved release channel for `update_apply` terminal rows. */
  channel?: string;
  /** Resolved release pin for `update_apply` terminal rows. */
  pin?: string;
  /** Captured image-ref → digest map for `update_apply` terminal rows. */
  resolved_sha?: Record<string, string>;
  /** Install-context snapshot at the time of the update_apply call. */
  install_context?: {
    install_type: string;
    detected_at: string;
  };
}

export interface AuditFilters {
  agent?: string;
  op?: string;
  errorOnly?: boolean;
}

export function defaultAuditLogPath(home: string = homedir()): string {
  return join(home, ".switchroom", "host-control-audit.log");
}

/** Parse a single JSONL line. Returns null on malformed input — the log
 *  is best-effort append-only so we tolerate the occasional partial
 *  write (interrupted fsync). */
export function parseAuditLine(line: string): AuditEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.ts !== "string" || typeof o.op !== "string") return null;
  if (typeof o.request_id !== "string" || typeof o.result !== "string") return null;
  if (typeof o.duration_ms !== "number") return null;
  const callerRaw = o.caller as Record<string, unknown> | undefined;
  let caller: AuditEntry["caller"];
  if (callerRaw && callerRaw.kind === "agent" && typeof callerRaw.name === "string") {
    caller = { kind: "agent", name: callerRaw.name };
  } else if (callerRaw && callerRaw.kind === "operator") {
    caller = { kind: "operator" };
  } else {
    return null;
  }
  const exit_code = o.exit_code === null || typeof o.exit_code === "number"
    ? (o.exit_code as number | null)
    : null;
  const entry: AuditEntry = {
    ts: o.ts,
    op: o.op,
    caller,
    request_id: o.request_id,
    result: o.result,
    exit_code,
    duration_ms: o.duration_ms,
  };
  if (typeof o.error === "string") entry.error = o.error;
  if (typeof o.phase === "string") entry.phase = o.phase;
  if (typeof o.stdout_tail === "string") entry.stdout_tail = o.stdout_tail;
  if (typeof o.stderr_tail === "string") entry.stderr_tail = o.stderr_tail;
  if (typeof o.channel === "string") entry.channel = o.channel;
  if (typeof o.pin === "string") entry.pin = o.pin;
  if (o.resolved_sha && typeof o.resolved_sha === "object" && !Array.isArray(o.resolved_sha)) {
    const rs: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.resolved_sha as Record<string, unknown>)) {
      if (typeof v === "string") rs[k] = v;
    }
    if (Object.keys(rs).length > 0) entry.resolved_sha = rs;
  }
  if (
    o.install_context &&
    typeof o.install_context === "object" &&
    !Array.isArray(o.install_context)
  ) {
    const ic = o.install_context as Record<string, unknown>;
    if (
      typeof ic.install_type === "string" &&
      typeof ic.detected_at === "string"
    ) {
      entry.install_context = {
        install_type: ic.install_type,
        detected_at: ic.detected_at,
      };
    }
  }
  return entry;
}

/** Apply filters in-order, return matching entries unchanged. */
export function filterEntries(
  entries: readonly AuditEntry[],
  filters: AuditFilters,
): AuditEntry[] {
  return entries.filter((e) => {
    if (filters.agent != null) {
      if (e.caller.kind !== "agent") return false;
      if (e.caller.name !== filters.agent) return false;
    }
    if (filters.op != null && e.op !== filters.op) return false;
    if (filters.errorOnly) {
      // Treat `error` and `denied` as failure-shaped. `started` is in-
      // flight (long-running async ops), excluded from error filter
      // because by itself it's not a failure.
      if (e.result !== "error" && e.result !== "denied") return false;
    }
    return true;
  });
}

/** Parse + filter + take last N (most-recent). Bounded reads — caller
 *  passes the whole file contents; for huge logs the CLI/gateway should
 *  pre-tail before calling. */
export function readAndFilter(
  raw: string,
  filters: AuditFilters,
  limit: number,
): AuditEntry[] {
  const lines = raw.split("\n");
  const parsed: AuditEntry[] = [];
  for (const line of lines) {
    const e = parseAuditLine(line);
    if (e != null) parsed.push(e);
  }
  const filtered = filterEntries(parsed, filters);
  return filtered.slice(-Math.max(1, limit));
}

function shortCaller(caller: AuditEntry["caller"]): string {
  return caller.kind === "agent" ? caller.name : "operator";
}

function shortTs(ts: string): string {
  // 2026-05-15T04:15:13.465Z → 2026-05-15 04:15:13
  return ts.replace("T", " ").replace(/\.\d+Z$/, "").slice(0, 19);
}

/** Indent every line of a tail blob so it reads as a sub-block under
 *  its row. Caps total length so one pathological entry can't flood
 *  the terminal / a Telegram message. */
function indentTail(label: string, blob: string, max = 1600): string[] {
  const clipped =
    blob.length > max ? blob.slice(blob.length - max) + "\n…(truncated)" : blob;
  const body = clipped
    .split("\n")
    .map((l) => `    │ ${l}`)
    .join("\n");
  return [`    ${label}:`, body];
}

/** Plain-text formatter for CLI stdout. Fixed-width columns. When
 *  `verbose` is set, error / terminal rows that carry a captured
 *  stderr (or error message) get an indented sub-block beneath them
 *  — this is the whole point of persisting the tails: a failed
 *  `update_apply` is diagnosable from the durable log alone. */
export function formatForCli(
  entries: readonly AuditEntry[],
  opts: { verbose?: boolean } = {},
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const ts = shortTs(e.ts).padEnd(20);
    const caller = shortCaller(e.caller).padEnd(15);
    const op = (e.phase === "terminal" ? `${e.op}✓` : e.op).padEnd(16);
    const result = e.result.padEnd(10);
    const exit = e.exit_code == null ? "  -" : String(e.exit_code).padStart(3);
    const ms = `${e.duration_ms}ms`.padStart(8);
    out.push(`${ts} ${caller} ${op} ${result} ${exit} ${ms}`);
    if (opts.verbose) {
      if (e.stderr_tail) out.push(...indentTail("stderr", e.stderr_tail));
      else if (e.error) out.push(...indentTail("error", e.error));
    }
  }
  return out;
}
