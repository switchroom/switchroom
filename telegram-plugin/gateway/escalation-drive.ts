/**
 * escalation-drive.ts — the obligation-ledger escalation step, extracted from
 * obligationSweep so the hang → bounded → terminal behaviour is EXECUTABLE in a
 * test with a fake hanging send. That path is unreachable by the two harnesses
 * we have: mtcute can't make Telegram's API hang, and the synchronous property
 * test can't model a promise that never settles — yet it is exactly the path the
 * total proof flagged as the determinism hole. This file makes the real drive
 * logic the sweep uses testable in isolation (escalation-drive.test.ts), so the
 * fix is verified by execution, not only by reasoning + review.
 *
 * Invariant it upholds: a single escalation attempt
 *  - is guarded so a sweep tick cannot fire a second concurrent send for the
 *    same obligation while one is awaiting;
 *  - bounds the send with `withDeadline`, so the chain ALWAYS settles within
 *    `deadlineMs` ⇒ the in-flight flag ALWAYS clears (a hung send becomes a
 *    bounded reject, handled like any other failed attempt);
 *  - closes the obligation ONLY after a successful send; a transient failure
 *    leaves it OPEN (retried next sweep); a permanent failure
 *    (attempt ≥ maxAttempts) closes best-effort — so repeated hung/failed sends
 *    reach a terminal in a bounded number of sweeps, never an infinite loop.
 */
import { withDeadline } from './with-deadline.js'

/** The slice of the ledger the escalation step needs. */
export interface EscalationLedger {
  markEscalateAttempt(originTurnId: string): number
  close(originTurnId: string | null | undefined): boolean
}

export interface DriveEscalationArgs {
  escId: string
  /** Set of origin ids with an escalation send in flight (concurrency guard). */
  inFlight: Set<string>
  ledger: EscalationLedger
  /** Perform the operator-nudge send (already thread-fallback-wrapped). May hang. */
  send: () => Promise<unknown>
  /** Attempts before a permanent failure closes best-effort. */
  maxAttempts: number
  /** Bound on a single send so a hang can't leak the in-flight flag. */
  deadlineMs: number
  log?: (line: string) => void
  /** Injectable for tests; defaults to the real withDeadline. */
  withDeadlineFn?: typeof withDeadline
}

/**
 * Drive one escalation attempt. Returns the settling chain promise (so tests can
 * await it) or `undefined` if the call was a no-op because a send is already in
 * flight for `escId`. obligationSweep calls this as `void driveEscalation(...)`.
 */
export function driveEscalation(args: DriveEscalationArgs): Promise<void> | undefined {
  const { escId, inFlight, ledger, send, maxAttempts, deadlineMs } = args
  const log = args.log ?? ((l: string) => process.stderr.write(l))
  const wd = args.withDeadlineFn ?? withDeadline
  if (inFlight.has(escId)) return undefined // a send is already awaiting
  const attempt = ledger.markEscalateAttempt(escId)
  inFlight.add(escId)
  log(`telegram gateway: obligation escalating origin=${escId} attempt=${attempt}/${maxAttempts}\n`)
  return wd(send(), deadlineMs, 'obligation escalation send timed out')
    .then(() => {
      ledger.close(escId)
      log(`telegram gateway: obligation escalation delivered + closed origin=${escId}\n`)
    })
    .catch((err: unknown) => {
      if (attempt >= maxAttempts) {
        ledger.close(escId)
        log(
          `telegram gateway: obligation escalation PERMANENTLY undeliverable after ${attempt} attempts — closing best-effort origin=${escId}: ${err}\n`,
        )
      } else {
        log(
          `telegram gateway: obligation escalation send failed (attempt ${attempt}/${maxAttempts}), retrying next sweep origin=${escId}: ${err}\n`,
        )
      }
    })
    .finally(() => {
      inFlight.delete(escId)
    })
}
