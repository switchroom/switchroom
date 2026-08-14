import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, statSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
// bun-only (this file is vitest-excluded and runs under `bun test`): used to
// build an OLD-schema DB file for the additive-migration test.
import { Database } from 'bun:sqlite'
import {
  initHistory,
  recordInbound,
  recordOutbound,
  recordEdit,
  query,
  getRecentOutboundCount,
  getLatestInboundMessageId,
  hasOutboundDeliveredSince,
  hasOutboundWithText,
  normalizeDeliveryText,
  verifyHistoryWritable,
  _resetForTests,
} from '../history.js'

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'telegram-history-test-'))
})

afterEach(() => {
  _resetForTests()
  if (existsSync(stateDir)) {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

describe('initHistory', () => {
  it('creates history.db with chmod 0644', () => {
    initHistory(stateDir, 30)
    const dbPath = join(stateDir, 'history.db')
    expect(existsSync(dbPath)).toBe(true)
    const st = statSync(dbPath)
    // Mask off the file-type bits — only the perm bits matter.
    // 0644: the web container (uid 1000) opens history.db read-only to
    // stream replies back to Hermes Desktop. Content is redacted on write,
    // so world-readable is safe (owner-approved behaviour change).
    expect(st.mode & 0o777).toBe(0o644)
  })

  it('is idempotent — second call is a no-op', () => {
    initHistory(stateDir, 30)
    expect(() => initHistory(stateDir, 30)).not.toThrow()
  })

  // Regression for HERMES #2689 review defect #1: the web process (a different
  // uid than the agent) opens history.db READ-ONLY to stream Telegram replies
  // back to Hermes Desktop. If the db/WAL sidecars were left 0600, that open
  // fails and the real-time sync poller silently no-ops. Assert both the perm
  // bits AND that a readonly open + the poller's exact SELECT succeed.
  it('history.db is world-readable and the Hermes poller can open it read-only', async () => {
    initHistory(stateDir, 30)
    recordInbound({ chat_id: '1', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'hi' })
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [2], texts: ['hello'], ts: 200 })

    const dbPath = join(stateDir, 'history.db')
    // Force a WAL sidecar to exist so we exercise the -wal/-shm perm path too.
    for (const suffix of ['', '-shm', '-wal']) {
      const f = dbPath + suffix
      if (existsSync(f)) expect(statSync(f).mode & 0o777).toBe(0o644)
    }

    // Reproduce the poller's open (src/web/hermes-adapter.ts startHistoryPoll):
    // readonly connection + MAX(rowid) + assistant-row SELECT.
    const { Database } = await import('bun:sqlite')
    const rdb = new Database(dbPath, { readonly: true })
    try {
      const max = rdb.prepare('SELECT MAX(rowid) AS r FROM messages').get() as { r: number | null }
      expect(max.r).toBeGreaterThan(0)
      const rows = rdb
        .prepare("SELECT rowid, role, text FROM messages WHERE rowid > ? AND role = 'assistant' ORDER BY rowid ASC")
        .all(0) as Array<{ role: string; text: string }>
      expect(rows.some((r) => r.text === 'hello')).toBe(true)
    } finally {
      rdb.close()
    }
  })
})

describe('recordInbound + query', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('round-trips a single message', () => {
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 5,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'hello',
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      chat_id: '-100',
      message_id: 5,
      role: 'user',
      user: 'alice',
      text: 'hello',
    })
  })

  it('returns oldest-first', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'first' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 2, user: 'a', user_id: '1', ts: 200, text: 'second' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 300, text: 'third' })
    const rows = query({ chat_id: '-100' })
    expect(rows.map(r => r.text)).toEqual(['first', 'second', 'third'])
  })

  it('respects the limit', () => {
    for (let i = 1; i <= 20; i++) {
      recordInbound({ chat_id: '-100', thread_id: null, message_id: i, user: 'a', user_id: '1', ts: 100 + i, text: `m${i}` })
    }
    const rows = query({ chat_id: '-100', limit: 5 })
    expect(rows).toHaveLength(5)
    // Newest 5, returned oldest-first
    expect(rows.map(r => r.text)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20'])
  })

  it('caps limit at 50', () => {
    for (let i = 1; i <= 100; i++) {
      recordInbound({ chat_id: '-100', thread_id: null, message_id: i, user: 'a', user_id: '1', ts: 100 + i, text: `m${i}` })
    }
    const rows = query({ chat_id: '-100', limit: 999 })
    expect(rows).toHaveLength(50)
  })

  it('paginates with before_message_id', () => {
    for (let i = 1; i <= 20; i++) {
      recordInbound({ chat_id: '-100', thread_id: null, message_id: i, user: 'a', user_id: '1', ts: 100 + i, text: `m${i}` })
    }
    const page1 = query({ chat_id: '-100', limit: 5 })
    expect(page1.map(r => r.text)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20'])
    const oldestId = page1[0]!.message_id
    const page2 = query({ chat_id: '-100', limit: 5, before_message_id: oldestId })
    expect(page2.map(r => r.text)).toEqual(['m11', 'm12', 'm13', 'm14', 'm15'])
  })

  it('filters by thread_id', () => {
    recordInbound({ chat_id: '-100', thread_id: 7, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'topicA' })
    recordInbound({ chat_id: '-100', thread_id: 8, message_id: 2, user: 'a', user_id: '1', ts: 100, text: 'topicB' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 100, text: 'root' })

    expect(query({ chat_id: '-100', thread_id: 7 }).map(r => r.text)).toEqual(['topicA'])
    expect(query({ chat_id: '-100', thread_id: 8 }).map(r => r.text)).toEqual(['topicB'])
    expect(query({ chat_id: '-100', thread_id: null }).map(r => r.text)).toEqual(['root'])
    // Omitted thread_id returns everything in the chat
    expect(query({ chat_id: '-100' })).toHaveLength(3)
  })

  it('isolates chats from each other', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'A' })
    recordInbound({ chat_id: '-200', thread_id: null, message_id: 1, user: 'b', user_id: '2', ts: 100, text: 'B' })
    expect(query({ chat_id: '-100' }).map(r => r.text)).toEqual(['A'])
    expect(query({ chat_id: '-200' }).map(r => r.text)).toEqual(['B'])
  })

  // Issue #119: Telegram-native reply context.
  it('round-trips reply_to_message_id and reply_to_text', () => {
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 42,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'how do we fix this?',
      reply_to_message_id: 17,
      reply_to_text: 'Morning briefing: cron job failed at 06:00',
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reply_to_message_id).toBe(17)
    expect(rows[0]?.reply_to_text).toBe('Morning briefing: cron job failed at 06:00')
  })

  it('stores null when no reply context is provided', () => {
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 5,
      user: 'a',
      user_id: '1',
      ts: 100,
      text: 'plain message',
    })
    const rows = query({ chat_id: '-100' })
    expect(rows[0]?.reply_to_message_id).toBeNull()
    expect(rows[0]?.reply_to_text).toBeNull()
  })

  it('stores reply context independently across messages in the same chat', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'first', reply_to_message_id: null, reply_to_text: null })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 2, user: 'a', user_id: '1', ts: 200, text: 'reply', reply_to_message_id: 1, reply_to_text: 'first' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 300, text: 'unrelated' })
    const rows = query({ chat_id: '-100' })
    expect(rows.map(r => r.reply_to_message_id)).toEqual([null, 1, null])
    expect(rows.map(r => r.reply_to_text)).toEqual([null, 'first', null])
  })
})

