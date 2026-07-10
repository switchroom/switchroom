/**
 * Unit tests for telegram-plugin/gateway/always-allow-persist-queue.ts
 * (#2973 pt.2 — durable retry queue for the "🔁 Always allow" persist).
 *
 * Contract under test:
 *   - enqueue is idempotent per (agent, rule); survives reload (boot drain);
 *   - listDue only returns entries whose backoff has elapsed;
 *   - a retryable failure re-checks isRulePersisted FIRST via a fresh
 *     config read, then re-synthesizes and redispatches — success dequeues;
 *   - a persist that fails 5 times (or ages out) is dropped AND the
 *     terminal-failure notice fires exactly once;
 *   - a retry that finds the rule already persisted is a no-op dequeue
 *     (no duplicate-rule risk, no redispatch);
 *   - bounds are structural: MAX_ATTEMPTS, MAX_AGE_MS, MAX_QUEUE_SIZE,
 *     MAX_BACKOFF_MS all cap out — nothing retries indefinitely;
 *   - concurrent read-modify-write operations against the queue file
 *     (two overlapping enqueue()s, an enqueue() racing a drain's
 *     recordAttempt(), etc.) are serialized — no lost update, no
 *     duplicated/corrupted rule (adversarial review pt.1/pt.3);
 *   - a write failure (disk full, permissions, …) PROPAGATES to the
 *     caller of enqueue/recordAttempt/remove rather than being silently
 *     swallowed (adversarial review pt.2).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Tests that need to force a `writeFileSync` failure (disk full /
// permissions / read-only fs) pass one in via `createAlwaysAllowPersistQueue`'s
// injectable `writeFileSyncFn` param (see `makeControllableWrite` below)
// rather than mocking `node:fs` — we run as root in CI/containers, so
// chmod-based permission tricks don't reliably fail, and bun's test runner
// doesn't support mocking node:fs built-ins.

import {
  createAlwaysAllowPersistQueue,
  drainAlwaysAllowPersistQueue,
  computeBackoffMs,
  isExhausted,
  makeEntryId,
  MAX_ATTEMPTS,
  MAX_AGE_MS,
  MAX_QUEUE_SIZE,
  MAX_BACKOFF_MS,
  BASE_BACKOFF_MS,
  type AlwaysAllowDrainDeps,
  type AlwaysAllowPersistEntry,
} from '../gateway/always-allow-persist-queue.js'

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'always-allow-persist-queue-test-'))
}

function baseArgs(over: Partial<Parameters<ReturnType<typeof createAlwaysAllowPersistQueue>['enqueue']>[0]> = {}) {
  return {
    agentName: 'clerk',
    rule: 'Skill(calendar)',
    grantPhrase: 'use the calendar skill',
    chatId: '-100123',
    threadId: 7,
    error: 'E_PATCH_APPLY_FAILED',
    ...over,
  }
}

describe('createAlwaysAllowPersistQueue', () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty', () => {
    const q = createAlwaysAllowPersistQueue(dir)
    expect(q.listAll()).toEqual([])
    expect(q.listDue()).toEqual([])
  })

  it('enqueue + listAll returns the entry with attempts=1', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const all = q.listAll()
    expect(all).toHaveLength(1)
    expect(all[0].attempts).toBe(1)
    expect(all[0].id).toBe(makeEntryId('clerk', 'Skill(calendar)'))
  })

  it('is idempotent per (agent, rule) — a second failure updates, not duplicates', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs({ error: 'first' }))
    await q.enqueue(baseArgs({ error: 'second' }))
    expect(q.listAll()).toHaveLength(1)
    expect(q.listAll()[0].lastError).toBe('second')
  })

  it('listDue only returns entries whose backoff has elapsed', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const now = Date.now()
    // Not due yet — backoff for attempt 1 is BASE_BACKOFF_MS.
    expect(q.listDue(now)).toEqual([])
    expect(q.listDue(now + BASE_BACKOFF_MS + 1)).toHaveLength(1)
  })

  it('survives reload (boot drain picks up a queued entry after restart)', async () => {
    const q1 = createAlwaysAllowPersistQueue(dir)
    await q1.enqueue(baseArgs())
    const q2 = createAlwaysAllowPersistQueue(dir)
    expect(q2.listAll()).toHaveLength(1)
  })

  it('recordAttempt(success) dequeues', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id
    await q.recordAttempt(id, { success: true })
    expect(q.listAll()).toEqual([])
  })

  it('recordAttempt(failure) increments attempts and pushes nextAttemptAt out', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id
    const before = q.listAll()[0].nextAttemptAt
    await q.recordAttempt(id, { success: false, error: 'boom' })
    const after = q.listAll()[0]
    expect(after.attempts).toBe(2)
    expect(after.nextAttemptAt).toBeGreaterThan(before)
  })

  it('recordAttempt drops the entry once MAX_ATTEMPTS is reached', async () => {
    // enqueue() itself counts as attempt 1 (the original failed dispatch
    // that triggered the enqueue) — so MAX_ATTEMPTS total tries is reached
    // after (MAX_ATTEMPTS - 1) further recordAttempt(failure) calls.
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id
    for (let i = 0; i < MAX_ATTEMPTS - 2; i++) {
      await q.recordAttempt(id, { success: false, error: 'boom' })
    }
    // One more failure reaches attempts===MAX_ATTEMPTS and drops it.
    expect(q.listAll()[0].attempts).toBe(MAX_ATTEMPTS - 1)
    await q.recordAttempt(id, { success: false, error: 'boom' })
    expect(q.listAll()).toEqual([])
  })

  it('honors a structured retryAfterMs floor on backoff', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id
    const now = Date.now()
    await q.recordAttempt(id, { success: false, error: 'rate limited', retryAfterMs: 20 * 60_000 })
    const entry = q.listAll()[0]
    // 20 minutes is bigger than the exponential value at attempt 2, so the
    // hint should win (but never exceed MAX_BACKOFF_MS).
    expect(entry.nextAttemptAt - now).toBeGreaterThanOrEqual(20 * 60_000 - 1000)
    expect(entry.nextAttemptAt - now).toBeLessThanOrEqual(MAX_BACKOFF_MS + 1000)
  })

  it('bounds the queue at MAX_QUEUE_SIZE, dropping the oldest', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    for (let i = 0; i < MAX_QUEUE_SIZE + 5; i++) {
      await q.enqueue(baseArgs({ agentName: `agent${i}`, rule: 'Bash' }))
    }
    expect(q.listAll().length).toBeLessThanOrEqual(MAX_QUEUE_SIZE)
  })

  it('remove() drops an entry outright', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id
    await q.remove(id)
    expect(q.listAll()).toEqual([])
  })

  it('clear() wipes the backing file', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    q.clear()
    expect(q.listAll()).toEqual([])
  })
})

describe('createAlwaysAllowPersistQueue — concurrency (#2973 adversarial review pt.1/pt.3)', () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('two concurrent enqueue() calls for the SAME (agent, rule) race but do not duplicate or corrupt the entry', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    // Fire both "concurrently" — no await between them — simulating two
    // overlapping "Always allow" taps racing against each other, the
    // exact scenario from the original bug report.
    await Promise.all([
      q.enqueue(baseArgs({ error: 'attempt-A' })),
      q.enqueue(baseArgs({ error: 'attempt-B' })),
    ])
    const all = q.listAll()
    // Exactly one entry — never duplicated, never lost.
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(makeEntryId('clerk', 'Skill(calendar)'))
    // One of the two attempts' error message won — not corrupted/merged
    // into something neither caller wrote.
    expect(['attempt-A', 'attempt-B']).toContain(all[0].lastError)
  })

  it('two concurrent enqueue() calls for DIFFERENT rules both land — no lost update', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await Promise.all([
      q.enqueue(baseArgs({ rule: 'Skill(calendar)' })),
      q.enqueue(baseArgs({ rule: 'Skill(email)' })),
      q.enqueue(baseArgs({ rule: 'Bash(ls:*)' })),
    ])
    const all = q.listAll()
    expect(all).toHaveLength(3)
    const rules = all.map(e => e.rule).sort()
    expect(rules).toEqual(['Bash(ls:*)', 'Skill(calendar)', 'Skill(email)'])
  })

  it('many concurrent enqueue() calls interleaved with recordAttempt on an unrelated id never lose an update', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    // Seed one entry to record against concurrently with fresh enqueues —
    // simulates a drain's recordAttempt() racing new "Always allow" taps.
    await q.enqueue(baseArgs({ agentName: 'seed', rule: 'Read' }))
    const seedId = makeEntryId('seed', 'Read')

    const ops: Promise<void>[] = []
    for (let i = 0; i < 10; i++) {
      ops.push(q.enqueue(baseArgs({ agentName: `agent${i}`, rule: 'Bash' })))
    }
    ops.push(q.recordAttempt(seedId, { success: false, error: 'racing' }))

    await Promise.all(ops)

    const all = q.listAll()
    // 10 fresh entries + the seed entry (updated, not dropped/duplicated).
    expect(all).toHaveLength(11)
    const seed = all.find(e => e.id === seedId)
    expect(seed).toBeDefined()
    expect(seed!.attempts).toBe(2)
    expect(seed!.lastError).toBe('racing')
    for (let i = 0; i < 10; i++) {
      expect(all.some(e => e.id === makeEntryId(`agent${i}`, 'Bash'))).toBe(true)
    }
  })

  it('a concurrent enqueue() racing recordAttempt(success) on the SAME id does not resurrect a dequeued entry with corrupted state', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id

    // One racer dequeues via success, the other refreshes via enqueue
    // (e.g. a second failed tap landing right as the drain's redispatch
    // for the SAME rule succeeds). Whichever wins, the on-disk file must
    // stay well-formed and never contain two entries for the same id.
    await Promise.all([
      q.recordAttempt(id, { success: true }),
      q.enqueue(baseArgs({ error: 'second-tap-failure' })),
    ])

    const all = q.listAll()
    const matching = all.filter(e => e.id === id)
    expect(matching.length).toBeLessThanOrEqual(1)
  })
})

/** A `writeFileSync`-shaped fn that runs the real node:fs implementation
 * unless armed via `failNext()` (throws once, then reverts to real writes)
 * or `failAlways()` (throws on every call from here on) — lets a test force
 * writes to fail while everything before/after actually lands on disk. */
