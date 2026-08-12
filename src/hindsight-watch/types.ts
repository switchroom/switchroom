/**
 * Wire types for the hindsight watchdog's durable state. Kept in one file so
 * the state-file schema is reviewable in isolation — it is the only thing
 * that has to survive an upgrade.
 */

/**
 * Every signal the watchdog can raise. Stable ids — they key the state file.
 *
 * `retain-latency-p95` was removed before this ever shipped: hindsight's
 * exposition tops out at a 120 s `le` edge and a healthy post-#3610 backend
 * already runs 19.4 % of retains past it, so no resolvable threshold
 * distinguishes healthy from sick. The full derivation is in
 * `thresholds.ts`, where the constant used to be.
 *
 * `recall-latency` was removed twice for the same reason — the healthy
 * population it was calibrated against was itself running at the wall — and is
 * RESTORED here, on the re-baseline that removal always named as its
 * precondition (follow-up #3792). The fleet's recall was repaired on
 * 2026-08-08 and has since run p95 ~1.5 s against a ~10 s wall, so a healthy
 * band demonstrably exists now where it demonstrably did not before. The
 * derivation, and the measurement that would falsify it, are in
 * `thresholds.ts`.
 */
export type SignalId =
  | "probe" // the watchdog itself could not see hindsight
  | "retain-failure-rate" // the storm signal
  | "retain-queue-growth" // spool rising, not draining
  | "retain-loss" // memories left the queue without being persisted
  | "container" // unhealthy / restarted
  // ── recall: the READ half ────────────────────────────────────────────
  // Every signal above watches WRITES or liveness, and all of them were
  // green while the fleet's recall ran ~86 % broken for six weeks — because
  // a recall that fails is still a fast HTTP 200 with an empty body. These
  // five watch the read path, from the telemetry `recall.py` writes itself.
  | "recall-own-bank-timeout" // the agent's own bank did not answer
  | "recall-zero-memory" // recall "succeeded" and injected nothing
  | "recall-candidate-floor" // the candidate pool itself is empty
  | "recall-injected-score" // what we DID inject scores like noise
  // ── recall: degradation the four ABSOLUTE floors above cannot see ────
  // All four are collapse detectors, tuned so a working fleet never trips
  // them. That is the right shape for an outage and the wrong shape for a
  // DEGRADATION: between 2026-08-01 and 2026-08-07 recall quality fell ~5×
  // (top-hit p50 0.55 → 0.19) and not one of them moved — the score floor
  // wants ≤0.02 and the worst reading was 0.186, the pool floor wants ≤8 and
  // the pool GREW from 58 to 87. These three are relative and latency-aware
  // instead: they measure the fleet against its own recent past and against
  // the deadline it is running into.
  | "recall-latency" // recall is slow, against a wall it is not hitting
  | "recall-quality-regression" // quality fell off its OWN trailing baseline
  | "recall-deadline-pinning" // requests are being cut off, not completing
  | "consolidation-queue-age" // the async queue is not draining
  // ── consolidation: the half `consolidation-queue-age` cannot see ─────
  // `consolidation-queue-age` reads ONLY `status IN ('pending','processing')`,
  // and the failing path calls `_mark_operation_failed` within milliseconds —
  // so a bank whose consolidation fails on every attempt leaves that set
  // instantly and the signal reads OK (its detail no longer claims
  // "consolidation queue empty" — corrected in #3989 — but it still cannot
  // raise here). The metric is inverted: the more RELIABLY a bank fails, the
  // healthier `consolidation-queue-age` reads.
  // Observed live 2026-07-29, `overlord` bank: the API reported
  // `pending_operations: 0, failed_operations: 96, pending_consolidation:
  // 37711` simultaneously, for 2.5 h, with every watchdog signal green.
  | "consolidation-failure-streak" // consecutive terminal failures for one bank
  | "pending-consolidation-depth" // unconsolidated memories piling up per bank
  | "vector-index-corruption" // an HNSW index raises on a nearest-neighbour probe
  // ── the fallback that never fires ────────────────────────────────────
  | "llm-fallback-ineffective";