describe('getLatestInboundMessageId', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('returns null when no inbound messages exist', () => {
    expect(getLatestInboundMessageId('-100')).toBeNull()
  })

  it('returns the highest-ts inbound message_id for a chat', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'a' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 2, user: 'a', user_id: '1', ts: 200, text: 'b' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 150, text: 'c' })
    // ts=200 wins even though id 3 > id 2 but lower ts.
    expect(getLatestInboundMessageId('-100')).toBe(2)
  })

  it('ignores outbound (assistant) messages', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'hi' })
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [2],
      texts: ['bot reply'],
      ts: 200,
    })
    // Assistant row has higher ts but must not be returned.
    expect(getLatestInboundMessageId('-100')).toBe(1)
  })

  it('scopes by thread when threadId passed', () => {
    recordInbound({ chat_id: '-100', thread_id: 7, message_id: 10, user: 'a', user_id: '1', ts: 100, text: 'topicA' })
    recordInbound({ chat_id: '-100', thread_id: 8, message_id: 20, user: 'a', user_id: '1', ts: 200, text: 'topicB' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 30, user: 'a', user_id: '1', ts: 300, text: 'root' })

    expect(getLatestInboundMessageId('-100', 7)).toBe(10)
    expect(getLatestInboundMessageId('-100', 8)).toBe(20)
    expect(getLatestInboundMessageId('-100', null)).toBe(30)
    // Omitted thread → any thread (highest ts wins).
    expect(getLatestInboundMessageId('-100')).toBe(30)
  })

  it('isolates chats', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'a' })
    recordInbound({ chat_id: '-200', thread_id: null, message_id: 99, user: 'b', user_id: '2', ts: 100, text: 'b' })
    expect(getLatestInboundMessageId('-100')).toBe(1)
    expect(getLatestInboundMessageId('-200')).toBe(99)
    expect(getLatestInboundMessageId('-300')).toBeNull()
  })
})

describe('recordOutbound', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('records a single-chunk reply', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [42],
      texts: ['the answer'],
      ts: 500,
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      message_id: 42,
      role: 'assistant',
      text: 'the answer',
      group_id: 42,
    })
  })

  it('records each chunk of a multi-chunk reply with shared group_id', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [10, 11, 12],
      texts: ['part 1', 'part 2', 'part 3'],
      ts: 500,
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.message_id)).toEqual([10, 11, 12])
    expect(rows.map(r => r.group_id)).toEqual([10, 10, 10])
    expect(rows.map(r => r.text)).toEqual(['part 1', 'part 2', 'part 3'])
  })

  it('interleaves correctly with inbound when sorted by ts', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: 100, text: 'q1' })
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [2], texts: ['a1'], ts: 200 })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 3, user: 'a', user_id: '1', ts: 300, text: 'q2' })
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [4], texts: ['a2'], ts: 400 })
    const rows = query({ chat_id: '-100' })
    expect(rows.map(r => `${r.role}:${r.text}`)).toEqual([
      'user:q1',
      'assistant:a1',
      'user:q2',
      'assistant:a2',
    ])
  })
})

