/**
 * Pure-function tests for the per-agent card module: TodoWrite parsing,
 * reducer ingestion, glyph rotation, slice projection, and the render
 * template. These are the building blocks that the per-agent driver
 * lifecycle (§2) wires together.
 */

import { describe, it, expect } from 'vitest'
import {
  STATUS_GLYPHS,
  STATUS_GLYPH_DONE,
  STATUS_GLYPH_FAILED,
  TASK_SYMBOL,
  glyphForTick,
  initialState,
  parseTodoWriteInput,
  projectAgentSlice,
  reduce,
  renderAgentCard,
  renderTaskList,
  type ProgressCardState,
  type SubAgentState,
  type TaskItem,
} from '../progress-card.js'
import type { SessionEvent } from '../session-tail.js'

const BASE_TIME = 1_700_000_000_000

function enqueue(now = BASE_TIME): SessionEvent {
  return { kind: 'enqueue', rawContent: '<channel>hello</channel>', messageId: 'm1' } as unknown as SessionEvent
}

function todoWrite(todos: Array<{ content: string; activeForm: string; status: string }>): SessionEvent {
  return {
    kind: 'tool_use',
    toolName: 'TodoWrite',
    toolUseId: 'tu_todo',
    input: { todos },
  } as SessionEvent
}

function subStart(agentId: string, parentToolUseId?: string, firstPromptText?: string): SessionEvent {
  return {
    kind: 'sub_agent_started',
    agentId,
    firstPromptText: firstPromptText ?? 'do thing',
    subagentType: parentToolUseId ? 'researcher' : undefined,
  } as unknown as SessionEvent
}

function subTodoWrite(agentId: string, todos: Array<{ content: string; activeForm: string; status: string }>): SessionEvent {
  return {
    kind: 'sub_agent_tool_use',
    agentId,
    toolName: 'TodoWrite',
    toolUseId: 'tu_sub_todo',
    input: { todos },
  } as SessionEvent
}

