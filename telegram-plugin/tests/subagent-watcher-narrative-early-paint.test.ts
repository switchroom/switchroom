/**
 * Residual A regression: a worker / sub-agent's OPENING narration must paint
 * EARLY on its card (~the next poll after PENDING_NARRATIVE_FLUSH_MS) WITHOUT
 * waiting for the worker's first tool — the same time-box the main-agent card
 * got in #3227, applied uniformly to the poll-driven worker/sub-agent path via
 * the SHARED NarrativeFlushController kernel driven by the injected poll clock.
 *
 * These assert OUTCOMES on the onProgress cue stream (the worker card is
 * replace-on-write via onProgress), driven by an INJECTED clock so the timing
 * is deterministic:
 *   - a parked opening narration fires a narrative cue after the flush window
 *     with NO tool event (RED if the early-paint tick is removed);
 *   - it fires at more than one entry (depth-generic — the registry is flat, so
 *     every sub-agent/worker/nested sub-worker is a WorkerEntry and the gate is
 *     per-entry);
 *   - the early-painted block is NOT re-fired (no double-print) and does not
 *     leave a stale duplicate when the first real tool step lands after it;
 *   - a tool arriving WITHIN the window still resolves the block exactly once
 *     (no early-paint + resolve double).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSubagentWatcher } from '../subagent-watcher.js'
import { PENDING_NARRATIVE_FLUSH_MS } from '../narrative-flush.js'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}
function subAgentAssistantText(text: string) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}
function subAgentToolUse(name: string, id: string) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: {} }] } }
}

interface Cue { progressLine?: string; latestSummary: string; skeleton?: boolean }

describe('worker/sub-agent opening-narration early paint (Residual A)', () => {
  let tmpRoot = ''
  const started: Array<ReturnType<typeof startSubagentWatcher>> = []

  afterEach(() => {
    while (started.length) {
      try { started.pop()?.stop() } catch { /* ignore */ }
    }
    if (tmpRoot) {
      try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
      tmpRoot = ''
    }
  })

  /** Watcher over a real tmpdir with an INJECTED, manually-advanced clock. */
  function startWatcher(agentDir: string) {
    let currentTime = 100_000
    const cues: Array<{ agentId: string } & Cue> = []
    const intervals: Array<{ fn: () => void; ref: number }> = []
    let nextRef = 1
    const watcher = startSubagentWatcher({
      agentDir,
      onFinish: () => {},
      onProgress: ({ agentId, progressLine, latestSummary, skeleton }) => {
        cues.push({ agentId, progressLine, latestSummary, skeleton })
      },
      stallThresholdMs: 600_000,
      silentSynthesisStallThresholdMs: 600_000,
      rescanMs: 1000,
      now: () => currentTime,
      setInterval: (fn) => { const ref = nextRef++; intervals.push({ fn, ref }); return { ref } },
      clearInterval: (handle) => {
        const { ref } = handle as { ref: number }
        const idx = intervals.findIndex((i) => i.ref === ref)
        if (idx !== -1) intervals.splice(idx, 1)
      },
      setTimeout: () => ({ ref: nextRef++ }),
      clearTimeout: () => {},
      log: () => {},
    })
    started.push(watcher)
    return {
      watcher,
      cues,
      poll: () => intervals[0]?.fn(),
      advance: (ms: number) => { currentTime += ms },
    }
  }

  function narrativeCues(cues: Cue[]): string[] {
    // Narrative cues carry NO progressLine; tool-label cues do. Skeleton
    // liveness cues (#3231) also carry no progressLine but an empty summary —
    // exclude them here so this counts only real narrative content.
    return cues.filter((c) => !c.skeleton && c.progressLine == null).map((c) => c.latestSummary)
  }

  it('paints a parked opening narration after the flush window with NO tool event', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sr-early-paint-'))
    const agentDir = join(tmpRoot, 'agent')
    const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')

    writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))
    const h = startWatcher(agentDir)
    h.poll() // register + promote to live

    // Opening narration arrives; the worker then "thinks" (no tool yet).
    appendFileSync(jsonlPath, buildJSONL(subAgentAssistantText('On it — pulling the logs first.')))
    h.poll() // parks the block, arms the early-paint timer — NO cue yet
    expect(narrativeCues(h.cues), 'parked block must not paint before the window').toHaveLength(0)

    // Advance past the flush window and poll again — STILL no new jsonl event.
    h.advance(PENDING_NARRATIVE_FLUSH_MS + 50)
    h.poll()

    const narr = narrativeCues(h.cues)
    expect(narr, 'opening narration must early-paint without a tool').toHaveLength(1)
    expect(narr[0]).toContain('pulling the logs')
  })

  it('does NOT paint before the flush window elapses', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sr-early-paint-nofire-'))
    const agentDir = join(tmpRoot, 'agent')
    const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')

    writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))
    const h = startWatcher(agentDir)
    h.poll()
    appendFileSync(jsonlPath, buildJSONL(subAgentAssistantText('On it — pulling the logs first.')))
    h.poll()

    // Advance LESS than the window — the tick must not fire yet.
    h.advance(PENDING_NARRATIVE_FLUSH_MS - 50)
    h.poll()
    expect(narrativeCues(h.cues), 'must not paint before the window').toHaveLength(0)
  })

  it('is depth-generic: two independent entries each early-paint their opening narration', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sr-early-paint-depth-'))
    const agentDir = join(tmpRoot, 'agent')
    const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    // Two entries stand in for two nesting levels: the registry is FLAT, so a
    // top worker and a nested depth-2 sub-worker are both plain WorkerEntry
    // rows and take the identical per-entry gate — this proves the mechanism
    // is depth-generic (it operates on the generic node, not a fixed level).
    const aPath = join(subagentsDir, 'agent-aaaa0000.jsonl')
    const bPath = join(subagentsDir, 'agent-bbbb1111.jsonl')
    writeFileSync(aPath, buildJSONL(subAgentUserMsg('Level 1 task')))
    writeFileSync(bPath, buildJSONL(subAgentUserMsg('Level 2 task')))
    const h = startWatcher(agentDir)
    h.poll()
    appendFileSync(aPath, buildJSONL(subAgentAssistantText('Worker A: reading the config.')))
    appendFileSync(bPath, buildJSONL(subAgentAssistantText('Worker B: cloning the repo.')))
    h.poll()
    expect(narrativeCues(h.cues)).toHaveLength(0)

    h.advance(PENDING_NARRATIVE_FLUSH_MS + 50)
    h.poll()

    const aCues = h.cues.filter((c) => c.agentId === 'aaaa0000' && c.progressLine == null)
    const bCues = h.cues.filter((c) => c.agentId === 'bbbb1111' && c.progressLine == null)
    expect(aCues.map((c) => c.latestSummary).join(' ')).toContain('reading the config')
    expect(bCues.map((c) => c.latestSummary).join(' ')).toContain('cloning the repo')
  })

  it('does not double-print: an early-painted block is not re-shown when the first real tool lands', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sr-early-paint-nodup-'))
    const agentDir = join(tmpRoot, 'agent')
    const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')
    writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))
    const h = startWatcher(agentDir)
    h.poll()
    appendFileSync(jsonlPath, buildJSONL(subAgentAssistantText('On it — pulling the logs first.')))
    h.poll()
    h.advance(PENDING_NARRATIVE_FLUSH_MS + 50)
    h.poll() // early-paint fires (1 narrative cue)
    expect(narrativeCues(h.cues)).toHaveLength(1)

    // Now the worker's first real tool lands. The parked block was already
    // consumed by the timer → it must NOT re-fire as a narrative cue, and the
    // tool-label cue is a SEPARATE step (no stale duplicate narration).
    appendFileSync(jsonlPath, buildJSONL(subAgentToolUse('Bash', 'b1')))
    h.advance(10)
    h.poll()

    expect(narrativeCues(h.cues), 'narration must not be re-shown').toHaveLength(1)
    const toolCues = h.cues.filter((c) => c.progressLine != null)
    expect(toolCues.length, 'the tool step fires as its own cue').toBeGreaterThanOrEqual(1)
  })

  it('a tool arriving WITHIN the window resolves the block exactly once (no early-paint + resolve double)', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sr-early-paint-within-'))
    const agentDir = join(tmpRoot, 'agent')
    const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    const jsonlPath = join(subagentsDir, 'agent-deadbeef.jsonl')
    writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))
    const h = startWatcher(agentDir)
    h.poll()
    appendFileSync(jsonlPath, buildJSONL(subAgentAssistantText('On it — let me find the repo.')))
    h.poll()
    // Tool lands well within the window → resolve shows it once; timer never fires.
    h.advance(50)
    appendFileSync(jsonlPath, buildJSONL(subAgentToolUse('Bash', 'b1')))
    h.poll()
    // Advance past the window: the (already-consumed) block must not re-paint.
    h.advance(PENDING_NARRATIVE_FLUSH_MS + 50)
    h.poll()
    expect(narrativeCues(h.cues), 'resolved narration shows exactly once').toHaveLength(1)
  })
})
