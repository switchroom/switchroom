/**
 * flood-reply-queue.ts — durably queue a USER-FACING reply that Telegram's
 * flood window refused, instead of throwing its content away.
 *
 * The hole this closes (#3861). `retryApiCall` short-circuits BEFORE the wire
 * when the persisted breaker reports a window longer than its in-process sleep
 * ceiling, throwing the `FLOOD_WAIT_ACTIVE` marker (`retry-api-call.ts:198`,
 * `:252`). That is the right call for the WIRE — nothing can succeed while the
 * ban is open — but it is a bare `throw`, and the reply path's chunk-loop catch
 * only re-wrapped it:
 *
 *     reply failed after 0 of 1 chunk(s) sent: FLOOD_WAIT_ACTIVE
 *
 * The composed answer died in that string. Reproduced live on 2026-07-28: the
 * error came back to the MCP caller and NO record appeared in the agent's
 * `telegram/outbox/`. The durable-outbox work-loss guarantee was real for the
 * outbox-delivered paths and false for the interactive reply path — so during a
 * multi-hour ban the agent's actual answers to the operator were the one class
 * of content that was silently lost.
 *
 * What this module does: classify the failure, and for anything that is not
 * droppable (`cosmetic`) write the text into the SAME durable outbox the sweep
 * already drains, under a CONTENT-derived nonce. The sweep (which since #3854
 * defers while the window is open) delivers it when the window closes.
 *
 * Two design choices worth stating, because both are load-bearing:
 *
 * 1. CONTENT-derived nonce, not the turn nonce. `writeOutboxRecordAtomic` is
 *    idempotent per nonce and the sweep's delivered-keys journal is keyed by
 *    nonce, so a content nonce gives caller-retry dedup (same text ⇒ same file
 *    ⇒ one delivery, and after delivery the journal makes a re-queue a no-op)
 *    WITHOUT inheriting the turn nonce's failure mode: an earlier successful
 *    reply in the same turn journals `turn.turnId` as delivered, which would
 *    make a later flood-blocked answer queued under that same nonce
 *    `skip-journaled` — i.e. dropped. Never drop the answer.
 *
 * 2. `cosmetic` is NOT queued. A typing indicator or a card edit that missed
 *    its moment is worthless (and actively confusing) delivered hours later;
 *    the priority classes already in the tree say so. `critical` / `useful` /
 *    untagged are queued.
 */

import { sha256Hex, writeOutboxRecordAtomic, type OutboxRecord } from '../outbox.js'
import { isFloodWaitActiveError } from '../retry-api-call.js'

/** The `source` stamped on records this module writes (diagnostic only). */
export const FLOOD_QUEUED_SOURCE = 'flood-deferred-reply'

/** Priority classes as used by `retry-api-call.ts` / `outbound-class.ts`. */
export type QueuePriorityClass = 'critical' | 'useful' | 'cosmetic' | undefined

/**
 * True when `err` is a Telegram flood rejection — the local `FLOOD_WAIT_ACTIVE`
 * fail-fast, a raw 429, or a wrapper whose message carries either.
 *
 * Deliberately duck-typed as well as `instanceof`-checked: the marker error
 * carries Telegram's own `{ error_code: 429, parameters: { retry_after } }`
 * shape, several surfaces re-wrap it in a plain `Error`, and the reply path's
 * own partial-failure contract wraps it in
 * `reply failed after N of M chunk(s) sent: …`.
 */
export function isFloodRejection(err: unknown): boolean {
  if (isFloodWaitActiveError(err)) return true
  const e = err as { error_code?: number; parameters?: { retry_after?: number } } | null
  if (e != null && typeof e === 'object') {
    if (e.error_code === 429) return true
    if (typeof e.parameters?.retry_after === 'number') return true
  }
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (msg.includes('FLOOD_WAIT_ACTIVE')) return true
  return /too many requests/i.test(msg) && /retry[ _-]?after/i.test(msg)
}

