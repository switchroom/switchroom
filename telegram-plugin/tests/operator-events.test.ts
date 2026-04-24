import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyClaudeError,
  renderOperatorEvent,
  shouldEmitOperatorEvent,
  clearOperatorEventCooldown,
  resetAllCooldowns,
  DEFAULT_OPERATOR_EVENT_COOLDOWN_MS,
  type OperatorEvent,
  type OperatorEventKind,
} from '../operator-events.js'
import fixturesRaw from '../operator-events.fixtures.json'

// ─── Fixture types ───────────────────────────────────────────────────────────

type FixtureEntry = { _source: string; _value?: unknown; [k: string]: unknown }
type Fixtures = Record<string, FixtureEntry[]>
const fixtures = fixturesRaw as Fixtures

function makeEvent(kind: OperatorEventKind, overrides?: Partial<OperatorEvent>): OperatorEvent {
  return {
    kind,
    agent: 'gymbro',
    detail: '',
    suggestedActions: [],
    firstSeenAt: new Date('2026-04-24T00:00:00Z'),
    ...overrides,
  }
}

// ─── classifyClaudeError — per-fixture coverage ──────────────────────────────

describe('classifyClaudeError — credentials-expired fixtures', () => {
  for (const fixture of fixtures['credentials-expired']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('credentials-expired')
    })
  }
})

describe('classifyClaudeError — credentials-invalid fixtures', () => {
  for (const fixture of fixtures['credentials-invalid']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('credentials-invalid')
    })
  }
})

describe('classifyClaudeError — credit-exhausted fixtures', () => {
  for (const fixture of fixtures['credit-exhausted']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('credit-exhausted')
    })
  }
})

describe('classifyClaudeError — quota-exhausted fixtures', () => {
  for (const fixture of fixtures['quota-exhausted']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('quota-exhausted')
    })
  }
})

describe('classifyClaudeError — rate-limited fixtures', () => {
  for (const fixture of fixtures['rate-limited']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('rate-limited')
    })
  }
})

describe('classifyClaudeError — agent-crashed fixtures', () => {
  for (const fixture of fixtures['agent-crashed']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('agent-crashed')
    })
  }
})

describe('classifyClaudeError — agent-restarted-unexpectedly fixtures', () => {
  for (const fixture of fixtures['agent-restarted-unexpectedly']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('agent-restarted-unexpectedly')
    })
  }
})

describe('classifyClaudeError — unknown-4xx fixtures (fallback coverage)', () => {
  for (const fixture of fixtures['unknown-4xx']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('unknown-4xx')
    })
  }
})

describe('classifyClaudeError — unknown-5xx fixtures (fallback coverage)', () => {
  for (const fixture of fixtures['unknown-5xx']) {
    it(`classifies: ${fixture._source}`, () => {
      const input = '_value' in fixture ? fixture._value : fixture
      expect(classifyClaudeError(input)).toBe('unknown-5xx')
    })
  }
})

describe('classifyClaudeError — safety: must never throw', () => {
  const weirdInputs = [
    undefined,
    null,
    0,
    false,
    '',
    [],
    [1, 2, 3],
    { deeply: { nested: { unknown: true } } },
    { error: null },
    { error: 42 },
    Symbol('sym'),
    () => {},
    new Error('raw Error'),
    { status: 'not-a-number' },
  ]
  for (const input of weirdInputs) {
    it(`does not throw for: ${JSON.stringify(input) ?? String(input)}`, () => {
      expect(() => classifyClaudeError(input)).not.toThrow()
    })
  }
})

describe('classifyClaudeError — unknown-4xx is the default fallback', () => {
  it('unknown object with no status defaults to unknown-4xx', () => {
    expect(classifyClaudeError({ totally: 'unrecognised' })).toBe('unknown-4xx')
  })

  it('empty string → unknown-4xx', () => {
    expect(classifyClaudeError('')).toBe('unknown-4xx')
  })
})

// ─── renderOperatorEvent — per-kind output ────────────────────────────────────

describe('renderOperatorEvent — credentials-expired', () => {
  it('produces reauth button', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('credentials-expired'))
    expect(text).toContain('expired')
    expect(text).toContain('<b>gymbro</b>')
    expect(keyboard.inline_keyboard.flat().some(b => b.callback_data?.includes('reauth'))).toBe(true)
  })

  it('includes detail when provided', () => {
    const { text } = renderOperatorEvent(makeEvent('credentials-expired', { detail: 'token expired 2026-04-01' }))
    expect(text).toContain('token expired')
  })
})

describe('renderOperatorEvent — credentials-invalid', () => {
  it('produces reauth button + code hint', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('credentials-invalid'))
    expect(text).toContain('Invalid')
    expect(keyboard.inline_keyboard.flat().some(b => b.callback_data?.includes('reauth'))).toBe(true)
  })
})

describe('renderOperatorEvent — credit-exhausted', () => {
  it('offers swap + add slot buttons', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('credit-exhausted'))
    expect(text).toContain('Credit balance')
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some(b => b.callback_data?.includes('swap-slot'))).toBe(true)
    expect(buttons.some(b => b.callback_data?.includes('add-slot'))).toBe(true)
  })
})

