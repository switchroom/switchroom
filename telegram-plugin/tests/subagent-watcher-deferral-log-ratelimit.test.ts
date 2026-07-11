/**
 * #3092 — the "silent-stall terminal synthesis deferred" line must not be
 * re-emitted on every rescan tick.
 *
 * `checkStalls()` runs on the ~1s rescan interval and re-evaluates the
 * in-flight deferral every time. The DECISION is correct (a worker inside a
 * long `Bash` is alive, not dead, and must not have its card finalised) — but
 * before this gate the decision was also RE-LOGGED every tick. Observed on the
 * live overlord gateway 2026-07-11: 1,547 near-identical lines in ~35 minutes
 * for a single worker id, differing only in the idle-seconds counter, while
 * the gateway was concurrently hitting real Telegram 429 flood bans (#3084)
 * whose lines were buried in the spam.
 *
 * Contract asserted here:
 *   - first entry into the deferred state logs immediately (diagnosability),
 *   - subsequent ticks are rate-limited to 1 line / `deferralLogIntervalMs`,
 *   - the cap-crossing STATE CHANGE (deferral → terminal synthesis) always
 *     logs,
 *   - the resume STATE CHANGE (worker resurrects) always logs,
 *   - the emitted lines still carry worker id / in-flight count / idle / cap.
 *
 * Deterministic fake clock + injected setInterval — no real timers.
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
/** An assistant tool_use with no matching tool_result → the tool call is IN FLIGHT. */
function bashToolUse(id: string) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } }
}
/** The matching tool_result — drains the in-flight set and resurrects the worker. */
function bashToolResult(id: string) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }
}

const DEFERRED_RE = /silent-stall terminal synthesis deferred/
const CAP_RE = /in-flight deferral cap reached/
const RESOLVED_RE = /in-flight deferral resolved/

function makeHarness(opts: {
  agentId?: string
  deferralLogIntervalMs?: number
  inflightTerminalCapMs?: number
} = {}) {
  const {
    agentId = 'a732f61196738da7d', // the real (synthetic-safe) worker id shape from the incident
    deferralLogIntervalMs,
    inflightTerminalCapMs = 2_700_000, // 45 min — the cap in the incident log
  } = opts

  let currentTime = 1000
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
    Buffer.from(buildJSONL(subAgentUserMsg('bg task'), bashToolUse('tool-B')), 'utf-8'),
  )

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
    // Tight windows so the deferral is reachable in a handful of ticks; the
    // rate-limit under test is orthogonal to how we got into the state.
    stallThresholdMs: 1000,
    silentSynthesisStallThresholdMs: 5000,
    silentStallTerminalMs: 5000,
    inflightTerminalCapMs,
    deferralLogIntervalMs,
    rescanMs: 1000, // the production 1Hz tick — the cadence that produced the spam
    log: (line) => logs.push(line),
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

  /**
   * Drive N discrete 1s ticks with the clock advancing between each — the
   * faithful simulation of the production loop. (A single advance(N*1000)
   * would fire N callbacks all observing the SAME `now`, which would mask a
   * time-based gate.)
   */
  const tick = (n: number): void => { for (let i = 0; i < n; i++) advance(1000) }

  const unmarkHistorical = (): void => {
    const e = watcher.getRegistry().get(agentId)
    if (e) e.historical = false
  }

  /** Land the matching tool_result — the worker resurrects. */
  const resumeWorker = (): void => {
    fileContents.set(
      jsonlPath,
      Buffer.from(
        buildJSONL(subAgentUserMsg('bg task'), bashToolUse('tool-B'), bashToolResult('tool-B')),
        'utf-8',
      ),
    )
  }

  /**
   * The resumed worker starts a NEW long tool call (no tool_result) — it goes
   * quiet again with something in flight, so the deferral path is re-entered.
   */
  const startNewToolCall = (): void => {
    fileContents.set(
      jsonlPath,
      Buffer.from(
        buildJSONL(
          subAgentUserMsg('bg task'),
          bashToolUse('tool-B'),
          bashToolResult('tool-B'),
          bashToolUse('tool-C'),
        ),
        'utf-8',
      ),
    )
  }

  return { logs, advance, tick, unmarkHistorical, resumeWorker, startNewToolCall, agentId }
}

