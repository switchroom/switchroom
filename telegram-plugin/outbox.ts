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
 * Routing (H3/F2): a record captured off an envelope-less anchor (task-notification
 * handback, chained/background-spawned dispatch) carries no chatId. `resolveOutboxChat`
 * resolves it via a transitive registry-chain lookup first, then the record's OWN
 * stamped per-session origin chat (`originChatId`, captured at Stop from this
 * session's most recent real `<channel>` inbound). It never consults a
 * gateway-global "last chat anyone messaged" fallback (that could leak private
 * content cross-chat), and FAILS CLOSED — holding the record — if neither
 * resolves.
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
  /**
   * Per-session ORIGIN chat, stamped at capture time from THIS session's own
   * transcript (its most-recent real Telegram `<channel>` inbound) — the
   * conversation of record for the session that produced this handback. Used as
   * the scoped routing fallback for an envelope-less record whose registry chain
   * fails (H3/F2), REPLACING the old gateway-global "last chat anyone messaged"
   * fallback that could leak private content into an unrelated chat. Absent when
   * the session has no prior channel inbound → the record fails CLOSED (held,
   * never delivered to an arbitrary chat).
   */
  originChatId?: string | null
  /** Forum thread of the per-session origin chat (see `originChatId`). */
  originThreadId?: number | null
  /**
   * #3510 instrumentation: was a qualifying reply already delivered through
   * the gateway in the turn that produced this record? Stamped by the Stop
   * hook from the SAME boolean that gates its capture-vs-election branch.
   * After #3510 this is always `false` for a written record (a `true` routes
   * to the single-writer election instead of the outbox), so a `true` here —
   * or in a sweep journal entry — is direct evidence of a regression.
   */
  replyAlreadyDeliveredThisTurn?: boolean
}

/** One line of the delivered-keys journal (`outbox/delivered.jsonl`). */
export interface DeliveredEntry {
  turnNonce: string
  textSha256: string
  tgMessageId?: number
  ts: number
  /**
   * #3510 instrumentation: which machine delivered — the outbox sweep, the
   * gateway reply-path machinery (reply/stream_reply send, silent-anchor edit,
   * captured-prose bridge), or the turn-end / answer-ready quiescence flush
   * (`'flush'`, added in the #3513 exactly-once-among-backstops follow-up).
   * Absent on pre-#3510 journal lines.
   */
  deliverySource?: 'sweep' | 'reply-tool' | 'flush'
  /** #3510 instrumentation: see `OutboxRecord.replyAlreadyDeliveredThisTurn`. */
  replyAlreadyDeliveredThisTurn?: boolean
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
 * True iff a journal entry is a prior BACKSTOP delivery (turn-flush E1/E2,
 * captured-prose bridge E3, outbox sweep E4) — NOT an explicit E0 `reply` /
 * `stream_reply` send (#3513 follow-up, MF2).
 *
 *   - `deliverySource === 'sweep'`  → E4 backstop.
 *   - `deliverySource === 'flush'`  → E1/E2 backstop.
 *   - `deliverySource === 'reply-tool'` AND `replyAlreadyDeliveredThisTurn ===
 *     false` → E3 captured-prose bridge (a backstop; the bridge only fires when
 *     NO genuine final answer was delivered this turn).
 *   - `deliverySource === 'reply-tool'` AND `replyAlreadyDeliveredThisTurn ===
 *     true` → an explicit E0 reply send — NOT a backstop. E0 replies are
 *     ungated by design (a turn may send N of them), so they must NOT satisfy a
 *     backstop's exactly-once guard (else the guard would eat a legitimate
 *     #3510 trailing recap or a multi-reply turn's later bridge).
 *
 * A pre-#3510 line with no `deliverySource` is treated conservatively as NOT a
 * backstop (fail open — never suppress a backstop on ambiguous provenance).
 */
export function isBackstopDeliveredEntry(e: DeliveredEntry): boolean {
  if (e.deliverySource === 'sweep' || e.deliverySource === 'flush') return true
  if (e.deliverySource === 'reply-tool' && e.replyAlreadyDeliveredThisTurn === false) return true
  return false
}

/**
 * True iff `nonce` already has a prior BACKSTOP delivery journaled (see
 * `isBackstopDeliveredEntry`). This is the BACKSTOP-SCOPED exactly-once read the
 * turn-flush (E1/E2) and captured-prose bridge (E3) consult before delivering —
 * unlike `outboxAlreadyDelivered` (any journal line) it does NOT count an
 * explicit E0 reply, so it can never suppress a legitimate second explicit
 * message (#3513 follow-up, MF2).
 */
export function backstopAlreadyDelivered(nonce: string, stateDir?: string): boolean {
  if (nonce == null || nonce === '') return false
  const path = join(resolveOutboxDir(stateDir), JOURNAL_FILE)
  if (!existsSync(path)) return false
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as DeliveredEntry
        if (e.turnNonce === nonce && isBackstopDeliveredEntry(e)) return true
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* best-effort */
  }
  return false
}

/**
 * Max delivered-keys kept in the journal. On exceeding `JOURNAL_ROTATE_AT` lines
 * the journal is compacted down to the newest `JOURNAL_KEEP` entries — bounding
 * on-disk growth and per-tick read cost. A duplicate arriving after its nonce
 * has aged out of the kept window is still caught by the record having been
 * deleted at delivery (the pending file is gone), so compaction never
 * reintroduces a double-post for any live record.
 */
export const JOURNAL_KEEP = 2_000
export const JOURNAL_ROTATE_AT = 4_000

/**
 * Append a delivered entry to the journal (intent/outcome). Called by EVERY
 * delivering machine (sweep, legacy flush, captured-prose bridge, exhausted
 * fallback, final-answer reply send) under the SAME nonce — the shared
 * exactly-once namespace (H1). Best-effort; never throws. Compacts the journal
 * in place once it grows past `JOURNAL_ROTATE_AT` lines.
 */
export function appendDelivered(entry: DeliveredEntry, stateDir?: string): void {
  const dir = resolveOutboxDir(stateDir)
  const path = join(dir, JOURNAL_FILE)
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 })
    compactJournalIfLarge(path)
  } catch {
    /* best-effort */
  }
}

