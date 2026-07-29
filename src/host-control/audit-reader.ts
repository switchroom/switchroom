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

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveRotationConfig } from "../util/log-rotation.js";
import {
  DEFAULT_HOSTD_AUDIT_MAX_BYTES,
  DEFAULT_HOSTD_AUDIT_MAX_FILES,
} from "./audit-rotation-config.js";

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
  /** #1841 — attestation attribution. `"passphrase-attest"` on rows where
   *  an operator-passphrase attestation was verified (or a required
   *  attestation was missing/rejected). Mirrors the vault broker's
   *  `method` audit field. Never carries the passphrase itself. */
  method?: string;
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
  // ─── Rollout-flow structured result (#2487) ────────────────────────
  /** Agents confirmed on the target version, in order (rollout rows). */
  rolled?: string[];
  /** Step that stopped the rollout (rollout rows). */
  failed_step?: string;
  /** Agent that failed the version assert (rollout rows). */
  failed_agent?: string;
  /** Components still behind the target after the roll (#3928). Present on
   *  rollout terminal rows with `failed_step === "verify-components"`. */
  drifted?: string[];
  // ─── Rollout phase rows (#2726) ────────────────────────────────────
  /** Agent named in a per-phase rollout row (agent-start/-done, canary-*). */
  agent?: string;
  /** Roll-order position (1-based) of the agent named in a phase row. */
  n?: number;
  /** Total agents this roll restarts (phase rows). */
  m?: number;
  // ─── Prior-pin capture (#2492) ────────────────────────────────────
  /** Semver that WAS running before this rollout completed. Only present
   *  on completed (ok=true) rollout terminal rows. Enables
   *  `rollout --allow-downgrade` to default its target to the last good
   *  version without the operator having to recall the tag. */
  prior_pin?: string;
  /** Every distinct version observed across the in-scope fleet when the
   *  roll started, highest first. Present only when the fleet was mixed. */
  prior_pin_observed?: string[];
  /** How `prior_pin` was derived — see `PriorPinSource` in prior-pin.ts. */
  prior_pin_source?: string;
}

export interface AuditFilters {
  agent?: string;
  op?: string;
  errorOnly?: boolean;
}

export function defaultAuditLogPath(home: string = homedir()): string {
  return join(home, ".switchroom", "host-control-audit.log");
}

/**
 * How many bytes of audit history a seam-aware read aims to return.
 * Sized so `--tail 50` (and the dashboard's 1000-row window) still has
 * material to work with immediately after a rotation.
 */
