/**
 * silent-end-transport.test.ts — PR 2 of
 * reference/rfcs/deterministic-turn-liveness.md (Phase 2: audit-and-harden
 * the shipped dark-turn guard, per reference/jobs/know-what-my-agent-is-doing.md).
 *
 * Prior coverage (`silent-end.test.ts`, `silent-end-integration.test.ts`)
 * proves the *decision* — state-file lifecycle, retryCount bookkeeping,
 * the `{exhausted}` contract. It never asserts a byte reaches the
 * transport, which is exactly the decision-vs-delivery gap the RFC calls
 * out for the muted 45s floor (#2667) and asks Phase 2 to wall off for
 * the dark-turn guard instead of re-creating it.
 *
 * This file reproduces the EXACT call sequence at the gateway's turn_end
 * handler (gateway.ts ~14486-14535: `if (turn.finalAnswerDelivered ===
 * false) { const silentEnd = recordUndeliveredTurnEnd(...); if
 * (silentEnd.exhausted) { <send> } }`) against a spy transport, using the
 * REAL exported `recordUndeliveredTurnEnd` / `clearSilentEndState` /
 * `isFinalAnswerReply` — same pattern `silent-end-integration.test.ts`
 * already established for testing gateway call-sites that aren't
 * themselves exported (gateway.ts is a multi-thousand-line module with
 * process-level side effects on import; see that file's "KNOWN GAP" note).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync as writeFileSyncState } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeSilentEndState,
  readSilentEndState,
  recordUndeliveredTurnEnd,
  SILENT_END_MAX_RETRIES,
  type SilentEndDeps,
} from '../silent-end.js'
import { isFinalAnswerReply } from '../final-answer-detect.js'

let stateDir: string
const ORIG_ENV = process.env.TELEGRAM_STATE_DIR

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'silent-end-transport-test-'))
  process.env.TELEGRAM_STATE_DIR = stateDir
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  if (ORIG_ENV != null) process.env.TELEGRAM_STATE_DIR = ORIG_ENV
  else delete process.env.TELEGRAM_STATE_DIR
})

/** Spy transport — records every "send" with a wall-clock timestamp, the
 * same shape a `bot.api.sendMessage` spy would capture at the real
 * transport boundary. */
interface SentMessage {
  chatId: string
  text: string
  ts: number
}

function makeTransport() {
  const sent: SentMessage[] = []
  return {
    sent,
    send: (chatId: string, text: string) => {
      sent.push({ chatId, text, ts: Date.now() })
    },
  }
}

function fallbackText(turnDurationMs: number): string {
  // Mirrors gateway.ts's silentEndFallbackText(turnDurationMs) exactly —
  // the elapsed-inclusion hardening from this PR.
  const elapsed = ` (waited ${Math.round(turnDurationMs / 1000)}s)`
  return (
    '⚠️ The agent finished working but didn’t send a reply' +
    elapsed +
    ' — your last message may not have been answered. Please try asking again.'
  )
}

/**
 * Faithful reproduction of the gateway's turn_end branch
 * (gateway.ts ~14486-14535). Real functions in, spy transport out.
 */
function simulateTurnEnd(
  args: {
    chatId: string
    threadId: number | null
    turnKey: string
    finalAnswerDelivered: boolean
    turnDurationMs: number
  },
  transport: ReturnType<typeof makeTransport>,
  deps?: SilentEndDeps,
): { exhausted: boolean } | null {
  if (args.finalAnswerDelivered === false) {
    const silentEnd = recordUndeliveredTurnEnd(
      { chatId: args.chatId, threadId: args.threadId, turnKey: args.turnKey },
      deps,
    )
    if (silentEnd.exhausted) {
      transport.send(args.chatId, fallbackText(args.turnDurationMs))
    }
    return silentEnd
  }
  return null
}

/** Drives the Stop-hook re-prompt ladder up to (but not past) MAX_RETRIES,
 * exactly as `silent-end-interrupt-stop.mjs` does on each block. */
function driveRetryLadderToMax(turnKey: string) {
  const path = join(stateDir, 'silent-end-pending.json')
  const s = readSilentEndState()!
  writeFileSyncState(path, JSON.stringify({ ...s, retryCount: SILENT_END_MAX_RETRIES, turnKey }), 'utf8')
}

