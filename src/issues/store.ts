/**
 * File-backed store for the issue sink.
 *
 * Storage layout:
 *   <stateDir>/issues.jsonl   — one line per fingerprint, holding the
 *                                CURRENT state for that fingerprint.
 *                                Atomic rewrite on every mutation.
 *   <stateDir>/issues.lock    — flock target for concurrent writers.
 *
 * Why one-line-per-fingerprint instead of an append-only audit log:
 * the sink's primary consumer is the Telegram issues card (#428), which
 * needs the *current* state. Append-only would force every reader to
 * replay history; that's both slower and easier to corrupt. By
 * collapsing on write we keep reads O(N) where N is the number of
 * distinct fingerprints (small, bounded by prune).
 *
 * Why JSONL instead of a single JSON blob: each line is independently
 * parseable, so a partial write or hand-edit can't corrupt unrelated
 * entries. Atomic writes (tmpfile + rename) protect against partial
 * writes, but JSONL is the durable format the sink contract advertises
 * to outside tools.
 *
 * Concurrency: writes hold an exclusive flock on issues.lock for the
 * read-modify-write cycle. Readers don't lock — atomic rename means a
 * concurrent reader sees either the old or the new file in full.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  DETAIL_MAX_BYTES,
  SEVERITY_RANK,
  SUMMARY_MAX_CHARS,
  type IssueEvent,
  type IssueInput,
  type IssueSeverity,
} from "./types.js";
import { computeFingerprint } from "./fingerprint.js";

export const ISSUES_FILE = "issues.jsonl";
export const ISSUES_LOCK = "issues.lock";

export interface ListOptions {
  /** Only return events with last_seen >= this ts. */
  since?: number;
  /** Only return events at or above this severity. */
  minSeverity?: IssueSeverity;
  /** Default true. When true, resolved entries are filtered out. */
  unresolvedOnly?: boolean;
}

export interface PruneOptions {
  /** Drop resolved entries whose resolved_at is older than (now - ms). */
  resolvedOlderThanMs?: number;
  /** Drop unresolved entries whose last_seen is older than (now - ms).
   *  Off by default — unresolved issues stay until acknowledged. */
  unresolvedOlderThanMs?: number;
  /** Override Date.now() for tests. */
  now?: number;
}

/**
 * Read the current state from disk. Returns an empty array when the
 * file is missing or unparseable lines are encountered (skipped — the
 * sink is best-effort visibility, not a database).
 */
export function readAll(stateDir: string): IssueEvent[] {
  const path = join(stateDir, ISSUES_FILE);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: IssueEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isIssueEvent(parsed)) out.push(parsed);
    } catch {
      // Skip malformed lines; future writes will overwrite the file.
    }
  }
  return out;
}

export function list(stateDir: string, opts: ListOptions = {}): IssueEvent[] {
  const all = readAll(stateDir);
  const unresolvedOnly = opts.unresolvedOnly ?? true;
  const minRank = opts.minSeverity ? SEVERITY_RANK[opts.minSeverity] : -1;
  return all.filter((e) => {
    if (unresolvedOnly && e.resolved_at != null) return false;
    if (opts.since != null && e.last_seen < opts.since) return false;
    if (SEVERITY_RANK[e.severity] < minRank) return false;
    return true;
  });
}

/**
 * Record a new occurrence. If an unresolved entry with the same
 * fingerprint exists, coalesce: bump occurrences, update last_seen,
 * promote severity, replace detail. Otherwise append a new entry.
 *
 * Recording with the same fingerprint as a *resolved* entry creates a
 * fresh entry with occurrences=1 (the issue came back).
 *
 * Returns the resulting (post-coalesce) event for the caller's records.
 */
export function record(
  stateDir: string,
  input: IssueInput,
  nowFn: () => number = Date.now,
): IssueEvent {
  ensureDir(stateDir);
  const fingerprint = computeFingerprint(input.source, input.code);
  const now = nowFn();

  return withLock(stateDir, () => {
    const all = readAll(stateDir);
    const existingIdx = all.findIndex(
      (e) => e.fingerprint === fingerprint && e.resolved_at == null,
    );

    let result: IssueEvent;
    if (existingIdx >= 0) {
      const prev = all[existingIdx];
      const promotedSeverity =
        SEVERITY_RANK[input.severity] > SEVERITY_RANK[prev.severity]
          ? input.severity
          : prev.severity;
      result = {
        ...prev,
        ts: now,
        severity: promotedSeverity,
        summary: capSummary(input.summary),
        detail: capDetail(input.detail),
        occurrences: prev.occurrences + 1,
        last_seen: now,
      };
      all[existingIdx] = result;
    } else {
      result = {
        ts: now,
        agent: input.agent,
        severity: input.severity,
        source: input.source,
        code: input.code,
        summary: capSummary(input.summary),
        detail: capDetail(input.detail),
        fingerprint,
        occurrences: 1,
        first_seen: now,
        last_seen: now,
      };
      all.push(result);
    }

    writeAll(stateDir, all);
    return result;
  });
}

