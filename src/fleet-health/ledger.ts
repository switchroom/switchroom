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
  FleetHealthCountingUnit,
} from "../web/fleet-health-read.js";
import type { Finding } from "./detect.js";
import {
  ALL_JOB_SPECS,
  mapSignal,
  dedupKeyFor,
  issuePriority,
  countingUnitFor,
  LEGACY_COUNTING_UNIT,
  siblingDedupKeys,
} from "./mapping.js";

/** Below this occurrence count, a previously-open issue is considered fixed —
 *  it flips to `resolved-pending-verify` and its GH issue closes on the next
 *  verified scan (the RFC count-drop self-verify; e.g. 282 → ~2). */
export const RESOLVED_THRESHOLD = 3;

/** A prior ledger's issue state, keyed by dedup_key, so the writer can carry
 *  forward the GH issue number and detect a count-drop for the close path.
 *  Carries the prior issue's identity fields too, so a dedup_key that vanished
 *  from the current scan (a real fix drove its count to zero → no agg) can
 *  still be synthesized as a closed issue and routed to its job spec. */
export interface PriorIssueState {
  gh_issue?: number;
  frequency: number;
  status: FleetHealthIssue["status"];
  job_spec: string;
  failure_mode: FleetHealthIssue["failure_mode"];
  severity: number;
  /** The unit `frequency` above was counted in. A ledger written before #4680
   *  carries no field, which means the legacy one-per-log-line unit. */
  counting_unit: FleetHealthCountingUnit;
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
        job_spec: rec.job_spec,
        failure_mode: iss.failure_mode,
        severity: iss.severity,
        counting_unit: iss.counting_unit ?? LEGACY_COUNTING_UNIT,
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
  /** Authoritative frequency — every finding for this key. Tracked during the
   *  single aggregation pass to avoid an O(findings × aggs) re-filter later. */
  count: number;
  /** The unit `count` is measured in — see `countingUnitFor`. */
  counting_unit: FleetHealthCountingUnit;
}