describe('recordEdit', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('updates an existing outbound row', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [42],
      texts: ['original'],
      ts: 500,
    })
    recordEdit({ chat_id: '-100', message_id: 42, text: 'edited' })
    const rows = query({ chat_id: '-100' })
    expect(rows[0]?.text).toBe('edited')
  })

  it('is a silent no-op for missing rows', () => {
    expect(() =>
      recordEdit({ chat_id: '-100', message_id: 999, text: 'oops' }),
    ).not.toThrow()
    expect(query({ chat_id: '-100' })).toHaveLength(0)
  })

  it('updates the row regardless of thread (Telegram message_ids are chat-unique)', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: 7,
      message_ids: [42],
      texts: ['original in thread 7'],
      ts: 500,
    })
    // Edit without knowing the thread — should still update the row.
    recordEdit({ chat_id: '-100', message_id: 42, text: 'edited' })
    const rows = query({ chat_id: '-100', thread_id: 7 })
    expect(rows[0]?.text).toBe('edited')
  })
})

describe('retention sweep', () => {
  it('deletes rows older than retentionDays on init', () => {
    initHistory(stateDir, 30)
    const oldTs = Math.floor(Date.now() / 1000) - 40 * 86400
    const recentTs = Math.floor(Date.now() / 1000) - 5 * 86400
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: oldTs, text: 'ancient' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 2, user: 'a', user_id: '1', ts: recentTs, text: 'recent' })
    // Re-init to fire the sweep
    _resetForTests()
    initHistory(stateDir, 30)
    const rows = query({ chat_id: '-100' })
    expect(rows.map(r => r.text)).toEqual(['recent'])
  })

  it('retentionDays=0 disables the sweep', () => {
    initHistory(stateDir, 0)
    const ancientTs = Math.floor(Date.now() / 1000) - 365 * 86400
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 1, user: 'a', user_id: '1', ts: ancientTs, text: 'ancient' })
    _resetForTests()
    initHistory(stateDir, 0)
    expect(query({ chat_id: '-100' })).toHaveLength(1)
  })
})

describe('getRecentOutboundCount (backstop dedup helper)', () => {
  it('counts assistant messages within the time window', () => {
    initHistory(stateDir, 30)
    const now = Math.floor(Date.now() / 1000)
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [10], texts: ['reply 1'], ts: now })
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [11], texts: ['reply 2'], ts: now - 1 })
    // Message outside the 2-second window
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [9], texts: ['old reply'], ts: now - 5 })

    expect(getRecentOutboundCount('-100', 2)).toBe(2)
    expect(getRecentOutboundCount('-100', 10)).toBe(3)
  })

  it('returns 0 when no outbound messages exist', () => {
    initHistory(stateDir, 30)
    expect(getRecentOutboundCount('-100', 2)).toBe(0)
  })

  it('does not count inbound messages', () => {
    initHistory(stateDir, 30)
    const now = Math.floor(Date.now() / 1000)
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 10, user: 'u', user_id: '1', ts: now, text: 'user msg' })
    expect(getRecentOutboundCount('-100', 2)).toBe(0)
  })

  it('scopes to the specified chat_id', () => {
    initHistory(stateDir, 30)
    const now = Math.floor(Date.now() / 1000)
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [10], texts: ['in chat -100'], ts: now })
    recordOutbound({ chat_id: '-200', thread_id: null, message_ids: [11], texts: ['in chat -200'], ts: now })
    expect(getRecentOutboundCount('-100', 2)).toBe(1)
    expect(getRecentOutboundCount('-200', 2)).toBe(1)
  })
})

// A substantive reply: 200+ chars (the FINAL_ANSWER_MIN_CHARS threshold).
const SUBSTANTIVE = 'A'.repeat(200)
// A non-substantive ack: short (<200 chars).
const ACK = 'On it.'

