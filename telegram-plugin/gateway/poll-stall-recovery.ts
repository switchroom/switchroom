/**
 * Telegram poll stall recovery (incident 2026-06-18: a network flap left the
 * whole agent fleet alive-but-deaf for ~30 min until a manual restart).
 *
 * When the long-poll health-check (poll-health.ts) detects a stall — 3
 * consecutive `getMe` failures — the OLD recovery did `await runnerHandle.stop()`
 * then re-ran the runner in place. That HUNG: grammy's `stop()` returns the
 * runner task promise, which is blocked on a non-abortable `getUpdates` retry
 * backoff (`@grammyjs/runner` maxRetryTime 15h, exponential, plain setTimeout
 * that ignores the abort signal). During a network outage the source never
 * terminates, so `stop()` never resolves, the re-run never fires, and the
 * gateway stays deaf.
 *
 * Recovery is now a clean non-zero process EXIT: `_switchroom_supervise`
 * (profiles/_base/start.sh.hbs) restarts the gateway sidecar with a fresh
 * runner. Same mechanism the manual fix used and the run loop's catch-block
 * already relies on; it restarts only the gateway (claude/tmux untouched,
 * in-flight turns recovered by boot-resume). Extracted as its own module with
 * an injectable `exit` so the exit code is unit-testable (mirrors
 * startup-network-retry.ts) — gateway.ts itself can't be imported in a test.
 */

export interface PollStallRecoveryDeps {
  /** Process exit. Injectable for tests; defaults to process.exit. */
  exit?: (code: number) => void;
  /** Logger. Defaults to process.stderr. */
  log?: (msg: string) => void;
  /** Agent name for the log line. */
  agentName?: string;
}

/** Exit code for a poll stall. Always 1 — NEVER 78. */
export const POLL_STALL_EXIT_CODE = 1;

/**
 * Recover from a confirmed Telegram poll stall by exiting non-zero so the
 * supervisor restarts the gateway with a fresh runner.
 *
 * MUST exit 1 — NEVER 78. Exit 78 (EX_CONFIG) is the supervisor's permanent-
 * quarantine sentinel (start.sh.hbs); quarantining on a *transient* network
 * stall would leave the gateway dead even after connectivity returns — the
 * exact failure this fix exists to prevent.
 */
export function recoverFromPollStall(deps: PollStallRecoveryDeps = {}): void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log =
    deps.log ??
    ((msg: string) => {
      process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
    });
  const agentName = deps.agentName ?? "-";

  log(
    `telegram gateway: poll.health_check.stall_recovery exiting code=${POLL_STALL_EXIT_CODE} ` +
      `pid=${process.pid} agent=${agentName} — supervisor will restart the gateway with a fresh runner ` +
      `(not awaiting runnerHandle.stop(): grammy stop() blocks on a non-abortable getUpdates retry backoff during an outage)`,
  );
  exit(POLL_STALL_EXIT_CODE);
}
