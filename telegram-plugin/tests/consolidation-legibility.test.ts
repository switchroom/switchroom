import { describe, it, expect } from 'vitest'
import {
  isConsolidationLegibilityEnabled,
  detectConsolidationEvent,
  renderConsolidationLine,
  consolidationSignature,
  ConsolidationRateLimiter,
  HINDSIGHT_WEBHOOK_SOURCE,
  CONSOLIDATION_COMPLETED_EVENT,
} from '../consolidation-legibility.js'

describe('isConsolidationLegibilityEnabled — OPT-IN (default OFF)', () => {
  it('is OFF when unset (opposite of the default-ON tool-observation path)', () => {
    expect(isConsolidationLegibilityEnabled(undefined)).toBe(false)
  })
  it('is OFF for the empty string and for "0"/"false"/"off"', () => {
    expect(isConsolidationLegibilityEnabled('')).toBe(false)
    expect(isConsolidationLegibilityEnabled('0')).toBe(false)
    expect(isConsolidationLegibilityEnabled('false')).toBe(false)
    expect(isConsolidationLegibilityEnabled('off')).toBe(false)
    expect(isConsolidationLegibilityEnabled('no')).toBe(false)
  })
  it('is ON only for an explicit truthy opt-in', () => {
    expect(isConsolidationLegibilityEnabled('1')).toBe(true)
    expect(isConsolidationLegibilityEnabled('true')).toBe(true)
    expect(isConsolidationLegibilityEnabled('on')).toBe(true)
    expect(isConsolidationLegibilityEnabled('yes')).toBe(true)
    expect(isConsolidationLegibilityEnabled(' TRUE ')).toBe(true)
  })
})

describe('wire constants', () => {
  it('names the hindsight consolidation.completed source/event', () => {
    expect(HINDSIGHT_WEBHOOK_SOURCE).toBe('hindsight')
    expect(CONSOLIDATION_COMPLETED_EVENT).toBe('consolidation.completed')
  })
})

describe('detectConsolidationEvent — MATERIAL-only (sparse)', () => {
  it('returns null on a routine no-op consolidation (nothing stored/corrected)', () => {
    expect(detectConsolidationEvent({ stored: 0, corrected: 0 })).toBeNull()
    expect(detectConsolidationEvent({})).toBeNull()
    expect(detectConsolidationEvent(undefined)).toBeNull()
  })

  it('classifies a pure store as "updated"', () => {
    const ev = detectConsolidationEvent({ stored: 2, subject: 'your deploy preferences' })
    expect(ev).toEqual({ kind: 'updated', topic: 'your deploy preferences' })
  })

  it('classifies any correction as "revised" (higher signal), even alongside stores', () => {
    expect(detectConsolidationEvent({ corrected: 1, subject: 'old runbook' })).toEqual({
      kind: 'revised',
      topic: 'old runbook',
    })
    expect(detectConsolidationEvent({ stored: 3, corrected: 1, subject: 'X' })).toEqual({
      kind: 'revised',
      topic: 'X',
    })
  })

  it('tolerates field aliases (created/added/new_observations; invalidated/superseded)', () => {
    expect(detectConsolidationEvent({ created: 1, topic: 'a' })?.kind).toBe('updated')
    expect(detectConsolidationEvent({ new_observations: 5, topic: 'a' })?.kind).toBe('updated')
    expect(detectConsolidationEvent({ invalidated: 2, topic: 'a' })?.kind).toBe('revised')
    expect(detectConsolidationEvent({ superseded: 1, topic: 'a' })?.kind).toBe('revised')
  })

  it('counts an observations array by length as a store', () => {
    const ev = detectConsolidationEvent({
      observations: [{ statement: 'User prefers TS', subject: 'coding style' }],
    })
    expect(ev).toEqual({ kind: 'updated', topic: 'coding style' })
  })

  it('accepts numeric-string counts', () => {
    expect(detectConsolidationEvent({ stored: '2', subject: 'x' })?.kind).toBe('updated')
  })

  it('derives topic from subjects[]/entities[] arrays when no direct subject', () => {
    expect(detectConsolidationEvent({ stored: 1, subjects: ['travel plans'] })?.topic).toBe(
      'travel plans',
    )
    expect(
      detectConsolidationEvent({ stored: 1, entities: [{ name: 'Acme Corp' }] })?.topic,
    ).toBe('Acme Corp')
  })

  it('falls back to the first observation statement when no subject', () => {
    const ev = detectConsolidationEvent({
      observations: [{ statement: 'The user lives in Sydney' }],
    })
    expect(ev?.topic).toBe('The user lives in Sydney')
  })

  it('leaves topic empty when the payload carries no legible subject', () => {
    expect(detectConsolidationEvent({ stored: 1, bank_id: 'agent-x' })?.topic).toBe('')
  })
})

