/**
 * The 🤖 agent card and the 🛠 worker card must end the SAME way: a `─────`
 * rule then `✅ _<final summary sentence>_`.
 *
 * Before this suite the two surfaces had already been unified for the card
 * BODY (#3844 — one `renderStatusCard`/`card-layout` core), but the terminal
 * RESULT footer was still forked: the derivation (clean the raw summary, pick
 * ✅/⚠️ from the state, omit on empty, never emit one for `incomplete`) lived
 * inline in `renderWorkerActivity`, so the agent card had no result block at
 * all and ended on `✓ N steps`. `deriveCardResult` is now the single shared
 * derivation and both adapters call it.
 *
 * These assertions fail on the forked behaviour: (1) the agent card had no
 * `✅` footer to end with, and (2) there was no shared symbol whose output
 * both cards' footers could be compared against byte for byte.
 */
import { describe, it, expect } from 'vitest'
import {
  deriveCardResult,
  renderActivityFeed,
  renderActivityFeedWithNested,
  type SessionActivityHeader,
} from '../tool-activity-summary.js'
import { renderWorkerActivity, type WorkerActivityView } from '../worker-activity-feed.js'

/** A realistic multi-line, markdown-authored final summary. */
const RAW_SUMMARY = '## Result\nStanding by for the **background merge waiter** to complete.'
/** What the shared derivation cleans it down to. */
const CLEAN_SUMMARY = 'Result Standing by for the background merge waiter to complete.'
/** The exact two trailing card lines both surfaces must end with. */
const EXPECTED_FOOTER_TAIL = `─────`

function agentHeader(over: Partial<SessionActivityHeader> = {}): SessionActivityHeader {
  return {
    label: 'Agent',
    elapsedMs: 64_000,
    toolCount: 6,
    state: 'done',
    model: 'claude-opus-5',
    totalTokens: 3000,
    ...over,
  }
}

function workerView(over: Partial<WorkerActivityView> = {}): WorkerActivityView {
  return {
    description: 'Merge 3922 and cut v0.19.30',
    lastTool: null,
    toolCount: 6,
    totalTokens: 3000,
    latestSummary: RAW_SUMMARY,
    narrativeLines: ['Reading a.ts', 'Running tests'],
    elapsedMs: 64_000,
    state: 'done',
    model: 'claude-opus-5',
    ...over,
  }
}

/** The card's trailing result block: the `─────` rule line and everything after. */
function footerOf(card: string): string {
  const idx = card.lastIndexOf(EXPECTED_FOOTER_TAIL)
  return idx === -1 ? '' : card.slice(idx)
}

describe('deriveCardResult — the ONE terminal-footer derivation', () => {
  it('done → ✅ + the cleaned single-paragraph summary', () => {
    expect(deriveCardResult('done', RAW_SUMMARY)).toEqual({ emoji: '✅', text: CLEAN_SUMMARY })
  })

  it('failed → ⚠️ (never the green tick)', () => {
    expect(deriveCardResult('failed', RAW_SUMMARY)).toEqual({ emoji: '⚠️', text: CLEAN_SUMMARY })
  })

  it('running → no block (the card is not finished)', () => {
    expect(deriveCardResult('running', RAW_SUMMARY)).toBeUndefined()
  })

  it('incomplete → NEVER a block, even with summary text (truthful-no-result)', () => {
    expect(deriveCardResult('incomplete', RAW_SUMMARY)).toBeUndefined()
  })

  it('empty / whitespace / markdown-only summary → no block, never a fabricated line', () => {
    expect(deriveCardResult('done', '')).toBeUndefined()
    expect(deriveCardResult('done', undefined)).toBeUndefined()
    expect(deriveCardResult('done', '   \n---\n  ')).toBeUndefined()
  })

  it('redacts a secret in the summary — cards bypass the outbound redact chokepoint', () => {
    // Status cards go out via sendRichMessage, which skips
    // `normalizeOutboundBody → redact` (outbound-send-path.ts). The agent
    // card's summary is the turn's PRE-redaction reply text, so the scrub has
    // to happen in this derivation or a token reaches Telegram verbatim.
    const token = 'sk-ant-' + 'api03-' + 'A'.repeat(48)
    const out = deriveCardResult('done', `Deployed with ${token} and all is green.`)!
    expect(out.text).not.toContain(token)
    expect(out.text).toContain('[REDACTED:')
    expect(out.text).toContain('Deployed with')
    expect(out.text).toContain('and all is green.')
  })
})

