/**
 * Tests for the two background-worker handback gaps closed in
 * `fix/subagent-handback-restart-and-failure`:
 *
 *  Gap 1 — restart survival. A background worker that is in-flight when
 *    the gateway restarts is discovered by the boot scan and tagged
 *    `historical`. That flag is meant to suppress replay for workers that
 *    ALREADY finished before boot — but it was also applied to workers
 *    still running, which then completed with outcome `orphan`, and the
 *    handback gate drops `orphan`. Net: dispatched worker + any gateway
 *    bounce (incl. a fleet rollout) + worker finishes = user never told.
 *    Fix: a file still `running` at boot is promoted to a LIVE entry, so
 *    it gets the stall-synthesis safety net and a real `completed`/`failed`
 *    handback. A file already `done` at boot stays suppressed.
 *
 *  Gap 2 — failure honesty. The `failed` outcome was dead code (no caller
 *    set it), so every dead worker was reported `completed`. Fix: a
 *    TERMINAL error line in the worker's own transcript (model API failure
 *    / quota exhaustion / crash — not an in-flight retry, not a routine
 *    tool-level is_error) flips the terminal outcome to `failed` and
 *    carries the error detail into the handback result.
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
function subAgentText(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}
function subAgentTurnEnd() {
  return { type: 'system', subtype: 'turn_duration', duration_ms: 1234 }
}
// A terminal error line in the worker's OWN transcript — the model call
// itself failed (here an invalid_request_error). `detectErrorInTranscriptLine`
// classifies an explicit `type:"error"` line with a non-rate-limit kind as
// terminal:true.
function subAgentTerminalError(message: string) {
  return { type: 'error', error: { type: 'invalid_request_error', message } }
}
// A routine mid-run tool failure (e.g. a grep that found nothing). This is a
// `sub_agent_tool_result` with is_error — NOT a worker death. Must NOT trip
// the failed classification.
function subAgentToolResultError() {
  return {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: 'no matches found' }],
    },
  }
}

interface FinishCall {
  agentId: string
  outcome: string
  resultText: string
}

interface Harness {
  stallTerminalCalls: Array<{ agentId: string }>
  finishCalls: FinishCall[]
  logs: string[]
  advance: (ms: number) => void
  watcher: ReturnType<typeof startSubagentWatcher>
  fileContents: Map<string, Buffer>
  jsonlPath: string
  append: (...lines: object[]) => void
}

function makeHarness(opts: {
  agentId?: string
  /** Lines present in the JSONL at boot (before the watcher starts). */
  bootLines: object[]
  stallThresholdMs?: number
  silentStallTerminalMs?: number
  rescanMs?: number
}): Harness {
  const {
    agentId = 'gap-agent',
    bootLines,
    stallThresholdMs = 60_000,
    silentStallTerminalMs = 300_000,
    rescanMs = 500,
  } = opts

  let currentTime = 1000
  const stallTerminalCalls: Array<{ agentId: string }> = []
  const finishCalls: FinishCall[] = []
  const logs: string[] = []

  const agentDir = '/home/user/.switchroom/agents/myagent'
  const sessionId = 'mock-session'
  const projectsRoot = `${agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/${sessionId}`
  const subagentsDir = `${sessionDir}/subagents`
  const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

  const fileContents = new Map<string, Buffer>()
  fileContents.set(jsonlPath, Buffer.from(buildJSONL(...bootLines), 'utf-8'))

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
    statSync: ((p: fs.PathLike) => ({ size: fileContents.get(String(p))?.length ?? 0 }) as fs.Stats) as typeof fs.statSync,
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
  let nextRef = 1

  const watcher = startSubagentWatcher({
    agentDir,
    stallThresholdMs,
    silentSynthesisStallThresholdMs: stallThresholdMs,
    silentStallTerminalMs,
    rescanMs,
    onStallTerminal: (id) => stallTerminalCalls.push({ agentId: id }),
    onFinish: ({ agentId: id, outcome, resultText }) =>
      finishCalls.push({ agentId: id, outcome, resultText }),
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
    fs: mockFs,
    log: (msg) => logs.push(msg),
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

  const append = (...lines: object[]): void => {
    const cur = fileContents.get(jsonlPath) ?? Buffer.alloc(0)
    const more = buildJSONL(...lines)
    fileContents.set(jsonlPath, Buffer.concat([cur, Buffer.from(more, 'utf-8')]))
  }

  return { stallTerminalCalls, finishCalls, logs, advance, watcher, fileContents, jsonlPath, append }
}

describe('Gap 1 — background worker in-flight across a gateway restart', () => {
  it('an in-flight-at-boot worker that completes hands back as completed (not orphan)', () => {
    // Boot scan finds a running worker (prompt, no turn_end yet) → tagged
    // historical. The fix promotes it to live. When it finishes under our
    // watch, the outcome must be `completed` so the handback delivers.
    const h = makeHarness({ agentId: 'gap1-complete', bootLines: [subAgentUserMsg('bg task')] })

    // The worker finishes after the restart.
    h.append(subAgentText('Found the root cause in auth.ts'), subAgentTurnEnd())
    h.advance(600) // one poll reads the new bytes

    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].agentId).toBe('gap1-complete')
    expect(h.finishCalls[0].outcome).toBe('completed') // pre-fix: 'orphan' → dropped
    expect(h.finishCalls[0].resultText).toContain('root cause')
    // The promotion is logged so the path is observable in prod.
    expect(h.logs.some((l) => l.includes('in-flight at boot — promoting to live'))).toBe(true)
  })

  it('an in-flight-at-boot worker that dies silently is rescued by stall synthesis', () => {
    // Pre-fix, historical entries were skipped by stall detection, so a
    // worker that crossed a restart and then went silent sat running
    // forever — no handback ever. After promotion it gets the safety net.
    const h = makeHarness({
      agentId: 'gap1-silent',
      bootLines: [subAgentUserMsg('bg task')],
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 120_000,
    })

    h.advance(62_000) // stall threshold crossed
    expect(h.stallTerminalCalls).toHaveLength(0)
    h.advance(121_000) // silent-stall terminal window elapses → synthesis
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].outcome).toBe('completed')
  })

  it('a worker already DONE at boot stays suppressed (no spurious replay)', () => {
    // The legitimate use of `historical`: a worker that finished in a prior
    // session must NOT re-fire a handback on every restart. This is the
    // regression guard for the fix.
    const h = makeHarness({
      agentId: 'gap1-stale',
      bootLines: [subAgentUserMsg('bg task'), subAgentText('done long ago'), subAgentTurnEnd()],
    })

    h.advance(600)
    h.advance(600_000) // well past any stall window
    expect(h.finishCalls).toHaveLength(0)
    expect(h.stallTerminalCalls).toHaveLength(0)
  })
})

