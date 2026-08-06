/**
 * outbox-sweep.ts — the single deliverer for the guaranteed-final-message
 * outbox. Runs on the gateway heartbeat tick, independent of turn lifecycle,
 * so it covers turn CLASSES the gateway never sees a CurrentTurn for
 * (`<task-notification>` handbacks, background-worker completions, unknown
 * future wake shapes). See `../outbox.ts` for the record/nonce/journal model.
 *
 * Exactly-once (H1): every record is claimed with a rename-mutex, guarded by the
 * shared delivered-keys journal (same turnNonce every delivering machine uses),
 * and by the in-memory text `outboundDedup` cache. Delivered nonce is journaled
 * AFTER a successful send. When a legacy machine (turn-flush / reply / captured
 * prose) delivered the same turn's answer first, its journal write under the
 * SAME nonce makes the sweep skip-journaled; and the sweep's own skip-dedup
 * branch JOURNALS the nonce and DELETES the record (see below) so a text-dedup
 * hit can never re-fire after the in-memory cache's TTL evicts. A crash between
 * send and journal is caught next boot by the journal + text-dedup (never a
 * loss, at most one duplicate).
 *
 * Routing (H3/F2): `resolveOutboxChat` runs the injected transitive registry-chain
 * lookup then the record's OWN stamped per-session origin chat for envelope-less
 * records — never a gateway-global last-inbound fallback (cross-chat leak). It
 * FAILS CLOSED (holds the record) when neither resolves.
 *
 * The orchestration takes injected IO deps so it is unit-testable without a live
 * gateway; `gateway.ts` wires the real send / dedup / registry lookups.
 */

import {
  OUTBOX_MAX_AGE_MS,
  OUTBOX_QUIET_MS,
  appendDelivered,
  claimRecord,
  clearOutboxRecord,
  decideOutboxSweep,
  extractTaskId,
  listPendingRecords,
  readDeliveredNonces,
  readOutboxRecord,
  reclaimStaleSending,
  releaseClaim,
  removeClaimed,
  resolveOutboxChat,
  sha256Hex,
  type OutboxRecord,
} from '../outbox.js'
import {
  AUDIENCE_INTERNAL,
  formatInternalSuppression,
  formatReplyThrowFraming,
  formatSelfImprovementFraming,
  resolveRecordAudience,
  shouldSuppressForAudience,
} from '../hooks/audience-classify.mjs'
import { isShownBlock } from '../shown-ledger.js'
import { richMessage, isParseEntitiesError } from '../rich-send.js'
import { splitMarkdownChunks, splitPlainTextToCap } from '../format.js'
import { resolveSubagentOriginTurnKey } from '../registry/subagents-schema.js'
import { createRetryApiCall, retryWithThreadFallback } from '../retry-api-call.js'
import {
  floodStatePath,
  makeFloodWaitProbe,
  makeFloodWaitRecorder,
} from '../flood-circuit-breaker.js'

/**
 * What a sweep `send` reports back. The primary (last) landed message id is the
 * journal's `tgMessageId`; the per-chunk `chunks` are what {@link sweepOutbox}
 * hands to `recordOutbound` so the history row is aligned to the ACTUAL sends
 * (a markdown-aware split can land >1 chunk), exactly like the backstop uses
 * `ledger.entries` (`backstop-delivery.ts`).
 */
export interface OutboxSendResult {
  /** Primary (last) landed message id, or `undefined` when nothing was sent. */
  messageId: number | undefined
  /** Every landed chunk in delivery order: its message id + the delivered text. */
  chunks: Array<{ messageId: number; text: string }>
}

export interface OutboxSweepDeps {
  /**
   * Deliver `text` to the chat. Resolves to the landed message id(s) + their
   * texts (best-effort) — see {@link OutboxSendResult}. A long body is chunked
   * inside the sender, so more than one message may land.
   */
  send: (
    chatId: string,
    threadId: number | null,
    text: string,
  ) => Promise<OutboxSendResult>
  /**
   * Persist the sweep-delivered final answer to history (role='assistant'),
   * the SAME `recordOutbound` the reply path (`outbound-send-path.ts`) and the
   * turn-flush backstop (`backstop-delivery.ts`) call. Without it every
   * net-delivered handback / task-notification answer is silently absent from
   * `history.db`, degrading `get_recent_messages`, the handoff briefing, and the
   * represent-guard's outbound counting. OPTIONAL and called DEFENSIVELY (a
   * missing recorder or a throw never breaks the safety-net delivery).
   */
  recordOutbound?: (
    chatId: string,
    threadId: number | null,
    messageIds: number[],
    texts: string[],
  ) => void
  /** Has this exact text already been delivered to this chat/thread recently? */
  textAlreadyDelivered: (chatId: string, threadId: number | null, text: string) => boolean
  /**
   * Transitive registry-chain lookup (H3): resolve the originating chat for a
   * task-notification / chained-dispatch anchor from its `<task-id>`. Null when
   * the chain doesn't resolve.
   */
  registryChainLookup?: (
    taskId: string,
  ) => { chatId: string; threadId: number | null } | null
  stateDir?: string
  now?: () => number
  log?: (line: string) => void
  quietMs?: number
  /**
   * Remaining ms of a KNOWN-OPEN Telegram flood window, or 0 when none — the
   * SAME persisted breaker state (`flood-wait.json`) `robustApiCall` consults
   * (`makeFloodWaitProbe`). When it reports an open window the sweep does not
   * scan, claim, or send at all.
   *
   * Why the sweep needs its own check on top of the retry policy's: the retry
   * policy only short-circuits windows LONGER than its in-process sleep ceiling
   * (120s), and even then it does so per-CALL — it still costs a claim/release
   * cycle and a log line every tick. The outbox is a safety net with no latency
   * SLA; deferring the whole sweep while ANY window is open is strictly correct
   * and is the only thing that makes "does not hit the wire" true.
   *
   * FAILS OPEN (a throwing probe ⇒ 0) for the same reason `makeFloodWaitProbe`
   * does: a broken marker file must never permanently strand the outbox.
   */
  floodWaitRemainingMs?: () => number
  /**
   * W1-d (#3865) kill switch for the audience gate. Defaults to the env read
   * `SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE !== '0'` (ON by default; `=0` restores
   * the pre-change leak). Injected rather than read at module scope so the
   * revert-check test can flip it deterministically inside one process — a
   * module-level const would be captured at import and the revert-check could
   * not run at all.
   */
  audienceGateEnabled?: () => boolean
  /**
   * W1-d (#3865) structured-telemetry sink for a suppressed `'internal'`
   * record. Mirrors `escalateOrphan` (#4104): a SEPARATE, non-chat channel, so
   * the escalation path for internal prose is structurally incapable of
   * becoming a message. Defaults to `log`.
   */
  escalateInternalSuppression?: (line: string) => void
  /**
   * W1-d follow-up (#4141) kill switch for the reply-throw provenance banner.
   * Defaults to `SWITCHROOM_TG_OUTBOX_PROVENANCE_FRAMING !== '0'` (ON). Same
   * injected-seam reasoning as {@link audienceGateEnabled}: a module-scope env
   * read would be captured at import and the revert-check could not run.
   */
  provenanceFramingEnabled?: () => boolean
  /**
   * W1-d follow-up (#4141) telemetry sink for a FRAMED delivery. Separate from
   * {@link escalateInternalSuppression} because the two outcomes are different
   * (withheld vs. delivered-with-provenance) and must be greppable apart.
   * Defaults to `log`.
   */
  logProvenanceFraming?: (line: string) => void
  /**
   * Ken 2026-08-07 kill switch for the self-improvement title header. Defaults
   * to `SWITCHROOM_TG_OUTBOX_SELF_IMPROVE_FRAMING !== '0'` (ON). Same
   * injected-seam reasoning as {@link provenanceFramingEnabled}: a module-scope
   * env read would be captured at import and a revert-check could not run.
   */
  selfImprovementFramingEnabled?: () => boolean
  /**
   * Ken 2026-08-07 telemetry sink for a self-improvement-framed delivery.
   * Separate from {@link logProvenanceFraming} so the two framings are greppable
   * apart. Defaults to `log`.
   */
  logSelfImprovementFraming?: (line: string) => void
}

