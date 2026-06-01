/**
 * Tests for telegram-plugin/hooks/sentinel-reply-guard-pretool.mjs (#2053).
 *
 * Defense-in-depth guard on the reply path: a reply / stream_reply call
 * whose entire payload is only the silent sentinel (NO_REPLY /
 * HEARTBEAT_OK) must be DROPPED before it reaches the Telegram chat,
 * regardless of any nag-loop behaviour upstream.
 *
 * Two layers of coverage:
 *   - the pure `isSentinelOnly` predicate (exact-trim match, never a
 *     substring of genuine prose);
 *   - the hook end-to-end as a child process, asserting the PreToolUse
 *     block/allow protocol (decision JSON on stdout).
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

import { isSentinelOnly } from '../hooks/sentinel-reply-guard-pretool.mjs'

const HOOK_PATH = resolve(__dirname, '..', 'hooks', 'sentinel-reply-guard-pretool.mjs')

function runHook(event: unknown): { stdout: string; decision?: { decision?: string; reason?: string } } {
  const res = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  })
  const stdout = res.stdout.trim()
  let decision: { decision?: string; reason?: string } | undefined
  if (stdout) {
    try {
      decision = JSON.parse(stdout)
    } catch {
      decision = undefined
    }
  }
  return { stdout, decision }
}

const REPLY = 'mcp__switchroom-telegram__reply'
const STREAM_REPLY = 'mcp__switchroom-telegram__stream_reply'

describe('isSentinelOnly — exact-trim, never substring (#2053)', () => {
  it('bare NO_REPLY / HEARTBEAT_OK → true', () => {
    expect(isSentinelOnly('NO_REPLY')).toBe(true)
    expect(isSentinelOnly('HEARTBEAT_OK')).toBe(true)
    expect(isSentinelOnly('  NO_REPLY  ')).toBe(true)
    expect(isSentinelOnly('NO_REPLY.')).toBe(true)
  })
  it('repeats of the sentinel → true', () => {
    expect(isSentinelOnly('NO_REPLY\nNO_REPLY')).toBe(true)
    expect(isSentinelOnly('NO_REPLY\nHEARTBEAT_OK\nNO_REPLY')).toBe(true)
  })
  it('(d) genuine prose containing "NO_REPLY" as a substring → false', () => {
    expect(isSentinelOnly('Reply with exactly NO_REPLY if there is nothing to add.')).toBe(false)
    expect(isSentinelOnly('The hook expects NO_REPLY on idle turns — here is your answer.')).toBe(false)
  })
  it('prose then a trailing NO_REPLY line → false (has non-marker content)', () => {
    // The guard is the LAST line of defense and only drops PURE sentinel
    // payloads. A prose+trailing-NO_REPLY blob is handled upstream by the
    // flush gate / Stop-hook scan; if it somehow reaches the reply tool it
    // still carries real prose the user might need, so the guard lets it
    // through rather than silently eating content.
    expect(isSentinelOnly('Here is the summary.\nNO_REPLY')).toBe(false)
  })
  it('non-strings / empty → false', () => {
    expect(isSentinelOnly(undefined as unknown as string)).toBe(false)
    expect(isSentinelOnly('')).toBe(false)
    expect(isSentinelOnly('   ')).toBe(false)
  })
})

describe('sentinel-reply-guard hook — end-to-end (#2053)', () => {
  it('(c) DROPS a sentinel-only reply payload', () => {
    const { decision } = runHook({ tool_name: REPLY, tool_input: { text: 'NO_REPLY' } })
    expect(decision?.decision).toBe('block')
    expect(decision?.reason).toMatch(/sentinel|NO_REPLY/i)
  })

  it('DROPS a sentinel-only stream_reply payload (repeated markers)', () => {
    const { decision } = runHook({ tool_name: STREAM_REPLY, tool_input: { text: 'NO_REPLY\nNO_REPLY' } })
    expect(decision?.decision).toBe('block')
  })

  it('(d) ALLOWS a real reply that mentions NO_REPLY inside prose', () => {
    const { stdout } = runHook({
      tool_name: REPLY,
      tool_input: { text: 'If nothing is pending, reply with exactly NO_REPLY — otherwise summarise.' },
    })
    expect(stdout).toBe('')
  })

  it('ALLOWS an ordinary reply', () => {
    const { stdout } = runHook({ tool_name: REPLY, tool_input: { text: 'Done — the build is green.' } })
    expect(stdout).toBe('')
  })

  it('ignores non-reply tools entirely', () => {
    const { stdout } = runHook({ tool_name: 'Bash', tool_input: { command: 'NO_REPLY' } })
    expect(stdout).toBe('')
  })

  it('fails open on malformed / empty stdin', () => {
    const res = spawnSync('node', [HOOK_PATH], { input: '', encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe('')
  })
})
