/**
 * Sub-agent surface-chat resolution — the DB-backed seam behind the
 * gateway's `resolveSubagentOriginChat` / `resolveWorkerFeedChat` and the
 * handback/progress destination inputs.
 *
 * Extracted (Telegram msg 6897 misroute, 2026-08-04) so the FULL resolution
 * precedence — including the new most-recent-turn floor — is unit-testable
 * against a real registry DB (gateway.ts is not importable in tests; the
 * repo's `decideWorkerFeedDestination` pattern).
 *
 * Precedence (resolveWorkerSurfaceChat):
 *   1. `origin`       — the dispatch-attributed turn: jsonl_agent_id →
 *      subagents.parent_turn_key (walking the nested-parent chain) →
 *      turns.chat_id/thread_id. The correct answer whenever the row was
 *      stamped (pretool-hook marker stamp #2085, gateway dispatch stamp, or
 *      the watcher's started_at window backfill).
 *   2. `fleet`        — the configured fleet chat (permanently '' today).
 *   3. `recent-turn`  — NEW safe-degradation floor: the most recent turn's
 *      chat+topic. A gap-dispatched worker (no turns row open at its
 *      started_at, stamp missed) lands NEAR the work — in the topic the
 *      operator last drove — instead of the owner DM with the thread
 *      stripped.
 *   4. `owner-dm`     — the durable last resort ("wrong chat" beats
 *      "no card").
 */

import {
  getTurnByKey,
  findMostRecentTurn,
  type Turn,
} from '../registry/turns-schema.js'
import { resolveSubagentOriginTurnKey } from '../registry/subagents-schema.js'

/** Structural sqlite shape — byte-matches the registry modules' own
 *  bun:sqlite structural type, so handles flow both ways without casts. */
type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown
  close(): void
}

export interface SubagentSurfaceChat {
  chatId: string
  threadId?: number
}

export type SubagentSurfaceVia = 'origin' | 'fleet' | 'recent-turn' | 'owner-dm' | 'none'

/** Map a turns row to a routable {chatId, threadId}. Null when the row has
 *  no usable chat. thread_id is stored as TEXT — parse defensively. */
function turnToSurfaceChat(turn: Pick<Turn, 'chat_id' | 'thread_id'> | null): SubagentSurfaceChat | null {
  if (turn == null || turn.chat_id.length === 0) return null
  const threadNum =
    turn.thread_id != null && turn.thread_id.length > 0 ? Number(turn.thread_id) : NaN
  return {
    chatId: turn.chat_id,
    ...(Number.isFinite(threadNum) ? { threadId: threadNum } : {}),
  }
}

/**
 * The dispatch-attributed origin chat for a worker (jsonl stem →
 * parent_turn_key chain → turns row). Null on any miss; never throws.
 * The DB-parameterized body of the gateway's `resolveSubagentOriginChat`.
 */
export function resolveSubagentOriginChatDb(
  db: SqliteDatabase,
  jsonlAgentId: string,
): SubagentSurfaceChat | null {
  try {
    const originKey = resolveSubagentOriginTurnKey(db, jsonlAgentId)
    if (originKey == null) return null
    return turnToSurfaceChat(getTurnByKey(db, originKey))
  } catch {
    return null
  }
}

/**
 * The most-recent-turn routing floor: chat+topic of the newest turns row
 * (running or ended). Null on empty table / unusable row; never throws.
 */
export function resolveRecentTurnFallbackChat(
  db: SqliteDatabase,
): SubagentSurfaceChat | null {
  try {
    return turnToSurfaceChat(findMostRecentTurn(db))
  } catch {
    return null
  }
}

/**
 * Full surface-chat precedence for a worker's card/handback/progress
 * destination. `db` may be null (turn registry disabled) — resolution then
 * degrades to fleet → owner DM exactly as before the recent-turn floor.
 */
export function resolveWorkerSurfaceChat(
  db: SqliteDatabase | null,
  jsonlAgentId: string,
  opts: { fleetChatId: string; ownerDm: string },
): { chatId: string; threadId?: number; via: SubagentSurfaceVia } {
  const origin = db != null ? resolveSubagentOriginChatDb(db, jsonlAgentId) : null
  if (origin != null && origin.chatId.length > 0) return { ...origin, via: 'origin' }
  if (opts.fleetChatId.length > 0) return { chatId: opts.fleetChatId, via: 'fleet' }
  const recent = db != null ? resolveRecentTurnFallbackChat(db) : null
  if (recent != null) return { ...recent, via: 'recent-turn' }
  if (opts.ownerDm.length > 0) return { chatId: opts.ownerDm, via: 'owner-dm' }
  return { chatId: '', via: 'none' }
}