export interface OutboxSweepSummary {
  scanned: number
  delivered: number
  skipped: number
  /**
   * Records whose send THREW this sweep (claim released, retried next tick).
   * The tick-level backoff keys off this: a 5s fixed retry against a failing
   * Telegram is how the 2026-07-27 sweep hit an open 4.4h ban 228 times.
   */
  sendFailures: number
  /** True when the whole sweep was skipped because a flood window is open. */
  floodDeferred?: boolean
  /** Remaining ms of the window that caused `floodDeferred`. */
  floodRemainingMs?: number
  /**
   * W1-d (#3865): records withheld from the chat this sweep because their
   * audience is `'internal'`. Counted separately from `skipped` so "we
   * suppressed a leak" is never confused with "we deferred a delivery".
   */
  audienceSuppressed?: number
  /**
   * W1-d follow-up (#4141): deliveries this sweep that carried the reply-throw
   * provenance banner. These ARE counted in `delivered` — framing is a
   * delivery, not a skip.
   */
  provenanceFramed?: number
  /**
   * Ken 2026-08-07: deliveries this sweep that carried the self-improvement
   * title header. These ARE counted in `delivered` — framing is a delivery, not
   * a skip.
   */
  selfImprovementFramed?: number
}

/**
 * Sweep the outbox once. Idempotent; safe to call every heartbeat tick.
 */
