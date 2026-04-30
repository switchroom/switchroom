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
  compactItems,
  formatDuration,
  type ProgressCardState,
  type ChecklistItem,
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
    expect(render(initialState(), 0)).toBe('○ Waiting…')
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
      { kind: 'tool_result', toolUseId: 'toolu_B', toolName: null, isError: true, errorText: 'unhandled exception: segfault' },
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

  it('text event updates latestText and creates narrative steps', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: 'thinking about it' },
      { kind: 'text', text: 'actually…' },
    ])
    expect(s.latestText).toBe('actually…')
    expect(s.narratives).toHaveLength(2)
    expect(s.narratives[0].text).toBe('thinking about it')
    expect(s.narratives[0].state).toBe('done')
    expect(s.narratives[1].text).toBe('actually…')
    expect(s.narratives[1].state).toBe('active')
  })

  it('text event extracts first line as narrative label', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: 'First line\nSecond line\nThird line' },
    ])
    expect(s.narratives[0].text).toBe('First line')
  })

  it('empty text event does not create narrative', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: '   ' },
    ])
    expect(s.narratives).toHaveLength(0)
  })

  it('tool_use increments active narrative toolCount', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: 'Let me check' },
      { kind: 'tool_use', toolName: 'Read' },
      { kind: 'tool_use', toolName: 'Grep' },
    ])
    expect(s.narratives[0].toolCount).toBe(2)
  })

  it('turn_end closes active narratives', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: 'Working on it' },
      { kind: 'turn_end', durationMs: 500 },
    ])
    expect(s.narratives[0].state).toBe('done')
  })

  it('text event stashes pendingPreamble for the next tool_use', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: "Let me check the reducer" },
    ])
    expect(s.pendingPreamble).toBe('Let me check the reducer')
  })

  it('tool_use consumes pendingPreamble and uses it as the Read label', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: 'Reading the reducer implementation' },
      { kind: 'tool_use', toolName: 'Read', input: { file_path: '/x/progress-card.ts' } },
    ])
    expect(s.items[0].label).toBe('Reading the reducer implementation')
    expect(s.pendingPreamble).toBeFalsy()
  })

  it('sibling tool_use in the same batch does NOT reuse the preamble', () => {
    // Simulating the "parallel tool_use" case: one text block followed
    // by two tool_use blocks in the same assistant message. Only the
    // first should adopt the preamble; the second falls back.
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: 'Checking a couple files' },
      { kind: 'tool_use', toolName: 'Read', input: { file_path: '/x/a.ts' } },
      { kind: 'tool_use', toolName: 'Read', input: { file_path: '/x/b.ts' } },
    ])
    expect(s.items[0].label).toBe('Checking a couple files')
    expect(s.items[1].label).toBe('b.ts')
  })

  it('tool_use without a preceding preamble keeps the filename fallback', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Read', input: { file_path: '/x/a.ts' } },
    ])
    expect(s.items[0].label).toBe('a.ts')
  })

  it('multi-line text becomes a narrative, not a preamble → filename fallback', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'text', text: "Here's my plan:\n1. foo\n2. bar" },
      { kind: 'tool_use', toolName: 'Read', input: { file_path: '/x/a.ts' } },
    ])
    expect(s.items[0].label).toBe('a.ts')
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
    // User request is no longer rendered as a blockquote — it is shown via
    // Telegram's native reply banner (reply_parameters on sendMessage).
    expect(out).not.toContain('<blockquote>')
    expect(out).not.toContain('🤔 Plan')
  })

  it('renders a distinctive "Working…" header while in-progress', () => {
    const s = fold([enqueue('fix tests')])
    const out = render(s, 5000)
    const lines = out.split('\n')
    const headerLine = lines.find(l => l.includes('⚙️ <b>Working…</b>'))
    expect(headerLine).toBeDefined()
    // No blockquote — user request shown via Telegram native reply banner.
    expect(out).not.toContain('<blockquote>')
    expect(out).not.toContain('─ ─ ─')
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
    const out = render(s, 3200)
    expect(out).toContain('◉ <b><code>Bash</code></b>')
    expect(out).toContain('(00:02)')
  })

  it('renders done items without duration when sub-second', () => {
    const s = fold([
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Read' },
      { kind: 'tool_result', toolUseId: 'x', toolName: 'Read' },
    ])
    const out = render(s, 1300)
    expect(out).toContain('● <code>Read</code>')
    expect(out).not.toContain('(00:00)')
  })

  it('renders done items with duration when over 1s', () => {
    let st = reduce(initialState(), enqueue('test'), 1000)
    st = reduce(st, { kind: 'tool_use', toolName: 'Bash' }, 1100)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'x', toolName: 'Bash' }, 4200)
    const out = render(st, 4300)
    expect(out).toContain('● <code>Bash</code>')
    expect(out).toContain('(00:03)')
  })

  it('rolls up 2+ consecutive identical done tools (threshold lowered from 5)', () => {
    let st: ProgressCardState = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    for (let i = 0; i < 6; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `${i}`, toolName: 'Read' }, 1150 + i * 100)
    }
    const out = render(st, 2000)
    expect(out).toContain('● Read <i>×6</i>')
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
    expect(out).toContain('◉ <b><code>Read</code></b>')
  })

  it('does NOT roll up mixed tools', () => {
    let st: ProgressCardState = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    // 5 tools fits within MAX_VISIBLE_ITEMS so all are visible and none are rolled up
    const tools = ['Read', 'Grep', 'Read', 'Grep', 'Read']
    for (let i = 0; i < tools.length; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: tools[i] }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `${i}`, toolName: tools[i] }, 1150 + i * 100)
    }
    const out = render(st, 2000)
    expect(out).not.toContain('×')
    expect(out.match(/Read/g) ?? []).toHaveLength(3)
    expect(out.match(/Grep/g) ?? []).toHaveLength(2)
  })

  it('rolls up exactly 2 identical done items (B1: new lower threshold)', () => {
    // The old threshold was 5. With the new threshold=2, just two consecutive
    // identical tool+label items should collapse.
    let st = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    st = reduce(st, { kind: 'tool_use', toolName: 'Bash', input: { command: 'git status' } }, 1100)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'a', toolName: 'Bash' }, 1200)
    st = reduce(st, { kind: 'tool_use', toolName: 'Bash', input: { command: 'git status' } }, 1300)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'b', toolName: 'Bash' }, 1400)
    const out = render(st, 2000)
    expect(out).toContain('×2')
    // Label is shown in the rollup (B3: identical label preserved)
    expect(out).toContain('git status')
    // Only one Bash line, not two
    expect(out.match(/Bash/g) ?? []).toHaveLength(1)
  })

  it('includes label in rollup when all items share the same label (B3: semantic label dedup)', () => {
    // B3: when items have identical tool+label, the label is preserved in the
    // rollup. Instead of "Read ×3" (which drops context), user sees "Read foo.ts ×3".
    let st = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    for (let i = 0; i < 3; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: 'Read', input: { file_path: '/project/src/foo.ts' } }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `r${i}`, toolName: 'Read' }, 1150 + i * 100)
    }
    const out = render(st, 2000)
    // Should show "Read foo.ts ×3", not just "Read ×3"
    expect(out).toContain('foo.ts')
    expect(out).toContain('×3')
    expect(out.match(/Read/g) ?? []).toHaveLength(1)
  })

  it('collapses 3+ same-tool mixed-label items into a label-free rollup (C1: heuristic)', () => {
    let st = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    const files = ['alpha.ts', 'beta.ts', 'gamma.ts']
    for (let i = 0; i < files.length; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: 'Read', input: { file_path: `/src/${files[i]}` } }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `r${i}`, toolName: 'Read' }, 1150 + i * 100)
    }
    const out = render(st, 2000)
    expect(out).toContain('● Read')
    expect(out).toContain('×3')
    expect(out).not.toContain('alpha')
    expect(out).not.toContain('beta')
    expect(out).not.toContain('gamma')
    expect(out.match(/Read/g) ?? []).toHaveLength(1)
  })

  it('does NOT collapse 2 same-tool mixed-label items (below MIXED_ROLLUP_THRESHOLD=3)', () => {
    // Two Read calls with different files stay separate — only 3+ triggers
    // the mixed-label heuristic rollup.
    let st = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    st = reduce(st, { kind: 'tool_use', toolName: 'Read', input: { file_path: '/src/a.ts' } }, 1100)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'r0', toolName: 'Read' }, 1200)
    st = reduce(st, { kind: 'tool_use', toolName: 'Read', input: { file_path: '/src/b.ts' } }, 1300)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'r1', toolName: 'Read' }, 1400)
    const out = render(st, 2000)
    // Two different files — no rollup, both visible
    expect(out).not.toContain('×')
    expect(out).toContain('a.ts')
    expect(out).toContain('b.ts')
  })

  it('mixed-label run of 4 collapses; same-label pair within the same tool stays labeled', () => {
    // Regression: ensure a run that has ≥3 mixed labels collapses even if some
    // items within it share a label.
    let st = initialState()
    st = reduce(st, enqueue('scan'), 1000)
    const files = ['a.ts', 'a.ts', 'b.ts', 'c.ts'] // first two are same, last two differ
    for (let i = 0; i < files.length; i++) {
      st = reduce(st, { kind: 'tool_use', toolName: 'Read', input: { file_path: `/src/${files[i]}` } }, 1100 + i * 100)
      st = reduce(st, { kind: 'tool_result', toolUseId: `r${i}`, toolName: 'Read' }, 1150 + i * 100)
    }
    const out = render(st, 2000)
    // The run [a.ts, a.ts, b.ts, c.ts] has 4 items with mixed labels → C1 applies
    expect(out).toContain('×4')
    // No individual file names shown (label dropped because mixed)
    expect(out).not.toContain('a.ts')
    expect(out).not.toContain('b.ts')
  })

  it('does not render the user request as a blockquote (shown via Telegram reply banner)', () => {
    const long = 'a'.repeat(300)
    const s = fold([enqueue(long)])
    const out = render(s, 2000)
    // The user request is no longer in the HTML — it appears as a Telegram
    // native reply banner (reply_parameters) which is outside the HTML body.
    expect(out).not.toContain('<blockquote>')
    expect(out).not.toContain('aaa')
  })

  it('escapes HTML in latestText', () => {
    const s = fold([
      enqueue('fix <script>alert(1)</script>'),
      { kind: 'text', text: 'my plan: <img>' },
    ])
    const out = render(s, 2000)
    // User request is no longer in the HTML (shown via Telegram reply banner),
    // so the script tag does not appear in the rendered card HTML at all.
    expect(out).not.toContain('script')
    // latestText IS still rendered, and its HTML must be escaped.
    expect(out).toContain('&lt;img&gt;')
    expect(out).not.toContain('<img>')
  })

  it('header banner reflects the active stage', () => {
    let st = fold([enqueue('test')])
    expect(render(st, 1500)).toContain('⚙️ <b>Working…</b>')
    st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1500)
    expect(render(st, 1600)).toContain('⚙️ <b>Working…</b>')
    expect(render(st, 1600)).toContain('◉ <b><code>Read</code></b>')
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1700)
    const done = render(st, 1700)
    expect(done).toContain('✅ <b>Done</b>')
    expect(done).not.toContain('⚙️ <b>Working…</b>')
  })

  it('hides thought line on done stage', () => {
    let st = fold([enqueue('test'), { kind: 'text', text: 'thinking…' }])
    // Text events now create narrative steps; thought bubble suppressed when narratives exist
    expect(render(st, 1500)).toContain('◉ <b>thinking…</b>')
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1700)
    expect(render(st, 1700)).toContain('● <s>thinking…</s>')
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
    const readLineA = a.find((l) => l.includes('● Read'))
    const readLineB = b.find((l) => l.includes('● Read'))
    expect(readLineA).toBe(readLineB)
    // Only the header (⏱) and the running Bash line differ.
    const diff = a.filter((l, i) => l !== b[i])
    expect(diff.length).toBeLessThanOrEqual(2)
  })
  it('renders narrative steps when text events exist', () => {
    let st = reduce(initialState(), enqueue('fix tests'), 1000)
    st = reduce(st, { kind: 'text', text: 'Let me check the test files' }, 1100)
    st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1200)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'a', toolName: 'Read' }, 1500)
    st = reduce(st, { kind: 'text', text: 'Found the issue in merge.ts' }, 2000)
    st = reduce(st, { kind: 'tool_use', toolName: 'Edit' }, 2100)
    const out = render(st, 3000)
    // Narrative steps are primary — no tool names visible
    expect(out).toContain('● <s>Let me check the test files</s>')
    expect(out).toContain('◉ <b>Found the issue in merge.ts</b>')
    expect(out).not.toContain('Read')
    expect(out).not.toContain('Edit')
  })

  it('falls back to tool checklist when no narratives exist', () => {
    let st = reduce(initialState(), enqueue('test'), 1000)
    st = reduce(st, { kind: 'tool_use', toolName: 'Read' }, 1100)
    const out = render(st, 2000)
    expect(out).toContain('◉ <b><code>Read</code></b>')
    expect(out).not.toContain('●')
  })

  it('narrative overflow shows (+N earlier)', () => {
    let st = reduce(initialState(), enqueue('test'), 1000)
    for (let i = 0; i < 7; i++) {
      st = reduce(st, { kind: 'text', text: `Step ${i + 1}` }, 1100 + i * 100)
    }
    const out = render(st, 2000)
    expect(out).toContain('(+2 earlier)')
    expect(out).not.toContain('Step 1')
    expect(out).not.toContain('Step 2')
    expect(out).toContain('Step 3')
    expect(out).toContain('Step 7')
  })

  it('thinking indicator shows when no narratives and model is thinking', () => {
    let st = reduce(initialState(), enqueue('test'), 1000)
    st = reduce(st, { kind: 'thinking' }, 1100)
    const out = render(st, 1500)
    expect(out).toContain('◉ <i>Thinking…</i>')
  })

  it('suppresses raw mcp__ tool name prefix when label is present', () => {
    // The checklist used to render:
    //   "mcp__switchroom-telegram__stream_reply Telegram: stream_reply (…)"
    // after the MCP polish it should render the friendly label alone.
    let st = reduce(initialState(), enqueue('polish test'), 1000)
    st = reduce(
      st,
      {
        kind: 'tool_use',
        toolName: 'mcp__switchroom-telegram__stream_reply',
        toolUseId: 'toolu_x',
        input: { text: 'Hello world' },
      },
      1100,
    )
    const out = render(st, 1500)
    expect(out).not.toContain('mcp__switchroom-telegram__stream_reply')
    expect(out).toContain('Telegram: stream_reply')
  })

  it('strips HTML tags from MCP preview so <b> does not leak as literal text', () => {
    let st = reduce(initialState(), enqueue('html leak test'), 1000)
    st = reduce(
      st,
      {
        kind: 'tool_use',
        toolName: 'mcp__switchroom-telegram__stream_reply',
        toolUseId: 'toolu_y',
        input: { text: '<b>Recommendation, priority-ordered:</b> 1a' },
      },
      1100,
    )
    const out = render(st, 1500)
    // escapeHtml would turn a surviving '<b>' into '&lt;b&gt;' in the
    // final string. Assert neither form appears.
    expect(out).not.toContain('<b>Recommendation')
    expect(out).not.toContain('&lt;b&gt;Recommendation')
    expect(out).toContain('Recommendation')
  })

  // ─── Deferred-completion header: "Working…" while sub-agents outlive turn_end ───
  //
  // Root cause covered by these tests: after parent turn_end the reducer
  // sets stage='done' unconditionally, but background Agent sub-agents
  // can still be running. Pre-fix the header rendered "✅ Done" and the
  // heartbeat stopped re-rendering — users saw a frozen ✅ card while
  // the sub-agent ground away. Post-fix "truly done" means
  // stage==='done' AND no in-flight sub-agents.

  it('shows "Working…" header while sub-agent outlives parent turn_end', () => {
    let st = reduce(initialState(), enqueue('deferred test'), 1000)
    st = reduce(st, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'toolu_a',
      input: { description: 'run review', subagent_type: 'reviewer' },
    }, 1100)
    st = reduce(st, {
      kind: 'sub_agent_started',
      agentId: 'agent-x',
      firstPromptText: 'run review',
      subagentType: 'reviewer',
    }, 1200)
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1500)

    // Sanity: reducer still flips stage='done' internally, but the
    // sub-agent is still running — so the header should reflect
    // "still working" to the user.
    expect(st.stage).toBe('done')
    const out = render(st, 2000)
    expect(out).toContain('⚙️')
    expect(out).toContain('Working')
    expect(out).not.toContain('✅')
  })

  it('flips header to "✅ Done" once last sub-agent finishes', () => {
    let st = reduce(initialState(), enqueue('deferred completion'), 1000)
    st = reduce(st, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'toolu_b',
      input: { description: 'run review', subagent_type: 'reviewer' },
    }, 1100)
    st = reduce(st, {
      kind: 'sub_agent_started',
      agentId: 'agent-y',
      firstPromptText: 'run review',
      subagentType: 'reviewer',
    }, 1200)
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1500)
    // Sub-agent finishes after parent turn_end.
    st = reduce(st, {
      kind: 'sub_agent_turn_end',
      agentId: 'agent-y',
      durationMs: 2000,
    }, 3500)

    const out = render(st, 3600)
    expect(out).toContain('✅')
    expect(out).toContain('Done')
  })
})

