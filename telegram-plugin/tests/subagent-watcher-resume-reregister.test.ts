/**
 * Tests for SubagentWatcher re-registration after a SendMessage resume
 * (issue #3315).
 *
 * A background worker that completes normally (a REAL `sub_agent_turn_end`)
 * is swept out of the registry by `cleanupTerminalAgent`, which records the
 * agent id in `terminatedAgentIds` so a rescan of the still-present JSONL
 * doesn't re-register and re-fire a duplicate handback (issue #1116 Bug B).
 *
 * But a SendMessage-resume reuses the SAME `agent-<id>.jsonl`, appending a
 * NEW turn to it. Pre-fix the `terminatedAgentIds` guard suppressed that file
 * forever regardless of growth, so the resumed worker was never tracked again:
 * no FSWatcher, no `onProgress`, no progress card — the exact UX failure the
 * card exists to prevent (operator: "I don't see any progress cards, anything
 * happening??").
 *
 * This suite pins BOTH directions of the deterministic size-based mechanism:
 *
 *  (a) terminal cleanup → resume (JSONL grows past the terminal size) ⇒ the
 *      watcher re-registers the agent as a LIVE worker and emits progress
 *      cues again. The re-registration reads only the NEW turn — it does NOT
 *      replay the already-handed-back completed turn (no duplicate onFinish
 *      until the resumed turn genuinely ends).
 *  (b) terminal cleanup with NO resume (JSONL static) ⇒ the agent stays
 *      cleaned up: no re-registration, no duplicate onFinish, no leaked card.
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
function subAgentToolUse(name: string, id: string, input: Record<string, unknown> = {}) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } }
}
function subAgentTurnEnd() {
  return { type: 'system', subtype: 'turn_duration', duration_ms: 1234 }
}

const RESCAN_MS = 500
const CLEANUP_GRACE_MS = 30_000 // TERMINAL_CLEANUP_GRACE_MS in subagent-watcher.ts

interface ProgressCall {
  agentId: string
  skeleton: boolean
  progressLine?: string
  toolCount: number
}

function makeHarness(opts: { agentId?: string } = {}) {
  const { agentId = 'resume-agent' } = opts

  let currentTime = 1000
  const progressCalls: ProgressCall[] = []
  const finishCalls: Array<{ agentId: string; outcome: string }> = []
  const terminalCleanupCalls: string[] = []
  const logs: string[] = []

  const agentDir = '/home/user/.switchroom/agents/myagent'
  const sessionId = 'mock-session'
  const projectsRoot = `${agentDir}/.claude/projects`
  const projectDir = `${projectsRoot}/mock-cwd`
  const sessionDir = `${projectDir}/${sessionId}`
  const subagentsDir = `${sessionDir}/subagents`
  const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

  // The agent JSONL is NOT present at construction, so the boot scan registers
  // nothing and the file — when it later appears — registers post-boot as a
  // LIVE (non-historical) worker, exactly like a freshly-dispatched one.
  const fileContents = new Map<string, Buffer>()

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
      if (ps === subagentsDir) {
        // Dynamic: list the agent-*.jsonl files currently present on "disk".
        const names: string[] = []
        for (const key of fileContents.keys()) {
          if (key.startsWith(subagentsDir + '/agent-') && key.endsWith('.jsonl')) {
            names.push(key.slice(subagentsDir.length + 1))
          }
        }
        return names
      }
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
    rescanMs: RESCAN_MS,
    onProgress: ({ agentId: id, skeleton, progressLine, toolCount }) =>
      progressCalls.push({ agentId: id, skeleton: skeleton === true, progressLine, toolCount }),
    onFinish: ({ agentId: id, outcome }) => finishCalls.push({ agentId: id, outcome }),
    onTerminalCleanup: (id) => terminalCleanupCalls.push(id),
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

  const setFile = (content: string): void => {
    fileContents.set(jsonlPath, Buffer.from(content, 'utf-8'))
  }
  const append = (content: string): void => {
    const cur = fileContents.get(jsonlPath) ?? Buffer.alloc(0)
    fileContents.set(jsonlPath, Buffer.concat([cur, Buffer.from(content, 'utf-8')]))
  }

  return {
    agentId,
    progressCalls,
    finishCalls,
    terminalCleanupCalls,
    logs,
    advance,
    watcher,
    setFile,
    append,
  }
}

describe('subagent-watcher resume re-registration (issue #3315)', () => {
  it('(a) re-registers a terminal-then-resumed worker so its progress card resumes', () => {
    const agentId = 'resume-live'
    const h = makeHarness({ agentId })

    // A worker is dispatched post-boot: its JSONL appears with a running turn.
    h.setFile(buildJSONL(subAgentUserMsg('bg task'), subAgentToolUse('Bash', 't1')))
    h.advance(RESCAN_MS) // rescan discovers the file → LIVE registration

    const registered = h.watcher.getRegistry().get(agentId)
    expect(registered).toBeDefined()
    expect(registered!.state).toBe('running')
    expect(registered!.historical).toBe(false)

    // It completes normally with a REAL turn_end.
    h.append(buildJSONL(subAgentTurnEnd()))
    h.advance(RESCAN_MS) // poll reads turn_end → done → onFinish(completed)
    expect(h.finishCalls).toHaveLength(1)
    expect(h.finishCalls[0].outcome).toBe('completed')

    // Grace elapses → the entry is swept out of the registry.
    h.advance(CLEANUP_GRACE_MS)
    expect(h.watcher.getRegistry().has(agentId)).toBe(false)
    expect(h.terminalCleanupCalls).toContain(agentId)

    const progressBeforeResume = h.progressCalls.length

    // SendMessage resume: Claude Code appends a NEW turn to the SAME JSONL.
    h.append(buildJSONL(
      subAgentUserMsg('follow-up question'),
      subAgentToolUse('Read', 't2', { file_path: '/tmp/x' }),
    ))
    h.advance(RESCAN_MS) // rescan sees growth past terminal size → re-register

    // The worker is tracked again — live, running, non-historical.
    const revived = h.watcher.getRegistry().get(agentId)
    expect(revived).toBeDefined()
    expect(revived!.state).toBe('running')
    expect(revived!.historical).toBe(false)
    expect(h.logs.some((l) => l.includes('resumed after terminal cleanup') && l.includes(agentId))).toBe(true)

    // Progress cues resume (the card updates again) — the user-visible fix.
    expect(h.progressCalls.length).toBeGreaterThan(progressBeforeResume)
    expect(h.progressCalls.slice(progressBeforeResume).some((c) => c.agentId === agentId)).toBe(true)

    // The completed turn was NOT replayed — no duplicate onFinish fired on
    // re-registration (the old turn_end sits before the resume cursor).
    expect(h.finishCalls).toHaveLength(1)

    // When the resumed turn genuinely ends, onFinish fires again for the new
    // turn — the resumed work gets its own handback.
    h.append(buildJSONL(subAgentTurnEnd()))
    h.advance(RESCAN_MS)
    expect(h.finishCalls).toHaveLength(2)
    expect(h.finishCalls[1].outcome).toBe('completed')

    h.watcher.stop()
  })

  it('(b) a terminal worker that is NOT resumed stays cleaned up (no re-register, no duplicate handback)', () => {
    const agentId = 'stay-clean'
    const h = makeHarness({ agentId })

    h.setFile(buildJSONL(subAgentUserMsg('bg task'), subAgentToolUse('Bash', 't1')))
    h.advance(RESCAN_MS)
    expect(h.watcher.getRegistry().has(agentId)).toBe(true)

    h.append(buildJSONL(subAgentTurnEnd()))
    h.advance(RESCAN_MS)
    expect(h.finishCalls).toHaveLength(1)

    h.advance(CLEANUP_GRACE_MS) // sweep
    expect(h.watcher.getRegistry().has(agentId)).toBe(false)
    const finishAfterCleanup = h.finishCalls.length
    const progressAfterCleanup = h.progressCalls.length

    // The JSONL stays on disk, static (Claude Code leaves it), and the worker
    // is never resumed. Many rescans must NOT re-register it or re-fire the
    // handback (issue #1116 Bug B guard preserved) — the reverse-bug direction.
    for (let i = 0; i < 20; i++) h.advance(RESCAN_MS)

    expect(h.watcher.getRegistry().has(agentId)).toBe(false)
    expect(h.finishCalls).toHaveLength(finishAfterCleanup) // no duplicate
    expect(h.progressCalls).toHaveLength(progressAfterCleanup) // no card churn
    // Cleanup fired exactly once — no leaked/duplicated terminal sweep.
    expect(h.terminalCleanupCalls.filter((id) => id === agentId)).toHaveLength(1)

    h.watcher.stop()
  })
})