/** Telegram's stated `retry_after` (seconds) if the error carries one. */
export function floodRetryAfterSec(err: unknown): number | null {
  const e = err as { retryAfterSec?: number; parameters?: { retry_after?: number } } | null
  if (e != null && typeof e === 'object') {
    if (typeof e.retryAfterSec === 'number') return e.retryAfterSec
    if (typeof e.parameters?.retry_after === 'number') return e.parameters.retry_after
  }
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const m = /retry[ _-]?after[^0-9]{0,4}(\d+)/i.exec(msg)
  return m != null ? Number(m[1]) : null
}

/**
 * Stable, content-derived outbox nonce for a flood-deferred send. Same
 * chat + thread + text ⇒ same nonce ⇒ exactly one delivery however many times
 * the caller retries. Prefixed so a record's provenance is obvious on disk.
 */
export function floodQueueNonce(
  chatId: string,
  threadId: number | null,
  text: string,
): string {
  return `flood-${sha256Hex(`${chatId}\u0000${threadId ?? '_'}\u0000${text}`).slice(0, 40)}`
}

export interface FloodQueueInput {
  /** The error that killed the send. */
  err: unknown
  chatId: string
  threadId: number | null
  /** The UNDELIVERED text (for a partial failure, only the chunks that never landed). */
  text: string
  /** Priority class of the send. `cosmetic` is never queued. */
  priorityClass?: QueuePriorityClass
  /** Per-session origin chat, for the sweep's F2 scoped routing fallback. */
  originChatId?: string | null
  originThreadId?: number | null
  createdAt?: number
  stateDir?: string
  /** Injected for tests; defaults to the real atomic outbox writer. */
  write?: (record: OutboxRecord, stateDir?: string) => boolean
}

export interface FloodQueueResult {
  turnNonce: string
  retryAfterSec: number | null
  /** Human-readable outcome for the MCP caller, so the model does NOT recompose. */
  notice: string
}

/**
 * Queue a flood-blocked send to the durable outbox.
 *
 * Returns `null` — meaning "not handled, let the caller throw" — when the error
 * is not a flood rejection, when the class is `cosmetic` (legitimately
 * droppable), when there is no text left to deliver, or when the disk write
 * failed. A `null` return must never be mistaken for "delivered".
 */
export function queueFloodBlockedReply(input: FloodQueueInput): FloodQueueResult | null {
  const { err, chatId, threadId, text } = input
  if (!isFloodRejection(err)) return null
  if (input.priorityClass === 'cosmetic') return null
  if (chatId === '' || text === '') return null

  const turnNonce = floodQueueNonce(chatId, threadId, text)
  const createdAt = input.createdAt ?? Date.now()
  const record: OutboxRecord = {
    turnNonce,
    chatId,
    threadId,
    text,
    textSha256: sha256Hex(text),
    createdAt,
    source: FLOOD_QUEUED_SOURCE,
    // W1-d (#3865): a flood-deferred record is a reply the agent ALREADY chose
    // to send to this chat — its audience is never in question. Stamped
    // explicitly rather than relying on the legacy default, so this producer
    // stays correct if that default is ever revisited.
    audience: 'user',
    ...(input.originChatId != null ? { originChatId: input.originChatId } : {}),
    ...(input.originThreadId != null ? { originThreadId: input.originThreadId } : {}),
  }
  const write = input.write ?? writeOutboxRecordAtomic
  if (!write(record, input.stateDir)) return null

  const retryAfterSec = floodRetryAfterSec(err)
  const when =
    retryAfterSec != null && retryAfterSec > 0
      ? ` Telegram's flood window has ~${retryAfterSec}s left`
      : ' A Telegram flood window is open'
  return {
    turnNonce,
    retryAfterSec,
    notice:
      `reply QUEUED (not yet visible to the user):${when}, so this answer was written ` +
      `to the durable outbox and will be delivered automatically when the window ` +
      `closes. Do NOT resend it — a resend is deduplicated, and every extra call ` +
      `extends the ban. (outbox nonce ${turnNonce})`,
  }
}