// ─── #324: awaiting-subagent narrative-step tests ────────────────────────

describe('progress-card — #324 awaiting-subagent narrative step', () => {
  // Helper: build the common setup: enqueue → text (narrative) → Agent tool_use
  function buildWithAgentDispatch(agentId = 'sa1', toolUseId = 'toolu_324') {
    let st = reduce(initialState(), enqueue('run review'), 1000)
    st = reduce(st, { kind: 'text', text: 'Dispatching background review' }, 1100)
    st = reduce(st, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId,
      input: { description: 'run review', prompt: 'PROMPT', subagent_type: 'reviewer' },
    }, 1200)
    st = reduce(st, {
      kind: 'sub_agent_started',
      agentId,
      firstPromptText: 'PROMPT',
      subagentType: 'reviewer',
    }, 1300)
    return { st, agentId, toolUseId }
  }

  it('awaiting-subagent step renders as ◉ (active), not ● (done)', () => {
    // After turn_end with sub-agent still running, the narrative step should
    // be in awaiting-subagent state and render with ◉, not ●.
    let { st, agentId } = buildWithAgentDispatch()
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1500)
    // Sub-agent is still running at render time.
    expect(st.subAgents.get(agentId)?.state).toBe('running')
    const out = render(st, 2000)
    // Must render as active (◉) not done (●).
    expect(out).toContain('◉')
    expect(out).toContain('Dispatching background review')
    expect(out).not.toMatch(/●.*Dispatching background review/)
  })

  it('state machine: background Agent dispatch → step ends in awaiting-subagent, not done', () => {
    let { st } = buildWithAgentDispatch()
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1500)
    const narrative = st.narratives.find(n => n.text === 'Dispatching background review')!
    expect(narrative).toBeDefined()
    expect(narrative.state).toBe('awaiting-subagent')
  })

  it('state machine: sub_agent_turn_end transitions awaiting-subagent step to done', () => {
    let { st, agentId } = buildWithAgentDispatch()
    st = reduce(st, { kind: 'turn_end', durationMs: 500 }, 1500)
    // Confirm awaiting-subagent before the sub-agent finishes.
    const before = st.narratives.find(n => n.text === 'Dispatching background review')!
    expect(before.state).toBe('awaiting-subagent')
    // Sub-agent completes.
    st = reduce(st, { kind: 'sub_agent_turn_end', agentId, durationMs: 2000 }, 3500)
    const after = st.narratives.find(n => n.text === 'Dispatching background review')!
    expect(after.state).toBe('done')
  })

  it('regression: foreground tool_result flips narrative step directly to done', () => {
    // A non-Agent tool call (foreground) should still flip to done immediately —
    // no awaiting-subagent detour.
    let st = reduce(initialState(), enqueue('read a file'), 1000)
    st = reduce(st, { kind: 'text', text: 'Reading the file' }, 1100)
    st = reduce(st, { kind: 'tool_use', toolName: 'Read', toolUseId: 'toolu_r', input: { file_path: '/x' } }, 1200)
    st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_r', toolName: 'Read' }, 1300)
    st = reduce(st, { kind: 'text', text: 'Done reading' }, 1400)
    const narrative = st.narratives.find(n => n.text === 'Reading the file')!
    expect(narrative).toBeDefined()
    expect(narrative.state).toBe('done')
  })
})