describe('renderConsolidationLine — terse, HTML, notification-free surface', () => {
  it('renders the updated line with a subject', () => {
    expect(renderConsolidationLine({ kind: 'updated', topic: 'your deploy preferences' })).toBe(
      '🧠 <i>updated what I know</i> about "your deploy preferences"',
    )
  })
  it('renders the revised line with a subject', () => {
    expect(renderConsolidationLine({ kind: 'revised', topic: 'the old runbook' })).toBe(
      '🧠 <i>revised what I know</i> about "the old runbook"',
    )
  })
  it('falls back to a bare line when there is no legible subject', () => {
    expect(renderConsolidationLine({ kind: 'updated', topic: '' })).toBe(
      '🧠 <i>updated what I know about you.</i>',
    )
    expect(renderConsolidationLine({ kind: 'revised', topic: '   ' })).toBe(
      '🧠 <i>revised what I know about you.</i>',
    )
  })
  it('HTML-escapes the subject (no entity injection)', () => {
    expect(renderConsolidationLine({ kind: 'updated', topic: 'a <b> & c' })).toBe(
      '🧠 <i>updated what I know</i> about "a &lt;b&gt; &amp; c"',
    )
  })
  it('truncates a very long subject', () => {
    const long = 'x'.repeat(500)
    const out = renderConsolidationLine({ kind: 'updated', topic: long })
    expect(out.length).toBeLessThan(200)
    expect(out).toContain('…')
  })
})

describe('ConsolidationRateLimiter — sparse / non-spammy', () => {
  it('allows the first line, then blocks a second within the min-interval', () => {
    let t = 1_000_000
    const rl = new ConsolidationRateLimiter({ minIntervalMs: 600_000, now: () => t })
    expect(rl.allow('klanker', 'updated:a')).toBe(true)
    t += 60_000 // 1 min later
    expect(rl.allow('klanker', 'updated:b')).toBe(false) // different topic, still capped
  })

  it('allows again once the min-interval has elapsed', () => {
    let t = 1_000_000
    const rl = new ConsolidationRateLimiter({ minIntervalMs: 600_000, now: () => t })
    expect(rl.allow('klanker', 'updated:a')).toBe(true)
    t += 600_001
    expect(rl.allow('klanker', 'updated:b')).toBe(true)
  })

  it('suppresses an IDENTICAL signature across the dedup window even after the interval', () => {
    let t = 1_000_000
    const rl = new ConsolidationRateLimiter({
      minIntervalMs: 600_000,
      dedupWindowMs: 3_600_000,
      now: () => t,
    })
    expect(rl.allow('klanker', 'updated:deploy')).toBe(true)
    t += 700_000 // past min-interval…
    expect(rl.allow('klanker', 'updated:deploy')).toBe(false) // …but same topic, still deduped
    t += 3_600_000 // past dedup window
    expect(rl.allow('klanker', 'updated:deploy')).toBe(true)
  })

  it('rate-limits per agent independently', () => {
    let t = 1_000_000
    const rl = new ConsolidationRateLimiter({ minIntervalMs: 600_000, now: () => t })
    expect(rl.allow('klanker', 'updated:a')).toBe(true)
    expect(rl.allow('reggie', 'updated:a')).toBe(true) // different agent, own budget
  })

  it('accepts an explicit now override per call', () => {
    const rl = new ConsolidationRateLimiter({ minIntervalMs: 600_000 })
    expect(rl.allow('klanker', 'updated:a', 0)).toBe(true)
    expect(rl.allow('klanker', 'updated:a', 100)).toBe(false)
    expect(rl.allow('klanker', 'updated:a', 700_000)).toBe(false) // dedup window
    expect(rl.allow('klanker', 'updated:b', 700_000)).toBe(true) // new topic past interval
  })
})

describe('consolidationSignature — stable dedup key', () => {
  it('normalises whitespace + case so trivially-different topics collapse', () => {
    expect(consolidationSignature({ kind: 'updated', topic: '  Deploy   Prefs ' })).toBe(
      'updated:deploy prefs',
    )
  })
  it('separates kind so a store and a correction of the same topic differ', () => {
    expect(consolidationSignature({ kind: 'updated', topic: 'x' })).not.toBe(
      consolidationSignature({ kind: 'revised', topic: 'x' }),
    )
  })
})