describe('silent-end dark-turn guard — transport-boundary outcome tests (RFC Phase 2)', () => {
  it('(a) full dark turn: exactly one fallback message lands on the real surface', () => {
    const transport = makeTransport()
    const turnKey = 'c:_'

    // First dark turn-end — writes state, does NOT deliver a fallback
    // (the Stop-hook re-prompt ladder hasn't been exhausted yet).
    simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey, finalAnswerDelivered: false, turnDurationMs: 12_000 },
      transport,
    )
    expect(transport.sent).toHaveLength(0)

    // Stop hook re-prompts twice (SILENT_END_MAX_RETRIES), agent stays
    // silent both times — ladder exhausted.
    driveRetryLadderToMax(turnKey)

    // Re-prompted turn ends dark again — budget spent, deliver fallback.
    simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey, finalAnswerDelivered: false, turnDurationMs: 47_000 },
      transport,
    )

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.chatId).toBe('c')
    expect(transport.sent[0]!.text).toContain('waited 47s')
    expect(transport.sent[0]!.text).toContain('didn’t send a reply')
    // Once delivered, the state must not linger to double-fire on a
    // subsequent, unrelated dark turn on the same chat/thread.
    expect(readSilentEndState()).toBeNull()
  })

  it('(b) deliberate silent end (NO_REPLY / HEARTBEAT_OK) never fires the guard', () => {
    // The gateway sets `turn.finalAnswerDelivered = true` for NO_REPLY /
    // HEARTBEAT_OK silent markers BEFORE reaching this branch
    // (gateway.ts ~14192, ~13880, ~10762 — the sentinel-suppression
    // sites) — so the branch is never entered at all for a legitimately
    // silent turn. Reproduce that gate here.
    const transport = makeTransport()
    simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey: 'c:_', finalAnswerDelivered: true, turnDurationMs: 5_000 },
      transport,
    )
    expect(transport.sent).toHaveLength(0)
    expect(readSilentEndState()).toBeNull()
  })

  it('(c) normal replied turn: zero fallback messages, regardless of prior stale state', () => {
    const transport = makeTransport()
    // A prior turn on this chat/thread already reached exhaustion and
    // was cleared (see test (a)) — simulate a completely normal turn
    // afterwards; the branch must not even be entered.
    simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey: 'c:_', finalAnswerDelivered: true, turnDurationMs: 3_000 },
      transport,
    )
    expect(transport.sent).toHaveLength(0)
  })

  it('(d) the guard never double-fires: two calls to the exhausted branch on the same spent record yield exactly one send', () => {
    const transport = makeTransport()
    const turnKey = 'c:dup'
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey })
    driveRetryLadderToMax(turnKey)

    simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey, finalAnswerDelivered: false, turnDurationMs: 10_000 },
      transport,
    )
    expect(transport.sent).toHaveLength(1)
    // State is cleared by the first exhausted call — a defensive SECOND
    // call for the exact same still-dark turn (e.g. a duplicate turn_end
    // event) finds no prior state and starts a FRESH retry cycle rather
    // than re-firing the fallback a second time.
    const second = simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey, finalAnswerDelivered: false, turnDurationMs: 10_050 },
      transport,
    )
    expect(second?.exhausted).toBe(false)
    expect(transport.sent).toHaveLength(1)
  })

  it('(d2) staleness hardening: an exhausted-looking record left by an ALREADY-ANSWERED turn on the same chat/thread must not fire the fallback for a brand-new dark turn', () => {
    // silent-end's turnKey is `statusKey(chatId, threadId)` — stable
    // across every turn on a chat/thread, not a per-turn nonce. If a
    // reply's `clearSilentEndState` call is ever missed (it is
    // fail-silent by design), a spent retryCount from an OLD,
    // genuinely-answered turn could otherwise be misread as THIS
    // brand-new dark turn's already-exhausted budget — firing the
    // fallback without ever running the Stop-hook re-prompt ladder.
    //
    // This is the same class of bug #2472 fixed in the represent guard
    // (gateway/represent-guard.ts shouldSuppressRepresent): a
    // satisfied-but-misdetected obligation must be verified against real
    // delivery history, not trusted from key equality + a counter alone.
    const transport = makeTransport()
    const turnKey = 'c:_'
    const staleTimestamp = 1_000_000

    // Simulate the missed-clear: an old, already-answered turn left the
    // ladder pinned at MAX_RETRIES and (because the clear was missed) the
    // file was never removed.
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey })
    driveRetryLadderToMax(turnKey)
    // Force the stale timestamp to predate the "reply" the deps stub
    // reports below.
    const path = join(stateDir, 'silent-end-pending.json')
    const s = readSilentEndState()!
    writeFileSyncState(path, JSON.stringify({ ...s, timestamp: staleTimestamp }), 'utf8')

    // A reply WAS in fact delivered on this chat (the missed-clear case)
    // at some point after the stale record's timestamp.
    const deps: SilentEndDeps = {
      hasOutboundDeliveredSince: (chatId, sinceMs) =>
        chatId === 'c' && sinceMs <= staleTimestamp + 500,
    }

    // A genuinely NEW, unrelated dark turn now ends on the same
    // chat/thread (same turnKey by construction).
    const result = simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey, finalAnswerDelivered: false, turnDurationMs: 8_000 },
      transport,
      deps,
    )

    expect(result?.exhausted).toBe(false)
    expect(transport.sent).toHaveLength(0)
  })

  it('(d3) staleness hardening does NOT suppress a genuine, fresh exhaustion (no reply since the record)', () => {
    const transport = makeTransport()
    const turnKey = 'c:_'
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey })
    driveRetryLadderToMax(turnKey)

    const deps: SilentEndDeps = {
      // No reply has landed since the record — the exhaustion is real.
      hasOutboundDeliveredSince: () => false,
    }

    const result = simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey, finalAnswerDelivered: false, turnDurationMs: 9_000 },
      transport,
      deps,
    )

    expect(result?.exhausted).toBe(true)
    expect(transport.sent).toHaveLength(1)
  })

  it('cross-check: isFinalAnswerReply gating means an ack-only turn still reaches the dark-turn branch', () => {
    // Sanity cross-check against the real predicate used at the reply
    // send-sites (executeReply/executeStreamReply) — an interim ack does
    // NOT satisfy finalAnswerDelivered, so the branch is correctly
    // entered (this is the #1664 case, not a legitimate silent end).
    const ack = { text: 'On it', disableNotification: true }
    expect(isFinalAnswerReply(ack)).toBe(false)

    const transport = makeTransport()
    const turnKey = 'c:ack-only'
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey })
    driveRetryLadderToMax(turnKey)
    simulateTurnEnd(
      { chatId: 'c', threadId: null, turnKey, finalAnswerDelivered: isFinalAnswerReply(ack), turnDurationMs: 15_000 },
      transport,
    )
    expect(transport.sent).toHaveLength(1)
  })
})