// ─── Multi-agent correlation reducer tests ───────────────────────────────
//
// Renderer is unchanged in this PR, so we only assert state-shape — the
// rendered HTML is verified by the renderer PR.

describe('progress-card reducer — multi-agent correlation', () => {
  it('forward race: parent Agent tool_use stages a pendingAgentSpawn', () => {
    const st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'design ux', prompt: 'PROMPT-A', subagent_type: 'researcher' },
      },
    ])
    expect(st.pendingAgentSpawns.size).toBe(1)
    expect(st.pendingAgentSpawns.get('toolu_p1')?.promptText).toBe('PROMPT-A')
    expect(st.subAgents.size).toBe(0)
  })

  it('forward race: sub_agent_started moves pending → subAgents and links checklist item', () => {
    const st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'design ux', prompt: 'PROMPT-A' },
      },
      { kind: 'sub_agent_started', agentId: 'aaa', firstPromptText: 'PROMPT-A' },
    ])
    expect(st.pendingAgentSpawns.size).toBe(0)
    expect(st.subAgents.size).toBe(1)
    const sa = st.subAgents.get('aaa')!
    expect(sa.parentToolUseId).toBe('toolu_p1')
    expect(sa.description).toBe('design ux')
    expect(sa.state).toBe('running')
    // Checklist item linked
    const agentItem = st.items.find((i) => i.toolUseId === 'toolu_p1')!
    expect(agentItem.spawnedAgentId).toBe('aaa')
  })

  it('reverse race: sub_agent_started lands first as orphan, then parent adopts', () => {
    const st = fold([
      enqueue('go'),
      { kind: 'sub_agent_started', agentId: 'bbb', firstPromptText: 'PROMPT-B' },
    ])
    expect(st.subAgents.get('bbb')?.parentToolUseId).toBeNull()
    expect(st.subAgents.get('bbb')?.description).toBe('(uncorrelated)')
    const st2 = reduce(
      st,
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p2',
        input: { description: 'audit', prompt: 'PROMPT-B' },
      },
      9999,
    )
    expect(st2.pendingAgentSpawns.size).toBe(0)
    expect(st2.subAgents.get('bbb')?.parentToolUseId).toBe('toolu_p2')
    expect(st2.subAgents.get('bbb')?.description).toBe('audit')
  })

  it('two parallel Agent calls with identical prompts: FIFO arrival order assigns', () => {
    // Parent emits two Agent tool_uses with the SAME prompt text. Two
    // sub-agent JSONLs appear in some order. Each sub_agent_started
    // adopts the FIRST remaining pending spawn (FIFO).
    let st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'first', prompt: 'DUP' },
      },
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p2',
        input: { description: 'second', prompt: 'DUP' },
      },
    ])
    st = reduce(st, { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'DUP' }, 5000)
    st = reduce(st, { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'DUP' }, 5100)
    // Both correlated, deterministic FIFO
    expect(st.subAgents.get('A')?.parentToolUseId).toBe('toolu_p1')
    expect(st.subAgents.get('B')?.parentToolUseId).toBe('toolu_p2')
    expect(st.pendingAgentSpawns.size).toBe(0)
  })

  it('reverse-race with duplicate prompts: oldest-startedAt orphan wins adoption', () => {
    // Two sub-agent JSONLs land FIRST (reverse race), both with the
    // same firstPromptText. Their `startedAt` stamps reflect the order
    // they were discovered. When the parents arrive, they should adopt
    // in the same order (parent_1 → oldest orphan, parent_2 → newer).
    //
    // Prior implementation used JS Map insertion order as the
    // tiebreaker — which matches startedAt in this direct-reduce case
    // but can diverge under concurrent JSONL file-watch delivery.
    // The explicit startedAt tiebreaker makes adoption deterministic.
    let st = fold([enqueue('go')])
    st = reduce(st, { kind: 'sub_agent_started', agentId: 'older', firstPromptText: 'DUP' }, 5000)
    st = reduce(st, { kind: 'sub_agent_started', agentId: 'newer', firstPromptText: 'DUP' }, 5100)
    // Both orphans.
    expect(st.subAgents.get('older')?.parentToolUseId).toBeNull()
    expect(st.subAgents.get('newer')?.parentToolUseId).toBeNull()

    // First parent lands — should adopt the oldest.
    st = reduce(
      st,
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'first', prompt: 'DUP' } },
      5200,
    )
    expect(st.subAgents.get('older')?.parentToolUseId).toBe('toolu_p1')
    expect(st.subAgents.get('older')?.description).toBe('first')
    expect(st.subAgents.get('newer')?.parentToolUseId).toBeNull()

    // Second parent adopts the remaining orphan.
    st = reduce(
      st,
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p2', input: { description: 'second', prompt: 'DUP' } },
      5300,
    )
    expect(st.subAgents.get('newer')?.parentToolUseId).toBe('toolu_p2')
    expect(st.subAgents.get('newer')?.description).toBe('second')
    expect(st.pendingAgentSpawns.size).toBe(0)
  })

  it('reverse-race tiebreaker: later-arriving orphan with earlier startedAt is adopted first', () => {
    // Construct a state where map-insertion-order DIFFERS from
    // startedAt order. Simulates a file-watcher that delivered the
    // "newer" sub-agent JSONL first despite it starting later — which
    // can happen when FS events are buffered across CPU-bound gaps.
    //
    // Without the startedAt tiebreaker, first-match-wins on Map
    // iteration would mis-pair; with it, the older `startedAt` always
    // wins regardless of Map insertion order.
    let st = fold([enqueue('go')])
    // Insert "newer" (later startedAt) first in the map, then "older" (earlier startedAt).
    st = reduce(st, { kind: 'sub_agent_started', agentId: 'newer', firstPromptText: 'DUP' }, 6100)
    st = reduce(st, { kind: 'sub_agent_started', agentId: 'older', firstPromptText: 'DUP' }, 6000)

    // Sanity: map iteration is insertion order.
    expect([...st.subAgents.keys()]).toEqual(['newer', 'older'])

    // First parent adopts — should pick 'older' despite 'newer' being first in map.
    st = reduce(
      st,
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'first', prompt: 'DUP' } },
      6200,
    )
    expect(st.subAgents.get('older')?.parentToolUseId).toBe('toolu_p1')
    expect(st.subAgents.get('newer')?.parentToolUseId).toBeNull()
  })

  it('sub_agent_tool_use sets currentTool (toolCount still 0 until result arrives)', () => {
    // Gap 5 fix (#316): toolCount increments on sub_agent_tool_result (completed),
    // NOT on sub_agent_tool_use (started), so the count reflects tools that have
    // actually finished. After tool_use alone, toolCount stays 0.
    let st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'd', prompt: 'P' },
      },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
    ])
    st = reduce(
      st,
      { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 'toolu_x1', toolName: 'Read', input: { file_path: '/f' } },
      6000,
    )
    const sa = st.subAgents.get('X')!
    expect(sa.toolCount).toBe(0)
    expect(sa.currentTool?.tool).toBe('Read')
    // Tool result increments toolCount and clears currentTool
    st = reduce(st, { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: 'toolu_x1' }, 6100)
    expect(st.subAgents.get('X')!.currentTool).toBeUndefined()
    expect(st.subAgents.get('X')!.toolCount).toBe(1)
  })

  it('sub_agent_text stashes pendingPreamble on the target sub-agent only', () => {
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a', input: { description: 'dA', prompt: 'PA' } },
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_b', input: { description: 'dB', prompt: 'PB' } },
      { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'PA' },
      { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'PB' },
    ])
    st = reduce(st, { kind: 'sub_agent_text', agentId: 'A', text: 'Checking the reducer' }, 6000)
    expect(st.subAgents.get('A')?.pendingPreamble).toBe('Checking the reducer')
    // B must not receive A's preamble — per-sub-agent isolation.
    expect(st.subAgents.get('B')?.pendingPreamble ?? null).toBeNull()
  })

  it('sub_agent_tool_use consumes + clears pendingPreamble and uses it as the Read label', () => {
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'd', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_text', agentId: 'X', text: 'Reading the reducer implementation' },
    ])
    st = reduce(
      st,
      { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 'toolu_x1', toolName: 'Read', input: { file_path: '/x/progress-card.ts' } },
      6000,
    )
    const sa = st.subAgents.get('X')!
    expect(sa.currentTool?.label).toBe('Reading the reducer implementation')
    expect(sa.pendingPreamble ?? null).toBeNull()
  })

  it('sibling sub_agent_tool_use (no new text between) falls back to basename', () => {
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'd', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_text', agentId: 'X', text: 'Checking a couple files' },
    ])
    st = reduce(
      st,
      { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 'toolu_x1', toolName: 'Read', input: { file_path: '/x/a.ts' } },
      6000,
    )
    st = reduce(
      st,
      { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 'toolu_x2', toolName: 'Read', input: { file_path: '/x/b.ts' } },
      6100,
    )
    // The sub-agent's currentTool reflects the latest tool_use; second
    // tool_use in the same batch should NOT inherit the preamble — falls
    // back to filename.
    expect(st.subAgents.get('X')?.currentTool?.label).toBe('b.ts')
  })

  it('multi-line sub_agent_text is a narrative, not a preamble → basename fallback', () => {
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'd', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_text', agentId: 'X', text: "Here's my plan:\n1. foo\n2. bar" },
    ])
    st = reduce(
      st,
      { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 'toolu_x1', toolName: 'Read', input: { file_path: '/x/a.ts' } },
      6000,
    )
    expect(st.subAgents.get('X')?.currentTool?.label).toBe('a.ts')
  })

  it("sub_agent_text for agent A does NOT leak onto sub-agent B's tool_use", () => {
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a', input: { description: 'dA', prompt: 'PA' } },
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_b', input: { description: 'dB', prompt: 'PB' } },
      { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'PA' },
      { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'PB' },
      { kind: 'sub_agent_text', agentId: 'A', text: 'A is checking the reducer' },
    ])
    st = reduce(
      st,
      { kind: 'sub_agent_tool_use', agentId: 'B', toolUseId: 'toolu_b1', toolName: 'Read', input: { file_path: '/x/b.ts' } },
      6000,
    )
    // B uses its own (empty) preamble → filename fallback.
    expect(st.subAgents.get('B')?.currentTool?.label).toBe('b.ts')
    // A's preamble is still waiting for A's tool_use.
    expect(st.subAgents.get('A')?.pendingPreamble).toBe('A is checking the reducer')
  })

  it('sub_agent_text for an unknown agent is a no-op', () => {
    const st = fold([
      enqueue('go'),
      { kind: 'sub_agent_text', agentId: 'ghost', text: 'nobody home' },
    ])
    expect(st.subAgents.has('ghost')).toBe(false)
  })

  // ── Issue #305 Option A: sub_agent_narrative reducer + render ─────────────

  it('sub_agent_narrative sets currentNarrative and bumps lastEventAt', () => {
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'd', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
    ])
    const before = st.subAgents.get('X')!
    const beforeMilestone = before.milestoneVersion
    st = reduce(st, { kind: 'sub_agent_narrative', agentId: 'X', text: 'Analyzing 12 files in /src/auth' }, 7000)
    const sa = st.subAgents.get('X')!
    expect(sa.currentNarrative).toBe('Analyzing 12 files in /src/auth')
    expect(sa.lastEventAt).toBe(7000)
    // Per-tick update — milestoneVersion must NOT bump.
    expect(sa.milestoneVersion).toBe(beforeMilestone)
  })

  it('sub_agent_narrative for an unknown agent is a no-op', () => {
    const before = fold([enqueue('go')])
    const after = reduce(before, { kind: 'sub_agent_narrative', agentId: 'ghost', text: 'nobody home' }, 5000)
    // State must be untouched (same reference is fine; subAgents must not have ghost).
    expect(after.subAgents.has('ghost')).toBe(false)
    expect(after).toBe(before)
  })

  it('subsequent sub_agent_narrative replaces prior narrative (last write wins)', () => {
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'd', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
    ])
    st = reduce(st, { kind: 'sub_agent_narrative', agentId: 'X', text: 'first line' }, 7000)
    expect(st.subAgents.get('X')!.currentNarrative).toBe('first line')
    st = reduce(st, { kind: 'sub_agent_narrative', agentId: 'X', text: 'second line' }, 7100)
    expect(st.subAgents.get('X')!.currentNarrative).toBe('second line')
  })

  it('renders currentNarrative ↳ <i>...</i> above pendingPreamble in running fallback chain', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('go'),
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'work', prompt: 'P' } },
        { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
        // Both pendingPreamble and currentNarrative present — narrative must win.
        { kind: 'sub_agent_text', agentId: 'X', text: 'preamble line that should lose' },
        { kind: 'sub_agent_narrative', agentId: 'X', text: 'Analyzing 12 files in /src/auth' },
      ])
      const html = render(st, 7000)
      expect(html).toContain('↳ <i>Analyzing 12 files in /src/auth</i>')
      // pendingPreamble must NOT appear in the inner-body fallback line —
      // the narrative branch ran first.
      expect(html).not.toContain('preamble line that should lose')
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('terminal-state render does not surface currentNarrative (terminal branch only renders lastCompletedTool / count)', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('go'),
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'work', prompt: 'P' } },
        { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
        { kind: 'sub_agent_narrative', agentId: 'X', text: 'narrative-that-should-not-render-in-done' },
        // Move sub-agent into terminal 'done' state via the parent tool_result path.
        { kind: 'tool_result', toolUseId: 'toolu_p1', toolName: 'Agent', isError: false },
      ])
      const sa = st.subAgents.get('X')!
      // Sanity: state must be terminal and the narrative must still be on the slot.
      expect(sa.state).toBe('done')
      expect(sa.currentNarrative).toBe('narrative-that-should-not-render-in-done')
      const html = render(st, 7000)
      // Terminal branch falls through to lastCompletedTool / "N tools completed".
      // The narrative text must not appear in the rendered output.
      expect(html).not.toContain('narrative-that-should-not-render-in-done')
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it("parent's tool_result is authoritative: overrides early sub_agent_turn_end on isError", () => {
    let st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'd', prompt: 'P' },
      },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_turn_end', agentId: 'X' },
    ])
    expect(st.subAgents.get('X')?.state).toBe('done')
    st = reduce(
      st,
      { kind: 'tool_result', toolUseId: 'toolu_p1', toolName: 'Agent', isError: true, errorText: 'unhandled exception in sub-agent' },
      7000,
    )
    expect(st.subAgents.get('X')?.state).toBe('failed')
  })

  it('sub_agent_nested_spawn increments nestedSpawnCount but does not create a row', () => {
    let st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'parent', prompt: 'P' },
      },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
    ])
    st = reduce(st, { kind: 'sub_agent_nested_spawn', agentId: 'X' }, 8000)
    st = reduce(st, { kind: 'sub_agent_nested_spawn', agentId: 'X' }, 8100)
    expect(st.subAgents.get('X')?.nestedSpawnCount).toBe(2)
    expect(st.subAgents.size).toBe(1) // no row for the nested ones
  })

  // ── Gap 5 (#316): toolCount counts completed tools ────────────────────────

  it('toolCount counts: 3 tool_use+tool_result cycles → toolCount === 3', () => {
    // Gap 5 fix (#316): toolCount must increment on sub_agent_tool_result
    // (completed) not sub_agent_tool_use (started). After 3 full use+result
    // cycles, toolCount must be 3.
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'd', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
    ])
    for (let i = 1; i <= 3; i++) {
      st = reduce(st, { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: `toolu_x${i}`, toolName: 'Read', input: { file_path: `/f${i}` } }, 6000 + i * 100)
      // Between use and result: toolCount must still be i-1 (not yet incremented)
      expect(st.subAgents.get('X')!.toolCount).toBe(i - 1)
      st = reduce(st, { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: `toolu_x${i}` }, 6000 + i * 100 + 50)
      // After result: toolCount must be i
      expect(st.subAgents.get('X')!.toolCount).toBe(i)
    }
    // Final check: exactly 3 completed tools
    expect(st.subAgents.get('X')!.toolCount).toBe(3)
  })

  // ── Gap 6 (#316): lastCompletedTool populated on sub_agent_tool_result ────

  it('lastCompletedTool populated: after Read use+result, currentTool is null and lastCompletedTool has Read info', () => {
    // Gap 6 fix (#316): sub_agent_tool_result must populate lastCompletedTool
    // from currentTool before clearing it. Render fallback chain then shows
    // "✓ just finished Read …" instead of bare "(idle)" during silent stretches.
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_p1', input: { description: 'd', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
    ])
    st = reduce(st, { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 'toolu_x1', toolName: 'Read', input: { file_path: '/src/foo.ts' } }, 6000)
    expect(st.subAgents.get('X')!.currentTool?.tool).toBe('Read')
    expect(st.subAgents.get('X')!.lastCompletedTool).toBeUndefined()

    st = reduce(st, { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: 'toolu_x1' }, 6200)
    const sa = st.subAgents.get('X')!
    // currentTool must be cleared
    expect(sa.currentTool).toBeUndefined()
    // lastCompletedTool must be populated with the Read tool info
    expect(sa.lastCompletedTool).toBeDefined()
    expect(sa.lastCompletedTool!.tool).toBe('Read')
    expect(sa.lastCompletedTool!.finishedAt).toBe(6200)
  })

  // ── Gap 7 (#316): pendingPreamble per-agent isolation regression ──────────

  it('pendingPreamble isolated: A text then B tool_use — A preamble intact, B has no preamble', () => {
    // Gap 7 regression (#316): sub_agent_text and sub_agent_tool_use must both
    // index by agentId so preamble from sub-agent A cannot leak onto sub-agent B.
    let st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a', input: { description: 'dA', prompt: 'PA' } },
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_b', input: { description: 'dB', prompt: 'PB' } },
      { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'PA' },
      { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'PB' },
    ])
    // A emits text — stash preamble on A only
    st = reduce(st, { kind: 'sub_agent_text', agentId: 'A', text: 'A is about to read a file' }, 6000)
    // B fires a tool_use — should NOT pick up A's preamble
    st = reduce(st, { kind: 'sub_agent_tool_use', agentId: 'B', toolUseId: 'toolu_b1', toolName: 'Read', input: { file_path: '/x/b.ts' } }, 6100)
    // B's tool label must fall back to the filename (not A's text)
    expect(st.subAgents.get('B')!.currentTool?.label).toBe('b.ts')
    // A's preamble must still be intact
    expect(st.subAgents.get('A')!.pendingPreamble).toBe('A is about to read a file')
    // B's preamble must be cleared (consumed as undefined → null)
    expect(st.subAgents.get('B')!.pendingPreamble ?? null).toBeNull()

    // Reverse order: B text then A tool_use — B preamble intact, A has no preamble
    let st2 = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a2', input: { description: 'dA', prompt: 'PA2' } },
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_b2', input: { description: 'dB', prompt: 'PB2' } },
      { kind: 'sub_agent_started', agentId: 'A2', firstPromptText: 'PA2' },
      { kind: 'sub_agent_started', agentId: 'B2', firstPromptText: 'PB2' },
    ])
    st2 = reduce(st2, { kind: 'sub_agent_text', agentId: 'B2', text: 'B is about to grep something' }, 7000)
    st2 = reduce(st2, { kind: 'sub_agent_tool_use', agentId: 'A2', toolUseId: 'toolu_a2_1', toolName: 'Grep', input: { pattern: 'foo' } }, 7100)
    // A2's tool must NOT inherit B2's preamble — label comes from the Grep
    // pattern fallback ("<pattern>" (in repo)) not B2's text.
    const a2Label = st2.subAgents.get('A2')!.currentTool?.label ?? ''
    expect(a2Label).toContain('foo')
    expect(a2Label).not.toBe('B is about to grep something')
    // B2's preamble must still be intact
    expect(st2.subAgents.get('B2')!.pendingPreamble).toBe('B is about to grep something')
  })

  it('flag-off renderer ignores subAgents (byte-identical legacy output)', () => {
    // Force flag off explicitly
    const prev = process.env.PROGRESS_CARD_MULTI_AGENT
    process.env.PROGRESS_CARD_MULTI_AGENT = '0'
    try {
      const st = fold([
        enqueue('go'),
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_p1',
          input: { description: 'Deploy the service', prompt: 'P' },
        },
        { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      ])
      const html = render(st, 5000)
      expect(html).not.toContain('[Main')
      expect(html).not.toContain('[Sub-agents')
      // Agent with human-authored description renders without the "Agent:" prefix.
      // Check the description text appears (not the raw tool name as a prefix).
      expect(html).toContain('Deploy the service')
      expect(html).not.toContain('Agent: Deploy')
    } finally {
      if (prev != null) process.env.PROGRESS_CARD_MULTI_AGENT = prev
      else delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('flag-on renderer adds [Main] section and sub-agent expandables with chrono ordering and subagent_type', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('go'),
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_p1',
          input: { description: 'design ux', prompt: 'P1', subagent_type: 'researcher' },
        },
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_p2',
          input: { description: 'audit', prompt: 'P2', subagent_type: 'worker' },
        },
      ])
      // Sub-agents land in REVERSE chronological order to test sort
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'P2' }, 5000)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'P1' }, 5100)
      const html = render(st, 6000)
      // Main section uses underline formatting
      expect(html).toContain('[<u>Main</u> · <u>2 tools</u>]')
      // Sub-agents are now in <blockquote expandable> blocks (no inline [Sub-agents] header)
      expect(html).not.toContain('[Sub-agents')
      expect(html).toContain('<blockquote expandable>')
      // Both sub-agents appear somewhere in the HTML
      expect(html).toContain('design ux')
      expect(html).toContain('audit')
      // Per #352 the per-agent header drops the typeSuffix — only dispatch
      // description, status emoji, and duration remain. Verify the rows
      // render as 🤖 + description rather than asserting the type label.
      expect(html).toContain('🤖 <b>design ux</b>')
      expect(html).toContain('🤖 <b>audit</b>')
      // Chrono order: B started first (5000) so its expandable appears before A's (5100)
      const idxAudit = html.indexOf('audit')
      const idxDesignUx = html.lastIndexOf('design ux') // use last — [Main] also has it
      expect(idxAudit).toBeLessThan(idxDesignUx)
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('flag-on: nested spawn count tracked in state; main Agent line stays 🤖 until tool_result', () => {
    // Per #352, the `(spawned N)` suffix is no longer rendered in the per-agent
    // header (cleaner one-line format). The `nestedSpawnCount` is still tracked
    // in state for telemetry, just not surfaced visually.
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('go'),
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_p1',
          input: { description: 'parent task', prompt: 'P' },
        },
        { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      ])
      st = reduce(st, { kind: 'sub_agent_nested_spawn', agentId: 'X' }, 6000)
      st = reduce(st, { kind: 'sub_agent_nested_spawn', agentId: 'X' }, 6100)
      st = reduce(
        st,
        { kind: 'sub_agent_tool_use', agentId: 'X', toolUseId: 't1', toolName: 'Read', input: { file_path: '/f' } },
        6200,
      )
      // State tracks the nested spawn count even though render drops it.
      expect(st.subAgents.get('X')?.nestedSpawnCount).toBe(2)
      const html = render(st, 7000)
      // Render does NOT surface the spawned count in the new format.
      expect(html).not.toContain('spawned')
      // Main agent line uses 🤖 not ✅ while running
      const mainSection = html.split('[Sub-agents')[0]
      expect(mainSection).toContain('🤖')
      expect(mainSection).not.toContain('● Agent')
      // Sub-agent activity line shows the current tool with the new ↳ prefix.
      expect(html).toContain('↳')
      expect(html).toContain('Read')
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('flag-on turn_end: sub-agents collapse to one-line summary, [Main] Agent flips to ✅', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('go'),
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_p1',
          input: { description: 'task A', prompt: 'P' },
        },
        { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
        {
          kind: 'sub_agent_tool_use',
          agentId: 'X',
          toolUseId: 't1',
          toolName: 'Read',
          input: { file_path: '/a' },
        },
        { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: 't1' },
      ])
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_p1', toolName: 'Agent' }, 7000)
      st = reduce(st, { kind: 'turn_end', durationMs: 1 }, 7500)
      const html = render(st, 8000)
      expect(html).toContain('●')
      expect(html).toContain('task A')
      // After #315 dedup: main blockquote has the one-line summary; expandable
      // blockquote has the per-sub-agent forensics. Tool count moves to its own
      // line in the expandable, so check assertions independently.
      expect(html).toMatch(/● task A/)
      expect(html).toContain('1 tools')
      // Active tool spinner (◉) must not appear in a done state.
      expect(html).not.toContain('◉')
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('turn_end leaves running sub-agents alive and clears pending spawns', () => {
    // Parent turn_end no longer force-closes running sub-agents —
    // background Agent calls may legitimately outlive the parent turn.
    // The driver's pendingCompletion gate keeps the card alive until
    // each sub-agent reports its own sub_agent_turn_end. pendingSpawns
    // are still cleared on turn_end (they're pre-correlation state
    // with no sub-agent yet to represent them).
    const st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'd', prompt: 'P' },
      },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p2',
        input: { description: 'd2', prompt: 'P2' },
      },
      // P2's sub-agent JSONL never appears
      { kind: 'turn_end', durationMs: 1 },
    ])
    expect(st.subAgents.get('X')?.state).toBe('running')
    expect(st.pendingAgentSpawns.size).toBe(0)
    expect(st.stage).toBe('done')
  })

  it('turn_end followed by sub_agent_turn_end closes the sub-agent', () => {
    // End-to-end: background sub-agent outlives parent, then reports
    // its own turn_end via its JSONL. Card is now closeable.
    const st = fold([
      enqueue('go'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'toolu_p1',
        input: { description: 'bg', prompt: 'P' },
      },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'turn_end', durationMs: 1 },
      // Parent turn done, sub-agent still running.
      { kind: 'sub_agent_turn_end', agentId: 'X', durationMs: 5 },
    ])
    expect(st.subAgents.get('X')?.state).toBe('done')
    expect(st.stage).toBe('done')
  })
})


