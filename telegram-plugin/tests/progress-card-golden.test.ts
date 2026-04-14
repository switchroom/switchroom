/**
 * Golden-fixture test for the progress card: feed a realistic session
 * JSONL through projectTranscriptLine → reduce → render and snapshot the
 * final HTML. This is the end-to-end integration pin — any change to the
 * reducer, renderer, or tool-label formatters that would visibly move
 * pixels trips this test.
 *
 * The JSONL here is a synthesized but shape-accurate sample of what Claude
 * Code actually writes (assistant blocks with tool_use + input, user
 * blocks with tool_result, system turn_duration). Kept inline so the fixture
 * stays close to the assertions.
 */
import { describe, it, expect } from 'vitest'
import { projectTranscriptLine } from '../session-tail.js'
import { initialState, reduce, render } from '../progress-card.js'

const SAMPLE_JSONL = [
  // Inbound user message via Telegram
  JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: '<channel source="clerk-telegram" chat_id="123">fix the failing tests and push</channel>',
  }),
  // Assistant thinks
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'checking failing suite' }] },
  }),
  // Tool 1: Read
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/ken/code/clerk/tests/merge.test.ts' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  }),
  // Tool 2: Bash (long)
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'bun test' } }],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '402 pass' }] },
  }),
  // Tool 3: Edit
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/home/ken/code/clerk/src/config/merge.ts' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'edit ok' }] },
  }),
  // Tool 4: Bash that failed
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'git push' } }],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 't4', is_error: true, content: 'rejected' },
      ],
    },
  }),
  // Assistant final text
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Tests fixed but push was rejected.' }] },
  }),
  // System turn_duration (turn_end)
  JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 4200 }),
]

describe('progress-card golden turn', () => {
  it('reduces a realistic session JSONL into the expected HTML', () => {
    let state = initialState()
    let t = 1000
    for (const line of SAMPLE_JSONL) {
      for (const event of projectTranscriptLine(line)) {
        state = reduce(state, event, t)
        t += 1500
      }
    }

    // Render at a fixed wall-clock so the header elapsed is deterministic.
    const html = render(state, t + 500)

    // Structural assertions — don't brittle-pin the whole string, but
    // lock in the key visual elements and their ordering.
    expect(html).toContain('💬 fix the failing tests and push')
    expect(html).toContain('<b>✅ Done</b>')

    // Checklist: 4 items, in order, with labels derived from input args.
    expect(html).toContain('✅ Read: <code>clerk/tests/merge.test.ts</code>')
    expect(html).toContain('✅ Bash: <code>bun test</code>')
    expect(html).toContain('✅ Edit: <code>clerk/src/config/merge.ts</code>')
    expect(html).toContain('❌ Bash: <code>git push</code>')

    // Ordering: Read appears before Edit, Edit before the failed Bash.
    const readIdx = html.indexOf('Read: <code>')
    const editIdx = html.indexOf('Edit: <code>')
    const failIdx = html.indexOf('❌ Bash')
    expect(readIdx).toBeLessThan(editIdx)
    expect(editIdx).toBeLessThan(failIdx)

    // No thought line on Done stage.
    expect(html).not.toContain('💭')
  })

  it('renders a still-in-flight turn with a running item + thought line', () => {
    let state = initialState()
    let t = 1000
    // Feed the first 5 events (up through Read + result + second Bash start,
    // but not its result or turn_end)
    for (const line of SAMPLE_JSONL.slice(0, 5)) {
      for (const event of projectTranscriptLine(line)) {
        state = reduce(state, event, t)
        t += 800
      }
    }

    const html = render(state, t + 300)

    expect(html).toContain('<b>🔧 Run</b>')
    expect(html).toContain('✅ Read')
    expect(html).toContain('⚡ <b>Bash</b>: <code>bun test</code>')
    // Running item has elapsed-time suffix
    expect(html).toMatch(/⚡ <b>Bash<\/b>: <code>bun test<\/code> <i>\(\d/)
  })
})
