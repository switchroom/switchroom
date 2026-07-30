/**
 * Regression: the PreToolUse hook must NOT write labels for SIDECHAIN
 * (sub-agent) tool calls into the parent session's sidecar.
 *
 * The bug (log-verified): Claude Code fires PreToolUse for sub-agent tool
 * calls too, and passes the PARENT `session_id`. The hook wrote the worker's
 * label into `tool-labels-<parentSession>.jsonl`; the gateway's real-time
 * draft-mirror tails that file and emits a main-tier `tool_label` event per
 * line, binding it to whatever turn is live — so a still-running background
 * worker dispatched by the PREVIOUS turn streamed its Bash step labels into an
 * unrelated new turn's progress card, and inflated that turn's
 * `labeledToolCount` / re-armed its orphaned-reply fuse.
 *
 * The fix severs the chain at its cheapest, at-source link: the hook drops
 * sidechain calls, so a sub-agent `toolUseId` never reaches the parent sidecar
 * → never becomes a `tool_label` event → never touches an unrelated card.
 * These tests assert that OUTCOME (no foreign sidecar line), plus the pure
 * predicate that distinguishes main-tier from sub-agent payloads.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// The hook exports isSubagentToolCall for unit testing (see the "Skip main()
// when imported" guard at the bottom of the hook).
import { isSubagentToolCall } from '../hooks/tool-label-pretool.mjs'

const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'tool-label-pretool.mjs')

/** Run the hook once with a payload; return the sidecar file's lines (if any). */
function runHook(payload: Record<string, unknown>): { stateDir: string; lines: string[]; sidecarPath: string } {
  const stateDir = mkdtempSync(join(tmpdir(), 'sidechain-label-'))
  const sessionId = String(payload.session_id ?? 'sess')
  const sidecarPath = join(stateDir, `tool-labels-${sessionId}.jsonl`)
  const res = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
    encoding: 'utf8',
  })
  // The hook must always exit 0 (exit 2 would BLOCK the tool call).
  expect(res.status).toBe(0)
  const lines = existsSync(sidecarPath)
    ? readFileSync(sidecarPath, 'utf8').split('\n').filter(Boolean)
    : []
  return { stateDir, lines, sidecarPath }
}

describe('isSubagentToolCall — main-tier vs sidechain discrimination', () => {
  it('treats agent_type "main" as main-tier (keep)', () => {
    expect(isSubagentToolCall({ agent_type: 'main', agent_id: 's1', session_id: 's1' })).toBe(false)
  })

  it('treats an ABSENT agent_type as main-tier (safe default — keep)', () => {
    expect(isSubagentToolCall({ session_id: 's1' })).toBe(false)
    expect(isSubagentToolCall({ agent_id: 's1', session_id: 's1' })).toBe(false)
  })

  it('flags every concrete non-"main" agent_type as sidechain (drop)', () => {
    for (const at of ['worker', 'general-purpose', 'Explore', 'Plan', 'researcher', 'my-custom-agent']) {
      expect(isSubagentToolCall({ agent_type: at, session_id: 'parent' })).toBe(true)
    }
  })

  it('flags a distinct agent_id (sub-agent id ≠ parent session) as sidechain', () => {
    // Corroborating signal even if agent_type were somehow absent.
    expect(isSubagentToolCall({ agent_id: 'sub-abc', session_id: 'parent-xyz' })).toBe(true)
  })

  it('does not flag main when agent_id equals session_id', () => {
    expect(isSubagentToolCall({ agent_id: 'same', session_id: 'same' })).toBe(false)
  })

  it('is robust to a null/undefined event', () => {
    expect(isSubagentToolCall(null)).toBe(false)
    expect(isSubagentToolCall(undefined)).toBe(false)
  })
})

describe('PreToolUse hook — sidechain calls never reach the parent sidecar', () => {
  it('writes a sidecar line for a MAIN-tier Bash call', () => {
    const { stateDir, lines } = runHook({
      session_id: 'parent-sess',
      tool_use_id: 'toolu_main_1',
      tool_name: 'Bash',
      tool_input: { command: 'git status', description: 'Check status' },
      agent_type: 'main',
      agent_id: 'parent-sess',
    })
    try {
      expect(lines.length).toBe(1)
      const row = JSON.parse(lines[0])
      expect(row.tool_use_id).toBe('toolu_main_1')
      expect(row.label).toBe('Check status')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('DROPS a sub-agent Bash call (no line in the parent sidecar)', () => {
    // The exact shape of the log-verified bug: a background worker's Bash call,
    // carrying the PARENT session_id but a "worker" agent_type.
    const { stateDir, lines, sidecarPath } = runHook({
      session_id: 'parent-sess',
      tool_use_id: 'toolu_worker_9',
      tool_name: 'Bash',
      tool_input: { command: 'npm run build', description: 'Build the worker output' },
      agent_type: 'worker',
      agent_id: 'sub-agent-42',
    })
    try {
      // No sidecar row at all → the draft-mirror never emits a foreign
      // tool_label → the live turn's card / labeledToolCount / fuse are
      // untouched. This is the regression that would have caught the bug.
      expect(lines.length).toBe(0)
      expect(existsSync(sidecarPath)).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('DROPS a sub-agent call flagged only by a distinct agent_id', () => {
    const { stateDir, lines } = runHook({
      session_id: 'parent-sess',
      tool_use_id: 'toolu_worker_10',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
      agent_id: 'sub-agent-77',
    })
    try {
      expect(lines.length).toBe(0)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