describe('parseTodoWriteInput', () => {
  it('parses a well-formed todos array', () => {
    const out = parseTodoWriteInput({
      todos: [
        { content: 'A', activeForm: 'Doing A', status: 'pending' },
        { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
        { content: 'C', activeForm: 'Doing C', status: 'completed' },
      ],
    })
    expect(out).toEqual([
      { content: 'A', activeForm: 'Doing A', state: 'pending' },
      { content: 'B', activeForm: 'Doing B', state: 'in_progress' },
      { content: 'C', activeForm: 'Doing C', state: 'completed' },
    ])
  })

  it('returns null when input is undefined', () => {
    expect(parseTodoWriteInput(undefined)).toBeNull()
  })

  it('returns null when todos field is missing', () => {
    expect(parseTodoWriteInput({})).toBeNull()
  })

  it('returns null when todos is not an array', () => {
    expect(parseTodoWriteInput({ todos: 'nope' as unknown as never[] })).toBeNull()
  })

  it('drops malformed entries but keeps the rest', () => {
    const out = parseTodoWriteInput({
      todos: [
        { content: 'A', activeForm: 'Doing A', status: 'pending' },
        { content: 'no activeform', status: 'pending' },
        { activeForm: 'no content', status: 'pending' },
        null,
        'not-an-object',
        { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
      ],
    })
    expect(out).toEqual([
      { content: 'A', activeForm: 'Doing A', state: 'pending' },
      { content: 'B', activeForm: 'Doing B', state: 'in_progress' },
    ])
  })

  it('treats unknown status strings as pending', () => {
    const out = parseTodoWriteInput({
      todos: [{ content: 'A', activeForm: 'Doing A', status: 'wat' }],
    })
    expect(out).toEqual([{ content: 'A', activeForm: 'Doing A', state: 'pending' }])
  })

  it('returns an empty array when todos is empty (caller decides what to do)', () => {
    // Distinct from null: empty array is a valid (if unusual) replacement.
    expect(parseTodoWriteInput({ todos: [] })).toEqual([])
  })
})

describe('reducer: TodoWrite ingestion', () => {
  it('parent TodoWrite atomically replaces ProgressCardState.tasks', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    expect(state.tasks).toEqual([])

    state = reduce(
      state,
      todoWrite([
        { content: 'Refactor', activeForm: 'Refactoring', status: 'in_progress' },
        { content: 'Wire', activeForm: 'Wiring', status: 'pending' },
      ]),
      BASE_TIME + 1000,
    )
    expect(state.tasks).toEqual([
      { content: 'Refactor', activeForm: 'Refactoring', state: 'in_progress' },
      { content: 'Wire', activeForm: 'Wiring', state: 'pending' },
    ])
  })

  it('atomic replace: a second TodoWrite overwrites the slice', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(
      state,
      todoWrite([{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }]),
      BASE_TIME + 1000,
    )
    state = reduce(
      state,
      todoWrite([
        { content: 'A', activeForm: 'Doing A', status: 'completed' },
        { content: 'B', activeForm: 'Doing B', status: 'in_progress' },
      ]),
      BASE_TIME + 2000,
    )
    expect(state.tasks).toEqual([
      { content: 'A', activeForm: 'Doing A', state: 'completed' },
      { content: 'B', activeForm: 'Doing B', state: 'in_progress' },
    ])
  })

  it('non-TodoWrite tool_use leaves tasks unchanged', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(
      state,
      todoWrite([{ content: 'A', activeForm: 'Doing A', status: 'pending' }]),
      BASE_TIME + 1000,
    )
    const tasksBefore = state.tasks
    state = reduce(
      state,
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1', input: { command: 'ls' } } as SessionEvent,
      BASE_TIME + 2000,
    )
    expect(state.tasks).toBe(tasksBefore)
  })

  it('sub-agent TodoWrite atomically replaces SubAgentState.tasks', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(state, subStart('sub-1'), BASE_TIME + 500)
    expect(state.subAgents.get('sub-1')?.tasks).toEqual([])

    state = reduce(
      state,
      subTodoWrite('sub-1', [
        { content: 'A', activeForm: 'Doing A', status: 'in_progress' },
      ]),
      BASE_TIME + 1000,
    )
    expect(state.subAgents.get('sub-1')?.tasks).toEqual([
      { content: 'A', activeForm: 'Doing A', state: 'in_progress' },
    ])

    // Parent's tasks are unaffected.
    expect(state.tasks).toEqual([])
  })

  it('parent and sub-agent task slices are independent', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(state, subStart('sub-1'), BASE_TIME + 500)

    state = reduce(
      state,
      todoWrite([{ content: 'P', activeForm: 'Doing P', status: 'in_progress' }]),
      BASE_TIME + 1000,
    )
    state = reduce(
      state,
      subTodoWrite('sub-1', [{ content: 'S', activeForm: 'Doing S', status: 'pending' }]),
      BASE_TIME + 2000,
    )

    expect(state.tasks).toEqual([
      { content: 'P', activeForm: 'Doing P', state: 'in_progress' },
    ])
    expect(state.subAgents.get('sub-1')?.tasks).toEqual([
      { content: 'S', activeForm: 'Doing S', state: 'pending' },
    ])
  })
})

describe('glyphForTick', () => {
  it('returns frames in order', () => {
    expect(glyphForTick(0)).toBe(STATUS_GLYPHS[0])
    expect(glyphForTick(1)).toBe(STATUS_GLYPHS[1])
    expect(glyphForTick(STATUS_GLYPHS.length - 1)).toBe(STATUS_GLYPHS[STATUS_GLYPHS.length - 1])
  })

  it('wraps modulo the frame count', () => {
    expect(glyphForTick(STATUS_GLYPHS.length)).toBe(STATUS_GLYPHS[0])
    expect(glyphForTick(STATUS_GLYPHS.length * 7 + 3)).toBe(STATUS_GLYPHS[3])
  })

  it('handles negative ticks (defensive)', () => {
    // Driver shouldn't pass negatives, but the math should still land on a valid frame.
    const out = glyphForTick(-1)
    expect(STATUS_GLYPHS).toContain(out)
  })
})

