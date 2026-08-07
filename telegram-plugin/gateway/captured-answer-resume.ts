/**
 * captured-answer-resume.ts — durable captured-answer resume for a partially
 * delivered turn-flush backstop (#3282).
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 * When the turn-flush backstop (`deliverAnswer` → `runBackstopDelivery`) lands
 * chunks 0,1 of a 3-chunk answer but chunk 2 exhausts its bounded retries, the
 * turn-flush IIFE historically (a) cleared the per-chunk `BackstopDeliveryLedger`
 * unconditionally and (b) left the delivery obligation OPEN. The liveness floor
 * then re-presented the obligation as a FRESH must-answer model turn, which
 * REGENERATED the whole answer — re-posting chunks 0,1's content the user already
 * received. Result: the user sees the head of the answer twice after a partial
 * failure (or after a restart mid-delivery). #3282.
 *
 * ── The fix (design-of-record §2.2) ─────────────────────────────────────────
 * Make the re-present a *byte-identical captured-answer resume* of ONLY the
 * not-yet-LANDED tail — never a regeneration — so a chunk that already reached
 * the chat is provably never re-posted:
 *
 *   1. On a partial (`!delivered`) turn-flush, persist a {@link
 *      CapturedDeliverySnapshot} (the split chunks + each landed chunk's ids and
 *      confirmed flag) onto the durable obligation record, keyed by
 *      `originTurnId`. This rides the obligation ledger's existing atomic
 *      snapshot, so it survives a gateway/container restart.
 *   2. The obligation sweep's `represent` branch becomes source-aware: when the
 *      obligation carries a captured-delivery snapshot it drives THIS resume
 *      (re-run `runBackstopDelivery` for the SAME `turnId` and the SAME captured
 *      chunks, resuming at the first UNSENT index) instead of pushing a
 *      fresh-generation inbound. No snapshot ⇒ the genuine "model wrote nothing
 *      / never fired a backstop" case falls through to fresh generation
 *      unchanged.
 *   3. The in-memory ledger is rehydrated from the snapshot AND reconciled against
 *      the durable outbound-text oracle (`hasOutboundWithText`), so a chunk that
 *      landed a durable history row is confirmed even if the snapshot's flag was
 *      not yet flushed when the process died (crash-idempotency, design §2.3/A5).
 *
 * Chunk identity is the chunk INDEX within `turnId`, stable across the represent
 * boundary and across restart because the resume re-delivers the exact captured
 * chunks (not a regenerated answer). #3278's per-chunk state machine
 * (`unsent → pending → landed-unconfirmed → {landed-confirmed | unsent}`) binds
 * here too: the resume re-PROBES `landed-unconfirmed` chunks (never re-sends
 * them) and re-SENDS only `unsent` ones, so a landed chunk is never duplicated
 * by either the in-fire retry OR the cross-represent resume.
 *
 * ── The CLOSE condition is LANDED, not confirmed (#3702) ────────────────────
 * `runBackstopDelivery`'s verdict is evidence-based: every chunk landed a
 * message id and at least one is a fresh non-card id. An inconclusive read-back
 * does not lower it (only a POSITIVE `absent`, which demotes the chunk back to
 * `unsent`, does). So a resume over a snapshot whose chunks ALL landed but were
 * never corroborated closes the obligation having sent NOTHING — the re-probe
 * ran, resolved nothing, and the landed-id evidence stood.
 *
 * That is deliberate, not an oversight. The alternative — keep the obligation
 * OPEN because nothing corroborated the ids — has no corrective action
 * available: the resume never re-sends a LANDED chunk, so every subsequent
 * represent would re-run the same shed probe, send zero messages, and burn
 * represent budget until the cap escalates a false "the agent never answered
 * you" nudge to the operator. Representing cannot deliver anything the first
 * delivery did not; the only thing it can produce is noise. When the durable
 * outbound-text oracle CAN corroborate (history enabled + the row present) it
 * confirms the chunk at hydration and the same close happens by the older
 * `hasOutboundWithText` route — this path is the same decision when that oracle
 * is unavailable.
 *
 * This module is PURE state + orchestration over injected effects — no Telegram,
 * no SQLite, no gateway module state — so the resume decision is unit-testable
 * (see tests/captured-answer-resume.test.ts). The gateway owns the real
 * `deliver` (via `deliverAnswer`), the durable oracle, and the obligation I/O.
 */

