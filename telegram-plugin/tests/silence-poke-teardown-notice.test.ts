/**
 * switchroom#3551 — the 5-minute silence poke killed turns silently.
 *
 * `formatFrameworkFallbackText` returns a string on exactly one branch
 * (`blockedOnApproval`); the stall-notice path was retired and every other
 * branch returns null. So on a normal fire the gateway delivered NO text while
 * still tearing the turn down and redelivering buffered inbound — from the
 * user's seat, five minutes of nothing followed by the agent apparently
 * restarting the same request. 110 fires / 14 days, p50 silence 302s.
 *
 * `decideFallbackTeardownNotice` makes that kill observable without
 * re-introducing the banned cadence ping. These tests assert the decision
 * OUTCOMES — which real situations speak and which stay quiet — plus the
 * structural guarantee that the wiring actually sends on a speaking decision.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideFallbackTeardownNotice,
  formatFrameworkFallbackText,
  type FallbackTeardownNoticeInput,
} from '../silence-poke.js'

/** The situation the issue is about: a human asked, got nothing, turn killed. */
function killedUserTurn(over: Partial<FallbackTeardownNoticeInput> = {}): FallbackTeardownNoticeInput {
  return {
    tearsDownLiveTurn: true,
    role: 'user',
    finalAnswerDelivered: false,
    userAddressedTextDelivered: false,
    representWillFollow: true,
    silenceMs: 302_000,
    ...over,
  }
}

describe('#3551 — a fire that ends a user turn is never silent', () => {
  it('speaks when the framework kills an undelivered user turn', () => {
    const d = decideFallbackTeardownNotice(killedUserTurn())
    expect(d.send).toBe(true)
    if (!d.send) throw new Error('unreachable')
    // Honest about WHAT happened (the turn was ended) and WHO did it (the
    // framework, not the agent) — the two facts the user had no way to know.
    expect(d.text).toContain('the framework ended that stalled turn')
    expect(d.text).toContain('5 min')
  })

  it('closes the exact gap: the branch where formatFrameworkFallbackText is null still produces a message', () => {
    // This is the bug, stated as a test. On the non-approval branch the
    // formatter yields nothing; before the fix, that meant the whole fire was
    // user-invisible.
    expect(formatFrameworkFallbackText('working', 302_000, [], false)).toBeNull()
    expect(decideFallbackTeardownNotice(killedUserTurn({ userAddressedTextDelivered: false })).send).toBe(true)
  })

  it('derives the minute count from the real silence, not the nominal threshold', () => {
    const d = decideFallbackTeardownNotice(killedUserTurn({ silenceMs: 904_000 }))
    if (!d.send) throw new Error('expected a notice')
    expect(d.text).toContain('for 15 min')
    expect(d.text).not.toContain('for 5 min')
  })

  it('never promises a re-ask the obligation ledger cannot deliver', () => {
    const on = decideFallbackTeardownNotice(killedUserTurn({ representWillFollow: true }))
    const off = decideFallbackTeardownNotice(killedUserTurn({ representWillFollow: false }))
    if (!on.send || !off.send) throw new Error('expected notices')
    expect(on.text).toContain('being re-asked now')
    expect(off.text).toContain('please re-send it')
    expect(off.text).not.toContain('re-asked')
  })
})

describe('#3551 — the gates that keep this from becoming the retired stall ping', () => {
  it('stays quiet when a delivered approval re-ping already addressed the user', () => {
    const d = decideFallbackTeardownNotice(killedUserTurn({ userAddressedTextDelivered: true }))
    expect(d).toEqual({ send: false, reason: 'user-addressed-text-delivered' })
  })

  it('stays quiet on a late fire that tore down nothing', () => {
    const d = decideFallbackTeardownNotice(killedUserTurn({ tearsDownLiveTurn: false }))
    expect(d).toEqual({ send: false, reason: 'no-live-turn-torn-down' })
  })

  it('stays quiet on cron / system / sub-agent turns — nobody is waiting', () => {
    expect(decideFallbackTeardownNotice(killedUserTurn({ role: 'system' })))
      .toEqual({ send: false, reason: 'non-user-turn' })
    expect(decideFallbackTeardownNotice(killedUserTurn({ role: 'sub-agent' })))
      .toEqual({ send: false, reason: 'non-user-turn' })
    expect(decideFallbackTeardownNotice(killedUserTurn({ role: null })))
      .toEqual({ send: false, reason: 'non-user-turn' })
  })

  it('stays quiet when the user already has their answer', () => {
    const d = decideFallbackTeardownNotice(killedUserTurn({ finalAnswerDelivered: true }))
    expect(d).toEqual({ send: false, reason: 'answer-already-delivered' })
  })
})