/**
 * Rewrite the journal keeping only its newest `JOURNAL_KEEP` non-empty lines
 * once it exceeds `JOURNAL_ROTATE_AT`. Atomic (tmp + rename); best-effort.
 */
function compactJournalIfLarge(path: string): void {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
    if (lines.length <= JOURNAL_ROTATE_AT) return
    const kept = lines.slice(lines.length - JOURNAL_KEEP)
    const tmp = `${path}.${process.pid}.compact`
    writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 })
    renameSync(tmp, path)
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
  | 'skip-ephemeral-shown'

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
 *   skip-dedup      — identical text already delivered (the in-memory
 *                     `outboundDedup` cache; NOT a persistent/SQLite store —
 *                     the durable exactly-once guard is the delivered-keys
 *                     journal keyed by turnNonce, checked above).
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
  /**
   * #3513 (correction 1): was this record's text marked ephemeral-shown on the
   * progress card for its turnNonce (the durable shown-ledger)? A hit means the
   * block was already assigned to the ephemeral surface — the single-surface
   * invariant forbids ANY delivery machine, including this out-of-process late
   * sweep, from ALSO delivering it to chat. The ledger only ever contains
   * STRUCTURAL narration (correction 4: never a possibly-terminal answer), so
   * this can never suppress a genuine answer. Checked here (in the backstop
   * decision itself) rather than only at a send seam, because the sweep bypasses
   * `normalizeOutboundBody` (it sends via `bot.api.sendMessage` directly).
   */
  shownLedgerHit?: boolean
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
    shownLedgerHit = false,
  } = input
  if (deliveredNonces.has(record.turnNonce)) return { action: 'skip-journaled' }
  if (shownLedgerHit) return { action: 'skip-ephemeral-shown' }
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
  /** How the chat was resolved — 'anchor' (envelope), 'registry' (H3 chain), 'origin' (per-session fallback). */
  via: 'anchor' | 'registry' | 'origin'
}

/**
 * Resolve the destination chat for a record (H3 / F2).
 *
 *   1. anchor    — the record already carries a chatId (envelope-bearing turn).
 *   2. registry  — transitive `<task-id>` → registry-row → originating chatKey
 *                  lookup, recursing up a chained/background-spawned dispatch.
 *   3. origin    — the record's OWN stamped per-session origin chat
 *                  (`originChatId`), captured at Stop from this session's most
 *                  recent real `<channel>` inbound. This is SCOPED to the record
 *                  (F2): it can never route to "whatever chat messaged the
 *                  gateway last" the way the retired global last-inbound file
 *                  could, so a DM-origin handback can never leak into an
 *                  unrelated group. The caller adds a "(from background task)"
 *                  prefix for this route.
 *
 * FAIL CLOSED: if none of the three resolves, returns null — the sweep HOLDS the
 * record (skip-unroutable) rather than delivering to an arbitrary chat.
 *
 * Pure — the caller injects `registryChainLookup`.
 */
export function resolveOutboxChat(
  record: Pick<OutboxRecord, 'chatId' | 'threadId' | 'anchorContent' | 'originChatId' | 'originThreadId'>,
  deps: {
    registryChainLookup?: (anchorContent: string) => { chatId: string; threadId: number | null } | null
  },
): ResolvedChat | null {
  if (record.chatId != null && record.chatId !== '') {
    return { chatId: record.chatId, threadId: record.threadId ?? null, via: 'anchor' }
  }
  if (record.anchorContent && deps.registryChainLookup) {
    const hit = deps.registryChainLookup(record.anchorContent)
    if (hit != null) return { chatId: hit.chatId, threadId: hit.threadId, via: 'registry' }
  }
  if (record.originChatId != null && record.originChatId !== '') {
    return { chatId: record.originChatId, threadId: record.originThreadId ?? null, via: 'origin' }
  }
  return null
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
