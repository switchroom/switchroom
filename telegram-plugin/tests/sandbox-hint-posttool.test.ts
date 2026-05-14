/**
 * Tests for the sandbox-hint-posttool hook (Layer 2 of the sandbox UX work).
 *
 * Hook contract:
 *   stdin:  PostToolUse JSON event { tool_name, tool_response, ... }
 *   stdout: optional JSON
 *             {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *              "additionalContext":"..."}}
 *   exit:   0 always.
 *
 * Tests spawn the hook as a subprocess (mirroring how Claude Code invokes
 * it), feed a tool_response, and assert whether additionalContext was
 * emitted and that it carries the load-bearing strings the agent needs.
 */

import { describe, it, expect } from 'bun:test'
import { join } from 'path'
import { spawnSync } from 'child_process'

const HOOK_SCRIPT = join(import.meta.dir, '..', 'hooks', 'sandbox-hint-posttool.mjs')

function runHook(event: object) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: process.env,
    timeout: 5_000,
  })
  return result
}

function parseContext(stdout: string): string | null {
  if (!stdout.trim()) return null
  const parsed = JSON.parse(stdout)
  return parsed?.hookSpecificOutput?.additionalContext ?? null
}

describe('sandbox-hint-posttool', () => {
  it('emits sandbox hint when tool_response contains EROFS', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_use_id: 'toolu_001',
      tool_response: {
        error: "EROFS: read-only file system, open '/opt/switchroom/skills/foo.md'",
      },
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('Sandbox boundary hit')
    expect(ctx).toContain('operator action')
    expect(ctx).toContain('Writable paths')
  })

  it('emits sandbox hint when tool_response contains "Read-only file system"', () => {
    const result = runHook({
      tool_name: 'Edit',
      tool_use_id: 'toolu_002',
      tool_response: 'mkdir: cannot create directory: Read-only file system',
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).toContain('Sandbox boundary hit')
  })

  it('emits an apt-specific hint when tool_response shows dpkg permission denied', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_003',
      tool_response: {
        exit_code: 100,
        stderr:
          'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?',
      },
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).toContain('docker/Dockerfile.agent')
    expect(ctx).toContain('rebuild')
  })

  it('emits a hint for EACCES on a rootfs path', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_004',
      tool_response: 'npm ERR! EACCES: permission denied, mkdir "/usr/lib/node_modules/foo"',
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).toContain('Sandbox boundary hit')
  })

  it('emits nothing when tool_response is a normal success', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_005',
      tool_response: { stdout: 'hello world\n', exit_code: 0 },
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('emits nothing when tool_response merely mentions /usr but is not a sandbox error', () => {
    // Guard against false positives — the agent may legitimately discuss
    // paths under /usr in normal output (e.g. `which node` returning
    // /usr/local/bin/node). Only EACCES / EROFS patterns should trigger.
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_006',
      tool_response: { stdout: '/usr/local/bin/node\n' },
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('exits 0 on malformed stdin without crashing', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: 'not json at all',
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('exits 0 on empty stdin', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('caps the scan window for huge tool_response payloads', () => {
    // 100 KiB of harmless output followed by an EROFS — we cap at 64 KiB
    // so this should NOT match. Keeps a runaway tool_response from
    // pinning the hook on a regex scan. The exit_code is set so the
    // failure-classifier reaches the scan path — without it, #1303's
    // success-gate would return early for a different reason.
    const huge = 'x'.repeat(100 * 1024) + ' EROFS happened'
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_007',
      tool_response: { exit_code: 1, stdout: huge },
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  // #1303 — the hook used to fire on every tool whose payload merely
  // MENTIONED EROFS / read-only-fs / EACCES /usr / dpkg, regardless of
  // whether the tool actually failed. Concrete repro: reading a file
  // whose content describes the sandbox model triggered the advisory
  // every time. Fix: classify tool_response as success-or-failure FIRST
  // (only failures can have hit a kernel boundary), AND gate on
  // write-capable tools only (Read/Grep/Glob can't EROFS).
  describe('#1303 — false-positive guard', () => {
    it('does NOT emit when a Read on a file MENTIONS EROFS (Read is not write-capable)', () => {
      const result = runHook({
        tool_name: 'Read',
        tool_use_id: 'toolu_fp_read',
        // Realistic: an Edit on a file whose Read returns content that
        // happens to talk about the sandbox model. Pre-fix this fired.
        tool_response: {
          file: '/state/agent/home/some-doc.md',
          content:
            '# Sandbox notes\n\nWhen a write hits EROFS we say "Read-only file system".\n',
        },
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
    })

    it('does NOT emit when a Grep finds a line containing "Read-only file system"', () => {
      const result = runHook({
        tool_name: 'Grep',
        tool_use_id: 'toolu_fp_grep',
        tool_response: { stdout: 'docs/sandbox.md:42: Read-only file system semantics' },
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
    })

    it('does NOT emit when a successful Bash mentions EROFS in stdout (exit_code=0)', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_use_id: 'toolu_fp_bash_success',
        tool_response: {
          exit_code: 0,
          stdout: 'I tested EROFS handling: all good.',
        },
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
    })

    it('does NOT emit when a successful Edit echoes new content containing "EROFS"', () => {
      // The Edit tool's tool_response echoes the modified content. If
      // the new content mentions EROFS — e.g. when editing this very
      // hook source — the pre-fix logic fired falsely on every keystroke.
      const result = runHook({
        tool_name: 'Edit',
        tool_use_id: 'toolu_fp_edit_success',
        tool_response: {
          // is_error explicitly false; no error field; no exit_code.
          is_error: false,
          file_path: '/state/agent/home/hook.mjs',
          old_string: '// old',
          new_string: '// new code mentioning EROFS and read-only file system semantics',
        },
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
    })

    it('still emits when an Edit FAILED with is_error=true on a real EROFS', () => {
      const result = runHook({
        tool_name: 'Edit',
        tool_use_id: 'toolu_real_failure',
        tool_response: {
          is_error: true,
          error: "EROFS: read-only file system, open '/opt/switchroom/skills/foo.md'",
        },
      })

      expect(result.status).toBe(0)
      const ctx = parseContext(result.stdout)
      expect(ctx).toContain('Sandbox boundary hit')
    })

    it('still emits when a Bash FAILED with non-zero exit_code and stderr containing EROFS', () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_use_id: 'toolu_real_bash_failure',
        tool_response: {
          exit_code: 1,
          stderr: "mkdir: cannot create directory '/opt/foo': Read-only file system",
          stdout: '',
        },
      })

      expect(result.status).toBe(0)
      const ctx = parseContext(result.stdout)
      expect(ctx).toContain('Sandbox boundary hit')
    })

    it('does NOT emit for tools not in the write-capable allowlist, even on failure-shaped payload', () => {
      // Even a payload that LOOKS like a failure — `is_error: true` —
      // cannot reflect a kernel sandbox hit if the tool isn't write-
      // capable. Read can't EROFS. We refuse to advise.
      const result = runHook({
        tool_name: 'WebFetch',
        tool_use_id: 'toolu_fp_webfetch',
        tool_response: { is_error: true, error: 'EROFS lookalike in HTTP body' },
      })

      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
    })

    it('DOES emit for an MCP tool failure (proxies can write)', () => {
      const result = runHook({
        tool_name: 'mcp__some-server__write_file',
        tool_use_id: 'toolu_mcp_failure',
        tool_response: {
          is_error: true,
          error: 'EROFS: read-only file system on /opt/foo',
        },
      })

      expect(result.status).toBe(0)
      const ctx = parseContext(result.stdout)
      expect(ctx).toContain('Sandbox boundary hit')
    })
  })

  // Direct unit tests on the classifier helper.
  describe('classifyFailure', () => {
    it('returns null for a successful object response', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      expect(mod.__internals.classifyFailure({ exit_code: 0, stdout: 'EROFS mentioned' }))
        .toBeNull()
      expect(mod.__internals.classifyFailure({ is_error: false, content: 'EROFS mentioned' }))
        .toBeNull()
    })

    it('returns a structured-failure for is_error=true', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      const got = mod.__internals.classifyFailure({
        is_error: true,
        error: 'EROFS: ...',
      })
      expect(got?.kind).toBe('structured-failure')
      expect(got?.body).toContain('EROFS')
    })

    it('returns a structured-failure for non-zero exit_code with stderr', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      const got = mod.__internals.classifyFailure({
        exit_code: 1,
        stderr: 'Read-only file system',
        stdout: 'also relevant context',
      })
      expect(got?.kind).toBe('structured-failure')
      // Both stderr and stdout included on failed Bash.
      expect(got?.body).toContain('Read-only file system')
      expect(got?.body).toContain('also relevant context')
    })

    it('treats a bare string as a candidate to scan', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      const got = mod.__internals.classifyFailure('mkdir: Read-only file system')
      expect(got?.kind).toBe('bare-string')
      expect(got?.body).toContain('Read-only file system')
    })

    it('returns null for null / undefined / primitives', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      expect(mod.__internals.classifyFailure(null)).toBeNull()
      expect(mod.__internals.classifyFailure(undefined)).toBeNull()
      expect(mod.__internals.classifyFailure(42)).toBeNull()
    })
  })

  describe('isWriteCapableTool', () => {
    it('returns true for the canonical write tools', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      for (const n of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']) {
        expect(mod.__internals.isWriteCapableTool(n)).toBe(true)
      }
    })

    it('returns false for read-only tools', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      for (const n of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite']) {
        expect(mod.__internals.isWriteCapableTool(n)).toBe(false)
      }
    })

    it('returns true for any MCP tool (proxy writes possible)', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      expect(mod.__internals.isWriteCapableTool('mcp__server__do_thing')).toBe(true)
    })

    it('returns false for empty / non-string', async () => {
      const mod = await import('../hooks/sandbox-hint-posttool.mjs')
      expect(mod.__internals.isWriteCapableTool('')).toBe(false)
      expect(mod.__internals.isWriteCapableTool(null as any)).toBe(false)
      expect(mod.__internals.isWriteCapableTool(undefined as any)).toBe(false)
    })
  })
})