export const AUDIT_READ_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * Resolve the hostd audit rotation config the WRITER will use. Single
 * source of truth for both the generation count and the byte window
 * (#3600 review, finding 6 / re-review, finding 3) — a hand-mirrored
 * constant here silently truncates history the moment an operator raises
 * `SWITCHROOM_HOSTD_AUDIT_MAX_FILES`/`_MAX_BYTES`.
 */
function auditRotation(): { maxBytes: number; maxFiles: number } {
  return resolveRotationConfig({
    envBytesVar: "SWITCHROOM_HOSTD_AUDIT_MAX_BYTES",
    envFilesVar: "SWITCHROOM_HOSTD_AUDIT_MAX_FILES",
    defaultBytes: DEFAULT_HOSTD_AUDIT_MAX_BYTES,
    defaultFiles: DEFAULT_HOSTD_AUDIT_MAX_FILES,
  });
}

/**
 * Whole-history window for callers that must not miss an old row
 * (`resolveRollbackTarget` — #3600 review, finding 3). Derived as
 * `(maxFiles + 1) x maxBytes`: the writer-side ceiling on everything that
 * can exist on disk, so this is "all of it" without being unbounded.
 * 128 MiB at the defaults (32 MiB x (3+1)).
 */
export function auditReadFullWindowBytes(): number {
  const { maxBytes, maxFiles } = auditRotation();
  return (maxFiles + 1) * maxBytes;
}

/**
 * How many rotated generations a seam-aware read walks back through.
 * Derived from the SAME resolver the writer uses (honouring
 * `SWITCHROOM_HOSTD_AUDIT_MAX_FILES`), so a raised retention can never
 * write more generations than the reader reads (#3600 review, finding 6).
 * The byte window remains the real bound.
 */
export function auditReadMaxGenerations(): number {
  return auditRotation().maxFiles;
}

export interface AuditReadOptions {
  /** Byte ceiling on the returned text. Default {@link AUDIT_READ_WINDOW_BYTES}. */
  windowBytes?: number;
  /** Generations to walk. Default {@link auditReadMaxGenerations}. */
  maxFiles?: number;
  /**
   * Surface real I/O failures (EACCES, EIO, …) as a thrown error rather
   * than an empty read. A MISSING file is never an error either way.
   *
   * Callers that report ABSENCE — `get_status` ("no update_apply row
   * found"), `resolveRollbackTarget` (null → operator must pass an
   * explicit `--pin`) — MUST set this: on a privileged-verb surface,
   * silently reporting "it never happened" because the log was
   * unreadable is the wrong default (#3600 review, finding 4).
   */
  strict?: boolean;
}

/** Read the last `n` bytes of `path`, dropping a leading partial line.
 *  A missing file yields "". Other I/O errors yield "" unless `strict`,
 *  in which case they throw. */
function tailBytes(path: string, n: number, strict = false): string {
  if (n <= 0) return "";
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch (err) {
    if (strict && (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return "";
  }
  try {
    const len = Math.min(n, size);
    const start = size - len;
    const buf = Buffer.alloc(len);
    let read = 0;
    try {
      while (read < len) {
        const got = readSync(fd, buf, read, len - read, start + read);
        if (got <= 0) break;
        read += got;
      }
    } catch (err) {
      // open(2) can succeed where read(2) fails (EISDIR, EIO, a vanished
      // network mount). Same policy as the open failure above: loud under
      // `strict`, best-effort otherwise.
      if (strict) throw err;
      return "";
    }
    let text = buf.subarray(0, read).toString("utf-8");
    // Dropped a leading partial line? Cut to the first newline. (Not
    // needed when we started at byte 0 — that line is whole.)
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * Seam-aware raw read of the hostd audit log (#3596).
 *
 * The active log is size-rotated (`server.ts` → `maybeRotateAuditLog`),
 * so reading ONLY `<path>` shows an almost-empty file for a while right
 * after a rotation — `switchroom hostd audit`, the dashboard panel and
 * `get_status` would all appear to have lost history. This reads the
 * active file and, when it is smaller than the read window, back-fills
 * from `<path>.1` (oldest-first) so the seam is invisible to consumers.
 *
 * Bounded by construction: at most `windowBytes` of `.1` is read, and a
 * partial first line is dropped (`parseAuditLine` would return null for
 * it anyway).
 */
export function readAuditRaw(
  logPath: string,
  opts: AuditReadOptions = {},
): string {
  const windowBytes = opts.windowBytes ?? AUDIT_READ_WINDOW_BYTES;
  const maxFiles = opts.maxFiles ?? auditReadMaxGenerations();
  const strict = opts.strict ?? false;
  // Newest-first: active, then `.1`, `.2`, … stopping once the window is
  // full or every generation has been considered.
  const chunks: string[] = [];
  let budget = windowBytes;
  const active = tailBytes(logPath, budget, strict);
  chunks.push(active);
  budget -= Buffer.byteLength(active, "utf-8");
  for (let n = 1; n <= maxFiles && budget > 0; n++) {
    const gen = `${logPath}.${n}`;
    // An EXISTING-but-empty generation must not stop the walk — a
    // crashed/raced rotation can leave a zero-byte `.1` while `.2`/`.3`
    // still hold real history (#3600 review, finding 5). Only a genuinely
    // ABSENT generation ends it: rotation shifts contiguously, so there is
    // nothing older beyond the first gap.
    if (!existsSync(gen)) break;
    const chunk = tailBytes(gen, budget, strict);
    if (chunk.length === 0) continue;
    chunks.push(chunk);
    budget -= Buffer.byteLength(chunk, "utf-8");
  }
  // Emit oldest-first so consumers keep their chronological contract.
  return chunks
    .reverse()
    .filter((c) => c.length > 0)
    .map((c) => (c.endsWith("\n") ? c : c + "\n"))
    .join("");
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
  if (typeof o.method === "string") entry.method = o.method;
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
  if (Array.isArray(o.rolled) && o.rolled.every((x) => typeof x === "string")) {
    entry.rolled = o.rolled as string[];
  }
  if (typeof o.failed_step === "string") entry.failed_step = o.failed_step;
  if (typeof o.failed_agent === "string") entry.failed_agent = o.failed_agent;
  // #3928 — components the roll left behind, so a `get_status` served from
  // the durable log (in-memory entry evicted) still names them.
  if (Array.isArray(o.drifted) && o.drifted.every((x) => typeof x === "string")) {
    entry.drifted = o.drifted as string[];
  }
  // Rollout phase rows (#2726) — per-phase agent/n/m context.
  if (typeof o.agent === "string") entry.agent = o.agent;
  if (typeof o.n === "number") entry.n = o.n;
  if (typeof o.m === "number") entry.m = o.m;
  // Prior-pin capture (#2492) — present only on completed rollout terminal rows.
  if (typeof o.prior_pin === "string") entry.prior_pin = o.prior_pin;
  if (
    Array.isArray(o.prior_pin_observed) &&
    o.prior_pin_observed.every((v) => typeof v === "string")
  ) {
    entry.prior_pin_observed = o.prior_pin_observed as string[];
  }
  if (typeof o.prior_pin_source === "string") {
    entry.prior_pin_source = o.prior_pin_source;
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

/**
 * #2726 — the LATEST rollout audit row for a given `request_id`, from the
 * durable log. "Latest" = the last-written row for that request among all
 * rollout ops (`rollout` + the synthetic `rollout_orphaned`), covering the
 * per-phase progress rows AND the terminal row. This is what un-blinds
 * `get_status` when the in-memory status entry is gone (hostd restarted
 * mid-roll, or the entry aged out) — the durable log is the source of truth.
 *
 * Pure: caller passes the whole log contents. Returns null when no rollout row
 * for that request_id exists. Rows are appended in order, so the last matching
 * parsed row is the most recent phase/terminal state.
 */
export function latestRolloutRowForRequest(
  raw: string,
  requestId: string,
): AuditEntry | null {
  const ROLLOUT_OPS = new Set(["rollout", "rollout_orphaned"]);
  let latest: AuditEntry | null = null;
  for (const line of raw.split("\n")) {
    const e = parseAuditLine(line);
    if (e === null) continue;
    if (e.request_id !== requestId) continue;
    if (!ROLLOUT_OPS.has(e.op)) continue;
    latest = e; // keep walking — the last match wins (most-recent).
  }
  return latest;
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