describe('projectAgentSlice — parent', () => {
  it('uses turnStartedAt as the elapsed origin by default', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    const slice = projectAgentSlice({
      state,
      agentId: '__parent__',
      kind: 'parent',
      k: 1,
      n: 1,
      glyphTick: 0,
      now: BASE_TIME + 5000,
    })
    expect(slice).not.toBeNull()
    expect(slice!.kind).toBe('parent')
    expect(slice!.startedAt).toBe(BASE_TIME)
    expect(slice!.title).toBe('Main')
  })

  it('respects parentStartedAt override', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    const slice = projectAgentSlice({
      state,
      agentId: '__parent__',
      kind: 'parent',
      k: 1,
      n: 1,
      glyphTick: 0,
      now: BASE_TIME + 5000,
      parentStartedAt: BASE_TIME + 1000,
    })
    expect(slice!.startedAt).toBe(BASE_TIME + 1000)
  })

  it('verb falls back to "starting" before any activity', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    const slice = projectAgentSlice({
      state,
      agentId: '__parent__',
      kind: 'parent',
      k: 1,
      n: 1,
      glyphTick: 0,
      now: BASE_TIME + 100,
    })!
    expect(slice.verb).toBe('starting')
  })

  it('verb tracks the most recent running tool', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(
      state,
      { kind: 'tool_use', toolName: 'Bash', toolUseId: 'b1', input: { description: 'Run tests' } } as SessionEvent,
      BASE_TIME + 1000,
    )
    const slice = projectAgentSlice({
      state, agentId: '__parent__', kind: 'parent', k: 1, n: 1, glyphTick: 0, now: BASE_TIME + 1500,
    })!
    // humanAuthored description path bypasses the tool prefix.
    expect(slice.verb).toBe('Run tests')
  })

  it('exposes parent.tasks slice', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(
      state,
      todoWrite([{ content: 'A', activeForm: 'Doing A', status: 'in_progress' }]),
      BASE_TIME + 100,
    )
    const slice = projectAgentSlice({
      state, agentId: '__parent__', kind: 'parent', k: 1, n: 1, glyphTick: 0, now: BASE_TIME + 200,
    })!
    expect(slice.tasks).toEqual([
      { content: 'A', activeForm: 'Doing A', state: 'in_progress' },
    ])
  })
})

describe('projectAgentSlice — sub-agent', () => {
  it('returns null for an unknown agentId', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    const slice = projectAgentSlice({
      state, agentId: 'sub-missing', kind: 'sub', k: 2, n: 2, glyphTick: 0, now: BASE_TIME + 500,
    })
    expect(slice).toBeNull()
  })

  it('uses the sub-agent startedAt as elapsed origin', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(state, subStart('sub-1'), BASE_TIME + 1000)
    const slice = projectAgentSlice({
      state, agentId: 'sub-1', kind: 'sub', k: 2, n: 2, glyphTick: 5, now: BASE_TIME + 4000,
    })!
    expect(slice.kind).toBe('sub')
    expect(slice.startedAt).toBe(BASE_TIME + 1000)
    expect(slice.k).toBe(2)
    expect(slice.n).toBe(2)
    expect(slice.glyphTick).toBe(5)
  })

  it('verb tracks current tool, with fallback to narrative + description', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(state, subStart('sub-1'), BASE_TIME + 1000)
    // No tool yet → fall back to description (set via correlation).
    let sa = state.subAgents.get('sub-1')!
    // Manually patch description to assert the fallback chain. Reducer
    // sets it via correlation; here we synthesise it.
    state = {
      ...state,
      subAgents: new Map([['sub-1', { ...sa, description: 'research' }]]),
    } as ProgressCardState
    let slice = projectAgentSlice({
      state, agentId: 'sub-1', kind: 'sub', k: 1, n: 1, glyphTick: 0, now: BASE_TIME + 1500,
    })!
    expect(slice.verb).toBe('research')

    // Then a tool starts → verb tracks the tool label.
    state = reduce(
      state,
      { kind: 'sub_agent_tool_use', agentId: 'sub-1', toolName: 'Read', toolUseId: 'tu_r', input: { file_path: '/foo/bar.ts' } } as SessionEvent,
      BASE_TIME + 2000,
    )
    slice = projectAgentSlice({
      state, agentId: 'sub-1', kind: 'sub', k: 1, n: 1, glyphTick: 0, now: BASE_TIME + 2100,
    })!
    expect(slice.verb).toMatch(/^Read /)
  })
})