describe('hasOutboundDeliveredSince', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('returns true when a substantive outbound exists after openedAt', () => {
    const openedAt = 1_000_000 * 1000 // ms
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [10],
      texts: [SUBSTANTIVE],
      ts: 1_000_001, // sec — 1s after openedAt
    })
    expect(hasOutboundDeliveredSince('-100', openedAt)).toBe(true)
  })

  it('returns false when the only outbound is BEFORE openedAt', () => {
    const openedAt = 1_000_002 * 1000 // ms — after the message
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [10],
      texts: [SUBSTANTIVE],
      ts: 1_000_001, // sec — before openedAt
    })
    expect(hasOutboundDeliveredSince('-100', openedAt)).toBe(false)
  })

  it('returns false for a non-substantive ack after openedAt (blocker regression)', () => {
    // An agent that sends a short ack ("on it") then ghosts must NOT have
    // its escalation suppressed. The predicate must never match a bare ack.
    const openedAt = 1_000_000 * 1000
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [10],
      texts: [ACK],          // < 200 chars — non-substantive
      ts: 1_000_001,
    })
    expect(hasOutboundDeliveredSince('-100', openedAt)).toBe(false)
  })

  it('thread_id=undefined matches any thread (DM semantics)', () => {
    const openedAt = 1_000_000 * 1000
    recordOutbound({
      chat_id: '-100',
      thread_id: 5,
      message_ids: [10],
      texts: [SUBSTANTIVE],
      ts: 1_000_001,
    })
    // No thread filter → should find it
    expect(hasOutboundDeliveredSince('-100', openedAt, undefined)).toBe(true)
  })

  it('thread_id=number scopes to that thread only', () => {
    const openedAt = 1_000_000 * 1000
    recordOutbound({ chat_id: '-100', thread_id: 5, message_ids: [10], texts: [SUBSTANTIVE], ts: 1_000_001 })
    expect(hasOutboundDeliveredSince('-100', openedAt, 5)).toBe(true)
    expect(hasOutboundDeliveredSince('-100', openedAt, 6)).toBe(false)
  })

  it('thread_id=null matches only chat-root (non-thread) messages', () => {
    const openedAt = 1_000_000 * 1000
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [10], texts: [SUBSTANTIVE], ts: 1_000_001 })
    expect(hasOutboundDeliveredSince('-100', openedAt, null)).toBe(true)
    // A thread-scoped message should NOT match the root filter
    recordOutbound({ chat_id: '-100', thread_id: 3, message_ids: [11], texts: [SUBSTANTIVE], ts: 1_000_002 })
    expect(hasOutboundDeliveredSince('-100', openedAt, null)).toBe(true) // root still there
    expect(hasOutboundDeliveredSince('-100', openedAt, 3)).toBe(true)    // thread 3 also there
    expect(hasOutboundDeliveredSince('-100', openedAt, 9)).toBe(false)   // thread 9 not there
  })

  it('returns false when no history is present for the chat', () => {
    expect(hasOutboundDeliveredSince('-999', 0)).toBe(false)
  })

  // #2474 follow-up — the duplicate-represent guard passes a LOW minChars so a
  // terse-but-genuine reply counts as "the user was answered". The escalate
  // branch keeps the 200-char default.
  describe('minChars parameter (decoupled represent-guard threshold)', () => {
    it('default threshold (200) does NOT count a terse real reply', () => {
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: null,
        message_ids: [10],
        texts: ['Yes — done.'], // < 200 chars
        ts: 1_000_001,
      })
      // escalate-branch behavior is unchanged: a terse reply is NOT substantive
      expect(hasOutboundDeliveredSince('-100', openedAt)).toBe(false)
    })

    it('minChars=1 DOES count a terse real reply (fixes the #2472 terse-reply gap)', () => {
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: null,
        message_ids: [10],
        texts: ['Merged, all three landed.'], // genuine short reply
        ts: 1_000_001,
      })
      // represent-guard threshold: any real reply suppresses the duplicate
      expect(hasOutboundDeliveredSince('-100', openedAt, undefined, 1)).toBe(true)
    })

    it('minChars=1 still does NOT count an empty/whitespace-only row', () => {
      // A degenerate outbound (no real content) must never read as "answered",
      // even at the lowest threshold — minChars is clamped to >= 1.
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: null,
        message_ids: [10],
        texts: [''],
        ts: 1_000_001,
      })
      expect(hasOutboundDeliveredSince('-100', openedAt, undefined, 1)).toBe(false)
      // minChars=0 is clamped up to 1, so an empty row is still excluded
      expect(hasOutboundDeliveredSince('-100', openedAt, undefined, 0)).toBe(false)
    })

    it('minChars=1 respects the thread filter (terse reply scoped to its thread)', () => {
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: 5,
        message_ids: [10],
        texts: ['ok'],
        ts: 1_000_001,
      })
      expect(hasOutboundDeliveredSince('-100', openedAt, 5, 1)).toBe(true)
      expect(hasOutboundDeliveredSince('-100', openedAt, 6, 1)).toBe(false)
    })
  })

  // #4681 — the optional UPPER bound. The obligation escalate branch's reroute
  // fallback is licensed by an `EXPLICIT_OVERRIDDEN` record, which is evidence
  // about ONE instant; an open-ended forward query lets unrelated traffic in the
  // routed topic, arriving arbitrarily later, read as that record's answer and
  // close a genuinely unanswered obligation in silence.
  describe('untilMs parameter (the reroute fallback upper bound)', () => {
    it('omitted, the query stays open-ended forward (pre-existing behaviour)', () => {
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: null,
        message_ids: [10],
        texts: [SUBSTANTIVE],
        ts: 1_090_000, // 90_000s later
      })
      expect(hasOutboundDeliveredSince('-100', openedAt)).toBe(true)
    })

    it('excludes a row delivered AFTER the bound', () => {
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: null,
        message_ids: [10],
        texts: [SUBSTANTIVE],
        ts: 1_000_090, // 90s after the lower bound
      })
      // Inside an 18.5s window it cannot be this record's answer.
      expect(hasOutboundDeliveredSince('-100', openedAt, undefined, 200, openedAt + 18_500)).toBe(
        false,
      )
    })

    it('includes a row inside the bound, and the boundary second itself', () => {
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: null,
        message_ids: [10],
        texts: [SUBSTANTIVE],
        ts: 1_000_018, // 18s after — inside an 18.5s window
      })
      expect(hasOutboundDeliveredSince('-100', openedAt, undefined, 200, openedAt + 18_500)).toBe(
        true,
      )
      // The bound is CEILed to whole seconds, so a row written in the second the
      // bound falls inside is admitted — rounding never drops a real answer.
      expect(hasOutboundDeliveredSince('-100', openedAt, undefined, 200, openedAt + 17_600)).toBe(
        true,
      )
    })

    it('composes with the thread filter (parameter binding order)', () => {
      // The `ts <= ?` placeholder is appended BEFORE `thread_id = ?`; if the two
      // params were pushed in the wrong order the thread id would land in the
      // timestamp comparison and this would silently misbehave.
      const openedAt = 1_000_000 * 1000
      recordOutbound({
        chat_id: '-100',
        thread_id: 5,
        message_ids: [10],
        texts: [SUBSTANTIVE],
        ts: 1_000_010,
      })
      recordOutbound({
        chat_id: '-100',
        thread_id: 6,
        message_ids: [11],
        texts: [SUBSTANTIVE],
        ts: 1_000_090,
      })
      const until = openedAt + 18_500
      expect(hasOutboundDeliveredSince('-100', openedAt, 5, 200, until)).toBe(true)
      expect(hasOutboundDeliveredSince('-100', openedAt, 6, 200, until)).toBe(false) // too late
      expect(hasOutboundDeliveredSince('-100', openedAt, 6, 200)).toBe(true) // unbounded finds it
    })
  })
})

