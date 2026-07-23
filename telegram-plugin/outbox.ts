/**
 * outbox.ts — durable per-turn outbox for guaranteed final-message delivery.
 *
 * Root defect (2026-07-22 incident, see
 * `work/final-message-delivery/investigation.md`): every content-delivering
 * machine in the gateway is anchored on a `CurrentTurn` created at gateway
 * ENQUEUE of a Telegram inbound. Whole turn CLASSES never wake the gateway —
 * `<task-notification>` sub-agent handbacks, background-worker completions,
 * and any future harness wake type — so a real final answer written as plain
 * transcript prose (never sent via the `reply` tool) was silently lost.
 *
 * The fix collapses delivery to ONE capture path and ONE delivery path:
 *
 *   CAPTURE  — the Stop hook (`hooks/silent-end-interrupt-stop.mjs`) fires on
 *              EVERY main-session turn end regardless of what woke the turn.
 *              When the turn ended with substantive undelivered trailing
 *              prose, it atomically writes an outbox record here. Capture keys
 *              on "a turn ended with unsent trailing prose", NOT on
 *              recognising the wake shape, so unknown/future turn classes are
 *              covered by construction and fail CLOSED.
 *
 *   DELIVER  — the gateway heartbeat sweep (`sweepOutbox`, wired on the
 *              existing ~15s tick, independent of turn lifecycle) claims each
 *              record with a rename-mutex, delivers it exactly once (guarded by
 *              a persistent delivered-keys journal keyed by the SAME turnNonce
 *              every delivering machine uses, plus the existing text
 *              `outboundDedup`), and clears it.
 *
 * Exactly-once (H1): every delivering machine — the sweep AND the legacy
 * turn-flush / captured-prose bridge / exhausted-fallback / reply send — writes
 * the delivered-keys journal under the turnNonce and checks it before sending.
 * One namespace, one nonce end to end → no double-post.
 *
 * Nonce (H2): `deriveTurnNonce` uses the gateway's `deriveTurnId`
 * (`${chatKey}#${messageId}`) shape whenever the anchor envelope carries a real
 * message_id (unique per inbound), else `sha256(anchorTimestampMs + '\n' +
 * content)`. The ms timestamp makes a re-notifying task (byte-identical
 * `<task-notification>` content) collision-free, and serialized concurrent
 * sibling handbacks get distinct enqueue timestamps → distinct nonces.
 *
 * Routing (H3): a record captured off an envelope-less anchor (task-notification
 * handback, chained/background-spawned dispatch) carries no chatId. `resolveOutboxChat`
 * resolves it via a transitive registry-chain lookup first, then a per-session
 * last-real-inbound chatKey fallback.
 *
 * Pure cores (`deriveTurnNonce`, `decideOutboxSweep`, `resolveOutboxChat`) are
 * side-effect-free and unit-tested; the IO helpers are thin and best-effort.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** One captured, not-yet-delivered final message for a single main-session turn. */
export interface OutboxRecord {
  /** Unique per-turn nonce — the shared delivery key (see `deriveTurnNonce`). */
  turnNonce: string
  /**
   * Destination chat. May be `null` at capture time for an envelope-less anchor
   * (task-notification handback); resolved at sweep via `resolveOutboxChat`.
   */
  chatId: string | null
  /** Optional forum thread id. */
  threadId: number | null
  /** The undelivered final-answer prose. */
  text: string
  /** sha256 of `text` — the text-dedup key, matches the gateway's `outboundDedup`. */
  textSha256: string
  /** Wall-clock ms of capture. */
  createdAt: number
  /** Wake/anchor class: 'channel' | 'task-notification' | 'cron' | 'unknown' | … (diagnostic). */
  source: string
  /**
   * Raw anchor content (the enqueue line's `content`) — kept so the sweep's
   * transitive registry lookup can extract a `<task-id>` for chained-dispatch
   * routing (H3). Absent for envelope-carrying anchors that already routed.
   */
  anchorContent?: string
}