describe('renderTaskList', () => {
  it('returns empty string for an empty list', () => {
    expect(renderTaskList([])).toBe('')
  })

  it('orders in_progress, pending, completed', () => {
    const tasks: TaskItem[] = [
      { content: 'Pending one', activeForm: 'Doing pending one', state: 'pending' },
      { content: 'Done one', activeForm: 'Doing done one', state: 'completed' },
      { content: 'Active one', activeForm: 'Doing active one', state: 'in_progress' },
    ]
    const out = renderTaskList(tasks)
    const lines = out.split('\n')
    expect(lines[0]).toContain(TASK_SYMBOL.in_progress)
    expect(lines[0]).toContain('<b>Doing active one</b>')
    expect(lines[1]).toContain(TASK_SYMBOL.pending)
    expect(lines[1]).toContain('Pending one')
    expect(lines[2]).toContain(TASK_SYMBOL.completed)
    expect(lines[2]).toContain('<s>Done one</s>')
  })

  it('escapes HTML in task text', () => {
    const out = renderTaskList([
      { content: '<script>x</script>', activeForm: 'Doing', state: 'pending' },
    ])
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })
})

describe('renderAgentCard', () => {
  function baseInput(overrides: Partial<Parameters<typeof renderAgentCard>[0]> = {}) {
    return {
      kind: 'sub' as const,
      agentId: 'sub-1',
      title: 'research',
      verb: 'thinking',
      state: 'running' as const,
      startedAt: BASE_TIME,
      k: 1,
      n: 1,
      glyphTick: 0,
      now: BASE_TIME + 5000,
      tasks: [],
      ...overrides,
    }
  }

  it('renders the k-of-n header + status row', () => {
    const out = renderAgentCard(baseInput({ k: 2, n: 4, title: 'research', verb: 'thinking' }))
    expect(out).toContain('<b>Agent 2 of 4</b> — research')
    expect(out).toContain('<i>thinking</i>')
    expect(out).toContain('5s')
    // Token + thinking placeholders for the deferred ingestion.
    expect(out).toContain('↓?')
    expect(out).toContain('thought —')
  })

  it('uses the spinner glyph for running', () => {
    const out = renderAgentCard(baseInput({ glyphTick: 0, state: 'running' }))
    expect(out.startsWith(STATUS_GLYPHS[0]) || out.includes(STATUS_GLYPHS[0])).toBe(true)
  })

  it('uses the snowflake glyph for done', () => {
    const out = renderAgentCard(baseInput({ state: 'done' }))
    expect(out).toContain(STATUS_GLYPH_DONE)
  })

  it('uses the no-entry glyph for failed', () => {
    const out = renderAgentCard(baseInput({ state: 'failed' }))
    expect(out).toContain(STATUS_GLYPH_FAILED)
  })

  it('formats elapsed under 60s as `Ns`', () => {
    expect(renderAgentCard(baseInput({ now: BASE_TIME + 12_000 }))).toContain('12s')
  })

  it('formats elapsed at minute boundaries as `m:ss`', () => {
    expect(renderAgentCard(baseInput({ now: BASE_TIME + 65_000 }))).toContain('1:05')
    expect(renderAgentCard(baseInput({ now: BASE_TIME + 22 * 60_000 + 19_000 }))).toContain('22:19')
  })

  it('renders tokens when supplied', () => {
    expect(renderAgentCard(baseInput({ tokens: 76_600 }))).toContain('↓76.6k')
    expect(renderAgentCard(baseInput({ tokens: 2_500_000 }))).toContain('↓2.5M')
    expect(renderAgentCard(baseInput({ tokens: 42 }))).toContain('↓42')
  })

  it('renders thinking duration when supplied', () => {
    expect(renderAgentCard(baseInput({ thinkingMs: 8000 }))).toContain('thought 8s')
    expect(renderAgentCard(baseInput({ thinkingMs: 75_000 }))).toContain('thought 1:15')
  })

  it('includes the narrative line as a blockquote', () => {
    const out = renderAgentCard(baseInput({ narrative: 'Reading test fixtures' }))
    expect(out).toContain('<blockquote>Reading test fixtures</blockquote>')
  })

  it('includes the task block under the status row', () => {
    const out = renderAgentCard(
      baseInput({
        tasks: [
          { content: 'A', activeForm: 'Doing A', state: 'in_progress' },
          { content: 'B', activeForm: 'Doing B', state: 'pending' },
        ],
      }),
    )
    expect(out).toContain(TASK_SYMBOL.in_progress)
    expect(out).toContain('<b>Doing A</b>')
    expect(out).toContain(TASK_SYMBOL.pending)
    expect(out).toContain('B')
  })

  it('escapes the title and verb for HTML safety', () => {
    const out = renderAgentCard(
      baseInput({ title: 'A & B', verb: '<x>' }),
    )
    expect(out).toContain('A &amp; B')
    expect(out).toContain('&lt;x&gt;')
    expect(out).not.toContain('<x>')
  })

  it('renders empty verb as "idle"', () => {
    const out = renderAgentCard(baseInput({ verb: '' }))
    expect(out).toContain('<i>idle</i>')
  })

  it('parent kind renders the same template', () => {
    const out = renderAgentCard(baseInput({ kind: 'parent', title: 'Main', verb: 'Bash ls' }))
    expect(out).toContain('<b>Agent 1 of 1</b> — Main')
    expect(out).toContain('<i>Bash ls</i>')
  })
})

