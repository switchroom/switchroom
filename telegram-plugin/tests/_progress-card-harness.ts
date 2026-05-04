/**
 * Shared harness for progress-card-driver tests added in PR-C2.
 *
 * Mirrors the inline harness used by progress-card-close-paths-converge,
 * progress-card-driver-eviction, and the two-zone-* tests so the new
 * tests don't drift in fake-clock semantics.
 */

import { createProgressDriver, type ProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

export interface DriverHarness {
  driver: ProgressDriver
  emits: Array<{ chatId: string; threadId?: string; turnKey: string; html: string; done: boolean }>
  completions: string[]
  advance: (ms: number) => void
  getNow: () => number
}

export interface HarnessOpts {
  minIntervalMs?: number
  coalesceMs?: number
  initialDelayMs?: number
  heartbeatMs?: number
  maxIdleMs?: number
  deferredCompletionTimeoutMs?: number
  promoteAfterMs?: number
  editBudgetThreshold?: number
  editBudgetCoalesceMs?: number
  maxConsecutive4xx?: number
  onTurnComplete?: (s: { turnKey: string }) => void
}

export function makeHarness(opts: HarnessOpts = {}): DriverHarness {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; turnKey: string; html: string; done: boolean }> = []
  const completions: string[] = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    minIntervalMs: opts.minIntervalMs ?? 0,
    coalesceMs: opts.coalesceMs ?? 0,
    initialDelayMs: opts.initialDelayMs ?? 0,
    heartbeatMs: opts.heartbeatMs ?? 1_000,
    maxIdleMs: opts.maxIdleMs ?? 30_000,
    deferredCompletionTimeoutMs: opts.deferredCompletionTimeoutMs ?? 10_000,
    promoteAfterMs: opts.promoteAfterMs,
    editBudgetThreshold: opts.editBudgetThreshold,
    editBudgetCoalesceMs: opts.editBudgetCoalesceMs,
    maxConsecutive4xx: opts.maxConsecutive4xx,
    onTurnComplete: opts.onTurnComplete ?? ((s) => completions.push(s.turnKey)),
    now: () => now,
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref })
      return { ref }
    },
    clearTimeout: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
    setInterval: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
      return { ref }
    },
    clearInterval: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
  })

  const advance = (ms: number): void => {
    now += ms
    for (;;) {
      timers.sort((a, b) => a.fireAt - b.fireAt)
      const next = timers[0]
      if (!next || next.fireAt > now) break
      if (next.repeat != null) {
        next.fireAt += next.repeat
        next.fn()
      } else {
        timers.shift()
        next.fn()
      }
    }
  }

  return { driver, emits, completions, advance, getNow: () => now }
}

let nextMsgId = 50_000
export function enqueue(chatId: string, threadId?: string): SessionEvent {
  return {
    kind: 'enqueue',
    chatId,
    messageId: String(nextMsgId++),
    threadId: threadId ?? null,
    rawContent: `<channel chat_id="${chatId}">go</channel>`,
  }
}
