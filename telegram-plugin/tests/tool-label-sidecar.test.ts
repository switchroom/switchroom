import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolLabelSidecar } from '../tool-label-sidecar.js'

/**
 * Unit tests for tool-label-sidecar.ts (#783).
 *
 * Uses an injected scheduler so we drive polls deterministically — no
 * setTimeout, no flake.
 */

function makeManualScheduler() {
  let tickFn: (() => void) | null = null
  return {
    setInterval: (cb: () => void, _ms: number) => {
      tickFn = cb
      return Symbol('handle')
    },
    clearInterval: (_h: unknown) => {
      tickFn = null
    },
    tick: () => { if (tickFn) tickFn() },
  }
}

describe('tool-label-sidecar', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'tool-label-sidecar-'))
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('returns undefined when sidecar file is missing', () => {
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId: 'no-such', scheduler: sched })
    expect(s.getLabel('whatever')).toBeUndefined()
    s.stop()
  })

  it('reads existing sidecar lines on construction', () => {
    const sessionId = 'sess1'
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    writeFileSync(f, JSON.stringify({ ts: 1, tool_use_id: 'A', agent_id: 'g', label: 'Reading foo.ts', tool_name: 'Read' }) + '\n')
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('A')).toBe('Reading foo.ts')
    expect(s.getLabel('B')).toBeUndefined()
    s.stop()
  })

  it('picks up appended lines on poll() (renderer reads, hook then writes)', () => {
    const sessionId = 'sess2'
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('A')).toBeUndefined()

    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    appendFileSync(f, JSON.stringify({ ts: 1, tool_use_id: 'A', agent_id: null, label: 'Replying', tool_name: 'mcp__switchroom-telegram__reply' }) + '\n')
    s.poll()
    expect(s.getLabel('A')).toBe('Replying')
    s.stop()
  })

  it('fires onLabel subscribers as new lines arrive', () => {
    const sessionId = 'sess3'
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    const seen: Array<[string, string]> = []
    s.onLabel((id, label) => seen.push([id, label]))

    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    appendFileSync(f, JSON.stringify({ ts: 1, tool_use_id: 'X', agent_id: null, label: 'Reading a.ts', tool_name: 'Read' }) + '\n')
    s.poll()
    expect(seen).toEqual([['X', 'Reading a.ts']])

    appendFileSync(f, JSON.stringify({ ts: 2, tool_use_id: 'Y', agent_id: null, label: 'Editing b.ts', tool_name: 'Edit' }) + '\n')
    s.poll()
    expect(seen).toEqual([['X', 'Reading a.ts'], ['Y', 'Editing b.ts']])
    s.stop()
  })

  it('replays pre-existing rows to a subscriber that attaches after construction', () => {
    // Regression: the gateway's session-tail constructs the sidecar (which
    // does an initial drain of the file) and only THEN wires `onLabel`. On a
    // fast/clustered turn — or a resumed/flipped session — the hook has
    // already written labels, so the initial drain consumed them with an
    // empty subscriber set. Before the replay fix the late subscriber got
    // nothing, so the real-time draft-mirror never fired (every label lost).
    const sessionId = 'sess-replay'
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    writeFileSync(
      f,
      JSON.stringify({ ts: 1, tool_use_id: 'A', agent_id: 'g', label: 'Reading foo.ts', tool_name: 'Read' }) + '\n' +
      JSON.stringify({ ts: 2, tool_use_id: 'B', agent_id: 'g', label: 'List workspace', tool_name: 'Bash' }) + '\n',
    )
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    // Subscribe AFTER construction (the real ensureSidecar ordering).
    const seen: Array<[string, string, string]> = []
    s.onLabel((id, label, toolName) => seen.push([id, label, toolName]))
    expect(seen).toEqual([
      ['A', 'Reading foo.ts', 'Read'],
      ['B', 'List workspace', 'Bash'],
    ])

    // And a row appended afterwards still reaches the subscriber exactly once
    // (no double-emit of the replayed rows).
    appendFileSync(f, JSON.stringify({ ts: 3, tool_use_id: 'C', agent_id: 'g', label: 'Searching memory', tool_name: 'mcp__hindsight__recall' }) + '\n')
    s.poll()
    expect(seen).toEqual([
      ['A', 'Reading foo.ts', 'Read'],
      ['B', 'List workspace', 'Bash'],
      ['C', 'Searching memory', 'mcp__hindsight__recall'],
    ])
    s.stop()
  })

  it('ignores malformed JSON lines', () => {
    const sessionId = 'sess4'
    const sched = makeManualScheduler()
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    writeFileSync(
      f,
      'not-json\n' +
      JSON.stringify({ tool_use_id: 'good', label: 'Saved memory', ts: 1, tool_name: 'mcp__hindsight__retain', agent_id: null }) + '\n' +
      '{partial\n',
    )
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('good')).toBe('Saved memory')
    s.stop()
  })

  it('first write wins (idempotent on duplicates)', () => {
    const sessionId = 'sess5'
    const sched = makeManualScheduler()
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    writeFileSync(
      f,
      JSON.stringify({ tool_use_id: 'A', label: 'first', ts: 1, tool_name: 'Read', agent_id: null }) + '\n' +
      JSON.stringify({ tool_use_id: 'A', label: 'second', ts: 2, tool_name: 'Read', agent_id: null }) + '\n',
    )
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('A')).toBe('first')
    s.stop()
  })
})
