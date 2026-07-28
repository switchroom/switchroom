/**
 * stale-pin-sweep.test.ts — outcome tests for the stale-pin stack drain.
 *
 * The fake Telegram below models the ONE behaviour that made the previous
 * cleanup a no-op for months: `unpinChatMessage` resolves `{ ok: true }`
 * whether or not it popped anything. Every assertion here is about OBSERVED
 * chat state (`stack`) or about calls that were / were not made — never about
 * an internal code path — so a regression that goes back to trusting the API
 * result fails these tests rather than passing them.
 */

import { describe, expect, it } from 'vitest'
import {
  CIRCUIT_BREAKER_RETRY_AFTER_SEC,
  DM_SWEEP_GATE,
  GROUP_SWEEP_GATE,
  SUPERGROUP_REPIN_UNATTENDED,
  VERIFY_READ_GAP_MS,
  classifyChatForSweep,
  collectSweepTargets,
  createPinOpBudget,
  createStalePinSweeper,
  isNothingToUnpinError,
  isPeerFloodError,
  isPinRightsError,
  mayRepinLoopUnattended,
  retryAfterSeconds,
  unexpiredStoreRepinIds,
  type StalePinSweepDeps,
  type SweepTarget,
} from './stale-pin-sweep.js'
import {
  SWEEP_MAX_ATTEMPTS,
  loadSweepCursors,
  upsertSweepCursor,
  type SweepCursor,
  type SweepStoreFsSeam,
} from './stale-pin-sweep-store.js'

// Synthetic ids (check-no-pii-secrets): DMs positive, groups negative.
const DM = '900000001'
const GROUP = '-1009000000001'

// ─── in-memory durable ledger ────────────────────────────────────────────────

function memFs(): SweepStoreFsSeam & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const v = files.get(p)
      if (v == null) throw new Error(`ENOENT ${p}`)
      return v
    },
    writeFileSync: (p, data) => {
      files.set(p, data)
    },
  }
}

// ─── the fake chat ───────────────────────────────────────────────────────────

interface FakeOpts {
  /** Initial pin stack; index 0 is the TOP (what `getChat` exposes). */
  stack: number[]
  /**
   * THE BUG. When true, `unpinChatMessage` resolves `{ ok: true }` and pops
   * NOTHING — exactly what Telegram does for a stale stack entry.
   */
  unpinIsSilentNoop?: boolean
  /** Errors to throw from `pinChatMessage`, consumed in order. */
  pinErrors?: (unknown | null)[]
  /** Errors to throw from `unpinAllForumTopicMessages`, consumed in order. */
  unpinAllErrors?: (unknown | null)[]
  canPin?: boolean
  /** Throws from `getChat`, consumed in order (null = normal read). */
  getChatErrors?: (unknown | null)[]
}

function fakeChat(o: FakeOpts) {
  const stack = [...o.stack]
  const calls: string[] = []
  const pinErrors = [...(o.pinErrors ?? [])]
  const unpinAllErrors = [...(o.unpinAllErrors ?? [])]
  const getChatErrors = [...(o.getChatErrors ?? [])]
  return {
    stack,
    calls,
    getTopPinnedMessageId: async () => {
      calls.push('getChat')
      const err = getChatErrors.shift()
      if (err != null) throw err
      return stack.length > 0 ? stack[0] : null
    },
    pinSilent: async (_chatId: string, messageId: number) => {
      calls.push(`pin:${messageId}`)
      const err = pinErrors.shift()
      if (err != null) throw err
      const at = stack.indexOf(messageId)
      if (at >= 0) stack.splice(at, 1)
      stack.unshift(messageId)
      return { ok: true }
    },
    unpin: async (_chatId: string, messageId: number) => {
      calls.push(`unpin:${messageId}`)
      // ALWAYS resolves ok:true — the whole point.
      if (o.unpinIsSilentNoop === true) return { ok: true }
      const at = stack.indexOf(messageId)
      if (at >= 0) stack.splice(at, 1)
      return { ok: true }
    },
    unpinAllForumTopicMessages: async (_chatId: string, threadId: number) => {
      calls.push(`unpinAllTopic:${threadId}`)
      const err = unpinAllErrors.shift()
      if (err != null) throw err
      stack.length = 0
      return { ok: true }
    },
    canPinInChat: async () => {
      calls.push('getChatMember')
      return o.canPin !== false
    },
  }
}