// Review finding H5 regression: the original PRIMARY KEY (chat_id, thread_id, message_id) does
// NOT dedupe thread-less rows because SQLite treats NULL as distinct from NULL
// in a UNIQUE/PK index. The documented at-least-once boot replay re-records an
// already-stored DM/non-topic message, so `INSERT OR REPLACE` appended a
// DUPLICATE row instead of replacing — over-counting the silence / over-ping
// detectors. The COALESCE(thread_id,'') unique index makes the upsert
// idempotent. These tests fail (duplicate rows) without the fix.
describe('idempotent upsert for null-thread rows (H5)', () => {
  beforeEach(() => initHistory(stateDir, 30))

  it('re-recording the same null-thread inbound yields exactly ONE row', () => {
    const msg = {
      chat_id: '-100',
      thread_id: null,
      message_id: 7,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'hello',
    }
    // Simulate the at-least-once replay: record the same message twice.
    recordInbound(msg)
    recordInbound(msg)
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ message_id: 7, role: 'user', text: 'hello' })
    // The over-count surface the finding calls out must stay accurate.
    expect(getRecentOutboundCount('-100', 999_999)).toBe(0)
  })

  it('re-recording the same null-thread outbound yields exactly ONE row', () => {
    const now = Math.floor(Date.now() / 1000)
    const send = {
      chat_id: '-100',
      thread_id: null,
      message_ids: [42],
      texts: ['the answer'],
      ts: now,
    }
    recordOutbound(send)
    recordOutbound(send)
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    // hasOutboundDeliveredSince / getRecentOutboundCount read this table; a
    // duplicate here would double-count and over-ping.
    expect(getRecentOutboundCount('-100', 60)).toBe(1)
  })

  it('a re-record REPLACES rather than appends (newest text wins)', () => {
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 7, user: 'a', user_id: '1', ts: 1000, text: 'first version' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 7, user: 'a', user_id: '1', ts: 1000, text: 'second version' })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toBe('second version')
  })

  it('a topic row and a general row with the SAME message_id stay DISTINCT', () => {
    // Same chat_id + message_id, but one is in a forum topic (thread 5) and one
    // is the general/DM row (null thread). These are different logical messages
    // and must both survive — the COALESCE sentinel keeps them separate.
    recordInbound({ chat_id: '-100', thread_id: 5, message_id: 9, user: 'a', user_id: '1', ts: 100, text: 'in topic 5' })
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 9, user: 'a', user_id: '1', ts: 100, text: 'in general' })
    expect(query({ chat_id: '-100' })).toHaveLength(2)
    expect(query({ chat_id: '-100', thread_id: 5 }).map(r => r.text)).toEqual(['in topic 5'])
    expect(query({ chat_id: '-100', thread_id: null }).map(r => r.text)).toEqual(['in general'])
  })

  it('two distinct forum topics with the same message_id stay DISTINCT', () => {
    recordInbound({ chat_id: '-100', thread_id: 5, message_id: 9, user: 'a', user_id: '1', ts: 100, text: 'topic5' })
    recordInbound({ chat_id: '-100', thread_id: 6, message_id: 9, user: 'a', user_id: '1', ts: 100, text: 'topic6' })
    expect(query({ chat_id: '-100' })).toHaveLength(2)
    expect(query({ chat_id: '-100', thread_id: 5 }).map(r => r.text)).toEqual(['topic5'])
    expect(query({ chat_id: '-100', thread_id: 6 }).map(r => r.text)).toEqual(['topic6'])
  })

  it('migration de-dupes pre-existing null-thread duplicates from a legacy DB', async () => {
    // Simulate a DB written by the pre-fix build: insert duplicate null-thread
    // rows DIRECTLY, bypassing the (now-fixed) upsert, to reproduce the exact
    // corruption the finding describes. Then re-init to fire the migration.
    const { Database } = await import('bun:sqlite')
    const dbPath = join(stateDir, 'history.db')
    const now = Math.floor(Date.now() / 1000) // recent ts so the retention sweep keeps them
    _resetForTests()
    const raw = new Database(dbPath)
    // Drop the logical-key index so we're back to the legacy, dupe-permitting
    // schema, then append two rows sharing the same (chat, null-thread, msg).
    raw.exec('DROP INDEX IF EXISTS idx_messages_logical_key')
    const insert = raw.prepare(
      `INSERT INTO messages (chat_id, thread_id, message_id, role, user, user_id, ts, text, group_id)
       VALUES (?, NULL, ?, 'user', 'a', '1', ?, ?, NULL)`,
    )
    insert.run('-100', 7, now, 'stale copy')
    insert.run('-100', 7, now + 1, 'newest copy')
    // A distinct topic row with the same message_id must survive the migration.
    raw.prepare(
      `INSERT INTO messages (chat_id, thread_id, message_id, role, user, user_id, ts, text, group_id)
       VALUES (?, 5, ?, 'user', 'a', '1', ?, ?, NULL)`,
    ).run('-100', 7, now, 'topic row')
    raw.close()

    // Re-open through initHistory → runs the H5 migration (dedupe + index).
    initHistory(stateDir, 30)
    const general = query({ chat_id: '-100', thread_id: null })
    expect(general).toHaveLength(1)
    expect(general[0]?.text).toBe('newest copy') // kept the newest (highest ts/rowid)
    // The topic row with the same message_id is untouched.
    expect(query({ chat_id: '-100', thread_id: 5 }).map(r => r.text)).toEqual(['topic row'])
    expect(query({ chat_id: '-100' })).toHaveLength(2)

    // And the upsert is idempotent going forward.
    recordInbound({ chat_id: '-100', thread_id: null, message_id: 7, user: 'a', user_id: '1', ts: now + 2, text: 'replay' })
    expect(query({ chat_id: '-100', thread_id: null })).toHaveLength(1)
  })
})

