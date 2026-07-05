import { describe, it, expect } from 'vitest'
import {
  classifyMemoryToolCall,
  detectMemoryLegibilityEvent,
  isMemoryLegibilityEnabled,
  renderMemoryLegibilityLine,
  CREATE_DIRECTIVE_TOOL,
  INVALIDATE_MEMORY_TOOL,
  UPDATE_MEMORY_TOOL,
} from '../memory-legibility.js'

describe('isMemoryLegibilityEnabled — default-ON kill switch', () => {
  it('is ON when unset (fresh setup / defaults principle)', () => {
    expect(isMemoryLegibilityEnabled(undefined)).toBe(true)
  })
  it('is ON for any value except the literal "0"', () => {
    expect(isMemoryLegibilityEnabled('1')).toBe(true)
    expect(isMemoryLegibilityEnabled('')).toBe(true)
    expect(isMemoryLegibilityEnabled('true')).toBe(true)
  })
  it('is OFF only for "0"', () => {
    expect(isMemoryLegibilityEnabled('0')).toBe(false)
  })
})

describe('classifyMemoryToolCall — the reusable "did a material memory op happen?" primitive (#2848 Stage B imports this)', () => {
  it('classifies create_directive as directive-create', () => {
    expect(classifyMemoryToolCall(CREATE_DIRECTIVE_TOOL, { content: 'x', name: 'y' })).toBe(
      'directive-create',
    )
  })

  it('classifies invalidate_memory as memory-invalidate', () => {
    expect(classifyMemoryToolCall(INVALIDATE_MEMORY_TOOL, { memory_id: 'm1' })).toBe(
      'memory-invalidate',
    )
  })

  it('classifies update_memory as memory-invalidate ONLY when it applies the demote-from-recall tag', () => {
    expect(
      classifyMemoryToolCall(UPDATE_MEMORY_TOOL, {
        memory_id: 'm1',
        add_tags: ['[demote-from-recall]'],
      }),
    ).toBe('memory-invalidate')
    // bracket-less + case variant still matches
    expect(
      classifyMemoryToolCall(UPDATE_MEMORY_TOOL, { add_tags: ['DEMOTE-FROM-RECALL'] }),
    ).toBe('memory-invalidate')
  })

  it('does NOT classify a benign update_memory edit (no demote tag) — material-only', () => {
    expect(
      classifyMemoryToolCall(UPDATE_MEMORY_TOOL, { memory_id: 'm1', add_tags: ['urgent'] }),
    ).toBeNull()
    expect(classifyMemoryToolCall(UPDATE_MEMORY_TOOL, { content: 'edited' })).toBeNull()
  })

  it('does NOT classify ordinary recall / reflect / retain — no line on routine memory ops', () => {
    for (const tool of [
      'mcp__hindsight__recall',
      'mcp__hindsight__reflect',
      'mcp__hindsight__retain',
      'mcp__hindsight__sync_retain',
      'mcp__hindsight__list_directives',
      'Bash',
      'Read',
    ]) {
      expect(classifyMemoryToolCall(tool, { query: 'x' })).toBeNull()
    }
  })
})

describe('detectMemoryLegibilityEvent — extracts the human detail', () => {
  it('reads directive body from the real `content` wire field', () => {
    expect(
      detectMemoryLegibilityEvent(CREATE_DIRECTIVE_TOOL, {
        name: 'ts-pref',
        content: 'Always prefer TypeScript for this user',
      }),
    ).toEqual({ kind: 'remembered', detail: 'Always prefer TypeScript for this user' })
  })

  it('falls back to `text` then `name` when `content` is absent', () => {
    expect(detectMemoryLegibilityEvent(CREATE_DIRECTIVE_TOOL, { text: 'Prefer TS' })).toEqual({
      kind: 'remembered',
      detail: 'Prefer TS',
    })
    expect(detectMemoryLegibilityEvent(CREATE_DIRECTIVE_TOOL, { name: 'Prefer TS' })).toEqual({
      kind: 'remembered',
      detail: 'Prefer TS',
    })
  })

  it('surfaces an invalidate reason but omits the opaque memory_id', () => {
    expect(
      detectMemoryLegibilityEvent(INVALIDATE_MEMORY_TOOL, {
        memory_id: 'mem_abc123',
        reason: 'superseded deploy runbook',
      }),
    ).toEqual({ kind: 'forgot', detail: 'superseded deploy runbook' })
    // no reason → empty detail (render uses the bare fallback), never the id
    expect(detectMemoryLegibilityEvent(INVALIDATE_MEMORY_TOOL, { memory_id: 'mem_abc' })).toEqual({
      kind: 'forgot',
      detail: '',
    })
  })

  it('returns null for non-material tools', () => {
    expect(detectMemoryLegibilityEvent('mcp__hindsight__recall', { query: 'x' })).toBeNull()
    expect(detectMemoryLegibilityEvent(UPDATE_MEMORY_TOOL, { content: 'edit' })).toBeNull()
  })

  it('tolerates undefined input', () => {
    expect(detectMemoryLegibilityEvent(CREATE_DIRECTIVE_TOOL, undefined)).toEqual({
      kind: 'remembered',
      detail: '',
    })
  })
})

describe('renderMemoryLegibilityLine — terse HTML one-liner', () => {
  it('renders a remembered directive in quotes', () => {
    expect(
      renderMemoryLegibilityLine({ kind: 'remembered', detail: 'Always prefer TypeScript' }),
    ).toBe('📌 <i>remembered:</i> "Always prefer TypeScript"')
  })

  it('renders a forgot line with the reason', () => {
    expect(renderMemoryLegibilityLine({ kind: 'forgot', detail: 'superseded runbook' })).toBe(
      '✂️ <i>forgot:</i> superseded runbook',
    )
  })

  it('uses a bare fallback when there is no legible detail', () => {
    expect(renderMemoryLegibilityLine({ kind: 'remembered', detail: '' })).toBe(
      '📌 <i>remembered a new directive.</i>',
    )
    expect(renderMemoryLegibilityLine({ kind: 'forgot', detail: '   ' })).toBe(
      '✂️ <i>forgot a memory.</i>',
    )
  })

  it('HTML-escapes the detail so it cannot break parse_mode:HTML', () => {
    const out = renderMemoryLegibilityLine({
      kind: 'remembered',
      detail: 'use <b> & compare a < b',
    })
    expect(out).toBe('📌 <i>remembered:</i> "use &lt;b&gt; &amp; compare a &lt; b"')
    // the only literal < / > left are the wrapper <i> tags
    expect(out).not.toContain('<b>')
  })

  it('strips markdown and collapses whitespace before truncating', () => {
    const out = renderMemoryLegibilityLine({
      kind: 'remembered',
      detail: '**Always**   prefer  `TypeScript`',
    })
    expect(out).toBe('📌 <i>remembered:</i> "Always prefer TypeScript"')
  })

  it('truncates very long directive bodies with an ellipsis', () => {
    const long = 'x'.repeat(400)
    const out = renderMemoryLegibilityLine({ kind: 'remembered', detail: long })
    expect(out.length).toBeLessThan(220)
    expect(out).toContain('…')
  })
})