import { hasOutboundWithText as realHasOutboundWithText } from '../history.js'
import type { BackstopDeliveryLedger } from './backstop-delivery.js'
import type { CapturedDeliverySnapshot, Obligation } from './obligation-ledger.js'

/**
 * Build the durable {@link CapturedDeliverySnapshot} from the live per-chunk
 * ledger after a partial `runBackstopDelivery`. Captures every LANDED chunk's
 * message ids + confirmed flag so the resume can (a) never re-send a chunk that
 * already landed and (b) re-PROBE a landed-unconfirmed chunk instead of blindly
 * re-sending it. Chunks that never landed (send threw) are simply absent → the
 * resume treats them as `unsent` and re-sends them. Pure.
 */
export function buildCapturedDeliverySnapshot(
  ledger: BackstopDeliveryLedger,
  turnId: string,
  chunks: readonly string[],
): CapturedDeliverySnapshot {
  const chunkStates = ledger.entries(turnId).map(({ index, messageIds }) => ({
    index,
    messageIds,
    confirmed: ledger.hasConfirmedChunk(turnId, index),
  }))
  return { chunks: [...chunks], chunkStates }
}

/**
 * Rehydrate a `BackstopDeliveryLedger` for a captured-answer resume from a
 * durable snapshot, reconciled against the durable outbound-text oracle. For each
 * landed chunk in the snapshot:
 *   - re-record its landed message id(s) so `unsentIndices` excludes it (the
 *     resume never re-sends a chunk that already landed);
 *   - mark it `landed-confirmed` when the snapshot flag says so OR the oracle
 *     proves its text is a durable outbound row (crash-idempotency, §2.3/A5) —
 *     a confirmed chunk is neither re-probed nor re-sent.
 * Chunks absent from the snapshot stay `unsent` (re-sent by the resume). Pure over
 * the injected `hasLanded` oracle.
 */
export function hydrateResumeLedger(
  ledger: BackstopDeliveryLedger,
  turnId: string,
  snapshot: CapturedDeliverySnapshot,
  hasLanded: (chunkText: string, index: number) => boolean,
): void {
  for (const st of snapshot.chunkStates) {
    if (st.messageIds.length === 0) continue // never actually landed → leave unsent
    ledger.recordChunk(turnId, st.index, [...st.messageIds])
    if (st.confirmed || hasLanded(snapshot.chunks[st.index] ?? '', st.index)) {
      ledger.confirmChunk(turnId, st.index)
    }
  }
}

/** The args the module hands the gateway's `deliverAnswer` to run a resume. */
export interface CapturedResumeArgs {
  chatId: string
  threadId: number | undefined
  text: string
  turnId: string
  cardMessageId: number | null
  replyToMessageId: number | null
  resume: {
    snapshot: CapturedDeliverySnapshot
    hydrate: (ledger: BackstopDeliveryLedger, turnId: string) => void
  }
}

/**
 * The RAW gateway singletons the dispatcher wires. Structural (no gateway class
 * imports) and kept minimal so the gateway injection stays a handful of lines
 * under the gateway.ts line ratchet — the module builds every resume closure
 * (the `deliverAnswer` resume args, the oracle-reconciled hydrate, the supersede
 * record) itself.
 */