describe('secret redaction at persistence (both directions)', () => {
  beforeEach(() => initHistory(stateDir, 30))

  // Built by concatenation so the source never holds a contiguous
  // secret-shaped literal (repo Push Protection / no-pii lint).
  const SANCTUM = `19|${'qP4mN7rT2v'.repeat(4)}` // <id>|<40 base62> (Sanctum/Coolify)
  const GH_PAT = `ghp_${'A1b2C3d4E5'.repeat(3)}` // ghp_<30 base62>

  it('masks a user-pasted secret before it is stored (inbound)', () => {
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 1,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: `the new coolify token is ${SANCTUM}, save it`,
    })
    const text = query({ chat_id: '-100' })[0]!.text as string
    expect(text).not.toContain(SANCTUM)
    expect(text).toContain('[REDACTED')
    expect(text).toContain('the new coolify token is') // surrounding prose preserved
  })

  it('masks a secret echoed by the agent before it is stored (outbound)', () => {
    recordOutbound({
      chat_id: '-100',
      thread_id: null,
      message_ids: [2],
      texts: [`sure — your key is ${GH_PAT}, keep it safe`],
      ts: 2000,
    })
    const text = query({ chat_id: '-100' })[0]!.text as string
    expect(text).not.toContain(GH_PAT)
    expect(text).toContain('[REDACTED')
  })

  it('masks a secret introduced by an edit', () => {
    recordOutbound({ chat_id: '-100', thread_id: null, message_ids: [3], texts: ['placeholder'], ts: 3000 })
    recordEdit({ chat_id: '-100', message_id: 3, text: `token: ${SANCTUM}` })
    const text = query({ chat_id: '-100' })[0]!.text as string
    expect(text).not.toContain(SANCTUM)
    expect(text).toContain('[REDACTED')
  })

  it('leaves ordinary prose untouched', () => {
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 4,
      user: 'a',
      user_id: '1',
      ts: 4000,
      text: 'hello, how are you?',
    })
    expect(query({ chat_id: '-100' })[0]!.text).toBe('hello, how are you?')
  })
})

describe('forwarded-message origin columns', () => {
  it('round-trips forwarded_* fields on an inbound row', () => {
    initHistory(stateDir, 30)
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 7,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'fwd: look at this',
      forwarded_from: 'Release Notes (@relnotes)',
      forwarded_from_type: 'channel',
      forwarded_from_id: '-100400500',
      forwarded_date: '2026-06-15T13:46:40.000Z',
      forwarded_message_id: 555,
    })
    const row = query({ chat_id: '-100' })[0]!
    expect(row).toMatchObject({
      forwarded_from: 'Release Notes (@relnotes)',
      forwarded_from_type: 'channel',
      forwarded_from_id: '-100400500',
      forwarded_date: '2026-06-15T13:46:40.000Z',
      forwarded_message_id: 555,
    })
  })

  it('non-forwarded inbound stores NULL origin fields', () => {
    initHistory(stateDir, 30)
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 8,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'plain message',
    })
    const row = query({ chat_id: '-100' })[0]!
    expect(row.forwarded_from).toBeNull()
    expect(row.forwarded_from_type).toBeNull()
    expect(row.forwarded_from_id).toBeNull()
    expect(row.forwarded_date).toBeNull()
    expect(row.forwarded_message_id).toBeNull()
  })

  it('migrates additively: pre-existing DB without the columns gains them and round-trips', () => {
    // Build an OLD-schema DB file the way a pre-forward-origin build would
    // have left it: messages table without any forwarded_* columns, one row
    // already stored.
    const dbPath = join(stateDir, 'history.db')
    const old = new Database(dbPath, { create: true })
    old.exec(`
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
        reply_to_message_id INTEGER,
        reply_to_text  TEXT,
        PRIMARY KEY (chat_id, thread_id, message_id)
      )
    `)
    // Recent ts — initHistory's retention sweep deletes rows older than the
    // cutoff, and this test is about migration, not retention.
    const now = Math.floor(Date.now() / 1000)
    old.exec(
      `INSERT INTO messages (chat_id, thread_id, message_id, role, user, user_id, ts, text) ` +
      `VALUES ('-100', NULL, 1, 'user', 'alice', '111', ${now - 60}, 'pre-migration row')`,
    )
    old.close()

    // Re-open through the real init path — the additive ALTER TABLE loop
    // must add the forwarded_* columns without touching existing rows.
    initHistory(stateDir, 30)

    const oldRow = query({ chat_id: '-100' })[0]!
    expect(oldRow.text).toBe('pre-migration row')
    expect(oldRow.forwarded_from).toBeNull()

    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 2,
      user: 'alice',
      user_id: '111',
      ts: now,
      text: 'forwarded after migration',
      forwarded_from: 'Ada Lovelace (@adalove)',
      forwarded_from_type: 'user',
      forwarded_from_id: '42',
      forwarded_date: '2026-06-15T13:46:40.000Z',
    })
    const rows = query({ chat_id: '-100' })
    expect(rows).toHaveLength(2)
    const fwd = rows.find((r) => r.message_id === 2)!
    expect(fwd.forwarded_from).toBe('Ada Lovelace (@adalove)')
    expect(fwd.forwarded_from_type).toBe('user')
    expect(fwd.forwarded_from_id).toBe('42')
    expect(fwd.forwarded_date).toBe('2026-06-15T13:46:40.000Z')
    expect(fwd.forwarded_message_id).toBeNull()
  })

  it('hostile origin name is stored raw (XML metachars belong to the meta lane)', () => {
    initHistory(stateDir, 30)
    // Raw XML metacharacters are EXPECTED here — escaping belongs to the
    // channel-meta lane, the history buffer stores what the user saw.
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 9,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'fwd',
      forwarded_from: '<b>"Bob"&\'friends\'</b>',
      forwarded_from_type: 'user',
      forwarded_from_id: '42',
    })
    expect(query({ chat_id: '-100' })[0]!.forwarded_from).toBe('<b>"Bob"&\'friends\'</b>')
  })

  it('masks a secret-shaped origin name before it is stored (redaction backstop)', () => {
    initHistory(stateDir, 30)
    // Built by concatenation so the source never holds a contiguous
    // secret-shaped literal (repo Push Protection / no-pii lint). Same
    // pattern as the text/reply_to_text redaction tests above — a display
    // name is user-controlled text and rides the same redact() backstop.
    const GH_PAT = `ghp_${'F6g7H8i9J0'.repeat(3)}` // ghp_<30 base62>
    recordInbound({
      chat_id: '-100',
      thread_id: null,
      message_id: 10,
      user: 'alice',
      user_id: '111',
      ts: 1000,
      text: 'fwd',
      forwarded_from: `Bob ${GH_PAT}`,
      forwarded_from_type: 'user',
      forwarded_from_id: '42',
    })
    const stored = query({ chat_id: '-100' })[0]!.forwarded_from as string
    expect(stored).not.toContain(GH_PAT)
    expect(stored).toContain('[REDACTED')
    expect(stored).toContain('Bob') // surrounding name preserved
  })
})

