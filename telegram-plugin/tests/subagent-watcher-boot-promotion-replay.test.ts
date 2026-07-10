/**
 * Boot-promotion / onProgress gate-ordering regression (unified progress
 * cards — the frozen-"starting…" contributor in registerAgent).
 *
 * Pre-fix sequence for a worker file that is IN-FLIGHT at boot:
 *   1. registerAgent creates the entry with `historical = true`,
 *   2. the initial readSubTail runs — every onProgress cue is suppressed by
 *      the `!entry.historical` guard — and leaves the cursor at EOF,
 *   3. THEN the promotion block flips `historical = false`.
 * Result: the promoted live worker's existing activity never fires
 * onProgress, so its card (painted later by the heartbeat) shows a bare
 * "starting…" stub, and for a quiet worker no later tick ever repairs it.
 *
 * The fix re-reads the tail from byte 0 AFTER promotion (resetting
 * toolCount/lastTool so nothing double-counts), so the replayed events both
 * rebuild the entry and fire onProgress. This test pins that.
 */

import { describe, it, expect, vi } from 'vitest'
import { startSubagentWatcher } from '../subagent-watcher.js'
import * as fs from 'fs'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

describe('boot promotion — in-flight worker replays its activity through onProgress', () => {
  it('fires onProgress for pre-existing tool activity after promotion (not suppressed)', () => {
    const agentId = 'inflight-at-boot-01'
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/mock-cwd`
    const sessionDir = `${projectDir}/sess`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

    let currentTime = 100_000
    // The file EXISTS AT BOOT with real in-flight activity: a prompt and two
    // tool steps, still running (no turn_end). mtime is fresh (30s ago) so
    // the freshness gate makes it ELIGIBLE — but fix #5 also requires actual
    // post-boot growth before promoting (mtime freshness alone can't
    // distinguish this from a worker killed moments before the restart).
    // `content` grows below via the captured fs.watch callback to supply
    // that confirmation.
    let content = Buffer.from(buildJSONL(
      { type: 'user', message: { content: [{ type: 'text', text: 'long research task' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
    ), 'utf-8')

    let lastOpened: string | null = null
    let watchCb: (() => void) | null = null
    const mockFs = {
      existsSync: ((p: fs.PathLike) => {
        const ps = String(p)
        return ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir || ps === jsonlPath
      }) as typeof fs.existsSync,
      readdirSync: ((p: fs.PathLike) => {
        const ps = String(p)
        if (ps === projectsRoot) return ['mock-cwd']
        if (ps === projectDir) return ['sess']
        if (ps === sessionDir) return ['subagents']
        if (ps === subagentsDir) return [`agent-${agentId}.jsonl`]
        return []
      }) as unknown as typeof fs.readdirSync,
      statSync: (() => ({ size: content.length, mtimeMs: currentTime - 30_000 }) as fs.Stats) as typeof fs.statSync,
      openSync: ((p: fs.PathLike) => { lastOpened = String(p); return 7 }) as unknown as typeof fs.openSync,
      closeSync: (() => { lastOpened = null }) as typeof fs.closeSync,
      readSync: ((
        _fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
      ): number => {
        if (lastOpened !== jsonlPath) return 0
        const src = content.slice(position ?? 0, (position ?? 0) + length)
        src.copy(buf as Buffer, offset)
        return src.length
      }) as unknown as typeof fs.readSync,
      watch: ((_p: fs.PathLike, cb?: () => void) => {
        watchCb = cb ?? null
        return { close: vi.fn() } as unknown as fs.FSWatcher
      }) as unknown as typeof fs.watch,
    }

    const progressCalls: Array<{ agentId: string; progressLine?: string; toolCount: number }> = []
    const watcher = startSubagentWatcher({
      agentDir,
      fs: mockFs,
      now: () => currentTime,
      setInterval: () => ({ ref: 0 }),
      clearInterval: () => {},
      setTimeout: () => ({ ref: 0 }),
      clearTimeout: () => {},
      onProgress: ({ agentId: id, progressLine, toolCount }) => {
        progressCalls.push({ agentId: id, progressLine, toolCount })
      },
    })

    // Fix #5: registration alone (mtime-fresh, no observed growth yet) must
    // NOT promote — it stays historical/pending until growth confirms it.
    const preGrowthEntry = watcher.getRegistry().get(agentId)
    expect(preGrowthEntry?.historical).toBe(true)
    expect(preGrowthEntry?.bootPromotionPending).toBeDefined()

    // Simulate the worker taking one more real step post-boot: the JSONL
    // grows, and Claude Code's fs notification fires.
    content = Buffer.concat([content, Buffer.from(buildJSONL(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'still going' }] } },
    ), 'utf-8')])
    currentTime += 1000
    watchCb?.()

    const entry = watcher.getRegistry().get(agentId)
    expect(entry).toBeDefined()
    // Promoted live now that post-boot growth was actually observed.
    expect(entry?.historical).toBe(false)
    expect(entry?.bootPromotionPending).toBeUndefined()
    // Replay rebuilt the entry WITHOUT double-counting the initial read.
    expect(entry?.toolCount).toBe(2)
    expect(entry?.lastTool?.name).toBe('Bash')
    // THE regression pin: the replayed tool steps fired onProgress — pre-fix
    // this was zero (suppressed by the historical gate, cursor left at EOF).
    const mine = progressCalls.filter((c) => c.agentId === agentId)
    expect(mine.length).toBeGreaterThanOrEqual(2)
    expect(mine.some((c) => c.progressLine != null && c.progressLine.length > 0)).toBe(true)

    watcher.stop()
  })

  it('fix #5: a running-at-boot file with fresh mtime but NO post-boot growth is never promoted (avoids a stale completed handback)', () => {
    const agentId = 'inflight-no-growth-01'
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/mock-cwd`
    const sessionDir = `${projectDir}/sess`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

    let currentTime = 100_000
    // Fresh mtime (30s old) but the file NEVER grows again — indistinguishable
    // from a worker that was killed moments before this restart.
    const content = Buffer.from(buildJSONL(
      { type: 'user', message: { content: [{ type: 'text', text: 'task that got killed' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] } },
    ), 'utf-8')

    let lastOpened: string | null = null
    const intervals: Array<{ fn: () => void; ms: number; fireAt: number }> = []
    const mockFs = {
      existsSync: ((p: fs.PathLike) => {
        const ps = String(p)
        return ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir || ps === jsonlPath
      }) as typeof fs.existsSync,
      readdirSync: ((p: fs.PathLike) => {
        const ps = String(p)
        if (ps === projectsRoot) return ['mock-cwd']
        if (ps === projectDir) return ['sess']
        if (ps === sessionDir) return ['subagents']
        if (ps === subagentsDir) return [`agent-${agentId}.jsonl`]
        return []
      }) as unknown as typeof fs.readdirSync,
      statSync: (() => ({ size: content.length, mtimeMs: 100_000 - 30_000 }) as fs.Stats) as typeof fs.statSync,
      openSync: ((p: fs.PathLike) => { lastOpened = String(p); return 7 }) as unknown as typeof fs.openSync,
      closeSync: (() => { lastOpened = null }) as typeof fs.closeSync,
      readSync: ((
        _fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
      ): number => {
        if (lastOpened !== jsonlPath) return 0
        const src = content.slice(position ?? 0, (position ?? 0) + length)
        src.copy(buf as Buffer, offset)
        return src.length
      }) as unknown as typeof fs.readSync,
      watch: (() => ({ close: vi.fn() }) as unknown as fs.FSWatcher) as unknown as typeof fs.watch,
    }

    const finishCalls: Array<{ agentId: string; outcome: string }> = []
    const watcher = startSubagentWatcher({
      agentDir,
      fs: mockFs,
      inflightPromoteMaxAgeMs: 60_000, // small bound so the test can cross it
      now: () => currentTime,
      setInterval: (fn, ms) => {
        intervals.push({ fn, ms, fireAt: currentTime + ms })
        return { ref: 0 }
      },
      clearInterval: () => {},
      setTimeout: () => ({ ref: 0 }),
      clearTimeout: () => {},
      onFinish: ({ agentId: id, outcome }) => finishCalls.push({ agentId: id, outcome }),
    })

    const entryAtBoot = watcher.getRegistry().get(agentId)
    expect(entryAtBoot?.historical).toBe(true)
    expect(entryAtBoot?.bootPromotionPending).toBeDefined()

    // Advance well past the promotion window WITHOUT the file ever growing.
    currentTime += 120_000
    for (const iv of intervals) if (iv.fireAt <= currentTime) iv.fn()

    const entry = watcher.getRegistry().get(agentId)
    // Never promoted: still historical, no completed/failed handback ever
    // synthesised from these pre-restart bytes.
    expect(entry?.historical).toBe(true)
    expect(entry?.bootPromotionPending).toBeUndefined() // gave up after the deadline
    expect(finishCalls).toHaveLength(0)

    watcher.stop()
  })

  it('a STALE running-at-boot file stays historical and fires no onProgress (no replay spam)', () => {
    const agentId = 'stale-at-boot-01'
    const agentDir = '/home/user/.switchroom/agents/myagent'
    const projectsRoot = `${agentDir}/.claude/projects`
    const projectDir = `${projectsRoot}/mock-cwd`
    const sessionDir = `${projectDir}/sess`
    const subagentsDir = `${sessionDir}/subagents`
    const jsonlPath = `${subagentsDir}/agent-${agentId}.jsonl`

    const currentTime = 100_000_000
    const content = Buffer.from(buildJSONL(
      { type: 'user', message: { content: [{ type: 'text', text: 'dead prior-session task' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } },
    ), 'utf-8')

    let lastOpened: string | null = null
    const mockFs = {
      existsSync: ((p: fs.PathLike) => {
        const ps = String(p)
        return ps === projectsRoot || ps === projectDir || ps === sessionDir || ps === subagentsDir || ps === jsonlPath
      }) as typeof fs.existsSync,
      readdirSync: ((p: fs.PathLike) => {
        const ps = String(p)
        if (ps === projectsRoot) return ['mock-cwd']
        if (ps === projectDir) return ['sess']
        if (ps === sessionDir) return ['subagents']
        if (ps === subagentsDir) return [`agent-${agentId}.jsonl`]
        return []
      }) as unknown as typeof fs.readdirSync,
      // Last write DAYS ago — far past the 15-min freshness window.
      statSync: (() => ({ size: content.length, mtimeMs: currentTime - 3 * 24 * 3600_000 }) as fs.Stats) as typeof fs.statSync,
      openSync: ((p: fs.PathLike) => { lastOpened = String(p); return 7 }) as unknown as typeof fs.openSync,
      closeSync: (() => { lastOpened = null }) as typeof fs.closeSync,
      readSync: ((
        _fd: number, buf: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null,
      ): number => {
        if (lastOpened !== jsonlPath) return 0
        const src = content.slice(position ?? 0, (position ?? 0) + length)
        src.copy(buf as Buffer, offset)
        return src.length
      }) as unknown as typeof fs.readSync,
      watch: (() => ({ close: vi.fn() }) as unknown as fs.FSWatcher) as unknown as typeof fs.watch,
    }

    const progressCalls: string[] = []
    const watcher = startSubagentWatcher({
      agentDir,
      fs: mockFs,
      now: () => currentTime,
      setInterval: () => ({ ref: 0 }),
      clearInterval: () => {},
      setTimeout: () => ({ ref: 0 }),
      clearTimeout: () => {},
      onProgress: ({ agentId: id }) => { progressCalls.push(id) },
    })

    const entry = watcher.getRegistry().get(agentId)
    expect(entry?.historical).toBe(true)
    expect(progressCalls.filter((id) => id === agentId)).toHaveLength(0)

    watcher.stop()
  })
})
