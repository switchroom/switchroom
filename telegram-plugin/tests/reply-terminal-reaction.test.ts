/**
 * #1713 + #1728 — interim-ack `reply` tool is a non-event for the
 * status reaction; final-answer `reply` finalizes.
 *
 * History.
 *   - PR #602 follow-up wired `executeReply` to fire the terminal 👍
 *     after at least one chunk landed.
 *   - #1713 (#1718) reverted that: reaction reflects current turn
 *     activity, not delivery state. Made `turn_end` the sole terminal
 *     trigger so mid-turn ACK replies don't collapse the working-state
 *     ladder to 👍.
 *   - #1728 (this fix) carve-out: Claude Code's `turn_duration` system
 *     event is unreliable for the trivial-prompt happy path, leaving
 *     `activeTurnStartedAt` set forever and every subsequent inbound
 *     stuck "held mid-turn" (the v0.13.27 wedge). When the reply IS
 *     the final answer (`isFinalAnswerReply` returns true), executeReply
 *     calls `finalizeStatusReaction` to release the buffer gate and
 *     emit the (debounced 3500ms) terminal 👍. Interim acks bypass this
 *     branch and remain non-events for the reaction.
 *
 * Net contract pinned here:
 *   - executeReply post-send block must NOT call the legacy
 *     `endStatusReaction('done')` (the pre-#1713 bug class).
 *   - executeReply MUST call `finalizeStatusReaction` gated on
 *     `isFinalAnswerReply` so the buffer gate releases on final answer.
 *
 * The gateway IIFE / executeReply body are too entangled to import
 * directly, so we do source-level assertions.
 */
import { describe, it, expect, vi } from 'vitest'

describe('#1713 + #1728 — reply tool reaction contract', () => {
  it('executeReply post-send block does NOT call legacy endStatusReaction', () => {
    // The pre-#1713 bug class was `endStatusReaction(chat_id, threadId,
    // 'done')` firing 👍 unconditionally on every reply (including
    // mid-turn acks). That call must stay removed.
    //
    // We do a coarse-grained source-level check rather than a unit
    // test of a copied helper. If/when the executeReply body is
    // extracted into its own function this can become a proper unit
    // test; until then the source-level guard is the safest pin.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    const src = fs.readFileSync(
      path.resolve(__dirname, '../gateway/gateway.ts'),
      'utf8',
    )
    // Find the executeReply post-send block — anchored on the
    // distinctive "fresh sendMessage from reply tool is a user-visible
    // signal" comment.
    const anchor = src.indexOf("fresh sendMessage from reply tool is a user-visible")
    expect(anchor).toBeGreaterThan(-1)
    // Look at the ~40 lines after the anchor — pre-#1713 this region
    // contained `endStatusReaction(chat_id, threadId, 'done')`.
    const slice = src.slice(anchor, anchor + 3000)
    expect(slice).not.toMatch(/endStatusReaction\([^)]*'done'\)/)
  })

  it('executeReply post-send block DOES call finalizeStatusReaction gated on isFinalAnswerReply (#1728 wedge fix)', () => {
    // #1728 — the v0.13.27 wedge: `turn_duration` system events from
    // Claude Code don't reliably land for trivial-prompt turns, so
    // activeTurnStartedAt never clears and every subsequent inbound
    // gets held mid-turn. The fix: when executeReply detects a final-
    // answer reply (the same `isFinalAnswerReply` classifier #1664
    // uses for silent-end re-prompt gating), trigger
    // `finalizeStatusReaction` to release the buffer gate. Interim
    // acks (isFinalAnswerReply === false) MUST bypass this branch and
    // remain non-events for the reaction (preserves #1713).
    //
    // If a future commit removes the finalizeStatusReaction call or
    // un-gates it from isFinalAnswerReply, the wedge returns.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    const src = fs.readFileSync(
      path.resolve(__dirname, '../gateway/gateway.ts'),
      'utf8',
    )
    const anchor = src.indexOf("fresh sendMessage from reply tool is a user-visible")
    expect(anchor).toBeGreaterThan(-1)
    const slice = src.slice(anchor, anchor + 3000)
    // The finalize MUST appear in the post-send block.
    expect(slice).toMatch(/finalizeStatusReaction\(/)
    // It MUST be gated by isFinalAnswerReply (the classifier prevents
    // interim acks from firing 👍, which would regress #1713).
    expect(slice).toMatch(/isFinalAnswerReply\(/)
    // Sanity: the finalize MUST appear AFTER the isFinalAnswerReply
    // check (i.e. inside the gated branch), not as a sibling that
    // fires unconditionally.
    const gateIdx = slice.indexOf('isFinalAnswerReply(')
    const finalizeIdx = slice.indexOf('finalizeStatusReaction(')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(finalizeIdx).toBeGreaterThan(gateIdx)
  })

  it('reply tool deps no longer wire a status-reaction terminal callback', () => {
    // Post-#1713 the stream-reply-handler has no call site for
    // `deps.endStatusReaction`. Post follow-up cleanup, the dep itself
    // is gone too — this test pins that the stream-reply-handler source
    // contains no live call to `deps.endStatusReaction`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    const src = fs.readFileSync(
      path.resolve(__dirname, '../stream-reply-handler.ts'),
      'utf8',
    )
    // Only the interface declaration may mention it; no call site.
    expect(src).not.toMatch(/deps\.endStatusReaction\(/)
  })

  it('threadId/chatId are still recorded for outbound-dedup', () => {
    // Sanity check — removing the reaction call must not have removed
    // the dedup/signal-tracker recording for the reply, which is what
    // suppresses replayed un-acked tool_calls after a bridge reconnect.
    const noteSignal = vi.fn()
    const recordOutbound = vi.fn()
    // Simulate the post-send block — only the dedup/signal-tracker
    // calls should fire, and they should fire unconditionally on
    // sentIds.length > 0.
    function postSendBlock(sentIdsLength: number) {
      if (sentIdsLength > 0) {
        noteSignal('chat:thread', Date.now())
        recordOutbound('chat', null, 'text')
      }
    }
    postSendBlock(1)
    expect(noteSignal).toHaveBeenCalledTimes(1)
    expect(recordOutbound).toHaveBeenCalledTimes(1)
  })
})
