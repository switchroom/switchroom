/**
 * Tests for SubagentWatcher card resurrection (issue #3023).
 *
 * PR #3019 makes false terminal synthesis far less likely (in-flight tool
 * gate + 45min cap), but can't eliminate it. This suite locks the second
 * half of the operator invariant — "active work must always be visible":
 *
 *  (a) When a worker's card is FALSELY finalised (silent-stall synthesis
 *      fires) and its JSONL later resumes growing, the watcher resurrects it
 *      exactly once — fires `onResurrect`, re-registers it LIVE, emits a
 *      resurrection log line. A further growth tick does NOT re-fire.
 *  (b) A worker resurrected once and then falsely finalised AGAIN is
 *      named-as-lost (`onWorkerLost`), NOT resurrected a second time — the
 *      resurrection chain is bounded.
 *  (c) A genuine boot-time historical rediscovery of an old completed worker
 *      stays historical/suppressed — it never records a false finish, so it
 *      can never be resurrected even if its file were to grow.
 */

import { describe, it, expect, vi } from 'vitest'
import { startSubagentWatcher } from '../subagent-watcher.js'
import * as fs from 'fs'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}
function subAgentTurnEnd() {
  return { type: 'system', subtype: 'turn_duration', duration_ms: 1234 }
}

interface Harness {
  resurrectCalls: Array<{ agentId: string; description: string }>
  lostCalls: Array<{ agentId: string; description: string }>
  stallTerminalCalls: Array<{ agentId: string }>
  finishCalls: Array<{ agentId: string; outcome: string }>
  logs: string[]
  advance: (ms: number) => void
  watcher: ReturnType<typeof startSubagentWatcher>
  fileContents: Map<string, Buffer>
  jsonlPath: string
  appendActivity: () => void
  presentAtBoot: (content: string) => void
}

function makeHarness(opts: {
  agentId?: string
  stallThresholdMs?: number
  silentStallTerminalMs?: number
  rescanMs?: number
  bootContent?: string
} = {}): Harness {
  const {
    agentId = 'resurrect-agent',
    stallThresholdMs = 60_000,
    silentStallTerminalMs = 300_000,
    rescanMs = 500,
    bootContent,
  } = opts

  let currentTime = 1000
  const resurrectCalls: Array<{ agentId: string; description: string }> = []
  const lostCalls: Array<{ agentId: string; description: string }> = []
  const stallTerminalCalls: Array<{ agentId: string }> = []
  const finishCalls: Array<{ agentId: string; outcome: string }> = []
  const logs: string[] = []

  const agentDir = '/home/user/.switchroom/agents/myagent'
  const sessionId = 'mock-session'
  const projectsRoot = `${agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/${sessionId}`
  const subagentsDir = `${sessionDir}/subagents`
  const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

  const fileContents = new Map<string, Buffer>()
  fileContents.set(
    jsonlPath,
    Buffer.from(bootContent ?? buildJSONL(subAgentUserMsg('bg task')), 'utf-8'),
  )

  let lastOpenedPath: string | null = null
  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir) return true
      if (fileContents.has(ps)) return true
      return false
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot) return ['mock-cwd']
      if (ps === projectDir) return [sessionId]
      if (ps === sessionDir) return ['subagents']
      if (ps === subagentsDir) return [`agent-${agentId}.jsonl`]
      return []
    }) as unknown as typeof fs.readdirSync,
    statSync: ((p: fs.PathLike) =>
      ({ size: fileContents.get(String(p))?.length ?? 0, mtimeMs: currentTime }) as fs.Stats) as typeof fs.statSync,
    openSync: ((p: fs.PathLike) => {
      lastOpenedPath = String(p)
      return 42
    }) as unknown as typeof fs.openSync,
    closeSync: (() => { lastOpenedPath = null }) as typeof fs.closeSync,
    readSync: ((
      _fd: number,
      buf: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      const content = lastOpenedPath != null ? fileContents.get(lastOpenedPath) : undefined
      if (!content) return 0
      const pos = position ?? 0
      const src = content.slice(pos, pos + length)
      ;(src as Buffer).copy(buf as Buffer, offset)
      return src.length
    }) as unknown as typeof fs.readSync,
    watch: (() => ({ close: vi.fn() }) as unknown as fs.FSWatcher) as unknown as typeof fs.watch,
  }

  const intervals: Array<{ fn: () => void; ms: number; ref: number; fireAt: number }> = []
  const timeouts: Array<{ fn: () => void; ref: number; fireAt: number }> = []
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    stallThresholdMs,
    silentSynthesisStallThresholdMs: stallThresholdMs,
    silentStallTerminalMs,
    rescanMs,
    onStallTerminal: (id) => stallTerminalCalls.push({ agentId: id }),
    onResurrect: (id, desc) => resurrectCalls.push({ agentId: id, description: desc }),
    onWorkerLost: (id, desc) => lostCalls.push({ agentId: id, description: desc }),
    onFinish: ({ agentId: id, outcome }) => finishCalls.push({ agentId: id, outcome }),
    now: () => currentTime,
    setInterval: (fn, ms) => {
      const ref = nextRef++
      intervals.push({ fn, ms, ref, fireAt: currentTime + ms })
      return { ref }
    },
    clearInterval: (handle) => {
      const { ref } = handle as { ref: number }
      const idx = intervals.findIndex((i) => i.ref === ref)
      if (idx !== -1) intervals.splice(idx, 1)
    },
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timeouts.push({ fn, ref, fireAt: currentTime + ms })
      return { ref }
    },
    clearTimeout: (handle) => {
      const { ref } = handle as { ref: number }
      const idx = timeouts.findIndex((t) => t.ref === ref)
      if (idx !== -1) timeouts.splice(idx, 1)
    },
    fs: mockFs,
    log: (msg) => logs.push(msg),
  })

  const advance = (ms: number): void => {
    currentTime += ms
    for (;;) {
      intervals.sort((a, b) => a.fireAt - b.fireAt)
      timeouts.sort((a, b) => a.fireAt - b.fireAt)
      const nextI = intervals[0]
      const nextT = timeouts[0]
      const iReady = nextI && nextI.fireAt <= currentTime
      const tReady = nextT && nextT.fireAt <= currentTime
      if (!iReady && !tReady) break
      if (tReady && (!iReady || nextT!.fireAt <= nextI!.fireAt)) {
        timeouts.shift()
        nextT!.fn()
      } else {
        nextI!.fireAt += nextI!.ms
        nextI!.fn()
      }
    }
  }

  const appendActivity = (): void => {
    const cur = fileContents.get(jsonlPath) ?? Buffer.alloc(0)
    const more = buildJSONL({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'still working' }] },
    })
    fileContents.set(jsonlPath, Buffer.concat([cur, Buffer.from(more, 'utf-8')]))
  }

  const presentAtBoot = (content: string): void => {
    fileContents.set(jsonlPath, Buffer.from(content, 'utf-8'))
  }

  return {
    resurrectCalls,
    lostCalls,
    stallTerminalCalls,
    finishCalls,
    logs,
    advance,
    watcher,
    fileContents,
    jsonlPath,
    appendActivity,
    presentAtBoot,
  }
}