describe('renderOperatorEvent — quota-exhausted', () => {
  it('renders quota text + swap/add buttons', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('quota-exhausted'))
    expect(text).toContain('Quota exhausted')
    expect(text).toContain('<b>gymbro</b>')
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some(b => b.callback_data?.includes('swap-slot'))).toBe(true)
    expect(buttons.some(b => b.callback_data?.includes('add-slot'))).toBe(true)
  })

  it('contains auto-fallback slot info in detail when provided', () => {
    const { text } = renderOperatorEvent(
      makeEvent('quota-exhausted', { detail: 'Switched from slot default to personal. Reset at: 2026-04-25T00:00:00Z.' })
    )
    expect(text).toContain('default')
    expect(text).toContain('personal')
  })
})

describe('renderOperatorEvent — rate-limited', () => {
  it('mentions rate limit + wait button', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('rate-limited'))
    expect(text).toContain('Rate limited')
    expect(keyboard.inline_keyboard.flat().some(b => b.callback_data?.includes('dismiss'))).toBe(true)
  })
})

describe('renderOperatorEvent — agent-crashed', () => {
  it('offers restart + logs buttons', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('agent-crashed'))
    expect(text).toContain('crashed')
    const buttons = keyboard.inline_keyboard.flat()
    expect(buttons.some(b => b.callback_data?.includes('restart'))).toBe(true)
    expect(buttons.some(b => b.callback_data?.includes('logs'))).toBe(true)
  })
})

describe('renderOperatorEvent — agent-restarted-unexpectedly', () => {
  it('mentions unexpected restart + logs button', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('agent-restarted-unexpectedly'))
    expect(text).toContain('restarted unexpectedly')
    expect(keyboard.inline_keyboard.flat().some(b => b.callback_data?.includes('logs'))).toBe(true)
  })
})

describe('renderOperatorEvent — unknown-4xx', () => {
  it('surfaces "API error (4xx)" with dismiss button', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('unknown-4xx'))
    expect(text).toContain('4xx')
    expect(keyboard.inline_keyboard.flat().some(b => b.callback_data?.includes('dismiss'))).toBe(true)
  })
})

describe('renderOperatorEvent — unknown-5xx', () => {
  it('surfaces "Server error (5xx)" with dismiss button', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('unknown-5xx'))
    expect(text).toContain('5xx')
    expect(keyboard.inline_keyboard.flat().some(b => b.callback_data?.includes('dismiss'))).toBe(true)
  })
})

describe('renderOperatorEvent — HTML escaping', () => {
  it('escapes agent name with special chars', () => {
    const { text } = renderOperatorEvent(makeEvent('unknown-4xx', { agent: '<evil>' }))
    expect(text).toContain('&lt;evil&gt;')
    expect(text).not.toContain('<evil>')
  })

  it('escapes detail with special chars', () => {
    const { text } = renderOperatorEvent(makeEvent('credentials-expired', { detail: '<script>alert(1)</script>' }))
    expect(text).toContain('&lt;script&gt;')
    expect(text).not.toContain('<script>')
  })
})

describe('renderOperatorEvent — all kinds produce valid keyboard structure', () => {
  const allKinds: OperatorEventKind[] = [
    'credentials-expired',
    'credentials-invalid',
    'credit-exhausted',
    'quota-exhausted',
    'rate-limited',
    'agent-crashed',
    'agent-restarted-unexpectedly',
    'unknown-4xx',
    'unknown-5xx',
  ]

  for (const kind of allKinds) {
    it(`${kind} has non-empty text + at least one keyboard button`, () => {
      const { text, keyboard } = renderOperatorEvent(makeEvent(kind))
      expect(text.length).toBeGreaterThan(0)
      expect(keyboard.inline_keyboard.length).toBeGreaterThan(0)
      expect(keyboard.inline_keyboard.flat().length).toBeGreaterThan(0)
    })
  }
})

// ─── Cooldown dedupe ──────────────────────────────────────────────────────────

describe('shouldEmitOperatorEvent — cooldown dedupe', () => {
  const NOW = 1_780_000_000_000

  beforeEach(() => {
    resetAllCooldowns()
  })

  it('first call for new agent+kind returns true', () => {
    expect(shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW)).toBe(true)
  })

  it('second call within cooldown returns false', () => {
    shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW)
    expect(shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW + 100)).toBe(false)
  })

  it('call after cooldown expires returns true', () => {
    shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW)
    expect(
      shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW + DEFAULT_OPERATOR_EVENT_COOLDOWN_MS + 1)
    ).toBe(true)
  })

  it('different kind for same agent is independent', () => {
    shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW)
    expect(shouldEmitOperatorEvent('gymbro', 'credentials-expired', NOW + 100)).toBe(true)
  })

  it('different agent for same kind is independent', () => {
    shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW)
    expect(shouldEmitOperatorEvent('clerk', 'agent-crashed', NOW + 100)).toBe(true)
  })

  it('custom cooldown respected', () => {
    const shortCooldown = 1_000
    shouldEmitOperatorEvent('gymbro', 'rate-limited', NOW, shortCooldown)
    expect(shouldEmitOperatorEvent('gymbro', 'rate-limited', NOW + 500, shortCooldown)).toBe(false)
    expect(shouldEmitOperatorEvent('gymbro', 'rate-limited', NOW + 1_001, shortCooldown)).toBe(true)
  })

  it('clearOperatorEventCooldown allows immediate re-emit', () => {
    shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW)
    clearOperatorEventCooldown('gymbro', 'agent-crashed')
    expect(shouldEmitOperatorEvent('gymbro', 'agent-crashed', NOW + 1)).toBe(true)
  })

  it('5-minute default is DEFAULT_OPERATOR_EVENT_COOLDOWN_MS', () => {
    expect(DEFAULT_OPERATOR_EVENT_COOLDOWN_MS).toBe(5 * 60_000)
  })
})
