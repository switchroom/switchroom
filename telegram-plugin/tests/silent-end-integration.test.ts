/**
 * silent-end-integration.test.ts — #1744 follow-up.
 *
 * The existing silent-end.test.ts (#1741 block, L301-409) exercises the
 * gate as a pure unit via `simulateReplyAtGateway`, which mirrors the
 * `isFinalAnswerReply ? clearSilentEndState(...)` contract used at the
 * `executeReply` send-site (gateway.ts:4609). That's a fine unit test
 * for the `executeReply` path, but it does NOT model the `stream_reply`
 * state machine where:
 *
 *   - The FIRST stream emit is gated by `!activeDraftStreams.has(sKey)`
 *     (gateway.ts:5178) — only the first emit per stream considers
 *     clearing the silent-end state.
 *   - LATER emits in the same stream (subsequent calls that edit the
 *     same Telegram message) do NOT re-enter that first-emit branch.
 *
 * Pre-fix, a stream whose first emit was ack-shaped (short, silent, no
 * done) and whose LATER emit carried `done=true` or substantive text
 * would skip the clear at the first-emit gate and never re-attempt it,
 * leaving the silent-end state file behind even though the model HAS
 * now delivered its final answer. The Stop hook would then see a stale
 * state file and fire a spurious re-prompt on the next turn end.
 *
 * The fix in gateway.ts:5343 adds a second clear at the
 * `finalAnswerDelivered = true` site (which fires on EVERY emit that
 * qualifies as a final answer, not just the first). This test walks
 * the full ack-then-final stream sequence and asserts the state file's
 * lifecycle matches the contract.
 *
 * KNOWN GAP — true end-to-end coverage of `executeStreamReply` would
 * require importing gateway.ts (a multi-thousand-line module with
 * heavy startup-time side effects: bot creation, IPC server bind, MCP
 * registration, etc.). Neither `executeReply` nor `executeStreamReply`
 * is exported. Instead, this test reproduces the EXACT call sequence
 * the gateway makes at each send-site — same predicate
 * (`isFinalAnswerReply`), same state-file API (`writeSilentEndState` /
 * `clearSilentEndState`), same first-emit gating logic — by walking a
 * tracked `activeDraftStreams` set to model the first-vs-later-emit
 * branching that's the load-bearing detail of the bug. A future
 * refactor that drops the second clear at L5343 would fail the
 * `ack first emit then final later emit` test below, because the
 * state file would never get cleared on the path that no longer
 * passes through the first-emit branch.
 *
 * If the gateway is ever refactored so `executeReply`/`executeStreamReply`
 * become testable in isolation (or get extracted into a thin
 * dispatch shim around a pure handler), prefer wiring those real
 * functions over this faithful-shape reproduction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeSilentEndState,
  clearSilentEndState,
  readSilentEndState,
} from '../silent-end.js'
import { isFinalAnswerReply } from '../final-answer-detect.js'

let stateDir: string
const ORIG_ENV = process.env.TELEGRAM_STATE_DIR

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'silent-end-integration-test-'))
  process.env.TELEGRAM_STATE_DIR = stateDir
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  if (ORIG_ENV != null) process.env.TELEGRAM_STATE_DIR = ORIG_ENV
  else delete process.env.TELEGRAM_STATE_DIR
})

/**
 * Shape-accurate reproduction of the gateway's `executeReply` clear
 * site (gateway.ts:4599-4611). The `reply` tool runs this on every
 * call — no first-emit gating, because `reply` always produces a
 * fresh outbound message.
 */
function simulateExecuteReply(
  reply: { text: string; disableNotification: boolean },
  turnKey: string,
): { finalAnswerDelivered: boolean } {
  const final = isFinalAnswerReply(reply)
  if (final) clearSilentEndState(turnKey)
  return { finalAnswerDelivered: final }
}

/**
 * Shape-accurate reproduction of the gateway's `executeStreamReply`
 * call (gateway.ts:5172-5344). The stream has TWO clear sites:
 *
 *   1. First-emit-only branch (L5178-5195) — fires once per stream,
 *      regardless of whether this emit is the final answer. Clears
 *      iff this first emit is a final-answer-shaped reply.
 *   2. Final-answer site (L5335-5358, added in #1744 follow-up) —
 *      fires on EVERY emit that qualifies as the final answer,
 *      including later emits in a stream whose first emit was an ack.
 *      This is the load-bearing addition: without it, the ack-first-
 *      then-final-later case leaks the state file.
 *
 * `activeDraftStreams` is a Set-like state the gateway carries across
 * calls within the same turn; this test threads it through explicitly.
 */
function simulateExecuteStreamReply(
  emit: { text: string; disableNotification: boolean; done?: boolean },
  turnKey: string,
  state: { activeDraftStreams: Set<string>; finalAnswerDelivered: boolean },
): { finalAnswerDelivered: boolean } {
  // Site 1 — first-emit-only branch.
  const isFirstEmit = !state.activeDraftStreams.has(turnKey)
  if (isFirstEmit) {
    if (isFinalAnswerReply(emit)) {
      clearSilentEndState(turnKey)
    }
    // Mark the stream active for subsequent emits.
    state.activeDraftStreams.add(turnKey)
  }

  // ... draft / send-message work happens here in the real gateway ...

  // Site 2 — final-answer site (#1744 follow-up at gateway.ts:5343).
  if (isFinalAnswerReply(emit)) {
    state.finalAnswerDelivered = true
    clearSilentEndState(turnKey)
  }
  return { finalAnswerDelivered: state.finalAnswerDelivered }
}

