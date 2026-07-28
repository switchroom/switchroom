/**
 * The fuse must survive a restart and must react in PROPORTION to the ban
 * (#3856).
 *
 * ── The two bugs these tests guard ───────────────────────────────────────
 *
 * 1. **All state was in process memory.** `tightenLevel` / `tightenedUntil`
 *    were module-local variables. The gateway restarting during a flood ban —
 *    the single most likely thing to happen during a multi-hour outage —
 *    brought the fuse back FULLY UNTIGHTENED, at exactly the rate that earned
 *    the ban, while the window was still open. Every other outbound path in
 *    the tree already consults `flood-wait.json`; the fuse did not.
 *
 * 2. **`noteFlood()` ignored the magnitude.** Every 429 was worth exactly one
 *    level of multiplicative decrease, so a 3-second burst nudge and the
 *    15908-second (4.4h) ban of 2026-07-27 produced an identical response.
 *    The tightening also expired after a flat 10 minutes — ~25× shorter than
 *    that ban, so the fuse would have been back at full rate for hours while
 *    still banned.
 *
 * Every test asserts an OUTCOME (the live ceiling, or how many calls reached
 * the wire), never that a branch ran.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createEditFloodFuse,
  editFloodFuseConfigFromEnv,
  EDIT_FLOOD_FUSE_DEFAULTS,
} from '../edit-flood-fuse.js'
import { floodStatePath, makeFloodWaitProbe } from '../flood-circuit-breaker.js'
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
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

/** A 429 in the shape grammY throws it. */
function flood(retryAfterSec: number): Error & Record<string, unknown> {
  const e = new Error('Too Many Requests: retry after ' + retryAfterSec) as Error &
    Record<string, unknown>
  e.error_code = 429
  e.parameters = { retry_after: retryAfterSec }
  return e
}