function unmarkHistorical(harness: Harness, agentId: string): void {
  const entry = harness.watcher.getRegistry().get(agentId)
  if (entry) entry.historical = false
}

/** Drive a running worker through stall → silent-stall terminal synthesis. */
function driveToFalseFinish(h: Harness, agentId: string): void {
  h.advance(62_000) // stall notification fires
  h.advance(302_000) // past silentStallTerminalMs — synthesis fires
}

describe('subagent-watcher card resurrection (issue #3023)', () => {
  it('(a) resurrects a falsely-finalised worker exactly once when its JSONL resumes', () => {
    const agentId = 'resurrect-once'
    const h = makeHarness({ agentId })

    h.advance(500) // register
    unmarkHistorical(h, agentId)

    driveToFalseFinish(h, agentId)
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.resurrectCalls).toHaveLength(0)

    // The worker was NOT actually dead — its JSONL resumes growing.
    h.appendActivity()
    h.advance(500) // poll → checkResurrections detects the growth

    expect(h.resurrectCalls).toHaveLength(1)
    expect(h.resurrectCalls[0].agentId).toBe(agentId)
    expect(h.lostCalls).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('RESURRECTING worker') && l.includes(agentId))).toBe(true)

    // The revived entry is LIVE again (running, non-historical).
    const entry = h.watcher.getRegistry().get(agentId)
    expect(entry).toBeDefined()
    expect(entry!.state).toBe('running')
    expect(entry!.historical).toBe(false)

    // A further growth tick for the SAME false finish does NOT re-resurrect.
    h.appendActivity()
    h.advance(500)
    expect(h.resurrectCalls).toHaveLength(1)
  })

  it('(b) names a twice-falsely-finalised worker LOST instead of resurrecting again', () => {
    const agentId = 'resurrect-bound'
    const h = makeHarness({ agentId })

    h.advance(500)
    unmarkHistorical(h, agentId)

    // First false finish + resurrection.
    driveToFalseFinish(h, agentId)
    h.appendActivity()
    h.advance(500) // poll → checkResurrections resurrects the entry
    h.advance(500) // poll → the revived entry reads its resumed JSONL (settles)
    expect(h.resurrectCalls).toHaveLength(1)
    expect(h.lostCalls).toHaveLength(0)

    // The revived worker goes silent AGAIN and is falsely finalised a second
    // time (no fresh activity → stall → synthesis).
    driveToFalseFinish(h, agentId)
    expect(h.stallTerminalCalls.length).toBeGreaterThanOrEqual(2)

    // Its JSONL resumes once more — but the chain bound is spent.
    h.appendActivity()
    h.advance(500)

    expect(h.resurrectCalls).toHaveLength(1) // NOT resurrected a second time
    expect(h.lostCalls).toHaveLength(1)
    expect(h.lostCalls[0].agentId).toBe(agentId)
    expect(h.logs.some((l) => l.includes('NAMED AS LOST') && l.includes(agentId))).toBe(true)

    // Further growth stays lost — no more resurrections, no more lost fires.
    h.appendActivity()
    h.advance(500)
    expect(h.resurrectCalls).toHaveLength(1)
    expect(h.lostCalls).toHaveLength(1)
  })

  it('(c) a genuine boot-time historical completed worker is never resurrected', () => {
    const agentId = 'old-completed'
    // Present at boot, already finished (turn_end in the file). This is the
    // "old completed worker rediscovered at boot" population — it must stay
    // historical/suppressed and never enter the resurrection path.
    const h = makeHarness({
      agentId,
      bootContent: buildJSONL(subAgentUserMsg('done long ago'), subAgentTurnEnd()),
    })

    h.advance(500) // boot scan already ran at construction; register historical

    const entry = h.watcher.getRegistry().get(agentId)
    // Historical done-at-boot entries are short-circuited (completionNotified).
    if (entry) expect(entry.historical).toBe(true)

    // Even if the file grows post-boot, there is no false-finish record for it,
    // so it can never be resurrected.
    h.appendActivity()
    h.advance(500)
    h.advance(500)

    expect(h.resurrectCalls).toHaveLength(0)
    expect(h.lostCalls).toHaveLength(0)
    expect(h.stallTerminalCalls).toHaveLength(0)
  })
})