describe('sub-agent description fallback chain', () => {
  it('correlated sub-agent: uses description', () => {
    const st = fold([
      enqueue('go'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'analyse logs', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P', subagentType: 'researcher' },
    ])
    const html = render(st, 2000)
    expect(html).toContain('analyse logs')
    expect(html).not.toContain('(uncorrelated)')
  })

  it('orphan sub-agent with subagentType: uses subagentType', () => {
    const st = fold([
      enqueue('go'),
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'unknown prompt', subagentType: 'reviewer' },
    ])
    const html = render(st, 2000)
    expect(html).toContain('reviewer')
    expect(html).not.toContain('(uncorrelated)')
  })

  it('orphan sub-agent with narrative text: uses first line', () => {
    const st = fold([
      enqueue('go'),
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'unknown' },
      { kind: 'sub_agent_text', agentId: 'X', text: 'Looking at the config files\nsecond line' },
    ])
    const html = render(st, 2000)
    expect(html).toContain('Looking at the config files')
    expect(html).not.toContain('(uncorrelated)')
    expect(html).not.toContain('second line')
  })

  it('orphan sub-agent with nothing: falls back to generic "sub-agent"', () => {
    const st = fold([
      enqueue('go'),
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'unknown' },
    ])
    const html = render(st, 2000)
    expect(html).toContain('sub-agent')
    expect(html).not.toContain('(uncorrelated)')
  })

  it('render NEVER surfaces "(uncorrelated)" to users', () => {
    // Check across several orphan states.
    const states: ProgressCardState[] = [
      fold([enqueue('g'), { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'x' }]),
      fold([enqueue('g'), { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'x', subagentType: 'worker' }]),
      fold([
        enqueue('g'),
        { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'x' },
        { kind: 'sub_agent_tool_use', agentId: 'A', toolName: 'Read', toolUseId: 't1', input: { file_path: '/tmp/f' } },
      ]),
    ]
    for (const st of states) {
      expect(render(st, 2000)).not.toContain('(uncorrelated)')
    }
  })
})

