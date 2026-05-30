import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  StatusReactionController,
  resolveToolReactionState,
  REACTION_VARIANTS,
  TELEGRAM_REACTION_WHITELIST,
} from '../status-reactions.js'

function makeEmitter() {
  const calls: string[] = []
  const emit = vi.fn(async (emoji: string) => {
    calls.push(emoji)
  })
  return { emit, calls }
}

async function flush() {
  // Drain the microtask queue (chainPromise.then callbacks). Cannot use
  // setTimeout here because vi.useFakeTimers() would freeze it.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
  }
}

describe('resolveToolReactionState', () => {
  it('maps shell-class tools to coding', () => {
    expect(resolveToolReactionState('Bash')).toBe('coding')
    expect(resolveToolReactionState('exec_command')).toBe('coding')
    expect(resolveToolReactionState('shell_run')).toBe('coding')
  })

  it('maps file-class tools to coding', () => {
    expect(resolveToolReactionState('Read')).toBe('coding')
    expect(resolveToolReactionState('Write')).toBe('coding')
    expect(resolveToolReactionState('Edit')).toBe('coding')
    expect(resolveToolReactionState('MultiEdit')).toBe('coding')
    expect(resolveToolReactionState('Glob')).toBe('coding')
    expect(resolveToolReactionState('Grep')).toBe('coding')
  })

  it('maps web-class tools to web', () => {
    expect(resolveToolReactionState('WebFetch')).toBe('web')
    expect(resolveToolReactionState('WebSearch')).toBe('web')
    expect(resolveToolReactionState('browser_navigate')).toBe('web')
  })

  it('falls back to generic tool for everything else', () => {
    expect(resolveToolReactionState('mcp__hindsight__remember')).toBe('tool')
    expect(resolveToolReactionState('TodoCreate')).toBe('tool')
    // TodoWrite contains "write" so it correctly maps to coding
    expect(resolveToolReactionState('TodoWrite')).toBe('coding')
  })
})

describe('REACTION_VARIANTS', () => {
  it('every variant in every state is in the Telegram whitelist', () => {
    for (const [state, variants] of Object.entries(REACTION_VARIANTS)) {
      for (const v of variants) {
        expect(TELEGRAM_REACTION_WHITELIST.has(v),
          `${state} variant "${v}" is not in Telegram's reaction whitelist`,
        ).toBe(true)
      }
    }
  })

  it('🔥 is not in active-work states (queued/tool/coding/web) — #320', () => {
    const activeWorkStates = ['queued', 'tool', 'coding', 'web'] as const
    for (const state of activeWorkStates) {
      expect(REACTION_VARIANTS[state]).not.toContain('🔥')
    }
  })

  it('done includes at least one positive completion emoji (👍 or 💯)', () => {
    const done = REACTION_VARIANTS['done']
    const hasPositive = done.includes('👍') || done.includes('💯')
    expect(hasPositive).toBe(true)
  })
})

