import { describe, it, expect, beforeEach } from 'vitest'
import {
  emitTransportTransientEvent,
  flushDeferredUserNotices,
  noteTransportTransientAndShouldEscalate,
  renderTransportEscalationCard,
  resetTransportTransientEscalation,
  type UserFailureNoticeDeps,
} from '../gateway/user-failure-notices.js'
import type { OperatorEvent } from '../operator-events.js'
import type { PendingUserNotice } from '../pending-user-notice.js'

// ─── Fake deps: capture every side effect, drive time explicitly ─────────────

interface Capture {
  recorded: OperatorEvent[]
  scheduled: Array<{ chatIds: string[]; agent: string; kind: string; key: string | undefined; atMs: number }>
  sent: Array<{ chatId: string; text: string; hasKeyboard: boolean }>
  logs: string[]
  /** Notices the fake gate will release on the next resolveNotices call. */
  resolvedQueue: PendingUserNotice[]
  lastResolve?: { delivered: boolean; key: string }
}

function makeDeps(over?: {
  allowFrom?: string[]
  liveTurnKey?: string | undefined
  now?: number
}): { deps: UserFailureNoticeDeps; cap: Capture } {
  const cap: Capture = { recorded: [], scheduled: [], sent: [], logs: [], resolvedQueue: [] }
  const deps: UserFailureNoticeDeps = {
    now: () => over?.now ?? 1_000,
    allowFrom: () => over?.allowFrom ?? ['op', 'user-a', 'user-b'],
    liveTurnKey: () => ('liveTurnKey' in (over ?? {}) ? over!.liveTurnKey : 'chat:topic'),
    record: (e) => cap.recorded.push(e),
    scheduleUserNotice: (i) => cap.scheduled.push(i),
    resolveNotices: (delivered, key) => {
      cap.lastResolve = { delivered, key }
      // Emulate the real gate: a delivered reply drops everything.
      return delivered ? [] : cap.resolvedQueue
    },
    send: (chatId, text, keyboard) => cap.sent.push({ chatId, text, hasKeyboard: keyboard != null }),
    log: (m) => cap.logs.push(m),
  }
  return { deps, cap }
}