interface Harness {
  deps: StalePinSweepDeps
  fake: ReturnType<typeof fakeChat>
  fs: ReturnType<typeof memFs>
  sleeps: number[]
  path: string
  cursors: () => SweepCursor[]
}

function harness(
  o: FakeOpts & {
    /** When false the fake clock does NOT advance on sleep (freezes the
     *  per-minute budget window open, so the budget gate is what binds). */
    clockAdvances?: boolean
    protectedMessageIds?: number[]
    /** Wall-clock ms each fake API call consumes. Real latency is what lets a
     *  long sweep outrun the 60s per-minute window, so the per-CHAT pop cap —
     *  not the per-minute budget — becomes the binding gate. */
    apiLatencyMs?: number
    eligible?: boolean
    allowSupergroupRepinLoop?: boolean
  },
): Harness {
  const fake = fakeChat(o)
  const fs = memFs()
  const path = '/state/stale-pin-sweep.json'
  const sleeps: number[] = []
  let clock = 1_000_000
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const costed = <T extends (...a: any[]) => Promise<any>>(f: T): T =>
    (async (...a: Parameters<T>) => {
      clock += o.apiLatencyMs ?? 0
      return f(...a)
    }) as unknown as T
  const deps: StalePinSweepDeps = {
    getTopPinnedMessageId: costed(fake.getTopPinnedMessageId),
    pinSilent: costed(fake.pinSilent),
    unpin: costed(fake.unpin),
    unpinAllForumTopicMessages: costed(fake.unpinAllForumTopicMessages),
    canPinInChat: costed(fake.canPinInChat),
    protectedMessageIds: () => o.protectedMessageIds ?? [],
    eligible: () => o.eligible !== false,
    sleep: async (ms) => {
      sleeps.push(ms)
      if (o.clockAdvances !== false) clock += ms
    },
    now: () => clock,
    store: { path, fs },
    allowSupergroupRepinLoop: o.allowSupergroupRepinLoop,
    log: () => {},
  }
  return { deps, fake, fs, sleeps, path, cursors: () => loadSweepCursors(path, fs) }
}

const flood = (retryAfter: number) => ({
  error_code: 429,
  description: `Too Many Requests: retry after ${retryAfter}`,
  parameters: { retry_after: retryAfter },
})

// ─── headline: a stacked chat actually drains ───────────────────────────────