describe('#3551 — wiring: the teardown path actually sends the notice', () => {
  // buildSilencePokeOptions needs the whole gateway module's dep object, which
  // cannot be instantiated in a unit test (module-load side effects). Pin the
  // wiring structurally instead — the same technique the repo uses for other
  // gateway-resident callbacks.
  const src = readFileSync(join(__dirname, '..', 'gateway', 'liveness-wiring.ts'), 'utf8')
  const fallbackBody = src.slice(src.indexOf('onFrameworkFallback:'))

  it('calls the decider inside onFrameworkFallback and sends on a speaking decision', () => {
    expect(fallbackBody).toMatch(/decideFallbackTeardownNotice\(/)
    expect(fallbackBody).toMatch(/if \(teardownNotice\.send\)[\s\S]{0,400}?sendSilenceText\(/)
  })

  it('keeps the load-bearing unwedge — the notice does not replace the teardown', () => {
    // The whole point of the 300s fallback is #1122: end the wedged turn so
    // later inbound is not queued behind a dead turn forever. A "fix" that
    // stopped killing the turn would trade dead air for a wedged conversation.
    expect(fallbackBody).toMatch(/silencePoke\.endTurn\(fbKey\)/)
    expect(fallbackBody).toMatch(/endCurrentTurnForKey\(wedgedTurn, fbKey\)/)
    expect(fallbackBody).toMatch(/redeliverBufferedInbound\(/)
  })

  it('sends the notice LOUD — a killed question is not a silent status surface', () => {
    expect(fallbackBody).toMatch(/sendSilenceText\(fbChatId, ctx\.threadId \?\? null, teardownNotice\.text, false\)/)
  })
})

describe('#3551 L1/L2 — the suppression signal is narrow, and means DELIVERED', () => {
  // L1. `text` in onFrameworkFallback has TWO sources. Treating them alike
  // reproduced the very bug #3551 closes: user asks something during an
  // `update_apply`, gets no answer, the fallback emits a SILENT status line
  // about the update, the turn is torn down — and the notice was suppressed as
  // "other text sent". Silent kill, again.
  it('a silent, unrelated update-status line does NOT buy silence — that IS the #3551 case', () => {
    const d = decideFallbackTeardownNotice(killedUserTurn({ userAddressedTextDelivered: false }))
    expect(d.send).toBe(true)
  })

  const src = readFileSync(join(__dirname, '..', 'gateway', 'liveness-wiring.ts'), 'utf8')
  const fallbackBody = src.slice(src.indexOf('onFrameworkFallback:'))

  it('the wiring feeds the decider the DELIVERY flag, never `text != null`', () => {
    // The regression this pins: reverting to `otherTextSent: text != null`
    // silently re-couples the silent status line (L1) and the failed send (L2).
    expect(fallbackBody).toMatch(/userAddressedTextDelivered,/)
    expect(fallbackBody).not.toMatch(/otherTextSent:\s*text != null/)
  })

  it('L2 — the flag is set only AFTER a successful send, inside the try', () => {
    // A throwing approval re-ping must not buy silence: the catch only logs, so
    // assigning before/outside the await would leave the user with nothing at
    // all while the turn was torn down.
    expect(fallbackBody).toMatch(
      /await sendSilenceText\(ctx\.chatId[^\n]*\n\s*userAddressedTextDelivered = blockedOnApproval/,
    )
    // and it is initialised false, so the catch path leaves it false
    expect(fallbackBody).toMatch(/let userAddressedTextDelivered = false/)
  })

  it('L1 — the flag is gated on blockedOnApproval, which is what makes it user-addressed', () => {
    expect(fallbackBody).toMatch(/userAddressedTextDelivered = blockedOnApproval/)
  })
})