describe('Gap 2 — failure honesty', () => {
  it('a terminal error line flips the outcome to failed and carries the detail', () => {
    const h = makeHarness({ agentId: 'gap2-failed', bootLines: [subAgentUserMsg('bg task')] })

    // The worker's model call errors out, then the transcript ends.
    h.append(subAgentTerminalError('tool input rejected by the API'), subAgentTurnEnd())
    h.advance(600)

    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].outcome).toBe('failed')
    // No narrative was emitted, so the detail backfills the result slot.
    expect(h.finishCalls[0].resultText).toContain('tool input rejected')
  })

  it('a failed worker that went silent still synthesises terminal as failed', () => {
    const h = makeHarness({
      agentId: 'gap2-failed-silent',
      bootLines: [subAgentUserMsg('bg task')],
      stallThresholdMs: 60_000,
      silentStallTerminalMs: 120_000,
    })

    // Error line, then the worker goes silent (no turn_end).
    h.append(subAgentTerminalError('worker process crashed'))
    h.advance(600) // read the error line
    h.advance(62_000) // stall
    h.advance(121_000) // synthesis
    expect(h.stallTerminalCalls).toHaveLength(1)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].outcome).toBe('failed')
    expect(h.finishCalls[0].resultText).toContain('crashed')
  })

  it('a routine mid-run tool error does NOT cause a false failure', () => {
    const h = makeHarness({ agentId: 'gap2-toolerr', bootLines: [subAgentUserMsg('bg task')] })

    // A tool_result with is_error (e.g. grep found nothing) mid-run, then
    // the worker recovers and completes normally.
    h.append(subAgentToolResultError(), subAgentText('Completed after a retry'), subAgentTurnEnd())
    h.advance(600)

    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].outcome).toBe('completed') // NOT failed
    expect(h.finishCalls[0].resultText).toContain('Completed after a retry')
  })
})