describe('restart durability — the persisted window outranks process memory', () => {
  it('a FRESH fuse is already at its tightest when a ban is open on disk', async () => {
    const clock = new FakeClock()
    // Simulate the restart: brand-new fuse, zero in-memory history, but the
    // marker on disk still says 12247s of ban to go.
    const fuse = createEditFloodFuse({
      clock, floodWaitRemainingMs: () => 12_247_000,
      perMessageMaxPerWindow: 20, cosmeticPerMessageMaxPerWindow: 16,
      maxTightenLevel: 4, tightenFactor: 0.5,
    })

    const s = fuse.stats()
    expect(s.persistedFloodOpen).toBe(true)
    expect(s.tightenLevel).toBe(4)
    // 0.5^4 = 1/16 of the base ceiling — the fuse did NOT come back at full rate.
    expect(s.cosmeticPerMessageCeiling).toBe(1)
    expect(s.perMessageCeiling).toBe(1)
    // And it BINDS: 30 cosmetic edits offered, at most the tightened ceiling
    // reaches the wire. Without the persisted read this is 16.
    let landed = 0
    const calls = Array.from({ length: 30 }, () =>
      fuse.apply('editMessageText', { chat_id: CHAT, message_id: 7 }, async () => {
        landed++
        return true
      }))
    await clock.advance(31_000)
    await Promise.all(calls)
    expect(landed).toBeLessThanOrEqual(2)
  })

  it('untightens once the window on disk closes — it is a floor, not a latch', async () => {
    const clock = new FakeClock()
    let remaining = 12_247_000
    const fuse = createEditFloodFuse({
      clock, floodWaitRemainingMs: () => remaining,
      floodProbeIntervalMs: 0, // re-read every call, for determinism here
      perMessageMaxPerWindow: 20, maxTightenLevel: 4, tightenFactor: 0.5,
    })
    expect(fuse.stats().tightenLevel).toBe(4)
    remaining = 0
    // The fuse earned nothing itself, so it returns all the way to base — the
    // persisted window pins the level while open and never mutates it.
    expect(fuse.stats().tightenLevel).toBe(0)
    expect(fuse.stats().perMessageCeiling).toBe(20)
  })

  it('grades the persisted window by what REMAINS, not straight to maximum (#3885)', () => {
    // `makeFloodWaitRecorder` writes `flood-wait.json` for EVERY 429, including
    // a routine 3-second nudge. Pinning at `maxTightenLevel` for any open
    // window therefore reintroduced on the persisted path the exact defect
    // #3856 fixed on the in-memory one: a nudge and a 4.4h ban produced the
    // same maximal response, collapsing a whole chat to 1 call/min over a
    // transient blip. The severity ladder is the same one `noteFlood` uses.
    const cases: [number, number][] = [
      [3_000, 1],        // routine burst nudge
      [45_000, 2],       // sustained overrate
      [300_000, 3],      // a real ban
      [12_247_000, 4],   // the 2026-07-27 magnitude — still straight to maximum
    ]
    for (const [remainingMs, expected] of cases) {
      const fuse = createEditFloodFuse({
        clock: new FakeClock(), floodWaitRemainingMs: () => remainingMs,
        floodProbeIntervalMs: 0, maxTightenLevel: 4, tightenFactor: 0.5,
      })
      expect(fuse.stats().persistedFloodOpen).toBe(true)
      expect(fuse.stats().tightenLevel).toBe(expected)
    }
  })

  it('a single 3s 429 does not collapse the chat to 1 call/min (#3885)', async () => {
    // The production regression, end to end: one transient 429 during a fleet
    // restart both bumped the in-memory level AND wrote a 3-second marker that
    // pinned the fuse at maximum, taking `perChatTotalMaxPerWindow: 20` down to
    // an effective 1 for the whole chat.
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({
      clock, floodProbeIntervalMs: 0,
      // The marker as the real recorder would write it for a 3s penalty.
      floodWaitRemainingMs: () => Math.max(0, 3_000 - clock.now()),
      perChatTotalMaxPerWindow: 20, perChatReplyReserve: 8, perChatSendMaxPerWindow: 25,
      perTokenMaxPerWindow: 1_000, maxTightenLevel: 4, tightenFactor: 0.5,
    })
    await expect(
      fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' }, async () => { throw flood(3) }),
    ).rejects.toThrow()

    // One nudge is worth one level, on both paths — so the chat keeps half its
    // budget, not one-twentieth of it.
    expect(fuse.stats().tightenLevel).toBe(1)
    expect(fuse.stats().criticalPerChatTotalCeiling).toBe(10)

    // And it BINDS at that rate: 20 replies offered inside one window, ~half
    // land promptly rather than one. 9 rather than 10 because the 429'd call
    // above took a slot of the same window before it failed.
    let landed = 0
    const calls = Array.from({ length: 20 }, () =>
      fuse.apply('sendMessage', { chat_id: CHAT, text: 'answer' }, async () => { landed++; return true }))
    await clock.advance(1_000)
    expect(landed).toBe(9)
    await clock.advance(60_000)
    await Promise.all(calls)
  })

  it('FAILS OPEN: an unreadable marker must never gag the bot', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({
      clock,
      floodWaitRemainingMs: () => {
        throw new Error('EACCES: flood-wait.json owned by another uid')
      },
      perChatSendMaxPerWindow: 25,
    })
    expect(fuse.stats().persistedFloodOpen).toBe(false)
    expect(fuse.stats().tightenLevel).toBe(0)
    let landed = 0
    await fuse.apply('sendMessage', { chat_id: CHAT, text: 'the answer' }, async () => {
      landed++
      return true
    })
    expect(landed).toBe(1)
  })

  it('re-reads the marker at most once per floodProbeIntervalMs', async () => {
    const clock = new FakeClock()
    let reads = 0
    const fuse = createEditFloodFuse({
      clock, floodProbeIntervalMs: 1_000,
      floodWaitRemainingMs: () => { reads++; return 0 },
      perChatTotalMaxPerWindow: 1_000, perChatSendMaxPerWindow: 1_000,
      perTokenMaxPerWindow: 1_000,
    })
    for (let i = 0; i < 50; i++) {
      await fuse.apply('sendMessage', { chat_id: CHAT, text: 'x' }, async () => true)
    }
    // A file read on every admission would make the fuse the latency problem
    // it exists to prevent.
    expect(reads).toBeLessThanOrEqual(2)
  })

  it('reads the REAL breaker file that robustApiCall and the sweep use', async () => {
    // Not a mock: write the actual on-disk marker and let the production probe
    // read it, so the two halves cannot drift apart.
    const dir = mkdtempSync(join(tmpdir(), 'fuse-flood-'))
    try {
      writeFileSync(
        floodStatePath(dir),
        JSON.stringify({ untilTs: Date.now() + 12_247_000, retryAfterSec: 12247, recordedTs: Date.now() }),
        'utf-8',
      )
      const fuse = createEditFloodFuse({
        floodWaitRemainingMs: makeFloodWaitProbe(floodStatePath(dir)),
        maxTightenLevel: 4, tightenFactor: 0.5, perMessageMaxPerWindow: 20,
      })
      expect(fuse.stats().persistedFloodOpen).toBe(true)
      expect(fuse.stats().perMessageCeiling).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('editFloodFuseConfigFromEnv wires the probe from TELEGRAM_STATE_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fuse-env-'))
    try {
      writeFileSync(
        floodStatePath(dir),
        JSON.stringify({ untilTs: Date.now() + 600_000, retryAfterSec: 600, recordedTs: Date.now() }),
        'utf-8',
      )
      const cfg = editFloodFuseConfigFromEnv({ TELEGRAM_STATE_DIR: dir })
      expect(cfg.floodWaitRemainingMs).toBeTypeOf('function')
      expect(cfg.floodWaitRemainingMs!()).toBeGreaterThan(0)
      // The wiring is what makes it durable in production — a fuse built from
      // this config is tightened without anyone remembering to pass a probe.
      expect(createEditFloodFuse(cfg).stats().persistedFloodOpen).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a no-op when TELEGRAM_STATE_DIR is unset (dev / one-shot contexts)', () => {
    const cfg = editFloodFuseConfigFromEnv({})
    expect(cfg.floodWaitRemainingMs).toBeUndefined()
    expect(createEditFloodFuse(cfg).stats().persistedFloodOpen).toBe(false)
  })
})

