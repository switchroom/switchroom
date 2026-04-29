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

  it('setThinking is debounced by 700ms', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()
    expect(calls).toEqual(['👀'])

    ctrl.setThinking()
    await flush()
    // Not yet — debounce window
    expect(calls).toEqual(['👀'])

    vi.advanceTimersByTime(700)
    await flush()
    expect(calls).toEqual(['👀', '🤔'])
  })

  it('rapid intermediate transitions only emit the last one (coalesces)', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    // Simulate model flashing thinking → tool → thinking → coding within 200ms
    ctrl.setThinking()
    vi.advanceTimersByTime(100)
    ctrl.setTool('Bash')
    vi.advanceTimersByTime(100)
    ctrl.setThinking()
    vi.advanceTimersByTime(100)
    ctrl.setTool('Read')
    await flush()

    // Still nothing — debounce hasn't elapsed
    expect(calls).toEqual(['👀'])

    vi.advanceTimersByTime(700)
    await flush()
    // Only the final state lands (Read → coding 👨‍💻)
    expect(calls).toEqual(['👀', '👨‍💻'])
  })

  it('setDone is terminal and bypasses debounce', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    ctrl.setDone()
    await flush()
    expect(calls).toEqual(['👀', '👍'])

    // Subsequent calls are no-ops
    ctrl.setThinking()
    vi.advanceTimersByTime(5000)
    await flush()
    expect(calls).toEqual(['👀', '👍'])
  })

  it('setError is terminal', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()

    ctrl.setError()
    await flush()
    expect(calls).toEqual(['👀', '😱'])

    ctrl.setThinking()
    vi.advanceTimersByTime(5000)
    await flush()
    expect(calls).toEqual(['👀', '😱'])
  })

  it('issue #132: setSilent is terminal and uses 🙊 (distinct from 👍 done)', async () => {
    const { emit, calls } = makeEmitter()
    const ctrl = new StatusReactionController(emit)
    ctrl.setQueued()
    await flush()
    ctrl.setTool('Bash')
    vi.advanceTimersByTime(800)
    await flush()

    // Turn ends without producing a reply.
    ctrl.setSilent()
    await flush()
    // 🙊 is in the Telegram bot reaction whitelist (speak-no-evil monkey).
    // The choice signals "agent ran tools but said nothing" — distinct
    // from 👍 which the user reads as "agent acknowledged with a reply".
    // setTool('Bash') resolves to the 'coding' state → 👨‍💻 (first variant).
    expect(calls).toEqual(['👀', '👨‍💻', '🙊'])

    // Subsequent calls are no-ops (terminal).
    ctrl.setThinking()
    vi.advanceTimersByTime(5000)
    await flush()
    expect(calls).toEqual(['👀', '👨‍💻', '🙊'])
  })

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
    vi.advanceTimersByTime(800)
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
    vi.advanceTimersByTime(700)
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

    ctrl.setDone() // also immediate (terminal)
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
})
