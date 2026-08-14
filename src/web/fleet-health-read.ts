import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Fleet Health — the operator-facing, job-spec-anchored issue tracker.
 *
 * Design: `reference/rfcs/fleet-health.md`; serves the job spec
 * `reference/jobs/fleet-stays-healthy.md` (outcome `always-available`).
 *
 * This module is the typed, read-only reader over the health ledger. The
 * ledger is per-deployment state written by the operator-assigned owner
 * agent's nightly model-free sensor; it lives OUTSIDE the repo at
 * `~/.switchroom/fleet-health/ledger.json` (never committed — same rule as
 * agent scaffolds and the scheduler ledger). The web container mounts it
 * read-only. Everything here degrades to a clearly-marked empty state when
 * the ledger is absent (feature inert — no owner agent assigned yet) or
 * unreadable, so the page always renders and is testable without a live
 * pipeline.
 */

/** One distinct problem detected against a job spec, with hard-artifact
 *  evidence (turn ids + log pointers) the operator can independently
 *  verify. `failure_mode` is from the RFC's taxonomy; `severity` 1-3. */
export interface FleetHealthOccurrence {
  agent: string;
  /** origin_turn_id, e.g. `12345:_#12673` — the join key across
   *  turns.jsonl, the gateway log, and the transcript. */
  turn_id: string;
  /** A pointer into the gateway/turns log the operator can grep. */
  log_pointer?: string;
}

export type FleetHealthFailureMode =
  | "silent-no-op"
  | "success-theater"
  | "partial"
  | "wrong-but-plausible"
  | "missed-trigger"
  | "constraint-violation"
  | "duplicate"
  | "drift"
  | "spec-side-failure";

export type FleetHealthIssueStatus =
  | "open"
  | "resolved-pending-verify"
  | "closed";

/** The unit `frequency` counts in. `log-line` is one occurrence per matching
 *  log line; `gateway-event` is one occurrence per distinct affected turn (the
 *  #4680 gateway fold). The ledger's count-drop self-verify may only compare
 *  two scans measured in the SAME unit — see `countingUnitFor` in
 *  `src/fleet-health/mapping.ts` and the guard in `buildLedger`. */
export type FleetHealthCountingUnit = "log-line" | "gateway-event";

export interface FleetHealthIssue {
  /** Stable de-dup key — one GitHub issue per key, updated not re-created. */
  dedup_key: string;
  failure_mode: FleetHealthFailureMode;
  /** 1-3 (3 = did the wrong thing / nothing while reporting success). */
  severity: number;
  /** Occurrences of this dedup_key in the scan window. */
  frequency: number;
  /** Distinct agents exhibiting the issue. */
  reach: string[];
  /** ISO timestamp of the newest occurrence. */
  recency: string | null;
  /** Hard-artifact evidence links. */
  occurrences: FleetHealthOccurrence[];
  /** Linked GitHub issue number (identify + resolve system-of-record). */
  gh_issue?: number;
  status: FleetHealthIssueStatus;
  /** The unit `frequency` was counted in on the scan that wrote this issue.
   *  Absent on a ledger written before #4680, which means `log-line`. */
  counting_unit?: FleetHealthCountingUnit;
}

/** One persistent record per job spec (23 of them). */
export interface FleetHealthRecord {
  /** The `reference/jobs/<slug>.md` id — join key to the spec + GH label. */
  job_spec: string;
  open_issue_count: number;
  /** ISO timestamp of the last nightly sensor pass. */
  last_scanned: string | null;
  /** severity × frequency × reach × recency (see RFC). Higher = worse. */
  priority_score: number;
  /** Linked GitHub issue numbers for this job. */
  gh_issues: number[];
  /** ISO timestamp of the last L2 Opus deep-dive (null if never). */
  last_deep_dive: string | null;
  /** The distinct problems, each with its evidence. */
  issues: FleetHealthIssue[];
}

/** On-disk ledger shape (`~/.switchroom/fleet-health/ledger.json`). */
export interface FleetHealthLedger {
  /** Owner agent that runs the sensor + deep-dive crons (attribution). */
  owner_agent?: string;
  /** ISO timestamp of the most recent sensor pass across the fleet. */
  generated_at?: string;
  /** L3 weekly-synthesis summary rendered in the page header. */
  summary?: string;
  records: FleetHealthRecord[];
}

/** The dashboard payload the Fleet Health page consumes. Records are
 *  ranked worst-first by `priority_score`. `empty` marks the inert state
 *  (no ledger yet — no owner agent assigned) so the UI can render a clear
 *  "not wired up" panel rather than a blank table. */
export interface FleetHealthDashboard {
  owner_agent: string | null;
  generated_at: string | null;
  summary: string | null;
  records: FleetHealthRecord[];
  empty: boolean;
  /** Present only in the empty/degraded state — tells the operator why. */
  reason?: string;
}

/**
 * Resolve the ledger path. `~/.switchroom/fleet-health/ledger.json` by
 * default; the `home` arg (or `SWITCHROOM_HOME` / `HOME`) is injectable so
 * tests point at a tmpdir and never touch the operator's live tree.
 */
export function fleetHealthLedgerPath(
  home: string = process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(),
): string {
  return resolve(home, ".switchroom", "fleet-health", "ledger.json");
}

const EMPTY_REASON =
  "Fleet Health is not wired up yet — no ledger at " +
  "~/.switchroom/fleet-health/ledger.json. Assign an owner agent " +
  "(`fleet_health.owner_agent` in switchroom.yaml) and schedule its " +
  "nightly sensor cron. See reference/rfcs/fleet-health.md.";

/**
 * Read the ledger from `path` and produce the dashboard payload, records
 * ranked worst-first by `priority_score`. Missing / unreadable / malformed
 * ledger → a clearly-marked empty state (never a throw), so the page always
 * renders. Exported for direct unit coverage (mirrors readContextOccupancy /
 * agentBridgeAlive: degrade-to-safe, no exceptions escape).
 */
export function readFleetHealth(path: string): FleetHealthDashboard {
  let ledger: FleetHealthLedger;
  try {
    ledger = JSON.parse(readFileSync(path, "utf-8")) as FleetHealthLedger;
  } catch {
    return {
      owner_agent: null,
      generated_at: null,
      summary: null,
      records: [],
      empty: true,
      reason: EMPTY_REASON,
    };
  }

  const rawRecords = Array.isArray(ledger.records) ? ledger.records : [];
  // Normalize `priority_score` to a finite number so a malformed ledger
  // (missing / string / NaN / Infinity score) never emits a non-number,
  // which would crash the render side.
  const records = rawRecords.map((r) => {
    const n = Number(r?.priority_score);
    return { ...r, priority_score: Number.isFinite(n) ? n : 0 };
  });
  // Rank worst-first.
  const ranked = [...records].sort(
    (a, b) => b.priority_score - a.priority_score,
  );

  return {
    owner_agent: ledger.owner_agent ?? null,
    generated_at: ledger.generated_at ?? null,
    summary: ledger.summary ?? null,
    records: ranked,
    empty: ranked.length === 0,
    ...(ranked.length === 0 ? { reason: EMPTY_REASON } : {}),
  };
}

/**
 * Dashboard handler — resolves the default ledger path and reads it. `path`
 * is injectable for tests. Read-only: no model call, no host mutation, no
 * network (the optional GitHub-status enrichment is layered on the client
 * side per the RFC, off this always-available local read).
 */
export function handleGetFleetHealth(
  path: string = fleetHealthLedgerPath(),
): FleetHealthDashboard {
  return readFleetHealth(path);
}
