import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, statSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordInbound,
  recordOutbound,
  recordEdit,
  query,
  getRecentOutboundCount,
  getLatestInboundMessageId,
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
  it('creates history.db with chmod 0600', () => {
    initHistory(stateDir, 30)
    const dbPath = join(stateDir, 'history.db')
    expect(existsSync(dbPath)).toBe(true)
    const st = statSync(dbPath)
    // Mask off the file-type bits — only the perm bits matter.
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('is idempotent — second call is a no-op', () => {
    initHistory(stateDir, 30)
    expect(() => initHistory(stateDir, 30)).not.toThrow()
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
