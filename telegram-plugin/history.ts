/**
 * Persistent message history for the Telegram plugin.
 *
 * Telegram's Bot API exposes no chat history endpoint, so the agent has no
 * way to recover "what were we just talking about" after a Claude Code
 * restart without asking the user. This module fills that gap by writing
 * every inbound and outbound message that flows through the plugin to a
 * local SQLite database, queryable via the `get_recent_messages` MCP tool.
 *
 * Storage is `bun:sqlite` (Bun's bundled SQLite, no extra dep). The DB file
 * lives at `${STATE_DIR}/history.db` and is chmod'd to 0600 to match the
 * plugin's existing credential-handling pattern.
 *
 * Capture is gated:
 *   - Inbound: only writes after the access gate, topic filter, and the
 *     permission-reply intercept have passed (see server.ts handleInbound).
 *   - Outbound: the reply/stream_reply/forward_message/edit_message handlers
 *     all assertAllowedChat() before reaching the capture call sites.
 *
 * Per-chunk rows: when a long `reply` is split into multiple Telegram
 * messages by the chunker, each chunk lands as its own row keyed by its
 * real message_id, with a shared `group_id` (the first chunk's id) so
 * the logical reply can be reconstructed if needed. This keeps
 * `before_message_id` pagination working — every visible message in the
 * chat exists in the DB.
 */

import { chmodSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * `bun:sqlite` is a Bun built-in — Vite/Node loaders can't resolve it
 * statically, which would crash any vitest test that transitively
 * imports this module (every test that imports server.ts). Hide the
 * require behind an eval so static analysis passes; runtime resolution
 * is per-Bun and works fine.
 *
 * The Database class is loaded lazily on the first initHistory() call.
 * If we're somehow running under non-Bun (vitest fallback, ts-node, etc.)
 * the lazy load throws — but only when the caller actually tries to use
 * the history feature, not on module import.
 *
 * The only Database APIs we touch are constructor(path, opts), exec,
 * prepare, transaction, close — all stable across bun:sqlite versions.
 */
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
type SqliteDatabaseConstructor = new (path: string, opts?: { create?: boolean }) => SqliteDatabase

let DatabaseClass: SqliteDatabaseConstructor | null = null
function loadDatabaseClass(): SqliteDatabaseConstructor {
  if (DatabaseClass != null) return DatabaseClass
  try {
    // Bun exposes a `require` on `import.meta` that works in ESM modules
    // and resolves built-in `bun:*` modules. Vite/esbuild's static
    // analyzer doesn't follow `import.meta.require(...)` calls (it only
    // resolves static `import` statements), so this hides the bun:sqlite
    // import from the test loader. Under non-Bun runtimes
    // `import.meta.require` is undefined and we throw a clear error.
    const metaRequire = (import.meta as { require?: (id: string) => unknown }).require
    if (typeof metaRequire !== 'function') {
      throw new Error('import.meta.require not available — Bun runtime required')
    }
    const mod = metaRequire('bun:sqlite') as { Database?: SqliteDatabaseConstructor }
    if (!mod.Database) throw new Error('bun:sqlite did not export Database')
    DatabaseClass = mod.Database
    return DatabaseClass
  } catch (err) {
    throw new Error(
      `history.ts requires Bun runtime (bun:sqlite). Caller: ${(err as Error).message}`,
    )
  }
}

export type MessageRole = 'user' | 'assistant'

export interface RecordedMessage {
  chat_id: string
  thread_id: number | null
  message_id: number
  role: MessageRole
  user: string | null
  user_id: string | null
  ts: number
  text: string
  attachment_kind: string | null
  group_id: number | null
}

export interface QueryOptions {
  chat_id: string
  thread_id?: number | null
  limit?: number
  before_message_id?: number
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

let db: SqliteDatabase | null = null

/**
 * Open (or create) the history DB and run migrations + retention sweep.
 * Idempotent — safe to call once at server startup.
 *
 * `retentionDays` deletes rows older than the cutoff. 0 disables retention.
 */
export function initHistory(stateDir: string, retentionDays = 30): void {
  if (db != null) return
  const Database = loadDatabaseClass()
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, 'history.db')
  db = new Database(path, { create: true })
  // WAL is friendlier for concurrent reads while a long transaction writes,
  // and survives crashes more cleanly than rollback journal.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      chat_id        TEXT    NOT NULL,
      thread_id      INTEGER,
      message_id     INTEGER NOT NULL,
      role           TEXT    NOT NULL,
      user           TEXT,
      user_id        TEXT,
      ts             INTEGER NOT NULL,
      text           TEXT    NOT NULL,
      attachment_kind TEXT,
      group_id       INTEGER,
      PRIMARY KEY (chat_id, thread_id, message_id)
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_recent
      ON messages (chat_id, thread_id, ts DESC)
  `)

  // Lock the file to owner-only. Same pattern the plugin uses for .env at
  // server.ts:52. No-op on Windows (would need ACLs).
  try {
    chmodSync(path, 0o600)
  } catch {
    /* ignore — chmod not supported, e.g. some FUSE mounts */
  }

  if (retentionDays > 0) {
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
    db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff)
  }
}

/**
 * For tests — close the singleton and forget it. Production code never
 * needs this; the DB is held open for the lifetime of the process.
 */
export function _resetForTests(): void {
  if (db != null) {
    db.close()
    db = null
  }
}

function requireDb(): SqliteDatabase {
  if (db == null) {
    throw new Error('history: initHistory() must be called before any record/query operation')
  }
  return db
}

interface RecordInboundArgs {
  chat_id: string
  thread_id: number | null | undefined
  message_id: number | null | undefined
  user: string | null | undefined
  user_id: string | null | undefined
  ts: number
  text: string
  attachment_kind?: string | null | undefined
}

/**
 * Record an inbound (user → bot) message. Called from server.ts handleInbound
 * right next to the `notifications/claude/channel` emit, so the stored row
 * matches what the agent actually saw.
 *
 * If `message_id` is missing (which shouldn't happen for normal Telegram
 * messages, but defensively...) we silently skip — the PK requires it and
 * we'd rather lose the row than crash the inbound path.
 */
export function recordInbound(args: RecordInboundArgs): void {
  if (args.message_id == null) return
  const stmt = requireDb().prepare(`
    INSERT OR REPLACE INTO messages
      (chat_id, thread_id, message_id, role, user, user_id, ts, text, attachment_kind, group_id)
    VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, NULL)
  `)
  stmt.run(
    args.chat_id,
    args.thread_id ?? null,
    args.message_id,
    args.user ?? null,
    args.user_id ?? null,
    args.ts,
    args.text,
    args.attachment_kind ?? null,
  )
}

interface RecordOutboundArgs {
  chat_id: string
  thread_id: number | null | undefined
  message_ids: number[]   // one entry per chunk
  texts: string[]         // parallel array, same length as message_ids
  ts?: number             // defaults to now
  attachment_kinds?: (string | null | undefined)[]
}

/**
 * Record an outbound (bot → user) message. The `reply` handler chunks long
 * text into multiple Telegram sends; pass them all here in one call so they
 * share a `group_id` (the first chunk's message_id). The other handlers
 * (`stream_reply`, `forward_message`, orphaned-reply backstop) typically
 * pass a single-element array.
 */
export function recordOutbound(args: RecordOutboundArgs): void {
  if (args.message_ids.length === 0) return
  const ts = args.ts ?? Math.floor(Date.now() / 1000)
  const groupId = args.message_ids[0]!
  const stmt = requireDb().prepare(`
    INSERT OR REPLACE INTO messages
      (chat_id, thread_id, message_id, role, user, user_id, ts, text, attachment_kind, group_id)
    VALUES (?, ?, ?, 'assistant', NULL, NULL, ?, ?, ?, ?)
  `)
  // bun:sqlite has a transaction() helper. Cheap insurance against partial
  // writes if the process dies mid-loop.
  const tx = requireDb().transaction((rows: Array<[number, string, string | null]>) => {
    for (const [msgId, text, attachKind] of rows) {
      stmt.run(
        args.chat_id,
        args.thread_id ?? null,
        msgId,
        ts,
        text,
        attachKind,
        groupId,
      )
    }
  })
  const rows: Array<[number, string, string | null]> = args.message_ids.map((id, i) => [
    id,
    args.texts[i] ?? '',
    args.attachment_kinds?.[i] ?? null,
  ])
  tx(rows)
}

interface RecordEditArgs {
  chat_id: string
  message_id: number
  text: string
}

/**
 * Update an existing outbound message's text in place. Called from the
 * `edit_message` tool handler. If the row doesn't exist (the bot is editing
 * a message it sent before history was enabled, or before this version
 * shipped), we silently no-op rather than inventing a row with role guessed.
 *
 * Telegram message_ids are unique within a chat regardless of thread, so
 * we don't filter on thread_id — that lets edits work even when the
 * original send-time thread isn't known at edit time.
 */
export function recordEdit(args: RecordEditArgs): void {
  requireDb()
    .prepare(`
      UPDATE messages
         SET text = ?
       WHERE chat_id = ? AND message_id = ?
    `)
    .run(args.text, args.chat_id, args.message_id)
}

export interface DeleteFromHistoryArgs {
  chat_id: string
  message_id: number
}

/**
 * Remove a single row from the local history buffer. Called after a
 * successful `bot.api.deleteMessage` so the `get_recent_messages` tool
 * reflects the deletion. Best-effort: callers should catch errors and
 * log them rather than failing the deletion request.
 *
 * Telegram message_ids are unique within a chat regardless of thread, so
 * we match on (chat_id, message_id) and ignore thread.
 */
export function deleteFromHistory(args: DeleteFromHistoryArgs): void {
  requireDb()
    .prepare(`
      DELETE FROM messages
       WHERE chat_id = ? AND message_id = ?
    `)
    .run(args.chat_id, args.message_id)
}

/**
 * Fetch recent messages for a chat (or chat+thread).
 *
 * Returns oldest-first so the caller can paste them into a prompt without
 * reversing. `before_message_id` lets the caller paginate further back —
 * pass the smallest `message_id` from the previous page.
 *
 * `thread_id` filter semantics:
 *   - omitted / undefined → all messages in the chat across all threads
 *   - explicit number → only that thread
 *   - explicit null → only the chat-root (non-thread) messages
 */
/**
 * Count outbound messages sent to a chat within the last `withinSeconds`.
 * Used by the orphaned-reply backstop to detect if a reply tool handler
 * already sent a message during the backstop's delay window, avoiding
 * a duplicate send.
 */
/**
 * Look up the most recent inbound (user → bot) message id for a chat, optionally
 * scoped to a forum-topic thread. Returns `null` if no inbound message exists
 * yet (fresh chat, or history was disabled when the message arrived).
 *
 * Used by the `reply` and `stream_reply` tool handlers to auto-populate
 * `reply_parameters` so outbound messages quote-thread under whatever the
 * user last said — the common case for a conversational bot — without the
 * agent having to pass `reply_to` explicitly every turn.
 *
 * `thread_id` filter semantics match `query()`:
 *   - omitted / undefined → any message in the chat
 *   - explicit number → only that thread
 *   - explicit null → only chat-root (non-thread)
 */
export function getLatestInboundMessageId(
  chatId: string,
  threadId?: number | null,
): number | null {
  const params: unknown[] = [chatId]
  let sql = "SELECT message_id FROM messages WHERE chat_id = ? AND role = 'user'"
  if (threadId !== undefined) {
    if (threadId === null) {
      sql += ' AND thread_id IS NULL'
    } else {
      sql += ' AND thread_id = ?'
      params.push(threadId)
    }
  }
  sql += ' ORDER BY ts DESC, message_id DESC LIMIT 1'
  const row = requireDb().prepare(sql).get(...params as any[]) as
    | { message_id: number }
    | undefined
  return row?.message_id ?? null
}

export function getRecentOutboundCount(
  chatId: string,
  withinSeconds: number,
): number {
  const cutoff = Math.floor(Date.now() / 1000) - withinSeconds
  const row = requireDb()
    .prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ? AND role = ? AND ts >= ?',
    )
    .get(chatId, 'assistant', cutoff) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

export function query(opts: QueryOptions): RecordedMessage[] {
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT))
  const params: unknown[] = [opts.chat_id]
  let sql = 'SELECT * FROM messages WHERE chat_id = ?'
  if (opts.thread_id !== undefined) {
    if (opts.thread_id === null) {
      sql += ' AND thread_id IS NULL'
    } else {
      sql += ' AND thread_id = ?'
      params.push(opts.thread_id)
    }
  }
  if (opts.before_message_id != null) {
    sql += ' AND message_id < ?'
    params.push(opts.before_message_id)
  }
  sql += ' ORDER BY ts DESC, message_id DESC LIMIT ?'
  params.push(limit)
  const rows = requireDb().prepare(sql).all(...params as any[]) as RecordedMessage[]
  // SELECT was DESC; flip to oldest-first for the caller.
  rows.reverse()
  return rows
}
