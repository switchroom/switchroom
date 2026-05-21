/**
 * audit-reader — pure-functional helpers for reading and filtering the vault
 * audit log.
 *
 * The audit log is newline-delimited JSON written by audit-log.ts.
 * This module parses, filters, and formats entries for the CLI.
 *
 * No I/O here — accepts raw lines and returns formatted strings.
 * The CLI in src/cli/vault-audit.ts handles file reading.
 */

import type { AuditEntry, AuditOp } from "./broker/audit-log.js";

export interface AuditFilters {
  /**
   * Filter by caller substring match (e.g. "my-agent").
   * Compared case-insensitively against the `caller` and `agent_name`
   * fields (see #1420).
   */
  who?: string;

  /**
   * Filter by key name.  Treated as a regex; falls back to substring match
   * when the string is not a valid regex.
   */
  key?: string;

  /**
   * When true, only include entries where result starts with "denied".
   */
  denied?: boolean;
}

/**
 * Parse a raw JSON line from the audit log.
 * Returns null when the line is not valid JSON or missing required fields.
 */
export function parseAuditLine(line: string): AuditEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    // Require at minimum ts, op, caller, pid, result
    if (
      typeof obj.ts !== "string" ||
      typeof obj.op !== "string" ||
      typeof obj.caller !== "string" ||
      typeof obj.pid !== "number" ||
      typeof obj.result !== "string"
    ) {
      return null;
    }
    return {
      ts: obj.ts,
      op: obj.op as AuditOp,
      key: typeof obj.key === "string" ? obj.key : undefined,
      caller: obj.caller,
      pid: obj.pid,
      cgroup: typeof obj.cgroup === "string" ? obj.cgroup : undefined,
      // sec WS10-F6 (#1420): `agent_name` is the socket-path-derived
      // TRUSTED identity (the ACL field). Pre-#1420 parseAuditLine
      // dropped it, so every consumer attributed by `caller` (cgroup
      // unit OR `pid:<n>` — frequently null/legacy post-docker, #1383
      // identity drift). Surface it so it can be the canonical
      // attribution; caller/cgroup are informational.
      agent_name:
        typeof obj.agent_name === "string" ? obj.agent_name : undefined,
      result: obj.result,
    };
  } catch {
    return null;
  }
}

/**
 * Apply filters to a list of parsed AuditEntry objects.
 * Returns only entries that pass all specified filters.
 */
export function filterAuditEntries(
  entries: AuditEntry[],
  filters: AuditFilters
): AuditEntry[] {
  let result = entries;

  if (filters.who !== undefined) {
    const needle = filters.who.toLowerCase();
    // sec WS10-F6 (#1420): match the canonical trusted agent_name too,
    // not just the informational caller — otherwise filtering by an
    // agent's real name misses rows where caller drifted to pid:<n>.
    result = result.filter(
      (e) =>
        e.caller.toLowerCase().includes(needle) ||
        (e.agent_name?.toLowerCase().includes(needle) ?? false),
    );
  }

  if (filters.key !== undefined) {
    let keyRe: RegExp | null = null;
    try {
      keyRe = new RegExp(filters.key, "i");
    } catch {
      // Not a valid regex — use substring match
      keyRe = null;
    }
    const keyNeedle = filters.key.toLowerCase();
    result = result.filter((e) => {
      if (!e.key) return false;
      if (keyRe) return keyRe.test(e.key);
      return e.key.toLowerCase().includes(keyNeedle);
    });
  }

  if (filters.denied) {
    result = result.filter((e) => e.result.startsWith("denied"));
  }

  return result;
}

/**
 * Format a single AuditEntry as a human-readable line.
 *
 * Format: timestamp · op · key · who · result
 *
 * sec WS10-F6 (#1420): `who` is the TRUSTED `agent_name`
 * (socket-path-derived, the ACL field) when present, falling back to
 * the informational `caller` (cgroup unit / `pid:<n>`) only on the
 * legacy/host paths where no agent_name was recorded. Pre-#1420 this
 * displayed `caller` unconditionally, so post-docker identity drift
 * (#1383) routinely showed `pid:<n>` for a known agent.
 */
export function formatAuditEntry(entry: AuditEntry): string {
  // Shorten ISO timestamp to local-ish display: "2026-04-28 14:33:00"
  const ts = entry.ts.replace("T", " ").replace(/\.\d+Z$/, "Z").replace("Z", "");

  const op = entry.op.padEnd(8);
  const key = (entry.key ?? "(no key)").padEnd(28);
  // Canonical attribution: trusted agent_name first, caller as fallback.
  const whoRaw = entry.agent_name ?? entry.caller;
  const who =
    whoRaw.length > 50 ? whoRaw.slice(0, 47) + "..." : whoRaw;
  const whoPadded = who.padEnd(52);
  const result = entry.result;

  return `${ts}  ${op}  ${key}  ${whoPadded}  ${result}`;
}

/**
 * Parse, filter, and format audit log lines.
 *
 * @param rawLines - Raw lines from the audit log file (may include blanks/garbage)
 * @param filters  - Filters to apply
 * @param limit    - Maximum number of entries to return (applied after filtering)
 * @returns Array of formatted human-readable lines
 */
export function formatAuditLines(
  rawLines: string[],
  filters: AuditFilters,
  limit = 50
): string[] {
  const parsed = rawLines
    .map(parseAuditLine)
    .filter((e): e is AuditEntry => e !== null);

  const filtered = filterAuditEntries(parsed, filters);

  // Take the last `limit` entries (most recent).
  const limited = filtered.slice(-limit);

  return limited.map(formatAuditEntry);
}
