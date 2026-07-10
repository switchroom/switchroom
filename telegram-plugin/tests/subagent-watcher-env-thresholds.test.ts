/**
 * Env-var overrides for the watcher's threshold knobs
 * (`stallThresholdMs`, `silentSynthesisStallThresholdMs`,
 * `silentStallTerminalMs`). Used by the UAT harness to compress the
 * stall+synth window so `bg-sub-agent-dispatch-dm.test.ts` can
 * validate Bug 6's terminal-synthesis path inside its 120s timeout
 * instead of waiting the production-tuned 6min.
 *
 * Resolution order: explicit config arg → env var → compile-time
 * default. Invalid env values (0, negative, NaN, empty string) fall
 * through to the default — we don't want a stray `=0` to silently
 * disable stall detection in production.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startSubagentWatcher } from '../subagent-watcher.js'
import * as fs from 'fs'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}

function makeHarness(opts: {
  agentId?: string
  configStallThresholdMs?: number
  configSilentSynthStallThresholdMs?: number
  configSilentStallTerminalMs?: number
  configInflightTerminalCapMs?: number
  initialContent?: string
} = {}) {
  const {
    agentId = 'env-thresh-agent',
    configStallThresholdMs,
    configSilentSynthStallThresholdMs,
    configSilentStallTerminalMs,
    configInflightTerminalCapMs,
    initialContent,
  } = opts

  let currentTime = 1000
  const stallCalls: Array<{ idleMs: number }> = []
  const stallTerminalCalls: Array<{ agentId: string }> = []
  const finishCalls: Array<{ outcome: string }> = []

  const agentDir = '/home/user/.switchroom/agents/myagent'
  const sessionId = 'mock-session'
  const projectsRoot = `${agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/${sessionId}`
  const subagentsDir = `${sessionDir}/subagents`
  const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`
  const fileContents = new Map<string, Buffer>()
  fileContents.set(jsonlPath, Buffer.from(initialContent ?? buildJSONL(subAgentUserMsg('bg task')), 'utf-8'))

  let lastOpenedPath: string | null = null
  const mockFs = {
    existsSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir) return true
      return fileContents.has(ps)
    }) as typeof fs.existsSync,
    readdirSync: ((p: fs.PathLike) => {
      const ps = String(p)
      if (ps === projectsRoot) return ['mock-cwd']
      if (ps === projectDir) return [sessionId]
      if (ps === sessionDir) return ['subagents']
      if (ps === subagentsDir) return [`agent-${agentId}.jsonl`]
      return []
    }) as unknown as typeof fs.readdirSync,
    statSync: ((p: fs.PathLike) => ({ size: fileContents.get(String(p))?.length ?? 0 }) as fs.Stats) as typeof fs.statSync,
    openSync: ((p: fs.PathLike) => { lastOpenedPath = String(p); return 42 }) as unknown as typeof fs.openSync,
    closeSync: (() => { lastOpenedPath = null }) as typeof fs.closeSync,
    readSync: ((
      _fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
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
  let nextRef = 1
  const watcher = startSubagentWatcher({
    agentDir,
    stallThresholdMs: configStallThresholdMs,
    silentSynthesisStallThresholdMs: configSilentSynthStallThresholdMs ?? configStallThresholdMs,
    silentStallTerminalMs: configSilentStallTerminalMs,
    inflightTerminalCapMs: configInflightTerminalCapMs,
    rescanMs: 500,
    onStall: (_id, idleMs) => stallCalls.push({ idleMs }),
    onStallTerminal: (id) => stallTerminalCalls.push({ agentId: id }),
    onFinish: ({ outcome }) => finishCalls.push({ outcome }),
    now: () => currentTime,
    setInterval: (fn, ms) => {
      const ref = nextRef++
      intervals.push({ fn, ms, ref, fireAt: currentTime + ms })
      return { ref }
    },
    clearInterval: (h) => {
      const { ref } = h as { ref: number }
      const idx = intervals.findIndex((i) => i.ref === ref)
      if (idx !== -1) intervals.splice(idx, 1)
    },
    fs: mockFs,
  })

  const advance = (ms: number): void => {
    currentTime += ms
    for (;;) {
      intervals.sort((a, b) => a.fireAt - b.fireAt)
      const next = intervals[0]
      if (!next || next.fireAt > currentTime) break
      next.fireAt += next.ms
      next.fn()
    }
  }

  const unmarkHistorical = (): void => {
    const e = watcher.getRegistry().get(agentId)
    if (e) e.historical = false
  }

  return { stallCalls, stallTerminalCalls, finishCalls, advance, unmarkHistorical }
}

const ENV_KEYS = [
  'SWITCHROOM_SUBAGENT_STALL_MS',
  'SWITCHROOM_SUBAGENT_SILENT_SYNTH_STALL_MS',
  'SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS',
  'SWITCHROOM_SUBAGENT_INFLIGHT_TERMINAL_CAP_MS',
] as const

describe('subagent-watcher env-var threshold overrides', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('honors SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS for the synth window', () => {
    process.env.SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS = '5000'
    const h = makeHarness({
      // Tight stall threshold so the test isn't dominated by the
      // 60s default.
      configStallThresholdMs: 1000,
    })
    h.advance(500) // register
    h.unmarkHistorical()
    h.advance(2_000) // stall fires (idle > 1s)
    expect(h.stallCalls).toHaveLength(1)
    expect(h.stallTerminalCalls).toHaveLength(0)

    // 4s post-stall — still under 5s env override.
    h.advance(4_000)
    expect(h.stallTerminalCalls).toHaveLength(0)

    // Cross 5s — synth fires.
    h.advance(2_000)
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.finishCalls).toHaveLength(1)
  })

  it('explicit config arg overrides env var (config wins)', () => {
    process.env.SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS = '5000'
    const h = makeHarness({
      configStallThresholdMs: 1000,
      configSilentStallTerminalMs: 60_000, // overrides env
    })
    h.advance(500)
    h.unmarkHistorical()
    h.advance(2_000) // stall fires
    expect(h.stallCalls).toHaveLength(1)

    // 10s past stall — env would have synthesised (5s) but config
    // override pins it at 60s.
    h.advance(10_000)
    expect(h.stallTerminalCalls).toHaveLength(0)

    // Cross 60s — synth fires.
    h.advance(55_000)
    expect(h.stallTerminalCalls).toHaveLength(1)
  })

  it('invalid env value falls through to default (does not disable)', () => {
    // Both negative and NaN should be ignored — not coerced to "disable
    // stall detection" or "fire immediately".
    process.env.SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS = '-1'
    const h1 = makeHarness({ configStallThresholdMs: 1000 })
    h1.advance(500)
    h1.unmarkHistorical()
    h1.advance(2_000) // stall fires
    expect(h1.stallCalls).toHaveLength(1)
    // Default is 300_000 — synth must NOT fire after a small advance.
    h1.advance(60_000)
    expect(h1.stallTerminalCalls).toHaveLength(0)
  })

  it('NaN env value falls through to default', () => {
    process.env.SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS = 'not-a-number'
    const h = makeHarness({ configStallThresholdMs: 1000 })
    h.advance(500)
    h.unmarkHistorical()
    h.advance(2_000)
    h.advance(60_000)
    expect(h.stallTerminalCalls).toHaveLength(0)
  })

  it('a Bash-in-flight worker skips the tight stall threshold, DEFERS terminal synthesis while the tool call is in flight, and still releases at the in-flight cap', () => {
    // Design reconciliation (incident 2026-07-10 vs the #2777/#2782
    // contract this test used to encode): a worker mid-`Bash` whose
    // transcript ends in a tool_use with no matching tool_result is NOT
    // silent — it's inside a legal long tool call — so the pass-2 terminal
    // synthesis must NOT fire at silentStallTerminalMs (the old contract;
    // it finalised a live worker's card). But the completion-gate release
    // from #2777/#2782 is still load-bearing for a worker that DIED
    // mid-tool, so the deferral is CAPPED at inflightTerminalCapMs of
    // total idle: deferred while in flight, released at the cap.
    const h = makeHarness({
      agentId: 'env-thresh-bash',
      configStallThresholdMs: 1000, // tight active-loop threshold
      configSilentSynthStallThresholdMs: 10_000, // widened long-runner window
      configSilentStallTerminalMs: 5000, // compressed terminal window
      configInflightTerminalCapMs: 60_000, // compressed died-mid-tool cap
      initialContent: buildJSONL(
        subAgentUserMsg('bg task'),
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-B', name: 'Bash', input: { command: 'npm test' } }] } },
      ),
    })
    h.advance(500) // register + tail → toolCount=1, lastTool=Bash, tool-B in flight
    h.unmarkHistorical()

    // 5s idle — well past the 1s active-loop threshold, but a Bash worker uses
    // the 10s silent-synthesis window, so NO false stall.
    h.advance(5_000)
    expect(h.stallCalls).toHaveLength(0)

    // Cross the 10s window → the stall IS flagged (pass-2 becomes reachable).
    h.advance(6_000)
    expect(h.stallCalls).toHaveLength(1)
    expect(h.stallTerminalCalls).toHaveLength(0)

    // 5s+ post-stall — the OLD contract synthesised here. The in-flight
    // Bash (no tool_result yet) now defers it: a live long-runner must not
    // have its card finalised under it.
    h.advance(6_000) // ~17.5s total idle, < 60s cap
    expect(h.stallTerminalCalls).toHaveLength(0)
    expect(h.finishCalls).toHaveLength(0)

    // Cross the in-flight cap (total idle ≥ 60s, tool_result still missing)
    // → died-mid-tool: synthesis proceeds and the completion gate releases.
    // The #2777/#2782 release guarantee survives, just later.
    h.advance(50_000)
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.finishCalls).toHaveLength(1)
  })

  it('zero env value falls through to default (zero is not "fire immediately")', () => {
    process.env.SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS = '0'
    const h = makeHarness({ configStallThresholdMs: 1000 })
    h.advance(500)
    h.unmarkHistorical()
    h.advance(2_000)
    h.advance(60_000)
    expect(h.stallTerminalCalls).toHaveLength(0)
  })
})