export const ALL_SIGNALS: SignalId[] = [
  "probe",
  "retain-failure-rate",
  "retain-queue-growth",
  "retain-loss",
  "container",
  "recall-own-bank-timeout",
  "recall-zero-memory",
  "recall-candidate-floor",
  "recall-injected-score",
  "recall-latency",
  "recall-quality-regression",
  "recall-deadline-pinning",
  "consolidation-queue-age",
  "consolidation-failure-streak",
  "pending-consolidation-depth",
  "vector-index-corruption",
  "llm-fallback-ineffective",
];

/** One probe pass, as persisted in the rolling window. */
export interface Sample {
  /** epoch ms of the probe */
  ts: number;
  /**
   * Cumulative successful retain operations (`success="true"`).
   *
   * OPTIONAL, and absent rather than zero when `/metrics` could not be
   * buffered (an over-cap body — see `MetricsTooLargeError`). Zero would mean
   * "no retains and no failures", which scores as a clean pass; absent makes
   * `retain-failure-rate` report `no-data`, which is inert.
   */
  retainOk?: number;
  /** cumulative failed retain operations (`success="false"`) — see `retainOk` */
  retainFail?: number;
  /**
   * Live spooled retains across the fleet (`*.json`).
   *
   * Post-#3610 this counts memory PARTS, not memories: one oversized
   * transcript enqueues one entry per part, where the part size is derived
   * from the retain client deadline (`retain_content_limit()`; 45,000 chars at
   * the 280s deadline #3610 shipped, 48,000 at the 310s of B7a, and 33,000
   * since #3693 sized it to a FRACTION of that deadline rather than all of it
   * — see B7a/B7b in `thresholds.ts`). Every threshold compared against it is
   * scaled by
   * `PARTS_PER_MEMORY`.
   */
  pending: number;
  /** permanently-failed spooled retains across the fleet (`*.json.dead`) */
  dead: number;
  /**
   * Entries in each agent's `pending-evicted/` archive — memory shed at the
   * queue's `MAX_ENTRIES`/`MAX_BYTES` cap (#3599). Archived, not persisted.
   */
  evicted: number;
  /**
   * Sum of the `count` field of each agent's `pending-drops.json` ledger
   * (#3599 `record_drop`) — retains that could not be written to the queue
   * at all. Monotonic per agent by construction, and a floor rather than an
   * exact tally (the ledger's own read-modify-write is unlocked).
   */
  drops: number;
  /**
   * Entries in each agent's `pending-duplicate/` archive — the redundant
   * copies `collapse_duplicates()` retired (`lib/pending.py:archive_duplicate`)
   * because a byte-identical entry was already queued. NOT a loss channel: the
   * surviving copy stays queued and the collapsed one is redundant by
   * construction, so `retain-loss` never counts it. Carried only so a large
   * collapse pass reads as a spool drain WITH a cause rather than as
   * unexplained memory loss (#3896).
   *
   * OPTIONAL on the wire — absent, not zero, in a state file written before
   * this field shipped, so `loadState`/`isSample` still accept that sample
   * instead of discarding it (which would re-baseline every signal on
   * upgrade). Absent ⇒ the collapsed-duplicate note is omitted, never shown
   * as 0.
   */
  duplicates?: number;
  /** docker `RestartCount` */
  restartCount: number;
  /** docker `State.StartedAt` — a change means restart/recreate */
  startedAt: string;
  /** docker `State.Health.Status`, or `"none"` when no healthcheck */
  health: string;
  /**
   * The recall SLI reduction for this tick, or `null` when the recall probe
   * could not run.
   *
   * Optional on the wire so a state file written by an older build still
   * loads (`loadState` would otherwise discard the whole window on upgrade
   * and re-baseline every signal). Absent ⇒ the recall signals report
   * `no-data`, which is inert — never a pass.
   */
  recall?: RecallSample | null;
  /**
   * Consolidation queue depth + oldest-entry age, or `null` when the psql
   * probe was unavailable (no client, no descriptor, container down — all
   * legitimate off-host).
   */
  consolidation?: ConsolidationSample | null;
  /**
   * Per-bank consolidation facts — terminal-failure streaks and
   * unconsolidated depth — or `null` when the psql probe was unavailable.
   *
   * Optional on the wire for the same reason `recall` is: a state file written
   * by an older build must still load rather than being discarded wholesale,
   * which would re-baseline every signal on upgrade.
   */
  banks?: BankSample | null;
  /**
   * Result of the HNSW nearest-neighbour canary, or `null` when the psql
   * probe was unavailable.
   */
  vectorIndex?: VectorIndexSample | null;
  /** cumulative successful hindsight LLM calls across every lane */
  llmOk?: number;
  /** cumulative failed hindsight LLM calls across every lane */
  llmFail?: number;
}

