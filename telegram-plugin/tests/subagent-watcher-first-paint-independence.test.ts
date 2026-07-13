/**
 * First-paint independence (#3231) regression.
 *
 * LIVE BUG (a57fbf, 2026-07-13): an async foreground sub-agent registered at
 * 13:17:27, did two Bash calls, then its first tool BLOCKED for ~99s (no JSONL
 * growth). Its spawning turn ended at 13:17:48 while it kept running, so there
 * was neither a live parent turn to nest into NOR a worker-feed row to paint —
 * and because the worker card is driven ONLY by growth-triggered onProgress
 * cues, NOTHING surfaced. The card did not appear until 13:20:52, 205s after
 * registration, on the next growth event that happened to route to the feed.
 *
 * The watcher's contract fix: a running, non-historical entry must emit a
 * growth-INDEPENDENT skeleton liveness cue on every no-growth poll — an empty
 * step line carrying the entry's real current state — so the gateway can paint
 * (and keep alive) the card from registration onward, regardless of whether the
 * worker's JSONL is currently growing. The gateway routes it: inert on the
 * foreground-nest path (empty child), row-creating on the orphan/background
 * worker-feed path.
 *
 * These assert OUTCOMES on the onProgress cue stream with an INJECTED clock.
 * A skeleton cue is identified by its explicit `skeleton: true` discriminator
 * (it also carries an empty `latestSummary` and no `progressLine`).
 *
 * RED-ON-REGRESSION: before the fix, readSubTail early-returns on a no-growth
 * poll BEFORE firing any onProgress cue, so ZERO skeleton cues are emitted and
 * every assertion below fails — reproducing the invisible-card window.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSubagentWatcher } from '../subagent-watcher.js'

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}
function subAgentUserMsg(promptText: string) {
  return { type: 'user', message: { content: [{ type: 'text', text: promptText }] } }
}
function subAgentToolUse(name: string, id: string) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: {} }] } }
}

interface Cue { agentId: string; progressLine?: string; latestSummary: string; elapsedMs: number; skeleton?: boolean }

describe('sub-agent card first-paint independence (#3231)', () => {
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

  const RESCAN_MS = 1000

  function startWatcher(agentDir: string) {
    let currentTime = 100_000
    const cues: Cue[] = []
    const intervals: Array<{ fn: () => void; ref: number }> = []
    let nextRef = 1
    const watcher = startSubagentWatcher({
      agentDir,
      onFinish: () => {},
      onProgress: ({ agentId, progressLine, latestSummary, elapsedMs, skeleton }) => {
        cues.push({ agentId, progressLine, latestSummary, elapsedMs, skeleton })
      },
      stallThresholdMs: 600_000,
      silentSynthesisStallThresholdMs: 600_000,
      rescanMs: RESCAN_MS,
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
      now: () => currentTime,
    }
  }

  const skeletonCues = (cues: Cue[]): Cue[] =>
    cues.filter((c) => c.skeleton === true)

  function makeSubagentDir(root: string): string {
    const agentDir = join(root, 'agent')
    const subagentsDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    return agentDir
  }

  it('emits a growth-independent skeleton cue on the first no-growth poll after registration', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sr-firstpaint-'))
    const agentDir = makeSubagentDir(tmpRoot)
    const jsonlPath = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents', 'agent-deadbeef.jsonl')

    // Start the watcher on an empty subagents dir, THEN the worker spawns — the
    // real async Agent-tool path (the JSONL appears post-boot, so the entry is
    // live/non-historical, not a boot-time rediscovery). Only its prompt is on
    // disk, no assistant output yet (it is "thinking"): the pre-content window
    // the user stares at.
    const h = startWatcher(agentDir)
    h.poll() // boot scan over the empty dir
    writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Do the task')))
    h.advance(RESCAN_MS)
    h.poll() // discover + register as a live worker

    // Next poll: the JSONL has NOT grown. Pre-fix, readSubTail early-returns and
    // NO cue fires — the card is invisible. Post-fix, a skeleton cue surfaces so
    // the gateway can paint the card without waiting for the worker's output.
    h.advance(RESCAN_MS)
    h.poll()

    const skel = skeletonCues(h.cues)
    expect(skel.length, 'a skeleton cue must fire on a no-growth poll').toBeGreaterThanOrEqual(1)
    // Tight bound vs the ~205s live behaviour: first cue is within a couple polls
    // of registration, NOT minutes.
    expect(skel[0].elapsedMs).toBeLessThanOrEqual(2 * RESCAN_MS)
  })

  it('keeps surfacing skeleton cues while a worker is silent after an early tool burst (blocked first tool)', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sr-firstpaint-silent-'))
    const agentDir = makeSubagentDir(tmpRoot)
    const jsonlPath = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents', 'agent-a57fbf00.jsonl')

    const h = startWatcher(agentDir)
    h.poll() // boot scan over the empty dir
    writeFileSync(jsonlPath, buildJSONL(subAgentUserMsg('Debug delegation regression')))
    h.advance(RESCAN_MS)
    h.poll() // discover + register as a live worker

    // The worker does two quick Bash calls (the a57fbf shape) …
    appendFileSync(jsonlPath, buildJSONL(subAgentToolUse('Bash', 'b1')))
    h.advance(RESCAN_MS)
    h.poll()
    appendFileSync(jsonlPath, buildJSONL(subAgentToolUse('Bash', 'b2')))
    h.advance(RESCAN_MS)
    h.poll()

    // … then its tool BLOCKS: no JSONL growth for a long stretch (~30 polls).
    // The card must NOT go dark — a skeleton cue must fire on essentially every
    // no-growth poll so the feed row is created/kept-alive and the heartbeat can
    // climb the elapsed. Pre-fix, zero cues fire across the entire silent window.
    const before = h.cues.length
    for (let i = 0; i < 30; i++) {
      h.advance(RESCAN_MS)
      h.poll()
    }
    const duringSilence = h.cues.slice(before)
    const skel = duringSilence.filter((c) => c.skeleton === true)
    expect(skel.length, 'silent worker must keep emitting skeleton cues').toBeGreaterThanOrEqual(20)
    // No skeleton cue ever fabricates content — the step line stays empty.
    for (const c of skel) expect(c.latestSummary).toBe('')
  })
})
