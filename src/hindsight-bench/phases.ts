/**
 * Server-side PHASE attribution for a recall (#4476, epic #4474 phase P2).
 *
 * ## Why this exists
 *
 * P1 (#4475) gave the epic a latency number. It did not give it a *budget*, and
 * without one every phase of the epic is graded on a hypothesis nobody can
 * falsify cheaply. #4476's acceptance criterion is "recall p95 ≥ 30 % and p99
 * ≥ 40 % below the P1 baseline" delivered by **cache residency and contention
 * isolation** — i.e. by making PostgreSQL faster. That criterion is only
 * reachable if PostgreSQL is actually where the time goes, and until this
 * module existed nothing in the repo could say whether it is.
 *
 * A Hindsight recall with `trace: true` returns
 * `trace.summary.phase_metrics[]` — a per-phase wall-clock breakdown of the
 * request handler, covering the two model stages (`generate_query_embedding`,
 * `reranking`), the SQL stage (`parallel_retrieval`), the pool and semaphore
 * waits, and the tail (`entity_build`, `token_filtering`, serialization).
 * Reducing those across a concurrency ladder turns "is the database the
 * bottleneck?" into arithmetic.
 *
 * ## The one number this module exists to produce
 *
 * {@link PhaseCell.maxDbSideGainFraction} — the fraction of **end-to-end**
 * recall latency that would disappear if every PostgreSQL call in the request
 * became instantaneous. It is an upper bound, not an estimate: it assumes a
 * perfect, physically impossible database.
 *
 * If a proposal claims an X % end-to-end reduction from database-side work and
 * `maxDbSideGainFraction < X`, the proposal is refuted by arithmetic before
 * anyone builds it. That is a deterministic mechanism replacing a judgement
 * call, which is the point.
 *
 * ## Why `arms` was not enough
 *
 * `runArmSweep` already reports per-arm SQL durations, but an arm timing is a
 * numerator with no denominator: it says the semantic arm took 84 ms and says
 * nothing about what the other 850 ms of the request were doing. It also omits
 * `reranking` and `generate_query_embedding` entirely, which is exactly where
 * this measured the time to be. Phases carry the whole request, so the shares
 * sum to something interpretable.
 *
 * ## What these timings are and are not
 *
 * They are **server-reported**, from a **traced** call. Two consequences,
 * stated rather than buried:
 *
 *  - A traced recall serialises the query embedding and every arm's full
 *    result list — megabytes of JSON. So, exactly as with `arms`, a phase
 *    cell's latency must never be compared against a `cells[]` latency. The
 *    shares are the product here; the absolute milliseconds are context.
 *  - Tracing inflates rather than deflates, and it inflates the *non*-database
 *    stages (serialization, trace finalisation) hardest. So
 *    `maxDbSideGainFraction` computed from a traced call is, if anything, an
 *    over-estimate of the database's share — which makes it a *conservative*
 *    bound when used to refute a database-side proposal.
 */

import { summarize } from "./stats.js";
import type { PhaseCell, PhaseStat } from "./types.js";

/**
 * Phases whose wall-clock is spent waiting on PostgreSQL.
 *
 * `parallel_retrieval` is the wall time of the semantic + BM25 + graph +
 * temporal arms run concurrently, so it already accounts for the arms without
 * double-counting them. The per-arm `retrieval_*` entries carry
 * `details.diagnostic = true` and OVERLAP `parallel_retrieval`; summing them in
 * would count the same wall-clock two or three times over and inflate the
 * database's apparent share. {@link isDiagnosticPhase} keeps them out.
 *
 * This list covers the NON-diagnostic spans only; see
 * {@link DB_DIAGNOSTIC_PHASES} for the database-attributable overlays.
 */
export const DB_PHASES: readonly string[] = ["parallel_retrieval"];

/**
 * Database-attributable phases that Hindsight marks `diagnostic: true`.
 *
 * `connection_wait` is time blocked acquiring a pooled connection — time a
 * database-side fix (a bigger pool, a shorter query) could genuinely remove —
 * but the engine flags it as an overlay, so it is excluded from
 * {@link ExtractedPhases.phases} and would be worth exactly zero to the DB
 * attribution if it were only looked up there. It is counted from
 * {@link ExtractedPhases.diagnostics} instead.
 *
 * This may DOUBLE-COUNT: if the pool wait happens inside `parallel_retrieval`'s
 * span, its milliseconds are added twice. That direction is chosen on purpose.
 * The number this module produces is used to REFUTE database-side proposals, so
 * every rounding decision must inflate the database's apparent share, never
 * shrink it — a refutation built on an under-count is not a refutation.
 *
 * `semaphore_wait` is deliberately NOT here. It is the model-concurrency
 * semaphore, not the connection pool; counting it as database time would
 * attribute the reranker's queueing to PostgreSQL and manufacture exactly the
 * bottleneck this pass exists to test for.
 */
export const DB_DIAGNOSTIC_PHASES: readonly string[] = ["connection_wait"];

/**
 * Phases that are diagnostic overlays rather than disjoint spans.
 *
 * Hindsight marks these with `details.diagnostic = true`; they are nested
 * inside another phase's span. Any share arithmetic must exclude them or the
 * shares stop summing to ≤ 1.
 */
export function isDiagnosticPhase(entry: unknown): boolean {
  const details = (entry as { details?: unknown })?.details;
  return (details as { diagnostic?: unknown })?.diagnostic === true;
}