describe('sub-agent activity-line fallback (never "(idle)")', () => {
  it('currently running tool: shows tool label', () => {
    const st = fold([
      enqueue('g'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'w', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_tool_use', agentId: 'X', toolName: 'Read', toolUseId: 't1', input: { file_path: '/foo.ts' } },
    ])
    const html = render(st, 3000)
    expect(html).toContain('foo.ts')
    expect(html).not.toContain('(idle)')
  })

  it('between tools with pendingPreamble: shows narrative', () => {
    const st = fold([
      enqueue('g'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'w', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_tool_use', agentId: 'X', toolName: 'Read', toolUseId: 't1', input: { file_path: '/foo.ts' } },
      { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: 't1', isError: false },
      { kind: 'sub_agent_text', agentId: 'X', text: 'Now checking tests' },
    ])
    const html = render(st, 3000)
    expect(html).toContain('Now checking tests')
    expect(html).not.toContain('(idle)')
  })

  it('between tools with no preamble: shows last completed tool', () => {
    const st = fold([
      enqueue('g'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'w', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_tool_use', agentId: 'X', toolName: 'Read', toolUseId: 't1', input: { file_path: '/foo.ts' } },
      { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: 't1', isError: false },
    ])
    const html = render(st, 3000)
    expect(html).toContain('just finished')
    expect(html).toContain('foo.ts')
    expect(html).not.toContain('(idle)')
  })

  it('running with no tools yet: shows "starting..." (post-#352 wording)', () => {
    const st = fold([
      enqueue('g'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'w', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
    ])
    const html = render(st, 3000)
    // Post #352: the pre-tool fallback line was renamed from "thinking…" to
    // "starting…" and uses the ↳ prefix consistent with other action lines.
    expect(html).toContain('starting')
    expect(html).toContain('↳')
    expect(html).not.toContain('(idle)')
  })

  it('render NEVER surfaces "(idle)" regardless of sub-agent phase', () => {
    // Exhaustive sanity: iterate through phases, check each render.
    const events: SessionEvent[] = [
      enqueue('g'),
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'p1', input: { description: 'w', prompt: 'P' } },
      { kind: 'sub_agent_started', agentId: 'X', firstPromptText: 'P' },
      { kind: 'sub_agent_tool_use', agentId: 'X', toolName: 'Read', toolUseId: 't1', input: { file_path: '/a' } },
      { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: 't1', isError: false },
      { kind: 'sub_agent_tool_use', agentId: 'X', toolName: 'Bash', toolUseId: 't2', input: { command: 'ls' } },
      { kind: 'sub_agent_tool_result', agentId: 'X', toolUseId: 't2', isError: false },
    ]
    let state = initialState()
    let t = 1000
    for (const e of events) {
      state = reduce(state, e, t)
      t += 100
      // Render at every step — should never show "(idle)".
      expect(render(state, t)).not.toContain('(idle)')
    }
  })
})

// ─── compactItems unit tests ─────────────────────────────────────────────
// Direct tests of the pure compactItems() function. The render() integration
// tests above verify end-to-end output; these pin the compaction logic itself
// so regressions are caught at the unit level before they bubble up.

function makeItem(
  id: number,
  tool: string,
  label: string,
  state: 'done' | 'running' | 'failed' = 'done',
  humanAuthored = false,
): ChecklistItem {
  return {
    id,
    toolUseId: null,
    tool,
    label,
    humanAuthored,
    state,
    startedAt: 1000 + id * 100,
    finishedAt: state === 'done' ? 1050 + id * 100 : undefined,
  }
}

describe('compactItems', () => {
  it('single item stays as single', () => {
    const out = compactItems([makeItem(0, 'Read', 'foo.ts')])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('single')
  })

  it('two identical tool+label done items → rollup with label (B1+B3)', () => {
    const out = compactItems([makeItem(0, 'Read', 'foo.ts'), makeItem(1, 'Read', 'foo.ts')])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('rollup')
    expect(out[0].count).toBe(2)
    expect(out[0].label).toBe('foo.ts')
  })

  it('three mixed-label same-tool done items → rollup without label (C1)', () => {
    const out = compactItems([
      makeItem(0, 'Read', 'a.ts'),
      makeItem(1, 'Read', 'b.ts'),
      makeItem(2, 'Read', 'c.ts'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('rollup')
    expect(out[0].count).toBe(3)
    expect(out[0].label).toBe('') // label dropped — no single representative
  })

  it('two mixed-label same-tool done items → NOT collapsed (below MIXED_ROLLUP_THRESHOLD)', () => {
    const out = compactItems([makeItem(0, 'Read', 'a.ts'), makeItem(1, 'Read', 'b.ts')])
    expect(out).toHaveLength(2)
    expect(out[0].kind).toBe('single')
    expect(out[1].kind).toBe('single')
  })

  it('running item in a run prevents any rollup', () => {
    const out = compactItems([
      makeItem(0, 'Bash', 'git status'),
      makeItem(1, 'Bash', 'git status'),
      makeItem(2, 'Bash', 'git status', 'running'),
    ])
    // allDone=false → no rollup
    expect(out).toHaveLength(3)
    expect(out.every(x => x.kind === 'single')).toBe(true)
  })

  it('failed item in a run prevents rollup', () => {
    const out = compactItems([
      makeItem(0, 'Bash', 'npm test'),
      makeItem(1, 'Bash', 'npm test', 'failed'),
      makeItem(2, 'Bash', 'npm test'),
    ])
    expect(out).toHaveLength(3)
    expect(out.every(x => x.kind === 'single')).toBe(true)
  })

  it('rollup preserves first.startedAt and last.finishedAt', () => {
    const items: ChecklistItem[] = [
      { id: 0, toolUseId: null, tool: 'Read', label: 'x', humanAuthored: false, state: 'done', startedAt: 100, finishedAt: 200 },
      { id: 1, toolUseId: null, tool: 'Read', label: 'x', humanAuthored: false, state: 'done', startedAt: 300, finishedAt: 500 },
    ]
    const out = compactItems(items)
    expect(out[0].startedAt).toBe(100)
    expect(out[0].finishedAt).toBe(500)
  })

  it('two runs in sequence each compact independently', () => {
    // [Read foo.ts ×2] [Bash git ×2] → two rollups
    const out = compactItems([
      makeItem(0, 'Read', 'foo.ts'),
      makeItem(1, 'Read', 'foo.ts'),
      makeItem(2, 'Bash', 'git status'),
      makeItem(3, 'Bash', 'git status'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ kind: 'rollup', tool: 'Read', label: 'foo.ts', count: 2 })
    expect(out[1]).toMatchObject({ kind: 'rollup', tool: 'Bash', label: 'git status', count: 2 })
  })

  it('interleaved tools break runs correctly', () => {
    // Read, Bash, Read — each run is length 1, no rollup
    const out = compactItems([
      makeItem(0, 'Read', 'foo.ts'),
      makeItem(1, 'Bash', 'git status'),
      makeItem(2, 'Read', 'foo.ts'),
    ])
    expect(out).toHaveLength(3)
    expect(out.every(x => x.kind === 'single')).toBe(true)
  })

  it('empty input returns empty output', () => {
    expect(compactItems([])).toEqual([])
  })

  // Issue #50.3 — pin the humanAuthored carve-out (#41 fix). When the agent
  // attached a human-readable description to each Bash, those descriptions
  // are valuable signal — collapsing into "Bash ×3" would discard them.
  describe('humanAuthored items are never collapsed (#41)', () => {
    it('three same-label humanAuthored Bash items render as three singles, not Bash ×3', () => {
      const items = [
        makeItem(0, 'Bash', 'Run the migration', 'done', true),
        makeItem(1, 'Bash', 'Run the migration', 'done', true),
        makeItem(2, 'Bash', 'Run the migration', 'done', true),
      ]
      const out = compactItems(items)
      expect(out).toHaveLength(3)
      expect(out.every((x) => x.kind === 'single')).toBe(true)
      expect(out.every((x) => x.humanAuthored === true)).toBe(true)
    })

    it('two same-label humanAuthored Bash items render as two singles', () => {
      const items = [
        makeItem(0, 'Bash', 'Check commit state', 'done', true),
        makeItem(1, 'Bash', 'Check commit state', 'done', true),
      ]
      const out = compactItems(items)
      expect(out).toHaveLength(2)
      expect(out.every((x) => x.kind === 'single')).toBe(true)
    })

    it('a single humanAuthored item in a same-label run blocks the rollup of the whole run', () => {
      // Two non-humanAuthored items would normally rollup at ROLLUP_THRESHOLD=2.
      // Adding one humanAuthored sibling in the same run must keep all three
      // as singles, otherwise the agent's description gets discarded.
      const items = [
        makeItem(0, 'Bash', 'git status', 'done', false),
        makeItem(1, 'Bash', 'git status', 'done', true),
        makeItem(2, 'Bash', 'git status', 'done', false),
      ]
      const out = compactItems(items)
      expect(out).toHaveLength(3)
      expect(out.every((x) => x.kind === 'single')).toBe(true)
    })

    it('a humanAuthored sibling blocks even the mixed-label rollup', () => {
      // 3 same-tool, mixed-label, all done normally collapses (C1).
      // One humanAuthored item in the run prevents that collapse too.
      const items = [
        makeItem(0, 'Bash', 'git status', 'done', false),
        makeItem(1, 'Bash', 'Run the migration', 'done', true),
        makeItem(2, 'Bash', 'npm test', 'done', false),
      ]
      const out = compactItems(items)
      expect(out).toHaveLength(3)
      expect(out.every((x) => x.kind === 'single')).toBe(true)
    })
  })
})

// ─── human-authored label rendering (issue #6 item 5) ────────────────────────

describe('renderItemCore: human-authored label prefix suppression', () => {
  it('Bash with description renders without "Bash " prefix', () => {
    const s = fold([
      enqueue('check stuff'),
      {
        kind: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'b1',
        input: { command: 'git log --oneline', description: 'Check commit state' },
      },
      { kind: 'tool_result', toolUseId: 'b1', toolName: 'Bash' },
    ])
    const html = render(s, 5000)
    // description should appear; raw "Bash " prefix must not
    expect(html).toContain('Check commit state')
    expect(html).not.toMatch(/Bash Check commit state/)
    expect(html).not.toMatch(/Bash: Check commit state/)
  })

  it('Bash with no description still renders "Bash <cmd>"', () => {
    const s = fold([
      enqueue('check stuff'),
      {
        kind: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'b2',
        input: { command: 'git status' },
      },
      { kind: 'tool_result', toolUseId: 'b2', toolName: 'Bash' },
    ])
    const html = render(s, 5000)
    expect(html).toContain('Bash')
    expect(html).toContain('git status')
    // prefix is preserved when no description
    expect(html).toMatch(/Bash.*git status/)
  })

  it('Task with description renders without "Task: " prefix', () => {
    const s = fold([
      enqueue('delegate'),
      {
        kind: 'tool_use',
        toolName: 'Task',
        toolUseId: 't1',
        input: { description: 'Research the bug', prompt: 'look into it' },
      },
      { kind: 'tool_result', toolUseId: 't1', toolName: 'Task' },
    ])
    const html = render(s, 5000)
    expect(html).toContain('Research the bug')
    expect(html).not.toMatch(/Task: Research/)
    expect(html).not.toMatch(/Task Research/)
  })

  it('Agent with description renders without "Agent: " prefix', () => {
    const s = fold([
      enqueue('delegate'),
      {
        kind: 'tool_use',
        toolName: 'Agent',
        toolUseId: 'a1',
        input: { description: 'Deploy the service', prompt: 'deploy it' },
      },
      { kind: 'tool_result', toolUseId: 'a1', toolName: 'Agent' },
    ])
    const html = render(s, 5000)
    expect(html).toContain('Deploy the service')
    expect(html).not.toMatch(/Agent: Deploy/)
    expect(html).not.toMatch(/Agent Deploy/)
  })

  it('MCP tool still renders label-only (regression guard)', () => {
    const s = fold([
      enqueue('remember'),
      {
        kind: 'tool_use',
        toolName: 'mcp__hindsight__retain',
        toolUseId: 'mcp1',
        input: { description: 'Remember user prefers TypeScript' },
      },
      { kind: 'tool_result', toolUseId: 'mcp1', toolName: 'mcp__hindsight__retain' },
    ])
    const html = render(s, 5000)
    expect(html).toContain('Remember user prefers TypeScript')
    expect(html).not.toContain('mcp__hindsight__retain')
  })

  it('WebFetch still renders "WebFetch <host>" (regression guard)', () => {
    const s = fold([
      enqueue('fetch docs'),
      {
        kind: 'tool_use',
        toolName: 'WebFetch',
        toolUseId: 'w1',
        input: { url: 'https://docs.example.com/api' },
      },
      { kind: 'tool_result', toolUseId: 'w1', toolName: 'WebFetch' },
    ])
    const html = render(s, 5000)
    expect(html).toContain('WebFetch')
    expect(html).toContain('docs.example.com')
  })
})

// ── formatDuration unit tests (issue #101) ──────────────────────────────────
//
// Every value returned by formatDuration must be safe for direct embedding
// inside Telegram HTML — no unescaped '<', '>', or '&' characters.

describe('formatDuration — HTML-safe output', () => {
  function isHtmlSafe(s: string): boolean {
    return !/</.test(s)
  }

  it('formatDuration(0) is HTML-safe', () => {
    const out = formatDuration(0)
    expect(isHtmlSafe(out)).toBe(true)
    expect(out).toBe('0ms')
  })

  it('formatDuration(999) is HTML-safe (sub-second boundary)', () => {
    const out = formatDuration(999)
    expect(isHtmlSafe(out)).toBe(true)
    expect(out).toBe('999ms')
  })

  it('formatDuration(1000) renders as seconds format', () => {
    const out = formatDuration(1000)
    expect(isHtmlSafe(out)).toBe(true)
    expect(out).toBe('00:01')
  })

  it('formatDuration(60_000) renders as 1-minute format', () => {
    const out = formatDuration(60_000)
    expect(isHtmlSafe(out)).toBe(true)
    expect(out).toBe('01:00')
  })

  it('formatDuration(3_600_000) renders as 60-minute format', () => {
    const out = formatDuration(3_600_000)
    expect(isHtmlSafe(out)).toBe(true)
    expect(out).toBe('60:00')
  })

  it('no value contains an unescaped "<" character (regression guard for issue #101)', () => {
    const samples = [0, 1, 500, 999, 1000, 5000, 30_000, 60_000, 90_000, 3_600_000]
    for (const ms of samples) {
      expect(formatDuration(ms)).not.toMatch(/</)
    }
  })
})

// ── Render-path regression: sub-second elapsed time (issue #101) ─────────────
//
// When a turn's elapsed time is sub-second the card header must not contain
// an unescaped '<' that would fail Telegram's HTML parser.

describe('render — sub-second elapsed time is HTML-safe', () => {
  it('card rendered at t=turnStart+500ms contains no bare "<" outside tags', () => {
    const state = reduce(initialState(), enqueue('quick task'), 1000)
    const html = render(state, 1500) // 500 ms elapsed
    // All '<' should be the start of known HTML tags, not bare numeric comparisons.
    // A simple heuristic: no '<' followed by a digit (e.g. "<1s").
    expect(html).not.toMatch(/<\d/)
  })

  it('card rendered at t=turnStart+0ms contains no bare "<" outside tags', () => {
    const state = reduce(initialState(), enqueue('instant task'), 1000)
    const html = render(state, 1000) // 0 ms elapsed
    expect(html).not.toMatch(/<\d/)
  })

  it('header elapsed duration is safe for HTML embedding when sub-second', () => {
    const state = reduce(initialState(), enqueue('test'), 1000)
    const html = render(state, 1999) // 999 ms
    // Must NOT contain a bare "<1s" pattern
    expect(html).not.toContain('<1s')
    // Must contain the safe ms representation
    expect(html).toContain('999ms')
  })
})

// ─── Issue #202: tool-error-filter wiring ───────────────────────────────────
//
// Benign tool errors (file-not-found, no-match, recoverable Telegram, tool
// setup, timeout) render as 'done' (✅) rather than 'failed' (❌). Real
// errors still render as 'failed'. Empty/missing errorText fail-closed —
// renders as 'failed' to avoid silently hiding errors with malformed
// JSONL or older shapes.
describe('progress-card reducer — tool-error-filter classification (#202)', () => {
  function runWithError(errorText: string | undefined): 'done' | 'failed' | 'running' {
    const events: SessionEvent[] = [
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_X' },
      {
        kind: 'tool_result',
        toolUseId: 'toolu_X',
        toolName: null,
        isError: true,
        ...(errorText !== undefined ? { errorText } : {}),
      },
    ]
    const s = fold(events)
    return s.items[0].state as 'done' | 'failed' | 'running'
  }

  // Pattern group 1: FILE_NOT_FOUND
  it('FILE_NOT_FOUND error renders as done', () => {
    expect(runWithError('Error: ENOENT: no such file or directory')).toBe('done')
    expect(runWithError('file not found: /tmp/missing.txt')).toBe('done')
    expect(runWithError('Path does not exist')).toBe('done')
  })

  // Pattern group 2: NO_MATCH
  it('NO_MATCH error renders as done', () => {
    expect(runWithError('grep: no matches found')).toBe('done')
    expect(runWithError('returned no results')).toBe('done')
    expect(runWithError('0 results returned from query')).toBe('done')
  })

  // Pattern group 3: TELEGRAM_RECOVERABLE
  it('TELEGRAM_RECOVERABLE error renders as done', () => {
    expect(runWithError('Bad Request: message is not modified')).toBe('done')
    expect(runWithError('message to edit not found')).toBe('done')
    expect(runWithError('MESSAGE_ID_INVALID')).toBe('done')
  })

  // Pattern group 4: TOOL_SETUP — narrowed to just "not a git repository"
  // after a review found `command not found` and `permission denied` were
  // too broad and could swallow real failures.
  it('TOOL_SETUP error (running git outside a repo) renders as done', () => {
    expect(runWithError('fatal: not a git repository (or any of the parent directories)')).toBe('done')
  })

  // Pattern group 5: TIMEOUT — bare `aborted` was dropped after review;
  // matches DB transaction aborts, git merge aborts, etc.
  it('TIMEOUT error renders as done', () => {
    expect(runWithError('operation timed out after 30s')).toBe('done')
    expect(runWithError('Request timeout')).toBe('done')
    expect(runWithError('operation cancelled by client')).toBe('done')
  })

  // Real errors must still escalate. Includes the messages that were
  // previously over-suppressed by the old TOOL_SETUP and TIMEOUT regexes.
  it('real errors render as failed (regression guard)', () => {
    expect(runWithError('AuthenticationError: invalid API key')).toBe('failed')
    expect(runWithError('SyntaxError: unexpected token at line 12')).toBe('failed')
    expect(runWithError('Connection refused: server is unreachable')).toBe('failed')
    expect(runWithError('500 Internal Server Error')).toBe('failed')
    expect(runWithError('unhandled exception: segfault in libc')).toBe('failed')
    // Previously over-suppressed by TOOL_SETUP_RE — now must escalate
    expect(runWithError('kubectl: command not found')).toBe('failed')
    expect(runWithError('Permission denied: /etc/passwd')).toBe('failed')
    // Previously over-suppressed by TIMEOUT_RE (bare `aborted`)
    expect(runWithError('transaction aborted: deadlock detected')).toBe('failed')
    expect(runWithError('git merge aborted: conflicts in 3 files')).toBe('failed')
  })

  // Fail-closed: empty / missing errorText keeps the loud failure state.
  // Suppression requires *evidence* the error is benign.
  it('isError=true with no errorText fail-closes to failed', () => {
    expect(runWithError(undefined)).toBe('failed')
    expect(runWithError('')).toBe('failed')
  })

  // isError=false (or undefined) is unaffected by errorText.
  it('isError=false renders as done regardless of any errorText', () => {
    const events: SessionEvent[] = [
      enqueue('test'),
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_X' },
      // isError omitted (falsy) — this is the success path
      { kind: 'tool_result', toolUseId: 'toolu_X', toolName: null },
    ]
    const s = fold(events)
    expect(s.items[0].state).toBe('done')
  })
})

// ─── Multi-agent layout snapshot tests ──────────────────────────────────────
// These tests pin the rendered HTML for the three canonical multi-agent
// scenarios described in issue #275: parent+1 worker, parent+3 parallel
// workers, and the all-done (post-turn_end) state. They are structural
// assertions rather than serialised snapshots because the elapsed-time
// values change with wall-clock. Each test verifies all semantic sections
// appear in the correct position and format.

describe('progress-card multi-agent layout snapshots', () => {
  it('snapshot: parent + 1 worker (in-flight)', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('analyse the logs'),
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_w1',
          input: { description: 'dig into error logs', prompt: 'Please analyse /var/log/app.log', subagent_type: 'researcher' },
        },
        { kind: 'sub_agent_started', agentId: 'W1', firstPromptText: 'Please analyse /var/log/app.log' },
      ])
      st = reduce(
        st,
        { kind: 'sub_agent_tool_use', agentId: 'W1', toolUseId: 'tw1', toolName: 'Read', input: { file_path: '/var/log/app.log' } },
        2000,
      )
      const html = render(st, 3000)

      // Header: working state
      expect(html).toContain('⚙️ <b>Working…</b>')

      // Main blockquote: shows parent tool count and sub-agent description in summary line
      expect(html).toContain('[<u>Main</u>')
      expect(html).toContain('dig into error logs')

      // Sub-agent expandable block present
      expect(html).toContain('<blockquote expandable>')

      // Per #352: per-agent header is universal 🤖 + dispatch description +
      // status emoji + duration; the typeSuffix (e.g. "researcher") is dropped.
      expect(html).toContain('🤖 <b>dig into error logs</b>')
      expect(html).toContain('🔄 working')

      // Sub-agent activity uses the new ↳ prefix for the current tool.
      expect(html).toContain('↳')
      expect(html).toContain('Read')

      // Layout: main blockquote before expandable
      expect(html.indexOf('[<u>Main</u>')).toBeLessThan(html.indexOf('<blockquote expandable>'))
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('snapshot: parent + 3 parallel workers (in-flight)', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      // Parent dispatches 3 sub-agents concurrently
      let st = fold([
        enqueue('refactor the codebase'),
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_a',
          input: { description: 'update types', prompt: 'Update all TypeScript types', subagent_type: 'worker' },
        },
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_b',
          input: { description: 'run tests', prompt: 'Run the full test suite', subagent_type: 'worker' },
        },
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_c',
          input: { description: 'update docs', prompt: 'Update README and docs', subagent_type: 'worker' },
        },
      ])
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'Update all TypeScript types' }, 2000)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'Run the full test suite' }, 2100)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'C', firstPromptText: 'Update README and docs' }, 2200)
      st = reduce(
        st,
        { kind: 'sub_agent_tool_use', agentId: 'A', toolUseId: 'ta1', toolName: 'Edit', input: { file_path: '/src/types.ts' } },
        2300,
      )
      st = reduce(
        st,
        { kind: 'sub_agent_tool_use', agentId: 'B', toolUseId: 'tb1', toolName: 'Bash', input: { command: 'bun test' } },
        2400,
      )
      const html = render(st, 3000)

      // Header: working state
      expect(html).toContain('⚙️ <b>Working…</b>')

      // Main blockquote: 3 tools total
      expect(html).toContain('[<u>Main</u>')
      expect(html).toContain('3 tools')

      // All 3 sub-agent descriptions visible somewhere
      expect(html).toContain('update types')
      expect(html).toContain('run tests')
      expect(html).toContain('update docs')

      // Multiple expandable blocks (one per sub-agent)
      const expandableCount = (html.match(/<blockquote expandable>/g) ?? []).length
      expect(expandableCount).toBe(3)

      // Active tools visible (A doing Edit, B doing Bash)
      expect(html).toContain('Edit')
      expect(html).toContain('Bash')

      // Chrono order: A (2000) before B (2100) before C (2200)
      const idxA = html.indexOf('update types')
      const idxB = html.indexOf('run tests')
      const idxC = html.indexOf('update docs')
      expect(idxA).toBeLessThan(idxB)
      expect(idxB).toBeLessThan(idxC)
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('snapshot: all-done state (parent + 3 workers, turn_end)', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('refactor the codebase'),
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_a',
          input: { description: 'update types', prompt: 'Update all TypeScript types', subagent_type: 'worker' },
        },
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_b',
          input: { description: 'run tests', prompt: 'Run the full test suite', subagent_type: 'worker' },
        },
        {
          kind: 'tool_use',
          toolName: 'Agent',
          toolUseId: 'toolu_c',
          input: { description: 'update docs', prompt: 'Update README and docs', subagent_type: 'worker' },
        },
      ])
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'Update all TypeScript types' }, 2000)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'Run the full test suite' }, 2100)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'C', firstPromptText: 'Update README and docs' }, 2200)
      // Each sub-agent does some work and completes
      st = reduce(
        st,
        { kind: 'sub_agent_tool_use', agentId: 'A', toolUseId: 'ta1', toolName: 'Edit', input: { file_path: '/src/types.ts' } },
        2300,
      )
      st = reduce(st, { kind: 'sub_agent_tool_result', agentId: 'A', toolUseId: 'ta1' }, 2400)
      st = reduce(
        st,
        { kind: 'sub_agent_tool_use', agentId: 'B', toolUseId: 'tb1', toolName: 'Bash', input: { command: 'bun test' } },
        2500,
      )
      st = reduce(st, { kind: 'sub_agent_tool_result', agentId: 'B', toolUseId: 'tb1' }, 2600)
      st = reduce(
        st,
        { kind: 'sub_agent_tool_use', agentId: 'C', toolUseId: 'tc1', toolName: 'Write', input: { file_path: '/README.md' } },
        2700,
      )
      st = reduce(st, { kind: 'sub_agent_tool_result', agentId: 'C', toolUseId: 'tc1' }, 2800)
      // Sub-agents complete
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_a', toolName: 'Agent' }, 3000)
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_b', toolName: 'Agent' }, 3100)
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_c', toolName: 'Agent' }, 3200)
      st = reduce(st, { kind: 'turn_end', durationMs: 3500 }, 3300)
      const html = render(st, 4000)

      // Header: done state
      expect(html).toContain('✅ <b>Done</b>')

      // No active tool spinner in done state
      expect(html).not.toContain('◉')

      // All 3 sub-agent descriptions still visible in the forensic blockquotes
      expect(html).toContain('update types')
      expect(html).toContain('run tests')
      expect(html).toContain('update docs')

      // Per #352: each per-agent expandable shows the new ✅ done status
      // emoji in its collapsed header (replaces the old "1 tools" line).
      const doneCount = (html.match(/✅ done/g) ?? []).length
      expect(doneCount).toBe(3)

      // Header summary line shows emoji counts ("<b><u>🤖 Sub-agents</u></b> · ✅ 3").
      expect(html).toContain('<b><u>🤖 Sub-agents</u></b> · ✅ 3')

      // 3 expandable forensic blocks, one per sub-agent
      const expandableCount = (html.match(/<blockquote expandable>/g) ?? []).length
      expect(expandableCount).toBe(3)

      // Chrono ordering preserved in done state
      const idxA = html.indexOf('update types')
      const idxB = html.indexOf('run tests')
      const idxC = html.indexOf('update docs')
      expect(idxA).toBeLessThan(idxB)
      expect(idxB).toBeLessThan(idxC)
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  // ── #352 state-coverage snapshots ───────────────────────────────────────
  // The acceptance criteria require snapshot coverage for each top-level
  // sub-agent state the new card can render: all-done (above), mixed,
  // all-running (above as "parent + 3 parallel workers"), all-failed, and
  // stalled. The three below fill in the gaps.

  it('snapshot: mixed state (1 done + 1 running + 1 failed)', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('mixed batch'),
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a', input: { description: 'finished work', prompt: 'P-A' } },
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_b', input: { description: 'in flight', prompt: 'P-B' } },
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_c', input: { description: 'broken work', prompt: 'P-C' } },
      ])
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'P-A' }, 2000)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'P-B' }, 2100)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'C', firstPromptText: 'P-C' }, 2200)
      // A finishes — parent tool_result with isError:false promotes A to done.
      st = reduce(st, { kind: 'sub_agent_tool_use', agentId: 'A', toolUseId: 'ta', toolName: 'Edit', input: { file_path: '/x.ts' } }, 2300)
      st = reduce(st, { kind: 'sub_agent_tool_result', agentId: 'A', toolUseId: 'ta' }, 2400)
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_a', toolName: 'Agent', isError: false }, 2500)
      // B is still running, mid-tool.
      st = reduce(st, { kind: 'sub_agent_tool_use', agentId: 'B', toolUseId: 'tb', toolName: 'Bash', input: { command: 'bun test' } }, 2600)
      // C fails — parent tool_result with isError:true flips C to 'failed'.
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_c', toolName: 'Agent', isError: true, errorText: 'context exhausted' }, 2700)
      const html = render(st, 3000)

      // Header summary line lists each non-zero count.
      expect(html).toContain('<b><u>🤖 Sub-agents</u></b> · ✅ 1 · 🔄 1 · ❌ 1')

      // Each per-agent header carries the right status emoji + label.
      expect(html).toContain('🤖 <b>finished work</b>')
      expect(html).toContain('✅ done')
      expect(html).toContain('🤖 <b>in flight</b>')
      expect(html).toContain('🔄 working')
      expect(html).toContain('🤖 <b>broken work</b>')
      expect(html).toContain('❌ failed')

      // Three expandable blocks, one per sub-agent.
      expect((html.match(/<blockquote expandable>/g) ?? []).length).toBe(3)
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('snapshot: all-failed state (3 sub-agents all failed)', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('failure cascade'),
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a', input: { description: 'task A', prompt: 'P-A' } },
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_b', input: { description: 'task B', prompt: 'P-B' } },
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_c', input: { description: 'task C', prompt: 'P-C' } },
      ])
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'P-A' }, 2000)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'B', firstPromptText: 'P-B' }, 2100)
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'C', firstPromptText: 'P-C' }, 2200)
      // Parent tool_result with isError:true is the canonical signal that
      // flips a sub-agent into 'failed' state.
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_a', toolName: 'Agent', isError: true, errorText: 'a' }, 2300)
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_b', toolName: 'Agent', isError: true, errorText: 'b' }, 2400)
      st = reduce(st, { kind: 'tool_result', toolUseId: 'toolu_c', toolName: 'Agent', isError: true, errorText: 'c' }, 2500)
      const html = render(st, 3000)

      // Header summary line: only the failed count, no done/running/stalled.
      expect(html).toContain('<b><u>🤖 Sub-agents</u></b> · ❌ 3')
      expect(html).not.toContain('✅')
      expect(html).not.toContain('🔄')

      // Every per-agent header shows ❌ failed.
      expect((html.match(/❌ failed/g) ?? []).length).toBe(3)
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })

  it('snapshot: stalled state (running sub-agent with no events for 60s)', () => {
    process.env.PROGRESS_CARD_MULTI_AGENT = '1'
    try {
      let st = fold([
        enqueue('stalled'),
        { kind: 'tool_use', toolName: 'Agent', toolUseId: 'toolu_a', input: { description: 'long task', prompt: 'P' } },
      ])
      st = reduce(st, { kind: 'sub_agent_started', agentId: 'A', firstPromptText: 'P' }, 2000)
      st = reduce(st, { kind: 'sub_agent_tool_use', agentId: 'A', toolUseId: 'ta', toolName: 'Bash', input: { command: 'sleep 1000' } }, 2100)
      // Render `now` is 70_000ms after the last event (>60s SUBAGENT_STALL_MS).
      const html = render(st, 72_100)

      // Stalled state surfaces in both the header summary and per-agent header.
      expect(html).toContain('<b><u>🤖 Sub-agents</u></b> · ⚠️ 1')
      expect(html).toContain('⚠️ stalled')

      // The sub-agent's underlying state stays 'running' — stalled is a
      // render-time classification based on lastEventAt freshness, not a
      // separate state machine value.
      expect(st.subAgents.get('A')?.state).toBe('running')
    } finally {
      delete process.env.PROGRESS_CARD_MULTI_AGENT
    }
  })
})
