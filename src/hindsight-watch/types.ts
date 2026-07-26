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
 */
export type SignalId =
  | "probe" // the watchdog itself could not see hindsight
  | "retain-failure-rate" // the storm signal
  | "retain-queue-growth" // spool rising, not draining
  | "retain-loss" // memories left the queue without being persisted
  | "container"; // unhealthy / restarted

export const ALL_SIGNALS: SignalId[] = [
  "probe",
  "retain-failure-rate",
  "retain-queue-growth",
  "retain-loss",
  "container",
];

/** One probe pass, as persisted in the rolling window. */
export interface Sample {
  /** epoch ms of the probe */
  ts: number;
  /** cumulative successful retain operations (`success="true"`) */
  retainOk: number;
  /** cumulative failed retain operations (`success="false"`) */
  retainFail: number;
  /**
   * Live spooled retains across the fleet (`*.json`).
   *
   * Post-#3610 this counts memory PARTS, not memories: one oversized
   * transcript enqueues one entry per part, where the part size is derived
   * from the retain client deadline (`retain_content_limit()`; 45,000 chars at
   * the 280s deadline #3610 shipped, 48,000 at the 310s it is now — see B7a in
   * `thresholds.ts`). Every threshold compared against it is scaled by
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
  /** docker `RestartCount` */
  restartCount: number;
  /** docker `State.StartedAt` — a change means restart/recreate */
  startedAt: string;
  /** docker `State.Health.Status`, or `"none"` when no healthcheck */
  health: string;
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

/** The whole durable state file. */
export interface WatchState {
  v: 1;
  /** rolling window, oldest first, capped at RING_MAX */
  ring: Sample[];
  signals: Partial<Record<SignalId, SignalState>>;
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
  /** One-line human summary with the measured value AND the threshold. */
  detail: string;
  /** Machine-readable measurement for `--json`. */
  measured?: Record<string, number | string>;
}