describe('StatusReactionController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('setQueued emits the queued emoji immediately', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()
    expect(calls).toEqual(['👀'])
  })

  it('setThinking is debounced by 3500ms (#1713)', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()
    expect(calls).toEqual(['👀'])

    ctrl.setThinking()
    await flush()
    // Not yet — debounce window
    expect(calls).toEqual(['👀'])

    vi.advanceTimersByTime(3500)
    await flush()
    expect(calls).toEqual(['👀', '🤔'])
  })

  it('rapid intermediate transitions only emit the last one (coalesces) — #1713', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    // Simulate model flashing thinking → tool → thinking → coding within 1.2s
    ctrl.setThinking()
    vi.advanceTimersByTime(400)
    ctrl.setTool('Bash')
    vi.advanceTimersByTime(400)
    ctrl.setThinking()
    vi.advanceTimersByTime(400)
    ctrl.setTool('Read')
    await flush()

    // Still nothing — debounce hasn't elapsed
    expect(calls).toEqual(['👀'])

    vi.advanceTimersByTime(3500)
    await flush()
    // Only the final state lands (Read → coding 👨‍💻)
    expect(calls).toEqual(['👀', '👨‍💻'])
  })

  it('finalize() is the only terminal trigger and bypasses debounce (#1713)', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    ctrl.finalize('done')
    await flush()
    expect(calls).toEqual(['👀', '👍'])

    // Subsequent calls are no-ops
    ctrl.setThinking()
    vi.advanceTimersByTime(5000)
    await flush()
    expect(calls).toEqual(['👀', '👍'])
  })

  it('setError is NON-terminal — recovery to a working state is allowed (#1713)', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    ctrl.setError()
    // setError is debounced (it's a normal working transition now).
    vi.advanceTimersByTime(3500)
    await flush()
    expect(calls).toEqual(['👀', '😱'])

    // Recovery to thinking is permitted — the controller is NOT finished.
    ctrl.setThinking()
    vi.advanceTimersByTime(3500)
    await flush()
    expect(calls).toEqual(['👀', '😱', '🤔'])

    // Only finalize() ends.
    ctrl.finalize('done')
    await flush()
    expect(calls).toEqual(['👀', '😱', '🤔', '👍'])
  })

  it('finalize("error") terminates with 😱 (#1713)', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    ctrl.finalize('error')
    await flush()
    expect(calls).toEqual(['👀', '😱'])

    // Subsequent calls are no-ops — terminal.
    ctrl.setThinking()
    vi.advanceTimersByTime(5000)
    await flush()
    expect(calls).toEqual(['👀', '😱'])
  })

  it('working transitions are bidirectional — thinking → tool → thinking (#1713)', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    ctrl.setThinking()
    vi.advanceTimersByTime(3500)
    await flush()
    expect(calls).toEqual(['👀', '🤔'])

    ctrl.setTool('Bash')
    vi.advanceTimersByTime(3500)
    await flush()
    expect(calls).toEqual(['👀', '🤔', '👨‍💻'])

    // Back to thinking — same state can re-enter.
    ctrl.setThinking()
    vi.advanceTimersByTime(3500)
    await flush()
    expect(calls).toEqual(['👀', '🤔', '👨‍💻', '🤔'])
  })

  // #1713: setSilent was deleted as dead code. The "turn ended without a
  // reply" path now finalizes to 👍 like any other turn — `turn_end` is
  // the terminal trigger, regardless of whether a reply landed. The
  // distinct-silent-emoji concept was never wired into production
  // anyway (no live callers as of the issue audit).

  it('promotes to stallSoft after 30s of no progress', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    // No further calls — stall watchdog should fire at 30s
    vi.advanceTimersByTime(30000)
    await flush()
    expect(calls).toContain('🥱')
  })

  it('promotes to stallHard after 90s of no progress', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    vi.advanceTimersByTime(30000) // stallSoft
    await flush()
    vi.advanceTimersByTime(60000) // total 90s → stallHard
    await flush()
    expect(calls).toContain('😨')
  })

  it('progress signals reset the stall timer', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    // Tick 25s, then signal progress
    vi.advanceTimersByTime(25000)
    ctrl.setThinking() // resets stall timers
    vi.advanceTimersByTime(3500)
    await flush()
    // We should have queued + thinking, but no stall yet
    expect(calls).toEqual(['👀', '🤔'])

    // Now wait another 20s (total 45s since queued, but only 20s since thinking)
    vi.advanceTimersByTime(20000)
    await flush()
    // Still no stall — the tick reset the watchdog
    expect(calls).toEqual(['👀', '🤔'])
  })

  it('cancel stops further reactions silently', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    ctrl.cancel()
    ctrl.setThinking()
    vi.advanceTimersByTime(5000)
    await flush()
    // Only the queued emoji landed; thinking was suppressed
    expect(calls).toEqual(['👀'])
  })

  it('skips emoji not in the chat allowed set', async () => {
    const { emit, calls } = makeEmitter()
    // This chat only allows 👍 and 🔥
    const allowed = new Set(['👍', '🔥'])
    const ctrl = new StatusReactionController(emit, allowed)

    ctrl.setQueued() // wants 👀, then 🤔, then 🤓 — none allowed; broad fallback picks 👍
    await flush()
    // 👀, 🤔, 🤓 — none in allowed; broad fallback hits 👍 → 👍
    expect(calls).toEqual(['👍'])

    ctrl.setThinking() // wants 🤔, falls back through variants, then generic — none in allowed
    vi.advanceTimersByTime(3500)
    await flush()
    // 🤔, 🤓, 👀 — none allowed; broad fallback hits 👍 but it's already current → no emit
    expect(calls).toEqual(['👍'])
  })

  it('serializes API calls through the chain promise', async () => {
    let resolveFirst: () => void = () => {}
    const firstPromise = new Promise<void>(r => (resolveFirst = r))
    const order: string[] = []

    const emit = vi.fn(async (emoji: string) => {
      if (emoji === '👀') {
        await firstPromise
      }
      order.push(emoji)
    })

    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued() // immediate
    await flush()
    // First call is in flight, blocked on firstPromise

    ctrl.finalize() // also immediate (terminal)
    await flush()

    // The done call should be queued behind the in-flight queued call
    expect(order).toEqual([])

    resolveFirst()
    await flush()
    expect(order).toEqual(['👀', '👍'])
  })

  it('does not re-emit the same emoji', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()
    ctrl.setQueued()
    await flush()
    ctrl.setQueued()
    await flush()
    expect(calls).toEqual(['👀'])
  })

  // setAwaiting(): park on 🙏 while a permission card waits for the
  // operator. A turn blocked on a human is NOT stalled, so the watchdog
  // must stay quiet — but it re-arms once the verdict resumes work.
  describe('setAwaiting() — park on a human permission decision', () => {
    it('emits 🙏 immediately (bypasses debounce)', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      await flush()
      ctrl.setAwaiting()
      await flush()
      expect(calls).toEqual(['👀', '🙏'])
    })

    it('suppresses stall promotion (no 🥱/😨) while the card sits unanswered', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      ctrl.setTool('Bash') // working: 👨‍💻
      vi.advanceTimersByTime(3500)
      await flush()
      ctrl.setAwaiting()
      await flush()
      // Well past both stall thresholds — awaiting must not yawn or panic.
      vi.advanceTimersByTime(120000)
      await flush()
      expect(calls).not.toContain('🥱')
      expect(calls).not.toContain('😨')
      expect(calls[calls.length - 1]).toBe('🙏')
    })

    it('re-arms the stall watchdog once a working transition resumes the turn', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      await flush()
      ctrl.setAwaiting()
      await flush()
      vi.advanceTimersByTime(120000) // long human wait — no stall
      await flush()
      expect(calls).toEqual(['👀', '🙏'])

      // Verdict dispatched → gateway calls setThinking() to un-park.
      ctrl.setThinking()
      vi.advanceTimersByTime(3500)
      await flush()
      expect(calls).toEqual(['👀', '🙏', '🤔'])

      // A genuine post-approval hang must still promote to 🥱 — the
      // watchdog was re-armed by the resuming transition.
      vi.advanceTimersByTime(30000)
      await flush()
      expect(calls).toContain('🥱')
    })

    it('is a no-op after finalize (cannot resurrect a finished controller)', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      ctrl.finalize('done')
      await flush()
      const snapshot = [...calls]
      ctrl.setAwaiting()
      vi.advanceTimersByTime(5000)
      await flush()
      expect(calls).toEqual(snapshot)
    })
  })

  // hold(): freeze on a WORKING glyph while background sub-agent workers
  // outlive the parent turn, deferring the terminal 👍 (worker-reaction fix).
  describe('hold() — defer 👍 while a background worker runs', () => {
    it('suppresses stall promotion (no 🥱/😨) while held', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      ctrl.setTool('Bash') // working: 👨‍💻
      vi.advanceTimersByTime(3500)
      await flush()

      ctrl.hold()
      await flush()
      // Well past both stall thresholds — held must not yawn or panic.
      vi.advanceTimersByTime(120000)
      await flush()
      expect(calls).not.toContain('🥱')
      expect(calls).not.toContain('😨')
    })

    it('promotes a read/thinking glyph to a working glyph on hold', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued() // 👀 (read-receipt)
      await flush()
      expect(calls).toEqual(['👀'])

      ctrl.hold() // should paint an explicit WORKING glyph (✍️)
      await flush()
      expect(calls[calls.length - 1]).toBe('✍')
    })

    it('finalize() still terminates to 👍 after hold (deferred terminal)', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      ctrl.setTool() // ✍
      vi.advanceTimersByTime(3500)
      await flush()

      ctrl.hold()
      await flush()
      // Worker runs for a while, then completes → gateway finalizes.
      vi.advanceTimersByTime(60000)
      await flush()
      ctrl.finalize('done')
      await flush()
      expect(calls[calls.length - 1]).toBe('👍')
    })

    it('does not double-paint when already on a working glyph', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      ctrl.setTool() // ✍
      vi.advanceTimersByTime(3500)
      await flush()
      const before = calls.length

      ctrl.hold() // already on ✍ → no new emit
      await flush()
      expect(calls.length).toBe(before)
    })

    it('hold() after finalize is a no-op (cannot resurrect a finished controller)', async () => {
      const { emit, calls } = makeEmitter()
      const ctrl = new StatusReactionController(emit)
      ctrl.setQueued()
      ctrl.finalize('done')
      await flush()
      const snapshot = [...calls]

      ctrl.hold()
      vi.advanceTimersByTime(120000)
      await flush()
      expect(calls).toEqual(snapshot)
    })
  })
})