describe('stale-pin sweep — draining a stacked chat', () => {
  it('drains a 5-deep DM pin stack to empty and discharges the obligation', async () => {
    const h = harness({ stack: [11, 12, 13, 14, 15] })
    const sweeper = createStalePinSweeper(h.deps)

    const res = await sweeper.sweepTarget({ chatId: DM })

    // The OUTCOME: the chat has no pins left.
    expect(h.fake.stack).toEqual([])
    expect(res.status).toBe('drained')
    expect(res.popped).toBe(5)
    // Each pop really was a re-pin followed by an unpin — a bare unpin does not
    // pop, so a regression to unpin-only would leave the stack non-empty above.
    expect(h.fake.calls.filter((c) => c.startsWith('pin:'))).toHaveLength(5)
    expect(h.fake.calls.filter((c) => c.startsWith('unpin:'))).toHaveLength(5)
    const cursor = h.cursors().find((c) => c.chatId === DM)
    expect(cursor?.done).toBe(true)
    expect(cursor?.popped).toBe(5)
  })

  it('does NOT treat a resolved unpin as a pop — the ok:true silent no-op', async () => {
    // Telegram resolves `{ok:true}` while popping nothing. Code that believes
    // the API result reports `drained` here; code that reads back the chat
    // cannot.
    const h = harness({ stack: [21, 22, 23], unpinIsSilentNoop: true })
    const sweeper = createStalePinSweeper(h.deps)

    const res = await sweeper.sweepTarget({ chatId: DM })

    expect(h.fake.stack).toEqual([21, 22, 23]) // nothing moved, as designed
    expect(res.status).not.toBe('drained')
    expect(res.status).toBe('incomplete')
    expect(res.popped).toBe(0)
    expect(res.detail).toMatch(/no progress/)
    // The obligation stays OWED so the next boot retries.
    const cursor = h.cursors().find((c) => c.chatId === DM)
    expect(cursor?.done).toBe(false)
    expect(cursor?.popped).toBe(0)
  })

  it('never concludes "empty" from a single read — two reads must agree', async () => {
    // First read says 31, second (post-cache) says nothing: disagreement, so
    // the stack state is UNKNOWN and must not be reported drained.
    const h = harness({ stack: [31] })
    let n = 0
    h.deps.getTopPinnedMessageId = async () => {
      n++
      return n === 1 ? 31 : null
    }
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('incomplete')
    expect(res.detail).toMatch(/unverifiable/)
  })

  it('treats a getChat throw as unknown, never as an empty stack', async () => {
    const h = harness({ stack: [41], getChatErrors: [new Error('ETIMEDOUT')] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('incomplete')
    expect(h.fake.stack).toEqual([41])
  })

  it('accepts Telegram\'s honest empty-stack signal from unpin', async () => {
    const h = harness({ stack: [51] })
    h.deps.unpin = async () => {
      throw { error_code: 400, description: 'Bad Request: message to unpin not found' }
    }
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('drained')
  })
})

// ─── rate gates ──────────────────────────────────────────────────────────────

describe('stale-pin sweep — rate gates', () => {
  it('spaces DM writes by DM_SWEEP_GATE.minCallDelayMs', async () => {
    const h = harness({ stack: [61, 62, 63] })
    await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    // Every gap the sweep inserted between two writes is the DM gate's, and it
    // inserted at least one per pop.
    const spacing = h.sleeps.filter((ms) => ms !== VERIFY_READ_GAP_MS)
    expect(spacing.length).toBeGreaterThanOrEqual(3)
    expect(new Set(spacing)).toEqual(new Set([DM_SWEEP_GATE.minCallDelayMs]))
    expect(h.sleeps).not.toContain(GROUP_SWEEP_GATE.minCallDelayMs)
  })

  it('spaces opted-in supergroup writes by the slower GROUP gate', async () => {
    const h = harness({ stack: [71, 72], canPin: true, allowSupergroupRepinLoop: true })
    await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })
    expect(h.sleeps).toContain(GROUP_SWEEP_GATE.minCallDelayMs)
    expect(h.sleeps).not.toContain(DM_SWEEP_GATE.minCallDelayMs)
  })

  it('stops at the per-chat pop cap and yields the remainder to the next boot', async () => {
    const deep = Array.from({ length: DM_SWEEP_GATE.maxPopsPerChatPerSweep + 6 }, (_, i) => 100 + i)
    const h = harness({ stack: deep, apiLatencyMs: 6_000 })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })

    expect(res.status).toBe('deferred-budget')
    expect(res.popped).toBe(DM_SWEEP_GATE.maxPopsPerChatPerSweep)
    expect(h.fake.stack).toHaveLength(6) // exactly the overflow is left
    const cursor = h.cursors().find((c) => c.chatId === DM)
    expect(cursor?.done).toBe(false)
    expect(cursor?.popped).toBe(DM_SWEEP_GATE.maxPopsPerChatPerSweep)
  })

  it('stops at the per-minute bot budget rather than sleeping out the minute', async () => {
    // Clock frozen ⇒ nothing ages out of the 60s window, so the budget binds
    // before the pop cap does.
    const deep = Array.from({ length: 40 }, (_, i) => 200 + i)
    const h = harness({ stack: deep, clockAdvances: false })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })

    expect(res.status).toBe('deferred-budget')
    expect(res.detail).toMatch(/budget/)
    const writes = h.fake.calls.filter((c) => c.startsWith('pin:') || c.startsWith('unpin:'))
    expect(writes).toHaveLength(DM_SWEEP_GATE.maxPinOpsPerMinute)
    // And it did NOT block for a whole minute waiting for the window.
    expect(Math.max(...h.sleeps)).toBeLessThan(60_000)
  })

  it('per-minute budget is per bot across chats, and per class', () => {
    let t = 0
    const budget = createPinOpBudget(() => t)
    for (let i = 0; i < GROUP_SWEEP_GATE.maxPinOpsPerMinute; i++) budget.record('group')
    expect(budget.waitMs('group')).toBeGreaterThan(0)
    expect(budget.waitMs('dm')).toBe(0) // separate class, separate window
    t += 60_000
    expect(budget.waitMs('group')).toBe(0) // window slid
  })
})

// ─── flood / circuit breaker ─────────────────────────────────────────────────

