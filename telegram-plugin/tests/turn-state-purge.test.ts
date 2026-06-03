/**
 * turn-state-purge — the silence-poke fallback's defense-in-depth
 * cleanup. Pins the multi-chat safety + key-shape correctness that
 * the gymbro/klanker held-mid-turn fix (2026-05-20) depends on.
 */

import { describe, it, expect } from 'vitest'
import { purgeStaleTurnsForChat } from '../gateway/turn-state-purge.js'

function statusKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

describe('purgeStaleTurnsForChat', () => {
  it('returns [] and calls nothing when keys is empty', () => {
    let calls = 0
    const r = purgeStaleTurnsForChat('123', [], () => calls++)
    expect(r.purged).toEqual([])
    expect(calls).toBe(0)
  })

  it('returns [] and calls nothing when chatId is empty (guard)', () => {
    let calls = 0
    const r = purgeStaleTurnsForChat('', [statusKey('123')], () => calls++)
    expect(r.purged).toEqual([])
    expect(calls).toBe(0)
  })

  it('purges the canonical DM key for the firing chat (typical case)', () => {
    const purged: string[] = []
    const r = purgeStaleTurnsForChat(
      '12345',
      [statusKey('12345')],
      (k) => purged.push(k),
    )
    expect(r.purged).toEqual(['12345:_'])
    expect(purged).toEqual(['12345:_'])
  })

  it('purges every sibling key for the same chat (multi-thread / dangling)', () => {
    // This is the gymbro/klanker symptom: a stale activeTurnStartedAt
    // entry under a different thread of the same chat survives the
    // canonical purgeReactionTracking(fbKey).
    const purged: string[] = []
    const r = purgeStaleTurnsForChat(
      '12345',
      [
        statusKey('12345'),       // DM, no thread
        statusKey('12345', 42),    // thread 42
        statusKey('12345', 99),    // thread 99
      ],
      (k) => purged.push(k),
    )
    expect(r.purged.sort()).toEqual(['12345:42', '12345:99', '12345:_'])
    expect(purged).toHaveLength(3)
  })

  it('NEVER touches keys for OTHER chats (multi-chat safety — the #1546 guard)', () => {
    const purged: string[] = []
    const r = purgeStaleTurnsForChat(
      '12345',
      [
        statusKey('12345'),       // target chat — purge
        statusKey('-1001234567890'),       // different chat — must NOT touch
        statusKey('-1001234567890', 7),    // different chat thread — must NOT touch
      ],
      (k) => purged.push(k),
    )
    expect(r.purged).toEqual(['12345:_'])
    expect(purged).toEqual(['12345:_']) // ONLY the target chat
  })

  it('does not false-match on a chatId-prefix superstring (e.g. 123 vs 1234)', () => {
    // If we used a naive startsWith on the WHOLE key, chatId "123"
    // would falsely match key "1234:_". The helper splits on `:` and
    // equates the chatId slice, which prevents that.
    const purged: string[] = []
    const r = purgeStaleTurnsForChat(
      '123',
      [statusKey('123'), statusKey('1234'), statusKey('12')],
      (k) => purged.push(k),
    )
    expect(r.purged).toEqual(['123:_']) // ONLY the exact match
  })

  it('skips malformed keys (no `:`)', () => {
    let calls = 0
    const r = purgeStaleTurnsForChat(
      '123',
      ['malformed', '', 'no-colon-here', statusKey('123')],
      () => calls++,
    )
    expect(r.purged).toEqual(['123:_'])
    expect(calls).toBe(1)
  })

  it('accepts any iterable (snapshots before iteration — purger may delete)', () => {
    // The real call site iterates `activeTurnStartedAt.keys()` and
    // the purger deletes from that same Map. Snapshotting in the
    // helper prevents iterator skew.
    const map = new Map<string, number>()
    map.set('123:_', 1)
    map.set('123:7', 2)
    map.set('999:_', 3)
    const r = purgeStaleTurnsForChat('123', map.keys(), (k) => map.delete(k))
    expect(r.purged.sort()).toEqual(['123:7', '123:_'])
    expect([...map.keys()]).toEqual(['999:_']) // multi-chat safety preserved
  })

  // #2 supergroup sibling-topic fix: one agent owns the supergroup, so all
  // forum topics share the chatId. A 300s poke on topic A must NOT purge a
  // LIVE sibling topic B's turn state — only siblings that are themselves stale.
  it('isStale predicate spares live sibling topics (the supergroup fix)', () => {
    const purged: string[] = []
    const live = new Set(['-100:7']) // topic 7 is actively mid-turn
    const r = purgeStaleTurnsForChat(
      '-100',
      ['-100:4', '-100:7', '999:_'],
      (k) => purged.push(k),
      (k) => !live.has(k), // stale iff not live
    )
    expect(r.purged).toEqual(['-100:4']) // only the stale topic purged
    expect(purged).toEqual(['-100:4']) // live topic 7 + other chat untouched
  })

  it('isStale=false for every sibling purges nothing (all topics live)', () => {
    const purged: string[] = []
    purgeStaleTurnsForChat('-100', ['-100:4', '-100:7'], (k) => purged.push(k), () => false)
    expect(purged).toEqual([])
  })

  it('default isStale (omitted) purges every chatId match — back-compat', () => {
    const purged: string[] = []
    const r = purgeStaleTurnsForChat('123', ['123:_', '123:7', '999:_'], (k) => purged.push(k))
    expect(r.purged.sort()).toEqual(['123:7', '123:_'])
  })
})
