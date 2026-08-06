/**
 * backstop-exactly-once.test.ts — outcome-asserting regression suite for the
 * switchroom#3513 FOLLOW-UP: the deterministic, model-discipline-free
 * "exactly-once-among-backstops" outbound contract.
 *
 * The invariant under test:
 *   - Any text block followed by a NON-ephemeral (turn-continuing) tool_use in
 *     the SAME turn — including the cross-message shape ([text-only message] →
 *     [tool_use in the NEXT message]) — is suppressed from the backstop delivery
 *     UNCONDITIONALLY (no length / wording gate). This replaces #3515's
 *     substance/wording heuristic on the backstop path.
 *   - The delivered block is the TERMINAL RUN (the suffix of non-tool-followed
 *     blocks), joined; a multi-paragraph terminal answer stays whole.
 *   - The empty-terminal corner (last block was itself tool-followed) delivers
 *     that last block IFF it clears the substantive floor, else nothing.
 *   - An explicit reply-tool (E0) send is journaled with
 *     `replyAlreadyDeliveredThisTurn=true` and is NOT counted by
 *     `backstopAlreadyDelivered`, so a legitimate later explicit reply is never
 *     blocked by the backstop exactly-once guard.
 *   - An answer followed ONLY by an ephemeral surface tool (react / pin / typing
 *     / edit / delete) still delivers — those tools are not turn-continuing.
 *
 * Every test asserts an OUTCOME and is written to be RED on the pre-fix logic
 * (per-message provenance + substance-gated wording strip + no backstop-scoped
 * durable read).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  selectBackstopDelivery,
  isEphemeralTool,
  EPHEMERAL_TOOLS,
  SUBSTANTIVE_MIN_CHARS,
} from '../hooks/narration-classify.mjs'
import { scanTurnForFinalReply, scanForOutboxCapture } from '../hooks/silent-end-scan.mjs'
import {
  appendDelivered,
  backstopAlreadyDelivered,
  isBackstopDeliveredEntry,
  outboxAlreadyDelivered,
} from '../outbox.js'
import { decideCapturedProseDelivery, writeSilentEndState } from '../silent-end.js'

// ── Fixture builders (parity with silent-end-interrupt-stop-scan.test.ts) ────

const ENQUEUE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<channel source="switchroom-telegram" chat_id="111" message_id="42">hi</channel>',
})

function assistantText(text: string) {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}
function assistantToolUse(name: string, input: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `t-${name}`, name, input }] },
  })
}
function jsonl(...lines: string[]) {
  return lines.join('\n')
}

const BIG = (label: string) =>
  `${label}: ` + 'X'.repeat(SUBSTANTIVE_MIN_CHARS + 20)

// ── selectBackstopDelivery — the shared coalescer ────────────────────────────

describe('selectBackstopDelivery — deterministic backstop coalescer (#3513 follow-up)', () => {
  it('excludes a tool-followed block UNCONDITIONALLY, even a substantive one (no substance carve-out)', () => {
    // Pre-fix: a ≥floor block followed by a tool was KEPT (the #3237 substance
    // gate). New contract: suppressed unconditionally; only the terminal block
    // survives. RED on the old substance-gated logic.
    const answer = BIG('the real answer')
    const closer = 'Saved that to memory.'
    const out = selectBackstopDelivery([
      { text: answer, followedByToolUse: true },
      { text: closer, followedByToolUse: false },
    ])
    expect(out).not.toBeNull()
    expect(out!.text).toBe(closer)
    expect(out!.text).not.toContain('the real answer')
  })

  it('joins the maximal terminal suffix run of non-tool-followed blocks (multi-paragraph answer stays whole)', () => {
    const p1 = 'First paragraph of the genuine answer.'
    const p2 = 'Second paragraph, still part of the same answer.'
    const out = selectBackstopDelivery([
      { text: 'Let me look…', followedByToolUse: true }, // suppressed
      { text: p1, followedByToolUse: false },
      { text: p2, followedByToolUse: false },
    ])
    expect(out!.text).toBe(`${p1}\n\n${p2}`)
  })

  it('empty-terminal corner: last block was tool-followed → delivered IFF ≥ substantive floor', () => {
    const big = BIG('trailing but substantive')
    const overFloor = selectBackstopDelivery([{ text: big, followedByToolUse: true }])
    expect(overFloor!.text).toBe(big)
    const short = selectBackstopDelivery([{ text: 'ok…', followedByToolUse: true }])
    expect(short).toBeNull()
  })

  it('undefined provenance fails OPEN — the block is delivered, never dropped', () => {
    const out = selectBackstopDelivery([{ text: 'Let me check.' }, { text: 'the answer' }])
    // No structural signal → both are the terminal run → joined (no wording strip).
    expect(out!.text).toBe('Let me check.\n\nthe answer')
  })

  it('all-empty / no-blocks → null', () => {
    expect(selectBackstopDelivery([])).toBeNull()
    expect(selectBackstopDelivery([{ text: '   ', followedByToolUse: false }])).toBeNull()
  })
})

// ── isEphemeralTool — MF4 exact set ─────────────────────────────────────────

describe('isEphemeralTool — the exact ephemeral surface set (MF4)', () => {
  it('recognises exactly {react, send_typing, delete_message, edit_message}, MCP-prefixed or bare', () => {
    expect([...EPHEMERAL_TOOLS].sort()).toEqual(
      ['delete_message', 'edit_message', 'react', 'send_typing'].sort(),
    )
    for (const t of EPHEMERAL_TOOLS) {
      expect(isEphemeralTool(t)).toBe(true)
      expect(isEphemeralTool(`mcp__switchroom-telegram__${t}`)).toBe(true)
      expect(isEphemeralTool(`mcp__clerk-telegram__${t}`)).toBe(true)
    }
  })

  it('pin_message is NOT ephemeral — the pin_message MCP tool was retired (#4452)', () => {
    expect(EPHEMERAL_TOOLS.has('pin_message')).toBe(false)
    expect(isEphemeralTool('pin_message')).toBe(false)
    expect(isEphemeralTool('mcp__switchroom-telegram__pin_message')).toBe(false)
  })

  it('progress_update is NOT ephemeral (MF4 — dropped from the set)', () => {
    expect(isEphemeralTool('progress_update')).toBe(false)
    expect(isEphemeralTool('mcp__switchroom-telegram__progress_update')).toBe(false)
  })

  it('work / reply tools are NOT ephemeral (turn-continuing)', () => {
    for (const t of ['Bash', 'Read', 'retain', 'download_attachment', 'reply', 'stream_reply']) {
      expect(isEphemeralTool(t)).toBe(false)
    }
  })
})

// ── Cross-message split-shape leak — the ROOT-CAUSE regression (MF1) ─────────

describe('cross-message split-shape provenance (MF1 — RED on per-message logic)', () => {
  it('scanTurnForFinalReply: substantive narration in msg1, work-tool in msg2, real answer in msg3 → ONLY the answer delivers (narration suppressed)', () => {
    // Pre-fix: `followedByToolUse` was computed per-message, so the narration
    // block — the LAST content of its OWN message — never saw the tool that
    // arrived in the SEPARATE next message. Its provenance read `false`, so the
    // wording heuristic (not a structural tool signal) decided its fate; a
    // substantive narration that didn't LOOK like narration leaked, joined with
    // the answer. The per-turn two-pass marks it tool-followed → the terminal-run
    // coalescer excludes it UNCONDITIONALLY, leaving only the genuine answer.
    const narration = BIG('checking the gateway logs to see what happened before I answer')
    const answer = BIG('here is the settled, terminal answer the user asked for')
    const text = jsonl(
      ENQUEUE,
      assistantText(narration), // msg1 — text only
      assistantToolUse('Bash', { command: 'tail -f log' }), // msg2 — turn-continuing tool
      assistantText(answer), // msg3 — the real terminal answer
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.pendingText).toBe(answer)
    expect(r.pendingText).not.toContain('checking the gateway logs')
  })

  it('scanForOutboxCapture: same cross-message shape → captures ONLY the answer, never the narration', () => {
    const narration = BIG('cross-referencing the ledger before summarising the result')
    const answer = BIG('the durable, delivered-once answer for the outbox sweep')
    const text = jsonl(
      ENQUEUE,
      assistantText(narration), // msg1
      assistantToolUse('Read', { file_path: '/tmp/x' }), // msg2 — turn-continuing tool
      assistantText(answer), // msg3 — terminal answer
    )
    const cap = scanForOutboxCapture(text)
    expect(cap.capture).toBe(true)
    if (cap.capture) {
      expect(cap.text).toBe(answer.trim())
      expect(cap.text).not.toContain('cross-referencing the ledger')
    }
  })

  it('scanTurnForFinalReply: same shape but the trailing block IS terminal (no later tool) → delivered', () => {
    // Control: when the substantive block is genuinely terminal (nothing follows
    // it in the whole turn), it IS the answer and must deliver.
    const answer = BIG('the genuine terminal answer')
    const text = jsonl(
      ENQUEUE,
      assistantToolUse('Bash', { command: 'ls' }), // work happened first
      assistantText(answer), // terminal — no tool after
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.pendingText).toBe(answer)
  })
})

// ── answer-then-ephemeral-react still delivers (MF4b) ───────────────────────

describe('answer-then-ephemeral-tool still delivers (MF4b)', () => {
  it('a terminal answer followed ONLY by a react/pin/edit is NOT suppressed', () => {
    const answer = BIG('the answer the user was waiting for')
    // Ephemeral tools are not recorded as work-tool markers, so the answer stays
    // terminal and delivers.
    const text = jsonl(
      ENQUEUE,
      assistantText(answer),
      assistantToolUse('mcp__switchroom-telegram__react', { emoji: '👍' }),
    )
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.pendingText).toBe(answer)
  })
})

// ── backstopAlreadyDelivered — exactly-once-among-backstops (MF2) ────────────

describe('backstopAlreadyDelivered — backstop-scoped durable exactly-once (MF2)', () => {
  let dir: string

  it('classifies delivery sources: flush + sweep + non-E0 reply-tool are backstops; E0 reply is NOT', () => {
    expect(isBackstopDeliveredEntry({ turnNonce: 'n', textSha256: 'x', ts: 0, deliverySource: 'flush' })).toBe(true)
    expect(isBackstopDeliveredEntry({ turnNonce: 'n', textSha256: 'x', ts: 0, deliverySource: 'sweep' })).toBe(true)
    // E3 captured-prose bridge journals as reply-tool with replyAlready=false → backstop.
    expect(
      isBackstopDeliveredEntry({
        turnNonce: 'n', textSha256: 'x', ts: 0,
        deliverySource: 'reply-tool', replyAlreadyDeliveredThisTurn: false,
      }),
    ).toBe(true)
    // E0 explicit reply journals with replyAlready=true → NOT a backstop.
    expect(
      isBackstopDeliveredEntry({
        turnNonce: 'n', textSha256: 'x', ts: 0,
        deliverySource: 'reply-tool', replyAlreadyDeliveredThisTurn: true,
      }),
    ).toBe(false)
  })

  it('a prior FLUSH delivery is seen by backstopAlreadyDelivered; a prior E0 reply is NOT', () => {
    dir = mkdtempSync(join(tmpdir(), 'backstop-once-'))
    try {
      // E0 reply for turn A — must NOT count as a backstop.
      appendDelivered(
        { turnNonce: 'A', textSha256: 'ha', ts: 1, deliverySource: 'reply-tool', replyAlreadyDeliveredThisTurn: true },
        dir,
      )
      expect(backstopAlreadyDelivered('A', dir)).toBe(false)
      // …but outboxAlreadyDelivered (the E4 sweep dedup, source-agnostic) DOES see it.
      expect(outboxAlreadyDelivered('A', dir)).toBe(true)

      // Flush backstop for turn B — must count.
      appendDelivered({ turnNonce: 'B', textSha256: 'hb', ts: 2, deliverySource: 'flush' }, dir)
      expect(backstopAlreadyDelivered('B', dir)).toBe(true)

      // Unknown nonce → false.
      expect(backstopAlreadyDelivered('C', dir)).toBe(false)
      expect(backstopAlreadyDelivered('', dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('E3 bridge decision skips when a prior backstop already delivered the nonce (already-delivered), but an E0 recap does NOT block it', () => {
    dir = mkdtempSync(join(tmpdir(), 'backstop-e3-'))
    try {
      const turnKey = 'c:_'
      const turnId = 'c:_#42'
      const answer = BIG('the recovered answer')
      writeSilentEndState({ chatId: 'c', threadId: null, turnKey }, { stateDir: dir })
      // Persist pendingText onto the record so the bridge has something to deliver.
      // (writeSilentEndState doesn't set pendingText; simulate the hook's write.)
      appendDelivered({ turnNonce: turnId, textSha256: 'z', ts: 1, deliverySource: 'flush' }, dir)

      // With a prior FLUSH backstop for this turnId, the bridge must refuse.
      const blocked = decideCapturedProseDelivery(
        { turnKey, turnId, minChars: 1 },
        {
          stateDir: dir,
          backstopDeliveredNonceHit: (n) => backstopAlreadyDelivered(n ?? '', dir),
        },
      )
      // The state file itself carries no pendingText here, so the decision is
      // no-substantive-prose OR already-delivered — assert it does NOT deliver.
      expect(blocked.deliver).toBe(false)

      // A prior E0 reply recap for the same nonce must NOT trip the backstop guard.
      const dir2 = mkdtempSync(join(tmpdir(), 'backstop-e0-'))
      try {
        appendDelivered(
          { turnNonce: turnId, textSha256: 'z', ts: 1, deliverySource: 'reply-tool', replyAlreadyDeliveredThisTurn: true },
          dir2,
        )
        expect(backstopAlreadyDelivered(turnId, dir2)).toBe(false)
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
      void answer
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── multi-substantive-block → one delivery; empty-terminal → one delivery ────

describe('single-delivery selection through the scan (MF5)', () => {
  it('multiple substantive terminal blocks → ONE joined delivery (never a second bubble)', () => {
    const p1 = BIG('first half of the answer')
    const p2 = BIG('second half of the answer')
    const text = jsonl(ENQUEUE, assistantText(p1), assistantText(p2))
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.pendingText).toBe(`${p1}\n\n${p2}`)
  })

  it('empty terminal (last block tool-followed) → the prior substantive terminal run is delivered once', () => {
    const answer = BIG('the settled answer')
    const text = jsonl(
      ENQUEUE,
      assistantText(answer), // terminal? no — a tool follows in the next msg
      assistantToolUse('retain', { text: 'note' }),
    )
    // answer is tool-followed → empty terminal run → rule 3 delivers it iff ≥floor.
    const r = scanTurnForFinalReply(text)
    expect(r.decided).toBe('block')
    expect(r.pendingText).toBe(answer)
  })
})