/** One traced recall's server-side breakdown. */
export interface ExtractedPhases {
  /** `trace.summary.total_duration_seconds` in ms; 0 when absent. */
  serverMs: number;
  /** Non-diagnostic phase name → duration ms. These are disjoint spans. */
  phases: Map<string, number>;
  /**
   * Diagnostic overlay name → duration ms, kept SEPARATE rather than discarded.
   *
   * They must stay out of any share arithmetic (they overlap the spans in
   * {@link ExtractedPhases.phases}), but discarding them outright silently zeroes
   * `connection_wait` — a real, database-attributable wait — and a bound that
   * quietly omits database time is a bound that over-refutes.
   */
  diagnostics: Map<string, number>;
}

/**
 * Parse `trace.summary` into a phase map.
 *
 * Exported and pure so a Hindsight response-shape change is caught by a test
 * against a captured trace rather than by a silently-empty table on the next
 * production sweep — the same failure mode `extractArms` guards against.
 *
 * Unknown phase names are carried through verbatim. The engine adds phases
 * between releases and a hard-coded allow-list would drop the new one silently,
 * which is precisely how an instrument stops measuring the thing that changed.
 */
export function extractPhases(trace: unknown): ExtractedPhases {
  const summary = (trace as { summary?: unknown })?.summary;
  const totalS = Number((summary as { total_duration_seconds?: unknown })?.total_duration_seconds);
  const raw = (summary as { phase_metrics?: unknown })?.phase_metrics;
  const phases = new Map<string, number>();
  const diagnostics = new Map<string, number>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const name = (entry as { phase_name?: unknown })?.phase_name;
      const secs = Number((entry as { duration_seconds?: unknown })?.duration_seconds);
      if (typeof name !== "string" || name === "" || !Number.isFinite(secs)) continue;
      const into = isDiagnosticPhase(entry) ? diagnostics : phases;
      // Additive rather than last-wins: a handler that reports a phase twice
      // has spent time in it twice, and taking the last would silently discard
      // the first.
      into.set(name, (into.get(name) ?? 0) + secs * 1000);
    }
  }
  return { serverMs: Number.isFinite(totalS) ? totalS * 1000 : 0, phases, diagnostics };
}

/** One traced sample as the reducer consumes it. */
export interface PhaseSample {
  /** Client-observed wall-clock ms for the whole call, body fully read. */
  clientMs: number;
  extracted: ExtractedPhases;
}

/**
 * Reduce a cell's traced samples into a {@link PhaseCell}.
 *
 * Means, not percentiles, for the per-phase shares: a share is only
 * interpretable as "where the time goes" when the parts are averaged over the
 * same calls the whole is averaged over. Taking p95 of each phase separately
 * and dividing produces a ratio of order statistics drawn from different calls,
 * which sums to nothing meaningful. Each phase's p95 is carried BESIDE its mean
 * so a phase with a heavy tail (the reranker's, in practice) is still visible.
 *
 * Returns `null` for an empty sample set rather than a cell of `NaN`s — a cell
 * whose every call errored is a missing measurement, and emitting zeros for it
 * would make a broken run read as a database-free one.
 */
export function reducePhaseCell(
  bank: string,
  rows: number,
  concurrency: number,
  samples: readonly PhaseSample[],
  errors: number,
): PhaseCell | null {
  if (samples.length === 0) return null;

  const clientMsMean = mean(samples.map((s) => s.clientMs));
  const serverMsMean = mean(samples.map((s) => s.extracted.serverMs));

  const names = new Set<string>();
  for (const s of samples) for (const n of s.extracted.phases.keys()) names.add(n);

  const phases: PhaseStat[] = [];
  for (const name of [...names].sort()) {
    // Absent on a sample means the phase took no time on that call, not that
    // the call is unmeasured — so 0, and the mean stays over the same
    // denominator as every other phase.
    const vals = samples.map((s) => s.extracted.phases.get(name) ?? 0);
    const st = summarize(vals, 0);
    phases.push({
      name,
      meanMs: st.mean,
      p95Ms: st.p95,
      shareOfServer: serverMsMean > 0 ? st.mean / serverMsMean : 0,
    });
  }
  phases.sort((a, b) => b.meanMs - a.meanMs);

  const dbMsMean =
    DB_PHASES.reduce((acc, name) => acc + mean(samples.map((s) => s.extracted.phases.get(name) ?? 0)), 0) +
    DB_DIAGNOSTIC_PHASES.reduce(
      (acc, name) => acc + mean(samples.map((s) => s.extracted.diagnostics.get(name) ?? 0)),
      0,
    );

  return {
    bank,
    rows,
    concurrency,
    n: samples.length,
    errors,
    clientMsMean,
    serverMsMean,
    dbMsMean,
    dbShareOfServer: serverMsMean > 0 ? dbMsMean / serverMsMean : 0,
    // Denominator is the CLIENT-observed time on purpose. The end-to-end number
    // an agent's user waits for includes the queueing that happens before the
    // handler starts its own clock, and a bound expressed against server time
    // alone would overstate what a database fix can deliver by exactly that
    // queueing.
    maxDbSideGainFraction: clientMsMean > 0 ? dbMsMean / clientMsMean : 0,
    phases,
  };
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * The worst (largest) `maxDbSideGainFraction` across a set of phase cells.
 *
 * "Worst" from the perspective of someone trying to REFUTE a database-side
 * proposal: the bound has to hold everywhere, so the strongest cell for the
 * proposal is the one that decides whether it survives. Returns `null` for an
 * empty set — no cells is not a bound of zero.
 */
export function maxDbSideGainAcross(cells: readonly PhaseCell[]): number | null {
  if (cells.length === 0) return null;
  return Math.max(...cells.map((c) => c.maxDbSideGainFraction));
}
