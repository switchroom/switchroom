/**
 * Fix #9a — `terminatedAgentIds` (the re-discovery dedup guard added on
 * every `cleanupTerminalAgent`, read in `scanSubagentsDir`'s skip-check)
 * grew unboundedly: only ever cleared wholesale in `stop()`. This pins the
 * bound: once the cap is hit, the OLDEST id is evicted on each new insert
 * (Set preserves insertion order), while the dedup guarantee for recently-
 * terminated ids still holds.
 *
 * `terminatedAgentIdsCap` is a config override so the test can exercise
 * eviction with a handful of entries instead of the production cap
 * (a few thousand).
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
  return { type: 'system', subtype: 'turn_duration', duration_ms: 100 }
}

describe('terminatedAgentIds cap (fix #9a)', () => {
  it('evicts the oldest terminated id once the cap is hit, but keeps dedup for recent ids', () => {
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/mock-cwd`
    const sessionDir = `${projectDir}/sess`
    const subagentsDir = `${sessionDir}/subagents`

    // 4 agents, already fully done (turn_end present) at "boot" — each will
    // schedule a terminal cleanup immediately.
    const agentIds = ['agent-a', 'agent-b', 'agent-c', 'agent-d']
    const fileNames = agentIds.map((id) => `agent-${id}.jsonl`)
    const filePaths = new Map(agentIds.map((id) => [id, `${subagentsDir}/agent-${id}.jsonl`]))
    // Files visible to a directory scan — stay present throughout (a real
    // gateway's JSONL files don't disappear on cleanup either; only the
    // in-memory `terminatedAgentIds` dedup guard decides re-registration).
    const visibleFiles = [...fileNames]

    const content = Buffer.from(buildJSONL(subAgentUserMsg('done task'), subAgentTurnEnd()), 'utf-8')

    let lastOpened: string | null = null
    const mockFs = {
      existsSync: ((p: fs.PathLike) => {
        const ps = String(p)
        if (ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir) return true
        return [...filePaths.values()].includes(ps)
      }) as typeof fs.existsSync,
      readdirSync: ((p: fs.PathLike) => {
        const ps = String(p)
        if (ps === projectsRoot) return ['mock-cwd']
        if (ps === projectDir) return ['sess']
        if (ps === sessionDir) return ['subagents']
        if (ps === subagentsDir) return visibleFiles
        return []
      }) as unknown as typeof fs.readdirSync,
      statSync: (() => ({ size: content.length, mtimeMs: 0 }) as fs.Stats) as typeof fs.statSync,
      openSync: ((p: fs.PathLike) => { lastOpened = String(p); return 7 }) as unknown as typeof fs.openSync,
      closeSync: (() => { lastOpened = null }) as typeof fs.closeSync,
      readSync: ((
        _fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
      ): number => {
        if (lastOpened == null) return 0
        const src = content.slice(position ?? 0, (position ?? 0) + length)
        src.copy(buf as Buffer, offset)
        return src.length
      }) as unknown as typeof fs.readSync,
      watch: (() => ({ close: vi.fn() }) as unknown as fs.FSWatcher) as unknown as typeof fs.watch,
    }

    let currentTime = 1_000_000
    const intervals: Array<{ fn: () => void; ms: number; fireAt: number }> = []
    const timeouts: Array<{ fn: () => void; ms: number; fireAt: number; ref: number }> = []
    let nextTimeoutRef = 1

    const advance = (ms: number): void => {
      currentTime += ms
      for (;;) {
        timeouts.sort((a, b) => a.fireAt - b.fireAt)
        const next = timeouts[0]
        if (!next || next.fireAt > currentTime) break
        timeouts.shift()
        next.fn()
      }
      for (const iv of intervals) {
        while (iv.fireAt <= currentTime) {
          iv.fn()
          iv.fireAt += iv.ms
        }
      }
    }

    const watcher = startSubagentWatcher({
      agentDir,
      fs: mockFs,
      terminatedAgentIdsCap: 3,
      now: () => currentTime,
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms, fireAt: currentTime + ms })
        return { ref: 0 }
      },
      clearInterval: () => {},
      setTimeout: (fn, ms) => {
        const ref = nextTimeoutRef++
        timeouts.push({ fn, ms, fireAt: currentTime + ms, ref })
        return { ref }
      },
      clearTimeout: (handle) => {
        const { ref } = handle as { ref: number }
        const idx = timeouts.findIndex((t) => t.ref === ref)
        if (idx !== -1) timeouts.splice(idx, 1)
      },
    })

    // All 4 discovered at boot, already `done` → each schedules a terminal
    // cleanup TERMINAL_CLEANUP_GRACE_MS (30s) out, in discovery order.
    for (const id of agentIds) {
      expect(watcher.getRegistry().has(id)).toBe(true)
    }

    // Fire all 4 scheduled cleanups (in order a, b, c, d). With cap=3, the
    // 4th cleanup (d) evicts the OLDEST tracked id (a) before inserting d.
    // `advance()` also drives the rescan interval (default 1s) forward as
    // part of the same clock jump, so by the time it returns the poll
    // loop has ALSO already rediscovered the just-evicted agent-a (its
    // JSONL file is still on disk throughout — nothing "disappears" for a
    // real gateway either) — that's the observable proof the eviction
    // took effect, not a separate step.
    advance(30_000)

    // agent-a was evicted from `terminatedAgentIds` (cap=3, it was the
    // oldest insert) → the dedup guard no longer suppresses it, so the
    // rescan re-discovered and re-registered it.
    expect(watcher.getRegistry().has('agent-a')).toBe(true)
    // agent-b, agent-c, agent-d are still within the cap window → the
    // dedup guard still suppresses their re-discovery even though their
    // JSONL files are also still sitting on disk.
    expect(watcher.getRegistry().has('agent-b')).toBe(false)
    expect(watcher.getRegistry().has('agent-c')).toBe(false)
    expect(watcher.getRegistry().has('agent-d')).toBe(false)

    watcher.stop()
  })
})