export async function sweepOutbox(deps: OutboxSweepDeps): Promise<OutboxSweepSummary> {
  const now = deps.now?.() ?? Date.now()
  const log = deps.log ?? (() => {})
  const summary: OutboxSweepSummary = { scanned: 0, delivered: 0, skipped: 0, sendFailures: 0 }

  // #3853 — do not sweep INTO a known-open flood window. Every record is
  // preserved on disk and re-scanned on the next tick after the window closes,
  // so this loses no delivery; issuing the send would only feed the ban.
  const remainingMs = probeFloodWindow(deps.floodWaitRemainingMs)
  if (remainingMs > 0) {
    summary.floodDeferred = true
    summary.floodRemainingMs = remainingMs
    // NOT logged here: a 4.4h ban is ~3181 ticks, and one line per tick just
    // moves the flood from the wire to the disk. `startOutboxSweep` logs the
    // deferral at most once per DEFER_LOG_INTERVAL_MS.
    return summary
  }

  // Re-queue crashed claims first (claim-then-crash before send).
  reclaimStaleSending(deps.stateDir, now)

  const pending = listPendingRecords(deps.stateDir)
  if (pending.length === 0) return summary
  const deliveredNonces = readDeliveredNonces(deps.stateDir)

  // #3861 — deliver in CAPTURE order. `listPendingRecords` returns readdir
  // order, which is filesystem-dependent (hash order on most Linux filesystems,
  // i.e. effectively the nonce's hash). That was harmless while the outbox held
  // at most one stray handback per turn; it is not harmless now that a
  // multi-hour flood window can park a whole conversation's worth of queued
  // replies, which would then land shuffled. Sort by `createdAt`, tie-broken by
  // nonce so the order is total and deterministic.
  const records = pending
    .map((fileName) => readOutboxRecord(fileName, deps.stateDir))
    .filter((r): r is OutboxRecord => r != null)
    .sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt - b.createdAt
        : a.turnNonce < b.turnNonce
          ? -1
          : a.turnNonce > b.turnNonce
            ? 1
            : 0,
    )

  const audienceGateEnabled = deps.audienceGateEnabled?.() ??
    process.env.SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE !== '0'
  const escalateInternalSuppression = deps.escalateInternalSuppression ?? log
  const provenanceFramingEnabled = deps.provenanceFramingEnabled?.() ??
    process.env.SWITCHROOM_TG_OUTBOX_PROVENANCE_FRAMING !== '0'
  const logProvenanceFraming = deps.logProvenanceFraming ?? log
  const selfImprovementFramingEnabled = deps.selfImprovementFramingEnabled?.() ??
    process.env.SWITCHROOM_TG_OUTBOX_SELF_IMPROVE_FRAMING !== '0'
  const logSelfImprovementFraming = deps.logSelfImprovementFraming ?? log

  for (const record of records) {
    summary.scanned++

    // ── W1-d (#3865): AUDIENCE GATE ─────────────────────────────────────────
    //
    // Placed at ENTRY SELECTION — before routing, before the claim, before any
    // adapter is consulted — and NOT inside the send adapter. That placement is
    // the whole design: W1-b replaces the send adapter wholesale, and a gate
    // living inside the adapter would leave with it. Here, an `'internal'`
    // record simply never becomes a send candidate, whatever is wired below.
    //
    // Terminal, not deferred: we journal the nonce and delete the record, so a
    // second tick has nothing to look at and the decision survives a restart.
    // The escalation is STRUCTURED TELEMETRY on a non-chat channel — internal
    // prose has exactly one exit from this pipeline, and it is not Telegram.
    if (shouldSuppressForAudience(record, { gateEnabled: audienceGateEnabled })) {
      summary.skipped++
      summary.audienceSuppressed = (summary.audienceSuppressed ?? 0) + 1
      const ageMs = now - record.createdAt
      appendDelivered(
        {
          turnNonce: record.turnNonce,
          textSha256: record.textSha256,
          ts: now,
          // The record is TERMINALLY resolved by the sweep machine — the same
          // provenance a delivery would carry, so every exactly-once guard
          // (`backstopAlreadyDelivered`, the turn-flush backstop) also treats
          // this turn as settled and no other machine re-delivers the prose.
          deliverySource: 'sweep',
          replyAlreadyDeliveredThisTurn: record.replyAlreadyDeliveredThisTurn === true,
          audience: AUDIENCE_INTERNAL,
          // The honest terminal state: withheld by design. Recorded as an
          // explicit named outcome rather than as an absence, so suppression
          // reads as telemetry and never as a delivery failure.
          suppressedAudience: AUDIENCE_INTERNAL,
        },
        deps.stateDir,
      )
      clearOutboxRecord(record.turnNonce, deps.stateDir)
      escalateInternalSuppression(
        formatInternalSuppression({
          turnNonce: record.turnNonce,
          turnId: turnIdFromNonce(record.turnNonce),
          chatId: record.chatId,
          textSha256: record.textSha256,
          ageMs,
          source: record.source,
          pastWindow: ageMs > OUTBOX_MAX_AGE_MS,
        }),
      )
      continue
    }

    // Resolve destination (anchor → registry chain → per-session origin). Fails
    // CLOSED (null → held) rather than routing to an arbitrary chat (F2).
    const resolved = resolveOutboxChat(record, {
      registryChainLookup: (anchorContent) => {
        const taskId = extractTaskId(anchorContent)
        if (taskId == null || deps.registryChainLookup == null) return null
        return deps.registryChainLookup(taskId)
      },
    })

    const routePrefix = resolved?.via === 'origin' ? '(from background task) ' : ''
    const decision = decideOutboxSweep({
      record,
      now,
      deliveredNonces,
      textAlreadyDelivered:
        resolved != null &&
        deps.textAlreadyDelivered(resolved.chatId, resolved.threadId, record.text),
      routable: resolved != null,
      routePrefix,
      quietMs: deps.quietMs ?? OUTBOX_QUIET_MS,
      // #3513: suppress a record whose text was already surfaced on the ephemeral
      // progress card for this turn (durable shown-ledger). The invariant forbids
      // a second, out-of-process delivery of an ephemeral-shown block.
      shownLedgerHit: isShownBlock(record.turnNonce, record.text, deps.stateDir),
      // ── W1-d follow-up (#4141): PROVENANCE FRAMING ───────────────────────
      //
      // The residual case #4140 deliberately leaves open: the reply tool threw
      // on a FOREGROUND turn, so the inbound obligation is still OPEN, the
      // record classifies `'user'`, and the captured trailing prose delivers
      // presented as if it were the answer.
      //
      // We do NOT suppress here, and that is the design, not a compromise.
      // Someone is provably still waiting; there is no deterministic signal
      // that separates "working notes" from "the answer re-written as plain
      // prose after the tool errored" (see `audience-classify.mjs`). Dropping
      // the text would trade a visible wrong-content failure for an invisible
      // no-answer one — the exact severity-3 class this whole line of work
      // exists to prevent. So we state the provenance instead, and the human
      // (who can tell the difference, unlike any classifier here) decides.
      provenanceFraming: provenanceFramingEnabled,
      // Ken 2026-08-07: label any review-originated record that reaches delivery
      // (the audience gate's default suppression already withheld it above; this
      // covers the gate-off / `user`-route residual) with the self-improvement
      // title, so review reasoning can never appear as raw, unlabelled prose.
      selfImprovementFraming: selfImprovementFramingEnabled,
    })

    if (decision.action !== 'send' && decision.action !== 'send-delayed') {
      summary.skipped++
      if (decision.action === 'skip-ephemeral-shown') {
        // Ephemeral-shown (#3513): the block already lives on the progress card.
        // Journal the nonce and drop the record so the sweep never re-scans it
        // and a racing machine also skips — same terminal bookkeeping as a dedup
        // hit, but the reason is "assigned to the ephemeral surface".
        appendDelivered(
          {
            turnNonce: record.turnNonce,
            textSha256: record.textSha256,
            ts: now,
            deliverySource: 'sweep',
            replyAlreadyDeliveredThisTurn: record.replyAlreadyDeliveredThisTurn === true,
          },
          deps.stateDir,
        )
        clearOutboxRecord(record.turnNonce, deps.stateDir)
        log(`outbox-sweep: suppressed ephemeral-shown nonce=${record.turnNonce}\n`)
      } else if (decision.action === 'skip-journaled') {
        // Already delivered under this nonce by another machine → drop the
        // pending record. clearOutboxRecord unlinks the `.json` (the pending
        // file) AND any `.sending` — the pre-fix `removeClaimed` only unlinked
        // `.sending`, leaking the `.json` to be rescanned forever (S4).
        clearOutboxRecord(record.turnNonce, deps.stateDir)
      } else if (decision.action === 'skip-dedup') {
        // F1: the identical text was already delivered by the legacy flush/reply
        // (in-memory `outboundDedup` hit). JOURNAL the nonce and DELETE the
        // record NOW, so once that in-memory cache's TTL evicts (~60s) the sweep
        // cannot resurrect and re-send this turn's answer. Deterministic
        // exactly-once, independent of cache lifetime and surviving a restart
        // (the record is gone from disk, the nonce is durably journaled).
        appendDelivered(
          {
            turnNonce: record.turnNonce,
            textSha256: record.textSha256,
            ts: now,
            deliverySource: 'sweep',
            replyAlreadyDeliveredThisTurn: record.replyAlreadyDeliveredThisTurn === true,
          },
          deps.stateDir,
        )
        clearOutboxRecord(record.turnNonce, deps.stateDir)
      }
      continue
    }

    // Claim (rename mutex). If lost, another sweep/machine has it.
    const claimed = claimRecord(record.turnNonce, deps.stateDir)
    if (claimed == null) {
      summary.skipped++
      continue
    }
    const resolvedChat = resolved! // routable implies non-null

    try {
      const sendResult = await deps.send(
        resolvedChat.chatId,
        resolvedChat.threadId,
        decision.text ?? record.text,
      )
      appendDelivered(
        {
          turnNonce: record.turnNonce,
          textSha256: record.textSha256,
          tgMessageId: sendResult.messageId,
          ts: now,
          // #3510 instrumentation: a sweep delivery journals its machine and the
          // record's capture-time reply-already-delivered flag, so a duplicate
          // (deliverySource:'sweep' after a reply-tool delivery of the same
          // turn) is provable from the journal alone.
          deliverySource: 'sweep',
          replyAlreadyDeliveredThisTurn: record.replyAlreadyDeliveredThisTurn === true,
          // #4141: the durable terminal stamp for a framed delivery. Written on
          // the same line as the delivery it describes, so "what did the user
          // actually see" is answerable from the journal alone after the logs
          // have rotated.
          ...(decision.framedProvenance != null
            ? { framedProvenance: decision.framedProvenance }
            : {}),
          // Ken 2026-08-07: durable terminal stamp for a self-improvement-framed
          // delivery — same reasoning as `framedProvenance`.
          ...(decision.framedSelfImprovement != null
            ? { framedSelfImprovement: decision.framedSelfImprovement }
            : {}),
        },
        deps.stateDir,
      )
      if (decision.framedProvenance != null) {
        summary.provenanceFramed = (summary.provenanceFramed ?? 0) + 1
        logProvenanceFraming(
          formatReplyThrowFraming({
            turnNonce: record.turnNonce,
            turnId: turnIdFromNonce(record.turnNonce),
            chatId: resolvedChat.chatId,
            textSha256: record.textSha256,
            source: record.source,
          }),
        )
      }
      if (decision.framedSelfImprovement != null) {
        summary.selfImprovementFramed = (summary.selfImprovementFramed ?? 0) + 1
        logSelfImprovementFraming(
          formatSelfImprovementFraming({
            turnNonce: record.turnNonce,
            turnId: turnIdFromNonce(record.turnNonce),
            chatId: resolvedChat.chatId,
            textSha256: record.textSha256,
            source: record.source,
          }),
        )
      }
      // Persist parity (mirrors outbound-send-path.ts + backstop-delivery.ts):
      // record the delivered chunk ids + texts to history so a net-delivered
      // answer is not silently absent from history.db. Best-effort — a missing
      // recorder or a throw must never break this safety-net delivery.
      if (deps.recordOutbound != null && sendResult.chunks.length > 0) {
        try {
          deps.recordOutbound(
            resolvedChat.chatId,
            resolvedChat.threadId,
            sendResult.chunks.map((c) => c.messageId),
            sendResult.chunks.map((c) => c.text),
          )
        } catch {
          /* best-effort — the delivery already landed; never throw here */
        }
      }
      removeClaimed(record.turnNonce, deps.stateDir)
      summary.delivered++
      log(
        `outbox-sweep: delivered nonce=${record.turnNonce} via=${resolvedChat.via} ` +
          `source=${record.source} chars=${record.text.length}${decision.action === 'send-delayed' ? ' (delayed)' : ''}\n`,
      )
    } catch (err) {
      // Send failed — release the claim so the next tick retries. The record is
      // preserved on disk; no loss.
      releaseClaim(record.turnNonce, deps.stateDir)
      summary.skipped++
      summary.sendFailures++
      log(`outbox-sweep: send failed nonce=${record.turnNonce}: ${(err as Error).message} — will retry\n`)
    }
  }
  return summary
}

