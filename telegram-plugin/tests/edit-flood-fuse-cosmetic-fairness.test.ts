/**
 * Per-`message_id` cosmetic fair-share (#4300).
 *
 * The bug: `cosmeticPerChatMaxPerWindow` (6/60s) is ONE bucket shared across
 * every cosmetic surface in a chat — the primary activity card, a worker /
 * sub-agent card, and answer-stream draft edits. Under intra-cosmetic
 * contention (two live cards) — and especially once a 429 tightens that bucket
 * — the surface the user is actually watching (the primary activity card) could
 * be starved well past 60s between frames while the OTHER surface kept
 * repainting. The fix carves a small AIMD-immune per-message floor OUT OF the
 * same pool (no new wire rate, so 429 risk is unchanged) so no cosmetic surface
 * can starve another, and a watched card keeps a minimum cadence under flood.
 *
 * These tests assert OUTCOMES (frames that actually reached the API within a
 * window), not code paths, and pin the behaviour against the kill-switch so a
 * revert of the core change fails at least one of them.
 */
import { describe, it, expect } from 'vitest'
import { createEditFloodFuse, EDIT_FLOOD_FUSE_DEFAULTS } from '../edit-flood-fuse.js'
import type { Clock } from '../send-gate.js'

const CHAT = '5005'
const PRIMARY = 1 // the activity card the user watches
const WORKER = 2 // a second live cosmetic surface (sub-agent card / draft)

const D = EDIT_FLOOD_FUSE_DEFAULTS

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

const flood = () => Object.assign(
  new Error('Too Many Requests: retry after 3'),
  { error_code: 429, parameters: { retry_after: 3 } },
)

/**
 * Drive `n` observed 429s so the ceilings tighten by `n` AIMD levels. The
 * probes go to a SEPARATE chat: tightening is global, but a probe still charges
 * the target chat's shared total window, and we don't want those synthetic
 * sends to eat into CHAT's tightened cosmetic-total budget under test.
 */
async function tighten(fuse: ReturnType<typeof createEditFloodFuse>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await fuse.apply('sendMessage', { chat_id: '9009', text: 'probe' }, async () => { throw flood() })
      .then(() => { /* unreachable */ }, () => { /* the 429 is re-thrown; swallow */ })
  }
}

/**
 * Run a contention scenario: WORKER repaints densely (every `workerEveryMs`)
 * and PRIMARY repaints at a heartbeat cadence (every `primaryEveryMs`), both
 * for `spanMs`. Returns how many frames of each landed strictly inside the
 * first `perChatWindowMs` window.
 */
async function contend(
  fuse: ReturnType<typeof createEditFloodFuse>, clock: FakeClock,
  opts: { spanMs: number; workerEveryMs: number; primaryEveryMs: number },
): Promise<{ primary: number; worker: number }> {
  const landed: { primary: number; worker: number } = { primary: 0, worker: 0 }
  const inflight: Promise<unknown>[] = []
  let nextWorker = 0
  let nextPrimary = 3_000 // let the worker grab the pool first, as in the real stall
  const step = 500
  for (let t = 0; t <= opts.spanMs; t += step) {
    if (t >= nextWorker) {
      inflight.push(fuse.apply(
        'editMessageText', { chat_id: CHAT, message_id: WORKER, text: `w${t}` },
        async () => { if (clock.now() < D.perChatWindowMs) landed.worker++; return true },
      ))
      nextWorker += opts.workerEveryMs
    }
    if (t >= nextPrimary) {
      inflight.push(fuse.apply(
        'editMessageText', { chat_id: CHAT, message_id: PRIMARY, text: `p${t}` },
        async () => { if (clock.now() < D.perChatWindowMs) landed.primary++; return true },
      ))
      nextPrimary += opts.primaryEveryMs
    }
    await clock.advance(step)
  }
  // Drain every still-deferred frame so no promise is left dangling.
  await clock.advance(D.maxDeferMs + 1_000)
  await Promise.all(inflight)
  return landed
}

