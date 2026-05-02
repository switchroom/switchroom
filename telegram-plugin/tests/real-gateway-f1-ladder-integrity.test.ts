/**
 * F1 — "ladder collapse" — regression test against real-gateway harness.
 *
 * Symptom from #545: on a Class B turn (1–3 tool calls, < ~15s), the
 * status reaction jumps straight from 👀 to 👍, skipping the
 * intermediate 🤔 (thinking) and 🔥 (tool work) states. User loses the
 * "agent is doing things" signal.
 *
 * Root cause: `StatusReactionController.scheduleState()` debounces
 * non-immediate transitions (default `debounceMs=700`). When a turn
 * completes faster than the debounce window, intermediate states never
 * cross the timer — `setDone()` calls `finishWithState()` which
 * `clearDebounceTimer()`s and emits 👍 directly, dropping the pending
 * 🤔/🔥.
 *
 * Spec contract from `waiting-ux-spec.md`:
 *
 *   F1: ladder integrity — for Class B turns, recorded reaction
 *       sequence MUST contain 👀 followed by at least one
 *       intermediate state (🤔 / 🔥 / a tool-specific reaction)
 *       BEFORE 👍. No straight-to-👍 collapse.
 *
 * The fix flushes any pending non-terminal reaction before the
 * terminal 👍 emits. Tracking: #545 (parent), #553 (Phase 3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/**
 * Dedupe consecutive duplicate reactions in the recorded sequence.
 * The post-F2 harness fires 👀 twice (early-ack + controller setQueued);
 * Telegram dedupes by emoji so consecutive duplicates are visually one
 * step. Tests asserting ladder integrity should ignore them.
 */
function uniqueLadder(seq: string[]): string[] {
  const out: string[] = []
  for (const e of seq) {
    if (out[out.length - 1] !== e) out.push(e)
  }
  return out
}

describe('F1 — ladder integrity (no straight-to-👍 collapse)', () => {
  it('Class B sub-debounce turn (~500ms): pending tool reaction MUST emit before 👍', async () => {
    // The exact failure case from the live demo: a turn that completes
    // faster than the controller's 700ms debounce window. Pre-fix, the
    // 🔥 reaction was scheduled but cancelled when setDone() cleared
    // the debounce timer. User saw 👀 → 👍 with no intermediate state.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'quick task' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'quick task' })
    await h.clock.advance(50)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(50)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash' })
    await h.clock.advance(400) // tool runs ~400ms, total turn ~500ms — under 700ms debounce
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 500 })
    await h.clock.advance(1500) // settle, well past debounce window

    const ladder = uniqueLadder(h.recorder.reactionSequence())
    expect(ladder[0]).toBe('👀')
    expect(ladder[ladder.length - 1]).toBe('👍')
    // Must contain at least one intermediate — no straight 👀 → 👍 collapse.
    expect(ladder.length).toBeGreaterThanOrEqual(3)
    h.finalize()
  })

  it('Class B medium turn (~2s, single tool): ladder shows 👀 → tool reaction → 👍', async () => {
    // Slower turn (single 2s tool) — works correctly even pre-fix because
    // 2000ms > 700ms debounce. Pin so the fix doesn't regress the working case.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'medium task' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'medium task' })
    await h.clock.advance(50)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash' })
    await h.clock.advance(2000)
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 2300 })
    await h.clock.advance(1000)

    const ladder = uniqueLadder(h.recorder.reactionSequence())
    expect(ladder[0]).toBe('👀')
    expect(ladder[ladder.length - 1]).toBe('👍')
    expect(ladder.length).toBeGreaterThanOrEqual(3)
    h.finalize()
  })

  it('Class B 3-tool series at sub-debounce intervals: each transition shows', async () => {
    // Three rapid tool transitions inside a single debounce window.
    // Pre-fix, only the LAST one would survive (the others got
    // overwritten by the next setTool). We don't strictly require all
    // three to appear (the controller can collapse same-emoji adjacent
    // calls) — but the FINAL pending state before 👍 must emit.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'rapid tools' })
    h.feedSessionEvent({ kind: 'enqueue', chatId: CHAT, messageId: '1', threadId: null, rawContent: 'rapid tools' })
    await h.clock.advance(50)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(50)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read' })
    await h.clock.advance(100)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash' })
    await h.clock.advance(100)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Edit' })
    await h.clock.advance(200)
    h.feedSessionEvent({ kind: 'turn_end', durationMs: 500 })
    await h.clock.advance(1500)

    const ladder = uniqueLadder(h.recorder.reactionSequence())
    expect(ladder[0]).toBe('👀')
    expect(ladder[ladder.length - 1]).toBe('👍')
    expect(ladder.length).toBeGreaterThanOrEqual(3)
    h.finalize()
  })
})