/**
 * W1-d (#3865): recover the gateway `turnId` from an envelope-derived nonce.
 *
 * `deriveTurnNonce` builds `${chatId}:${threadId||'_'}#${messageId}` — byte-
 * identical to the gateway's `deriveTurnId` — so an envelope-bearing nonce IS
 * the turn id and `extractTurnId` in `src/fleet-health/detect.ts` can join the
 * suppression telemetry back to the turn record. The sha256 fallback nonce
 * (envelope-less anchors) carries no turn id; return null rather than emit a
 * hash that looks like one.
 */
export function turnIdFromNonce(nonce: string): string | null {
  return /^-?\d+:[^#]*#\d+$/.test(nonce) ? nonce : null
}

/** Read the flood probe, failing OPEN on any throw. */
function probeFloodWindow(probe: (() => number) | undefined): number {
  if (probe == null) return 0
  try {
    const ms = probe()
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  } catch {
    return 0
  }
}

/**
 * Parse a registry `turn_key` (`chatId:threadId`, `_` → null thread) into a
 * routable chat. Exported for the gateway wiring + tests.
 */
export function chatFromTurnKey(turnKey: string): { chatId: string; threadId: number | null } {
  const idx = turnKey.indexOf(':')
  const chatId = idx === -1 ? turnKey : turnKey.slice(0, idx)
  const tRaw = idx === -1 ? '_' : turnKey.slice(idx + 1)
  const t = tRaw === '_' || tRaw === '' ? null : Number(tRaw)
  return { chatId, threadId: Number.isFinite(t as number) ? t : null }
}

/** How often the sweep ticks (aligned with the delivery-confirm sweep cadence). */
export const OUTBOX_SWEEP_INTERVAL_MS = 5_000

/** Ceiling on the exponential send-failure backoff. */
export const OUTBOX_SWEEP_BACKOFF_MAX_MS = 5 * 60_000

/**
 * Minimum gap between two "flood window still open" log lines. A 4.4h ban is
 * ~3181 ticks; logging each one just relocates the flood from the wire to the
 * disk, so the deferral is reported once a minute instead.
 */
export const OUTBOX_SWEEP_DEFER_LOG_INTERVAL_MS = 60_000

/**
 * Exponential backoff over the fixed 5s sweep tick (#3853).
 *
 * The tick interval alone is not a retry policy. On 2026-07-27 the sweep held
 * ONE undeliverable record and re-issued its `sendMessage` every 5s for the
 * whole 4.4h ban — 228 requests into a window the breaker already knew was
 * open, each one answered with the same counting-down `retry_after`. The flood
 * probe (above) closes the case where the breaker HAS a window recorded; this
 * closes the case where it does not — a persistent failure of any other kind
 * must not be re-driven at 12 requests/minute forever.
 *
 * Pure and clock-injected so the schedule is asserted in tests rather than
 * inferred from timer behaviour.
 */
export function createSweepBackoff(cfg: { baseMs?: number; maxMs?: number } = {}): {
  ready: (now: number) => boolean
  noteFailure: (now: number) => number
  noteSuccess: () => void
  failures: () => number
} {
  const baseMs = cfg.baseMs ?? OUTBOX_SWEEP_INTERVAL_MS
  const maxMs = cfg.maxMs ?? OUTBOX_SWEEP_BACKOFF_MAX_MS
  let failures = 0
  let nextAllowedAt = 0
  return {
    ready: (now) => now >= nextAllowedAt,
    noteFailure: (now) => {
      failures++
      // 5s, 10s, 20s, … capped. `failures - 1` so the FIRST failure still
      // retries at the normal tick cadence — a one-off transient send error
      // should not delay a real answer.
      const delay = Math.min(maxMs, baseMs * Math.pow(2, failures - 1))
      nextAllowedAt = now + delay
      return delay
    },
    noteSuccess: () => {
      failures = 0
      nextAllowedAt = 0
    },
    failures: () => failures,
  }
}

/**
 * Own the heartbeat-tick outbox sweep entirely, keeping the timer / chunking /
 * turn-key parse / dedup / registry-chain wiring OUT of `gateway.ts` (the line
 * ratchet). The gateway passes only the primitives that must come from its
 * scope: lazy getters for `bot` / `turnsDb` (both assigned late), its live
 * `OutboundDedupCache`, and the state dir. Returns the interval handle (unref'd)
 * or `undefined` when disabled / not the main process.
 *
 * Delivery reuses `bot.api.sendMessage` and chunks to Telegram's 4096-char
 * ceiling so an oversized record can never wedge the sweep in a permanent
 * retry loop. Routing runs the transitive registry chain
 * (`resolveSubagentOriginTurnKey`) then the last-real-inbound fallback (H3).
 * Kill switch: `SWITCHROOM_TG_OUTBOX_DELIVERY=0`.
 */
/** A Telegram inline keyboard the sweep attaches to the FINAL delivered chunk
 *  (the 🔊 Listen button / voice-out keyboard — switchroom #3502 regression fix,
 *  so a net-delivered answer keeps the same button a `sendReply` answer gets).
 *  Shaped to match `planListenButton().replyMarkup`. */
export type OutboxDeliveryMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}