// ---------------------------------------------------------------------------
// hasOutboundWithText — durable text-identity delivery oracle (crash-survival
// redelivery). Keys on the ANSWER TEXT, not a chat+time window, so an interim
// progress_update earlier in the same turn does NOT false-positive "delivered".
// ---------------------------------------------------------------------------

describe('hasOutboundWithText (durable text-identity oracle)', () => {
  it('does NOT match an interim progress message against the (undelivered) final answer', () => {
    initHistory(stateDir, 30)
    // The turn sent only an interim progress_update; the real final answer was
    // lost in the crash and never recorded. The time-windowed oracle would say
    // "delivered" off the progress row — the text-identity oracle must not.
    recordOutbound({
      chat_id: '1', thread_id: null, message_ids: [10],
      texts: ['on it — pulling yesterday’s GitHub activity'], ts: 200,
    })
    const finalAnswer = 'The deploy finished — all three services are green.'
    expect(hasOutboundWithText('1', finalAnswer, null)).toBe(false)
    // sanity: the coarse time-window oracle DOES false-positive here (this is
    // exactly why we cannot use it as the redelivery gate).
    expect(hasOutboundDeliveredSince('1', 100 * 1000, null, 1)).toBe(true)
  })

  it('matches when the final answer text was actually delivered', () => {
    initHistory(stateDir, 30)
    const finalAnswer = 'The deploy finished — all three services are green.'
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [11], texts: [finalAnswer], ts: 300 })
    expect(hasOutboundWithText('1', finalAnswer, null)).toBe(true)
  })

  it('matches a delivered chunk-1 against a longer projected answer (multi-chunk, no double-send)', () => {
    initHistory(stateDir, 30)
    const chunk1 = 'Part one of a long answer that was split across chunks.'
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [12], texts: [chunk1], ts: 300 })
    // The re-projected full answer starts with chunk-1 → treated as delivered.
    expect(hasOutboundWithText('1', chunk1 + ' Part two continues here.', null)).toBe(true)
  })

  it('ignores whitespace/spacer differences via normalization', () => {
    initHistory(stateDir, 30)
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [13], texts: ['hello   world'], ts: 300 })
    expect(hasOutboundWithText('1', 'hello world', null)).toBe(true)
    expect(normalizeDeliveryText('hello   world')).toBe('hello world')
  })

  it('empty/whitespace text never matches', () => {
    initHistory(stateDir, 30)
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [14], texts: ['real'], ts: 300 })
    expect(hasOutboundWithText('1', '   ', null)).toBe(false)
  })

  it('scopes by chat (a different chat does not satisfy the match)', () => {
    initHistory(stateDir, 30)
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [15], texts: ['scoped answer'], ts: 300 })
    expect(hasOutboundWithText('2', 'scoped answer', null)).toBe(false)
    expect(hasOutboundWithText('1', 'scoped answer', null)).toBe(true)
  })

  // diff-review defect #1 — a SHORT final answer must not false-positive-match an
  // unrelated earlier row via the bidirectional-prefix rule (that would suppress a
  // genuine redelivery = permanent silence). Short texts require full equality.
  it('does NOT suppress a short answer that merely shares a prefix with an unrelated row', () => {
    initHistory(stateDir, 30)
    // An earlier turn delivered a longer line that starts with the short answer.
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [20], texts: ['Done, deploying now.'], ts: 300 })
    // The interrupted turn's real final answer was the short "Done." — never sent.
    expect(hasOutboundWithText('1', 'Done.', null)).toBe(false)
  })

  it('still suppresses a short answer that was genuinely delivered (exact match)', () => {
    initHistory(stateDir, 30)
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [21], texts: ['Done.'], ts: 300 })
    expect(hasOutboundWithText('1', 'Done.', null)).toBe(true)
  })

  // sinceMs scope: only rows delivered at/after the interrupted turn's started_at
  // count, so an unrelated PRIOR turn's identical text can never suppress.
  it('scopes by sinceMs (a prior-turn row before the floor does not match)', () => {
    initHistory(stateDir, 30)
    // Prior turn delivered this exact text at ts=200s.
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [22], texts: ['repeated answer'], ts: 200 })
    // Interrupted turn started at 250s (250_000 ms) — the prior row is out of scope.
    expect(hasOutboundWithText('1', 'repeated answer', null, 250_000)).toBe(false)
    // A row delivered within the turn window (ts=300s) does match.
    recordOutbound({ chat_id: '1', thread_id: null, message_ids: [23], texts: ['repeated answer'], ts: 300 })
    expect(hasOutboundWithText('1', 'repeated answer', null, 250_000)).toBe(true)
  })
})

