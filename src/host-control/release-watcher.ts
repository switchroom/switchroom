/**
 * Release watcher — pull-based release-triggered fleet restart (#1743).
 *
 * Runs inside the long-lived hostd process. On a fixed interval it
 * asks `checkFn()` whether a new release is available; when one is
 * detected it runs `applyFn()` (the equivalent of `switchroom update`)
 * then `restartFn()` (`switchroom restart all` — graceful by default).
 *
 * The design choice is **pull, not push**: GitHub Actions has no
 * inbound webhook surface into hostd's UDS, and exposing one publicly
 * would require new infra. A 5-minute poll meets the issue's P95 ≤5 m
 * acceptance criterion without any new public network surface.
 *
 * Single in-flight guard prevents overlapping cycles (a slow apply
 * outlasting the next tick); failures log + drop the tick rather than
 * retry-storming.
 *
 * The module is dependency-injection-shaped on purpose: the real
 * docker / switchroom shellouts are wired in `main.ts`, but tests
 * exercise the state machine with stub functions.
 */

export interface ReleaseCheckResult {
  /** True if remote release differs from currently-running fleet. */
  available: boolean;
  /** Opaque version / digest identifier — printed in logs and emitted
   *  in the audit row so operators can correlate a rollout. */
  version?: string;
}

export interface ReleaseWatcherEvent {
  /** ms since epoch */
  at: number;
  /** event kind. */
  kind:
    | "release_detected"
    | "apply_started"
    | "apply_succeeded"
    | "apply_failed"
    | "restart_started"
    | "fleet_caught_up"
    | "restart_failed"
    | "check_failed";
  version?: string;
  error?: string;
  duration_ms?: number;
}

export interface ReleaseWatcherOptions {
  /** Poll interval in milliseconds. */
  intervalMs: number;
  /** Probe for a new release. Returns `available: true` when the
   *  remote tag's digest no longer matches the deployed digest. */
  checkFn: () => Promise<ReleaseCheckResult>;
  /** Run the equivalent of `switchroom update` end-to-end. Resolves
   *  when the apply completes (or rejects on failure). */
  applyFn: () => Promise<void>;
  /** Run the equivalent of `switchroom restart all` (graceful by
   *  default — drains in-flight turns). Resolves when scheduling
   *  completes; the per-agent drain happens asynchronously. */
  restartFn: () => Promise<void>;
  /** If false, the watcher will log a "release detected" event and
   *  stop short of calling applyFn / restartFn. Use to dogfood the
   *  check loop without auto-rolling the fleet. */
  applyOnDetect: boolean;
  /** Receives one event per state transition for telemetry / audit. */
  onEvent?: (e: ReleaseWatcherEvent) => void;
  /** Diagnostic log sink. */
  log?: (m: string) => void;
  /** Test seam — wall clock. */
  now?: () => number;
}

export class ReleaseWatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(private readonly opts: ReleaseWatcherOptions) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // Schedule with setInterval — first tick fires after `intervalMs`,
    // not immediately. Deliberate: on hostd boot the fleet was just
    // started from the operator's most-recent update, so the boot-time
    // tick would near-certainly be a no-op and we'd rather not double-
    // check during startup churn.
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one check-and-maybe-roll cycle. Exposed for testing. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.log("skip tick: previous cycle still in flight");
      return;
    }
    this.inFlight = true;
    try {
      let check: ReleaseCheckResult;
      try {
        check = await this.opts.checkFn();
      } catch (err) {
        this.emit({
          at: this.now(),
          kind: "check_failed",
          error: errMsg(err),
        });
        this.log(`check_failed: ${errMsg(err)}`);
        return;
      }
      if (!check.available) return;

      const detectedAt = this.now();
      this.emit({
        at: detectedAt,
        kind: "release_detected",
        ...(check.version ? { version: check.version } : {}),
      });
      this.log(
        `release detected${check.version ? `: ${check.version}` : ""}` +
          (this.opts.applyOnDetect
            ? ", auto-applying"
            : " (apply_on_detect=false; not rolling)"),
      );
      if (!this.opts.applyOnDetect) return;

      const applyStarted = this.now();
      this.emit({
        at: applyStarted,
        kind: "apply_started",
        ...(check.version ? { version: check.version } : {}),
      });
      try {
        await this.opts.applyFn();
      } catch (err) {
        this.emit({
          at: this.now(),
          kind: "apply_failed",
          error: errMsg(err),
          duration_ms: this.now() - applyStarted,
        });
        this.log(`apply_failed: ${errMsg(err)}`);
        return;
      }
      this.emit({
        at: this.now(),
        kind: "apply_succeeded",
        duration_ms: this.now() - applyStarted,
      });

      const restartStarted = this.now();
      this.emit({
        at: restartStarted,
        kind: "restart_started",
        ...(check.version ? { version: check.version } : {}),
      });
      try {
        await this.opts.restartFn();
      } catch (err) {
        this.emit({
          at: this.now(),
          kind: "restart_failed",
          error: errMsg(err),
          duration_ms: this.now() - restartStarted,
        });
        this.log(`restart_failed: ${errMsg(err)}`);
        return;
      }
      const caughtUpAt = this.now();
      this.emit({
        at: caughtUpAt,
        kind: "fleet_caught_up",
        ...(check.version ? { version: check.version } : {}),
        duration_ms: caughtUpAt - detectedAt,
      });
      this.log(
        `fleet caught up in ${caughtUpAt - detectedAt}ms` +
          (check.version ? ` (version ${check.version})` : ""),
      );
    } finally {
      this.inFlight = false;
    }
  }

  private emit(e: ReleaseWatcherEvent): void {
    if (this.opts.onEvent) {
      try {
        this.opts.onEvent(e);
      } catch {
        // never let a telemetry sink failure break the watcher
      }
    }
  }

  private log(m: string): void {
    if (this.opts.log) this.opts.log(`release-watcher: ${m}`);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