/** Minimal bot-api surface the sweep needs to deliver text. `sendRichMessage`
 *  is the canonical rendered path (raw GFM markdown → entities); `sendMessage`
 *  is the plain parse-reject fallback. */
type OutboxSendBot = {
  api: {
    sendMessage: (
      chatId: string,
      text: string,
      opts: object,
    ) => Promise<{ message_id?: number }>
    sendRichMessage: (
      chatId: string,
      body: { markdown: string },
      opts: object,
    ) => Promise<{ message_id?: number }>
  }
}

/**
 * Send ONE chunk with RENDER PARITY: ship raw GFM markdown through the shared
 * `richMessage` → `sendRichMessage` path — the SAME renderer the reply path
 * uses (`outbound-send-path.ts`) — so a net-delivered answer is formatted
 * identically to a normally-delivered one (no more literal `**bold**`). On a
 * markdown PARSE-REJECT, resend the same chunk as PLAIN text (the raw markdown
 * source is itself readable prose), mirroring the reply path's plaintext
 * fallback (`outbound-send-path.ts`). A length / thread / flood error is NOT
 * caught here — it propagates so `retryWithThreadFallback` and the sweep's
 * claim-release retry handle it, exactly as before.
 */
/**
 * #4043: the plain fallback is RE-CAPPED to `PLAIN_TEXT_MAX_CHARS` (4096). The
 * caller splits at the RICH cap (32768 — `splitMarkdownChunks`' default), so an
 * oversized chunk that parse-rejected used to be re-sent to the plain endpoint
 * whole, get `message is too long`, throw, release the claim, and retry on the
 * NEXT tick forever: the record could never be delivered and never cleared.
 * Returns one entry per message actually landed (the plain fallback can land
 * several) so the caller's history / journal bookkeeping stays aligned with the
 * wire. A trailing `reply_markup` (the Listen button) rides the FINAL piece
 * only, exactly as it rides the final chunk.
 */
