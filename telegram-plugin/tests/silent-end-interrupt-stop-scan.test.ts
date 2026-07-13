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
  endsWithSilentMarker,
} from '../hooks/silent-end-scan.mjs'

// ── Fixture builders ────────────────────────────────────────────────

const ENQUEUE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<channel source="switchroom-telegram" chat_id="111" message_id="42">hi</channel>',
})

// Cron-fired turn: the enqueue envelope carries `source="cron"` (#2053).
const ENQUEUE_CRON = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<channel source="cron" chat_id="111" message_thread_id="7">Time for the digest</channel>',
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

  it('Option A: block result carries pendingText = the undelivered answer prose (#3227)', () => {
    // The transcript-prose bridge: a turn that ends with a substantive answer
    // written as plain text (no reply tool) must surface that prose so the
    // gateway can deliver it directly on the first silent-end.
    const answer = 'That was actually your FY25 NOA, not Bloomfield. ' + 'A'.repeat(2200)
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: "On it — checking…",
        disable_notification: true,
      }),
      assistantToolUse('Bash', { command: 'ls' }),
      assistantText(answer),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('no-final-reply')
    expect(r.pendingText).toBe(answer)
  })

  it('Option A: zero-outbound turn with a long plain-text answer → pendingText set', () => {
    const answer = 'Here is the whole answer the model forgot to send. ' + 'Z'.repeat(400)
    const text = jsonl(ENQUEUE, assistantText(answer))
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('no-final-reply')
    expect(r.pendingText).toBe(answer)
  })

  it('Option A: trailing-text-after-reply block carries only the trailing prose (#3227)', () => {
    const trailing = 'The real verdict the model wrote but never re-sent. ' + 'T'.repeat(400)
    const text = jsonl(
      ENQUEUE,
      assistantText('some narration before the delivered answer'),
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'delivered answer, notification-bearing',
        disable_notification: false,
      }),
      assistantText(trailing),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('trailing-text-after-reply')
    // Only the prose AFTER the last delivery event — not the pre-reply narration.
    expect(r.pendingText).toBe(trailing)
  })

  it('Option A: a SHORT trailing/only fragment does NOT set pendingText (substance floor)', () => {
    // A genuinely empty-ish turn: a short plain-text closer under the 200-char
    // floor must not be re-delivered as if it were the answer.
    const text = jsonl(ENQUEUE, assistantText('ok done, let me know if you need anything else'))
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.pendingText).toBeUndefined()
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

// ── "at least once" bug regression — trailing content after an early
//    qualifying reply must still block ────────────────────────────────

describe('scanTurnForFinalReply — trailing undelivered content after an early qualifying reply (bug repro)', () => {
  it('early notification-bearing ack + later substantive plain text → block (not "reply called once" amnesty)', () => {
    // Repro of the confirmed incident: the agent (1) got a background-task
    // notification, (2) called reply ONCE early with a short, stale ack —
    // notification-bearing (disable_notification unset/false), which
    // ALWAYS qualifies as "final" under isFinalAnswerReply regardless of
    // text length — then (3) wrote a large substantive verdict as plain
    // assistant text with NO second reply call. The pre-fix scan returned
    // 'allow' on the first qualifying block and never looked further; the
    // fix must walk the whole turn and catch the undelivered trailing text.
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'running now' }),
      assistantToolUse('Bash', { command: 'ls' }),
      assistantToolUse('Read', { file_path: '/tmp/x' }),
      assistantText('Here is the actual verdict after investigation: ' + 'X'.repeat(300)),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('trailing-text-after-reply')
    // turnKey/chatId must still be populated so the gateway's retry
    // bookkeeping works exactly as it does for the zero-reply block path.
    expect(r.chatId).toBe('111')
    expect(r.turnKey).toBe('111:_')
  })

  it('early qualifying reply + trailing SHORT pleasantry → allow (#2956 review: substance floor, no-spam)', () => {
    // A short trailing text after a delivered reply (a closer like "let me
    // know if you need anything else.") is NOT a dropped answer — it's a
    // pleasantry the persona prompts discourage but which must not burn
    // retry budget or force a redundant second reply. Only SUBSTANTIVE
    // trailing text (≥ FINAL_ANSWER_MIN_CHARS) blocks. Pre-fix this
    // false-positive blocked and re-prompted a healthy turn.
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ok', disable_notification: false }),
      assistantText('actually, one more thing you should know'),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
  })

it('early qualifying reply + trailing SUBSTANTIVE undelivered text (≥ floor) → block (at-least-once holds)', () => {
    // The substance floor must NOT weaken the at-least-once guarantee for
    // a real dropped answer: a long trailing verdict the model forgot to
    // send still blocks. The trailing text here clears FINAL_ANSWER_MIN_CHARS.
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ok', disable_notification: false }),
      assistantText('Here is the actual verdict after investigation: ' + 'X'.repeat(200)),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('trailing-text-after-reply')
  })

  it('final qualifying reply is the LAST content block → allow (healthy shape, no false positive)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantText('Let me check that.'),
      assistantToolUse('Bash', { command: 'ls' }),
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'Here is your answer.',
        disable_notification: false,
      }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('final-reply')
  })

  it('turn ends on a tool_result with no trailing text at all → allow (not a normal-turn false positive)', () => {
    // A turn whose very last assistant content is the delivering
    // reply tool_use, followed only by a (user-role) tool_result line —
    // never any further assistant text. Must not be flagged.
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'Done — here is the summary.',
        disable_notification: false,
      }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('final-reply')
  })

  it('undelivered text sandwiched between two qualifying replies is superseded by the LATER reply → allow', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'first answer', disable_notification: false }),
      assistantText('actually let me reconsider that'),
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'corrected final answer', disable_notification: false }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('final-reply')
  })

  it('explicit trailing NO_REPLY after an earlier qualifying reply overrides → allow (intentional final silence)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'draft answer', disable_notification: false }),
      assistantText('actually, scrap that, nothing more to add\nNO_REPLY'),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('silent-marker-text')
  })

  it('reverse case: an EARLIER NO_REPLY silence marker followed by later undelivered prose → block', () => {
    // Mirror image of the "trailing NO_REPLY overrides" allow-case above.
    // Here the model signals silence FIRST — as plain transcript text,
    // not through the reply tool — and then keeps going, writing a real
    // substantive answer afterward that it never sent through `reply` or
    // `stream_reply`. The NO_REPLY marker is a "deliver" event (silence is
    // a valid outcome), but it must not amnesty content written AFTER it,
    // same failure shape as the original "at least once" bug: a naive scan
    // that stops at the FIRST qualifying delivery/silence event would
    // return 'allow' here and the trailing answer would be silently
    // dropped. The fix's "last delivery event, then check for trailing
    // text" walk must still catch this.
    const text = jsonl(
      ENQUEUE,
      assistantText('Nothing to report right now.\nNO_REPLY'),
      assistantToolUse('Bash', { command: 'ls' }),
      assistantText('Wait, actually I found something you need to know: ' + 'Y'.repeat(300)),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.reason).toBe('trailing-text-after-reply')
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

describe('scanTurnForFinalReply — envelope-derived turnKey (block result)', () => {
  it('block carries turnKey/chatId/threadId parsed from the enqueue envelope', () => {
    const enq = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<channel source="switchroom-telegram" chat_id="abc" message_thread_id="42" message_id="9">hi</channel>',
    })
    const text = jsonl(
      enq,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ack', disable_notification: true }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.chatId).toBe('abc')
    expect(r.threadId).toBe(42)
    expect(r.turnKey).toBe('abc:42')
  })

  it("DM (no message_thread_id) → turnKey uses '_' sentinel matching chatKey()", () => {
    // chatKey() at telegram-plugin/gateway/chat-key.ts:46 returns
    // `${chatId}:_` when threadId is missing/0. This must match.
    const r = scanTurnForFinalReply(
      jsonl(ENQUEUE, assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ack', disable_notification: true })),
    )
    expect(r.decided).toBe('block')
    expect(r.turnKey).toBe('111:_')
    expect(r.chatId).toBe('111')
    expect(r.threadId).toBeNull()
  })

  it('allow result does NOT need turnKey (only block path writes the state file)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', { text: 'ok', disable_notification: false }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.turnKey).toBeUndefined()
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

// ── #2053 — endsWithSilentMarker helper ─────────────────────────────

describe('endsWithSilentMarker (#2053)', () => {
  it('bare marker (whole string) → true', () => {
    expect(endsWithSilentMarker('NO_REPLY')).toBe(true)
    expect(endsWithSilentMarker('HEARTBEAT_OK')).toBe(true)
  })
  it('prose then trailing bare NO_REPLY → true', () => {
    expect(endsWithSilentMarker('Nothing actionable in the digest today.\nNO_REPLY')).toBe(true)
    expect(endsWithSilentMarker('Long\nmulti-line\nsummary.\nHEARTBEAT_OK')).toBe(true)
  })
  it('trailing marker with stray punctuation → true', () => {
    expect(endsWithSilentMarker('done reviewing.\nNO_REPLY.')).toBe(true)
  })
  it('marker buried mid-output with real content after → false', () => {
    expect(endsWithSilentMarker('NO_REPLY\nThe answer is 42.')).toBe(false)
  })
  // Documents the intentional divergence from the TS-side helper: this
  // .mjs uses SILENT_MARKER_RE directly (unlimited trailing punctuation),
  // whereas turn-flush-safety.ts delegates to the length-capped,
  // single-punct isSilentFlushMarker. This side is deliberately the more
  // permissive of the two — extra leniency only ever suppresses more.
  it('trailing marker with multiple punctuation chars → true (more permissive than TS side)', () => {
    expect(endsWithSilentMarker('all quiet.\nNO_REPLY...')).toBe(true)
    expect(endsWithSilentMarker('NO_REPLY!!!')).toBe(true)
    expect(endsWithSilentMarker('NO_REPLY?!')).toBe(true)
  })
  it('genuine prose mentioning NO_REPLY as a substring → false', () => {
    expect(endsWithSilentMarker('reply with exactly NO_REPLY if there is nothing to add')).toBe(false)
  })
  it('non-strings / empty → false', () => {
    expect(endsWithSilentMarker(undefined)).toBe(false)
    expect(endsWithSilentMarker('')).toBe(false)
    expect(endsWithSilentMarker('   \n  ')).toBe(false)
  })
})

// ── #2053 — prose-then-trailing-NO_REPLY recognised as silent ───────

describe('scanTurnForFinalReply — trailing NO_REPLY is a valid silent end (#2053)', () => {
  it('(a) plain assistant TEXT ending with a trailing bare NO_REPLY → allow', () => {
    // The exact #2053 leak shape: the model wrote prose then a bare
    // NO_REPLY as plain transcript text (NOT through the reply tool).
    // Pre-fix this matched nothing → block → nag → sentinel leak.
    const text = jsonl(
      ENQUEUE,
      assistantText("Reviewed the overnight digest — nothing needs your attention.\nNO_REPLY"),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('silent-marker-text')
  })

  it('reply-tool payload of prose+trailing NO_REPLY → allow (silent-marker)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'Checked the build — all green.\nNO_REPLY',
        disable_notification: true,
      }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('silent-marker')
  })

  it('plain text NOT ending with a marker → still block', () => {
    const text = jsonl(
      ENQUEUE,
      assistantText('Here is my real answer that I forgot to send via the reply tool.'),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('block')
  })
})

// ── #2053 — cron-source turns skip the nag ──────────────────────────

describe('scanTurnForFinalReply — cron-source turns skip the nag (#2053)', () => {
  it('(b) cron turn with no qualifying reply → allow (cron-source), not block', () => {
    const text = jsonl(
      ENQUEUE_CRON,
      assistantText('Ran the scheduled check. Nothing to report.'),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('cron-source')
  })

  it('cron turn that DID send a real reply → allow (final-reply), reply still wins', () => {
    const text = jsonl(
      ENQUEUE_CRON,
      assistantToolUse('mcp__switchroom-telegram__reply', {
        text: 'Daily digest: 3 PRs merged, 1 incident.',
        disable_notification: false,
      }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('allow')
    expect(r.reason).toBe('final-reply')
  })

  it('non-cron (telegram) turn with no reply → still blocks (cron carve-out scoped)', () => {
    const text = jsonl(
      ENQUEUE,
      assistantText('I forgot to send my answer.'),
    )
    expect(scanTurnForFinalReply(text).decided).toBe('block')
  })
})
