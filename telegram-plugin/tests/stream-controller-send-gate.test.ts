/**
 * Integration tests: `createStreamController` driven through a REAL
 * `createSendGate` (#3110).
 *
 * Production wires stream-controller's `retry` to the gateway's
 * `robustApiCall`, which is the send gate wrapped over the retry policy —
 * so what the gate does to the opts a call site passes IS the production
 * behavior. Before #3110 the controller passed only `{ threadId, chat_id }`,
 * the gate saw ordinary sends, and the draft stream's own 400 ms DM throttle
 * drove same-message editMessageText straight past the >=1.5s per-message
 * edit floor — the #1 documented flood-ban trigger (part3-design §4;
 * production ~6h ban 2026-07-12).
 *
 * These tests pin the wiring end to end:
 *   - draft edits inside the floor never reach the API; intermediates
 *     collapse; the latest snapshot lands floor-paced
 *   - the floor is per-message (stream A does not delay stream B)
 *   - the gate's no-op skip drops a repeat payload for the same message
 *   - an open flood window sheds draft edits with ZERO API calls, and the
 *     stream recovers with full state after the window closes
 *   - a shed draft is NOT recorded as delivered — a later flush of the
 *     SAME text (the completed answer) still lands
 *   - the finalize flush is `critical`: never shed; waits out a short
 *     window; fails fast (structured, logged) on a long one
 *   - regression pin: the controller passes messageId / editPayload /
 *     priorityClass through the retry policy on every edit
 *
 * Two clocks, deliberately separate: vitest fake timers drive draft-stream's
 * internal `setTimeout` throttle (only `setTimeout`/`clearTimeout` are faked
 * so the gate's microtask pump below stays real); the gate runs on the same
 * injectable fake `Clock` used by send-gate.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStreamController, type RetryPolicy } from '../stream-controller.js'
import { createSendGate, type Clock, type SendGateConfig } from '../send-gate.js'
import { isFloodWaitActiveError } from '../retry-api-call.js'
import { createMockBot, installBotResetHook } from './bot-api.harness.js'

/** Deterministic fake clock — same contract as send-gate.test.ts's. */
class FakeClock implements Clock {
  private cur = 0
  private seq = 0
  private timers: { at: number; id: number; resolve: () => void }[] = []

  now(): number {
    return this.cur
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.cur + ms, id: this.seq++, resolve })
    })
  }

  async advance(ms: number): Promise<void> {
    const target = this.cur + ms
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const t = due[0]
      this.timers = this.timers.filter((x) => x !== t)
      this.cur = t.at
      t.resolve()
      await flush()
    }
    this.cur = target
  }
}

/** Flush pending microtasks via a REAL macrotask hop (setImmediate is not faked). */
function flush(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r))
}

/** A real send gate on a fake clock, exposed as a stream-controller RetryPolicy. */
function makeGatedRetry(cfg: Partial<SendGateConfig> = {}) {
  const clock = new FakeClock()
  const gate = createSendGate({ enabled: true, clock, jitter: () => 0, ...cfg })
  const retry: RetryPolicy = (fn, opts) => gate.gate(fn, opts)
  return { clock, gate, retry }
}

