/**
 * Wire types for the hindsight watchdog's durable state. Kept in one file so
 * the state-file schema is reviewable in isolation — it is the only thing
 * that has to survive an upgrade.
 */

/** Every signal the watchdog can raise. Stable ids — they key the state file. */
export type SignalId =
  | "probe" // the watchdog itself could not see hindsight
  | "retain-failure-rate" // the storm signal
  | "retain-queue-growth" // spool rising, not draining
  | "retain-dead" // permanently-lost memories appeared
  | "container" // unhealthy / restarted
  | "retain-latency-p95"; // early warning ahead of timeouts

export const ALL_SIGNALS: SignalId[] = [
  "probe",
  "retain-failure-rate",
  "retain-queue-growth",
  "retain-dead",
  "container",
  "retain-latency-p95",
];

/** One probe pass, as persisted in the rolling window. */
export interface Sample {
  /** epoch ms of the probe */
  ts: number;
  /** cumulative successful retain operations (`success="true"`) */
  retainOk: number;
  /** cumulative failed retain operations (`success="false"`) */
  retainFail: number;
  /** cumulative retain-duration histogram, `le` → count */
  retainBuckets: Record<string, number>;
  /** live spooled retains across the fleet (`*.json`) */
  pending: number;
  /** permanently-failed spooled retains across the fleet (`*.json.dead`) */
  dead: number;
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