describe('subagent-watcher: deferral log rate-limit (#3092)', () => {
  it('logs the deferral ONCE on entry, then at most once per interval — not once per 1Hz tick', () => {
    const h = makeHarness({ deferralLogIntervalMs: 60_000 })
    h.advance(500)
    h.unmarkHistorical()

    // Get into the deferred state: cross the long-runner stall window, then
    // the post-stall terminal window, with `tool-B` still in flight.
    h.tick(12)
    const afterEntry = h.logs.filter((l) => DEFERRED_RE.test(l))
    expect(afterEntry.length).toBe(1) // first entry IS logged — diagnosability preserved

    // The line must still carry the full diagnostic payload.
    expect(afterEntry[0]).toContain(h.agentId)
    expect(afterEntry[0]).toContain('1 tool call(s) still in flight')
    expect(afterEntry[0]).toMatch(/\d+s idle < 2700s cap/)

    // Now 600 more 1Hz ticks = 10 minutes of a persistently-stalled worker.
    // Pre-fix this emitted ~600 lines. With a 60s interval it may emit at
    // most ~10 more.
    h.tick(600)
    const deferred = h.logs.filter((l) => DEFERRED_RE.test(l))
    expect(deferred.length).toBeLessThanOrEqual(11) // 1 entry + ≤10 periodic
    expect(deferred.length).toBeGreaterThanOrEqual(2) // still periodically visible
    // The regression this guards: NOT one line per tick.
    expect(deferred.length).toBeLessThan(50)
  })

  it('reproduces the incident scale: ~35min at 1Hz emits a handful of lines, not ~1500', () => {
    // The real evidence: 1,547 lines in ~35 minutes for one worker id.
    const h = makeHarness({ deferralLogIntervalMs: 60_000 })
    h.advance(500)
    h.unmarkHistorical()
    h.tick(2100) // 35 minutes of 1Hz ticks

    const deferred = h.logs.filter((l) => DEFERRED_RE.test(l))
    // 35 min / 60s ≈ 35 periodic lines + the entry line. Wildly below 1,547.
    expect(deferred.length).toBeLessThanOrEqual(40)
    // Every emitted line still names the worker and its in-flight count.
    for (const line of deferred) {
      expect(line).toContain(h.agentId)
      expect(line).toContain('tool call(s) still in flight')
    }
  })

  it('STATE CHANGE — a resurrecting worker always logs, even mid-suppression', () => {
    const h = makeHarness({ deferralLogIntervalMs: 60_000 })
    h.advance(500)
    h.unmarkHistorical()
    h.tick(12) // enter the deferred state (1 line)
    expect(h.logs.filter((l) => DEFERRED_RE.test(l)).length).toBe(1)

    h.tick(20) // 20 suppressed ticks — well inside the 60s window
    expect(h.logs.filter((l) => DEFERRED_RE.test(l)).length).toBe(1)

    // The worker resurrects (the incident worker did exactly this).
    h.resumeWorker()
    h.tick(2)

    const resolved = h.logs.filter((l) => RESOLVED_RE.test(l))
    expect(resolved.length).toBe(1) // the transition is NOT suppressed
    expect(resolved[0]).toContain(h.agentId)
    expect(resolved[0]).toContain('deferral was correct')
    // The suppressed volume is accounted for, not silently dropped.
    expect(resolved[0]).toMatch(/\d+ deferral tick\(s\) suppressed/)
    expect(h.logs.some((l) => /stall cleared/.test(l))).toBe(true)
  })

  it('STATE CHANGE — crossing the cap always logs the terminal synthesis', () => {
    // Compressed cap so the crossing is reachable in a bounded tick count.
    const h = makeHarness({ deferralLogIntervalMs: 60_000, inflightTerminalCapMs: 120_000 })
    h.advance(500)
    h.unmarkHistorical()
    h.tick(12)
    expect(h.logs.filter((l) => DEFERRED_RE.test(l)).length).toBe(1)

    h.tick(130) // cross the 120s cap
    const cap = h.logs.filter((l) => CAP_RE.test(l))
    expect(cap.length).toBe(1) // the cap-crossing is NOT suppressed
    expect(cap[0]).toContain(h.agentId)
    expect(cap[0]).toContain('proceeding with terminal synthesis')
    expect(cap[0]).toMatch(/\d+ deferral tick\(s\) suppressed/)

    // And the deferral lines over that whole window stayed bounded.
    expect(h.logs.filter((l) => DEFERRED_RE.test(l)).length).toBeLessThanOrEqual(4)
  })

  it('a re-stall after a resume logs its first deferral again (gate re-arms)', () => {
    const h = makeHarness({ deferralLogIntervalMs: 60_000 })
    h.advance(500)
    h.unmarkHistorical()
    h.tick(12)
    expect(h.logs.filter((l) => DEFERRED_RE.test(l)).length).toBe(1)

    h.resumeWorker()
    h.tick(2)
    expect(h.logs.filter((l) => RESOLVED_RE.test(l)).length).toBe(1)

    // The resumed worker goes quiet again inside a NEW tool call. Its first
    // deferral must log immediately rather than being swallowed by the
    // still-open 60s window from the previous stall episode.
    h.startNewToolCall()
    h.tick(14)
    expect(h.logs.filter((l) => DEFERRED_RE.test(l)).length).toBe(2)
  })

  it('env override SWITCHROOM_SUBAGENT_DEFERRAL_LOG_INTERVAL_MS is honored', () => {
    const saved = process.env.SWITCHROOM_SUBAGENT_DEFERRAL_LOG_INTERVAL_MS
    process.env.SWITCHROOM_SUBAGENT_DEFERRAL_LOG_INTERVAL_MS = '10000'
    try {
      const h = makeHarness() // no config arg → env wins
      h.advance(500)
      h.unmarkHistorical()
      h.tick(12)
      expect(h.logs.filter((l) => DEFERRED_RE.test(l)).length).toBe(1)

      // 60 ticks at a 10s interval → ~6 more lines, not 60.
      h.tick(60)
      const deferred = h.logs.filter((l) => DEFERRED_RE.test(l)).length
      expect(deferred).toBeGreaterThanOrEqual(5)
      expect(deferred).toBeLessThanOrEqual(9)
    } finally {
      if (saved === undefined) delete process.env.SWITCHROOM_SUBAGENT_DEFERRAL_LOG_INTERVAL_MS
      else process.env.SWITCHROOM_SUBAGENT_DEFERRAL_LOG_INTERVAL_MS = saved
    }
  })
})
