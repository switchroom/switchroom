/**
 * outbox-capture-scan.test.ts — the capture half of guaranteed final-message
 * delivery (`work/final-message-delivery/`).
 *
 * Exercises the class-agnostic Stop-hook capture scan (`scanForOutboxCapture`)
 * and the shared nonce (`deriveTurnNonce`) against the adversarial-review
 * oracles: the incident replay (task-notification handback with trailing prose
 * and no reply), same-content re-notification (H2, no nonce collision), cron
 * capture (H5), unknown-anchor fail-closed (H4), and prose + trailing NO_REPLY
 * (H6). Pure functions — no subprocess needed.
 *
 * RED-then-green: these functions are new; against pre-fix code the import
 * resolves to `undefined` and every assertion throws. The hook-subprocess
 * outcome test (`outbox-hook-capture.test.ts`) is the behavioural RED replay.
 */

import { describe, it, expect } from 'vitest'
import {
  scanForOutboxCapture,
  deriveTurnNonce,
  stripTrailingSilentMarker,
} from '../hooks/silent-end-scan.mjs'

const A_LONG = 'x'.repeat(1647) // the incident's 1,647-char final answer shape

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n')
}

function taskNotification(content = 'worker done', taskId = 'a7cc7a0fa8f', ts = 1000): object {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification><task-id>${taskId}</task-id> ${content}</task-notification>`,
    timestamp: ts,
  }
}

function channel(chatId: string, messageId: string, body = 'hi', ts = 1000, source = 'telegram'): object {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<channel source="${source}" chat_id="${chatId}" message_id="${messageId}">${body}</channel>`,
    timestamp: ts,
  }
}

function assistantText(text: string): object {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } }
}

function reply(text: string, opts: Record<string, unknown> = {}): object {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', name: 'mcp__switchroom-telegram__reply', input: { text, ...opts } }],
    },
  }
}

describe('scanForOutboxCapture — incident replay (task-notification handback)', () => {
  it('captures the trailing final answer of a task-notification turn with no reply', () => {
    const t = jsonl([taskNotification(), assistantText(A_LONG)])
    const cap = scanForOutboxCapture(t)
    expect(cap.capture).toBe(true)
    if (cap.capture) {
      expect(cap.text).toBe(A_LONG)
      expect(cap.chatId).toBeNull() // envelope-less → routed at sweep (H3)
      expect(cap.source).toBe('task-notification')
      expect(cap.turnNonce).toBeTruthy()
    }
  })
})

describe('H2 — nonce uniqueness on same-content re-notification', () => {
  it('two identical task-notifications at different timestamps get distinct nonces', () => {
    const c1 = scanForOutboxCapture(jsonl([taskNotification('done', 'task-A', 1000), assistantText(A_LONG)]))
    const c2 = scanForOutboxCapture(jsonl([taskNotification('done', 'task-A', 2000), assistantText('y'.repeat(500))]))
    expect(c1.capture && c2.capture).toBe(true)
    if (c1.capture && c2.capture) expect(c1.turnNonce).not.toBe(c2.turnNonce)
  })

  it('a gateway-visible turn keeps the deriveTurnId nonce shape', () => {
    const cap = scanForOutboxCapture(jsonl([channel('999', '77'), assistantText(A_LONG)]))
    expect(cap.capture).toBe(true)
    if (cap.capture) expect(cap.turnNonce).toBe('999:_#77')
  })
})

describe('H4 — unknown anchor fails CLOSED (still captures)', () => {
  it('captures trailing prose when there is NO queue-operation anchor at all', () => {
    // A future/unknown wake shape: no enqueue line, only a user boundary + prose.
    const t = jsonl([
      { type: 'user', message: { content: 'resume' } },
      assistantText(A_LONG),
    ])
    const cap = scanForOutboxCapture(t)
    expect(cap.capture).toBe(true)
    if (cap.capture) {
      expect(cap.text).toBe(A_LONG)
      expect(cap.source).toBe('unknown')
    }
  })

  it('still captures with no anchor line whatsoever (bare tail)', () => {
    const cap = scanForOutboxCapture(jsonl([assistantText(A_LONG)]))
    expect(cap.capture).toBe(true)
  })
})