/**
 * Resume state for ONE chunk, owned by the caller and therefore SURVIVING a
 * re-invocation of the send closure.
 *
 * The caller wraps this whole function — the multi-send plain-fallback loop
 * included — in `retryWithThreadFallback(deps.retry, …)`, and
 * `createRetryApiCall` re-invokes the closure it was given after a flood wait
 * (`../retry-api-call.ts`). Without resume state, a 429 on plain piece 4 of 5
 * meant the retry re-ran the closure from the top: the rich send
 * DETERMINISTICALLY parse-rejects again and pieces 1-3 are re-delivered to the
 * user's chat — repeating every attempt until the whole loop happens to
 * succeed. A mid-loop 429 is likely precisely in the flood conditions the
 * sweep runs under, so this is the common case, not the exotic one.
 *
 * Carrying landed-piece state (rather than wrapping each `sendMessage` in its
 * own nested `deps.retry`) is what makes the send IDEMPOTENT under ANY
 * re-invocation — the retry policy's flood re-drive AND
 * `retryWithThreadFallback`'s thread-drop re-drive — instead of only the one
 * we thought of. Nesting a retry inside the outer retry would instead multiply
 * the attempt and flood-sleep budgets (maxRetries²) at exactly the moment the
 * policy exists to issue LESS, and would still re-send pieces 1-3 whenever the
 * inner budget was exhausted and the error bubbled to the outer wrapper.
 */
interface ChunkSendState {
  /** The rich send already parse-rejected — skip straight to the plain loop. */
  parseRejected: boolean
  /** Plain pieces already ON THE WIRE, in order. Never re-sent. */
  landed: Array<{ message_id?: number; text: string }>
}

function newChunkSendState(): ChunkSendState {
  return { parseRejected: false, landed: [] }
}

async function sendChunkRich(
  bot: OutboxSendBot,
  chatId: string,
  chunk: string,
  opts: object,
  state: ChunkSendState = newChunkSendState(),
): Promise<Array<{ message_id?: number; text: string }>> {
  // A re-invocation after the rich send already parse-rejected must NOT
  // re-issue it: the reject is deterministic (same body, same renderer), so
  // the only thing another attempt buys is one more 400 against a
  // flood-sensitive endpoint.
  if (!state.parseRejected) {
    try {
      // allow-raw-bot-api: caller (createOutboxSend) invokes this inside retryWithThreadFallback + createRetryApiCall
      const sent = await bot.api.sendRichMessage(chatId, richMessage(chunk), opts)
      return [{ message_id: sent?.message_id, text: chunk }]
    } catch (err) {
      if (!isParseEntitiesError(err)) throw err
      state.parseRejected = true
    }
  }

  const pieces = splitPlainTextToCap(chunk)
  const withoutMarkup = { ...(opts as Record<string, unknown>) }
  delete withoutMarkup.reply_markup
  // Resume at the first piece that has NOT landed. On a first invocation
  // `landed` is empty and this is the plain 0..n loop.
  for (let p = state.landed.length; p < pieces.length; p++) {
    const isFinalPiece = p === pieces.length - 1
    // allow-raw-bot-api: parse-reject plain fallback, still inside the sweep's retryWithThreadFallback wrapper
    const sent = await bot.api.sendMessage(
      chatId,
      pieces[p],
      isFinalPiece ? opts : withoutMarkup,
    )
    // Recorded BEFORE the next iteration can throw, so a mid-loop failure
    // leaves the state pointing at the first UNSENT piece.
    state.landed.push({ message_id: sent?.message_id, text: pieces[p] })
  }
  return state.landed
}

/**
 * Build the chunked `send` the sweep hands to {@link sweepOutbox}. Extracted +
 * exported so the reply-markup attachment (the #3502 fix) is unit-testable
 * without a live gateway or timer.
 *
 * `resolveReplyMarkup` resolves the voice-out Listen button / keyboard for a
 * delivery (null/undefined → no button). It is applied to the FINAL chunk ONLY
 * so the button lands on the last visible message, exactly like the normal
 * `sendReply` path (buttons attach to the last chunk there too). This makes a
 * safety-net-delivered final answer indistinguishable from a normally-delivered
 * one instead of silently dropping the button.
 */
export function createOutboxSend(deps: {
  getBot: () => OutboxSendBot | undefined
  retry: Parameters<typeof retryWithThreadFallback>[0]
  resolveReplyMarkup?: (
    chatId: string,
    threadId: number | null,
    text: string,
  ) => OutboxDeliveryMarkup | undefined
}): OutboxSweepDeps['send'] {
  return async (chatId, threadId, text) => {
    const bot = deps.getBot()
    if (bot == null) throw new Error('outbox-sweep: bot unavailable')
    // Empty text → nothing to deliver. Telegram rejects an empty message body,
    // so sending one chunk of '' would throw every tick and wedge the sweep in
    // a permanent retry (the record never journals → never clears). Return
    // early, matching the pre-refactor loop's zero-chunk behaviour.
    if (text.length === 0) return { messageId: undefined, chunks: [] }
    // Resolve the Listen button / keyboard ONCE from the full answer text; it
    // rides only on the final chunk below.
    const replyMarkup = deps.resolveReplyMarkup?.(chatId, threadId, text)
    // Chunk with the markdown-boundary-aware splitter the reply path uses
    // (`splitMarkdownChunks`), NOT a blind fixed-char slice — a raw slice can
    // bisect an inline entity (`**bold**`) and force a parse-reject. Each chunk
    // goes through the standard retry / flood-wait / thread-fallback wrapper. A
    // thrown send propagates so the sweep releases the claim and retries next
    // tick (the record is never journaled → never lost).
    const landed: Array<{ messageId: number; text: string }> = []
    const chunks = splitMarkdownChunks(text)
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx]
      const isLast = idx === chunks.length - 1
      // Per-chunk resume state, OUTSIDE the closure the retry policy
      // re-invokes: a flood wait mid plain-fallback loop must resume at the
      // first unsent piece, not re-deliver the ones already in the chat.
      const chunkState = newChunkSendState()
      const res = await retryWithThreadFallback(
        deps.retry,
        (tid) => {
          const base = tid != null ? { message_thread_id: tid } : {}
          // Button on the LAST chunk only (final visible message).
          const opts =
            isLast && replyMarkup != null ? { ...base, reply_markup: replyMarkup } : base
          return sendChunkRich(bot, chatId, chunk, opts, chunkState)
        },
        { threadId: threadId ?? undefined, chat_id: chatId, verb: 'outbox-sweep.sendMessage' },
      )
      // One entry per message that actually landed — the #4043 plain fallback
      // can split ONE rich chunk into several 4096-capped plain messages, and
      // history/backstop bookkeeping must reflect the wire, not the pre-split
      // chunk.
      for (const sent of res ?? []) {
        if (sent.message_id != null) landed.push({ messageId: sent.message_id, text: sent.text })
      }
    }
    return {
      messageId: landed.length > 0 ? landed[landed.length - 1]!.messageId : undefined,
      chunks: landed,
    }
  }
}