/**
 * Mark all unresolved entries with this fingerprint resolved. No-op
 * (and idempotent) if none exist or all are already resolved. Returns
 * the number of entries flipped.
 */
export function resolve(
  stateDir: string,
  fingerprint: string,
  nowFn: () => number = Date.now,
): number {
  if (!existsSync(join(stateDir, ISSUES_FILE))) return 0;
  return withLock(stateDir, () => {
    const all = readAll(stateDir);
    const now = nowFn();
    let flipped = 0;
    for (const e of all) {
      if (e.fingerprint === fingerprint && e.resolved_at == null) {
        e.resolved_at = now;
        flipped++;
      }
    }
    if (flipped > 0) writeAll(stateDir, all);
    return flipped;
  });
}

/**
 * Drop entries per the retention rules. Resolved entries older than
 * `resolvedOlderThanMs` always go. Unresolved entries are kept by
 * default (silence on a stuck issue would defeat the sink's purpose).
 *
 * Returns the number of entries removed.
 */
export function prune(stateDir: string, opts: PruneOptions = {}): number {
  if (!existsSync(join(stateDir, ISSUES_FILE))) return 0;
  return withLock(stateDir, () => {
    const all = readAll(stateDir);
    const now = opts.now ?? Date.now();
    const resolvedThreshold =
      opts.resolvedOlderThanMs != null ? now - opts.resolvedOlderThanMs : null;
    const unresolvedThreshold =
      opts.unresolvedOlderThanMs != null
        ? now - opts.unresolvedOlderThanMs
        : null;

    const kept: IssueEvent[] = [];
    let removed = 0;
    for (const e of all) {
      if (e.resolved_at != null && resolvedThreshold != null) {
        if (e.resolved_at < resolvedThreshold) {
          removed++;
          continue;
        }
      }
      if (e.resolved_at == null && unresolvedThreshold != null) {
        if (e.last_seen < unresolvedThreshold) {
          removed++;
          continue;
        }
      }
      kept.push(e);
    }
    if (removed > 0) writeAll(stateDir, kept);
    return removed;
  });
}

// ─── internals ───────────────────────────────────────────────────────────────

function ensureDir(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
}

function writeAll(stateDir: string, events: IssueEvent[]): void {
  const path = join(stateDir, ISSUES_FILE);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const body =
    events.length === 0
      ? ""
      : events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(tmp, body, "utf-8");
  renameSync(tmp, path);
}

/**
 * Hold an exclusive lock on issues.lock for the duration of `fn`.
 *
 * We use the existence of a lock *file* (created with `openSync` and
 * the `wx` flag) rather than `flock(2)` so the implementation works on
 * platforms without `flock` and stays in pure Node fs. Spin-wait with
 * short backoff is acceptable: the critical section is a few KB of
 * read-parse-write, contention is rare, and a stuck lock self-heals
 * after MAX_LOCK_AGE_MS.
 */
const MAX_LOCK_AGE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

function withLock<T>(stateDir: string, fn: () => T): T {
  const lockPath = join(stateDir, ISSUES_LOCK);
  const startedAt = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      // Lock exists. If it's stale, steal it.
      try {
        const lockMtime = (
          require("node:fs") as typeof import("node:fs")
        ).statSync(lockPath).mtimeMs;
        if (Date.now() - lockMtime > MAX_LOCK_AGE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock file vanished between our exists check and stat — retry.
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`issues store: lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  // Busy-loop is acceptable here — lock wait is bounded and rare. Avoids
  // pulling in a worker / atomics dependency for a few-ms wait.
  while (Date.now() < end) {
    /* spin */
  }
}

function capSummary(s: string): string {
  if (s.length <= SUMMARY_MAX_CHARS) return s;
  return s.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
}

function capDetail(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= DETAIL_MAX_BYTES) return s;
  // Truncate to byte budget and decode, dropping any partial multi-byte
  // codepoint at the boundary.
  return buf.subarray(0, DETAIL_MAX_BYTES).toString("utf-8") + "…";
}

function isIssueEvent(v: unknown): v is IssueEvent {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ts === "number" &&
    typeof o.agent === "string" &&
    typeof o.severity === "string" &&
    typeof o.source === "string" &&
    typeof o.code === "string" &&
    typeof o.summary === "string" &&
    typeof o.fingerprint === "string" &&
    typeof o.occurrences === "number" &&
    typeof o.first_seen === "number" &&
    typeof o.last_seen === "number"
  );
}
