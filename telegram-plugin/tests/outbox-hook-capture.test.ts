/**
 * outbox-hook-capture.test.ts — behavioural RED replay of the 2026-07-22
 * incident at the real Stop-hook boundary. Spawns
 * `hooks/silent-end-interrupt-stop.mjs` as a subprocess with a synthetic
 * task-notification-shaped transcript that ends with a 1,647-char plain-text
 * final answer and no reply tool call — the exact shape whose answer was
 * silently lost — and asserts the hook writes exactly one durable outbox record
 * to `$TELEGRAM_STATE_DIR/outbox/` and allows the stop.
 *
 * Against pre-fix code the hook wrote NO outbox record (the mechanism did not
 * exist) → this test's record-count assertion fails RED. Post-fix → green.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HOOK = resolve(__dirname, '..', 'hooks', 'silent-end-interrupt-stop.mjs')

function runHook(event: object, stateDir: string) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
  })
}

function transcript(dir: string, lines: object[]): string {
  const p = join(dir, 'transcript.jsonl')
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  return p
}

function outboxRecords(dir: string): object[] {
  const outbox = join(dir, 'outbox')
  let files: string[]
  try {
    files = readdirSync(outbox).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  return files.map((f) => JSON.parse(readFileSync(join(outbox, f), 'utf8')))
}

describe('Stop hook — outbox capture (incident replay)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hook-outbox-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const answer = 'B'.repeat(1647)

  it('captures the lost final answer of a task-notification turn to exactly one record', () => {
    const t = transcript(dir, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification><task-id>a7cc7a0fa8f</task-id> worker done</task-notification>',
        timestamp: 1000,
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
    ])
    const r = runHook({ session_id: 's', transcript_path: t }, dir)
    expect(r.status).toBe(0)
    const records = outboxRecords(dir) as Array<{ text: string; chatId: string | null; source: string }>
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe(answer)
    expect(records[0].chatId).toBeNull()
    expect(records[0].source).toBe('task-notification')
  })

  it('writes NO record for a pure NO_REPLY turn', () => {
    const t = transcript(dir, [
      { type: 'queue-operation', operation: 'enqueue', content: '<channel source="telegram" chat_id="1" message_id="2">hi</channel>' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'NO_REPLY' }] } },
    ])
    const r = runHook({ session_id: 's', transcript_path: t }, dir)
    expect(r.status).toBe(0)
    expect(outboxRecords(dir)).toHaveLength(0)
  })

  it('capture is idempotent — a second hook run does not write a duplicate', () => {
    const t = transcript(dir, [
      { type: 'queue-operation', operation: 'enqueue', content: '<channel source="telegram" chat_id="9" message_id="3">q</channel>', timestamp: 1000 },
      { type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
    ])
    runHook({ session_id: 's', transcript_path: t }, dir)
    runHook({ session_id: 's', transcript_path: t }, dir)
    expect(outboxRecords(dir)).toHaveLength(1)
  })
})
