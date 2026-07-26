/**
 * The edit-flood fuse (#3620) — the chokepoint that no outbound call can
 * bypass.
 *
 * These tests assert the INVARIANT, not the code path: an outbound caller
 * that knows nothing about the send gate (no keying, no priority class, no
 * `robustApiCall`) still cannot exceed the ceiling, because the fuse lives in
 * the grammY transformer stack that every call to the bot's `Api` object
 * traverses.
 */
import { describe, it, expect } from 'vitest'
import {
  createEditFloodFuse, installEditFloodFuse, EDIT_FLOOD_FUSE_DEFAULTS,
  type FuseInstallable,
} from '../edit-flood-fuse.js'
import type { Clock } from '../send-gate.js'

const CHAT = '1001'

class FakeClock implements Clock {
  private cur = 0
  private seq = 0
  private timers: { at: number; id: number; resolve: () => void }[] = []

  now(): number { return this.cur }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.cur + ms, id: this.seq++, resolve })
    })
  }

  async advance(ms: number): Promise<void> {
    const target = this.cur + ms
    for (;;) {
      await flush()
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const t = due[0]!
      this.timers = this.timers.filter((x) => x !== t)
      this.cur = t.at
      t.resolve()
      await flush()
    }
    this.cur = target
    await flush()
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

describe('edit-flood fuse — a runaway edit stream cannot exceed the ceiling', () => {
  it('200 unkeyed edits to ONE message admit at most the per-message ceiling per window', async () => {
    const clock = new FakeClock()
    const landed: string[] = []
    const fuse = createEditFloodFuse({ clock, perMessageMaxPerWindow: 20, perMessageWindowMs: 60_000 })

    // A caller that does everything wrong: raw, unkeyed, as fast as it can.
    const inflight: Promise<unknown>[] = []
    for (let i = 1; i <= 200; i++) {
      inflight.push(fuse.apply(
        'editMessageText',
        { chat_id: CHAT, message_id: 42, text: `frame ${i}` },
        async () => { landed.push(`frame ${i}`); return true },
      ))
      await clock.advance(50) // 20 edits/sec offered — 1200/min
    }
    // 200 offers spread over 10s of fake time. Snapshot INSIDE the window —
    // that is where the ceiling claim lives.
    await clock.advance(1_000)
    const inWindow = landed.length
    // Then settle: the one surviving waiter is dropped at `maxDeferMs`.
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)

    // The whole burst happened inside ONE 60s window, so the ceiling is the
    // ceiling — not 200, not 60.
    expect(inWindow).toBeLessThanOrEqual(20)
    expect(inWindow).toBeGreaterThan(0)
    const s = fuse.stats()
    expect(s.dropped + s.superseded).toBeGreaterThan(0)
  })

  it('drops the STALE frames, not the newest: the last edit to land is the newest offered', async () => {
    const clock = new FakeClock()
    const landed: string[] = []
    const fuse = createEditFloodFuse({ clock, perMessageMaxPerWindow: 3, perMessageWindowMs: 10_000, maxDeferMs: 60_000 })

    const inflight: Promise<unknown>[] = []
    for (let i = 1; i <= 30; i++) {
      inflight.push(fuse.apply(
        'editMessageText',
        { chat_id: CHAT, message_id: 7, text: `v${i}` },
        async () => { landed.push(`v${i}`); return true },
      ))
      await clock.advance(100)
    }
    // Let the window slide so the surviving (newest) frame gets its slot.
    await clock.advance(30_000)
    await Promise.all(inflight)

    expect(landed.length).toBeLessThanOrEqual(6) // 3 per 10s window over ~33s
    // Last-write-wins at the chokepoint: the final frame that reached the API
    // is the newest one that was offered, never a stale intermediate.
    expect(landed[landed.length - 1]).toBe('v30')
    expect(fuse.stats().superseded).toBeGreaterThan(0)
  })

  it('N concurrent producers (parallel sub-agents) share ONE budget — they do not each get their own', async () => {
    const clock = new FakeClock()
    const landed: string[] = []
    const fuse = createEditFloodFuse({
      clock, perMessageMaxPerWindow: 50, perChatEditMaxPerWindow: 12, perChatWindowMs: 60_000,
    })

    // 8 producers, each editing its OWN card in the SAME chat — the shape of
    // parallel sub-agents each driving a worker feed. Per-message budgets
    // would let all 8 through; the per-CHAT budget is what must bind.
    const producers = 8
    const perProducer = 20
    const inflight: Promise<unknown>[] = []
    for (let round = 0; round < perProducer; round++) {
      for (let p = 0; p < producers; p++) {
        inflight.push(fuse.apply(
          'editMessageText',
          { chat_id: CHAT, message_id: 100 + p, text: `p${p} r${round}` },
          async () => { landed.push(`p${p} r${round}`); return true },
        ))
      }
      await clock.advance(200)
    }
    await clock.advance(1_000)
    const inWindow = landed.length
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)

    // 160 offered across 8 producers in a 5s span; the shared per-chat ceiling
    // holds regardless of how many producers there are.
    expect(inWindow).toBeLessThanOrEqual(12)
  })

  it('never drops a non-edit send — a reply is paced, not lost', async () => {
    const clock = new FakeClock()
    const landed: number[] = []
    const fuse = createEditFloodFuse({
      clock, perChatSendMaxPerWindow: 2, perChatWindowMs: 10_000, maxDeferMs: 60_000,
    })

    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < 6; i++) {
      inflight.push(fuse.apply(
        'sendMessage',
        { chat_id: CHAT, text: `reply ${i}` },
        async () => { landed.push(i); return true },
      ))
    }
    await clock.advance(120_000)
    await Promise.all(inflight)

    // Every single reply reached the API — paced, never dropped.
    expect(landed).toHaveLength(6)
    expect(fuse.stats().dropped).toBe(0)
  })
})