describe('stale-pin sweep — flood waits and the circuit breaker', () => {
  it('gives up after MAX_CONSECUTIVE_FLOOD_WAITS distinct 429s', async () => {
    const h = harness({ stack: [81, 82], pinErrors: [flood(3), flood(5), flood(7)] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('deferred-flood')
    expect(res.popped).toBe(0)
    // It backed off, honouring retry_after then doubling.
    expect(h.sleeps).toContain(3000)
    expect(h.sleeps).toContain(10_000)
  })

  it('gives up on two IDENTICAL retry_after values with zero progress', async () => {
    // The pegged-server signature: same wait handed back forever.
    const h = harness({ stack: [91], pinErrors: [flood(3), flood(3)] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('deferred-flood')
    expect(h.fake.calls.filter((c) => c.startsWith('pin:'))).toHaveLength(2)
  })

  it('trips the breaker on PEER_FLOOD and halts every later target', async () => {
    const h = harness({
      stack: [101],
      pinErrors: [{ error_code: 400, description: 'Bad Request: PEER_FLOOD' }],
    })
    const sweeper = createStalePinSweeper(h.deps)

    const first = await sweeper.sweepTarget({ chatId: DM })
    expect(first.status).toBe('aborted-circuit-breaker')
    expect(sweeper.isCircuitOpen()).toBe(true)

    const before = h.fake.calls.length
    const second = await sweeper.sweepTarget({ chatId: '900000002' })
    expect(second.status).toBe('aborted-circuit-breaker')
    expect(h.fake.calls.length).toBe(before) // zero further API traffic
  })

  it('trips the breaker on a retry_after above the ceiling', async () => {
    const h = harness({
      stack: [111],
      pinErrors: [flood(CIRCUIT_BREAKER_RETRY_AFTER_SEC + 1)],
    })
    const sweeper = createStalePinSweeper(h.deps)
    const res = await sweeper.sweepTarget({ chatId: DM })
    expect(res.status).toBe('aborted-circuit-breaker')
    expect(sweeper.isCircuitOpen()).toBe(true)
  })
})

// ─── forum topics ────────────────────────────────────────────────────────────

describe('stale-pin sweep — forum topics', () => {
  const topic: SweepTarget = { chatId: GROUP, threadId: 77, isForum: true }

  it('drains a topic with ONE topic-scoped unpinAllForumTopicMessages call', async () => {
    const h = harness({ stack: [121, 122, 123] })
    const res = await createStalePinSweeper(h.deps).sweepTarget(topic)

    expect(res.status).toBe('drained')
    expect(h.fake.calls.filter((c) => c === 'unpinAllTopic:77')).toHaveLength(1)
    // No repin loop: a supergroup pin emits a visible service message.
    expect(h.fake.calls.filter((c) => c.startsWith('pin:'))).toHaveLength(0)
    expect(h.fake.stack).toEqual([])
  })

  it('does NOT loop on a 429 from the unpin-all verb', async () => {
    // TDLib re-issues the identical query while !is_final_, so a retry never
    // terminates. One attempt, then defer.
    const h = harness({ stack: [131, 132], unpinAllErrors: [flood(3), flood(3), flood(3)] })
    const res = await createStalePinSweeper(h.deps).sweepTarget(topic)

    expect(res.status).toBe('deferred-flood')
    expect(h.fake.calls.filter((c) => c === 'unpinAllTopic:77')).toHaveLength(1)
    expect(h.sleeps).not.toContain(3000) // it did not even back off — it gave up
  })

  it('falls back to manual-only when a forum chat has no recorded thread', async () => {
    const h = harness({ stack: [141] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP, isForum: true })
    expect(res.status).toBe('skipped-supergroup-manual')
    expect(h.fake.calls.filter((c) => c.startsWith('unpinAllTopic'))).toHaveLength(0)
  })
})

// ─── group safety: rights + service-message spam ─────────────────────────────

describe('stale-pin sweep — group safety', () => {
  it('skips a group without pin rights WITHOUT writing anything', async () => {
    const h = harness({ stack: [151, 152], canPin: false })
    const res = await createStalePinSweeper(h.deps).sweepTarget({
      chatId: GROUP,
      threadId: 5,
      isForum: true,
    })

    expect(res.status).toBe('skipped-no-rights')
    expect(h.fake.calls).toEqual(['getChatMember']) // the precheck and nothing else
    expect(h.fake.stack).toEqual([151, 152])
  })

  it('treats a throwing rights check as "no rights"', async () => {
    const h = harness({ stack: [161] })
    h.deps.canPinInChat = async () => {
      throw new Error('Bad Request: chat not found')
    }
    const res = await createStalePinSweeper(h.deps).sweepTarget({
      chatId: GROUP,
      threadId: 5,
      isForum: true,
    })
    expect(res.status).toBe('skipped-no-rights')
    expect(h.fake.calls).toEqual([])
  })

  it('never repin-loops a non-forum supergroup unattended', async () => {
    const h = harness({ stack: [171, 172, 173] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })

    expect(res.status).toBe('skipped-supergroup-manual')
    expect(h.fake.calls).toEqual([]) // not even a rights probe
    expect(h.fake.stack).toEqual([171, 172, 173])
  })

  it('routes the whole supergroup policy through ONE predicate', () => {
    // Deliberately pinned: if the service-message premise is refuted
    // empirically, flipping SUPERGROUP_REPIN_UNATTENDED to true must be the
    // entire change. DMs and forum topics are never gated by it.
    expect(mayRepinLoopUnattended('dm')).toBe(true)
    expect(mayRepinLoopUnattended('forum-topic')).toBe(true)
    expect(mayRepinLoopUnattended('supergroup')).toBe(SUPERGROUP_REPIN_UNATTENDED)
    // An explicit per-deployment override wins in both directions; undefined
    // means "take the standing policy", which is NOT the same as false.
    expect(mayRepinLoopUnattended('supergroup', true)).toBe(true)
    expect(mayRepinLoopUnattended('supergroup', false)).toBe(false)
    expect(mayRepinLoopUnattended('supergroup', undefined)).toBe(SUPERGROUP_REPIN_UNATTENDED)
  })

  it('drains a non-forum supergroup when the policy is overridden on', async () => {
    const h = harness({ stack: [176, 177], allowSupergroupRepinLoop: true })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })
    expect(res.status).toBe('drained')
    expect(h.fake.stack).toEqual([])
  })

  it('runs a DM sweep with NO rights precheck (getChatMember is meaningless there)', async () => {
    const h = harness({ stack: [181] })
    await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(h.fake.calls).not.toContain('getChatMember')
  })
})

// ─── eligibility + durability ────────────────────────────────────────────────

describe('stale-pin sweep — eligibility and durable resume', () => {
  it('writes nothing when this gateway did not win the startup mutex', async () => {
    const h = harness({ stack: [191, 192], eligible: false })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('skipped-not-eligible')
    expect(h.fake.calls).toEqual([])
    expect(h.fs.files.size).toBe(0)
  })

  it('RESUMES from a persisted cursor after a restart mid-sweep', async () => {
    // Boot 1: budget-capped part way through a deep stack.
    const deep = Array.from({ length: DM_SWEEP_GATE.maxPopsPerChatPerSweep + 3 }, (_, i) => 300 + i)
    const h1 = harness({ stack: deep, apiLatencyMs: 6_000 })
    const first = await createStalePinSweeper(h1.deps).sweepTarget({ chatId: DM })
    expect(first.status).toBe('deferred-budget')
    const carried = h1.cursors().find((c) => c.chatId === DM)
    expect(carried?.popped).toBe(DM_SWEEP_GATE.maxPopsPerChatPerSweep)
    expect(carried?.done).toBe(false)

    // Boot 2: a NEW sweeper over the SAME ledger and the SAME (partly drained)
    // chat. It must finish the remainder and count cumulatively.
    const h2 = harness({ stack: h1.fake.stack, apiLatencyMs: 6_000 })
    h2.fs.files.set(h2.path, h1.fs.files.get(h1.path)!)
    const second = await createStalePinSweeper(h2.deps).sweepTarget({ chatId: DM })

    expect(second.status).toBe('drained')
    expect(h2.fake.stack).toEqual([])
    const final = h2.cursors().find((c) => c.chatId === DM)
    expect(final?.done).toBe(true)
    expect(final?.popped).toBe(DM_SWEEP_GATE.maxPopsPerChatPerSweep + 3)
    expect(final?.attempts).toBe(2)
  })

  it('does not re-drain a discharged obligation', async () => {
    const h = harness({ stack: [201] })
    upsertSweepCursor(h.path, h.fs, {
      chatId: DM,
      kind: 'dm',
      popped: 9,
      done: true,
      attempts: 1,
      updatedAt: 1,
    })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('already-drained')
    expect(h.fake.calls).toEqual([])
  })

  it('forfeits an obligation that has burned its attempt budget', async () => {
    const h = harness({ stack: [211] })
    upsertSweepCursor(h.path, h.fs, {
      chatId: DM,
      kind: 'dm',
      popped: 0,
      done: false,
      attempts: SWEEP_MAX_ATTEMPTS,
      updatedAt: 1,
    })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('forfeited')
    expect(h.fake.calls).toEqual([])
  })

  it('keys the ledger by (chat, thread), not by chat alone', async () => {
    const h = harness({ stack: [] })
    const sweeper = createStalePinSweeper(h.deps)
    await sweeper.sweepTarget({ chatId: GROUP, threadId: 5, isForum: true })
    await sweeper.sweepTarget({ chatId: GROUP, threadId: 9, isForum: true })
    const rows = h.cursors()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.threadId).sort()).toEqual([5, 9])
  })

  it('survives a corrupt ledger by failing open rather than throwing', async () => {
    const h = harness({ stack: [221] })
    h.fs.files.set(h.path, '{ not json')
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('drained')
  })

  it('never lets a failing ledger write break the sweep', async () => {
    const h = harness({ stack: [231, 232] })
    h.fs.writeFileSync = () => {
      throw new Error('EROFS')
    }
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('drained')
    expect(h.fake.stack).toEqual([])
  })
})

