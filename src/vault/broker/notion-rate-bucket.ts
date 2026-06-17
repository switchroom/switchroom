/**
 * Notion rate-bucket primitive — RFC reference/rfcs/notion-integration.md §7.
 *
 * Pure token-bucket implementation, shared globally by the broker
 * across all agents that consume the same integration token. Not yet
 * wired into the broker's IPC verb surface (that lands in PR 3 along
 * with the consumer side in the PreToolUse hook). PR 2 ships the
 * primitive standalone with full unit-test coverage so the wire-up in
 * PR 3 is a thin glue layer.
 *
 * **Why a bucket and not just propagating 429s**: §7 of the RFC has
 * the math. The hook in PR 3 makes 2+ API calls per write (parent-DB
 * resolver walk) plus N calls per search (post-filter), so a single
 * agent's multi-step turn easily exceeds 3 rps. Across multiple
 * agents (which all share one integration token) the worst case is
 * worse. A central bucket bounds the burst at the value of `capacity`.
 *
 * **Tokens vs requests**: 1 token = 1 outbound Notion REST call. The
 * bucket fills at `refillRatePerSec` tokens/sec, capped at `capacity`.
 * `acquire()` returns immediately if a token is available, otherwise
 * waits up to `maxWaitMs` and returns true. If still no token, returns
 * false — caller surfaces 429-equivalent to the agent rather than
 * blocking longer than Notion's own retry-after would have implied.
 *
 * **Single-process scope**: The bucket lives in the broker's
 * in-memory state. There is exactly one vault-broker per host, so
 * "single process" equals "fleet-wide single source of truth" — the
 * shared-state requirement the RFC calls for. If the broker
 * restarts, the bucket resets to full capacity (acceptable: any
 * in-flight Notion calls finish on their own; a fresh budget is the
 * safe failure mode).
 */

import { setTimeout as setTimeoutPromise } from "node:timers/promises";

export interface NotionRateBucketOptions {
  /**
   * Max tokens the bucket holds. Default 3 — Notion's documented
   * burst capacity. Operators can override via
   * `notion_workspace.rate_limit_rps` (which sets BOTH capacity and
   * refill rate to the same value, matching Notion's documented
   * "3 rps, no documented burst" behaviour).
   */
  capacity?: number;
  /**
   * Refill rate in tokens per second. Default matches capacity.
   */
  refillRatePerSec?: number;
  /**
   * Max time `acquire()` waits for a token before returning false.
   * Default 1000 ms — longer than Notion's typical retry-after, short
   * enough that the calling agent's tool-use loop doesn't appear to
   * wedge.
   */
  maxWaitMs?: number;
  /** Injectable now() for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface PendingAcquire {
  /** When the caller began waiting (ms). */
  enqueuedAt: number;
  /** Resolves with true on success, false on timeout. */
  resolve: (granted: boolean) => void;
  /** Set by the timeout — when fired, marks this request as expired. */
  timeoutHandle: NodeJS.Timeout;
}

export class NotionRateBucket {
  readonly capacity: number;
  readonly refillRatePerSec: number;
  readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Current token count (float — refill increments fractionally). */
  private tokens: number;
  /** Last time `tokens` was advanced via refill (ms). */
  private lastRefillAt: number;
  /** FIFO queue of pending acquires. */
  private readonly waiters: PendingAcquire[] = [];

  /** Total successful acquires since construction. */
  totalAcquired = 0;
  /** Total acquires that timed out. */
  totalDenied = 0;
  /** Largest queue depth observed. */
  peakQueueDepth = 0;

  constructor(opts: NotionRateBucketOptions = {}) {
    const capacity = opts.capacity ?? 3;
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(
        `NotionRateBucket: capacity must be a positive number, got ${capacity}`,
      );
    }
    const refill = opts.refillRatePerSec ?? capacity;
    if (!Number.isFinite(refill) || refill <= 0) {
      throw new Error(
        `NotionRateBucket: refillRatePerSec must be a positive number, got ${refill}`,
      );
    }
    this.capacity = capacity;
    this.refillRatePerSec = refill;
    this.maxWaitMs = opts.maxWaitMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ?? ((ms: number) => setTimeoutPromise(ms, undefined));

