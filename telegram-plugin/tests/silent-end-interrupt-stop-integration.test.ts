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
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Read the single outbox record the guaranteed-delivery capture writes for a
 * turn that ended with substantive undelivered prose. Returns null when none.
 */
function readOutboxRecord(stateDir: string): { text: string; chatId: string | null; turnNonce: string } | null {
  const dir = join(stateDir, 'outbox')
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'delivered.jsonl')
  } catch {
    return null
  }
  if (files.length !== 1) return null
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
}

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

  it('captures the trailing answer to the outbox + allows when transcript shows ack-only + undelivered verdict (Ken\'s repro, collapsed design)', () => {
    // Collapsed guaranteed-delivery design: an ack followed by a substantive
    // plain-text verdict is now CAPTURED to the durable outbox and the stop is
    // ALLOWED — the gateway sweep is the single deterministic deliverer. The old
    // block/re-prompt (which depended on the model re-replying) is superseded
    // for capturable prose.
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
    expect(r.stdout.trim()).toBe('') // ALLOW — no block re-prompt
    const rec = readOutboxRecord(stateDir)
    expect(rec).not.toBeNull()
    expect(rec!.text).toBe('A'.repeat(2237))
    expect(rec!.chatId).toBe('111')
    expect(rec!.turnNonce).toBe('111:_#42') // shared deriveTurnId nonce (H1)
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

  it('routes the trailing verdict through the single-writer election (NOT the outbox) when an early qualifying reply already delivered (#3510)', () => {
    // Pre-#3510 this shape — (1) inbound, (2) an early notification-bearing
    // (ping-final) reply, (3) a large trailing verdict as plain text — was
    // CAPTURED to the outbox and self-exited, bypassing the #3469 election.
    // Because the ping-final reply is delivered by the gateway but sits under
    // the reply-site journal floor, the sweep then flushed the trailing prose
    // as a SECOND message (the #3510 double-send). Now: a reply already
    // delivered this turn ⇒ NO outbox record; the trailing prose goes through
    // `decideStopHookDisposition`'s 'trailing-text-after-reply' branch, whose
    // captured-prose bridge is the single writer (fresh heartbeat ⇒ elected
    // allow, pendingText persisted as the bridge's input).
    writeFileSync(join(stateDir, 'gateway-heartbeat'), 'hb', 'utf8')
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
    expect(r.stdout.trim()).toBe('') // elected allow — no re-prompt
    expect(r.stderr).toMatch(/replyAlreadyDeliveredThisTurn=true/)
    // No outbox record: the sweep must have nothing to flush as a second message.
    expect(readOutboxRecord(stateDir)).toBeNull()
    // The verdict is handed to the bridge (single writer) via the state file.
    const state = JSON.parse(readFileSync(join(stateDir, 'silent-end-pending.json'), 'utf8'))
    expect(state.pendingText).toBe('Here is the actual verdict: ' + 'X'.repeat(300))
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

    it('zero-reply ≥200 + FRESH gateway heartbeat → CAPTURE + ALLOW (sweep is the single writer)', () => {
      // Collapsed design: the duplicate repro is killed structurally — the
      // trailing prose is captured to the outbox and the stop is allowed. The
      // sweep is the single deterministic deliverer; no election, no re-prompt.
      writeFreshHeartbeat()
      const transcript = writeTranscript(tmp, [
        ENQUEUE,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(300) }] } },
      ])
      const r = runHook({ event: { session_id: 's1', transcript_path: transcript }, stateDir })
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('') // ALLOW
      const rec = readOutboxRecord(stateDir)
      expect(rec).not.toBeNull()
      expect(rec!.text).toBe('A'.repeat(300))
      expect(rec!.turnNonce).toBe('111:_#42')
    })

    it('zero-reply ≥200 + STALE/missing heartbeat → STILL CAPTURE + ALLOW (record persists on disk; swept at next boot — strictly better than block-and-hope)', () => {
      // Capture no longer depends on gateway liveness: even into a possibly-dead
      // gateway the answer is durably captured and swept whenever the gateway is
      // next alive — strictly stronger than the old block-and-hope re-prompt.
      const transcript = writeTranscript(tmp, [
        ENQUEUE,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(300) }] } },
      ])
      const r = runHook({ event: { session_id: 's1', transcript_path: transcript }, stateDir })
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('')
      expect(readOutboxRecord(stateDir)!.text).toBe('A'.repeat(300))
    })

    it('retryCount>0 (prior state) + capturable prose → CAPTURE + ALLOW (nonce-scoped; the outbox journal handles redelivery, not the chat-global counter)', () => {
      writeFreshHeartbeat()
      // A stale chat-global silent-end record must NOT poison the capture of a
      // genuine trailing answer (Defect B fix — retry state no longer gates it).
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
      expect(r.stdout.trim()).toBe('')
      expect(readOutboxRecord(stateDir)!.text).toBe('A'.repeat(300))
    })
  })
})
