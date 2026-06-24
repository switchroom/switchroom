/**
 * Regression test for workflow sub-agent feed visibility.
 *
 * Root cause: rescanSubagentDirs() did a flat readdir on subagents/ and only
 * matched entries whose names started with "agent-" and ended with ".jsonl".
 * Workflow sub-agents (spawned by the Workflow tool) write to a nested path:
 *   <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl
 * The "workflows" directory entry doesn't match the agent-*.jsonl filter, so
 * it was silently skipped and no workflow agent was ever registered or tailed.
 *
 * Fix: descend one level into subagents/workflows/wf_NNN dirs using the same
 * watchAndScan helper so all downstream tiers (registry, tailing, stall
 * detection, historical suppression, terminatedAgentIds dedup) apply
 * identically.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { rmSync } from 'fs'
import { startSubagentWatcher } from '../subagent-watcher.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildJSONL(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

function minimalAgentJsonl(): string {
  return buildJSONL(
    { type: 'user', message: { content: [{ type: 'text', text: 'Implement the workflow step' }] } },
  )
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('workflow sub-agent feed visibility', () => {
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

  /**
   * Start a minimal watcher against a real tmpdir and return a poll() helper.
   * Timers are stubbed so no real setInterval fires; the caller drives polls
   * manually to control the scan sequence.
   */
  function startWatcher(agentDir: string): {
    poll: () => void
    watcher: ReturnType<typeof startSubagentWatcher>
    registered: string[]
  } {
    const registered: string[] = []
    const intervals: Array<{ fn: () => void; ref: number }> = []
    const timeouts: Array<{ fn: () => void; ref: number }> = []
    let nextRef = 1

    const watcher = startSubagentWatcher({
      agentDir,
      onFinish: (info) => { registered.push(`finish:${info.agentId}`) },
      stallThresholdMs: 60_000,
      silentSynthesisStallThresholdMs: 60_000,
      rescanMs: 500,
      now: () => Date.now(),
      setInterval: (fn) => {
        const ref = nextRef++
        intervals.push({ fn, ref })
        return { ref }
      },
      clearInterval: (handle) => {
        const { ref } = handle as { ref: number }
        const idx = intervals.findIndex((i) => i.ref === ref)
        if (idx !== -1) intervals.splice(idx, 1)
      },
      setTimeout: (fn) => {
        const ref = nextRef++
        timeouts.push({ fn, ref })
        return { ref }
      },
      clearTimeout: (handle) => {
        const { ref } = handle as { ref: number }
        const idx = timeouts.findIndex((t) => t.ref === ref)
        if (idx !== -1) timeouts.splice(idx, 1)
      },
      log: () => {},
    })
    started.push(watcher)

    return {
      poll: () => intervals[0]?.fn(),
      watcher,
      registered,
    }
  }

  it('registers a workflow agent at subagents/workflows/wf_<id>/agent-<id>.jsonl', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-workflow-test-'))
    const agentDir = join(tmpRoot, 'agent')

    // Lay out the nested workflow path that the Workflow tool produces
    const wfDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents', 'workflows', 'wf_test')
    mkdirSync(wfDir, { recursive: true })
    const agentId = 'abcdef1234567890'
    const jsonlPath = join(wfDir, `agent-${agentId}.jsonl`)
    writeFileSync(jsonlPath, minimalAgentJsonl())

    const { poll, watcher } = startWatcher(agentDir)
    poll()

    const entry = watcher.getRegistry().get(agentId)
    expect(entry, 'workflow agent should be registered').toBeDefined()
    expect(entry?.state).toBe('running')
    // The agent file was just written, so the boot-promotion path correctly
    // marks it live (historical=false) — the user is still awaiting its output.
  })

  it('does NOT register a sibling journal.jsonl in the wf dir', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-workflow-journal-test-'))
    const agentDir = join(tmpRoot, 'agent')

    const wfDir = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents', 'workflows', 'wf_test')
    mkdirSync(wfDir, { recursive: true })

    const agentId = 'deadbeefcafe0001'
    writeFileSync(join(wfDir, `agent-${agentId}.jsonl`), minimalAgentJsonl())
    // journal.jsonl is written by the Workflow tool alongside the agent transcript
    writeFileSync(join(wfDir, 'journal.jsonl'), buildJSONL({ type: 'workflow_event', step: 1 }))

    const { poll, watcher } = startWatcher(agentDir)
    poll()

    // The agent JSONL must be registered
    expect(watcher.getRegistry().get(agentId), 'agent entry must exist').toBeDefined()
    // journal.jsonl must NOT appear in the registry (no agent id derived from it)
    const journalKey = 'journal' // would be the agentId if erroneously registered
    expect(watcher.getRegistry().get(journalKey), 'journal.jsonl must not be registered').toBeUndefined()
    // Registry should have exactly one entry (the real agent)
    expect(watcher.getRegistry().size).toBe(1)
  })

  it('registers multiple workflow agents across different wf_* dirs', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-workflow-multi-test-'))
    const agentDir = join(tmpRoot, 'agent')

    const workflowsBase = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents', 'workflows')

    const wfIds = ['wf_step1', 'wf_step2', 'wf_step3']
    const agentIds: string[] = []
    for (const wfId of wfIds) {
      const wfDir = join(workflowsBase, wfId)
      mkdirSync(wfDir, { recursive: true })
      const agentId = `agent${wfId.replace('wf_', '')}cafebabe`
      agentIds.push(agentId)
      writeFileSync(join(wfDir, `agent-${agentId}.jsonl`), minimalAgentJsonl())
      // Each wf dir also gets a journal.jsonl — must be ignored
      writeFileSync(join(wfDir, 'journal.jsonl'), buildJSONL({ step: wfId }))
    }

    const { poll, watcher } = startWatcher(agentDir)
    poll()

    for (const agentId of agentIds) {
      expect(watcher.getRegistry().get(agentId), `${agentId} should be registered`).toBeDefined()
    }
    // Exactly the three agents, no journals
    expect(watcher.getRegistry().size).toBe(3)
  })

  it('skips a stray non-directory file sitting directly in workflows/', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-workflow-stray-test-'))
    const agentDir = join(tmpRoot, 'agent')

    const workflowsBase = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents', 'workflows')
    mkdirSync(workflowsBase, { recursive: true })
    // A stray regular file directly under workflows/ (e.g. an index/lock the
    // Workflow tool might drop there). statSync succeeds on it, so without the
    // isDirectory() guard it would be handed to watchAndScan and open a wasted
    // fs.watch. It must be skipped — not registered — and not crash the scan.
    writeFileSync(join(workflowsBase, 'index.json'), '{"runs":[]}')

    // A real workflow agent alongside the stray file must still register
    const wfDir = join(workflowsBase, 'wf_real')
    mkdirSync(wfDir, { recursive: true })
    const agentId = 'feedface00001111'
    writeFileSync(join(wfDir, `agent-${agentId}.jsonl`), minimalAgentJsonl())

    const { poll, watcher } = startWatcher(agentDir)
    poll()

    expect(watcher.getRegistry().get(agentId), 'real workflow agent should register').toBeDefined()
    // Only the real agent — the stray file produced no entry
    expect(watcher.getRegistry().size).toBe(1)
  })

  it('discovers a wf_* dir created AFTER the watcher starts (runtime poll)', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'switchroom-workflow-late-test-'))
    const agentDir = join(tmpRoot, 'agent')

    // Session + subagents dir present at boot, but no workflows/ run yet
    const subagents = join(agentDir, '.claude', 'projects', 'p1', 'session-abc', 'subagents')
    mkdirSync(subagents, { recursive: true })

    const { poll, watcher } = startWatcher(agentDir)
    poll() // boot scan: nothing to register
    expect(watcher.getRegistry().size).toBe(0)

    // A workflow run begins after the watcher is already live
    const wfDir = join(subagents, 'workflows', 'wf_late')
    mkdirSync(wfDir, { recursive: true })
    const agentId = 'lateb00b1234abcd'
    writeFileSync(join(wfDir, `agent-${agentId}.jsonl`), minimalAgentJsonl())

    poll() // next poll tick re-descends workflows/ and picks it up
    expect(watcher.getRegistry().get(agentId), 'late workflow agent should be discovered on poll').toBeDefined()
  })
})