describe('edit-flood fuse — AIMD: a soft 429 tightens the sustained rate', () => {
  it('halves the ceiling after an observed 429 and restores it after the tighten window', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({
      clock, perMessageMaxPerWindow: 20, perMessageWindowMs: 60_000,
      tightenFactor: 0.5, tightenMs: 600_000,
    })
    expect(fuse.stats().perMessageCeiling).toBe(20)
    expect(fuse.stats().tightened).toBe(false)

    // A 429 arrives the way grammY surfaces it: a thrown error carrying the
    // code and retry_after. The fuse must not swallow it...
    const flood = Object.assign(new Error('Too Many Requests: retry after 3'), {
      error_code: 429, parameters: { retry_after: 3 },
    })
    await expect(fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' }, async () => { throw flood }))
      .rejects.toThrow(/Too Many Requests/)

    // ...but it must tighten the sustained rate, which nothing in the stack
    // did before: retry-api-call sleeps `retry_after` and resumes at FULL rate.
    expect(fuse.stats().floodObserved).toBe(1)
    expect(fuse.stats().tightened).toBe(true)
    expect(fuse.stats().perMessageCeiling).toBe(10)

    // The tightened ceiling is what actually binds, not just what stats says.
    const landed: number[] = []
    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < 40; i++) {
      inflight.push(fuse.apply(
        'editMessageText', { chat_id: CHAT, message_id: 5, text: `t${i}` },
        async () => { landed.push(i); return true },
      ))
      await clock.advance(10)
    }
    await clock.advance(1_000)
    const inWindow = landed.length
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)
    expect(inWindow).toBeLessThanOrEqual(10)

    // Additive-ish recovery: once the tighten window lapses the full ceiling
    // is back (no permanent degradation from one transient 429).
    await clock.advance(600_001)
    expect(fuse.stats().tightened).toBe(false)
    expect(fuse.stats().perMessageCeiling).toBe(20)
  })

  it('recognises a 429 that arrives as a raw ApiResponse rather than a throw', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock })
    await fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' }, async () => ({
      ok: false, error_code: 429, parameters: { retry_after: 5 },
    }))
    expect(fuse.stats().floodObserved).toBe(1)
    expect(fuse.stats().tightened).toBe(true)
  })
})

describe('edit-flood fuse — structural: installed where nothing can bypass it', () => {
  it('installs as a grammY transformer, so a RAW bot.api call is fused too', async () => {
    const clock = new FakeClock()
    const landed: string[] = []
    // A stand-in for grammY's Api transformer stack: `use` registers a
    // transformer and `call` runs the chain, exactly as grammY does.
    const chain: ((prev: (m: string, p: unknown, s?: unknown) => Promise<unknown>, m: string, p: unknown, s?: unknown) => Promise<unknown>)[] = []
    const bot: FuseInstallable = { api: { config: { use: (t) => { chain.push(t) } } } }
    const raw = async (_m: string, p: unknown) => {
      landed.push(String((p as { text: string }).text))
      return true
    }
    const call = (m: string, p: unknown) =>
      chain.reduce<(mm: string, pp: unknown, ss?: unknown) => Promise<unknown>>(
        (prev, t) => (mm, pp, ss) => t(prev, mm, pp, ss), raw,
      )(m, p)

    const fuse = installEditFloodFuse(bot, { clock, perMessageMaxPerWindow: 4, perMessageWindowMs: 60_000 })
    expect(chain).toHaveLength(1)

    const inflight: Promise<unknown>[] = []
    for (let i = 0; i < 50; i++) {
      inflight.push(call('editMessageText', { chat_id: CHAT, message_id: 9, text: `raw ${i}` }))
      await clock.advance(20)
    }
    await clock.advance(1_000)
    const inWindow = landed.length
    await clock.advance(EDIT_FLOOD_FUSE_DEFAULTS.maxDeferMs + 1_000)
    await Promise.all(inflight)

    // The caller never touched the send gate, never keyed anything, and is
    // still bounded. That is the property the send gate alone cannot give.
    expect(inWindow).toBeLessThanOrEqual(4)
    expect(fuse.stats().dropped + fuse.stats().superseded).toBeGreaterThan(0)
  })

  it('passes non-message methods straight through (getUpdates must never be paced)', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock, perChatSendMaxPerWindow: 1, perChatWindowMs: 600_000 })
    let calls = 0
    for (let i = 0; i < 100; i++) {
      await fuse.apply('getUpdates', {}, async () => { calls++; return [] })
    }
    expect(calls).toBe(100)
    expect(fuse.stats().deferred).toBe(0)
  })

  it('defaults sit above every legitimate cadence in the codebase', () => {
    // The worker feed's own min edit interval is 2500ms (≤24 edits/min for a
    // chat) and the send gate's cosmetic per-message budget is 30/min. The
    // fuse must bind only on a genuine runaway, so its per-message ceiling is
    // below those but its per-CHAT ceiling is not.
    expect(EDIT_FLOOD_FUSE_DEFAULTS.perMessageMaxPerWindow).toBeLessThan(24)
    expect(EDIT_FLOOD_FUSE_DEFAULTS.perChatEditMaxPerWindow).toBeGreaterThanOrEqual(24)
    expect(EDIT_FLOOD_FUSE_DEFAULTS.perMessageWindowMs).toBe(60_000)
  })
})
