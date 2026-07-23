/**
 * outbox-sweep.ts — the single deliverer for the guaranteed-final-message
 * outbox. Runs on the gateway heartbeat tick, independent of turn lifecycle,
 * so it covers turn CLASSES the gateway never sees a CurrentTurn for
 * (`<task-notification>` handbacks, background-worker completions, unknown
 * future wake shapes). See `../outbox.ts` for the record/nonce/journal model.
 *
 * Exactly-once (H1): every record is claimed with a rename-mutex, guarded by the
 * shared delivered-keys journal (same turnNonce every delivering machine uses),
 * and by the existing text `outboundDedup`. Delivered nonce is journaled AFTER a
 * successful send; a crash between send and journal is caught next boot by the
 * text-dedup backstop (never a loss, at most one duplicate).
 *
 * Routing (H3): `resolveOutboxChat` runs the injected transitive registry-chain
 * lookup then the last-real-inbound fallback for envelope-less records.
 *
 * The orchestration takes injected IO deps so it is unit-testable without a live
 * gateway; `gateway.ts` wires the real send / dedup / registry lookups.
 */

import {
  OUTBOX_QUIET_MS,
  appendDelivered,
  claimRecord,
  decideOutboxSweep,
  extractTaskId,
  listPendingRecords,
  readDeliveredNonces,
  readLastInboundChat,
  readOutboxRecord,
  reclaimStaleSending,
  releaseClaim,
  removeClaimed,
  resolveOutboxChat,
  sha256Hex,
  type OutboxRecord,
} from '../outbox.js'
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

    // Resolve destination (anchor → registry chain → last-inbound fallback).
    const resolved = resolveOutboxChat(record, {
      registryChainLookup: (anchorContent) => {
        const taskId = extractTaskId(anchorContent)
        if (taskId == null || deps.registryChainLookup == null) return null
        return deps.registryChainLookup(taskId)
      },
      lastInboundChat: () => readLastInboundChat(deps.stateDir),
    })

    const routePrefix = resolved?.via === 'last-inbound' ? '(from background task) ' : ''
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
    })

    if (decision.action !== 'send' && decision.action !== 'send-delayed') {
      summary.skipped++
      if (decision.action === 'skip-journaled') removeClaimed(record.turnNonce, deps.stateDir)
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
        { turnNonce: record.turnNonce, textSha256: record.textSha256, tgMessageId: messageId, ts: now },
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
export function startOutboxSweep(deps: {
  isGatewayMain: boolean
  stateDir: string
  getBot: () => { api: { sendMessage: (chatId: string, text: string, opts: object) => Promise<{ message_id?: number }> } } | undefined
  getTurnsDb: () => Parameters<typeof resolveSubagentOriginTurnKey>[0] | null
  dedupCheck: (chatId: string, threadId: number | undefined, text: string) => boolean
  log?: (line: string) => void
}): ReturnType<typeof setInterval> | undefined {
  if (!deps.isGatewayMain || process.env.SWITCHROOM_TG_OUTBOX_DELIVERY === '0') return undefined
  const retry = createRetryApiCall({ log: deps.log })
  const tick = () => {
    const bot = deps.getBot()
    if (bot == null) return
    void sweepOutbox({
      stateDir: deps.stateDir,
      log: deps.log,
      send: async (chatId, threadId, text) => {
        // Chunk to Telegram's 4096-char ceiling; each chunk goes through the
        // standard retry / flood-wait / thread-fallback wrapper. A thrown send
        // propagates so the sweep releases the claim and retries next tick (the
        // record is never journaled → never lost).
        let lastId: number | undefined
        for (let i = 0; i < text.length; i += 4000) {
          const chunk = text.slice(i, i + 4000)
          const res = await retryWithThreadFallback(
            retry,
            (tid) => bot.api.sendMessage(chatId, chunk, tid != null ? { message_thread_id: tid } : {}),
            { threadId: threadId ?? undefined, chat_id: chatId, verb: 'outbox-sweep.sendMessage' },
          )
          lastId = res?.message_id
        }
        return lastId
      },
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
 * the shared nonce, and drop any pending outbox record for it — the reply-path
 * clear-by-nonce (H1). Call this at every existing delivery site with the
 * gateway's own `deriveTurnId` nonce so the sweep never double-posts.
 */
export function journalExternalDelivery(
  args: { turnNonce: string; text: string; tgMessageId?: number },
  stateDir?: string,
  now: number = Date.now(),
): void {
  appendDelivered(
    { turnNonce: args.turnNonce, textSha256: sha256Hex(args.text), tgMessageId: args.tgMessageId, ts: now },
    stateDir,
  )
}

export { writeLastInboundChat } from '../outbox.js'
export type { OutboxRecord }
