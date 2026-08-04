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
  UNPIN_ALL_FORUM_TOPIC_ENABLED,
  VERIFY_READ_GAP_MS,
  classifyChatForSweep,
  collectSweepTargets,
  createPinOpBudget,
  createStalePinSweeper,
  isNothingToUnpinError,
  isPeerFloodError,
  isPinRightsError,
  mayUnpinAllForumTopic,
  retryAfterSeconds,
  unexpiredStoreRepinIds,
  type StalePinSweepDeps,
  type SweepTarget,
} from './stale-pin-sweep.js'
import {
  SWEEP_MAX_ATTEMPTS,
  loadSweepCursors,
  pruneSweepCursors,
  reseedSweepLedger,
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
  /**
   * Ids `unpinAllForumTopicMessages` removes. Undefined = the whole stack.
   *
   * The verb is TOPIC-scoped while `getChat` exposes the CHAT-wide top, so a
   * successful topic drain routinely leaves pins belonging to other topics —
   * including the one on top — untouched. That is exactly the case where a
   * call-counted `popped` and an observation-counted `popped` disagree.
   */
  unpinAllTopicRemoves?: number[]
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
      if (o.unpinAllTopicRemoves == null) {
        stack.length = 0
      } else {
        for (const id of o.unpinAllTopicRemoves) {
          const at = stack.indexOf(id)
          if (at >= 0) stack.splice(at, 1)
        }
      }
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
    allowUnpinAllForumTopic?: boolean
    /** Ids the gateway is on record as having pinned (the group drain's list). */
    recordedPinIds?: number[]
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
    recordedPinIds: () => o.recordedPinIds ?? [],
    eligible: () => o.eligible !== false,
    sleep: async (ms) => {
      sleeps.push(ms)
      if (o.clockAdvances !== false) clock += ms
    },
    now: () => clock,
    store: { path, fs },
    allowUnpinAllForumTopic: o.allowUnpinAllForumTopic,
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

  it('never concludes "empty" from a single read — a flapping chat is unknown', async () => {
    // getChat never settles: 31 / null / 31 / null … No two consecutive reads
    // agree, so the stack state is UNKNOWN and must not be reported drained.
    const h = harness({ stack: [31] })
    let n = 0
    h.deps.getTopPinnedMessageId = async () => {
      n++
      return n % 2 === 1 ? 31 : null
    }
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('incomplete')
    expect(res.detail).toMatch(/unverifiable/)
  })

  it('does NOT terminate on the transient `pinned_message: None` lie', async () => {
    // MEASURED (2026-07-29): right after an unpin, getChat briefly reports NO
    // pinned message on a stack that is NOT empty — at ~0.15s it read None, at
    // ~0.55s and after it read the next real pin. The transient value is the
    // EMPTY one, so a loop that stops at the first None orphans the rest of the
    // stack. Here read #2 lies; the drain must keep going and finish the stack.
    const h = harness({ stack: [61, 62, 63] })
    let n = 0
    const honest = h.deps.getTopPinnedMessageId
    h.deps.getTopPinnedMessageId = async (chatId) => {
      n++
      if (n === 2) return null // the lie, mid-verification
      return honest(chatId)
    }
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('drained')
    expect(res.popped).toBe(3)
    expect(h.fake.stack).toEqual([])
  })

  it('treats a getChat throw as unknown, never as an empty stack', async () => {
    const h = harness({ stack: [41], getChatErrors: [new Error('ETIMEDOUT')] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('incomplete')
    expect(h.fake.stack).toEqual([41])
  })

  it('does not lose an unpin that landed after the verifying read went dark (#3956)', async () => {
    // Sequence: read/read agree on 61 → repin 61 → unpin 61 (it really pops) →
    // the read that WOULD have verified it throws, so the sweep exits early.
    //
    // `popped` must stay 0 — the module never credits an unobserved pop — but
    // the removal must not vanish from the accounting either: it is reported as
    // one `issued`, which is what makes the ledger's "went out, unverified"
    // figure honest instead of silently short by one.
    const h = harness({ stack: [61, 62], getChatErrors: [null, null, new Error('ETIMEDOUT')] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })

    expect(res.status).toBe('incomplete')
    // The pop DID happen in the chat — this is not a hypothetical loss.
    expect(h.fake.stack).toEqual([62])
    expect(res.popped).toBe(0)
    expect(res.issued).toBe(1)
  })

  it('reports issued alongside popped on a clean DM drain', async () => {
    const h = harness({ stack: [71, 72] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })
    expect(res.status).toBe('drained')
    expect(res.popped).toBe(2)
    expect(res.issued).toBe(2)
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

  it('spaces supergroup writes by the slower GROUP gate', async () => {
    const h = harness({ stack: [71, 72], canPin: true, recordedPinIds: [71, 72] })
    await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })
    expect(h.sleeps).toContain(GROUP_SWEEP_GATE.minCallDelayMs)
    expect(h.sleeps).not.toContain(DM_SWEEP_GATE.minCallDelayMs)
  })

  it('has NO per-chat pop ceiling in a group — the id list is the bound', async () => {
    // The old 10-pop group ceiling existed to ration visible service messages.
    // Measured: unpinning is silent, so there is nothing to ration and a deep
    // group stack must drain in ONE sweep rather than dribbling over 3 boots.
    expect(GROUP_SWEEP_GATE.maxPopsPerChatPerSweep).toBe(Number.POSITIVE_INFINITY)
    const ids = Array.from({ length: 25 }, (_, i) => 700 + i)
    const h = harness({ stack: ids, canPin: true, recordedPinIds: ids, apiLatencyMs: 6_000 })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })

    expect(res.status).toBe('drained')
    expect(h.fake.stack).toEqual([])
    expect(h.fake.calls.filter((c) => c.startsWith('unpin:'))).toHaveLength(25)
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

  it('does NOT use the wholesale topic drain by default — it would take other pins', async () => {
    // MEASURED: the unpin-all family destroyed a pre-existing pin the gateway
    // never placed. 122 here is a third party's. The routine sweep must unpin
    // ONLY the recorded ids and leave 122 alone.
    const h = harness({ stack: [121, 122, 123], recordedPinIds: [121, 123] })
    const res = await createStalePinSweeper(h.deps).sweepTarget(topic)

    expect(h.fake.calls.filter((c) => c.startsWith('unpinAllTopic'))).toHaveLength(0)
    expect(h.fake.stack).toEqual([122]) // the stranger's pin survives
    expect(res.status).toBe('drained')
    expect(res.issued).toBe(2)
  })

  it('uses the wholesale topic drain ONLY when explicitly opted in', async () => {
    const h = harness({ stack: [121, 122, 123], allowUnpinAllForumTopic: true })
    const res = await createStalePinSweeper(h.deps).sweepTarget(topic)

    expect(res.status).toBe('drained')
    expect(h.fake.calls.filter((c) => c === 'unpinAllTopic:77')).toHaveLength(1)
    // Still no repin: a pin is the one group op that emits a service message.
    expect(h.fake.calls.filter((c) => c.startsWith('pin:'))).toHaveLength(0)
    expect(h.fake.stack).toEqual([])
  })

  it('does NOT loop on a 429 from the unpin-all verb', async () => {
    // TDLib re-issues the identical query while !is_final_, so a retry never
    // terminates. One attempt, then defer.
    const h = harness({
      stack: [131, 132],
      allowUnpinAllForumTopic: true,
      unpinAllErrors: [flood(3), flood(3), flood(3)],
    })
    const res = await createStalePinSweeper(h.deps).sweepTarget(topic)

    expect(res.status).toBe('deferred-flood')
    expect(h.fake.calls.filter((c) => c === 'unpinAllTopic:77')).toHaveLength(1)
    expect(h.sleeps).not.toContain(3000) // it did not even back off — it gave up
  })

  it('credits the wholesale drain a POP only when the observed top moved (#3955)', async () => {
    // A real, ordinary shape: the topic drain clears THIS topic's pins (202)
    // while the chat-wide top (201) belongs to another topic and survives. The
    // obligation IS discharged, but nothing observable moved — so this is one
    // `issued`, zero `popped`. Counting the call as a pop would give the forum
    // branch a different meaning for `popped` than every other branch has.
    const h = harness({
      stack: [201, 202],
      allowUnpinAllForumTopic: true,
      unpinAllTopicRemoves: [202],
    })
    const res = await createStalePinSweeper(h.deps).sweepTarget(topic)

    expect(h.fake.calls.filter((c) => c === 'unpinAllTopic:77')).toHaveLength(1)
    expect(res.status).toBe('drained')
    expect(res.issued).toBe(1)
    expect(res.popped).toBe(0)
    // …and the durable counter did not inherit the call count either.
    expect(h.cursors()[0].popped).toBe(0)
  })

  it('credits the wholesale drain a pop when the top DID move', async () => {
    const h = harness({ stack: [211, 212], allowUnpinAllForumTopic: true })
    const res = await createStalePinSweeper(h.deps).sweepTarget(topic)

    expect(h.fake.stack).toEqual([])
    expect(res.status).toBe('drained')
    expect(res.issued).toBe(1)
    expect(res.popped).toBe(1)
    expect(h.cursors()[0].popped).toBe(1)
  })

  it('routes the wholesale-drain policy through ONE predicate', () => {
    // Deliberately pinned: the destructive remedy is opt-in in exactly one
    // place, and no chat class reaches it implicitly.
    expect(mayUnpinAllForumTopic('dm')).toBe(false)
    expect(mayUnpinAllForumTopic('supergroup')).toBe(false)
    expect(mayUnpinAllForumTopic('forum-topic')).toBe(UNPIN_ALL_FORUM_TOPIC_ENABLED)
    // An explicit per-deployment override wins; undefined means "take the
    // standing policy", which is NOT the same as false.
    expect(mayUnpinAllForumTopic('forum-topic', true)).toBe(true)
    expect(mayUnpinAllForumTopic('forum-topic', false)).toBe(false)
    expect(mayUnpinAllForumTopic('forum-topic', undefined)).toBe(UNPIN_ALL_FORUM_TOPIC_ENABLED)
    // Even opted in, it is topic-scoped only — a chat-wide unpin-all is never
    // reachable from any input.
    expect(mayUnpinAllForumTopic('supergroup', true)).toBe(false)
  })

  it('sweeps a forum chat with no recorded thread as an ordinary group', async () => {
    const h = harness({ stack: [141, 142], recordedPinIds: [141] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP, isForum: true })
    expect(res.status).toBe('drained')
    expect(h.fake.calls.filter((c) => c.startsWith('unpinAllTopic'))).toHaveLength(0)
    expect(h.fake.stack).toEqual([142])
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

  it('NEVER pins in a group — a pin is the only op that emits a service message', async () => {
    // MEASURED id-gap probe: control 1, pin 2 (with and without
    // disable_notification), every unpin verb 1. So the group drain must be
    // unpin-only, and the DM-style repin loop must not be reachable here.
    const h = harness({ stack: [171, 172, 173], recordedPinIds: [171, 172, 173] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })

    expect(res.status).toBe('drained')
    expect(h.fake.stack).toEqual([])
    expect(h.fake.calls.filter((c) => c.startsWith('pin:'))).toEqual([])
  })

  it('unpins a recorded id from the MIDDLE of the stack without a repin', async () => {
    // MEASURED: targeted unpin works at ANY stack position in a group — an
    // entry third from the top vanished from the middle.
    const h = harness({ stack: [174, 175, 176], recordedPinIds: [176] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })

    expect(h.fake.calls.filter((c) => c.startsWith('unpin:'))).toEqual(['unpin:176'])
    expect(h.fake.stack).toEqual([174, 175])
    expect(res.issued).toBe(1)
  })

  it('does nothing at all in a group with no recorded pin ids', async () => {
    // The gateway only removes pins it placed. With no record there is no safe
    // action — an unpin-all would take the strangers' pins with it.
    const h = harness({ stack: [178, 179], recordedPinIds: [] })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })

    expect(res.status).toBe('skipped-nothing-recorded')
    expect(h.fake.calls.filter((c) => c.startsWith('unpin'))).toEqual([])
    expect(h.fake.stack).toEqual([178, 179])
  })

  it('does not report a group drained when a recorded pin survives on top', async () => {
    // The ok:true silent no-op, observed in a supergroup too.
    const h = harness({ stack: [180], recordedPinIds: [180], unpinIsSilentNoop: true })
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: GROUP })

    expect(res.status).toBe('incomplete')
    expect(res.popped).toBe(0)
    expect(h.cursors().find((c) => c.chatId === GROUP)?.done).toBe(false)
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

  it('RESUMES a group drain at the next unpinned id, never re-issuing one', async () => {
    // Clock frozen ⇒ the 60s window never ages, so the per-minute budget binds
    // part way through the id list and the boot must yield with a cursor that
    // records exactly which ids are already done.
    const ids = Array.from({ length: GROUP_SWEEP_GATE.maxPinOpsPerMinute + 4 }, (_, i) => 400 + i)
    const h1 = harness({ stack: ids, recordedPinIds: ids, clockAdvances: false })
    const first = await createStalePinSweeper(h1.deps).sweepTarget({ chatId: GROUP })

    expect(first.status).toBe('deferred-budget')
    expect(first.issued).toBe(GROUP_SWEEP_GATE.maxPinOpsPerMinute)
    const carried = h1.cursors().find((c) => c.chatId === GROUP)
    expect(carried?.done).toBe(false)
    expect(carried?.doneIds).toEqual(ids.slice(0, GROUP_SWEEP_GATE.maxPinOpsPerMinute))

    // Boot 2 over the SAME ledger and the SAME partly-drained chat.
    const h2 = harness({ stack: h1.fake.stack, recordedPinIds: ids })
    h2.fs.files.set(h2.path, h1.fs.files.get(h1.path)!)
    const second = await createStalePinSweeper(h2.deps).sweepTarget({ chatId: GROUP })

    expect(second.status).toBe('drained')
    expect(second.issued).toBe(4) // ONLY the remainder — no id is unpinned twice
    expect(h2.fake.calls.filter((c) => c.startsWith('unpin:'))).toHaveLength(4)
    expect(h2.fake.stack).toEqual([])
    expect(h2.cursors().find((c) => c.chatId === GROUP)?.done).toBe(true)
  })

  it('attempts a target AT MOST ONCE per process, however often it is called', async () => {
    // The lazy first-inbound caller fires on EVERY inbound. A target whose
    // drain did not finish must not be re-attempted per message: that burns the
    // 8-boot attempt budget in 8 messages and hammers the flood ledger.
    const h = harness({ stack: [261, 262, 263], unpinIsSilentNoop: true })
    const sweeper = createStalePinSweeper(h.deps)

    const first = await sweeper.sweepTarget({ chatId: DM })
    expect(first.status).toBe('incomplete')
    const callsAfterFirst = h.fake.calls.length

    for (let i = 0; i < 12; i++) {
      expect((await sweeper.sweepTarget({ chatId: DM })).status).toBe('already-attempted')
    }
    expect(h.fake.calls.length).toBe(callsAfterFirst) // zero further API traffic
    expect(h.cursors().find((c) => c.chatId === DM)?.attempts).toBe(1)
  })

  it('coalesces concurrent callers for the same target onto one drain', async () => {
    const h = harness({ stack: [271, 272] })
    const sweeper = createStalePinSweeper(h.deps)
    const [a, b] = await Promise.all([
      sweeper.sweepTarget({ chatId: DM }),
      sweeper.sweepTarget({ chatId: DM }),
    ])
    expect(a).toBe(b) // literally the same promise result
    expect(h.fake.calls.filter((c) => c.startsWith('pin:'))).toHaveLength(2)
  })

  it('an ineligible call does not consume the one allowed attempt', async () => {
    // The lazy first-inbound path can fire before the startup mutex is won; the
    // boot sweep must still get its turn afterwards.
    let eligible = false
    const h = harness({ stack: [281] })
    h.deps.eligible = () => eligible
    const sweeper = createStalePinSweeper(h.deps)

    expect((await sweeper.sweepTarget({ chatId: DM })).status).toBe('skipped-not-eligible')
    eligible = true
    expect((await sweeper.sweepTarget({ chatId: DM })).status).toBe('drained')
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

  it('still honours an obligation written by a NEWER build (#3957)', async () => {
    // Downgrade case. A ledger the running build does not recognise must not be
    // silently thrown away: for an obligation ledger, "discard" means "forget
    // an obligation", which re-creates the orphan the sweep exists to clear.
    // Here the newer build already discharged this target — a version-
    // intolerant reader would re-drain a chat it had no business touching.
    const h = harness({ stack: [241] })
    h.fs.files.set(
      h.path,
      JSON.stringify({
        v: 99,
        cursors: [
          {
            chatId: DM,
            kind: 'dm',
            popped: 3,
            done: true,
            attempts: 1,
            updatedAt: 1,
            futureFieldFromV99: 'x',
          },
        ],
      }),
    )
    const res = await createStalePinSweeper(h.deps).sweepTarget({ chatId: DM })

    expect(res.status).toBe('already-drained')
    expect(h.fake.calls.filter((c) => c.startsWith('unpin:'))).toHaveLength(0)
    expect(h.fake.stack).toEqual([241])
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

  it('dedupes seed targets on the FULL (chat, thread) key and carries their ids', () => {
    const targets = collectSweepTargets({
      statusPins: [
        { chatId: GROUP, threadId: 5, messageId: 501 },
        { chatId: GROUP, threadId: 9, messageId: 901 },
        { chatId: GROUP, threadId: 5, messageId: 502 },
        { chatId: GROUP, threadId: 5, messageId: 501 },
      ],
      activityCards: [
        // Pinned ⇒ on the stack ⇒ its id joins the unpin list.
        { chatId: GROUP, threadId: null, activityMessageId: 601, pinned: true },
        // NOT pinned ⇒ never on the stack ⇒ its id must NOT be unpinned.
        { chatId: DM, activityMessageId: 602 },
      ],
      queuedCards: [{ chatId: '' }],
    })
    expect(targets).toEqual([
      { chatId: GROUP, threadId: 5, messageIds: [501, 502] },
      { chatId: GROUP, threadId: 9, messageIds: [901] },
      { chatId: GROUP, threadId: undefined, messageIds: [601] },
      { chatId: DM, threadId: undefined, messageIds: [] },
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

// ─── #3953: the boot-seed prune reseeds a discharged obligation ───────────────
//
// Regression #3953 replaced the per-boot DM self-heal with a cursor-gated stack
// drain, but the boot "seed pass" that clears discharged cursors was never
// wired — so `done:true` was effectively PERMANENT and every later boot /
// first-inbound sweep short-circuited on `already-drained`, orphaning any pin
// that leaked AFTER the first drain. These tests pin the reseed contract:
//   1. `pruneSweepCursors` drops `done` rows ONLY and RETAINS forfeited
//      (attempts-exhausted) rows — a store-level test that FAILS on the pre-fix
//      filter (which also dropped forfeited rows, re-burning the attempt budget
//      every boot = flood risk).
//   2. Running that prune between two fresh-process sweeps re-arms the drain, so
//      a pin leaked after a prior discharge is reaped — for a DM AND a
//      supergroup (channel-class) target alike.

/** The boot-seed reseed exactly as the gateway wires it (`gateway.ts`
 *  `seedPruneSweepCursors` → `reseedSweepLedger`). */
function bootSeedPrune(fs: SweepStoreFsSeam, path: string): void {
  reseedSweepLedger(path, fs, () => {})
}

/** A sweeper over a SHARED durable store — a distinct instance models a fresh
 *  process (reboot), so the only state carried across is the on-disk ledger. */
function sweeperOver(
  fs: SweepStoreFsSeam,
  path: string,
  fake: ReturnType<typeof fakeChat>,
  opts: { recordedPinIds?: number[] } = {},
) {
  let clock = 1_000_000
  const deps: StalePinSweepDeps = {
    getTopPinnedMessageId: fake.getTopPinnedMessageId,
    pinSilent: fake.pinSilent,
    unpin: fake.unpin,
    unpinAllForumTopicMessages: fake.unpinAllForumTopicMessages,
    canPinInChat: fake.canPinInChat,
    protectedMessageIds: () => [],
    recordedPinIds: () => opts.recordedPinIds ?? [],
    eligible: () => true,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    store: { path, fs },
    log: () => {},
  }
  return createStalePinSweeper(deps)
}

describe('pruneSweepCursors — boot-seed reseed (#3953)', () => {
  const now = 1_000_000

  it('drops discharged rows but RETAINS forfeited (attempts-exhausted) rows', () => {
    const discharged: SweepCursor = {
      chatId: DM,
      kind: 'dm',
      popped: 3,
      done: true,
      attempts: 1,
      updatedAt: now,
    }
    // A no-rights group that spent its whole attempt budget: `done` is false,
    // but re-seeding it would re-burn all 8 attempts on the NEXT boot, and every
    // boot after — the exact Telegram flood the attempt cap exists to stop.
    const forfeited: SweepCursor = {
      chatId: GROUP,
      kind: 'supergroup',
      popped: 0,
      done: false,
      attempts: SWEEP_MAX_ATTEMPTS,
      lastStatus: 'skipped-no-rights',
      updatedAt: now,
    }
    const stillOwed: SweepCursor = {
      chatId: '900000002',
      kind: 'dm',
      popped: 0,
      done: false,
      attempts: 2,
      updatedAt: now,
    }

    const keys = pruneSweepCursors([discharged, forfeited, stillOwed]).map((c) => c.chatId)

    expect(keys).not.toContain(DM) // discharged → reseeded (dropped)
    expect(keys).toContain(GROUP) // forfeited no-rights → RETAINED (no re-burn)
    expect(keys).toContain('900000002') // still owed → retained untouched
  })

  it('clears discharged rows for EVERY surface — dm, forum-topic, supergroup', () => {
    // The prune must be kind-agnostic: a stuck `done` on a topic or a channel is
    // the same regression as on a DM, so none may be left short-circuiting.
    const rows: SweepCursor[] = [
      { chatId: '1', kind: 'dm', popped: 1, done: true, attempts: 1, updatedAt: now },
      { chatId: '2', kind: 'forum-topic', threadId: 5, popped: 1, done: true, attempts: 1, updatedAt: now },
      { chatId: '3', kind: 'supergroup', popped: 1, done: true, attempts: 1, updatedAt: now },
    ]
    expect(pruneSweepCursors(rows)).toEqual([])
  })
})

describe('stale-pin sweep — re-drain after the boot-seed prune (#3953)', () => {
  it('re-drains a DM whose obligation was discharged in a prior session', async () => {
    const fs = memFs()
    const path = '/state/stale-pin-sweep.json'

    // Session 1: an orphan bot pin is drained and the obligation discharged.
    const s1 = await sweeperOver(fs, path, fakeChat({ stack: [11] })).sweepTarget({ chatId: DM })
    expect(s1.status).toBe('drained')
    expect(loadSweepCursors(path, fs).find((c) => c.chatId === DM)?.done).toBe(true)

    // A NEW orphan pin leaks in after that drain.
    // Fresh process, no prune: the sweep short-circuits on the stale `done` —
    // the #3953 regression, verbatim. The orphan is left pinned.
    const stuckChat = fakeChat({ stack: [99] })
    const stuck = await sweeperOver(fs, path, stuckChat).sweepTarget({ chatId: DM })
    expect(stuck.status).toBe('already-drained')
    expect(stuck.popped).toBe(0)
    expect(stuckChat.stack).toEqual([99])

    // Reboot WITH the boot-seed prune: the discharged row is reseeded, so the
    // next sweep re-evaluates the chat LIVE and reaps the orphan.
    bootSeedPrune(fs, path)
    const rebootChat = fakeChat({ stack: [99] })
    const redrain = await sweeperOver(fs, path, rebootChat).sweepTarget({ chatId: DM })
    expect(redrain.status).toBe('drained')
    expect(redrain.popped).toBe(1)
    expect(rebootChat.stack).toEqual([])
  })

  it('re-drains a supergroup (channel-class) discharged in a prior session', async () => {
    const fs = memFs()
    const path = '/state/stale-pin-sweep.json'

    // Session 1: the one recorded orphan is reaped, obligation discharged.
    const s1 = await sweeperOver(fs, path, fakeChat({ stack: [77], canPin: true }), {
      recordedPinIds: [77],
    }).sweepTarget({ chatId: GROUP })
    expect(s1.status).toBe('drained')
    expect(loadSweepCursors(path, fs).find((c) => c.chatId === GROUP)?.done).toBe(true)

    // A fresh recorded orphan leaks in; a fresh process short-circuits on `done`.
    const stuckChat = fakeChat({ stack: [88], canPin: true })
    const stuck = await sweeperOver(fs, path, stuckChat, { recordedPinIds: [88] }).sweepTarget({
      chatId: GROUP,
    })
    expect(stuck.status).toBe('already-drained')
    expect(stuckChat.stack).toEqual([88])

    // Reboot + prune: the supergroup row is reseeded and re-swept.
    bootSeedPrune(fs, path)
    const rebootChat = fakeChat({ stack: [88], canPin: true })
    const redrain = await sweeperOver(fs, path, rebootChat, { recordedPinIds: [88] }).sweepTarget({
      chatId: GROUP,
    })
    expect(redrain.status).toBe('drained')
    expect(rebootChat.stack).toEqual([])
  })
})
