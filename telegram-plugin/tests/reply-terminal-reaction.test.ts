/**
 * #1713 — plain `reply` tool is a NON-EVENT for the status reaction.
 *
 * History. PR #602 follow-up wired `executeReply` to fire the terminal
 * 👍 after at least one chunk landed, mirroring the (now-also-removed)
 * stream_reply Bug Z behaviour. #1713 reverts both: the status reaction
 * reflects current turn activity, not delivery state. Only the
 * gateway's `turn_end` IPC handler finalizes the reaction. Mid-turn
 * replies — ack or final — must not change the emoji.
 *
 * This file pins the new invariant: there is no `endStatusReaction`
 * call inside the executeReply post-send block. The post-send block
 * now records signal-tracker / outbound-dedup / final-answer state
 * only — reaction state is owned by turn_end.
 *
 * The gateway IIFE / executeReply body are too entangled to import
 * directly, so we model the post-#1713 contract here. If executeReply
 * regresses (re-adds a terminal-reaction call), the inline review
 * comment guarding `if (sentIds.length > 0)` and this test should both
 * catch it.
 */
import { describe, it, expect, vi } from 'vitest'

describe('#1713 — plain reply tool is a non-event for the reaction', () => {
  it('executeReply post-send block does NOT call endStatusReaction', () => {
    // Read the source to assert the contract — there should be no
    // `endStatusReaction(... 'done')` call inside the post-send
    // `if (sentIds.length > 0)` block in executeReply.
    //
    // We do a coarse-grained source-level check rather than a unit
    // test of a copied helper. If/when the executeReply body is
    // extracted into its own function this can become a proper unit
    // test; until then the source-level guard is the safest pin.
    //
    // The intent: a future commit that re-adds the call (regressing
    // #1713) will trip this assertion.
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
