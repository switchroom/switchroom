/**
 * Fleet Health — the ledger writer. Aggregates the model-free detector's
 * findings (across all agents) into the exact on-disk shape the read-side
 * (`src/web/fleet-health-read.ts`) consumes: one record per job spec, distinct
 * issues keyed by dedup_key, priority scored per the RFC.
 *
 * Design: `reference/rfcs/fleet-health.md`. Pure aggregation — no I/O, no
 * model call — so it round-trips cleanly under test (`readFleetHealth` accepts
 * exactly what `buildLedger` emits).
 */

import type {
  FleetHealthLedger,
  FleetHealthRecord,
  FleetHealthIssue,
  FleetHealthOccurrence,
} from "../web/fleet-health-read.js";
import type { Finding } from "./detect.js";
import {
  ALL_JOB_SPECS,
  mapSignal,
  dedupKeyFor,
  issuePriority,
} from "./mapping.js";

/** Below this occurrence count, a previously-open issue is considered fixed —
 *  it flips to `resolved-pending-verify` and its GH issue closes on the next
 *  verified scan (the RFC count-drop self-verify; e.g. 282 → ~2). */
export const RESOLVED_THRESHOLD = 3;

/** A prior ledger's issue state, keyed by dedup_key, so the writer can carry
 *  forward the GH issue number and detect a count-drop for the close path. */
export interface PriorIssueState {
  gh_issue?: number;
  frequency: number;
  status: FleetHealthIssue["status"];
}

export function indexPriorIssues(
  prior: FleetHealthLedger | null,
): Map<string, PriorIssueState> {
  const idx = new Map<string, PriorIssueState>();
  if (!prior?.records) return idx;
  for (const rec of prior.records) {
    for (const iss of rec.issues ?? []) {
      idx.set(iss.dedup_key, {
        gh_issue: iss.gh_issue,
        frequency: iss.frequency,
        status: iss.status,
      });
    }
  }
  return idx;
}

interface Agg {
  dedup_key: string;
  job_spec: string;
  failure_mode: FleetHealthIssue["failure_mode"];
  severity: number;
  occurrences: FleetHealthOccurrence[];
  reach: Set<string>;
  newest: string | null;
}

function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export interface BuildLedgerOptions {
  ownerAgent?: string;
  now?: Date;
  windowDays?: number;
  prior?: FleetHealthLedger | null;
  summary?: string;
}

/**
 * Build the full ledger from a flat list of findings across the fleet. Seeds
 * all 22 job-spec records (empty ones score 0), aggregates findings into
 * distinct issues by dedup_key, computes each issue's priority contribution,
 * and rolls the record's `priority_score` up as the max of its issues' scores
 * (the worst open problem drives the ranking — matches "severity of the worst
 * open issue" the page shows). Carries forward GH issue numbers from `prior`
 * and applies the count-drop status transition.
 */
export function buildLedger(
  findings: Finding[],
  opts: BuildLedgerOptions = {},
): FleetHealthLedger {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const priorIdx = indexPriorIssues(opts.prior ?? null);
  const nowIso = now.toISOString();

  // Aggregate findings by dedup_key.
  const aggs = new Map<string, Agg>();
  for (const f of findings) {
    const m = mapSignal(f.signal);
    const key = dedupKeyFor(f);
    let agg = aggs.get(key);
    if (!agg) {
      agg = {
        dedup_key: key,
        job_spec: m.job_spec,
        failure_mode: m.failure_mode,
        severity: m.severity,
        occurrences: [],
        reach: new Set(),
        newest: null,
      };
      aggs.set(key, agg);
    }
    agg.reach.add(f.agent);
    agg.newest = newer(agg.newest, f.ts);
    // Cap stored occurrences to keep the ledger bounded; the count is the
    // authoritative frequency (occurrences are evidence samples).
    if (agg.occurrences.length < 50) {
      agg.occurrences.push({
        agent: f.agent,
        turn_id: f.turn_id,
        log_pointer: f.log_pointer,
      });
    }
  }

  // Group aggregated issues by job spec.
  const byJob = new Map<string, FleetHealthIssue[]>();
  for (const agg of aggs.values()) {
    // Authoritative frequency = every finding for this key (occurrences are
    // capped-at-50 evidence samples; the count is not).
    const count = findings.filter(
      (f) => dedupKeyFor(f) === agg.dedup_key,
    ).length;
    const prior = priorIdx.get(agg.dedup_key);

    let status: FleetHealthIssue["status"] = "open";
    if (count <= RESOLVED_THRESHOLD && prior && prior.frequency > RESOLVED_THRESHOLD) {
      // count dropped after a fix → pending verification.
      status = "resolved-pending-verify";
    } else if (prior?.status === "resolved-pending-verify" && count <= RESOLVED_THRESHOLD) {
      status = "closed";
    }

    const issue: FleetHealthIssue = {
      dedup_key: agg.dedup_key,
      failure_mode: agg.failure_mode,
      severity: agg.severity,
      frequency: count,
      reach: [...agg.reach].sort(),
      recency: agg.newest,
      occurrences: agg.occurrences,
      ...(prior?.gh_issue !== undefined ? { gh_issue: prior.gh_issue } : {}),
      status,
    };
    const list = byJob.get(agg.job_spec) ?? [];
    list.push(issue);
    byJob.set(agg.job_spec, list);
  }

  // Seed all 22 records; fill scored issues.
  const records: FleetHealthRecord[] = ALL_JOB_SPECS.map((job_spec) => {
    const issues = (byJob.get(job_spec) ?? []).filter(
      (i) => i.status !== "closed",
    );
    const openIssues = issues.filter((i) => i.status === "open");
    const priority_score = issues.reduce((max, i) => {
      const s = issuePriority(
        i.severity,
        i.frequency,
        i.reach.length,
        i.recency,
        now,
        windowDays,
      );
      return Math.max(max, s);
    }, 0);
    const gh_issues = issues
      .map((i) => i.gh_issue)
      .filter((n): n is number => typeof n === "number");
    return {
      job_spec,
      open_issue_count: openIssues.length,
      last_scanned: nowIso,
      priority_score: Number(priority_score.toFixed(4)),
      gh_issues,
      last_deep_dive: findLastDeepDive(opts.prior ?? null, job_spec),
      issues,
    };
  });

  return {
    ...(opts.ownerAgent ? { owner_agent: opts.ownerAgent } : {}),
    generated_at: nowIso,
    ...(opts.summary ? { summary: opts.summary } : {}),
    records,
  };
}

function findLastDeepDive(
  prior: FleetHealthLedger | null,
  job_spec: string,
): string | null {
  if (!prior?.records) return null;
  const rec = prior.records.find((r) => r.job_spec === job_spec);
  return rec?.last_deep_dive ?? null;
}
