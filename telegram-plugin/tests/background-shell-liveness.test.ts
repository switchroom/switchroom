import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { applyBackgroundShellLiveness } from '../gateway/background-shell-liveness.js'
import { projectTranscriptLine, type SessionEvent } from '../session-tail.js'

// #3519 sharpen — the glue that maps parsed session events to the silence-poke
// background-shell registry. Driven by the REAL fixtures (carrie session
// a6d2d33a-…, claude v2.1.197; see tests/fixtures/bg-shell-liveness-3519.jsonl)
// parsed through the production projectTranscriptLine path, so the event shapes
// here are exactly what the gateway sees at runtime.
describe('applyBackgroundShellLiveness (real markers)', () => {
  const FIXTURE = join(__dirname, 'fixtures', 'bg-shell-liveness-3519.jsonl')
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(l => l.length > 0)
  const aliveEv = projectTranscriptLine(lines[0]).find(e => e.kind === 'tool_result')!
  const deadEv = projectTranscriptLine(lines[1])[0]
  // The real shell id carried by both the ALIVE and DEAD fixture lines.
  const REAL_ID = aliveEv.kind === 'tool_result' ? aliveEv.backgroundTaskId : undefined

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
    expect(r.calls).toEqual([{ fn: 'alive', key: 'c:0', id: REAL_ID! }])
  })

  it('DEAD: a real <task-notification> completion → noteBackgroundShellDead', () => {
    const r = spyRegistry()
    applyBackgroundShellLiveness(r, 'c:0', deadEv)
    expect(r.calls).toEqual([{ fn: 'dead', key: 'c:0', id: REAL_ID! }])
  })

  it('DEAD: a KillShell tool_use → noteBackgroundShellDead by shell_id', () => {
    const r = spyRegistry()
    const ev: SessionEvent = { kind: 'tool_use', toolName: 'KillShell', toolUseId: 't9', input: { shell_id: REAL_ID! } }
    applyBackgroundShellLiveness(r, 'c:0', ev)
    expect(r.calls).toEqual([{ fn: 'dead', key: 'c:0', id: REAL_ID! }])
  })

  it('no-op: an ordinary (foreground-completed) tool_result carries no marker', () => {
    const r = spyRegistry()
    const ev: SessionEvent = { kind: 'tool_result', toolUseId: 't1', toolName: null }
    applyBackgroundShellLiveness(r, 'c:0', ev)
    expect(r.calls).toEqual([])
  })

  it('DEFENSIVE: a hypothetical non-terminal <task-notification> does NOT mark the shell dead', () => {
    // Guards a future CLI that emits an interim (still-running) notification.
    // The terminal-status gate must keep a live shell in the alive-set — only
    // completed/failed/killed drop it. Built from the SAME real shell id so the
    // scenario is a faithful "what if this id got an interim update" case.
    const r = spyRegistry()
    const interim: SessionEvent = { kind: 'task_notification', taskId: REAL_ID!, status: 'running' }
    applyBackgroundShellLiveness(r, 'c:0', interim)
    expect(r.calls).toEqual([])
  })

  it('no-op: a non-KillShell tool_use is ignored', () => {
    const r = spyRegistry()
    const ev: SessionEvent = { kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: { command: 'ls' } }
    applyBackgroundShellLiveness(r, 'c:0', ev)
    expect(r.calls).toEqual([])
  })
})