describe('severity scaling — a 4.4h ban is not one nudge\'s worth of signal', () => {
  const mk = (clock: FakeClock) =>
    createEditFloodFuse({
      clock, maxTightenLevel: 4, tightenFactor: 0.5, tightenMs: 600_000,
      perMessageMaxPerWindow: 32,
    })

  async function observe(fuse: ReturnType<typeof mk>, retryAfterSec: number): Promise<void> {
    await expect(
      fuse.apply('editMessageText', { chat_id: CHAT, message_id: 1 }, async () => {
        throw flood(retryAfterSec)
      }),
    ).rejects.toThrow()
  }

  it.each([
    [3, 1],      // routine burst nudge
    [30, 2],     // sustained overrate
    [120, 3],    // a real ban
    [3713, 4],   // the 2026-07-25 incident — straight to maximum
    [15908, 4],  // the 2026-07-27 incident
  ])('retry_after=%is tightens by %i level(s)', async (retryAfterSec, expected) => {
    const clock = new FakeClock()
    const fuse = mk(clock)
    await observe(fuse, retryAfterSec)
    expect(fuse.stats().tightenLevel).toBe(expected)
  })

  it('the ban-magnitude case reaches the floor in ONE 429, not four', async () => {
    // This is the assertion that fails on the pre-fix code: there, a single
    // 15908s ban moved the ceiling from 32 to 16 and the stream carried on at
    // half rate into a four-hour outage.
    const clock = new FakeClock()
    const fuse = mk(clock)
    expect(fuse.stats().perMessageCeiling).toBe(32)
    await observe(fuse, 15_908)
    expect(fuse.stats().perMessageCeiling).toBe(2) // 32 * 0.5^4
  })

  it('holds the tightening for AT LEAST the ban\'s own duration', async () => {
    // A flat 10-minute tightenMs expired ~25× over during the 4.4h ban.
    const clock = new FakeClock()
    const fuse = mk(clock)
    await observe(fuse, 15_908)
    await clock.advance(15_907_000) // one second before the ban lifts
    expect(fuse.stats().tightenLevel).toBeGreaterThan(0)
    expect(fuse.stats().perMessageCeiling).toBeLessThan(32)
  })

  it('a 3s nudge still decays on the normal 10-minute schedule', async () => {
    const clock = new FakeClock()
    const fuse = mk(clock)
    await observe(fuse, 3)
    expect(fuse.stats().tightenLevel).toBe(1)
    // Held for tightenMs PLUS the stated penalty (3s) — still ~10 minutes.
    await clock.advance(600_001)
    expect(fuse.stats().tightenLevel).toBe(1)
    await clock.advance(3_001)
    expect(fuse.stats().tightenLevel).toBe(0)
    expect(fuse.stats().perMessageCeiling).toBe(32)
  })

  it('recovers the magnitude from a 429 that arrives as a raw ApiResponse', async () => {
    const clock = new FakeClock()
    const fuse = mk(clock)
    await fuse.apply('editMessageText', { chat_id: CHAT, message_id: 1 }, async () =>
      ({ ok: false, error_code: 429, parameters: { retry_after: 15_908 } }))
    expect(fuse.stats().tightenLevel).toBe(4)
  })

  it('recovers the magnitude from the message text when there is no parameters block', async () => {
    const clock = new FakeClock()
    const fuse = mk(clock)
    await expect(
      fuse.apply('editMessageText', { chat_id: CHAT, message_id: 1 }, async () => {
        throw new Error('Too Many Requests: retry after 15908')
      }),
    ).rejects.toThrow()
    expect(fuse.stats().tightenLevel).toBe(4)
  })

  it('an UNQUANTIFIED flood is treated as the mildest case, not the worst', async () => {
    // Inflating an unmeasured signal into a maximal response would let one
    // ambiguous error message throttle the bot to 1/window.
    const clock = new FakeClock()
    const fuse = mk(clock)
    await expect(
      fuse.apply('editMessageText', { chat_id: CHAT, message_id: 1 }, async () => {
        throw new Error('Too Many Requests')
      }),
    ).rejects.toThrow()
    expect(fuse.stats().tightenLevel).toBe(1)
  })

  it('still does NOT tighten on an ordinary error that merely contains "429"', async () => {
    const clock = new FakeClock()
    const fuse = mk(clock)
    await expect(
      fuse.apply('editMessageText', { chat_id: CHAT, message_id: 1 }, async () => {
        throw new Error('Bad Request: message 429 not found')
      }),
    ).rejects.toThrow()
    expect(fuse.stats().tightenLevel).toBe(0)
    expect(fuse.stats().floodObserved).toBe(0)
  })

  it('the default probe interval is bounded', () => {
    expect(EDIT_FLOOD_FUSE_DEFAULTS.floodProbeIntervalMs).toBeGreaterThan(0)
    expect(EDIT_FLOOD_FUSE_DEFAULTS.floodProbeIntervalMs).toBeLessThanOrEqual(5_000)
  })
})
