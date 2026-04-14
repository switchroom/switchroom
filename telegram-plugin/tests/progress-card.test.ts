/**
 * Unit tests for the progress-card reducer + renderer.
 *
 * Pure-function coverage: every event transition, render output for each
 * stage, rollup compaction, user-text truncation, HTML escaping.
 */
import { describe, it, expect } from 'vitest'
import type { SessionEvent } from '../session-tail.js'
import {
  initialState,
  reduce,
  render,
  type ProgressCardState,
} from '../progress-card.js'

function fold(events: SessionEvent[], startNow = 1000): ProgressCardState {
  let state = initialState()
  let t = startNow
  for (const e of events) {
    state = reduce(state, e, t)
    t += 100
  }
  return state
}

function enqueue(text: string): SessionEvent {
  return {
    kind: 'enqueue',
    chatId: '123',
    messageId: '1',
    threadId: null,
    rawContent: `<channel chat_id="123">${text}</channel>`,
  }
}

describe('progress-card reducer', () => {
  it('idle state renders a placeholder', () => {
    expect(render(initialState(), 0)).toBe('🤔 Waiting…')
  })

  it('enqueue initialises the turn and extracts user text', () => {
    const s = reduce(initialState(), enqueue('fix the tests'), 1000)
    expect(s.turnStartedAt).toBe(1000)
    expect(s.userRequest).toBe('fix the tests')
    expect(s.stage).toBe('plan')
    expect(s.items).toEqual([])
  })

  it('enqueue without channel wrapper still extracts text', () => {
    const s = reduce(
      initialState(),
      { kind: 'enqueue', chatId: null, messageId: null, threadId: null, rawContent: 'raw message' },
      1000,
    )
    expect(s.userRequest).toBe('raw message')
  })

  it('tool_use appends a running item and flips stage to run', () => {
    const s = fold([enqueue('test'), { kind: 'tool_use', toolName: 'Read' }])
    expect(s.items).toHaveLength(1)
    expect(s.items[0].tool).toBe('Read')
    expect(s.items[0].state).toBe('running')
    expect(s.stage).toBe('run')
  })

  it('tool_result closes the running item', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Bash' },
      { kind: 'tool_result', toolUseId: 'x', toolName: 'Bash' },
    ])
    expect(s.items[0].state).toBe('done')
    expect(s.items[0].finishedAt).toBe(1200)
  })

  it('multiple tool_use events append in order', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Read' },
      { kind: 'tool_result', toolUseId: 'a', toolName: 'Read' },
      { kind: 'tool_use', toolName: 'Grep' },
      { kind: 'tool_result', toolUseId: 'b', toolName: 'Grep' },
      { kind: 'tool_use', toolName: 'Edit' },
    ])
    expect(s.items.map((i) => i.tool)).toEqual(['Read', 'Grep', 'Edit'])
    expect(s.items.map((i) => i.state)).toEqual(['done', 'done', 'running'])
  })

  it('pairs tool_result to tool_use by toolUseId (parallel tool calls)', () => {
    // Pin the fix for the parallel-tool_use pairing bug: when the model
    // emits two tool_use calls in a single assistant message and the
    // results arrive out-of-order, the reducer must pair by tool_use_id
    // rather than by FIFO running-item order.
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_A' },
      { kind: 'tool_use', toolName: 'Read', toolUseId: 'toolu_B' },
      // Out-of-order results: B finishes first, with an error
      { kind: 'tool_result', toolUseId: 'toolu_B', toolName: null, isError: true },
      { kind: 'tool_result', toolUseId: 'toolu_A', toolName: null },
    ])
    expect(s.items.map((i) => [i.tool, i.state])).toEqual([
      ['Bash', 'done'],
      ['Read', 'failed'],
    ])
  })

  it('falls back to FIFO pairing when tool_result has no toolUseId', () => {
    // Older event shapes (before session-tail surfaced tool_use_id) omit
    // the field; the reducer must still close the oldest running item.
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Bash' },
      { kind: 'tool_result', toolUseId: '', toolName: null },
    ])
    expect(s.items[0].state).toBe('done')
  })

  it('turn_end closes all running items and flips stage to done', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Read' },
      { kind: 'turn_end', durationMs: 1000 },
    ])
    expect(s.items[0].state).toBe('done')
    expect(s.stage).toBe('done')
  })

  it('text event updates latestText', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: 'thinking about it' },
      { kind: 'text', text: 'actually…' },
    ])
    expect(s.latestText).toBe('actually…')
  })

  it('events outside the turn lifecycle are no-ops', () => {
    const s1 = reduce(initialState(), { kind: 'thinking' }, 1000)
    expect(s1).toEqual(initialState())
    const s2 = reduce(initialState(), { kind: 'tool_use', toolName: 'Read' }, 1000)
    expect(s2).toEqual(initialState())
    const s3 = reduce(initialState(), { kind: 'turn_end', durationMs: 0 }, 1000)
    expect(s3).toEqual(initialState())
  })

  it('parallel tool_use keeps both running for correct tool_result pairing', () => {
    // Claude Code DOES emit parallel tool_use blocks within a single
    // assistant message (e.g. Bash + Read batched). The reducer keeps
    // both running so the subsequent tool_results can pair by
    // toolUseId rather than the old auto-done-on-new-tool_use shortcut
    // which mis-paired the first result onto the wrong item.
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'A' },
      { kind: 'tool_use', toolName: 'B' },
    ])
    expect(s.items[0].state).toBe('running')
    expect(s.items[1].state).toBe('running')
  })

  it('enqueue in the middle of a turn resets everything', () => {
    const s = fold([
      enqueue('first'),
      { kind: 'tool_use', toolName: 'Read' },
      enqueue('second'),
    ])
    expect(s.userRequest).toBe('second')
    expect(s.items).toHaveLength(0)
  })
})

