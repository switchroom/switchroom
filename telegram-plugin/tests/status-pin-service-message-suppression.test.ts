/**
 * Structural test for the `bot.on('message:pinned_message')` handler that
 * suppresses the "pinned a message" service message Telegram inserts when
 * OUR silent status-pin fires.
 *
 * Why structural: like every other gateway handler, this closure is wired
 * inline against the live `bot` instance and is not exported — a functional
 * invocation would require booting the full grammy runtime against a mocked
 * Bot API. The gateway suite settled on file-level grep assertions for
 * exactly this reason (see `inbound-message-types.test.ts`). The regression
 * we care about: a future hand dropping the handler, dropping the ownership
 * guard (which would let us delete manual/operator pins), or swapping the
 * house deletion wrapper for a raw `bot.api.deleteMessage` (allowlist drift).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(
  new URL('../gateway/gateway.ts', import.meta.url),
  'utf8',
)

/**
 * Extract the body of the `bot.on('message:pinned_message', …)` handler:
 * from the `bot.on(` line to the matching outer-scope closing brace.
 */
function pinnedMessageHandler(): string {
  const needle = `bot.on('message:pinned_message'`
  const start = SRC.indexOf(needle)
  expect(start, `handler ${needle} not found`).toBeGreaterThan(0)
  const firstBrace = SRC.indexOf('{', start)
  let depth = 0
  for (let i = firstBrace; i < SRC.length; i++) {
    const c = SRC[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return SRC.slice(start, i + 1)
    }
  }
  throw new Error('could not find end of pinned_message handler')
}

describe('status-pin service-message suppression', () => {
  it("registers a bot.on('message:pinned_message') handler", () => {
    expect(SRC).toContain(`bot.on('message:pinned_message'`)
  })

  const body = pinnedMessageHandler()

  it('guards on ownership via statusPinState before deleting', () => {
    // Must consult our tracked pins — never blindly delete a pin service
    // message (which would nuke manual/operator pins too).
    expect(body).toContain('statusPinState')
    expect(body).toMatch(/pinned_message\?\.message_id/)
    expect(body).toMatch(/\.messageId === pinnedId/)
  })

  it('bails out when the pinned message is not one of ours', () => {
    // A `return` guard for the non-owned case must exist.
    expect(body).toMatch(/if \(!isOurs\(\)\) return/)
  })

  it('deletes the service message through the robust wrapper (not a raw api call)', () => {
    expect(body).toContain('robustApiCall(')
    expect(body).toContain('deleteMessage')
    // The message deleted is the service message itself, not the pinned msg.
    expect(body).toContain('serviceMsgId')
    // House verb tag so operators can trace it.
    expect(body).toContain("verb: 'status-pin.delete-service-message'")
  })

  it('tolerates the reconcile-store race with a short retry', () => {
    // The service update can arrive before reconcileStatusPin stores the
    // PinState; a single delayed re-check covers that window.
    expect(body).toContain('setTimeout')
  })
})
