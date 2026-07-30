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
import { isSubagentToolCall, hasAttributionSignal } from '../hooks/tool-label-pretool.mjs'

const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'tool-label-pretool.mjs')
const FIXTURE_DIR = resolve(__dirname, 'fixtures')

/** Load a committed real-shape PreToolUse fixture (see the drift-canary block). */
function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}

/** Run the hook once with a payload; return the sidecar file's lines (if any). */
function runHook(payload: Record<string, unknown>): {
  stateDir: string
  lines: string[]
  sidecarPath: string
  stderr: string
} {
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
  return { stateDir, lines, sidecarPath, stderr: res.stderr ?? '' }
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

/**
 * DRIFT CANARY — the compile-time half.
 *
 * The hand-built payloads above all use the field NAMES this reviewer round
 * happened to expect (`agent_type`, `agent_id`). If a future Claude Code
 * renamed BOTH (e.g. `agent_type`→`agentType`), those tests would stay green
 * while the hook silently fails open and the cross-turn contamination bug
 * returns. These two fixtures are the REAL 2.1.219 PreToolUse shape, verified
 * field-by-field against the installed binary's base `Kf(...)` hook-input
 * builder:
 *   { session_id, transcript_path, cwd, prompt_id?, permission_mode,
 *     agent_id, agent_type, effort?, hook_event_name, tool_name, tool_input,
 *     tool_use_id }
 * Piping the genuine object shape through the real hook proves the predicate
 * works against what claude actually emits (not a mental model of it), and
 * pins the field names so a rename that reaches these fixtures fails CI. The
 * runtime WARNING below covers the residual case (a live CLI drift the frozen
 * fixture can't see).
 */
describe('drift canary — real 2.1.219 PreToolUse payload shape', () => {
  it('DROPS a genuine sub-agent payload (full Kf shape) — zero sidecar lines, no file', () => {
    const fixture = loadFixture('pretool-subagent-2.1.219.json')
    // Sanity: the fixture really is a sidechain shape (parent session_id, own
    // agent_id, concrete agent_type) — if a maintainer refreshes it from a
    // future CLI and the schema moved, this predicate assertion trips first.
    expect(isSubagentToolCall(fixture)).toBe(true)
    const { stateDir, lines, sidecarPath } = runHook(fixture)
    try {
      expect(lines.length).toBe(0)
      expect(existsSync(sidecarPath)).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('KEEPS a genuine main-tier payload (full Kf shape) — one sidecar line', () => {
    const fixture = loadFixture('pretool-main-2.1.219.json')
    expect(isSubagentToolCall(fixture)).toBe(false)
    const { stateDir, lines } = runHook(fixture)
    try {
      expect(lines.length).toBe(1)
      const row = JSON.parse(lines[0])
      expect(row.tool_use_id).toBe('toolu_01MainReadCall4z')
      expect(row.label).toBe('Reading index.ts')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

/**
 * SYMMETRIC FALSE-POSITIVE guard — an explicit "main" must win over identity.
 *
 * The predicate's identity fallback (`agent_id !== session_id` ⇒ sidechain)
 * must never override an explicit `agent_type: "main"`. If a FUTURE main-tier
 * payload stopped setting `agent_id === session_id`, the old ordering would
 * have wrongly DROPPED legit main labels (the whole live feed for that turn).
 */
describe('agent_type "main" is authoritative — never a false-positive drop', () => {
  it('KEEPS a "main" payload even when agent_id differs from session_id', () => {
    expect(
      isSubagentToolCall({ agent_type: 'main', agent_id: 'different-id', session_id: 's1' }),
    ).toBe(false)
    const { stateDir, lines } = runHook({
      session_id: 's1',
      tool_use_id: 'toolu_main_diverged',
      tool_name: 'Read',
      tool_input: { file_path: '/x/y.ts' },
      agent_type: 'main',
      agent_id: 'different-id',
    })
    try {
      expect(lines.length).toBe(1)
      expect(JSON.parse(lines[0]).tool_use_id).toBe('toolu_main_diverged')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

/**
 * FAIL-LOUD guard — a payload with NEITHER identity field is anomalous on
 * 2.1.219 and means the schema may have drifted out from under the predicate.
 * The hook must warn (so plugin-logger surfaces it) but NOT drop (dropping
 * every label on drift would dark-out the whole feed).
 */
describe('hasAttributionSignal + the schema-drift warning', () => {
  it('hasAttributionSignal is true with either field, false with neither', () => {
    expect(hasAttributionSignal({ agent_type: 'main' })).toBe(true)
    expect(hasAttributionSignal({ agent_id: 'x' })).toBe(true)
    expect(hasAttributionSignal({ agent_type: '', agent_id: '' })).toBe(false)
    expect(hasAttributionSignal({ session_id: 's1', tool_use_id: 't' })).toBe(false)
    expect(hasAttributionSignal(null)).toBe(false)
  })

  it('WARNS but still writes when a real tool call carries neither agent_type nor agent_id', () => {
    const { stateDir, lines, stderr } = runHook({
      session_id: 's1',
      tool_use_id: 'toolu_no_attribution',
      tool_name: 'Read',
      tool_input: { file_path: '/x/y.ts' },
      // No agent_type, no agent_id — the both-fields-dropped drift scenario.
    })
    try {
      // Loud: the drift warning fires (plugin-logger tails stderr)…
      expect(stderr).toContain('sidechain-attribution invariant may be')
      // …but NOT dropped — main-tier labels still flow so the feed isn't dark.
      expect(lines.length).toBe(1)
      expect(JSON.parse(lines[0]).tool_use_id).toBe('toolu_no_attribution')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT warn on a normal 2.1.219 payload (both fields present)', () => {
    const { stateDir, stderr } = runHook(loadFixture('pretool-main-2.1.219.json'))
    try {
      expect(stderr).not.toContain('sidechain-attribution invariant may be')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