describe('progress-card render', () => {
  it('renders plan stage with no items', () => {
    const s = fold([enqueue('fix tests')])
    const out = render(s, 5000)
    expect(out).toContain('💬 fix tests')
    // The old static "🤔 Plan → 🔧 Run → ✅ Done" phase line is gone;
    // the checklist body is empty until tool_use events arrive.
    expect(out).not.toContain('🤔 Plan')
  })

  it('renders a distinctive "Working…" header while in-progress', () => {
    const s = fold([enqueue('fix tests')])
    const out = render(s, 5000)
    // Distinctive banner that no normal reply would ever produce.
    expect(out).toContain('⚙️ <b>Working…</b>')
    // Separator between header and bullets — avoids the "one blob" look.
    expect(out).toContain('─ ─ ─')
    // While in-progress, no "Done" banner.
    expect(out).not.toContain('✅ <b>Done</b> ·')
  })

  it('swaps the header to "Done" when the turn ends', () => {
    const s = fold([enqueue('fix tests'), { kind: 'turn_end', durationMs: 1000 }])
    const out = render(s, 5000)
    expect(out).toContain('✅ <b>Done</b>')
    expect(out).not.toContain('⚙️ <b>Working…</b>')
  })

  it('renders running item with elapsed time (tool name bolded)', () => {
    const s = fold([enqueue('test'), { kind: 'tool_use', toolName: 'Bash' }])
    // tool_use fired at t=1100, render at t=3200 → 2.1s elapsed for the item
    const out = render(s, 3200)
    expect(out).toContain('🔧 <b>Bash</b>')
    expect(out).toContain('(00:02)')
  })

  it('renders done items without duration when sub-second', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Read' }, // t=1100
      { kind: 'tool_result', toolUseId: 'x', toolName: 'Read' }, // t=1200
    ])
    const out = render(s, 1300)
    expect(out).toContain('✅ Read')
    expect(out).not.toContain('(00:00)')
  })

  it('renders done items with duration when over 1s', () => {
    const s = fold(
      [
        enqueue('test'),
        { kind: 'tool_use', toolName: 'Bash' },
        { kind: 'tool_result', toolUseId: 'x', toolName: 'Bash' },
      ],
      1000,
    )
    // Manually advance the clock between the two events by reducing separately
    let st = reduce(initialState(), enqueue('test'), 1000)
    st = reduce(st, { kind: 'tool_use', toolName: 'Bash' }, 1100)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'x', toolName: 'Bash' }, 4200)
    const out = render(st, 4300)
    expect(out).toContain('✅ Bash')
    expect(out).toContain('(00:03)')
  })

  it('rolls up 5+ consecutive identical done tools', () => {
    let st: ProgressCardState = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    for (let i = 0; i < 6; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `${i}`, toolName: 'Read' }, 1150 + i * 100)
    }
    const out = render(st, 2000)
    expect(out).toContain('✅ Read <i>×6</i>')
    // Only one rollup line, not six
    expect(out.match(/Read/g) ?? []).toHaveLength(1)
  })

  it('does NOT roll up when the run includes a running item', () => {
    let st: ProgressCardState = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    for (let i = 0; i < 5; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `${i}`, toolName: 'Read' }, 1150 + i * 100)
    }
    st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1800)
    const out = render(st, 2000)
    expect(out).not.toContain('×5')
    expect(out).toContain('🔧 <b>Read</b>')
  })

  it('does NOT roll up mixed tools', () => {
    let st: ProgressCardState = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    const tools = ['Read', 'Grep', 'Read', 'Grep', 'Read', 'Grep']
    for (let i = 0; i < tools.length; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: tools[i] }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `${i}`, toolName: tools[i] }, 1150 + i * 100)
    }
    const out = render(st, 2000)
    expect(out).not.toContain('×')
    expect(out.match(/Read/g) ?? []).toHaveLength(3)
    expect(out.match(/Grep/g) ?? []).toHaveLength(3)
  })

  it('truncates long user requests', () => {
    const long = 'a'.repeat(300)
    const s = fold([enqueue(long)])
    const out = render(s, 2000)
    // Header uses 120-char truncate with ellipsis
    expect(out).toContain('aaa…')
    expect(out.split('\n')[0].length).toBeLessThanOrEqual(125)
  })

  it('escapes HTML in user text and latestText', () => {
    const s = fold([
      enqueue('fix <script>alert(1)</script>'),
      { kind: 'text', text: 'my plan: <img>' },
    ])
    const out = render(s, 2000)
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('&lt;img&gt;')
    expect(out).not.toContain('<script>')
  })

  it('header banner reflects the active stage', () => {
    // Stage is no longer rendered as an inline Plan→Run→Done line; the
    // single source of truth is the header banner at the top of the card.
    let st = fold([enqueue('test')])
    expect(render(st, 1500)).toContain('⚙️ <b>Working…</b>')
    st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1500)
    expect(render(st, 1600)).toContain('⚙️ <b>Working…</b>')
    expect(render(st, 1600)).toContain('🔧 <b>Read</b>')
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1700)
    const done = render(st, 1700)
    expect(done).toContain('✅ <b>Done</b>')
    expect(done).not.toContain('⚙️ <b>Working…</b>')
  })

  it('hides thought line on done stage', () => {
    let st = fold([enqueue('test'), { kind: 'text', text: 'thinking…' }])
    expect(render(st, 1500)).toContain('💭')
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1700)
    expect(render(st, 1700)).not.toContain('💭')
  })

  it('renders stable output between renders when no events fire', () => {
    // Core anti-flicker guarantee: render(state, now1) should only differ from
    // render(state, now2) in time-dependent fields (elapsed time on the
    // running item and in the header). Nothing above the running line moves.
    let st = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Read' },
      { kind: 'tool_result', toolUseId: 'a', toolName: 'Read' },
      { kind: 'tool_use', toolName: 'Bash' },
    ])
    const a = render(st, 5000).split('\n')
    const b = render(st, 5100).split('\n')
    // The ✅ Read line is identical between the two renders.
    const readLineA = a.find((l) => l.includes('✅ Read'))
    const readLineB = b.find((l) => l.includes('✅ Read'))
    expect(readLineA).toBe(readLineB)
    // Only the header (⏱) and the running Bash line differ.
    const diff = a.filter((l, i) => l !== b[i])
    expect(diff.length).toBeLessThanOrEqual(2)
  })
})
