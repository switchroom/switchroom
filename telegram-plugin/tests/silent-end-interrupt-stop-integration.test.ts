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

  it('blocks + writes retryCount=1 when an early qualifying reply is followed by an undelivered verdict (trailing-content bug repro)', () => {
    // Confirmed-incident shape: (1) a background-task notification
    // arrives, (2) the agent calls reply ONCE early with a stale,
    // notification-bearing ack ("running now" — disable_notification
    // unset, so it satisfies isFinalAnswerReply regardless of length),
    // (3) the agent then does more work and writes a large substantive
    // verdict as plain assistant text with NO second reply call. Pre-fix,
    // the hook's "reply called at least once this turn" check allowed
    // this to slip through silently — the trailing verdict never reached
    // the user. Post-fix the hook must block on this shape exactly like
    // the zero-reply case.
    const transcript = writeTranscript(tmp, [
      ENQUEUE,
      reply('running now'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x' } }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Here is the actual verdict: ' + 'X'.repeat(300) }] },
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
    const statePath = join(stateDir, 'silent-end-pending.json')
    expect(existsSync(statePath)).toBe(true)
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(state.retryCount).toBe(1)
    expect(state.chatId).toBe('111')
    expect(state.turnKey).toBe('111:_')
  })

  it('does NOT false-positive on a normal single-reply turn ending on the reply tool_use', () => {
    const transcript = writeTranscript(tmp, [
      ENQUEUE,
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me check.' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
      reply('Here is your answer.', { disable_notification: false }),
    ])
    const r = runHook({
      event: { session_id: 's1', transcript_path: transcript },
      stateDir,
    })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(existsSync(join(stateDir, 'silent-end-pending.json'))).toBe(false)
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

  // ── Single-writer election (duplicate-message fix) ─────────────────
  describe('single-writer election end-to-end', () => {
    function writeFreshHeartbeat() {
      writeFileSync(join(stateDir, 'gateway-heartbeat'), String(Date.now()), 'utf8')
    }

    it('zero-reply ≥200 + FRESH gateway heartbeat → ALLOW (no block re-prompt), state file still written for the flush', () => {
      // The duplicate repro: today this BLOCKS *and* the gateway flush fires →
      // two messages. With a fresh heartbeat the election ALLOWS the stop so
      // the gateway flush is the single writer.
      writeFreshHeartbeat()
      const transcript = writeTranscript(tmp, [
        ENQUEUE,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(300) }] } },
      ])
      const r = runHook({ event: { session_id: 's1', transcript_path: transcript }, stateDir })
      expect(r.status).toBe(0)
      // ALLOW → no block JSON on stdout.
      expect(r.stdout.trim()).toBe('')
      expect(r.stderr).toMatch(/single-writer election ALLOWED/)
      // State file IS written so the gateway's captured-prose bridge has its
      // input (turnKey/turnId/pendingText); retryCount stays 0 (not a re-prompt).
      const statePath = join(stateDir, 'silent-end-pending.json')
      expect(existsSync(statePath)).toBe(true)
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      expect(state.retryCount).toBe(0)
      expect(state.turnKey).toBe('111:_')
      expect(state.pendingText).toBe('A'.repeat(300))
    })

    it('zero-reply ≥200 + STALE/missing heartbeat → BLOCK (never allow into a possibly-dead gateway)', () => {
      // No heartbeat file → the liveness gate forces today's BLOCK behaviour.
      const transcript = writeTranscript(tmp, [
        ENQUEUE,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(300) }] } },
      ])
      const r = runHook({ event: { session_id: 's1', transcript_path: transcript }, stateDir })
      expect(r.status).toBe(0)
      expect(JSON.parse(r.stdout).decision).toBe('block')
      const state = JSON.parse(readFileSync(join(stateDir, 'silent-end-pending.json'), 'utf8'))
      expect(state.retryCount).toBe(1)
    })

    it('retryCount>0 (prior failed delivery) + fresh heartbeat → BLOCK (preserve #3228 send-failure net)', () => {
      writeFreshHeartbeat()
      // Seed a prior state file with retryCount=1 (a delivery already failed).
      writeFileSync(
        join(stateDir, 'silent-end-pending.json'),
        JSON.stringify({ chatId: '111', threadId: null, turnKey: '111:_', retryCount: 1, timestamp: Date.now() }),
        'utf8',
      )
      const transcript = writeTranscript(tmp, [
        ENQUEUE,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(300) }] } },
      ])
      const r = runHook({ event: { session_id: 's1', transcript_path: transcript }, stateDir })
      expect(r.status).toBe(0)
      // retryCount was 1 → not the exhaustion boundary (MAX=2) → still blocks,
      // and the election does NOT allow (retry-ladder-in-flight).
      expect(JSON.parse(r.stdout).decision).toBe('block')
    })
  })
})