describe('stream-controller × send gate (#3110)', () => {
  const bot = createMockBot()
  installBotResetHook(bot)

  // Fake ONLY draft-stream's throttle timers. The gate's fake clock is
  // driven explicitly; its microtask pump (setImmediate) must stay real.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  /** Release draft-stream's local throttle, then settle microtasks. */
  async function tick(throttleMs = 250): Promise<void> {
    vi.advanceTimersByTime(throttleMs)
    await flush()
  }

  const editBodies = () =>
    bot.api.editMessageText.mock.calls.map(([, , text]) =>
      typeof text === 'object' && text != null ? text.markdown : text,
    )

  it('draft edits inside the floor never hit the API; intermediates collapse; latest lands floor-paced', async () => {
    const { clock, retry } = makeGatedRetry({ editFloorMs: 1500 })
    // Record the FAKE-clock time of every editMessageText that reaches the API.
    const editTimes: number[] = []
    bot.api.editMessageText.mockImplementation(async () => {
      editTimes.push(clock.now())
      return true as const
    })
    const stream = createStreamController({ bot, chatId: '1', throttleMs: 250, retry })

    // Anchor send, then the first edit — no prior edit on the message, so the
    // gate admits it immediately.
    void stream.update('draft 1')
    await flush()
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1)
    void stream.update('draft 2')
    await tick()
    expect(editBodies()).toEqual(['draft 2'])

    // Three rapid snapshots inside the 1.5s floor: d3 reaches the gate (edit
    // floor holds it); d4 and d5 arrive while that edit is in flight, so
    // draft-stream's own last-write-wins collapses d4 — it must NEVER reach
    // the API.
    void stream.update('draft 3')
    await tick()
    void stream.update('draft 4')
    void stream.update('draft 5')
    await flush()
    // Still inside the floor: nothing new hit the API.
    expect(editBodies()).toEqual(['draft 2'])

    await clock.advance(1500) // floor clears → d3 lands; d5 flushes into the gate
    await clock.advance(1500) // next floor clears → d5 lands
    expect(editBodies()).toEqual(['draft 2', 'draft 3', 'draft 5'])
    // Wire spacing is the gate floor, not the 250 ms local throttle.
    expect(editTimes).toEqual([0, 1500, 3000])
  })

  it('the edit floor is per-message: stream B is not delayed by stream A holding its floor', async () => {
    const { clock, retry } = makeGatedRetry({ editFloorMs: 1500 })
    const editTimes = new Map<number, number[]>()
    bot.api.editMessageText.mockImplementation(async (_chat, id) => {
      const arr = editTimes.get(id) ?? []
      arr.push(clock.now())
      editTimes.set(id, arr)
      return true as const
    })
    // Two chats → independent per-chat buckets; ONE shared gate (as in the
    // gateway, where every surface transits the same robustApiCall).
    const a = createStreamController({ bot, chatId: '100', throttleMs: 250, retry })
    const b = createStreamController({ bot, chatId: '200', throttleMs: 250, retry })

    void a.update('a1')
    void b.update('b1')
    await flush()
    void a.update('a2')
    void b.update('b2')
    await tick()
    // First edit per message admits immediately on each message's own floor.
    const idA = a.getMessageId() as number
    const idB = b.getMessageId() as number
    expect(editTimes.get(idA)).toEqual([0])
    expect(editTimes.get(idB)).toEqual([0])

    // Refill the global bucket a little so the cosmetic shed check (token
    // pressure) doesn't fire — this test isolates the FLOOR.
    await clock.advance(400)
    void a.update('a3')
    void b.update('b3')
    await tick()
    expect(editTimes.get(idA)).toEqual([0]) // held by A's floor…
    expect(editTimes.get(idB)).toEqual([0]) // …and B by B's own, not A's.

    await clock.advance(1100) // 400 + 1100 = 1500 → BOTH floors clear together
    expect(editTimes.get(idA)).toEqual([0, 1500])
    expect(editTimes.get(idB)).toEqual([0, 1500])
  })

  it('gate no-op skip: a second surface repeating the on-screen payload never reaches the API', async () => {
    const { clock, gate, retry } = makeGatedRetry({ editFloorMs: 1500 })
    // Two controllers re-attached to the SAME anchor message (the #626
    // initialMessageId path — e.g. a stream re-created after a restart).
    const first = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, initialMessageId: 7777,
    })
    void first.update('**status: done**')
    await flush()
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)

    await clock.advance(1500) // clear the floor — isolate the no-op skip
    const second = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, initialMessageId: 7777,
    })
    const onEdit = vi.fn()
    void second.update('**status: done**')
    await flush()

    // Identical rendered payload for the same chat+message → dropped by the
    // gate before the API.
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(gate.stats().global.dropped).toBe(1)
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('open flood window: draft edits shed with ZERO API calls; full state lands after it closes', async () => {
    const { clock, gate, retry } = makeGatedRetry({ editFloorMs: 1500 })
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, initialMessageId: 7777,
    })

    gate.openFloodWindow('global', clock.now() + 30_000)

    void stream.update('draft a')
    await flush()
    void stream.update('draft b')
    await tick()
    // Both drafts shed as cosmetic — nothing reached the API.
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    expect(gate.stats().global.shed).toBe(2)

    await clock.advance(30_000) // window closes
    void stream.update('draft c — full state')
    await tick()
    expect(editBodies()).toEqual(['draft c — full state'])
  })

  it('a shed draft is NOT recorded as delivered: a later finalize of the SAME text still lands', async () => {
    const { clock, gate, retry } = makeGatedRetry({ editFloorMs: 1500 })
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, initialMessageId: 7777,
    })

    gate.openFloodWindow('global', clock.now() + 30_000)
    void stream.update('the completed answer')
    await flush()
    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    expect(gate.stats().global.shed).toBe(1)

    await clock.advance(30_000)
    // stream_reply done=true with the same text → finalize(text). If the shed
    // draft had been recorded as on-screen, draft-stream's dedupe would skip
    // this flush and the completed answer would never render.
    await stream.finalize('the completed answer')
    expect(editBodies()).toEqual(['the completed answer'])
  })

  it('finalize is critical: not shed by an open short window — waits it out, then lands', async () => {
    const { clock, gate, retry } = makeGatedRetry({ editFloorMs: 1500 })
    const editTimes: number[] = []
    bot.api.editMessageText.mockImplementation(async () => {
      editTimes.push(clock.now())
      return true as const
    })
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, initialMessageId: 7777,
    })

    gate.openFloodWindow('global', clock.now() + 30_000) // short: <= 60s fail-fast ceiling
    void stream.update('draft while banned')
    await flush()
    expect(bot.api.editMessageText).not.toHaveBeenCalled() // draft shed

    const fin = stream.finalize('the answer')
    await flush()
    // Critical: NOT shed — queued against the window, still zero API calls.
    expect(bot.api.editMessageText).not.toHaveBeenCalled()

    await clock.advance(30_000)
    await fin
    expect(editBodies()).toEqual(['the answer'])
    expect(editTimes).toEqual([30_000])
    expect(gate.stats().global.shed).toBe(1) // only the draft
  })

  it('finalize under a LONG window fails fast (structured FLOOD_WAIT_ACTIVE, logged) — no API call, no hang', async () => {
    const { clock, gate, retry } = makeGatedRetry({ editFloorMs: 1500 })
    const logs: string[] = []
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, initialMessageId: 7777,
      log: (m) => logs.push(m),
    })

    gate.openFloodWindow('global', clock.now() + 21_397_000) // the 2026-07-12 ban: ~5.9h
    const fin = stream.finalize('the answer')
    await flush()
    await fin // resolves — draft-stream surfaces the failure via log, not a hang

    expect(bot.api.editMessageText).not.toHaveBeenCalled()
    expect(gate.stats().global.failedFast).toBe(1)
    expect(logs.some((m) => m.includes('FLOOD_WAIT_ACTIVE'))).toBe(true)
    // Sanity: the gate's structured error shape is what the reply path keys on.
    try {
      await retry(async () => true, { chat_id: '1', priorityClass: 'critical' })
      expect.unreachable('critical send during a long window must fail fast')
    } catch (err) {
      expect(isFloodWaitActiveError(err)).toBe(true)
    }
  })

  it('REGRESSION PIN: every edit passes messageId / editPayload / priorityClass to the retry policy', async () => {
    // Spy retry with NO gate — pins exactly what the controller hands to
    // robustApiCall (the #3110 bypass was these fields being absent).
    const seen: Array<Record<string, unknown> | undefined> = []
    const retry: RetryPolicy = (fn, opts) => {
      seen.push(opts as Record<string, unknown> | undefined)
      return fn()
    }
    const stream = createStreamController({ bot, chatId: '9', threadId: 3, throttleMs: 250, retry })

    void stream.update('draft')
    await flush()
    // The anchor SEND stays untagged: the gate admits untagged non-edit
    // sends as critical, and a shed send would break message-id capture.
    expect(seen[0]).toEqual({ threadId: 3, chat_id: '9' })

    void stream.update('draft v2')
    await tick()
    const id = stream.getMessageId() as number
    expect(seen[1]).toEqual({
      threadId: 3,
      chat_id: '9',
      messageId: id,
      editPayload: { markdown: 'draft v2' },
      priorityClass: 'cosmetic',
    })

    await stream.finalize('the final answer')
    expect(seen[2]).toEqual({
      threadId: 3,
      chat_id: '9',
      messageId: id,
      editPayload: { markdown: 'the final answer' },
      priorityClass: 'critical',
    })
  })

  it('REGRESSION PIN: the plain parse-entities fallback edit carries the gate fields too', async () => {
    const seen: Array<Record<string, unknown> | undefined> = []
    const retry: RetryPolicy = (fn, opts) => {
      seen.push(opts as Record<string, unknown> | undefined)
      return fn()
    }
    const stream = createStreamController({ bot, chatId: '9', throttleMs: 250, retry })
    void stream.update('draft')
    await flush()
    const id = stream.getMessageId() as number

    // Rich edit 400s with a parse-entities rejection → same-id plain fallback.
    const { GrammyError } = await import('grammy')
    bot.api.editMessageText.mockRejectedValueOnce(
      new GrammyError(
        "Bad Request: can't parse entities",
        { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
        'editMessageText',
        {},
      ),
    )
    void stream.update('draft *broken')
    await tick()

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(2)
    // The fallback is an EDIT of the same message: gate fields present, and
    // the payload is the PLAIN body (hashes differently from the rich form,
    // so the gate never no-op-drops the recovery edit).
    expect(seen[2]).toEqual({
      threadId: undefined,
      chat_id: '9',
      messageId: id,
      editPayload: 'draft *broken',
      priorityClass: 'cosmetic',
    })
  })
})
