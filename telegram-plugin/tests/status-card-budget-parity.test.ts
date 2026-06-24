import { describe, it, expect } from 'vitest'
import { renderStatusCard } from '../tool-activity-summary.js'
import { STATUS_CARD_CHAR_BUDGET } from '../status-no-truncate.js'

// Both status surfaces (🤖 agent + 🛠 worker) render through the single
// `renderStatusCard` primitive. Given the SAME raw steps, the rendered step
// BODY (everything below the two-line header) must be byte-identical regardless
// of the header emoji/label — the truncation pipeline, rolling window, and
// char-budget backstop are surface-agnostic. This pins that parity so the two
// surfaces can never drift apart again.

/** Strip the two header lines, returning just the step/result body. */
function body(card: string | null): string {
  if (card == null) return ''
  const lines = card.split('\n')
  return lines.slice(2).join('\n')
}

function agent(steps: string[], final = false) {
  return renderStatusCard({
    header: { emoji: '🤖', label: 'Agent', elapsedMs: 12_000, toolCount: 4, state: final ? 'done' : 'running' },
    steps,
    final,
  })
}

function worker(steps: string[], final = false) {
  return renderStatusCard({
    header: { emoji: '🛠', label: 'Worker', description: 'a task', elapsedMs: 12_000, toolCount: 4, state: final ? 'done' : 'running' },
    steps,
    final,
  })
}

describe('status-card body byte-parity: agent vs worker', () => {
  it('identical raw steps → identical body length and bytes (running)', () => {
    const steps = ['read the brief', 'scanned vendor A', 'scanned vendor B']
    const a = body(agent(steps))
    const w = body(worker(steps))
    expect(a).toBe(w)
    expect(a.length).toBe(w.length)
  })

  it('identical raw steps → identical body (final)', () => {
    const steps = ['compiled', 'linked', 'shipped']
    expect(body(agent(steps, true))).toBe(body(worker(steps, true)))
  })

  it('overflow window → identical body + same +N earlier marker', () => {
    const steps = Array.from({ length: 11 }, (_, i) => `step ${String(i + 1).padStart(2, '0')}`)
    const a = body(agent(steps))
    const w = body(worker(steps))
    expect(a).toBe(w)
    expect(a).toContain('earlier…')
  })

  it('char-budget backstop → identical body length under the fitter', () => {
    const big = 'z'.repeat(900)
    const steps = Array.from({ length: 6 }, () => big)
    const a = agent(steps)!
    const w = worker(steps)!
    expect(body(a).length).toBe(body(w).length)
    // Both whole cards stay within the wire budget.
    expect(a.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
    expect(w.length).toBeLessThanOrEqual(STATUS_CARD_CHAR_BUDGET)
  })

  it('escape parity: special chars escape identically on both surfaces', () => {
    const steps = ['run build && deploy <prod> & verify']
    expect(body(agent(steps))).toBe(body(worker(steps)))
  })
})