function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** Default scan window (days) — matches `recencyFactor`'s default. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Is this finding inside the scan window ending at `now`?
 *
 * `Finding.ts` is an ISO-8601 string or null (`detect.isoFromTs` converts the
 * unix-seconds `turns.jsonl` field; `detect.extractTs` lifts the gateway log
 * line's ISO prefix; the standalone sensors stamp `now`). So the only shapes
 * that reach here are: a parseable ISO instant, an unparseable string, or null.
 *
 * Fallback for an undatable finding (null or unparseable `ts`): KEEP it. An
 * absent timestamp is not evidence of age — it is a gateway line whose prefix
 * did not match, or a `turns.jsonl` row missing `ts`. Dropping those would
 * silently erase live signal on a log-format change, which is the worse
 * failure. They cost nothing in ranking (`recencyFactor(null) === 0`, so an
 * undatable-only cluster scores 0 and cannot float to the top), but they do
 * keep contributing their frequency/reach evidence.
 */
export function withinWindow(
  ts: string | null,
  now: Date,
  windowDays: number,
): boolean {
  if (!ts) return true; // undatable → keep (see above)
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return true; // unparseable → keep
  const days =
    Number.isFinite(windowDays) && windowDays > 0
      ? windowDays
      : DEFAULT_WINDOW_DAYS;
  const ageMs = now.getTime() - t;
  // Future-dated findings (clock skew) are in-window, not stale.
  if (ageMs < 0) return true;
  return ageMs < days * 86_400_000;
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
 * all 23 job-spec records (empty ones score 0), aggregates findings into
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
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const priorIdx = indexPriorIssues(opts.prior ?? null);
  const nowIso = now.toISOString();

  // Aggregate findings by dedup_key — WITHIN THE SCAN WINDOW ONLY. `windowDays`
  // used to damp `priority_score` via `recencyFactor` alone, which floors at
  // 0.1 and never reaches zero, so a fixed-and-quiet cluster kept its full
  // historical `frequency`/`reach` and could hold the #1 rank for a whole
  // window after its last occurrence. Filtering here makes the window mean what
  // it says: only occurrences inside it count toward frequency, reach, recency
  // and therefore ranking.
  //
  // A cluster whose findings are ALL out of window produces no agg at all, so
  // it falls through to the close-on-zero path below: if it was open in the
  // prior ledger it is emitted once as a zero-frequency `closed` issue (so
  // gh-sync closes its GitHub issue) and then drops out. That is the same
  // treatment a genuinely-fixed cluster already gets, and it needs no new
  // "historical context" concept in the ledger shape.
  const aggs = new Map<string, Agg>();
  for (const f of findings) {
    if (!withinWindow(f.ts, now, windowDays)) continue;
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
        count: 0,
        counting_unit: countingUnitFor(f.signal),
      };
      aggs.set(key, agg);
    }
    agg.count += 1;
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
    // Authoritative frequency = every finding for this key (counted during the
    // single aggregation pass above; occurrences are capped-at-50 samples).
    const count = agg.count;
    const prior = priorIdx.get(agg.dedup_key);
    // #4680 — did the RULER change under this issue since the prior scan?
    // `frequency` is a count in `counting_unit`, and the self-verify below
    // compares this scan's count against the prior ledger's. When the unit
    // changes (the gateway fold switched from one-per-log-line to one-per
    // affected-turn), the number falls with NOTHING fixed: a live
    // `duplicate-delivery-represent` issue at frequency 8 over 3 turns lands
    // at 3 on the very next scan. Honouring that as a count-drop flips it to
    // `resolved-pending-verify`, closes it the scan after, and has `gh-sync`
    // post "Verified count-drop … Closed by the Fleet Health sensor." on a
    // still-broken issue — the board lying, which is the one failure this
    // ledger exists to prevent.
    const unitChanged = prior !== undefined && prior.counting_unit !== agg.counting_unit;

    let status: FleetHealthIssue["status"] = "open";
    if (unitChanged) {
      // Hold state for exactly one scan: never advance toward closure across a
      // unit change. The issue is rewritten below carrying the NEW unit, so the
      // next scan compares like with like and a genuine drop still closes it —
      // this delays a real close by one scan, it does not suppress it. Reopening
      // is still allowed (a count above the threshold clears pending-verify),
      // because that direction cannot produce a false "fixed" claim.
      status =
        count <= RESOLVED_THRESHOLD && prior.status === "resolved-pending-verify"
          ? "resolved-pending-verify"
          : "open";
    } else if (prior?.status === "resolved-pending-verify" && count <= RESOLVED_THRESHOLD) {
      // The drop held for a second scan in the same unit → verified, close it.
      status = "closed";
    } else if (prior && count <= RESOLVED_THRESHOLD && count < prior.frequency) {
      // The count DROPPED to at/below the resolved threshold → pending
      // verification.
      //
      // #4682 M1 — the test is `count < prior.frequency`, NOT
      // `prior.frequency > RESOLVED_THRESHOLD`. The two are equivalent for an
      // issue that was never held, but the unit guard above rewrites
      // `frequency` to the POST-fold count: an issue held at 3 carries a prior
      // frequency of 3 from then on, which never satisfies `> 3` again. Under
      // the old test such an issue could only ever leave the board through the
      // zero path — stale-open on GitHub however much of it got fixed, the
      // opposite of the "delayed one scan, never suppressed" guarantee the
      // guard was written to keep.
      status = "resolved-pending-verify";
    }

    // #4682 B1 — a closed GitHub issue whose defect is back in the scan needs
    // an explicit reopen: `gh issue edit` refreshes the body of a CLOSED issue
    // and leaves it closed, so without this the board states "fixed" forever
    // while the sensor keeps finding the defect every night.
    const reopened = prior?.status === "closed" && status !== "closed";

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
      ...(reopened ? { reopened: true as const } : {}),
      counting_unit: agg.counting_unit,
    };
    const list = byJob.get(agg.job_spec) ?? [];
    list.push(issue);
    byJob.set(agg.job_spec, list);
  }

  // Close-on-zero: a dedup_key that was open (or pending-verify) in the prior
  // ledger but produced NO findings this scan has no agg above. Synthesize a
  // zero-frequency `closed` issue carrying the prior GH issue number so gh-sync
  // runs `gh issue close`. This is the common success path, not an edge case:
  // without it the issue leaks open forever.
  for (const [dedup_key, prior] of priorIdx) {
    if (aggs.has(dedup_key)) continue;
    if (prior.status !== "open" && prior.status !== "resolved-pending-verify") {
      continue;
    }
    // WHY the count is zero is not always "someone fixed it". #4682 B1 — a
    // finding that RECLASSIFIED into a sibling signature (the same alarm sorted
    // by its outcome: `orphaned-db-handle` → `orphaned-db-handle-recovered`)
    // empties this key and fills the sibling's. Zero is still zero, so the
    // close is correct — but the claim gh-sync attaches to it must not be
    // "Verified count-drop", which asserts a fix nobody made. `close_reason`
    // carries the distinction to `syncIssue`.
    const migratedTo = siblingDedupKeys(dedup_key).filter((k) => aggs.has(k));
    const issue: FleetHealthIssue = {
      dedup_key,
      failure_mode: prior.failure_mode,
      severity: prior.severity,
      frequency: 0,
      reach: [],
      recency: null,
      occurrences: [],
      ...(prior.gh_issue !== undefined ? { gh_issue: prior.gh_issue } : {}),
      status: "closed",
      close_reason: migratedTo.length > 0 ? "reclassified" : "count-drop",
      ...(migratedTo.length > 0 ? { reclassified_into: migratedTo.sort() } : {}),
      // The counting-unit guard does not apply here: a unit change re-measures
      // a non-empty finding set, which can shrink a count but never empty it.
      // Reclassification is the path that CAN empty it, and `close_reason`
      // above — not the unit guard — is what keeps that honest.
      counting_unit: prior.counting_unit,
    };
    const list = byJob.get(prior.job_spec) ?? [];
    list.push(issue);
    byJob.set(prior.job_spec, list);
  }

  // Seed all 23 records; fill scored issues.
  const records: FleetHealthRecord[] = ALL_JOB_SPECS.map((job_spec) => {
    // Retain `closed` issues in the record for THIS cycle so gh-sync
    // (`syncLedgerIssues`, run by the caller after `buildLedger`) sees them and
    // runs `gh issue close`. They carry no open weight (excluded from
    // open_issue_count / priority_score below) and drop out next cycle: prior
    // status is then `closed`, so the close-on-zero synthesis skips them.
    const issues = byJob.get(job_spec) ?? [];
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
      .filter((i) => i.status !== "closed")
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
