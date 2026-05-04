/**
 * P0 of #662 — watcher exposes `lastTool` on WorkerEntry.
 *
 * The driver shadow needs the most recent tool name + sanitised arg
 * for each running sub-agent. The watcher already projects
 * `sub_agent_tool_use` events from the JSONL tail; this test pins the
 * new field so subsequent driver work can rely on it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSubagentWatcher } from '../subagent-watcher.js'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function userMsg(text: string) {
  return { type: 'user', message: { content: [{ type: 'text', text }] } }
}

function toolUse(name: string, id: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  }
}

describe('subagent-watcher: WorkerEntry.lastTool', () => {
  let tmpRoot = ''
  const stops: Array<{ stop(): void }> = []

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'fleet-watcher-'))
  })

  afterEach(() => {
    while (stops.length) {
      try { stops.pop()?.stop() } catch { /* */ }
    }
    try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* */ }
  })

  function startWatcher(agentDir: string): {
    watcher: ReturnType<typeof startSubagentWatcher>
    poll: () => void
  } {
    const intervals: Array<{ fn: () => void }> = []
    const w = startSubagentWatcher({
      agentDir,
      sendNotification: () => {},
      stallThresholdMs: 60_000,
      rescanMs: 500,
      now: () => Date.now(),
      setInterval: (fn) => { intervals.push({ fn }); return { ref: intervals.length } },
      clearInterval: () => {},
      setTimeout: () => ({ ref: 0 }),
      clearTimeout: () => {},
      log: () => {},
    })
    stops.push(w)
    return { watcher: w, poll: () => intervals[0]?.fn() }
  }

  it('populates lastTool with most recent tool name + sanitised arg', () => {
    const content = buildJSONL(
      userMsg('do work'),
      toolUse('Read', 'id1', { file_path: '/etc/secrets/foo.key' }),
      toolUse('Bash', 'id2', { command: 'ls -la /tmp' }),
    )
    const agentDir = join(tmpRoot, 'agent')
    const subDir = join(agentDir, '.claude', 'projects', 'p1', 'session-x', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'agent-deadbeef.jsonl'), content)

    const h = startWatcher(agentDir)
    h.poll()

    const entry = h.watcher.getRegistry().get('deadbeef')
    expect(entry).toBeDefined()
    expect(entry?.lastTool).toEqual({ name: 'Bash', sanitisedArg: 'ls -la /tmp' })
    expect(entry?.toolCount).toBe(2)
  })

  it('lastTool is null before any tool_use event', () => {
    const content = buildJSONL(userMsg('hello'))
    const agentDir = join(tmpRoot, 'agent')
    const subDir = join(agentDir, '.claude', 'projects', 'p1', 'session-x', 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'agent-cafef00d.jsonl'), content)

    const h = startWatcher(agentDir)
    h.poll()

    const entry = h.watcher.getRegistry().get('cafef00d')
    expect(entry).toBeDefined()
    expect(entry?.lastTool).toBeNull()
  })
})
