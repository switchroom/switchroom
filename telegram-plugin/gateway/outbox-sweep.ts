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
import { isShownBlock } from '../shown-ledger.js'
import { resolveSubagentOriginTurnKey } from '../registry/subagents-schema.js'
import { createRetryApiCall, retryWithThreadFallback } from '../retry-api-call.js'

export interface OutboxSweepDeps {
  /** Deliver `text` to the chat. Resolves to the primary message id (best-effort). */
  send: (
    chatId: string,
    threadId: number | null,
    text: string,
  ) => Promise<number | undefined>
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
}

export interface OutboxSweepSummary {
  scanned: number
  delivered: number
  skipped: number
}

/**
 * Sweep the outbox once. Idempotent; safe to call every heartbeat tick.
 */
export async function sweepOutbox(deps: OutboxSweepDeps): Promise<OutboxSweepSummary> {
  const now = deps.now?.() ?? Date.now()
  const log = deps.log ?? (() => {})
  const summary: OutboxSweepSummary = { scanned: 0, delivered: 0, skipped: 0 }

  // Re-queue crashed claims first (claim-then-crash before send).
  reclaimStaleSending(deps.stateDir, now)

  const pending = listPendingRecords(deps.stateDir)
  if (pending.length === 0) return summary
  const deliveredNonces = readDeliveredNonces(deps.stateDir)

  for (const fileName of pending) {
    const record = readOutboxRecord(fileName, deps.stateDir)
    if (record == null) continue
    summary.scanned++

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
      const messageId = await deps.send(
        resolvedChat.chatId,
        resolvedChat.threadId,
        decision.text ?? record.text,
      )
      appendDelivered(
        {
          turnNonce: record.turnNonce,
          textSha256: record.textSha256,
          tgMessageId: messageId,
          ts: now,
          // #3510 instrumentation: a sweep delivery journals its machine and the
          // record's capture-time reply-already-delivered flag, so a duplicate
          // (deliverySource:'sweep' after a reply-tool delivery of the same
          // turn) is provable from the journal alone.
          deliverySource: 'sweep',
          replyAlreadyDeliveredThisTurn: record.replyAlreadyDeliveredThisTurn === true,
        },
        deps.stateDir,
      )
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
      log(`outbox-sweep: send failed nonce=${record.turnNonce}: ${(err as Error).message} — will retry\n`)
    }
  }
  return summary
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

/** Minimal bot-api surface the sweep needs to deliver text. */
type OutboxSendBot = {
  api: {
    sendMessage: (
      chatId: string,
      text: string,
      opts: object,
    ) => Promise<{ message_id?: number }>
  }
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
    if (text.length === 0) return undefined
    // Resolve the Listen button / keyboard ONCE from the full answer text; it
    // rides only on the final chunk below.
    const replyMarkup = deps.resolveReplyMarkup?.(chatId, threadId, text)
    // Chunk to Telegram's 4096-char ceiling; each chunk goes through the
    // standard retry / flood-wait / thread-fallback wrapper. A thrown send
    // propagates so the sweep releases the claim and retries next tick (the
    // record is never journaled → never lost).
    let lastId: number | undefined
    const chunkCount = Math.ceil(text.length / 4000)
    for (let i = 0, idx = 0; i < text.length; i += 4000, idx++) {
      const chunk = text.slice(i, i + 4000)
      const isLast = idx === chunkCount - 1
      const res = await retryWithThreadFallback(
        deps.retry,
        (tid) => {
          const base = tid != null ? { message_thread_id: tid } : {}
          // Button on the LAST chunk only (final visible message).
          const opts =
            isLast && replyMarkup != null ? { ...base, reply_markup: replyMarkup } : base
          return bot.api.sendMessage(chatId, chunk, opts)
        },
        { threadId: threadId ?? undefined, chat_id: chatId, verb: 'outbox-sweep.sendMessage' },
      )
      lastId = res?.message_id
    }
    return lastId
  }
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
  log?: (line: string) => void
}): ReturnType<typeof setInterval> | undefined {
  if (!deps.isGatewayMain || process.env.SWITCHROOM_TG_OUTBOX_DELIVERY === '0') return undefined
  const retry = createRetryApiCall({ log: deps.log })
  const send = createOutboxSend({
    getBot: deps.getBot,
    retry,
    ...(deps.resolveReplyMarkup != null ? { resolveReplyMarkup: deps.resolveReplyMarkup } : {}),
  })
  const tick = () => {
    const bot = deps.getBot()
    if (bot == null) return
    void sweepOutbox({
      stateDir: deps.stateDir,
      log: deps.log,
      send,
      textAlreadyDelivered: (chatId, threadId, text) => deps.dedupCheck(chatId, threadId ?? undefined, text),
      registryChainLookup: (taskId) => {
        const db = deps.getTurnsDb()
        if (db == null) return null
        const turnKey = resolveSubagentOriginTurnKey(db, taskId)
        return turnKey == null ? null : chatFromTurnKey(turnKey)
      },
    }).catch((err) => deps.log?.(`outbox-sweep: tick failed: ${(err as Error).message}\n`))
  }
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
  },
  stateDir?: string,
  now: number = Date.now(),
): void {
  const nonce = args.turnNonce
  if (nonce == null || nonce === '') return
  appendDelivered(
    {
      turnNonce: nonce,
      textSha256: sha256Hex(args.text),
      tgMessageId: args.tgMessageId,
      ts: now,
      deliverySource: args.deliverySource ?? 'reply-tool',
      ...(args.replyAlreadyDeliveredThisTurn == null
        ? {}
        : { replyAlreadyDeliveredThisTurn: args.replyAlreadyDeliveredThisTurn }),
    },
    stateDir,
  )
  clearOutboxRecord(nonce, stateDir)
}

export type { OutboxRecord }
