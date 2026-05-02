/**
 * I6 — Turn-flush + replay duplicate-content suppression (#546).
 *
 * THIS FILE IS A REGRESSION-PREVENTION LAYER. See
 * `real-gateway-ipc-lifecycle.test.ts` for the I1–I5 backstory.
 *
 * Bug #546 (resolved by 5bed5b7 — "outbound content-dedup window"):
 * agent emits text → bridge disconnects mid-flight → gateway's
 * turn-flush backstop sends the buffered text as HTML → bridge
 * reconnects → claude-code replays the un-acked stream_reply tool_call
 * with identical content but raw markdown → user sees the same content
 * twice.
 *
 * The fix added `OutboundDedupCache` (telegram-plugin/recent-outbound-
 * dedup.ts), which has 23 unit tests on the cache logic but ZERO
 * integration tests reproducing the full sequence end-to-end. This file
 * closes that gap. Without integration coverage the *bug class* (two
 * paths emitting the same content within a TTL) is still latent
 * anywhere the dedup cache isn't wired.
 *
 * Invariant pinned here:
 *
 *   I6 — When the same multi-line content is emitted twice for the
 *        same chat within the dedup TTL, only ONE outbound lands.
 *        Holds across: bridge cycle in between, format mismatch
 *        (HTML vs markdown), and reactions still finalize correctly.
 *
 * Failure mode if the dedup wiring regresses (e.g. someone removes the
 * cache wire-up in `streamReply` or rolls back recent-outbound-dedup.ts):
 * `recorder.sentTexts(chat).length === 2` and the test fails on the
 * "exactly one outbound" assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100
const REPLY_TEXT =
  'Here is a reply with enough content to clear the 24-char dedup floor — this paragraph is intentionally long to mirror the multi-paragraph replies that bug #546 actually duplicated.'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('I6 — turn-flush + replay duplicate-content suppression (#546)', () => {
  it('two identical send calls within TTL — second is suppressed by dedup (the #546 reproducer)', async () => {
    // fails when: the dedup cache wire-up in real-gateway-harness's
    // send/streamReply path is removed, or recent-outbound-dedup.ts's
    // check() always returns null.
    const h = createRealGatewayHarness({ gapMs: 0, withDedup: true })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'hello' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'hello',
    })
    await h.clock.advance(20)

    const result = await h.simulateRetryDup({ chat_id: CHAT, text: REPLY_TEXT })

    expect(result.suppressedSecond).toBe(true)
    // The bridge cycle uses a REGISTERED agent, so flushOnAgentDisconnect
    // must have run. If this is false, the test is a tautology (the
    // anonymous-skip path bypassed the production helper).
    expect(result.flushRan, 'flushOnAgentDisconnect must run — otherwise the test is a tautology').toBe(true)
    expect(h.recorder.sentTexts(CHAT).filter((t) => t === REPLY_TEXT).length).toBe(1)
    expect(h.dedupSuppressedCount()).toBe(1)
    h.finalize()
  })

  it('content-equal-but-format-differ still dedupes (HTML vs markdown)', async () => {
    // The smoking-gun shape from #546: msg=5025 had `<b>...</b>`,
    // msg=5027 had `**...**`, same content. Dedup must catch this via
    // the `normalizeForDedup` strip step.
    //
    // fails when: normalizeForDedup loses its HTML-tag or markdown-
    // marker stripping (e.g. someone simplifies it to a plain hash).
    //
    // We use `h.send()` (fresh sendMessage every time) rather than
    // `h.streamReply()` (which edits the same message on repeat
    // calls). The bug class is "two SEPARATE messages with the same
    // content", not "two streaming edits of one message."
    const h = createRealGatewayHarness({ gapMs: 0, withDedup: true })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'q' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'q',
    })

    const htmlForm = `<b>Important update:</b> The config file has been regenerated with the new schema layout described in section 4.2 of the migration guide.`
    const mdForm = `**Important update:** The config file has been regenerated with the new schema layout described in section 4.2 of the migration guide.`

    const id1 = await h.send({ chat_id: CHAT, text: htmlForm })
    const id2 = await h.send({ chat_id: CHAT, text: mdForm })
    expect(id1).not.toBeNull()
    expect(id2).toBeNull() // dedup suppressed
    expect(h.recorder.sentTexts(CHAT).length).toBe(1)
    expect(h.dedupSuppressedCount()).toBe(1)
    h.finalize()
  })

  it('content shorter than DEDUP_MIN_CONTENT_LEN (24 chars) is NOT deduped', async () => {
    // Conservative floor: short replies ("ok", "got it", "✅") legitimately
    // recur. Dedup ignores them.
    //
    // fails when: someone tightens the floor below 24 chars without
    // updating tests.
    const h = createRealGatewayHarness({ gapMs: 0, withDedup: true })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'q' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'q',
    })
    const id1 = await h.send({ chat_id: CHAT, text: 'ok' })
    const id2 = await h.send({ chat_id: CHAT, text: 'ok' })
    expect(id1).not.toBeNull()
    expect(id2).not.toBeNull() // NOT deduped — content too short
    expect(h.recorder.sentTexts(CHAT).filter((t) => t === 'ok').length).toBe(2)
    expect(h.dedupSuppressedCount()).toBe(0)
    h.finalize()
  })

  it('after TTL expires, the same content sends again (cache evicts)', async () => {
    // The TTL is bounded — same content sent an hour later should NOT
    // be suppressed. This pins the eviction semantics.
    //
    // fails when: TTL eviction breaks (entries linger forever) or the
    // dedup cache's clock source ignores caller-supplied `now`.
    const h = createRealGatewayHarness({ gapMs: 0, withDedup: true, dedupTtlMs: 1000 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'q' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'q',
    })

    const id1 = await h.send({ chat_id: CHAT, text: REPLY_TEXT })
    expect(id1).not.toBeNull()
    expect(h.recorder.sentTexts(CHAT).filter((t) => t === REPLY_TEXT).length).toBe(1)

    // Advance past the TTL.
    await h.clock.advance(2000)

    const id2 = await h.send({ chat_id: CHAT, text: REPLY_TEXT })
    expect(id2).not.toBeNull() // TTL expired → fresh send allowed
    expect(h.recorder.sentTexts(CHAT).filter((t) => t === REPLY_TEXT).length).toBe(2)
    h.finalize()
  })

  it('without withDedup, duplicate content lands twice (control case — confirms the harness default is back-compat)', async () => {
    // Sanity check: F1–F4 tests don't pass withDedup, and they MUST
    // continue to see every outbound landing as before. If a future
    // change wires dedup unconditionally, this test catches it.
    //
    // fails when: someone makes withDedup default to true, breaking
    // F1–F4 deadline assertions.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'q' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'q',
    })
    const id1 = await h.send({ chat_id: CHAT, text: REPLY_TEXT })
    const id2 = await h.send({ chat_id: CHAT, text: REPLY_TEXT })
    expect(id1).not.toBeNull()
    expect(id2).not.toBeNull() // no dedup, no suppression
    expect(h.recorder.sentTexts(CHAT).filter((t) => t === REPLY_TEXT).length).toBe(2)
    expect(h.dedup).toBeNull()
    h.finalize()
  })
})

// ─── I5 (Bug C) defense-in-depth via dedup ─────────────────────────────
//
// Bug C lives in profiles/_base/start.sh.hbs (a shell script the gateway
// can't run). The actual fix is in the wake-audit sentinel comparison
// logic, not in the gateway. BUT the OBSERVABLE failure is "duplicate
// reply lands in the gateway." If the wake-audit fix regresses, the
// dedup cache should still suppress the duplicate outbound. Defense in
// depth — testable here.
//
// I5 in real-gateway-ipc-lifecycle.test.ts is `.skip`'d pending the
// profile fix; this test is its harness-level companion.
describe('I5(b) — wake-audit respawn duplicate suppressed by dedup defense in depth (Bug C)', () => {
  it('respawn-replay simulation produces only one user-visible reply', async () => {
    // fails when: the dedup wire-up regresses, OR if a wake-audit-style
    // duplicate reply path emerges that bypasses streamReply (e.g. uses
    // raw bot.api.sendMessage). In that case this test still catches
    // the regression by counting outbounds.
    const h = createRealGatewayHarness({ gapMs: 0, withDedup: true })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'morning' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'morning',
    })

    const greeting =
      'Good morning! I noticed you mentioned the deploy yesterday — did the rollback succeed and are you ready to retry, or is there something I can help you investigate first?'

    // First wake-audit fire (legitimate).
    const id1 = await h.send({ chat_id: CHAT, text: greeting })
    expect(id1).not.toBeNull()

    // Simulate the --continue respawn: agent dies (registered disconnect),
    // a fresh agent spawns and re-runs wake-audit, attempts to fire the
    // same greeting again because the marker check was wrong.
    const cid = h.bridgeConnect('agent-x')
    h.bridgeDisconnect(cid)
    await h.clock.advance(50)

    const id2 = await h.send({ chat_id: CHAT, text: greeting })
    expect(id2).toBeNull() // dedup suppressed

    expect(h.recorder.sentTexts(CHAT).filter((t) => t === greeting).length).toBe(1)
    expect(h.dedupSuppressedCount()).toBeGreaterThanOrEqual(1)
    h.finalize()
  })
})
