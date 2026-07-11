/**
 * #2094 finding 3 — reaction-flush uses the #1556 turn gate.
 *
 * THE BUG: flushReactionBatch delivered its synthetic reaction inbound with a
 * bare `ipcServer.sendToAgent` + busy-mark, buffering ONLY on a bridge-offline
 * miss. It never ran the #1556 decideInboundDelivery gate. So a reaction that
 * landed WHILE a turn was in flight fired the MCP channel notification mid-turn
 * — the unmodified CLI typed it into its TUI composer and the auto-submit raced
 * turn-completion, re-creating the composer wedge.
 *
 * THE FIX: route the flush through deliverResumeSyntheticOrBuffer, the shared
 * helper that consults the gate (mid-turn → buffer-until-idle, flushed by the
 * turn-complete hook + idle-drain timer; idle → deliver now; buffer only on a
 * genuine miss).
 *
 * gateway.ts is a large side-effecting module that can't be imported into a
 * unit test, so this file pins (a) the gate decision for a reaction inbound's
 * shape via the pure gate + a modeled buffer/drain, and (b) that
 * flushReactionBatch wires the turn-safe helper structurally — the same
 * strategy button-tap-turn-gated.test.ts uses.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideInboundDelivery } from '../gateway/inbound-delivery-gate.js'
import { planBufferedRedelivery } from '../gateway/pending-inbound-buffer.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

// A reaction inbound as flushReactionBatch builds it: synthetic messageId (ts),
// never steering, never an interrupt — the exact inputs the shared helper
// (deliverResumeSyntheticOrBuffer) passes to the gate.
function reactionInbound(ts: number): InboundMessage {
  return {
    type: 'inbound',
    chatId: 'c1',
    messageId: ts,
    user: 'u',
    userId: 42,
    ts,
    text: `[user reacted 👍 to your message]`,
    meta: { chat_id: 'c1', count: '1' },
  }
}

describe('reaction flush uses the turn-gate (mid-turn → buffer)', () => {
  it('buffers a reaction that lands mid-turn, delivers when idle, never mid-turn', () => {
    const shape = { isSteering: false as const, isInterrupt: false as const }
    // Reaction lands WHILE a turn is in flight → HELD, not sent (the wedge the
    // raw sendToAgent used to cause).
    expect(decideInboundDelivery({ ...shape, turnInFlight: true })).toBe(
      'buffer-until-idle',
    )
    // Reaction lands at an idle prompt → delivered immediately.
    expect(decideInboundDelivery({ ...shape, turnInFlight: false })).toBe(
      'deliver',
    )
  })

  it('a mid-turn-buffered reaction drains as a fresh turn after turn end', () => {
    // Model the buffer→drain: the reaction was held mid-turn; on turn-complete
    // the buffer is planned for redelivery and the reaction lands cleanly as
    // its own turn (never merged away / dropped).
    const plan = planBufferedRedelivery([reactionInbound(1000)])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.merged.text).toBe('[user reacted 👍 to your message]')
  })
})

describe('flushReactionBatch wires the turn-safe helper', () => {
  const start = gatewaySrc.indexOf('function flushReactionBatch(batch: ReactionBatch)')
  // Bound the body by the next top-level declaration (the message_reaction
  // handler block).
  const body = gatewaySrc.slice(
    start,
    gatewaySrc.indexOf("bot.on('message_reaction'", start),
  )

  it('exists', () => {
    expect(start, 'flushReactionBatch missing').toBeGreaterThan(0)
  })

  it('delivers via deliverResumeSyntheticOrBuffer, not a raw ungated sendToAgent', () => {
    expect(body).toMatch(/deliverResumeSyntheticOrBuffer\(agentName, inbound\)/)
    // The regressed path — a raw ungated send of the reaction inbound + an
    // out-of-helper busy-mark — is gone.
    expect(body).not.toMatch(/ipcServer\.sendToAgent\(agentName, inbound\)/)
    expect(body).not.toMatch(/markClaudeBusyForInbound\(inbound\)/)
  })

  it('no longer open-codes the buffer-on-failure push (the helper owns it)', () => {
    // The #1150 buffer-on-failure guarantee now lives inside
    // deliverResumeSyntheticOrBuffer, so the flush body must not push directly.
    expect(body).not.toMatch(/pendingInboundBuffer\.push\(/)
  })
})