describe('end-to-end: TodoWrite → reducer → render', () => {
  it('drives a full status row + task list from real-shaped events', () => {
    let state = initialState()
    state = reduce(state, enqueue(), BASE_TIME)
    state = reduce(state, subStart('sub-1', 'p1', 'go'), BASE_TIME + 1000)
    // Patch description so the verb fallback shows something stable.
    const sa = state.subAgents.get('sub-1')! as SubAgentState
    state = {
      ...state,
      subAgents: new Map([['sub-1', { ...sa, description: 'research' }]]),
    } as ProgressCardState
    state = reduce(
      state,
      subTodoWrite('sub-1', [
        { content: 'Refactor', activeForm: 'Refactoring', status: 'in_progress' },
        { content: 'Wire', activeForm: 'Wiring', status: 'pending' },
      ]),
      BASE_TIME + 2000,
    )
    const slice = projectAgentSlice({
      state, agentId: 'sub-1', kind: 'sub', k: 2, n: 3, glyphTick: 4, now: BASE_TIME + 22_000,
    })!
    const html = renderAgentCard(slice)
    expect(html).toContain('<b>Agent 2 of 3</b> — research')
    expect(html).toContain('21s')
    expect(html).toContain(TASK_SYMBOL.in_progress)
    expect(html).toContain('<b>Refactoring</b>')
    expect(html).toContain(TASK_SYMBOL.pending)
    expect(html).toContain('Wire')
  })
})
