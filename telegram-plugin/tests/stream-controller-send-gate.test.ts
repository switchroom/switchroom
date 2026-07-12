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
import { renderOutboundChunks } from '../render/rich-render.js'
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

  it('gate no-op skip: a repeated payload is dropped BENIGNLY — no API call, treated as delivered (F4)', async () => {
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
    const onEdit = vi.fn()
    const logs: string[] = []
    const second = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, initialMessageId: 7777, onEdit,
      log: (m) => logs.push(m),
    })
    void second.update('**status: done**')
    await flush()

    // Identical rendered payload for the same chat+message → dropped by the
    // gate before the API…
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
    expect(gate.stats().global.dropped).toBe(1)
    // …and the drop is BENIGN (the payload IS on screen): the controller
    // reports it as delivered — onEdit fires, no shed marker, no failure log
    // (F4: pre-sentinel this test passed via the wrong mechanism — the
    // drop's `undefined` was misread as a shed and onEdit stayed silent).
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(logs.filter((m) => m.includes('shed') || m.includes('edit failed'))).toEqual([])

    // Because the drop was recorded as delivered, a THIRD identical update
    // dedupes inside draft-stream itself — it never even reaches the gate.
    void second.update('**status: done**')
    await tick() // release the local throttle so the dedupe check runs
    expect(gate.stats().global.dropped).toBe(1) // unchanged — gate never consulted
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1)
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

  /**
   * The reviewer's F1 production-faithful probe: a multi-piece body (the
   * escaped-markdown expansion splits it across several wire-cap pieces)
   * where only the TAIL grows across flushes. The anchor piece stops
   * changing, so on a perfectly healthy chat its edit resolves `undefined`
   * every flush — first via robustApiCall's swallowed "message is not
   * modified" 400, then via the gate's no-op drop. Pre-sentinel, that
   * `undefined` was misread as a shed and thrown BEFORE the tail loop: no
   * tail edit ever landed (screen frozen at "tail v1") and a false "shed"
   * line hit stderr every flush.
   */
  it('multi-piece body: a benign anchor outcome never starves the tail edits (F1)', async () => {
    const { clock, gate, retry } = makeGatedRetry({
      editFloorMs: 1500,
      // Generous buckets: this test isolates the benign-undefined path, not
      // token pressure.
      globalPerSec: 1000, globalBurst: 100, perChatPerSec: 1000, perChatBurst: 100,
    })
    const base = ('a_b_c_d_e ').repeat(3000)
    const b1 = `${base}tail v1`
    const b2 = `${base}tail v2`
    const b3 = `${base}tail v3`
    // Sanity-pin the repro geometry: several pieces, prefix-stable chunking,
    // only the LAST piece changes as the tail grows.
    const p1 = renderOutboundChunks(b1)
    const p2 = renderOutboundChunks(b2)
    expect(p1.length).toBeGreaterThan(1)
    expect(p2.length).toBe(p1.length)
    for (let i = 0; i < p1.length - 1; i++) expect(p2[i].text).toBe(p1[i].text)
    expect(p2[p1.length - 1].text).not.toBe(p1[p1.length - 1].text)

    // Faithful edit mock: repeating a message's current text 400s with
    // "message is not modified", which the production retry policy swallows
    // to `undefined` — simulate the post-swallow result directly.
    const currentText = new Map<number, string>()
    bot.api.sendMessage.mockImplementation(async (_c, text) => {
      const id = bot.nextMessageId++
      currentText.set(id, text)
      return { message_id: id }
    })
    bot.api.editMessageText.mockImplementation(async (_c, id, text) => {
      const body = typeof text === 'object' && text != null ? text.markdown : text
      if (currentText.get(id) === body) return undefined // swallowed not-modified
      currentText.set(id, body)
      return true as const
    })

    const logs: string[] = []
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry,
      log: (m) => logs.push(m), warn: (m) => logs.push(m),
    })

    void stream.update(b1)
    await flush()
    const anchorId = stream.getMessageId() as number
    const lastTailId = anchorId + p1.length - 1
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(p1.length)
    expect(currentText.get(lastTailId)).toContain('tail v1')

    // Flush 2: anchor unchanged → its edit resolves undefined via the
    // not-modified swallow. The tail edit MUST still land.
    void stream.update(b2)
    await tick()
    expect(currentText.get(lastTailId)).toContain('tail v2')

    // Flush 3: anchor unchanged again → this time the GATE no-op-drops it
    // (its hash is recorded from flush 2). The tail edit MUST still land.
    await clock.advance(1600) // clear the tail message's own edit floor
    void stream.update(b3)
    await tick()
    expect(currentText.get(lastTailId)).toContain('tail v3')
    expect(gate.stats().global.dropped).toBeGreaterThanOrEqual(1)

    // The whole run was healthy: no shed marker, no failure lines.
    expect(logs.filter((m) => m.includes('shed') || m.includes('FAILED') || m.includes('edit failed'))).toEqual([])

    // And the flushes were recorded as delivered: an identical finalize
    // dedupes inside draft-stream — zero further API calls.
    const editCalls = bot.api.editMessageText.mock.calls.length
    await stream.finalize(b3)
    expect(bot.api.editMessageText.mock.calls.length).toBe(editCalls)
  })

  it('a shed TAIL is not recorded as delivered: argument-less finalize() re-flushes and lands it (F2+F3)', async () => {
    const { clock, gate, retry } = makeGatedRetry({
      editFloorMs: 1500,
      globalPerSec: 1000, globalBurst: 100, perChatPerSec: 1000, perChatBurst: 100,
    })
    const base = ('a_b_c_d_e ').repeat(3000)
    const b1 = `${base}tail v1`
    const b2 = `${base}tail v2 — the completed answer`
    const pieceCount = renderOutboundChunks(b1).length
    expect(pieceCount).toBeGreaterThan(1)

    const logs: string[] = []
    const stream = createStreamController({
      bot, chatId: '1', throttleMs: 250, retry, log: (m) => logs.push(m),
    })
    void stream.update(b1)
    await flush()
    const anchorId = stream.getMessageId() as number
    const lastTailId = anchorId + pieceCount - 1

    // Flood window scoped to the LAST tail message only (H1 msg-edit scope):
    // its edit sheds; the anchor and other pieces are unaffected.
    gate.openFloodWindow(`msg-edit:1:${lastTailId}`, clock.now() + 30_000)

    void stream.update(b2)
    await tick()
    // The changed piece is the suppressed tail → shed, zero edits landed on
    // it; the flush is reported shed and the snapshot preserved (F2), NOT
    // recorded as delivered (F3).
    const tailEdits = () =>
      bot.api.editMessageText.mock.calls.filter(([, id]) => id === lastTailId)
    expect(tailEdits()).toHaveLength(0)
    expect(gate.stats().global.shed).toBe(1)
    expect(logs.some((m) => m.includes('shed by send gate'))).toBe(true)

    // Window closes; the gateway-style ARGUMENT-LESS finalize (the
    // disconnect-flush / turn-end cleanup path) must re-deliver the shed
    // snapshot — pre-F2 the content was silently lost here.
    await clock.advance(31_000)
    await stream.finalize()
    expect(tailEdits()).toHaveLength(1)
    const [, , tailBody] = tailEdits()[0]
    expect(String(tailBody)).toContain('tail v2')
  })
})
