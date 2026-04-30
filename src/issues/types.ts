/**
 * Issue sink — surface silent failures inside an agent so a Telegram
 * user can see what's broken without SSHing or asking Claude to dig
 * through journald.
 *
 * The sink is a per-agent JSONL file that any subprocess (hook,
 * shellout, periodic job) can append to without needing the gateway
 * up. The gateway watches the file and renders an "issues" card to
 * Telegram (#428) so silent failure is no longer the default.
 *
 * Phase 0.1 of #424: pure data + I/O library. No callers wired yet.
 */

export type IssueSeverity = "info" | "warn" | "error" | "critical";

/**
 * Maximum length of the `detail` field. Tail of stderr from a failing
 * hook is the primary use case — 2KB is enough to see the relevant
 * error without making the JSONL unwieldy when N events accumulate.
 */
export const DETAIL_MAX_BYTES = 2048;

/**
 * Maximum length of the `summary` field. One Telegram card row.
 */
export const SUMMARY_MAX_CHARS = 200;

/**
 * Single record in the issue store.
 *
 * `fingerprint` is the dedup key. Two events with the same fingerprint
 * coalesce: occurrences increments, last_seen updates, severity is
 * promoted to whichever is higher. detail is replaced with the most
 * recent value (latest stderr is usually the most informative).
 */
export interface IssueEvent {
  /** Unix epoch ms of the most recent occurrence. */
  ts: number;
  agent: string;
  severity: IssueSeverity;
  /** Stable identifier for the source: `hook:<name>`, `boot:<check>`, `cli:<verb>`, etc. */
  source: string;
  /** Machine-readable code, stable across instances of the same failure. */
  code: string;
  /** One-line human-readable description (capped at SUMMARY_MAX_CHARS). */
  summary: string;
  /** Optional longer detail (capped at DETAIL_MAX_BYTES, e.g. stderr tail). */
  detail?: string;
  /** Dedup key. Stable function of (source, code). */
  fingerprint: string;
  /** Number of times this fingerprint has fired. */
  occurrences: number;
  first_seen: number;
  last_seen: number;
  /** Set when the same fingerprint reports success or is manually resolved. */
  resolved_at?: number;
}

/**
 * Input shape for `record()` — caller supplies the inherent fields and
 * the store fills in fingerprint / occurrences / timestamps.
 */
export interface IssueInput {
  agent: string;
  severity: IssueSeverity;
  source: string;
  code: string;
  summary: string;
  detail?: string;
}

/**
 * Severity rank used when coalescing. Higher value = more severe; on
 * coalesce the stored severity is promoted to max(stored, incoming).
 */
export const SEVERITY_RANK: Record<IssueSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};
