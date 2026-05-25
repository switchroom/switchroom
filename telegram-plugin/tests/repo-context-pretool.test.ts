/**
 * Tests for telegram-plugin/hooks/repo-context-pretool.mjs.
 *
 * Two layers:
 *   - Pure helpers exported from the hook (resolveTargetDir,
 *     findNearestMarker, isUnderAgentWorkspace) — fast unit tests.
 *   - End-to-end spawn of the hook with a faked PreToolUse envelope
 *     on stdin — pins the JSON-output contract + the session-scoped
 *     dedup behaviour.
 *
 * Mirrors the spawn-the-hook integration pattern from
 * secret-guard-pretool.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  resolveTargetDir,
  findNearestMarker,
  isUnderAgentWorkspace,
} from '../hooks/repo-context-pretool.mjs'

const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'repo-context-pretool.mjs')

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe('resolveTargetDir', () => {
  it('Read → dirname(file_path)', () => {
    expect(
      resolveTargetDir('Read', { file_path: '/abs/path/to/file.ts' }, '/cwd'),
    ).toBe('/abs/path/to')
  })

  it('Edit / Write / MultiEdit / NotebookEdit — same shape', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(
        resolveTargetDir(tool, { file_path: '/repo/src/main.ts' }, '/cwd'),
      ).toBe('/repo/src')
    }
    // NotebookEdit takes file_path OR notebook_path
    expect(
      resolveTargetDir('NotebookEdit', { notebook_path: '/r/n.ipynb' }, '/cwd'),
    ).toBe('/r')
  })

  it('Bash → envelope cwd, not anything inside the command', () => {
    expect(
      resolveTargetDir('Bash', { command: 'ls /elsewhere' }, '/agent/cwd'),
    ).toBe('/agent/cwd')
  })

  it('returns null for relative file paths (ambiguous)', () => {
    expect(
      resolveTargetDir('Read', { file_path: 'rel/path.ts' }, '/cwd'),
    ).toBe(null)
  })

  it('returns null for non-target tools', () => {
    expect(resolveTargetDir('Glob', { pattern: '*' }, '/cwd')).toBe(null)
    expect(resolveTargetDir('Grep', { pattern: 'x' }, '/cwd')).toBe(null)
    expect(resolveTargetDir('WebFetch', { url: 'u' }, '/cwd')).toBe(null)
  })

  it('returns null for missing / empty tool_input fields', () => {
    expect(resolveTargetDir('Read', {}, '/cwd')).toBe(null)
    expect(resolveTargetDir('Read', { file_path: '' }, '/cwd')).toBe(null)
    expect(resolveTargetDir('Bash', { command: 'x' }, '')).toBe(null)
    expect(resolveTargetDir('Bash', { command: 'x' }, 'rel')).toBe(null)
  })
})

describe('findNearestMarker', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'repo-context-marker-'))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('finds CLAUDE.md in the target dir itself', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), 'root')
    expect(findNearestMarker(tmpRoot)).toBe(join(tmpRoot, 'CLAUDE.md'))
  })

  it('walks up to find CLAUDE.md in an ancestor', () => {
    mkdirSync(join(tmpRoot, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(tmpRoot, 'a', 'CLAUDE.md'), 'a-level')
    expect(findNearestMarker(join(tmpRoot, 'a', 'b', 'c'))).toBe(
      join(tmpRoot, 'a', 'CLAUDE.md'),
    )
  })

  it('prefers CLAUDE.md over AGENTS.md over AGENT.md at the same level', () => {
    writeFileSync(join(tmpRoot, 'AGENT.md'), 'agent')
    writeFileSync(join(tmpRoot, 'AGENTS.md'), 'agents')
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), 'claude')
    expect(findNearestMarker(tmpRoot)).toBe(join(tmpRoot, 'CLAUDE.md'))
  })

  it('falls back to AGENTS.md when CLAUDE.md is absent', () => {
    writeFileSync(join(tmpRoot, 'AGENTS.md'), 'agents')
    expect(findNearestMarker(tmpRoot)).toBe(join(tmpRoot, 'AGENTS.md'))
  })

  it('returns the NEAREST marker, not the furthest, when both exist', () => {
    mkdirSync(join(tmpRoot, 'inner'), { recursive: true })
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), 'outer')
    writeFileSync(join(tmpRoot, 'inner', 'CLAUDE.md'), 'inner')
    expect(findNearestMarker(join(tmpRoot, 'inner'))).toBe(
      join(tmpRoot, 'inner', 'CLAUDE.md'),
    )
  })

  it('returns null when no marker exists in the walk path', () => {
    mkdirSync(join(tmpRoot, 'a', 'b'), { recursive: true })
    expect(findNearestMarker(join(tmpRoot, 'a', 'b'))).toBe(null)
  })

  it('returns null for empty / non-string input', () => {
    expect(findNearestMarker('')).toBe(null)
    // @ts-expect-error testing runtime tolerance
    expect(findNearestMarker(null)).toBe(null)
  })
})

describe('isUnderAgentWorkspace', () => {
  it('returns true when target equals the workspace root', () => {
    const home = '/home/op'
    const ws = join(home, '.switchroom', 'agents', 'clerk', 'workspace')
    expect(isUnderAgentWorkspace(ws, 'clerk', home)).toBe(true)
  })

  it('returns true when target is nested under the workspace', () => {
    const home = '/home/op'
    expect(
      isUnderAgentWorkspace(
        join(home, '.switchroom/agents/clerk/workspace/memory'),
        'clerk',
        home,
      ),
    ).toBe(true)
  })

  it('returns false for paths outside the workspace', () => {
    const home = '/home/op'
    expect(isUnderAgentWorkspace('/tmp/foo', 'clerk', home)).toBe(false)
    expect(
      isUnderAgentWorkspace(
        join(home, '.switchroom/agents/clerk'),
        'clerk',
        home,
      ),
    ).toBe(false)
  })

  it('returns false when agentName is empty (cannot derive workspace)', () => {
    expect(isUnderAgentWorkspace('/home/op/x', '', '/home/op')).toBe(false)
  })

  it('does not false-positive on prefix-collision dirs', () => {
    // /workspace-other should NOT match /workspace (no trailing sep)
    const home = '/home/op'
    expect(
      isUnderAgentWorkspace(
        join(home, '.switchroom/agents/clerk/workspace-other'),
        'clerk',
        home,
      ),
    ).toBe(false)
  })
})

// ─── End-to-end spawn ─────────────────────────────────────────────────────

interface Sandbox {
  root: string
  cleanup: () => void
}

function newSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'repo-context-e2e-'))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function runHook(
  envelope: object,
  opts: { home?: string; agent?: string; disabled?: boolean; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; code: number } {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: opts.home ?? '/tmp/non-existent-home',
    SWITCHROOM_AGENT_NAME: opts.agent ?? '',
    ...(opts.disabled ? { SWITCHROOM_DISABLE_REPO_CONTEXT_HOOK: '1' } : {}),
    ...(opts.env ?? {}),
  }
  const res = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(envelope),
    env,
    encoding: 'utf8',
    timeout: 5000,
  })
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    code: res.status ?? -1,
  }
}

describe('repo-context-pretool e2e', () => {
  let sb: Sandbox
  let sessionStateDirs: string[] = []

  beforeEach(() => {
    sb = newSandbox()
    sessionStateDirs = []
  })

  afterEach(() => {
    sb.cleanup()
    for (const d of sessionStateDirs) rmSync(d, { recursive: true, force: true })
  })

  function repoStateDir(sessionId: string): string {
    const d = join(tmpdir(), `switchroom-repo-context-${sessionId}`)
    sessionStateDirs.push(d)
    return d
  }

  it('injects CLAUDE.md on first Read into a new repo', () => {
    const repo = join(sb.root, 'foo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'CLAUDE.md'), '# foo project\nuse pnpm.')
    writeFileSync(join(repo, 'src', 'main.ts'), 'x')

    const sid = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    repoStateDir(sid)
    const res = runHook({
      session_id: sid,
      cwd: sb.root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(repo, 'src', 'main.ts') },
    })

    expect(res.code).toBe(0)
    expect(res.stdout.length).toBeGreaterThan(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    const ctx = parsed.hookSpecificOutput.additionalContext
    expect(ctx).toContain('# foo project')
    expect(ctx).toContain('use pnpm')
    expect(ctx).toContain(join(repo, 'CLAUDE.md'))
  })

  it('dedups — second call in the same session is a no-op', () => {
    const repo = join(sb.root, 'foo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'CLAUDE.md'), '# foo')
    writeFileSync(join(repo, 'main.ts'), 'x')

    const sid = `e2e-dedup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    repoStateDir(sid)
    const envelope = {
      session_id: sid,
      cwd: sb.root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(repo, 'main.ts') },
    }

    const first = runHook(envelope)
    expect(first.code).toBe(0)
    expect(first.stdout.length).toBeGreaterThan(0)

    const second = runHook(envelope)
    expect(second.code).toBe(0)
    expect(second.stdout).toBe('')
  })

  it('different sessions get independent dedup tracking', () => {
    const repo = join(sb.root, 'foo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'CLAUDE.md'), '# foo')
    writeFileSync(join(repo, 'main.ts'), 'x')

    const sid1 = `e2e-sess1-${Date.now()}`
    const sid2 = `e2e-sess2-${Date.now()}`
    repoStateDir(sid1)
    repoStateDir(sid2)
    const base = {
      cwd: sb.root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(repo, 'main.ts') },
    }
    const a = runHook({ ...base, session_id: sid1 })
    const b = runHook({ ...base, session_id: sid2 })
    expect(a.stdout.length).toBeGreaterThan(0)
    expect(b.stdout.length).toBeGreaterThan(0)
  })

  it('opt-out via SWITCHROOM_DISABLE_REPO_CONTEXT_HOOK=1 → no-op', () => {
    const repo = join(sb.root, 'foo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'CLAUDE.md'), '# foo')
    writeFileSync(join(repo, 'main.ts'), 'x')

    const res = runHook(
      {
        session_id: `e2e-disabled-${Date.now()}`,
        cwd: sb.root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: join(repo, 'main.ts') },
      },
      { disabled: true },
    )
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('skips the agent workspace (already auto-loaded by Claude Code)', () => {
    const home = sb.root
    const wsRoot = join(home, '.switchroom', 'agents', 'clerk', 'workspace')
    mkdirSync(wsRoot, { recursive: true })
    writeFileSync(join(wsRoot, 'CLAUDE.md'), '# workspace')
    writeFileSync(join(wsRoot, 'note.md'), 'x')

    const sid = `e2e-ws-skip-${Date.now()}`
    repoStateDir(sid)
    const res = runHook(
      {
        session_id: sid,
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: join(wsRoot, 'note.md') },
      },
      { home, agent: 'clerk' },
    )
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('large CLAUDE.md emits a pointer rather than the body', () => {
    const repo = join(sb.root, 'huge')
    mkdirSync(repo, { recursive: true })
    // 60 KB — exceeds the default 30 KB per-file budget
    writeFileSync(join(repo, 'CLAUDE.md'), 'x'.repeat(60_000))
    writeFileSync(join(repo, 'main.ts'), 'y')

    const sid = `e2e-huge-${Date.now()}`
    repoStateDir(sid)
    const res = runHook({
      session_id: sid,
      cwd: sb.root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: join(repo, 'main.ts') },
    })
    expect(res.code).toBe(0)
    expect(res.stdout.length).toBeGreaterThan(0)
    const parsed = JSON.parse(res.stdout)
    const ctx = parsed.hookSpecificOutput.additionalContext
    // Should NOT contain the body; should contain the pointer phrasing
    expect(ctx).not.toContain('xxxxxxxxxxxx')
    expect(ctx).toContain('larger than the per-file injection budget')
    expect(ctx).toContain(join(repo, 'CLAUDE.md'))
  })

  it('Bash tool uses the envelope cwd', () => {
    const repo = join(sb.root, 'bash-repo')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'CLAUDE.md'), '# bash repo')

    const sid = `e2e-bash-${Date.now()}`
    repoStateDir(sid)
    const res = runHook({
      session_id: sid,
      cwd: repo,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    })
    expect(res.code).toBe(0)
    expect(res.stdout.length).toBeGreaterThan(0)
    const parsed = JSON.parse(res.stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain('# bash repo')
  })

  it('fails open on malformed stdin', () => {
    const res = spawnSync('node', [HOOK_PATH], {
      input: 'not json',
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp' },
      encoding: 'utf8',
      timeout: 5000,
    })
    expect(res.status).toBe(0)
    expect(res.stdout ?? '').toBe('')
  })

  it('fails open on empty stdin', () => {
    const res = spawnSync('node', [HOOK_PATH], {
      input: '',
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp' },
      encoding: 'utf8',
      timeout: 5000,
    })
    expect(res.status).toBe(0)
    expect(res.stdout ?? '').toBe('')
  })

  it('no marker → no output', () => {
    // tmpdir, no CLAUDE.md anywhere up the chain
    const file = join(sb.root, 'nothing.ts')
    writeFileSync(file, 'x')
    const sid = `e2e-no-marker-${Date.now()}`
    repoStateDir(sid)
    const res = runHook({
      session_id: sid,
      cwd: sb.root,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: file },
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('per-session file-count cap → stops injecting after N repos', () => {
    // Create 6 separate repos each with a marker; first 2 should inject
    // (override MAX_FILES to 2 via env)
    const sid = `e2e-cap-${Date.now()}`
    repoStateDir(sid)

    const outputs: string[] = []
    for (let i = 0; i < 4; i++) {
      const repo = join(sb.root, `r${i}`)
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, 'CLAUDE.md'), `# repo ${i}`)
      writeFileSync(join(repo, 'f.ts'), 'x')
      const res = runHook(
        {
          session_id: sid,
          cwd: sb.root,
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input: { file_path: join(repo, 'f.ts') },
        },
        {
          env: { SWITCHROOM_REPO_CONTEXT_PER_SESSION_MAX_FILES: '2' },
        },
      )
      outputs.push(res.stdout)
    }
    // First 2 inject, last 2 are caps-blocked → empty
    expect(outputs[0].length).toBeGreaterThan(0)
    expect(outputs[1].length).toBeGreaterThan(0)
    expect(outputs[2]).toBe('')
    expect(outputs[3]).toBe('')
  })
})
