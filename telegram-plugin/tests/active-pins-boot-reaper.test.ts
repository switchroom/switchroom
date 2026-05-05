/**
 * Regression test for #689 — boot-time orphan-pin reaper.
 *
 * Backstop for SIGKILL/OOM/panic where the SIGTERM handler (PR #690)
 * never ran. PR #690 covers clean shutdowns: it walks `pinnedEntries()`
 * in-memory before the process exits. But on a hard kill the in-memory
 * map dies with the process, so the next boot must rely on the disk
 * sidecar (`active-pins.ts`) to find the orphans and finalize them.
 *
 * Shape under test (the new `editBeforeUnpin` hook on `sweepActivePins`):
 *
 *   1. Pin lifecycle records to sidecar (already covered by
 *      active-pins.test.ts) — we just simulate "process died with
 *      sidecar populated" by calling `addActivePin` directly.
 *   2. On next boot, `sweepActivePins` is invoked with an
 *      `editBeforeUnpin` callback that renders the banner.
 *   3. Each entry: editFn runs first; unpin runs after; sidecar gets
 *      cleared.
 *   4. Banner edit failure (e.g. "message to edit not found") is caught
 *      and the unpin still fires — frozen card is worse than no card.
 *   5. Clean-shutdown unpin path (via pinManager.completeTurn) removes
 *      the sidecar entry, so a clean shutdown leaves nothing for the
 *      reaper to find — only crashes leave entries behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addActivePin,
  readActivePins,
  writeActivePins,
  ACTIVE_PINS_FILENAME,
  type ActivePin,
} from '../active-pins.js'
import { sweepActivePins } from '../active-pins-sweep.js'
import {
  createPinManager,
  type PinManagerDeps,
  type TimerHandle,
} from '../progress-card-pin-manager.js'

interface PendingTimer { fn: () => void; cancelled: boolean; fired: boolean }

function mkPinManagerHarness(overrides: Partial<PinManagerDeps> = {}) {
  const timers: PendingTimer[] = []
  const deps = {
    pin: vi.fn(async () => true),
    unpin: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    addPin: vi.fn(),
    removePin: vi.fn(),
    log: vi.fn(),
  }
  const scheduleTimer = (fn: () => void): TimerHandle => {
    const entry: PendingTimer = { fn, cancelled: false, fired: false }
    timers.push(entry)
    return { cancel() { entry.cancelled = true } }
  }
  const mgr = createPinManager({ ...deps, now: () => 10_000, scheduleTimer, ...overrides })
  const fireTimers = (): void => {
    for (const t of [...timers]) {
      if (t.cancelled || t.fired) continue
      t.fired = true
      t.fn()
    }
  }
  return { mgr, deps, fireTimers }
}

describe('boot-time orphan-pin reaper (#689)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pin-reaper-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const makePin = (overrides: Partial<ActivePin> = {}): ActivePin => ({
    chatId: '100',
    messageId: 42,
    turnKey: '100:0:1',
    pinnedAt: 1_700_000_000_000,
    agentId: '__parent__',
    ...overrides,
  })

  it('hard-kill mid-turn: next boot sees the sidecar entry, edits banner, then unpins', async () => {
    // Simulate: prior process pinned but never got to unpin (SIGKILL/OOM).
    addActivePin(tmp, makePin({ chatId: 'A', messageId: 101 }))
    addActivePin(tmp, makePin({ chatId: 'B', messageId: 202, turnKey: 'B:0:1' }))

    // Now boot: invoke the reaper.
    const editCalls: Array<{ chatId: string; messageId: number; banner: string }> = []
    const unpinCalls: Array<[string, number]> = []
    const banner = '⚠️ <b>Restart interrupted this work</b>\n<i>SIGKILL: oom</i>'

    const result = await sweepActivePins(
      tmp,
      async (chatId, messageId) => { unpinCalls.push([chatId, messageId]) },
      {
        editBeforeUnpin: async (pin) => {
          editCalls.push({ chatId: pin.chatId, messageId: pin.messageId, banner })
        },
      },
    )

    // Both pins were edited THEN unpinned.
    expect(editCalls.sort((a, b) => a.messageId - b.messageId)).toEqual([
      { chatId: 'A', messageId: 101, banner },
      { chatId: 'B', messageId: 202, banner },
    ])
    expect(unpinCalls.sort()).toEqual([['A', 101], ['B', 202]])
    expect(result.swept).toHaveLength(2)
    expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false)
  })

  it('banner edit failure does not block the unpin (frozen card is worse than no card)', async () => {
    addActivePin(tmp, makePin({ chatId: 'A', messageId: 101 }))

    const unpinCalls: Array<[string, number]> = []
    const result = await sweepActivePins(
      tmp,
      async (chatId, messageId) => { unpinCalls.push([chatId, messageId]) },
      {
        editBeforeUnpin: async () => {
          throw new Error('Bad Request: message to edit not found')
        },
      },
    )

    expect(unpinCalls).toEqual([['A', 101]])
    expect(result.swept).toHaveLength(1)
    expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false)
  })

  it('edit fires BEFORE unpin (ordering matters — never unpin a card with stale Working… body)', async () => {
    addActivePin(tmp, makePin({ chatId: 'A', messageId: 101 }))

    const order: string[] = []
    await sweepActivePins(
      tmp,
      async () => { order.push('unpin') },
      {
        editBeforeUnpin: async () => { order.push('edit') },
      },
    )

    expect(order).toEqual(['edit', 'unpin'])
  })

  it('clean unpin path removes sidecar entry, leaving nothing for the reaper', async () => {
    // Simulate the pinManager addPin/removePin sidecar wiring used in
    // gateway.ts: addPin appends to disk, removePin filters out.
    const h = mkPinManagerHarness({
      addPin: (entry) => addActivePin(tmp, entry),
      removePin: (chatId, messageId) => {
        const next = readActivePins(tmp).filter(
          (p) => !(p.chatId === chatId && p.messageId === messageId),
        )
        writeActivePins(tmp, next)
      },
    })

    // Pin
    h.mgr.considerPin({
      chatId: 'A', threadId: '7', turnKey: 'A:7:1',
      messageId: 101, isFirstEmit: true,
    })
    h.fireTimers()
    await h.mgr.drainInFlight()
    expect(readActivePins(tmp)).toHaveLength(1)

    // Clean unpin (e.g. via completeTurn at end of turn)
    h.mgr.completeTurn({ chatId: 'A', threadId: '7', turnKey: 'A:7:1' })
    await h.mgr.drainInFlight()

    // Sidecar is empty — the boot reaper would find nothing.
    expect(readActivePins(tmp)).toEqual([])

    // And confirm the reaper would no-op:
    const editCalls: ActivePin[] = []
    const result = await sweepActivePins(
      tmp,
      async () => {},
      { editBeforeUnpin: async (p) => { editCalls.push(p) } },
    )
    expect(editCalls).toEqual([])
    expect(result.swept).toEqual([])
  })

  it('respects the timeout budget when banner edits hang', async () => {
    addActivePin(tmp, makePin({ chatId: 'A', messageId: 101 }))

    const result = await sweepActivePins(
      tmp,
      async () => {},
      {
        timeoutMs: 50,
        editBeforeUnpin: () => new Promise(() => {}), // never resolves
      },
    )

    expect(result.timedOut).toBe(true)
    // Sidecar still cleared — Telegram unpin is idempotent.
    expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false)
  })
})