/**
 * Build the heartbeat tick that {@link startOutboxSweep} hands to `setInterval`,
 * with the SINGLE-FLIGHT guard (#3864).
 *
 * The tick fires every `OUTBOX_SWEEP_INTERVAL_MS` and the sweep it starts is
 * `void`-ed, so a sweep that outlives its interval used to have the NEXT tick
 * start a second, concurrent sweep body against the same outbox directory. The
 * per-record rename mutex (`claimRecord`, `../outbox.ts`) keeps that from
 * double-sending a single record, but it is the only thing that does: the two
 * bodies still race the same journal / dedup / backoff state, and every
 * additional overlapping tick multiplies the wire pressure at exactly the
 * moment (a slow or flood-throttled Telegram) when the sweep must issue LESS.
 * `inFlight` makes overlap unrepresentable rather than merely survivable.
 *
 * Extracted + exported so the guard is unit-testable without a live gateway,
 * a timer, or the filesystem: pass a `runSweep` you control and drive `tick()`
 * directly.
 */
export function createOutboxSweepTick(deps: {
  /** Nothing to sweep until the bot exists (unchanged pre-guard behaviour). */
  getBot: () => unknown
  backoff: ReturnType<typeof createSweepBackoff>
  /** Run ONE sweep body. Wired by {@link startOutboxSweep} to {@link sweepOutbox}. */
  runSweep: () => Promise<OutboxSweepSummary>
  log?: (line: string) => void
  /** Test seam — clock used for the backoff gate and the defer-log throttle. */
  now?: () => number
}): (() => void) & { inFlight: () => boolean } {
  const now = deps.now ?? (() => Date.now())
  let lastDeferLogAt = 0
  let inFlight = false
  let overlapSkips = 0
  const tick = () => {
    if (deps.getBot() == null) return
    if (!deps.backoff.ready(now())) return
    // #3864 — a sweep is still running; skip this tick entirely rather than
    // starting a second concurrent body. Skipping is free: the outbox is a
    // durable safety net with no latency SLA, and the in-flight sweep will
    // pick up anything this tick would have.
    if (inFlight) {
      overlapSkips++
      if (overlapSkips === 1) {
        deps.log?.(
          `outbox-sweep: tick skipped — the previous sweep is still in flight ` +
            `(single-flight guard; no concurrent sweep started)\n`,
        )
      }
      return
    }
    inFlight = true
    void deps
      .runSweep()
      .then((summary) => {
        // A flood-deferred sweep is neither success nor failure: it never
        // reached the wire, so it must not clear a backoff earned by real
        // failures, and it must not deepen one either.
        if (summary.floodDeferred === true) {
          const at = now()
          if (at - lastDeferLogAt >= OUTBOX_SWEEP_DEFER_LOG_INTERVAL_MS) {
            lastDeferLogAt = at
            deps.log?.(
              `outbox-sweep: deferred — Telegram flood window still open for ` +
                `${Math.ceil((summary.floodRemainingMs ?? 0) / 1000)}s; not issuing any ` +
                `send (would feed the ban)\n`,
            )
          }
          return
        }
        if (summary.sendFailures > 0) {
          const delay = deps.backoff.noteFailure(now())
          deps.log?.(
            `outbox-sweep: ${summary.sendFailures} send failure(s) — backing off ` +
              `${Math.round(delay / 1000)}s before the next sweep (attempt ${deps.backoff.failures()})\n`,
          )
        } else {
          deps.backoff.noteSuccess()
        }
      })
      .catch((err) => deps.log?.(`outbox-sweep: tick failed: ${(err as Error).message}\n`))
      .finally(() => {
        inFlight = false
        if (overlapSkips > 0) {
          deps.log?.(
            `outbox-sweep: sweep finished; ${overlapSkips} tick(s) were skipped while it ran\n`,
          )
          overlapSkips = 0
        }
      })
  }
  return Object.assign(tick, { inFlight: () => inFlight })
}