describe('H5 — cron turns are captured (no silent-loss carve-out)', () => {
  it('captures a cron turn that ends with substantive prose and no reply', () => {
    const cron = channel('555', '0', 'digest', 3000, 'cron')
    const cap = scanForOutboxCapture(jsonl([cron, assistantText(A_LONG)]))
    expect(cap.capture).toBe(true)
    if (cap.capture) expect(cap.source).toBe('cron')
  })
})

describe('H6 — prose + trailing NO_REPLY must not suppress a real answer', () => {
  it('captures the prose that precedes a stray trailing NO_REPLY', () => {
    const cap = scanForOutboxCapture(jsonl([channel('1', '2'), assistantText(`${A_LONG}\nNO_REPLY`)]))
    expect(cap.capture).toBe(true)
    if (cap.capture) expect(cap.text).toBe(A_LONG)
  })

  it('does NOT capture a pure NO_REPLY turn (legitimately silent)', () => {
    expect(scanForOutboxCapture(jsonl([channel('1', '2'), assistantText('NO_REPLY')])).capture).toBe(false)
  })

  it('does NOT capture a HEARTBEAT_OK-only cron turn', () => {
    expect(
      scanForOutboxCapture(jsonl([channel('5', '0', 'x', 1, 'cron'), assistantText('HEARTBEAT_OK')])).capture,
    ).toBe(false)
  })

  it('does NOT capture when the final answer was delivered via reply', () => {
    expect(scanForOutboxCapture(jsonl([channel('1', '2'), reply(A_LONG)])).capture).toBe(false)
  })

  it('does NOT capture narration-only trailing text', () => {
    expect(scanForOutboxCapture(jsonl([channel('1', '2'), assistantText('Let me check that…')])).capture).toBe(false)
  })
})

describe('interim-ack then undelivered answer (at-least-once)', () => {
  it('captures the substantive answer written after a short interim ack reply', () => {
    const t = jsonl([
      channel('1', '2'),
      reply('on it', { disable_notification: true }),
      assistantText(A_LONG),
    ])
    const cap = scanForOutboxCapture(t)
    expect(cap.capture).toBe(true)
    if (cap.capture) expect(cap.text).toBe(A_LONG)
  })
})

describe('stripTrailingSilentMarker', () => {
  it('strips a trailing bare marker and returns preceding prose', () => {
    expect(stripTrailingSilentMarker('the answer\nNO_REPLY')).toEqual({ prose: 'the answer', hadMarker: true })
  })
  it('reports no marker for plain prose', () => {
    expect(stripTrailingSilentMarker('just prose')).toEqual({ prose: 'just prose', hadMarker: false })
  })
  it('handles a marker-only block', () => {
    expect(stripTrailingSilentMarker('NO_REPLY')).toEqual({ prose: '', hadMarker: true })
  })
})

describe('deriveTurnNonce', () => {
  it('uses the deriveTurnId shape when a message_id is present', () => {
    expect(
      deriveTurnNonce({ chatId: '9', threadId: null, messageId: '3', anchorTimestampMs: 1, anchorContent: 'x' }),
    ).toBe('9:_#3')
  })
  it('threads the thread id into the key', () => {
    expect(
      deriveTurnNonce({ chatId: '9', threadId: 44, messageId: '3', anchorTimestampMs: 1, anchorContent: 'x' }),
    ).toBe('9:44#3')
  })
  it('falls back to a timestamped content hash without a message_id', () => {
    const a = deriveTurnNonce({ chatId: null, threadId: null, messageId: null, anchorTimestampMs: 1, anchorContent: 'x' })
    const b = deriveTurnNonce({ chatId: null, threadId: null, messageId: null, anchorTimestampMs: 2, anchorContent: 'x' })
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
