/**
 * Buzz sidecar pipeline stats — the operator-visible health surface.
 *
 * The inbound pump already keeps a content-free `stats` record: one monotonic
 * counter per outcome (`injected`, `duplicate`, `queued`, `inject_failed`,
 * `unmapped`, `channel_off`, and a `rejected:<reason>` bucket per auth-gate
 * refusal). This module DERIVES an operator-facing summary from that record
 * (plus the outbound mirror counters the sidecar owns), formats it as one
 * structured log line, and drives a periodic reporter loop.
 *
 * It invents no new counting mechanism — every number is either a pump counter
 * or a sum of pump counters — so a summary field can only move because a real
 * pipeline event moved the underlying bucket. Nothing here carries message
 * content or a secret: the pump's counters never did, and the derived summary
 * is pure arithmetic over them.
 */

/**
 * Content-free summary of the Buzz pipeline. Every field is a monotonic counter
 * (or a derived sum of counters). NONE carries message content or a secret.
 */
export interface BuzzPipelineSummary {
  /** Total events handed to the pump — the sum of every outcome bucket. */
  received: number;
  /** Admitted, mapped kind:9, and injected as a turn. */
  injected: number;
  /** Already-seen ids skipped (durable journal OR pending retry). */
  duplicate: number;
  /** Inject failed and held in the volatile retry queue (MAJOR-1). */
  queued: number;
  /** Inject failed with no retry queue — relying on relay resubscribe. */
  injectFailed: number;
  /** Admitted but dropped by kind — a non-kind:9 event the mapper refused. */
  droppedByKind: number;
  /** Dropped because the channel resolved not-live at handle time. */
  channelOff: number;
  /** Refused by the auth gate (bad signature, not on the allowlist, self-echo,
   *  or malformed) — the sum of every `rejected:*` bucket. */
  authFailures: number;
  /** Outbound mirror publishes the relay ACKed. */
  mirrorOk: number;
  /** Outbound mirror publishes that failed (reported honestly, never retried). */
  mirrorFailed: number;
}

/** The two outbound-mirror counters the sidecar maintains around its publisher. */
export interface MirrorCounters {
  readonly ok: number;
  readonly failed: number;
}

const REJECT_PREFIX = "rejected:";

/**
 * Derive the operator summary from the pump's raw outcome record + the mirror
 * counters. `received` is the sum of every bucket (the pump bumps exactly one
 * bucket per `handleEvent`), and `authFailures` is the sum of the
 * `rejected:*` buckets — so both track the real pipeline, not a parallel count.
 */
export function summarizePipeline(
  pumpStats: Readonly<Record<string, number>>,
  mirror: MirrorCounters,
): BuzzPipelineSummary {
  let received = 0;
  let authFailures = 0;
  for (const [key, count] of Object.entries(pumpStats)) {
    received += count;
    if (key.startsWith(REJECT_PREFIX)) authFailures += count;
  }
  return {
    received,
    injected: pumpStats.injected ?? 0,
    duplicate: pumpStats.duplicate ?? 0,
    queued: pumpStats.queued ?? 0,
    injectFailed: pumpStats.inject_failed ?? 0,
    droppedByKind: pumpStats.unmapped ?? 0,
    channelOff: pumpStats.channel_off ?? 0,
    authFailures,
    mirrorOk: mirror.ok,
    mirrorFailed: mirror.failed,
  };
}

/** One structured, greppable stats line in the sidecar's `buzz ...:` idiom. */
export function formatStatsLine(s: BuzzPipelineSummary): string {
  return (
    `buzz stats: received=${s.received} injected=${s.injected} ` +
    `duplicate=${s.duplicate} queued=${s.queued} inject_failed=${s.injectFailed} ` +
    `dropped_by_kind=${s.droppedByKind} channel_off=${s.channelOff} ` +
    `auth_failures=${s.authFailures} mirror_ok=${s.mirrorOk} mirror_failed=${s.mirrorFailed}`
  );
}

/** A single sample: the derived summary plus the relay subscription state. */
export interface StatsSample {
  summary: BuzzPipelineSummary;
  /** Relay subscription live at sample time (nostrClient.isSubscribed()). */
  subscribed: boolean;
}

export interface StatsReporterDeps {
  /** Sample the pipeline + liveness. Called on the first beat and every tick. */
  sample: () => StatsSample;
  /** Emit one structured stats line (the sidecar's stderr logger). */
  emit: (line: string) => void;
  /** Persist a heartbeat snapshot (best-effort — MUST be crash-safe; the
   *  reporter wraps it so a write failure never disturbs the loop). */
  persist?: (sample: StatsSample) => void;
  /** Tick period in ms. Default 60_000. */
  intervalMs?: number;
  /** Injected timer (deterministic tests); default setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injected clear (deterministic tests); default clearTimeout. */
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface StatsReporter {
  /** Emit the first beat now, then tick every `intervalMs`. */
  start(): void;
  /** Stop ticking. */
  stop(): void;
  /** Sample → persist (always) → emit (only when the summary line changed).
   *  Exposed for tests and as the timer body. */
  tick(): void;
}

/**
 * Periodic stats reporter. Each tick ALWAYS persists a heartbeat (so doctor's
 * liveness probe sees a fresh beat even on an idle-but-healthy channel) but
 * only EMITS a log line when the summary changed since the last emit — so an
 * idle channel logs one line and then stays quiet instead of writing an
 * identical line every minute.
 */
export function createStatsReporter(deps: StatsReporterDeps): StatsReporter {
  const intervalMs = deps.intervalMs && deps.intervalMs > 0 ? deps.intervalMs : 60_000;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastLine: string | null = null;

  function tick(): void {
    const sample = deps.sample();
    const line = formatStatsLine(sample.summary);
    if (line !== lastLine) {
      deps.emit(line);
      lastLine = line;
    }
    // The heartbeat beats every tick regardless of change — it is the liveness
    // signal, so a quiet-but-healthy sidecar must keep refreshing it.
    try {
      deps.persist?.(sample);
    } catch {
      /* best-effort — a heartbeat write must never disturb the pipeline */
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      if (stopped) return;
      tick();
      schedule();
    }, intervalMs);
    // Don't keep the process alive solely for the stats loop (mirrors the
    // publish-timeout timers in nostr-client.ts).
    if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  }

  return {
    start(): void {
      stopped = false;
      tick(); // first beat immediately so doctor sees liveness soon after boot
      schedule();
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
    tick,
  };
}