function ev(overrides?: Partial<OperatorEvent>): OperatorEvent {
  return {
    kind: 'transport-transient',
    agent: 'gymbro',
    detail: 'API Error: Connection closed mid-response',
    suggestedActions: [],
    firstSeenAt: new Date('2026-08-02T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => resetTransportTransientEscalation())

// ─── emitTransportTransientEvent — outcomes ──────────────────────────────────

describe('emitTransportTransientEvent', () => {
  it('records history and schedules a deferred user notice, but sends NO card (single event)', () => {
    const { deps, cap } = makeDeps()
    emitTransportTransientEvent(ev(), deps)
    // history recorded for /status
    expect(cap.recorded).toHaveLength(1)
    expect(cap.recorded[0].kind).toBe('transport-transient')
    // user notice scheduled to ALL allowlist chats, keyed to the live turn
    expect(cap.scheduled).toHaveLength(1)
    expect(cap.scheduled[0].chatIds).toEqual(['op', 'user-a', 'user-b'])
    expect(cap.scheduled[0].key).toBe('chat:topic')
    // NO broadcast / escalation card for a single event
    expect(cap.sent).toHaveLength(0)
  })

  it('records even when there is no allowlist, but schedules nothing', () => {
    const { deps, cap } = makeDeps({ allowFrom: [] })
    emitTransportTransientEvent(ev(), deps)
    expect(cap.recorded).toHaveLength(1)
    expect(cap.scheduled).toHaveLength(0)
    expect(cap.sent).toHaveLength(0)
  })

  it('carries an undefined notice key when there is no live turn', () => {
    const { deps, cap } = makeDeps({ liveTurnKey: undefined })
    emitTransportTransientEvent(ev(), deps)
    expect(cap.scheduled[0].key).toBeUndefined()
  })
})

// ─── Escalation: >=3 within the window → exactly ONE operator-only card ───────

describe('transport-transient escalation bound', () => {
  it('sends exactly ONE operator-only Dismiss-only card at the 3rd event in the window', () => {
    const { deps, cap } = makeDeps()
    emitTransportTransientEvent(ev(), deps) // 1 — no card
    emitTransportTransientEvent(ev(), deps) // 2 — no card
    expect(cap.sent).toHaveLength(0)
    emitTransportTransientEvent(ev(), deps) // 3 — ONE card
    expect(cap.sent).toHaveLength(1)
    // operator-only: goes to the allowlist HEAD, and carries a keyboard (Dismiss)
    expect(cap.sent[0].chatId).toBe('op')
    expect(cap.sent[0].hasKeyboard).toBe(true)
    expect(cap.sent[0].text).toContain('Repeated stream failures')
    // and only ONE — a 4th event in the same (reset) window does not re-fire yet
    emitTransportTransientEvent(ev(), deps) // 4
    expect(cap.sent).toHaveLength(1)
  })

  it('does not escalate when the events fall outside the window', () => {
    // Two events far apart never reach threshold-3-within-window.
    expect(noteTransportTransientAndShouldEscalate('gymbro', 0)).toBe(false)
    expect(noteTransportTransientAndShouldEscalate('gymbro', 60 * 60_000)).toBe(false)
    expect(noteTransportTransientAndShouldEscalate('gymbro', 120 * 60_000)).toBe(false)
  })

  it('counts per-agent — one agent bursting does not escalate another', () => {
    expect(noteTransportTransientAndShouldEscalate('a', 0)).toBe(false)
    expect(noteTransportTransientAndShouldEscalate('a', 1)).toBe(false)
    expect(noteTransportTransientAndShouldEscalate('b', 2)).toBe(false)
    // a's 3rd crosses; b has only seen 1
    expect(noteTransportTransientAndShouldEscalate('a', 3)).toBe(true)
    expect(noteTransportTransientAndShouldEscalate('b', 4)).toBe(false)
  })
})

describe('renderTransportEscalationCard', () => {
  it('is Dismiss-only with NO Reauth button', () => {
    const { keyboard, text } = renderTransportEscalationCard('gymbro')
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some((b) => b.callback_data?.includes('dismiss'))).toBe(true)
    expect(buttons.some((b) => b.callback_data?.includes('reauth'))).toBe(false)
    expect(text).toContain('gymbro')
  })
})

// ─── flushDeferredUserNotices — turn-outcome gate ────────────────────────────

describe('flushDeferredUserNotices', () => {
  it('sends nothing when the turn delivered a reply (notice dropped)', () => {
    const { deps, cap } = makeDeps()
    cap.resolvedQueue = [{ chatIds: ['user-a'], text: 'notice', agent: 'gymbro', kind: 'transport-transient', atMs: 1, key: 'k' }]
    flushDeferredUserNotices(/* turnDeliveredReply */ true, 'k', deps)
    expect(cap.lastResolve).toEqual({ delivered: true, key: 'k' })
    expect(cap.sent).toHaveLength(0)
  })

  it('flushes the plain notice (no keyboard) when the turn ended reply-less', () => {
    const { deps, cap } = makeDeps()
    cap.resolvedQueue = [{ chatIds: ['user-a', 'user-b'], text: 'notice', agent: 'gymbro', kind: 'transport-transient', atMs: 1, key: 'k' }]
    flushDeferredUserNotices(/* turnDeliveredReply */ false, 'k', deps)
    expect(cap.sent.map((s) => s.chatId)).toEqual(['user-a', 'user-b'])
    // plain user notice — never a card/keyboard
    expect(cap.sent.every((s) => s.hasKeyboard === false)).toBe(true)
    expect(cap.sent.every((s) => s.text === 'notice')).toBe(true)
  })

  it('does nothing when no notices resolve', () => {
    const { deps, cap } = makeDeps()
    flushDeferredUserNotices(false, 'k', deps)
    expect(cap.sent).toHaveLength(0)
  })
})