// ── 2026-07-16 incident hardening: writer durability across restart + surfacing
//    swallowed insert failures. Root cause: turn-flush deliveries (18944/18958)
//    reached Telegram but were absent from history.db, blinding
//    getRecentOutboundCount / hasOutboundDeliveredSince. The gateway had already
//    logged "history capture enabled" on both restarts, so DB-open success was
//    NOT proof the row-insert path worked. These tests pin the durable fix.
describe('history writer durability (2026-07-16 incident)', () => {
  it('verifyHistoryWritable proves the INSERT path works on a live DB', () => {
    initHistory(stateDir, 30)
    const res = verifyHistoryWritable()
    expect(res.ok).toBe(true)
    // The self-check must leave NO sentinel residue behind.
    expect(getRecentOutboundCount('__history_selfcheck__', 86_400)).toBe(0)
  })

  it('verifyHistoryWritable reports not-ok before init (no silent success)', () => {
    // No initHistory() this test — the writer is uninitialised.
    const res = verifyHistoryWritable()
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/initHistory/)
  })

  // The core recovery contract: recording must survive a shutdown + reinit
  // (a gateway restart, which nulls the module singleton and re-opens the same
  // file). Rows written before AND after the boundary must all be queryable.
  it('recording continues across a simulated restart (reinit of the same DB)', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    initHistory(stateDir, 30)
    recordOutbound({ chat_id: '9', thread_id: null, message_ids: [100], texts: ['before restart'], ts: nowSec - 60 })
    // Simulate a gateway restart: close + forget the singleton, then reinit
    // against the SAME stateDir (fresh process, db=null → re-open).
    _resetForTests()
    initHistory(stateDir, 30)
    // Boot self-check must still pass against the existing, populated file.
    expect(verifyHistoryWritable().ok).toBe(true)
    recordOutbound({ chat_id: '9', thread_id: null, message_ids: [101], texts: ['after restart'], ts: nowSec })
    const rows = query({ chat_id: '9' })
    expect(rows.map((r) => r.message_id)).toEqual([100, 101])
    // The backstop suppression counter (the surface blinded by the incident)
    // must see BOTH the pre- and post-restart outbounds.
    expect(getRecentOutboundCount('9', 10_000_000_000)).toBe(2)
  })

  // The exact incident shape: a malformed send result yields an invalid
  // message_id. OLD behaviour: the NOT NULL PRIMARY KEY throws inside the tx and
  // the caller's `catch {}` swallows it — the row is lost AND invisible. NEW
  // behaviour: the invalid chunk is filtered + logged, valid chunks still land,
  // and no throw escapes to be swallowed.
  it('drops an invalid message_id chunk loudly but records the valid ones (no silent total loss)', () => {
    initHistory(stateDir, 30)
    const errs: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    // @ts-expect-error narrow test shim over the write overloads
    process.stderr.write = (chunk: string) => { errs.push(String(chunk)); return true }
    try {
      recordOutbound({
        chat_id: '9',
        thread_id: null,
        // chunk 0 is a malformed (undefined) id; chunk 1 is real.
        message_ids: [undefined as unknown as number, 200],
        texts: ['lost chunk', 'kept chunk'],
        ts: 3000,
      })
    } finally {
      process.stderr.write = orig
    }
    // The valid chunk is recorded (delivery accounting is NOT silently zeroed).
    const rows = query({ chat_id: '9' })
    expect(rows.map((r) => r.message_id)).toEqual([200])
    // The drop was surfaced loudly, not swallowed.
    expect(errs.join('')).toMatch(/invalid message_id/)
  })

  it('recordOutbound with an all-invalid id set no-ops without throwing', () => {
    initHistory(stateDir, 30)
    expect(() =>
      recordOutbound({
        chat_id: '9',
        thread_id: null,
        message_ids: [NaN, null as unknown as number],
        texts: ['a', 'b'],
      }),
    ).not.toThrow()
    expect(getRecentOutboundCount('9', 10_000_000_000)).toBe(0)
  })
})