/**
 * The recall reduction carried in one sample. Mirrors `RecallStats` in
 * `recall-log.ts` — duplicated here rather than imported so this file stays
 * the standalone, reviewable description of the persisted schema, which is
 * the one thing that has to survive an upgrade.
 */
export interface RecallSample {
  rows: number;
  agents: number;
  timeoutConsidered: number;
  ownBankDegraded: number;
  zeroConsidered: number;
  zeroResult: number;
  poolConsidered: number;
  poolMedian: number | null;
  scoreConsidered: number;
  scoreP50: number | null;
  elapsedConsidered: number;
  elapsedP95Ms: number | null;
  /**
   * The effective recall deadline as the rows themselves report it, and how
   * many rows reported one.
   *
   * OPTIONAL on the wire even though `recall-deadline-pinning` reads
   * `deadlineEffectiveMedianMs` — which is a deliberate exception to the rule
   * `errorRows` states. A required field would make `normalizeRecallSample`
   * reject every sample persisted by an older build, re-baselining all
   * fourteen pre-existing signals on upgrade. Absent is safe here BECAUSE the
   * evaluator treats absent as `no-data`, never as a pass: an upgrade costs
   * one signal one window, not a false all-clear.
   */
  deadlineConsidered?: number;
  deadlineEffectiveMedianMs?: number | null;
  /** Diagnostic only — see `RecallStats.deadlineHitRows`. */
  deadlineHitRows?: number;
  /**
   * Diagnostic only — the modal `error` string over the window and how many
   * rows carried one. Optional (unlike every field above) precisely BECAUSE no
   * threshold reads them: a persisted sample written before this field shipped
   * must stay usable, and tolerating an absent value here cannot fail a signal
   * open. The numeric fields get no such latitude — see `normalizeRecallSample`.
   */
  errorRows?: number;
  topError?: string | null;
}

/** `async_operations` queue facts, as one tick sees them. */
export interface ConsolidationSample {
  /** rows in `pending` or `processing` */
  pending: number;
  /** age of the oldest such row, in seconds */
  oldestAgeS: number;
}

/**
 * One `(bank_id, operation_type)` pair's CONSECUTIVE terminal-failure streak:
 * the `status='failed'` rows newer than that pair's most recent
 * `status='completed'` row.
 *
 * Keyed on the pair, not on the bank, because a bank whose consolidation is
 * wedged goes on completing `retain` and `batch_retain` ops the whole time —
 * observed live during the 2026-07-29 incident, where `overlord` held 3,753
 * completed retains against 112 failed consolidations. A bank-wide streak
 * would have been broken by every successful retain and never reached 3.
 */
export interface BankFailureStreak {
  bank: string;
  operationType: string;
  /** consecutive `failed` rows since the last `completed` one for this pair */
  streak: number;
  /** seconds since the NEWEST failure in the streak — the staleness guard */
  newestFailureAgeS: number;
}

/** One bank's unconsolidated-memory depth. */
export interface BankPendingConsolidation {
  bank: string;
  /**
   * `memory_units` rows with `consolidated_at IS NULL AND fact_type IN
   * ('experience','world')` — byte-for-byte the definition the API's
   * `get_bank_freshness` uses for the `pending_consolidation` field it
   * publishes on `/v1/default/banks/{bank}/stats`
   * (`engine/memory_engine.py`, verified live 2026-07-29). Computed in the
   * same psql pass rather than over N HTTP calls: one grouped aggregate over
   * 676,720 rows measured 0.284 s, against the ~1.4-2.1 s per bank that
   * `doctor-observation-scopes.ts` pays for the `/stats` endpoint.
   */
  pending: number;
}

/** The per-bank consolidation block one tick reads. */
export interface BankSample {
  /** every pair with at least one live failure streak; empty is healthy */
  streaks: BankFailureStreak[];
  /** every bank with at least one memory unit */
  pending: BankPendingConsolidation[];
}