describe('🤖 agent card ends with the ✅ + final-summary footer', () => {
  it('final render with resultText appends the rule + ✅ summary as the LAST line', () => {
    const card = renderActivityFeed(
      ['Reading a.ts', 'Running tests'],
      true,
      '',
      6,
      agentHeader({ resultText: RAW_SUMMARY }),
    )!
    expect(card).toContain('─────')
    // The ✅ summary is the final line of the card, exactly like the worker card.
    expect(card.endsWith(`✅ _${CLEAN_SUMMARY}_`)).toBe(true)
  })

  it('the nested (foreground sub-agent) render gets the identical footer', () => {
    const flat = renderActivityFeed(
      ['Delegating: x'],
      true,
      '',
      6,
      agentHeader({ resultText: RAW_SUMMARY }),
    )!
    const nested = renderActivityFeedWithNested(
      ['Delegating: x'],
      ['child step'],
      true,
      '',
      6,
      agentHeader({ resultText: RAW_SUMMARY }),
    )!
    expect(footerOf(nested)).toBe(footerOf(flat))
    expect(nested.endsWith(`✅ _${CLEAN_SUMMARY}_`)).toBe(true)
  })

  it('no resultText → no footer block (worker fallback), card still ends on ✓ N steps', () => {
    const card = renderActivityFeed(['Reading a.ts'], true, '', 6, agentHeader())!
    expect(card).not.toContain('─────')
    expect(card).not.toContain('✅')
    expect(card.endsWith('_✓ 6 steps_')).toBe(true)
  })

  it('a LIVE (non-final) render never shows the footer, even if resultText is set', () => {
    const card = renderActivityFeed(
      ['Reading a.ts'],
      false,
      '',
      undefined,
      agentHeader({ state: 'running', resultText: RAW_SUMMARY }),
    )!
    expect(card).not.toContain('─────')
    expect(card).not.toContain('✅')
  })
})

describe('both cards render their footer through the SAME shared derivation', () => {
  it('agent + worker footers are byte-identical for the same raw summary', () => {
    const agent = renderActivityFeed(
      ['Reading a.ts', 'Running tests'],
      true,
      '',
      6,
      agentHeader({ resultText: RAW_SUMMARY }),
    )!
    const worker = renderWorkerActivity(workerView())
    const footer = footerOf(agent)
    expect(footer).not.toBe('')
    expect(footer).toBe(footerOf(worker))
    // …and that shared footer is exactly what `deriveCardResult` produced.
    const derived = deriveCardResult('done', RAW_SUMMARY)!
    expect(footer.endsWith(`${derived.emoji} _${derived.text}_`)).toBe(true)
  })

  it('the shared body (stats line + struck step list) is identical too', () => {
    // Line 2 (the `done · N tools · N tok · elapsed · model` stats run) and the
    // struck-through step lines come from the one card core — the only
    // legitimate difference is the title line (icon + label + task).
    const agent = renderActivityFeed(
      ['Reading a.ts', 'Running tests'],
      true,
      '',
      undefined,
      agentHeader({ resultText: RAW_SUMMARY }),
    )!
    const worker = renderWorkerActivity(workerView())
    const dropTitle = (card: string) => card.split('  \n').slice(1).join('  \n')
    expect(dropTitle(agent)).toBe(dropTitle(worker))
    // The title lines DO differ — that is the one parameterised difference.
    expect(agent.split('  \n')[0]).toContain('🤖')
    expect(worker.split('  \n')[0]).toContain('🛠')
  })
})