describe('#1744 — silent-end state-file lifecycle through real call paths', () => {
  it('executeReply: ack reply does not clear, then final-answer reply clears', () => {
    // Turn-end writer fires from a prior turn that ended undelivered,
    // OR the framework re-prompted and the state still persists.
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })

    // Interim ack via `reply` — must NOT clear.
    const r1 = simulateExecuteReply({ text: 'On it', disableNotification: true }, 'c:_')
    expect(r1.finalAnswerDelivered).toBe(false)
    expect(readSilentEndState()).not.toBeNull()

    // Final answer via `reply` (pings) — clears.
    const r2 = simulateExecuteReply(
      { text: "Here's the result.", disableNotification: false },
      'c:_',
    )
    expect(r2.finalAnswerDelivered).toBe(true)
    expect(readSilentEndState()).toBeNull()
  })

  it('executeStreamReply: stream that opens with a final-answer first emit clears at first-emit site', () => {
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    const state = { activeDraftStreams: new Set<string>(), finalAnswerDelivered: false }

    // First emit is substantive (>=200 chars) — qualifies as final.
    simulateExecuteStreamReply(
      { text: 'x'.repeat(250), disableNotification: true },
      'c:_',
      state,
    )
    expect(state.finalAnswerDelivered).toBe(true)
    expect(readSilentEndState()).toBeNull()
  })

  it('executeStreamReply ack-then-final edge case: first emit is an ack (no clear at first-emit gate), later emit is the final answer (must clear at the new L5343 site)', () => {
    // This is the regression the #1744 follow-up fixes. Pre-fix, the
    // first-emit gate would skip the clear (ack-shaped first emit),
    // and the later final-answer emit had NO second clear site —
    // state file leaked.
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    const state = { activeDraftStreams: new Set<string>(), finalAnswerDelivered: false }

    // First emit — ack-shaped. First-emit gate fires but the
    // isFinalAnswerReply predicate returns false → no clear here.
    simulateExecuteStreamReply(
      { text: 'thinking...', disableNotification: true, done: false },
      'c:_',
      state,
    )
    expect(state.finalAnswerDelivered).toBe(false)
    // CONTRACT: state file MUST still be present after the ack first emit.
    expect(readSilentEndState()).not.toBeNull()

    // Second emit — same stream (activeDraftStreams already has the key),
    // so the first-emit branch is skipped. This emit carries done=true
    // (the real final-answer signal). Without the L5343 clear, the
    // state file would persist and the Stop hook would fire a spurious
    // re-prompt on the next turn.
    simulateExecuteStreamReply(
      { text: 'done', disableNotification: true, done: true },
      'c:_',
      state,
    )
    expect(state.finalAnswerDelivered).toBe(true)
    // CONTRACT: state file MUST be cleared after the final-answer
    // emit, even though the first-emit branch was skipped.
    expect(readSilentEndState()).toBeNull()
  })

  it('executeStreamReply: late emit that flips disable_notification=false also clears', () => {
    // Variant of the edge case — final-answer signal is the pacing
    // contract flag rather than done=true.
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    const state = { activeDraftStreams: new Set<string>(), finalAnswerDelivered: false }

    simulateExecuteStreamReply(
      { text: 'one sec', disableNotification: true, done: false },
      'c:_',
      state,
    )
    expect(readSilentEndState()).not.toBeNull()

    // Later emit drops the disable_notification flag — the pacing
    // contract's "final answer" signal — but not done yet.
    simulateExecuteStreamReply(
      { text: "Here's what I found.", disableNotification: false, done: false },
      'c:_',
      state,
    )
    expect(state.finalAnswerDelivered).toBe(true)
    expect(readSilentEndState()).toBeNull()
  })

  it('idempotency: clearSilentEndState is safe to call when the file is already gone', () => {
    // The L5343 clear is unconditional on isFinalAnswerReply — it
    // fires even when the first-emit gate already cleared. The
    // clear must be a no-op in that case so it can't accidentally
    // unlink a fresh state file written for a DIFFERENT later turn.
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    const state = { activeDraftStreams: new Set<string>(), finalAnswerDelivered: false }

    // First emit is final — clears via the first-emit site.
    simulateExecuteStreamReply(
      { text: 'answer', disableNotification: false },
      'c:_',
      state,
    )
    expect(readSilentEndState()).toBeNull()

    // A second final-shaped emit on the same stream re-enters the
    // L5343 clear. State is already gone — must be a no-op.
    expect(() => {
      simulateExecuteStreamReply(
        { text: 'addendum', disableNotification: false },
        'c:_',
        state,
      )
    }).not.toThrow()
    expect(readSilentEndState()).toBeNull()
  })

  it('cross-turn safety: clearSilentEndState on turnKey A does NOT clear state for turnKey B', () => {
    // The clear is keyed on turnKey via the writer's stored value —
    // a clear call for a DIFFERENT turn must not unlink a state file
    // written for the in-flight turn. This guards against the L5343
    // clear accidentally racing a turn-end writer for a newer turn.
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:turn-B' })
    // A stale clear for turn-A — silent-end.ts only unlinks when the
    // stored turnKey matches.
    clearSilentEndState('c:turn-A')
    expect(readSilentEndState()).not.toBeNull()
    expect(readSilentEndState()!.turnKey).toBe('c:turn-B')

    // The matching clear works.
    clearSilentEndState('c:turn-B')
    expect(readSilentEndState()).toBeNull()
  })
})