/**
 * The HNSW canary's result for one tick.
 *
 * `amcheck` has no HNSW support, so a nearest-neighbour probe is the only
 * available verifier for these indexes: a corrupt one raises
 * `different vector dimensions 384 and 0` when the scan walks the damaged
 * node. The damage is INSIDE the index, not in the data — `memory_units.
 * embedding` is `vector(384)`, so a zero-dimension row cannot exist in the
 * table (verified live: 0 rows with `vector_dims(embedding) <> 384`), which
 * is why no data-level check can see it either.
 */
export interface VectorIndexSample {
  /** HNSW indexes the probe successfully scanned */
  probed: number;
  /** `<indexname>=<sqlerrm>` for every index whose probe raised */
  corrupt: string[];
}

/** Per-signal hysteresis state. */
export interface SignalState {
  status: "ok" | "firing";
  /** consecutive breaching evaluations (reset by a clean one) */
  breaches: number;
  /** consecutive clean evaluations (reset by a breaching one) */
  clears: number;
  /** epoch ms the signal went firing */
  firedAt?: number;
  /** epoch ms of the last operator DM for this signal */
  lastNotifiedAt?: number;
}

/**
 * One UTC day of recall-quality observations, as the trailing baseline keeps
 * them.
 *
 * The sample ring cannot carry this: it is 8 samples capped at 3 h old
 * (`RING_MAX` / `MAX_SAMPLE_AGE_MS`), deliberately, so that a stopped cron
 * re-baselines instead of paging off a stale era. A 7-day baseline therefore
 * needs its own structure, and it needs the OPPOSITE property — surviving a
 * gap rather than being erased by one.
 *
 * Observations are the per-tick `scoreP50` / `poolMedian`, kept raw so the
 * day's representative value is a MEDIAN of them rather than a mean: one tick
 * during a restart or a deploy must not drag a whole baseline day.
 */
export interface RecallBaselineDay {
  /** `YYYY-MM-DD`, UTC. UTC and not local so the key cannot shift under DST. */
  day: string;
  /** per-tick `scoreP50` observations, newest last, capped (see `foldBaseline`) */
  scoreObs: number[];
  /** per-tick `poolMedian` observations, newest last, capped */
  poolObs: number[];
}

/**
 * The trailing recall-quality baseline. Bounded by construction: at most
 * `RECALL_BASELINE_DAYS + 1` days, each holding at most
 * `RECALL_BASELINE_MAX_OBS_PER_DAY` observations of each of two series.
 */
export interface RecallBaseline {
  /** oldest first; the last entry is TODAY and is never its own baseline */
  days: RecallBaselineDay[];
}

/** The whole durable state file. */
export interface WatchState {
  v: 1;
  /** rolling window, oldest first, capped at RING_MAX */
  ring: Sample[];
  signals: Partial<Record<SignalId, SignalState>>;
  /**
   * Trailing per-day recall quality, for `recall-quality-regression`.
   *
   * OPTIONAL on the wire so a state file written before this shipped still
   * loads. Absent ⇒ the signal reports `no-data` and the baseline starts
   * accumulating from this tick — inert for the first
   * `RECALL_BASELINE_MIN_DAYS` days, which is honest: a baseline-relative
   * signal genuinely cannot say anything until it has a baseline.
   */
  baseline?: RecallBaseline;
}

export function emptyState(): WatchState {
  return { v: 1, ring: [], signals: {} };
}

/** One signal's verdict for one evaluation. */
export interface Verdict {
  signal: SignalId;
  /**
   * `breach`   — the condition holds.
   * `ok`       — the condition does not hold.
   * `no-data`  — not enough observations to say. Neither fires nor resolves;
   *              a quiet fleet must not silently clear a live alert.
   */
  state: "breach" | "ok" | "no-data";
  /**
   * How bad the breach is. Only meaningful when `state === "breach"`.
   *
   * Two levels rather than one because the recall SLIs have a genuine middle
   * band: an own-bank timeout rate of 8 % is a real regression worth a
   * message, and 86 % is an outage. Collapsing them would force a choice
   * between a threshold that misses the first week (what happened) and one
   * that cries wolf.
   *
   * Severity does NOT change the hysteresis or the delivery path — a warn and
   * a page are both one DM after the same number of consecutive breaches.
   * It changes the wording, so the operator can triage from the notification
   * without opening a terminal.
   */
  severity?: "warn" | "page";
  /** One-line human summary with the measured value AND the threshold. */
  detail: string;
  /** Machine-readable measurement for `--json`. */
  measured?: Record<string, number | string>;
}