    this.tokens = capacity;
    this.lastRefillAt = this.now();
  }

  /**
   * Compute new tokens earned since `lastRefillAt` and bump `tokens`,
   * clamped to `capacity`. No-op if zero elapsed. Idempotent — safe
   * to call from any state-mutating method.
   */
  private refill(): void {
    const t = this.now();
    const elapsedMs = t - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    const earned = (elapsedMs / 1000) * this.refillRatePerSec;
    this.tokens = Math.min(this.capacity, this.tokens + earned);
    this.lastRefillAt = t;
  }

  /**
   * Try to acquire one token immediately, no waiting. Returns true if
   * granted. Used by tests + the synchronous probe path.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.totalAcquired += 1;
      return true;
    }
    return false;
  }

  /**
   * Acquire one token, waiting up to `maxWaitMs` if necessary.
   * Returns true on success, false on timeout.
   *
   * Concurrent callers FIFO into a queue. The bucket scans the queue
   * each time tokens become available and grants in order.
   */
  async acquire(): Promise<boolean> {
    this.refill();
    // Fast path — token available right now.
    if (this.tokens >= 1 && this.waiters.length === 0) {
      this.tokens -= 1;
      this.totalAcquired += 1;
      return true;
    }

    // Slow path — enqueue and wait.
    return await new Promise<boolean>((resolve) => {
      const handle = setTimeout(() => {
        // Remove from waiters (may already have been removed by the
        // refill loop if granted just before the timeout fired).
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          this.totalDenied += 1;
          resolve(false);
        }
      }, this.maxWaitMs);
      this.waiters.push({
        enqueuedAt: this.now(),
        resolve,
        timeoutHandle: handle,
      });
      this.peakQueueDepth = Math.max(this.peakQueueDepth, this.waiters.length);

      // Kick the scheduler — refills are time-based, so wake at the
      // earliest moment a token might be available.
      this.scheduleNextWake();
    });
  }

  /**
   * Schedule a wake to re-scan waiters when the next token is
   * projected to be available. Idempotent — multiple back-to-back
   * acquires don't stack timers.
   */
  private scheduleWakeTimer: NodeJS.Timeout | null = null;
  private scheduleNextWake(): void {
    if (this.scheduleWakeTimer !== null) return;
    if (this.waiters.length === 0) return;

    this.refill();
    const tokensNeeded = Math.max(0, 1 - this.tokens);
    const msUntilOne = (tokensNeeded / this.refillRatePerSec) * 1000;
    // Always wait at least 1 ms to avoid tight-loop with setImmediate.
    const wait = Math.max(1, Math.ceil(msUntilOne));

    this.scheduleWakeTimer = setTimeout(() => {
      this.scheduleWakeTimer = null;
      this.serviceWaiters();
    }, wait);
  }

  /**
   * Hand tokens to waiters in FIFO order. Called from the wake timer.
   * If more waiters remain after a pass, schedule another wake.
   */
  private serviceWaiters(): void {
    this.refill();
    while (this.waiters.length > 0 && this.tokens >= 1) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timeoutHandle);
      this.tokens -= 1;
      this.totalAcquired += 1;
      w.resolve(true);
    }
    if (this.waiters.length > 0) {
      this.scheduleNextWake();
    }
  }

  /** Snapshot of bucket state for doctor probes / introspection. */
  snapshot(): {
    capacity: number;
    refillRatePerSec: number;
    tokens: number;
    queueDepth: number;
    totalAcquired: number;
    totalDenied: number;
    peakQueueDepth: number;
  } {
    this.refill();
    return {
      capacity: this.capacity,
      refillRatePerSec: this.refillRatePerSec,
      tokens: this.tokens,
      queueDepth: this.waiters.length,
      totalAcquired: this.totalAcquired,
      totalDenied: this.totalDenied,
      peakQueueDepth: this.peakQueueDepth,
    };
  }

  /**
   * Test helper: cancel all pending waiters and clear timers. Safe to
   * call in `afterEach` to avoid hanging tests.
   */
  dispose(): void {
    if (this.scheduleWakeTimer !== null) {
      clearTimeout(this.scheduleWakeTimer);
      this.scheduleWakeTimer = null;
    }
    for (const w of this.waiters) {
      clearTimeout(w.timeoutHandle);
      w.resolve(false);
    }
    this.waiters.length = 0;
  }
}
