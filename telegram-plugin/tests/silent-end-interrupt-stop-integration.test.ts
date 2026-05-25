/**
 * Integration test for the silent-end Stop hook .mjs.
 *
 * Spawns the real script as a subprocess with a synthetic transcript
 * on disk and the Stop event JSON on stdin. Pins the contract that
 * matters at the hook boundary: stdout JSON shape, exit code,
 * retry-count side-effect on the state file.
 *
 * Complements `silent-end-interrupt-stop-scan.test.ts` (which pins
 * the pure helper in isolation). This test guards against
 * regressions in:
 *   - stdin parsing
 *   - transcript_path file IO + fail-open on read errors
 *   - state-file retry-count increment
 *   - retry-budget exhaustion → allow
 *   - block-decision stdout shape
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { SILENT_END_MAX_RETRIES } from '../silent-end.js'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HOOK_PATH = resolve(
  __dirname,
  '..',
  'hooks',
  'silent-end-interrupt-stop.mjs',
)

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

function runHook(input: { event: object; stateDir: string }): RunResult {
  const r = spawnSync('node', [HOOK_PATH], {
    input: JSON.stringify(input.event),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, TELEGRAM_STATE_DIR: input.stateDir },
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function writeTranscript(dir: string, lines: object[]): string {
  const p = join(dir, 'transcript.jsonl')
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  return p
}

const ENQUEUE = {
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<channel source="switchroom-telegram" chat_id="111" message_id="42">hi</channel>',
}

function reply(text: string, opts: { disable_notification?: boolean; done?: boolean } = {}) {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'mcp__switchroom-telegram__reply',
          input: { text, ...opts },
        },
      ],
    },
  }
}

describe('silent-end-interrupt-stop.mjs — integration', () => {
  let tmp: string
  let stateDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'silent-end-hook-'))
    stateDir = join(tmp, 'state')
    mkdirSync(stateDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('allows stop when transcript shows a notification-bearing reply', () => {
    const transcript = writeTranscript(tmp, [
      ENQUEUE,
      reply('ok', { disable_notification: false }),
    ])
    const r = runHook({
      event: { session_id: 's1', transcript_path: transcript },
      stateDir,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(existsSync(join(stateDir, 'silent-end-pending.json'))).toBe(false)
  })

  it("blocks + writes retryCount=1 when transcript shows ack-only (Ken's repro)", () => {
    const transcript = writeTranscript(tmp, [
      ENQUEUE,
      reply('on it — checking now', { disable_notification: true }),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      // 2237-char answer as plain text, no reply tool
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'A'.repeat(2237) }] },
      },
    ])
    const r = runHook({
      event: { session_id: 's1', transcript_path: transcript },
      stateDir,
    })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.decision).toBe('block')
    expect(out.reason).toMatch(/Send your final answer/)
    expect(out.reason).toMatch(/NO_REPLY/)
    // Retry-count file was written.
    const statePath = join(stateDir, 'silent-end-pending.json')
    expect(existsSync(statePath)).toBe(true)
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.retryCount).toBe(1)
    // Reviewer-flagged regression: the hook's state-file write MUST
    // include turnKey + chatId derived from the enqueue envelope. Without
    // these, the gateway's later `recordSilentTurnEnd` write (~175ms after
    // the hook) sees a turnKey mismatch and resets retryCount to 0,
    // doubling the effective re-prompt budget. The shape here must match
    // `chatKey(chatId, threadId)` at telegram-plugin/gateway/chat-key.ts:46.
    expect(state.chatId).toBe('111')
    expect(state.turnKey).toBe('111:_')
  })

  it('preserves retryCount across the hook→gateway write order (reviewer regression)', () => {
    // Simulates what happens on the gateway side once it runs its own
    // `writeSilentEndState` ~175ms after the hook: it reads the hook's
    // file, sees matching turnKey, preserves retryCount. Then the next
    // `recordSilentTurnEnd` call sees retryCount=1 >= MAX_RETRIES=1 and
    // returns exhausted — the design budget. Without matching turnKey
    // this branch never fires on time and the budget doubles.
    const transcript = writeTranscript(tmp, [
      ENQUEUE,
      reply('on it', { disable_notification: true }),
    ])
    const r = runHook({
      event: { session_id: 's1', transcript_path: transcript },
      stateDir,
    })
    expect(r.status).toBe(0)
    const statePath = join(stateDir, 'silent-end-pending.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.turnKey).toBe('111:_')
    expect(state.retryCount).toBe(1)
  })

  it('allows stop when retry budget already exhausted (retryCount >= MAX_RETRIES)', () => {
    const transcript = writeTranscript(tmp, [
      ENQUEUE,
      // Still no final reply, BUT retry already spent — gateway will
      // post the user-facing fallback so the user isn't left silent.
      reply('ack', { disable_notification: true }),
    ])
    const statePath = join(stateDir, 'silent-end-pending.json')
    // Use the canonical ceiling so this test stays accurate as MAX_RETRIES evolves.
    writeFileSync(statePath, JSON.stringify({
      retryCount: SILENT_END_MAX_RETRIES, chatId: '111',
    }), 'utf8')

    const r = runHook({
      event: { session_id: 's1', transcript_path: transcript },
      stateDir,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(r.stderr).toMatch(/retry exhausted/)
    // State unchanged.
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.retryCount).toBe(SILENT_END_MAX_RETRIES)
  })

  it('NO_REPLY in transcript → allow stop, no state file written', () => {
    const transcript = writeTranscript(tmp, [
      ENQUEUE,
      reply('NO_REPLY'),
    ])
    const r = runHook({
      event: { session_id: 's1', transcript_path: transcript },
      stateDir,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(existsSync(join(stateDir, 'silent-end-pending.json'))).toBe(false)
  })

  it('fail-open when transcript_path missing from event', () => {
    const r = runHook({
      event: { session_id: 's1' },
      stateDir,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('fail-open when transcript_path does not exist on disk', () => {
    const r = runHook({
      event: { session_id: 's1', transcript_path: '/does/not/exist.jsonl' },
      stateDir,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('fail-open on malformed stdin', () => {
    const r = spawnSync('node', [HOOK_PATH], {
      input: 'this is not JSON',
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('empty stdin → exit 0 immediately', () => {
    const r = spawnSync('node', [HOOK_PATH], {
      input: '',
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })
})