/** One line of the delivered-keys journal (`outbox/delivered.jsonl`). */
export interface DeliveredEntry {
  turnNonce: string
  textSha256: string
  tgMessageId?: number
  ts: number
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * Build the shared per-turn delivery nonce (H1 + H2).
 *
 * - `messageId` present  → `${chatKey}#${messageId}` — byte-identical to the
 *   gateway's `deriveTurnId`, so the sweep and the legacy flush/bridge journal
 *   under the SAME key for a gateway-visible turn (no double-post).
 * - `messageId` absent   → `sha256(anchorTimestampMs + '\n' + content)`. The ms
 *   timestamp guarantees uniqueness for a re-notifying task (identical content)
 *   and for serialized concurrent siblings (distinct enqueue timestamps).
 */
export function deriveTurnNonce(args: {
  chatId: string | null
  threadId: number | null
  messageId: string | null
  anchorTimestampMs: number
  anchorContent: string
}): string {
  const { chatId, threadId, messageId, anchorTimestampMs, anchorContent } = args
  if (chatId != null && messageId != null && messageId !== '' && String(messageId) !== '0') {
    const key = `${chatId}:${threadId == null || threadId === 0 ? '_' : threadId}`
    return `${key}#${messageId}`
  }
  return sha256Hex(`${anchorTimestampMs}\n${anchorContent}`)
}

export function resolveStateDir(explicit?: string): string {
  if (explicit != null && explicit !== '') return explicit
  const env = process.env.TELEGRAM_STATE_DIR
  if (env != null && env !== '') return env
  const home = process.env.HOME ?? homedir()
  return join(home, '.claude', 'channels', 'telegram')
}

export function resolveOutboxDir(stateDir?: string): string {
  return join(resolveStateDir(stateDir), 'outbox')
}

const JOURNAL_FILE = 'delivered.jsonl'
/** Records older than this are delivered with a "(delayed)" prefix, never dropped. */
export const OUTBOX_MAX_AGE_MS = 30 * 60_000
/** Quiet period before a record is eligible for sweep — lets a same-turn legacy flush land first. */
export const OUTBOX_QUIET_MS = 5_000
/** A `.sending` claim older than this is presumed crashed and re-queued. */
export const OUTBOX_SENDING_TIMEOUT_MS = 60_000

/** Atomically write an outbox record (tmp + rename). Best-effort; never throws. */
export function writeOutboxRecordAtomic(record: OutboxRecord, stateDir?: string): boolean {
  const dir = resolveOutboxDir(stateDir)
  try {
    mkdirSync(dir, { recursive: true })
    const finalPath = join(dir, `${record.turnNonce}.json`)
    // Idempotent capture: if a record for this nonce already exists (Stop hook
    // re-fired, or gateway already captured), do not clobber — the first
    // capture wins and the sweep is the single deliverer.
    if (existsSync(finalPath)) return true
    const tmpPath = join(dir, `.${record.turnNonce}.${process.pid}.tmp`)
    writeFileSync(tmpPath, JSON.stringify(record), { mode: 0o600 })
    renameSync(tmpPath, finalPath)
    return true
  } catch {
    return false
  }
}

/** List pending (unclaimed) record filenames — `*.json` excluding the journal. */
export function listPendingRecords(stateDir?: string): string[] {
  const dir = resolveOutboxDir(stateDir)
  try {
    return readdirSync(dir).filter(
      (f) => f.endsWith('.json') && f !== JOURNAL_FILE && !f.startsWith('.'),
    )
  } catch {
    return []
  }
}

/** Read + parse a record file. Null on missing/corrupt. */
export function readOutboxRecord(fileName: string, stateDir?: string): OutboxRecord | null {
  try {
    const raw = readFileSync(join(resolveOutboxDir(stateDir), fileName), 'utf8')
    return JSON.parse(raw) as OutboxRecord
  } catch {
    return null
  }
}

/**
 * Claim a record by renaming `<nonce>.json` → `<nonce>.sending`. Rename is the
 * mutex: two concurrent sweeps cannot both claim the same record. Returns the
 * claimed path, or null if the claim lost the race.
 */
export function claimRecord(nonce: string, stateDir?: string): string | null {
  const dir = resolveOutboxDir(stateDir)
  const from = join(dir, `${nonce}.json`)
  const to = join(dir, `${nonce}.sending`)
  try {
    renameSync(from, to)
    return to
  } catch {
    return null
  }
}

/** Release a lost/failed claim back to pending (`<nonce>.sending` → `<nonce>.json`). */
export function releaseClaim(nonce: string, stateDir?: string): void {
  const dir = resolveOutboxDir(stateDir)
  try {
    renameSync(join(dir, `${nonce}.sending`), join(dir, `${nonce}.json`))
  } catch {
    /* best-effort */
  }
}

/** Delete a delivered record's claimed file. */
export function removeClaimed(nonce: string, stateDir?: string): void {
  try {
    unlinkSync(join(resolveOutboxDir(stateDir), `${nonce}.sending`))
  } catch {
    /* best-effort */
  }
}

/**
 * Re-queue `.sending` claims older than the crash timeout — covers a crash
 * after claim but before send. Idempotent; safe to run every sweep.
 */
export function reclaimStaleSending(stateDir?: string, now: number = Date.now()): void {
  const dir = resolveOutboxDir(stateDir)
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.sending'))
  } catch {
    return
  }
  for (const f of files) {
    try {
      const st = statSync(join(dir, f))
      if (now - st.mtimeMs > OUTBOX_SENDING_TIMEOUT_MS) {
        renameSync(join(dir, f), join(dir, f.replace(/\.sending$/, '.json')))
      }
    } catch {
      /* best-effort */
    }
  }
}