// ─── protected pins ──────────────────────────────────────────────────────────

describe('stale-pin sweep — protected pins', () => {
  it('restores deliberately-retained pins after the drain', async () => {
    const h = harness({ stack: [241, 242], protectedMessageIds: [242, 242] })
    await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    // Drained, then the retained id re-pinned exactly once (deduped).
    expect(h.fake.stack).toEqual([242])
    const restorePins = h.fake.calls.slice(h.fake.calls.lastIndexOf('unpin:242') + 1)
    expect(restorePins.filter((c) => c === 'pin:242')).toHaveLength(1)
  })

  it('does not re-pin anything when the sweep wrote nothing', async () => {
    const h = harness({ stack: [251], protectedMessageIds: [251], eligible: false })
    await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(h.fake.calls).toEqual([])
  })
})

// ─── pure helpers ────────────────────────────────────────────────────────────

describe('stale-pin sweep — classification and seeding', () => {
  it('classifies by chat id sign and forum/thread presence', () => {
    expect(classifyChatForSweep({ chatId: DM })).toBe('dm')
    expect(classifyChatForSweep({ chatId: GROUP })).toBe('supergroup')
    expect(classifyChatForSweep({ chatId: GROUP, threadId: 4, isForum: true })).toBe('forum-topic')
    // A thread id without a forum flag is not enough to aim the topic verb.
    expect(classifyChatForSweep({ chatId: GROUP, threadId: 4 })).toBe('supergroup')
    expect(classifyChatForSweep({ chatId: GROUP, isForum: true })).toBe('supergroup')
  })

  it('dedupes seed targets on the FULL (chat, thread) key', () => {
    const targets = collectSweepTargets({
      statusPins: [
        { chatId: GROUP, threadId: 5 },
        { chatId: GROUP, threadId: 9 },
        { chatId: GROUP, threadId: 5 },
      ],
      activityCards: [{ chatId: GROUP, threadId: null }, { chatId: DM }],
      queuedCards: [{ chatId: '' }],
    })
    expect(targets).toEqual([
      { chatId: GROUP, threadId: 5 },
      { chatId: GROUP, threadId: 9 },
      { chatId: GROUP, threadId: undefined },
      { chatId: DM, threadId: undefined },
    ])
  })

  it('protects only unexpired time-scoped rows in the same chat', () => {
    const now = 1_000
    expect(
      unexpiredStoreRepinIds(
        [
          { chatId: DM, messageId: 1, expiresAt: now + 10 },
          { chatId: DM, messageId: 2, expiresAt: now - 10 },
          { chatId: DM, messageId: 3 },
          { chatId: GROUP, messageId: 4, expiresAt: now + 10 },
        ],
        DM,
        now,
      ),
    ).toEqual([1])
  })

  it('recognises the Telegram error shapes it branches on', () => {
    expect(retryAfterSeconds(flood(7))).toBe(7)
    expect(retryAfterSeconds({ error_code: 429, description: 'retry after 4' })).toBe(4)
    expect(retryAfterSeconds(new Error('nope'))).toBeNull()
    expect(isPeerFloodError({ description: 'Bad Request: PEER_FLOOD' })).toBe(true)
    expect(
      isPinRightsError({
        description: 'Bad Request: not enough rights to manage pinned messages in the chat',
      }),
    ).toBe(true)
    expect(isNothingToUnpinError({ description: 'Bad Request: message to unpin not found' })).toBe(
      true,
    )
    expect(isNothingToUnpinError(new Error('something else'))).toBe(false)
  })
})
