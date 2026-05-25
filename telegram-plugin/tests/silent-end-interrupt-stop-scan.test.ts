/**
 * Regression guard for #1775 — the deterministic transcript-scan
 * replacement of the silent-end Stop hook's signal source.
 *
 * Pre-fix the hook depended on a gateway-written state file as the
 * block/allow signal. The state file was always written ~175ms AFTER
 * the hook fired (live evidence on clerk 2026-05-25, 12 correlated
 * samples), so the hook never saw its own turn's signal.
 *
 * Post-fix the hook reads `transcript_path` directly and scans the
 * just-finished turn's tool_use entries for a qualifying reply. This
 * test suite pins every branch of the new scan logic — the helper is
 * a pure function (`scanTurnForFinalReply`), so we exercise it with
 * synthetic JSONL fixtures rather than spawning the .mjs subprocess.
 *
 * Each fixture mimics the shapes the live Claude Code transcripts
 * use (verified against clerk's
 * `/state/agent/.claude/projects/.../{session}.jsonl` 2026-05-25).
 */

import { describe, it, expect } from 'vitest'
import {
  scanTurnForFinalReply,
  isFinalAnswerReply,
} from '../hooks/silent-end-scan.mjs'

// ── Fixture builders ────────────────────────────────────────────────

const ENQUEUE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<channel source="switchroom-telegram" chat_id="111" message_id="42">hi</channel>',
})

function assistantToolUse(name: string, input: Record<string, unknown>, opts: { isSidechain?: boolean } = {}) {
  const base = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  }
  if (opts.isSidechain) (base as Record<string, unknown>).isSidechain = true
  return JSON.stringify(base)
}

function assistantText(text: string) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  })
}

function jsonl(...lines: string[]) {
  return lines.join('\n')
}

// ── isFinalAnswerReply parity with TS ───────────────────────────────

describe('isFinalAnswerReply (parity with final-answer-detect.ts)', () => {
  it('done:true → final answer regardless of length/notification', () => {
    expect(isFinalAnswerReply({ text: '', disableNotification: true, done: true })).toBe(true)
  })

  it('disable_notification:false → final answer (the notification-bearing case)', () => {
    expect(isFinalAnswerReply({ text: 'ok', disableNotification: false })).toBe(true)
  })

  it('length ≥ 200 + disable_notification:true → final answer (substantive backstop)', () => {
    expect(isFinalAnswerReply({ text: 'a'.repeat(200), disableNotification: true })).toBe(true)
  })

  it('length 199 + disable_notification:true → interim ack', () => {
    expect(isFinalAnswerReply({ text: 'a'.repeat(199), disableNotification: true })).toBe(false)
  })
})

// ── scanTurnForFinalReply branches ──────────────────────────────────

describe('scanTurnForFinalReply — turn-start anchor', () => {
  it('empty transcript → unknown (caller must fail-open)', () => {
    const r = scanTurnForFinalReply('')
    expect(r.decided).toBe('unknown')
  })

  it('no enqueue line in transcript → unknown', () => {
    const text = jsonl(
      assistantText('hello'),
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ok', disable_notification: false }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('unknown')
    expect(r.reason).toBe('no-turn-start')
  })

  it('multiple enqueues → anchors on the LAST one (queued mid-turn semantics)', () => {
    // First inbound got a long reply BEFORE the second inbound was
    // queued. Scanning anchors on the last enqueue, so the early
    // long reply does NOT count.
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'a'.repeat(500),
        disable_notification: false,
      }),
      ENQUEUE, // second queued inbound
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'ack',
        disable_notification: true,
      }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
  })
})

describe('scanTurnForFinalReply — final-reply detection', () => {
  it('Ken-2026-05-25 repro: ack + plain text answer → block', () => {
    // The exact shape from clerk's msg 12227 slip.
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: "On it — checking the Bloomfield statement, then I'll lay out…",
        disable_notification: true,
      }),
      assistantToolUse('Bash', { command: 'ls' }),
      assistantToolUse('Read', { file_path: '/tmp/x' }),
      assistantText('That was actually your FY25 NOA, not Bloomfield. ' + 'A'.repeat(2200)),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('no-final-reply')
  })

  it('notification-bearing reply → allow', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ok', disable_notification: false }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })

  it('stream_reply done:true → allow even with empty text', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__stream_reply', {
        text: '',
        done: true,
        disable_notification: true,
      }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('final-reply')
  })

  it('long reply mis-marked disable_notification:true → still allow (≥200 chars backstop)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'B'.repeat(500),
        disable_notification: true,
      }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })

  it('short ack followed by long reply → allow (later qualifies)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'on it', disable_notification: true }),
      assistantToolUse('Bash', { command: 'ls' }),
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'Here is the full answer with notification ' + 'C'.repeat(500),
        disable_notification: false,
      }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })
})

describe('scanTurnForFinalReply — silent-marker carve-out', () => {
  it('NO_REPLY → allow', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'NO_REPLY' }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('silent-marker')
  })

  it('NO_REPLY with trailing punctuation → allow (matches gateway tolerance)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'NO_REPLY.' }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })

  it('lowercase no_reply → allow (case-insensitive)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'no_reply' }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })

  it('HEARTBEAT_OK → allow (cron-silence carve-out)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'HEARTBEAT_OK' }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })
})

describe('scanTurnForFinalReply — non-reply tool_use does NOT satisfy', () => {
  it('Bash + Read + Agent(sub-agent dispatch) without reply → block', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('Bash', { command: 'ls' }),
      assistantToolUse('Read', { file_path: '/tmp/x' }),
      assistantToolUse('Agent', { description: 'sub-agent' }),
      assistantText('done thinking, but never called reply'),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
  })

  it('isSidechain:true sub-agent reply does NOT count for parent', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse(
        'mcp__switchroom-telegram__reply',
        { text: 'sub-agent answer', disable_notification: false },
        { isSidechain: true },
      ),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('no-final-reply')
  })
})

describe('scanTurnForFinalReply — malformed input tolerance', () => {
  it('malformed JSON lines interleaved → skipped, decision matches the well-formed ones', () => {
    const text = jsonl(
      'this is not json',
      '{partial',
      ENQUEUE,
      'another bad line',
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ok', disable_notification: false }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })

  it('lines starting with non-`{` → skipped quickly (perf guard)', () => {
    const text = jsonl(
      '# this is a comment',
      'random plaintext',
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'NO_REPLY' }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('allow')
  })

  it('assistant line with non-array content is tolerated → no crash', () => {
    const text = jsonl(
      ENQUEUE,
      JSON.stringify({ type: 'assistant', message: { content: null } }),
      JSON.stringify({ type: 'assistant', message: { content: 'a string somehow' } }),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('block')
  })
})