/** Read the set of already-delivered turnNonces from the journal. */
export function readDeliveredNonces(stateDir?: string): Set<string> {
  const set = new Set<string>()
  const path = join(resolveOutboxDir(stateDir), JOURNAL_FILE)
  if (!existsSync(path)) return set
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as DeliveredEntry
        if (e.turnNonce) set.add(e.turnNonce)
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* best-effort */
  }
  return set
}

/** True iff `nonce` is already journaled as delivered. */
export function outboxAlreadyDelivered(nonce: string, stateDir?: string): boolean {
  return readDeliveredNonces(stateDir).has(nonce)
}

/**
 * Append a delivered entry to the journal (intent/outcome). Called by EVERY
 * delivering machine (sweep, legacy flush, captured-prose bridge, exhausted
 * fallback, final-answer reply send) under the SAME nonce — the shared
 * exactly-once namespace (H1). Best-effort; never throws.
 */
export function appendDelivered(entry: DeliveredEntry, stateDir?: string): void {
  const dir = resolveOutboxDir(stateDir)
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, JOURNAL_FILE), JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch {
    /* best-effort */
  }
}

/**
 * Delete any pending outbox record for `nonce` (the reply-path clear-by-nonce,
 * plus the journal write so a race-in-flight sweep also skips). Called when a
 * genuine reply/flush delivered this turn's answer, so the sweep never
 * re-sends. Best-effort.
 */
export function clearOutboxRecord(nonce: string, stateDir?: string): void {
  const dir = resolveOutboxDir(stateDir)
  for (const suffix of ['.json', '.sending']) {
    try {
      unlinkSync(join(dir, `${nonce}${suffix}`))
    } catch {
      /* best-effort */
    }
  }
}

export type OutboxSweepAction =
  | 'send'
  | 'send-delayed'
  | 'skip-journaled'
  | 'skip-quiet'
  | 'skip-dedup'
  | 'skip-unroutable'

export interface OutboxSweepDecision {
  action: OutboxSweepAction
  /** The text to deliver (with any "(delayed)"/"(from background task)" prefix). */
  text?: string
}

/**
 * Pure sweep decision for one record. No IO — the caller injects the journal
 * set, the text-dedup verdict, and the resolved chat.
 *
 *   skip-journaled  — nonce already delivered (exactly-once, H1).
 *   skip-quiet      — inside the quiet period; let a same-turn legacy flush land.
 *   skip-dedup      — identical text already delivered (outboundDedup / SQLite backstop).
 *   skip-unroutable — no chat could be resolved (H3 exhausted) — keep the record.
 *   send            — deliver now.
 *   send-delayed    — older than max-age; deliver with a "(delayed)" prefix, never drop.
 */