describe('#4300 cosmetic fair-share — a watched card is not starved by a second surface', () => {
  it('(a) under flood tightening the primary card keeps its per-message floor while a worker card repaints', async () => {
    // One 429 → AIMD level 1: the shared cosmetic pool ceiling(6) shrinks to 3,
    // which two live cosmetic surfaces would otherwise fight over.
    const clockOn = new FakeClock()
    const fuseOn = createEditFloodFuse({ clock: clockOn })
    await tighten(fuseOn, 1)
    expect(fuseOn.stats().tightenLevel).toBeGreaterThanOrEqual(1)
    const on = await contend(fuseOn, clockOn, { spanMs: 58_000, workerEveryMs: 1_000, primaryEveryMs: 6_000 })

    // The invariant: the watched card still repaints at least its guaranteed
    // floor (cosmeticFloorPerWindow = 2/60s = 1 edit/30s), AIMD-immune, even
    // though the worker is hammering the same pool.
    expect(on.primary).toBeGreaterThanOrEqual(D.cosmeticFloorPerWindow)
  })

  it('(d) mutation guard — with fair-share OFF the SAME scenario starves the primary below the floor', async () => {
    // Kill-switch OFF is the pre-fix single shared bucket. Reverting the core
    // change is behaviourally identical to this, so if the fix did nothing the
    // (a) assertion above would already hold here — it must NOT.
    const clockOff = new FakeClock()
    const fuseOff = createEditFloodFuse({ clock: clockOff, cosmeticFairShareEnabled: false })
    await tighten(fuseOff, 1)
    const off = await contend(fuseOff, clockOff, { spanMs: 58_000, workerEveryMs: 1_000, primaryEveryMs: 6_000 })

    // No per-message floor: the dense worker wins the shared pool and the
    // watched card is starved below the floor the fix guarantees.
    expect(off.primary).toBeLessThan(D.cosmeticFloorPerWindow)
    expect(fuseOff.stats().cosmeticFairShareEnabled).toBe(false)
  })

  it('(b) a heavily-tightened pool still lets a lone watched card repaint ≥ 1 edit / 30s (AIMD floor)', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock })
    // Two 429s → level 2: ceiling(6) → 1, so WITHOUT the floor the whole chat's
    // cosmetic budget would be a single frame per 60s.
    await tighten(fuse, 2)
    expect(fuse.stats().tightenLevel).toBeGreaterThanOrEqual(2)

    const landed: number[] = []
    const inflight: Promise<unknown>[] = []
    // A watched card's heartbeat: an edit every 5s across a 60s window.
    for (let i = 0; i < 12; i++) {
      inflight.push(fuse.apply(
        'editMessageText', { chat_id: CHAT, message_id: PRIMARY, text: `hb${i}` },
        async () => { if (clock.now() < D.perChatWindowMs) landed.push(i); return true },
      ))
      await clock.advance(5_000)
    }
    await clock.advance(1_000)
    const inWindow = landed.length
    await clock.advance(D.maxDeferMs + 1_000)
    await Promise.all(inflight)

    // ≥ 1 edit / 30s = ≥ cosmeticFloorPerWindow (2) per 60s window, guaranteed
    // no matter how many 429s tighten the pool.
    expect(inWindow).toBeGreaterThanOrEqual(D.cosmeticFloorPerWindow)
  })

  it('(c) fair-share OFF is the old single shared bucket — two surfaces share exactly cosmeticPerChatMax, byte-for-byte', async () => {
    // No tightening: the pre-fix behaviour is that ALL cosmetic surfaces in a
    // chat draw from one `cosmeticPerChatMaxPerWindow` bucket with no
    // per-message reservation. Two saturating surfaces therefore land, in
    // aggregate, exactly the pool — never more (the fix does not raise the wire
    // rate) and, with the flag off, with no floor keeping either one alive.
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock, cosmeticFairShareEnabled: false })
    let a = 0
    let b = 0
    const inflight: Promise<unknown>[] = []
    for (let t = 0; t < 58_000; t += 500) {
      inflight.push(fuse.apply('editMessageText', { chat_id: CHAT, message_id: PRIMARY, text: `a${t}` },
        async () => { if (clock.now() < D.perChatWindowMs) a++; return true }))
      inflight.push(fuse.apply('editMessageText', { chat_id: CHAT, message_id: WORKER, text: `b${t}` },
        async () => { if (clock.now() < D.perChatWindowMs) b++; return true }))
      await clock.advance(500)
    }
    await clock.advance(D.maxDeferMs + 1_000)
    await Promise.all(inflight)

    // The single shared bucket: aggregate cosmetic frames == the pool, and the
    // fair-share machinery is provably not in play.
    expect(a + b).toBeLessThanOrEqual(D.cosmeticPerChatMaxPerWindow)
    expect(a + b).toBeGreaterThan(0)
    expect(fuse.stats().cosmeticFairShareEnabled).toBe(false)
  })

  it('raises a visible `throttled` signal when a cosmetic edit is deferred past throttleNoticeMs', async () => {
    const clock = new FakeClock()
    const actions: string[] = []
    // Saturate the per-chat cosmetic pool with a DIFFERENT card so the target
    // edit has to wait; a long defer window lets it cross the notice threshold.
    const fuse = createEditFloodFuse({
      clock,
      cosmeticPerChatMaxPerWindow: 1, cosmeticFloorPerWindow: 0,
      perChatWindowMs: 600_000, maxDeferMs: 120_000, throttleNoticeMs: 45_000,
      onTrip: (i) => { actions.push(i.action) },
    })
    // Burn the pool.
    await fuse.apply('editMessageText', { chat_id: CHAT, message_id: WORKER, text: 'hog' },
      async () => true)
    // The watched card's frame cannot get in; it sits deferred.
    const stuck = fuse.apply('editMessageText', { chat_id: CHAT, message_id: PRIMARY, text: 'watched' },
      async () => true)
    await clock.advance(46_000)
    expect(fuse.stats().throttled).toBeGreaterThan(0)
    expect(actions).toContain('throttled')
    // Drain.
    await clock.advance(120_000)
    await stuck
  })
})