export interface CapturedResumePorts {
  /** The gateway's `deliverAnswer`, invoked in RESUME mode (byte-identical tail,
   *  no card gate). Only `delivered`/`sentIds` are read. */
  deliverAnswer: (args: CapturedResumeArgs) => Promise<{ delivered: boolean; sentIds: number[] }>
  /** The single obligation ledger. `markRepresented` consumes one represent-budget
   *  unit + stamps the per-represent grace (bounding the resume ladder exactly
   *  like a fresh-generation represent → escalate at the cap); `close` drops the
   *  captured snapshot once fully delivered. */
  obligationLedger: {
    markRepresented: (originTurnId: string) => unknown
    close: (originTurnId: string) => unknown
  }
  /** The per-chunk backstop ledger — GC'd for a fully delivered turn. */
  backstopDeliveryLedger: { clear: (turnId: string) => void }
  /** flushedTurnSupersede — feed the resume's fresh chat ids in so a late reply
   *  after the resumed tail still corrects the delivered set (design §4). */
  flushedTurnSupersede: {
    record: (
      chatId: string,
      threadId: number | undefined,
      rec: { turnId: string; messageIds: number[]; text: string },
      nowMs: number,
    ) => void
  }
  /** True when history is queryable (else the durable-text oracle reconcile that
   *  gives crash-idempotency — §2.3/A5 — is skipped). */
  historyEnabled: boolean
  /**
   * The durable outbound-text oracle. Defaults to the real `history.js`
   * implementation; tests inject a fake here instead of module-mocking
   * `../history.js`. A `vi.mock('../history.js', ...)` looks file-scoped
   * under vitest but is NOT under bun's vitest-compat layer (`bun test`
   * maps `vi.mock` onto the PROCESS-GLOBAL `mock.module`, which retroactively
   * rebinds every other file's import of the same specifier in the same
   * `bun-test-run` sweep — see check-bun-module-mock-scope.mjs). That leak
   * was the actual root cause of #4488/#4491: a mocked `hasOutboundWithText`
   * from this module's own test file silently answered
   * `telegram-plugin/tests/history.test.ts`'s calls to the REAL function
   * elsewhere in the same 651-file sweep, so a row `history.test.ts` had
   * genuinely just written was reported as not found. Injecting via this
   * port keeps the fake scoped to the dispatcher instance that receives it.
   */
  hasOutboundWithText?: (
    chatId: string,
    text: string,
    threadId: number | null,
    sinceMs?: number,
  ) => boolean
  stderr?: (s: string) => void
}

export interface CapturedResumeDispatcher {
  /** Fire a captured-answer resume for `o` (fire-and-forget; the sweep is sync).
   *  De-duped per `originTurnId` so two sweeps never launch concurrent resumes;
   *  a no-op when `o` carries no non-empty captured snapshot (the caller should
   *  then fall through to fresh generation). */
  dispatch: (o: Obligation) => void
  /** In-flight origin ids (test introspection). */
  inFlight: () => string[]
}

/**
 * The obligation-sweep's captured-answer resume driver. Owns the in-flight guard
 * + the deliver→close/leave-open orchestration so the gateway sweep stays a
 * two-line dispatch. On each dispatch it consumes one represent-budget unit
 * (bounding the ladder → escalate), re-delivers only the UNSENT tail (a landed
 * chunk is re-probed, never re-sent), and:
 *   - fully delivered ⇒ record the supersede tail, close the obligation, GC the
 *     ledger (the represent ladder stops). Since #3702 "delivered" means every
 *     chunk LANDED — so a snapshot that is already fully landed closes here
 *     having sent nothing (see the module header for why that is the right
 *     call, and why leaving it OPEN would only manufacture a false escalation);
 *   - still partial / error ⇒ leave the obligation OPEN so the next eligible
 *     sweep (after the per-represent grace) retries, until the represent cap
 *     escalates it to the operator nudge — no infinite loop.
 */
