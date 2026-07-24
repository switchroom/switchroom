import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { applyBackgroundShellLiveness } from '../gateway/background-shell-liveness.js'
import { projectTranscriptLine, type SessionEvent } from '../session-tail.js'

// #3519 sharpen — the glue that maps parsed session events to the silence-poke
// background-shell registry. Driven by the REAL fixtures (carrie session
// 1db49136-…, claude v2.1.185; see tests/fixtures/bg-shell-liveness-3519.jsonl)
// parsed through the production projectTranscriptLine path, so the event shapes
// here are exactly what the gateway sees at runtime.
describe('applyBackgroundShellLiveness (real markers)', () => {
  const FIXTURE = join(__dirname, 'fixtures', 'bg-shell-liveness-3519.jsonl')
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.length > 0)
  const aliveEv = projectTranscriptLine(lines[0]).find(e => e.kind === 'tool_result')!
  const deadEv = projectTranscriptLine(lines[1])[0]

  function spyRegistry() {
    const calls: Array<{ fn: 'alive' | 'dead'; key: string; id: string }> = []
    return {
      calls,
      noteBackgroundShellAlive: (key: string, id: string) => calls.push({ fn: 'alive', key, id }),
      noteBackgroundShellDead: (key: string, id: string) => calls.push({ fn: 'dead', key, id }),
    }
  }

  it('ALIVE: a real tool_result with backgroundTaskId → noteBackgroundShellAlive', () => {
    const r = spyRegistry()
    applyBackgroundShellLiveness(r, 'c:0', aliveEv)
    expect(r.calls).toEqual([{ fn: 'alive', key: 'c:0', id: 'bweqqjn9r' }])
  })

  it('DEAD: a real <task-notification> completion → noteBackgroundShellDead', () => {
    const r = spyRegistry()
    applyBackgroundShellLiveness(r, 'c:0', deadEv)
    expect(r.calls).toEqual([{ fn: 'dead', key: 'c:0', id: 'bweqqjn9r' }])
  })

  it('DEAD: a KillShell tool_use → noteBackgroundShellDead by shell_id', () => {
    const r = spyRegistry()
    const ev: SessionEvent = { kind: 'tool_use', toolName: 'KillShell', toolUseId: 't9', input: { shell_id: 'bweqqjn9r' } }
    applyBackgroundShellLiveness(r, 'c:0', ev)
    expect(r.calls).toEqual([{ fn: 'dead', key: 'c:0', id: 'bweqqjn9r' }])
  })

  it('no-op: an ordinary (foreground-completed) tool_result carries no marker', () => {
    const r = spyRegistry()
    const ev: SessionEvent = { kind: 'tool_result', toolUseId: 't1', toolName: null }
    applyBackgroundShellLiveness(r, 'c:0', ev)
    expect(r.calls).toEqual([])
  })

  it('no-op: a non-KillShell tool_use is ignored', () => {
    const r = spyRegistry()
    const ev: SessionEvent = { kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: { command: 'ls' } }
    applyBackgroundShellLiveness(r, 'c:0', ev)
    expect(r.calls).toEqual([])
  })
})