export function startOutboxSweep(deps: {
  isGatewayMain: boolean
  stateDir: string
  getBot: () => OutboxSendBot | undefined
  getTurnsDb: () => Parameters<typeof resolveSubagentOriginTurnKey>[0] | null
  dedupCheck: (chatId: string, threadId: number | undefined, text: string) => boolean
  /** Resolve the voice-out Listen button / keyboard for a net delivery. Wired
   *  by the gateway (loadAccess → resolveVoiceOutPlan → planListenButton +
   *  cache put + eager pre-synth). Absent → deliver plain (legacy behaviour). */
  resolveReplyMarkup?: (
    chatId: string,
    threadId: number | null,
    text: string,
  ) => OutboxDeliveryMarkup | undefined
  /** Persist a sweep-delivered answer to history — forwarded to {@link sweepOutbox}
   *  as {@link OutboxSweepDeps.recordOutbound}. Wired by the gateway to the shared
   *  `recordOutbound` (history.ts). Absent → no history row (legacy behaviour). */
  recordOutbound?: OutboxSweepDeps['recordOutbound']
  log?: (line: string) => void
  /** Test seam — override the flood probe (default: the persisted breaker). */
  floodWaitRemainingMs?: () => number
  /** Test seam — override the tick backoff. */
  backoff?: ReturnType<typeof createSweepBackoff>
}): ReturnType<typeof setInterval> | undefined {
  if (!deps.isGatewayMain || process.env.SWITCHROOM_TG_OUTBOX_DELIVERY === '0') return undefined
  // #3853 — the sweep is a full outbound machine and must consult the SAME
  // persisted flood breaker every other outbound path does. Before this it was
  // the one `createRetryApiCall` wiring with neither hook: it could not see an
  // open ban (no `floodWaitRemainingMs`) and could not record one it caused (no
  // `onFloodWait`). `scripts/check-retry-flood-hooks.mjs` now fails lint if any
  // wiring omits either.
  const floodProbe =
    deps.floodWaitRemainingMs ?? makeFloodWaitProbe(floodStatePath(deps.stateDir))
  const recordFloodWait = makeFloodWaitRecorder(floodStatePath(deps.stateDir))
  const retry = createRetryApiCall({
    log: deps.log,
    floodWaitRemainingMs: floodProbe,
    onFloodWait: (retryAfterSec) => recordFloodWait(retryAfterSec),
  })
  const send = createOutboxSend({
    getBot: deps.getBot,
    retry,
    ...(deps.resolveReplyMarkup != null ? { resolveReplyMarkup: deps.resolveReplyMarkup } : {}),
  })
  const backoff = deps.backoff ?? createSweepBackoff()
  const tick = createOutboxSweepTick({
    getBot: deps.getBot,
    backoff,
    log: deps.log,
    runSweep: () =>
      sweepOutbox({
        stateDir: deps.stateDir,
        log: deps.log,
        send,
        ...(deps.recordOutbound != null ? { recordOutbound: deps.recordOutbound } : {}),
        floodWaitRemainingMs: floodProbe,
        textAlreadyDelivered: (chatId, threadId, text) => deps.dedupCheck(chatId, threadId ?? undefined, text),
        registryChainLookup: (taskId) => {
          const db = deps.getTurnsDb()
          if (db == null) return null
          const turnKey = resolveSubagentOriginTurnKey(db, taskId)
          return turnKey == null ? null : chatFromTurnKey(turnKey)
        },
      }),
  })
  const timer = setInterval(tick, OUTBOX_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return timer
}

/**
 * Journal a delivery made by a NON-sweep machine (legacy turn-flush /
 * captured-prose bridge / exhausted fallback / final-answer reply send) under
 * the shared nonce, AND drop any pending outbox record for it — the reply-path
 * clear-by-nonce (H1/F1). Wired at every legacy delivery site with the gateway's
 * own `deriveTurnId` nonce (`turn.turnId`), which is byte-identical to the
 * hook's `deriveTurnNonce` `${chatKey}#${messageId}` for a gateway-visible turn, so:
 *   - the journal write makes a later sweep skip-journaled even after the
 *     in-memory `outboundDedup` TTL has evicted or the gateway restarted, and
 *   - `clearOutboxRecord` removes the hook's captured record immediately when
 *     the flush text differs from the captured text (text-dedup would miss).
 * Best-effort; never throws. A null/empty nonce is ignored (nothing to journal).
 */
export function journalExternalDelivery(
  args: {
    turnNonce: string | null
    text: string
    tgMessageId?: number
    /**
     * #3510 instrumentation: whether a qualifying reply had already delivered
     * this turn at the time of this delivery. Reply-send sites pass `true`
     * (they ARE that delivery); the captured-prose bridge omits it (its turn
     * shape is decided upstream). Journaled so a later sweep entry under the
     * same nonce is provably a double-send from the journal alone.
     */
    replyAlreadyDeliveredThisTurn?: boolean
    /**
     * #3513 follow-up: which backstop/machine delivered. Defaults to
     * `'reply-tool'` (the E0/E3 reply-path callers). The turn-flush backstop
     * (E1/E2) passes `'flush'` so `backstopAlreadyDelivered` recognises it as a
     * prior backstop and E3/E4 skip a duplicate durably (across a crash between
     * the flush send and its journal write), not just via the in-memory dedup.
     */
    deliverySource?: 'sweep' | 'reply-tool' | 'flush'
    /**
     * #4141: this delivery carried the reply-throw provenance banner. Durable
     * terminal stamp mirroring the sweep's own `DeliveredEntry.framedProvenance`,
     * so "was the recipient told where this text came from?" is answerable from
     * the journal alone — on EITHER delivery path (sweep or captured-prose
     * bridge), hours later.
     */
    framedProvenance?: 'reply-throw'
  },
  stateDir?: string,
  now: number = Date.now(),
): void {
  const nonce = args.turnNonce
  if (nonce == null || nonce === '') return
  appendDelivered(
    {
      turnNonce: nonce,
      // Hashed on the RAW text, deliberately: the banner is presentation, and
      // the journal key must stay stable across framed/unframed so
      // exactly-once-among-backstops keeps working (#4141).
      textSha256: sha256Hex(args.text),
      tgMessageId: args.tgMessageId,
      ts: now,
      deliverySource: args.deliverySource ?? 'reply-tool',
      ...(args.replyAlreadyDeliveredThisTurn == null
        ? {}
        : { replyAlreadyDeliveredThisTurn: args.replyAlreadyDeliveredThisTurn }),
      ...(args.framedProvenance == null ? {} : { framedProvenance: args.framedProvenance }),
    },
    stateDir,
  )
  clearOutboxRecord(nonce, stateDir)
}

export type { OutboxRecord }