function makeControllableWrite() {
  let armedMessage: string | null = null
  let alwaysFail = false
  const fn = ((...args: Parameters<typeof writeFileSync>) => {
    if (alwaysFail) throw new Error(armedMessage ?? 'forced write failure')
    if (armedMessage !== null) {
      const message = armedMessage
      armedMessage = null
      throw new Error(message)
    }
    return writeFileSync(...args)
  }) as typeof writeFileSync
  return {
    fn,
    failNext: (message: string) => { armedMessage = message },
    failAlways: (message: string) => { armedMessage = message; alwaysFail = true },
  }
}

describe('createAlwaysAllowPersistQueue — write failures propagate (#2973 adversarial review pt.2)', () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('enqueue() rejects when the underlying writeFileSync throws (disk full / permissions)', async () => {
    const write = makeControllableWrite()
    const q = createAlwaysAllowPersistQueue(dir, write.fn)
    write.failNext('ENOSPC: no space left on device')
    await expect(q.enqueue(baseArgs())).rejects.toThrow(/ENOSPC/)
    // The caller was told it failed — and indeed nothing was persisted.
    expect(q.listAll()).toEqual([])
  })

  it('recordAttempt() rejects when the underlying writeFileSync throws, and does not pretend the state change landed', async () => {
    const write = makeControllableWrite()
    const q = createAlwaysAllowPersistQueue(dir, write.fn)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id

    write.failNext('EACCES: permission denied')
    await expect(q.recordAttempt(id, { success: true })).rejects.toThrow(/EACCES/)

    // The entry is still there — the (failed) dequeue never actually
    // persisted, so a fresh read must still see it, not silently vanish.
    expect(q.listAll()).toHaveLength(1)
    expect(q.listAll()[0].id).toBe(id)
  })

  it('remove() rejects when the underlying writeFileSync throws', async () => {
    const write = makeControllableWrite()
    const q = createAlwaysAllowPersistQueue(dir, write.fn)
    await q.enqueue(baseArgs())
    const id = q.listAll()[0].id

    write.failNext('EROFS: read-only file system')
    await expect(q.remove(id)).rejects.toThrow(/EROFS/)

    expect(q.listAll()).toHaveLength(1)
  })

  it('a write failure does not wedge the in-process lock — a later successful call still lands', async () => {
    const write = makeControllableWrite()
    const q = createAlwaysAllowPersistQueue(dir, write.fn)
    write.failNext('ENOSPC: no space left on device')
    await expect(q.enqueue(baseArgs({ error: 'first' }))).rejects.toThrow(/ENOSPC/)

    // Disk recovered — the NEXT call (real writeFileSync) must succeed,
    // proving the failed link didn't leave the mutex permanently locked.
    await q.enqueue(baseArgs({ error: 'second' }))
    const all = q.listAll()
    expect(all).toHaveLength(1)
    expect(all[0].lastError).toBe('second')
  })
})

