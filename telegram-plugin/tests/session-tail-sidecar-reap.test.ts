/**
 * FD/timer-leak regression test for the session-tail PreToolUse sidecars
 * (review finding M1).
 *
 * `ToolLabelSidecar`s (each holding a stat-poll timer + file handle) were only
 * reaped in the global `stop()`. Every session rotation (`/clear`, compaction →
 * new sessionId) and every finished sub-agent minted a fresh sidecar that then
 * lived until process exit — hundreds of leaked timers/handles on a long-lived
 * agent.
 *
 * We mock the sidecar factory so each instance is a cheap fake with a `stop`
 * spy, then drive a real parent-session rotation and a real sub-agent reap and
 * assert the ended session's sidecar was stopped. Both assertions FAIL on
 * pre-fix code (stop only in `stop()`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ─── Sidecar factory mock: record every instance keyed by sessionId ──────────
const created = vi.hoisted(() => {
  const instances: Array<{ sessionId: string; stop: ReturnType<typeof vi.fn> }> = []
  return { instances }
})

vi.mock('../tool-label-sidecar.js', () => ({
  createToolLabelSidecar: (opts: { stateDir: string; sessionId: string }) => {
    const inst = {
      sessionId: opts.sessionId,
      stop: vi.fn(),
      getLabel: () => undefined,
      onLabel: () => () => {},
      poll: () => {},
    }
    created.instances.push(inst)
    return inst
  },
}))

// Import AFTER the mock is registered.
const { startSessionTail, getProjectsDirForCwd } = await import('../session-tail.js')

// ─── Helpers ─────────────────────────────────────────────────────────────────
const tempDirs: string[] = []
let prevStateDir: string | undefined

beforeEach(() => {
  created.instances.length = 0
  prevStateDir = process.env.TELEGRAM_STATE_DIR
  const stateDir = mkdtempSync(join(tmpdir(), 'sidecar-state-'))
  tempDirs.push(stateDir)
  process.env.TELEGRAM_STATE_DIR = stateDir
})

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.TELEGRAM_STATE_DIR
  else process.env.TELEGRAM_STATE_DIR = prevStateDir
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  tempDirs.length = 0
})

function mkProjectsDir(): { claudeHome: string; cwd: string; projectsDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'session-tail-sidecar-'))
  tempDirs.push(base)
  const cwd = join(base, 'agent')
  const claudeHome = join(base, 'claude-home')
  const projectsDir = getProjectsDirForCwd(cwd, claudeHome)
  mkdirSync(projectsDir, { recursive: true })
  return { claudeHome, cwd, projectsDir }
}

const setMtime = (path: string, seconds: number): void => utimesSync(path, seconds, seconds)
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const assistantText = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
const toolUseLine = (name: string, id: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: {} }] } }) + '\n'

const findSidecar = (sessionId: string) => created.instances.find((i) => i.sessionId === sessionId)

describe('session-tail sidecar reap (M1) — parent session rotation', () => {
  it('stops the prior session sidecar when the active file rotates', async () => {
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const first = join(projectsDir, 'session-one.jsonl')
    const second = join(projectsDir, 'session-two.jsonl')

    writeFileSync(first, assistantText('parent one'))
    setMtime(first, 1_000_000)

    const handle = startSessionTail({ cwd, claudeHome, rescanIntervalMs: 30, onEvent: () => {} })
    try {
      await wait(120) // initial attach → sidecar 'session-one' created
      expect(findSidecar('session-one')).toBeDefined()
      expect(findSidecar('session-one')!.stop).not.toHaveBeenCalled()

      // A newer session file appears (compaction / clear rotation).
      const nowSec = Math.floor(Date.now() / 1000)
      writeFileSync(second, assistantText('parent two'))
      setMtime(second, nowSec + 20)
      setMtime(first, nowSec + 5)
      await wait(200) // rescan flips to session-two → session-one must be reaped

      expect(findSidecar('session-two')).toBeDefined()
      // The rotated-away session's sidecar is stopped at runtime, not left for stop().
      expect(findSidecar('session-one')!.stop).toHaveBeenCalledTimes(1)
      // The now-active session's sidecar stays alive.
      expect(findSidecar('session-two')!.stop).not.toHaveBeenCalled()
    } finally {
      handle.stop()
    }
  })
})

describe('session-tail sidecar reap (M1) — idle sub-agent', () => {
  it('stops a sub-agent sidecar when its idle sub-tail is reaped', async () => {
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const parent = join(projectsDir, 'parent.jsonl')
    writeFileSync(parent, assistantText('parent'))
    setMtime(parent, Math.floor(Date.now() / 1000))

    // Sub-agents live under <parentSessionId>/subagents/agent-<id>.jsonl.
    const subDir = join(projectsDir, 'parent', 'subagents')
    mkdirSync(subDir, { recursive: true })
    const subFile = join(subDir, 'agent-sub123.jsonl')
    // A tool_use line makes the sub-tail lazily create its sidecar (keyed by
    // the file stem 'agent-sub123').
    writeFileSync(subFile, toolUseLine('Bash', 'toolu_1'))

    const handle = startSessionTail({
      cwd,
      claudeHome,
      rescanIntervalMs: 30,
      // Reap sub-tails idle for >1000ms so the test doesn't wait 5 minutes but
      // still respects the L1 floor clamp (Math.max(1000, …) — a smaller value
      // is silently lifted to 1s) and leaves a window to observe the
      // not-yet-reaped state.
      subTailIdleReapMs: 1000,
      onEvent: () => {},
    })
    try {
      await wait(100) // attach parent + sub, read tool_use → sidecar created
      const sub = findSidecar('agent-sub123')
      expect(sub).toBeDefined()
      expect(sub!.stop).not.toHaveBeenCalled()

      // Let the sub-tail go idle past the reap window; a rescan tick reaps it.
      await wait(1300)
      expect(sub!.stop).toHaveBeenCalledTimes(1)
    } finally {
      handle.stop()
    }
  })
})

describe('session-tail sidecar reap (L1) — reap window is floor-clamped', () => {
  it('does NOT instant-reap a live sub-tail under a zero (or negative) idle window', async () => {
    // A `subTailIdleReapMs` of 0 (or negative) would, without the
    // Math.max(1000, …) clamp, make `reapIdleSubTails` compute
    // `cutoff = Date.now() - 0`, which is ALWAYS ≥ a live sub-tail's slightly-
    // earlier `lastActivityAt` — so every live sub-agent sidecar would be
    // reaped on the very first rescan tick. The clamp lifts the effective
    // window to the 1s floor, so a sub-tail active moments ago survives.
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const parent = join(projectsDir, 'parent.jsonl')
    writeFileSync(parent, assistantText('parent'))
    setMtime(parent, Math.floor(Date.now() / 1000))

    const subDir = join(projectsDir, 'parent', 'subagents')
    mkdirSync(subDir, { recursive: true })
    const subFile = join(subDir, 'agent-subzero.jsonl')
    writeFileSync(subFile, toolUseLine('Bash', 'toolu_z'))

    const handle = startSessionTail({
      cwd,
      claudeHome,
      rescanIntervalMs: 30,
      subTailIdleReapMs: 0, // pathological: pre-clamp this instant-reaps
      onEvent: () => {},
    })
    try {
      await wait(100) // attach parent + sub → sidecar 'agent-subzero' created
      const sub = findSidecar('agent-subzero')
      expect(sub).toBeDefined()
      expect(sub!.stop).not.toHaveBeenCalled()

      // Several rescan ticks pass (well under the 1s clamp floor). A live
      // sub-tail whose activity is <1s old must NOT be reaped — so its sidecar
      // stays alive. Pre-clamp, the first tick reaps it (sub.stop called once).
      await wait(200)
      expect(sub!.stop).not.toHaveBeenCalled()
    } finally {
      handle.stop()
    }
  })
})

describe('session-tail sidecar reap (M1) — namespace safety', () => {
  it('a parent-session rotation does NOT stop a concurrently-live sub-agent sidecar', async () => {
    // The rotation reap in attachToFile stops the sidecar keyed by the
    // rotated-away parent's JSONL stem (a UUID). A live sub-agent's sidecar is
    // keyed by its OWN file stem ('agent-<id>'). Because the two key namespaces
    // never collide, rotating the parent must leave the sub-agent's sidecar
    // untouched — otherwise a `/clear` or compaction mid-worker would silently
    // kill the live worker's label sidecar. Reviewer verified by code-reading
    // only; this locks it in.
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const first = join(projectsDir, 'session-one.jsonl')
    const second = join(projectsDir, 'session-two.jsonl')

    writeFileSync(first, assistantText('parent one'))
    setMtime(first, 1_000_000)

    // A live sub-agent under the CURRENT (session-one) parent. Its tool_use
    // line makes the sub-tail create a sidecar keyed 'agent-subns'.
    const subDir = join(projectsDir, 'session-one', 'subagents')
    mkdirSync(subDir, { recursive: true })
    const subFile = join(subDir, 'agent-subns.jsonl')
    writeFileSync(subFile, toolUseLine('Bash', 'toolu_ns'))

    const handle = startSessionTail({
      cwd,
      claudeHome,
      rescanIntervalMs: 30,
      // Large window so the sub-tail is never idle-reaped during the test —
      // we're isolating the rotation path, not the idle path.
      subTailIdleReapMs: 60_000,
      onEvent: () => {},
    })
    try {
      await wait(120) // attach parent + sub → both sidecars created
      const parentSidecar = findSidecar('session-one')
      const subSidecar = findSidecar('agent-subns')
      expect(parentSidecar).toBeDefined()
      expect(subSidecar).toBeDefined()
      expect(parentSidecar!.stop).not.toHaveBeenCalled()
      expect(subSidecar!.stop).not.toHaveBeenCalled()

      // Parent session rotates (compaction / clear → new sessionId).
      const nowSec = Math.floor(Date.now() / 1000)
      writeFileSync(second, assistantText('parent two'))
      setMtime(second, nowSec + 20)
      setMtime(first, nowSec + 5)
      await wait(200) // rescan flips active file to session-two

      // The rotated-away PARENT sidecar is reaped …
      expect(parentSidecar!.stop).toHaveBeenCalledTimes(1)
      // … but the concurrently-live SUB-agent sidecar is NOT — different stem
      // namespace, so the rotation reap never targets it.
      expect(subSidecar!.stop).not.toHaveBeenCalled()
    } finally {
      handle.stop()
    }
  })
})