export function createCapturedResumeDispatcher(ports: CapturedResumePorts): CapturedResumeDispatcher {
  const stderr = ports.stderr ?? (() => {})
  const hasOutboundWithText = ports.hasOutboundWithText ?? realHasOutboundWithText
  const inFlight = new Set<string>()

  /** Re-deliver the UNSENT tail of `o`'s captured answer, byte-identical,
   *  by rehydrating the per-chunk ledger from the snapshot reconciled against the
   *  durable text oracle. Never regenerates. */
  function deliver(o: Obligation, snapshot: CapturedDeliverySnapshot): Promise<{ delivered: boolean; sentIds: number[] }> {
    return ports.deliverAnswer({
      chatId: o.chatId,
      threadId: o.threadId,
      text: '',
      turnId: o.originTurnId,
      cardMessageId: null,
      replyToMessageId: o.messageId,
      resume: {
        snapshot,
        hydrate: (ledger, turnId) =>
          hydrateResumeLedger(ledger, turnId, snapshot, (txt) =>
            ports.historyEnabled &&
            hasOutboundWithText(o.chatId, txt, o.threadId ?? null, o.openedAt),
          ),
      },
    })
  }

  /** Record the resume's FULL delivered id set (rehydrated-confirmed + freshly
   *  re-sent — `runBackstopDelivery` returns `ledger.sentIds`, i.e. all landed
   *  ids in index order) into the supersede lane, keyed by the turn id. This
   *  REPLACES the partial turn-flush record in place with the complete set, so a
   *  late reply for this turn corrects the WHOLE delivered answer (design §4) —
   *  no-op when nothing has landed. */
  function supersede(o: Obligation, snapshot: CapturedDeliverySnapshot, sentIds: number[]): void {
    if (sentIds.length === 0) return
    ports.flushedTurnSupersede.record(
      o.chatId,
      o.threadId,
      { turnId: o.originTurnId, messageIds: sentIds, text: snapshot.chunks.join('') },
      Date.now(),
    )
  }

  async function run(o: Obligation, snapshot: CapturedDeliverySnapshot): Promise<void> {
    try {
      const { delivered, sentIds } = await deliver(o, snapshot)
      supersede(o, snapshot, sentIds)
      if (delivered) {
        ports.obligationLedger.close(o.originTurnId)
        ports.backstopDeliveryLedger.clear(o.originTurnId)
        // `sentIds` is `ledger.sentIds()` — every LANDED id, which since #3702
        // routinely includes ids no read-back corroborated. Say "landed", not
        // "confirmed": claiming confirmation for an uncorroborated id is exactly
        // the overstatement this PR removed from the delivery verdict.
        stderr(
          `telegram gateway: captured-answer resume delivered — origin=${o.originTurnId} ` +
            `${sentIds.length} message id(s) landed; obligation closed\n`,
        )
      } else {
        // Not fully landed (a chunk never got an id, or a positive `absent`
        // demoted one) — leave the obligation OPEN for the next paced sweep /
        // escalation (bounded by the represent cap).
        stderr(
          `telegram gateway: captured-answer resume partial — origin=${o.originTurnId} ` +
            `tail still not landed; left OPEN for retry\n`,
        )
      }
    } catch (err) {
      stderr(
        `telegram gateway: captured-answer resume error — origin=${o.originTurnId}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      )
    } finally {
      inFlight.delete(o.originTurnId)
    }
  }

  return {
    dispatch(o: Obligation): void {
      const snapshot = o.capturedDelivery
      if (snapshot == null || snapshot.chunks.length === 0) return
      if (inFlight.has(o.originTurnId)) return
      inFlight.add(o.originTurnId)
      // Consume represent budget + arm the per-represent grace up front so the
      // ladder is bounded and the sweep can't immediately re-dispatch mid-flight.
      ports.obligationLedger.markRepresented(o.originTurnId)
      void run(o, snapshot)
    },
    inFlight: () => [...inFlight],
  }
}