export function decideOutboxSweep(input: {
  record: Pick<OutboxRecord, 'turnNonce' | 'text' | 'createdAt'>
  now: number
  deliveredNonces: Set<string>
  textAlreadyDelivered: boolean
  routable: boolean
  routePrefix?: string
  quietMs?: number
  maxAgeMs?: number
}): OutboxSweepDecision {
  const {
    record,
    now,
    deliveredNonces,
    textAlreadyDelivered,
    routable,
    routePrefix = '',
    quietMs = OUTBOX_QUIET_MS,
    maxAgeMs = OUTBOX_MAX_AGE_MS,
  } = input
  if (deliveredNonces.has(record.turnNonce)) return { action: 'skip-journaled' }
  const age = now - record.createdAt
  if (age < quietMs) return { action: 'skip-quiet' }
  if (textAlreadyDelivered) return { action: 'skip-dedup' }
  if (!routable) return { action: 'skip-unroutable' }
  const delayed = age > maxAgeMs
  const prefix = (delayed ? '(delayed) ' : '') + routePrefix
  return { action: delayed ? 'send-delayed' : 'send', text: prefix + record.text }
}

export interface ResolvedChat {
  chatId: string
  threadId: number | null
  /** How the chat was resolved — 'anchor' (envelope), 'registry' (H3 chain), 'last-inbound' (fallback). */
  via: 'anchor' | 'registry' | 'last-inbound'
}

/**
 * Resolve the destination chat for a record (H3).
 *
 *   1. anchor      — the record already carries a chatId (envelope-bearing turn).
 *   2. registry    — transitive `<task-id>` → registry-row → originating chatKey
 *                    lookup, recursing up a chained/background-spawned dispatch.
 *   3. last-inbound— per-session last-real-inbound chatKey fallback (single-chat
 *                    correct always; forum-correct unless the user switched
 *                    topics mid-chain — the caller adds a "(from background
 *                    task)" prefix in that case).
 *
 * Pure — the caller injects `registryChainLookup` and `lastInboundChat`.
 */
export function resolveOutboxChat(
  record: Pick<OutboxRecord, 'chatId' | 'threadId' | 'anchorContent'>,
  deps: {
    registryChainLookup?: (anchorContent: string) => { chatId: string; threadId: number | null } | null
    lastInboundChat?: () => { chatId: string; threadId: number | null } | null
  },
): ResolvedChat | null {
  if (record.chatId != null && record.chatId !== '') {
    return { chatId: record.chatId, threadId: record.threadId ?? null, via: 'anchor' }
  }
  if (record.anchorContent && deps.registryChainLookup) {
    const hit = deps.registryChainLookup(record.anchorContent)
    if (hit != null) return { chatId: hit.chatId, threadId: hit.threadId, via: 'registry' }
  }
  if (deps.lastInboundChat) {
    const hit = deps.lastInboundChat()
    if (hit != null) return { chatId: hit.chatId, threadId: hit.threadId, via: 'last-inbound' }
  }
  return null
}

// ── Last-real-inbound chat (H3 fallback) ─────────────────────────────────────
// The gateway writes this on every real Telegram-inbound enqueue; the sweep
// reads it to route an envelope-less handback to the conversation of record.

const LAST_INBOUND_FILE = 'last-inbound-chat.json'

export function writeLastInboundChat(
  chat: { chatId: string; threadId: number | null },
  stateDir?: string,
): void {
  const dir = resolveOutboxDir(stateDir)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, LAST_INBOUND_FILE),
      JSON.stringify({ ...chat, ts: Date.now() }),
      { mode: 0o600 },
    )
  } catch {
    /* best-effort */
  }
}

export function readLastInboundChat(
  stateDir?: string,
): { chatId: string; threadId: number | null } | null {
  const path = join(resolveOutboxDir(stateDir), LAST_INBOUND_FILE)
  if (!existsSync(path)) return null
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as {
      chatId?: string
      threadId?: number | null
    }
    if (o.chatId == null || o.chatId === '') return null
    return { chatId: o.chatId, threadId: o.threadId ?? null }
  } catch {
    return null
  }
}

/**
 * Extract a `<task-id>` (or `task_id="…"`/`taskId`) from a task-notification
 * anchor's content, for the H3 registry-chain lookup. Null if none.
 */
export function extractTaskId(anchorContent: string): string | null {
  if (typeof anchorContent !== 'string') return null
  const m =
    anchorContent.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/) ??
    anchorContent.match(/task[_-]?id="([^"]+)"/i) ??
    anchorContent.match(/task[_-]?id:\s*([^\s,}"']+)/i)
  return m ? m[1] : null
}
