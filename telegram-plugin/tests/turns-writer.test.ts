/**
 * Tests for Phase 1 of #332 — turns writer wiring.
 *
 * Covers the four acceptance criteria from the issue:
 *   1. Clean turn: insert + finalize → row has ended_via='stop', non-null
 *      ended_at, correct previews.
 *   2. Mid-turn restart: insert without finalize, simulate gateway boot via
 *      markOrphanedAsRestarted → row has ended_via='restart'.
 *   3. Multiple concurrent turns same chat: each row has a unique turn_key,
 *      no cross-contamination.
 *   4. tool_call_count increments correctly for N tool_use events.
 *
 * These tests run under Bun (bun:sqlite is a Bun built-in). They are
 * excluded from vitest.config.ts and run via `bun test` or the `test:bun`
 * script in the root package.json.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  openTurnsDbInMemory,
  recordTurnStart,
  recordTurnEnd,
  markOrphanedAsRestarted,
} from '../registry/turns-schema.js'

// ---------------------------------------------------------------------------
// 1. Clean turn
// ---------------------------------------------------------------------------

describe('clean turn (Phase 1 #332)', () => {
  it('insert + finalize → ended_via=stop, non-null ended_at, correct previews', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, {
      turnKey: 'chat1:_:1000',
      chatId: 'chat1',
      userPromptPreview: 'Hello, can you help me?',
    })

    // Before finalization the row is open.
    const open = db
      .prepare('SELECT ended_at, ended_via FROM turns WHERE turn_key = ?')
      .get('chat1:_:1000') as Record<string, unknown>
    expect(open['ended_at']).toBeNull()
    expect(open['ended_via']).toBeNull()

    recordTurnEnd(db, {
      turnKey: 'chat1:_:1000',
      endedVia: 'stop',
      assistantReplyPreview: 'Sure! Here is what I found.',
      toolCallCount: 3,
    })

    const row = db
      .prepare('SELECT * FROM turns WHERE turn_key = ?')
      .get('chat1:_:1000') as Record<string, unknown>

    expect(row['ended_via']).toBe('stop')
    expect(row['ended_at']).toBeTypeOf('number')
    expect((row['ended_at'] as number) > 0).toBe(true)
    expect(row['user_prompt_preview']).toBe('Hello, can you help me?')
    expect(row['assistant_reply_preview']).toBe('Sure! Here is what I found.')
    expect(row['tool_call_count']).toBe(3)

    db.close()
  })

  it('user_prompt_preview is stored at insert time, not overwritten by recordTurnEnd', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, {
      turnKey: 'chat1:_:1001',
      chatId: 'chat1',
      userPromptPreview: 'first 200 chars of the user message',
    })

    recordTurnEnd(db, {
      turnKey: 'chat1:_:1001',
      endedVia: 'stop',
      assistantReplyPreview: 'bot response',
      toolCallCount: 0,
    })

    const row = db
      .prepare('SELECT user_prompt_preview FROM turns WHERE turn_key = ?')
      .get('chat1:_:1001') as Record<string, unknown>
    expect(row['user_prompt_preview']).toBe('first 200 chars of the user message')

    db.close()
  })

  it('null userPromptPreview and null assistantReplyPreview are stored correctly', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, { turnKey: 'chat1:_:1002', chatId: 'chat1' })
    recordTurnEnd(db, { turnKey: 'chat1:_:1002', endedVia: 'stop', toolCallCount: 0 })

    const row = db
      .prepare('SELECT user_prompt_preview, assistant_reply_preview FROM turns WHERE turn_key = ?')
      .get('chat1:_:1002') as Record<string, unknown>
    expect(row['user_prompt_preview']).toBeNull()
    expect(row['assistant_reply_preview']).toBeNull()

    db.close()
  })
})

// ---------------------------------------------------------------------------
// 2. Mid-turn restart
// ---------------------------------------------------------------------------

describe('mid-turn restart (Phase 1 #332)', () => {
  it('insert without finalize, then markOrphanedAsRestarted → ended_via=restart', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, {
      turnKey: 'chat2:_:2000',
      chatId: 'chat2',
      userPromptPreview: 'this turn was interrupted',
    })

    // Simulate gateway boot reaper (same path as the real gateway boot).
    const swept = markOrphanedAsRestarted(db)
    expect(swept).toBe(1)

    const row = db
      .prepare('SELECT ended_via, ended_at FROM turns WHERE turn_key = ?')
      .get('chat2:_:2000') as Record<string, unknown>

    expect(row['ended_via']).toBe('restart')
    expect(row['ended_at']).toBeTypeOf('number')
    expect((row['ended_at'] as number) > 0).toBe(true)

    db.close()
  })

  it('clean turns are not touched by the reaper', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, { turnKey: 'chat2:_:2001', chatId: 'chat2' })
    recordTurnEnd(db, { turnKey: 'chat2:_:2001', endedVia: 'stop' })
    recordTurnStart(db, { turnKey: 'chat2:_:2002', chatId: 'chat2' })

    markOrphanedAsRestarted(db)

    const clean = db
      .prepare('SELECT ended_via FROM turns WHERE turn_key = ?')
      .get('chat2:_:2001') as Record<string, unknown>
    const orphan = db
      .prepare('SELECT ended_via FROM turns WHERE turn_key = ?')
      .get('chat2:_:2002') as Record<string, unknown>

    expect(clean['ended_via']).toBe('stop')
    expect(orphan['ended_via']).toBe('restart')

    db.close()
  })
})

// ---------------------------------------------------------------------------
// 3. Multiple concurrent turns same chat
// ---------------------------------------------------------------------------

describe('multiple concurrent turns same chat (Phase 1 #332)', () => {
  it('each row has a unique turn_key, values do not bleed across rows', () => {
    const db = openTurnsDbInMemory()

    const turns = [
      { key: 'chatA:_:3000', prompt: 'first message', reply: 'first reply', tools: 1 },
      { key: 'chatA:_:3001', prompt: 'second message', reply: 'second reply', tools: 2 },
      { key: 'chatA:_:3002', prompt: 'third message', reply: 'third reply', tools: 5 },
    ]

    for (const t of turns) {
      recordTurnStart(db, {
        turnKey: t.key,
        chatId: 'chatA',
        userPromptPreview: t.prompt,
      })
      recordTurnEnd(db, {
        turnKey: t.key,
        endedVia: 'stop',
        assistantReplyPreview: t.reply,
        toolCallCount: t.tools,
      })
    }

    const rows = db
      .prepare('SELECT * FROM turns WHERE chat_id = ? ORDER BY started_at ASC')
      .all('chatA') as Record<string, unknown>[]

    expect(rows).toHaveLength(3)

    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!
      const row = rows[i]!
      expect(row['turn_key']).toBe(t.key)
      expect(row['user_prompt_preview']).toBe(t.prompt)
      expect(row['assistant_reply_preview']).toBe(t.reply)
      expect(row['tool_call_count']).toBe(t.tools)
      expect(row['ended_via']).toBe('stop')
    }

    db.close()
  })

  it('turn_keys are unique even for the same chat_id', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, { turnKey: 'chatB:_:4000', chatId: 'chatB', userPromptPreview: 'a' })
    recordTurnStart(db, { turnKey: 'chatB:_:4001', chatId: 'chatB', userPromptPreview: 'b' })

    const keys = (
      db.prepare('SELECT turn_key FROM turns WHERE chat_id = ?').all('chatB') as Record<
        string,
        unknown
      >[]
    ).map((r) => r['turn_key'])

    expect(new Set(keys).size).toBe(2)

    db.close()
  })
})

// ---------------------------------------------------------------------------
// 4. tool_call_count accuracy
// ---------------------------------------------------------------------------

describe('tool_call_count (Phase 1 #332)', () => {
  it('records 0 when no tools were called', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, { turnKey: 'chat5:_:5000', chatId: 'chat5' })
    recordTurnEnd(db, { turnKey: 'chat5:_:5000', endedVia: 'stop', toolCallCount: 0 })

    const row = db
      .prepare('SELECT tool_call_count FROM turns WHERE turn_key = ?')
      .get('chat5:_:5000') as Record<string, unknown>
    expect(row['tool_call_count']).toBe(0)

    db.close()
  })

  it('records the exact number of tool_use events', () => {
    const db = openTurnsDbInMemory()
    const N = 7

    recordTurnStart(db, { turnKey: 'chat5:_:5001', chatId: 'chat5' })
    recordTurnEnd(db, {
      turnKey: 'chat5:_:5001',
      endedVia: 'stop',
      toolCallCount: N,
    })

    const row = db
      .prepare('SELECT tool_call_count FROM turns WHERE turn_key = ?')
      .get('chat5:_:5001') as Record<string, unknown>
    expect(row['tool_call_count']).toBe(N)

    db.close()
  })

  it('null tool_call_count when not provided to recordTurnEnd', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, { turnKey: 'chat5:_:5002', chatId: 'chat5' })
    // toolCallCount omitted — simulates the kill/SIGTERM path where count
    // may not be written (reaper path writes null).
    recordTurnEnd(db, { turnKey: 'chat5:_:5002', endedVia: 'restart' })

    const row = db
      .prepare('SELECT tool_call_count FROM turns WHERE turn_key = ?')
      .get('chat5:_:5002') as Record<string, unknown>
    expect(row['tool_call_count']).toBeNull()

    db.close()
  })

  it('tool_call_count increments are independent per turn', () => {
    const db = openTurnsDbInMemory()

    recordTurnStart(db, { turnKey: 'chat5:_:5010', chatId: 'chat5' })
    recordTurnEnd(db, { turnKey: 'chat5:_:5010', endedVia: 'stop', toolCallCount: 3 })

    recordTurnStart(db, { turnKey: 'chat5:_:5011', chatId: 'chat5' })
    recordTurnEnd(db, { turnKey: 'chat5:_:5011', endedVia: 'stop', toolCallCount: 9 })

    const r1 = db
      .prepare('SELECT tool_call_count FROM turns WHERE turn_key = ?')
      .get('chat5:_:5010') as Record<string, unknown>
    const r2 = db
      .prepare('SELECT tool_call_count FROM turns WHERE turn_key = ?')
      .get('chat5:_:5011') as Record<string, unknown>

    expect(r1['tool_call_count']).toBe(3)
    expect(r2['tool_call_count']).toBe(9)

    db.close()
  })
})

// ---------------------------------------------------------------------------
// Schema migration: existing DB without the Phase 1 columns
// ---------------------------------------------------------------------------

describe('schema migration (Phase 1 #332)', () => {
  it('openTurnsDbInMemory adds Phase 1 columns to the turns table', () => {
    const db = openTurnsDbInMemory()

    // If columns are missing SQLite throws "no such column"; this shows they
    // exist and accept null/integer values correctly.
    expect(() =>
      db
        .prepare(
          'SELECT user_prompt_preview, assistant_reply_preview, tool_call_count FROM turns',
        )
        .all(),
    ).not.toThrow()

    db.close()
  })
})
