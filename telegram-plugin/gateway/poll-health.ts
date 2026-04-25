/**
 * Long-poll health-check for the Telegram gateway.
 *
 * Motivation (issue #56):
 *   grammY's runner holds a permanent HTTPS connection to Telegram's
 *   getUpdates endpoint. On some network paths this connection can
 *   silently freeze — the TCP socket stays open but no bytes flow.
 *   The runner's `isRunning()` stays true and the gateway appears
 *   alive, but Telegram messages never arrive.
 *
 * Fix:
 *   A separate setInterval calls `getMe()` (a lightweight Bot API
 *   endpoint) every HEALTH_INTERVAL_MS. Three consecutive failures
 *   constitute a stall: we stop the runner, wait RESTART_GRACE_MS
 *   for the in-flight request to die, then let the caller restart it.
 *
 *   A single failure doesn't count — transient network blips happen.
 *   The threshold must be >= 3 so a brief Telegram outage (e.g. a
 *   data-centre hiccup) doesn't cause thrashing.
 *
 * Usage:
 *   const hc = createPollHealthCheck({
 *     ping:  () => bot.api.getMe(),
 *     onStall: async () => { await runnerHandle.stop(); … restart … },
 *     log:   (msg) => process.stderr.write(msg),
 *   });
 *   // start after the runner is up:
 *   hc.start();
 *   // on clean shutdown:
 *   hc.stop();
 */

export interface PollHealthCheckOptions {
  /**
   * Lightweight Bot API probe. Implementations should call `bot.api.getMe()`
   * or similar. The check is marked as a failure if this rejects.
   */
  ping: () => Promise<unknown>;

  /**
   * Called when `failureThreshold` consecutive pings have failed.
   * The health check stops itself before calling this, so `onStall`
   * is called at most once per `start()`. The implementation should
   * restart the runner and call `healthCheck.start()` again when ready.
   */
  onStall: () => Promise<void>;

  /** Interval between health pings. Defaults to 5 minutes. */
  intervalMs?: number;

  /**
   * Number of consecutive failures before `onStall` fires.
   * Defaults to 3.
   */
  failureThreshold?: number;

  /** Logger. Defaults to process.stderr. */
  log?: (msg: string) => void;

  /**
   * Injectable timer (for tests). Defaults to setInterval / clearInterval.
   */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

export interface PollHealthCheckHandle {
  /** Start the periodic health-check interval. Idempotent. */
  start(): void;
  /** Stop the interval without triggering onStall. Idempotent. */
  stop(): void;
  /** Current count of consecutive failures (exposed for testing). */
  consecutiveFailures(): number;
}

const DEFAULT_LOG = (msg: string): void => {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
};

export function createPollHealthCheck(
  options: PollHealthCheckOptions,
): PollHealthCheckHandle {
  const {
    ping,
    onStall,
    intervalMs = 5 * 60_000,
    failureThreshold = 3,
    log = DEFAULT_LOG,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

  let timer: ReturnType<typeof setInterval> | null = null;
  let failures = 0;
  let active = false;

  async function tick(): Promise<void> {
    try {
      await ping();
      if (failures > 0) {
        log(`telegram gateway: poll.health_check recovered after ${failures} failure(s)`);
      }
      failures = 0;
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      log(
        `telegram gateway: poll.health_check ping failed (${failures}/${failureThreshold}): ${msg}`,
      );
      if (failures >= failureThreshold) {
        log(
          `telegram gateway: poll.health_check stall detected after ${failures} consecutive failures — triggering recovery`,
        );
        // Stop before calling onStall so we don't fire again during recovery.
        doStop();
        try {
          await onStall();
        } catch (stallErr) {
          log(
            `telegram gateway: poll.health_check onStall error: ${stallErr instanceof Error ? stallErr.message : String(stallErr)}`,
          );
        }
      }
    }
  }

  function doStop(): void {
    active = false;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  return {
    start(): void {
      if (active) return; // idempotent
      active = true;
      failures = 0;
      timer = setIntervalFn(() => { void tick(); }, intervalMs);
      // unref so the interval doesn't prevent process exit on clean shutdown
      if (typeof (timer as any)?.unref === "function") {
        (timer as any).unref();
      }
      log(`telegram gateway: poll.health_check started interval=${intervalMs}ms threshold=${failureThreshold}`);
    },

    stop(): void {
      doStop();
    },

    consecutiveFailures(): number {
      return failures;
    },
  };
}