describe('computeBackoffMs / isExhausted — structural bounds', () => {
  it('doubles each attempt, capped at MAX_BACKOFF_MS', () => {
    expect(computeBackoffMs(1)).toBe(BASE_BACKOFF_MS)
    expect(computeBackoffMs(2)).toBe(BASE_BACKOFF_MS * 2)
    expect(computeBackoffMs(3)).toBe(BASE_BACKOFF_MS * 4)
    // Large attempt counts never exceed the ceiling — no unbounded growth.
    expect(computeBackoffMs(50)).toBe(MAX_BACKOFF_MS)
  })

  it('isExhausted trips on attempts>=MAX_ATTEMPTS regardless of age', () => {
    expect(isExhausted({ attempts: MAX_ATTEMPTS, createdAt: Date.now() })).toBe(true)
    expect(isExhausted({ attempts: MAX_ATTEMPTS - 1, createdAt: Date.now() })).toBe(false)
  })

  it('isExhausted trips on age>=MAX_AGE_MS regardless of attempts', () => {
    expect(isExhausted({ attempts: 1, createdAt: Date.now() - MAX_AGE_MS - 1 })).toBe(true)
    expect(isExhausted({ attempts: 1, createdAt: Date.now() })).toBe(false)
  })
})

describe('drainAlwaysAllowPersistQueue', () => {
  let dir: string
  beforeEach(() => { dir = makeTmpDir() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function makeDeps(over: Partial<AlwaysAllowDrainDeps> = {}): AlwaysAllowDrainDeps {
    return {
      readConfigText: () => 'agents:\n  clerk:\n    tools:\n      allow: [Read]\n',
      resolveAllowList: () => ['Read'],
      isRulePersisted: (allow, rule) => allow.includes(rule),
      synthesizeDiff: () => '--- a/switchroom.yaml\n+++ b/switchroom.yaml\n@@ -1 +1,2 @@\n+fake\n',
      dispatchConfigEdit: async () => ({ ok: true }),
      notifyTerminalFailure: vi.fn(),
      ...over,
    }
  }

  it('a retryable failure retries after backoff with a fresh config read and succeeds; entry removed', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const readConfigText = vi.fn(() => 'agents:\n  clerk:\n    tools:\n      allow: [Read]\n')
    const dispatchConfigEdit = vi.fn(async () => ({ ok: true as const }))
    const deps = makeDeps({ readConfigText, dispatchConfigEdit })

    // Not due yet.
    await drainAlwaysAllowPersistQueue(q, deps)
    expect(dispatchConfigEdit).not.toHaveBeenCalled()
    expect(q.listAll()).toHaveLength(1)

    // Force due by rewriting the entry directly via recordAttempt timing —
    // simplest: enqueue fresh with an already-elapsed backoff by manipulating
    // system time isn't available here, so instead verify due-gating via a
    // second queue instance whose entry we mark due by fast-forwarding.
    vi.useFakeTimers()
    vi.advanceTimersByTime(BASE_BACKOFF_MS + 1000)
    await drainAlwaysAllowPersistQueue(q, deps)
    vi.useRealTimers()

    expect(readConfigText).toHaveBeenCalled()
    expect(dispatchConfigEdit).toHaveBeenCalledTimes(1)
    expect(q.listAll()).toEqual([]) // dequeued on success
  })

  it('a retry that finds the rule already persisted is a no-op dequeue (no redispatch)', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs({ rule: 'Read' })) // "Read" will already be in the fresh allow list
    const dispatchConfigEdit = vi.fn(async () => ({ ok: true as const }))
    const deps = makeDeps({
      resolveAllowList: () => ['Read'],
      isRulePersisted: (allow, rule) => allow.includes(rule),
      dispatchConfigEdit,
    })

    vi.useFakeTimers()
    vi.advanceTimersByTime(BASE_BACKOFF_MS + 1000)
    await drainAlwaysAllowPersistQueue(q, deps)
    vi.useRealTimers()

    expect(dispatchConfigEdit).not.toHaveBeenCalled()
    expect(q.listAll()).toEqual([])
  })

  it('a persist that fails MAX_ATTEMPTS times sends the terminal-failure notice exactly once and is dropped', async () => {
    // enqueue() itself counts as attempt 1 (the original failed dispatch
    // that triggered the enqueue) — so the drain loop's dispatchConfigEdit
    // fires (MAX_ATTEMPTS - 1) times before the entry is exhausted/dropped.
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const notifyTerminalFailure = vi.fn()
    const dispatchConfigEdit = vi.fn(async () => ({ ok: false as const, error: 'E_PATCH_APPLY_FAILED' }))
    const deps = makeDeps({
      resolveAllowList: () => [], // rule never lands
      dispatchConfigEdit,
      notifyTerminalFailure,
    })

    vi.useFakeTimers()
    // Drive it through every remaining attempt. Each drain pass needs the
    // fake clock advanced past the current backoff before the entry
    // becomes due again.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      vi.advanceTimersByTime(MAX_BACKOFF_MS + 1000)
      await drainAlwaysAllowPersistQueue(q, deps)
    }
    vi.useRealTimers()

    expect(notifyTerminalFailure).toHaveBeenCalledTimes(1)
    expect(q.listAll()).toEqual([]) // dropped after exhaustion
    expect(dispatchConfigEdit).toHaveBeenCalledTimes(MAX_ATTEMPTS - 1)
  })

  it('never retries indefinitely: attempts and age are both hard bounds (no drain call exceeds MAX_ATTEMPTS-1 dispatches for one entry)', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const dispatchConfigEdit = vi.fn(async () => ({ ok: false as const, error: 'boom' }))
    const deps = makeDeps({ resolveAllowList: () => [], dispatchConfigEdit, notifyTerminalFailure: vi.fn() })

    vi.useFakeTimers()
    // Drain far more times than MAX_ATTEMPTS would allow — dispatch count
    // must plateau, never grow further once the entry is exhausted+dropped.
    for (let i = 0; i < MAX_ATTEMPTS + 10; i++) {
      vi.advanceTimersByTime(MAX_BACKOFF_MS + 1000)
      await drainAlwaysAllowPersistQueue(q, deps)
    }
    vi.useRealTimers()

    expect(dispatchConfigEdit.mock.calls.length).toBe(MAX_ATTEMPTS - 1)
  })

  it('a config read failure is treated as retryable, not a crash', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const deps = makeDeps({
      readConfigText: () => { throw new Error('ENOENT') },
    })

    vi.useFakeTimers()
    vi.advanceTimersByTime(BASE_BACKOFF_MS + 1000)
    await expect(drainAlwaysAllowPersistQueue(q, deps)).resolves.toBeUndefined()
    vi.useRealTimers()

    expect(q.listAll()).toHaveLength(1)
    expect(q.listAll()[0].attempts).toBe(2)
  })

  it('a null re-synthesized diff is treated as retryable, not a crash', async () => {
    const q = createAlwaysAllowPersistQueue(dir)
    await q.enqueue(baseArgs())
    const deps = makeDeps({ synthesizeDiff: () => null })

    vi.useFakeTimers()
    vi.advanceTimersByTime(BASE_BACKOFF_MS + 1000)
    await drainAlwaysAllowPersistQueue(q, deps)
    vi.useRealTimers()

    expect(q.listAll()).toHaveLength(1)
    expect(q.listAll()[0].attempts).toBe(2)
  })

  it('a drain-time write failure on recordAttempt does not crash the pass and other due entries still get processed', async () => {
    const write = makeControllableWrite()
    const q = createAlwaysAllowPersistQueue(dir, write.fn)
    await q.enqueue(baseArgs({ agentName: 'clerk', rule: 'Skill(calendar)' }))
    await q.enqueue(baseArgs({ agentName: 'clerk', rule: 'Skill(email)' }))
    const dispatchConfigEdit = vi.fn(async () => ({ ok: true as const }))
    const deps = makeDeps({ resolveAllowList: () => [], dispatchConfigEdit })

    // Both entries' recordAttempt writes fail — the drain pass must
    // swallow that (log it) rather than throwing out of
    // drainAlwaysAllowPersistQueue and abandoning remaining entries.
    write.failAlways('EIO: i/o error')

    vi.useFakeTimers()
    vi.advanceTimersByTime(BASE_BACKOFF_MS + 1000)
    await expect(drainAlwaysAllowPersistQueue(q, deps)).resolves.toBeUndefined()
    vi.useRealTimers()

    // Both entries were attempted despite the persistent write failure.
    expect(dispatchConfigEdit).toHaveBeenCalledTimes(2)
    // Since the "success" recordAttempt write failed, the entries are
    // still present on next read (state change did NOT silently land).
    expect(q.listAll()).toHaveLength(2)
  })
})
