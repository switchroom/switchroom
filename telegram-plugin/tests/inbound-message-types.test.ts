/**
 * Structural tests for the 13 previously-silent inbound message types
 * registered on `bot.on('message:<type>')` in the gateway (#1077).
 *
 * Why structural: gateway/gateway.ts wires every handler inline against
 * the live `bot` instance — none of these closures are exported, so a
 * functional invocation would require booting the full grammy runtime
 * against a real or mocked Bot API. The existing gateway test suite
 * settled on file-level grep assertions (see
 * `gateway-secret-detect.test.ts`) for exactly this reason: cheap,
 * deterministic, and they catch the regression we actually care about
 * — a future hand mistakenly deleting a handler or skipping the
 * gate/ack call that gives the user feedback.
 *
 * Decision matrix being enforced here (issue #1077):
 *
 *   forward         → contact, location, venue, poll, web_app_data,
 *                     users_shared, chat_shared
 *   ack-only        → dice, game, story, paid_media, successful_payment
 *   refuse (DENY)   → passport_data
 *
 * The contract per-type:
 *   - A `bot.on('message:<type>', …)` registration exists.
 *   - Forwarding handlers call `handleInbound(`.
 *   - Ack-only handlers call `handleAckOnly(`.
 *   - The refusal handler calls `handleRefusal(` and does NOT call
 *     `handleInbound(` (passport data must never reach the agent).
 *   - Every handler logs a stderr line so operators can see the
 *     event landed.
 *   - Every handler is wrapped in try/catch (or delegates to a helper
 *     that is) so a malformed payload cannot tear down the dispatcher.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(
  new URL('../gateway/gateway.ts', import.meta.url),
  'utf8',
)

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the body of a `bot.on('message:<kind>', …)` handler. Returns
 * the substring from the `bot.on(` line up to the matching closing
 * `})` at the outer scope. Good enough for grepping — not a full
 * AST parse.
 */
function handlerBody(kind: string): string {
  const needle = `bot.on('message:${kind}'`
  const start = SRC.indexOf(needle)
  expect(start, `handler bot.on('message:${kind}') not found`).toBeGreaterThan(0)
  // Find the matching close — naive depth count of {/} from the first `{`.
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
  throw new Error(`could not find end of handler ${kind}`)
}

// ─── Registration completeness ───────────────────────────────────────────

const ALL_KINDS = [
  'contact',
  'location',
  'venue',
  'dice',
  'poll',
  'game',
  'story',
  'paid_media',
  'successful_payment',
  'passport_data',
  'web_app_data',
  'users_shared',
  'chat_shared',
] as const

describe('inbound message-type handlers: registration', () => {
  for (const kind of ALL_KINDS) {
    it(`registers a bot.on('message:${kind}') handler`, () => {
      expect(SRC).toContain(`bot.on('message:${kind}'`)
    })
  }
})

// ─── Forwarding handlers ─────────────────────────────────────────────────

const FORWARDING = [
  'contact',
  'location',
  'venue',
  'poll',
  'web_app_data',
  'users_shared',
  'chat_shared',
] as const

describe('inbound message-type handlers: forwarding decisions', () => {
  for (const kind of FORWARDING) {
    it(`${kind} forwards via handleInbound and logs to stderr`, () => {
      const body = handlerBody(kind)
      expect(body).toMatch(/handleInbound\(ctx,/)
      expect(body).toMatch(/process\.stderr\.write/)
      // Must not divert to the ack-only path — that would silently
      // hide the payload from the agent.
      expect(body).not.toMatch(/handleAckOnly\(/)
      expect(body).not.toMatch(/handleRefusal\(/)
    })
  }

  it('forwarding envelopes describe the payload kind in the text', () => {
    // Each handler builds a `(<kind>: …)` text envelope so the agent
    // sees what category of payload arrived without having to decode
    // the meta block.
    expect(handlerBody('contact')).toContain('(contact:')
    expect(handlerBody('location')).toContain('(location:')
    expect(handlerBody('venue')).toContain('(venue:')
    expect(handlerBody('poll')).toContain('(poll:')
    expect(handlerBody('web_app_data')).toContain('(web_app_data:')
    expect(handlerBody('users_shared')).toContain('(users_shared:')
    expect(handlerBody('chat_shared')).toContain('(chat_shared:')
  })

  it('web_app_data caps untrusted payload length before forwarding', () => {
    // web_app_data.data is arbitrary mini-app output — a malicious
    // mini-app could otherwise flood the agent. Same defence as #553
    // applied to text coalescing.
    const body = handlerBody('web_app_data')
    expect(body).toMatch(/slice\(0,\s*4096\)/)
    expect(body).toMatch(/truncated/)
  })
})

// ─── Ack-only handlers ───────────────────────────────────────────────────

const ACK_ONLY = ['dice', 'game', 'story', 'paid_media', 'successful_payment'] as const

describe('inbound message-type handlers: ack-only decisions', () => {
  for (const kind of ACK_ONLY) {
    it(`${kind} uses handleAckOnly (no forward to agent)`, () => {
      const body = handlerBody(kind)
      expect(body).toMatch(/handleAckOnly\(/)
      expect(body).toMatch(/process\.stderr\.write/)
      // Ack-only must NOT call handleInbound — the whole point is
      // we don't bother the agent for these.
      expect(body).not.toMatch(/handleInbound\(/)
      // Nor should it pretend to refuse.
      expect(body).not.toMatch(/handleRefusal\(/)
    })
  }

  it('dice uses a 🎲 reaction for situational feedback', () => {
    expect(handlerBody('dice')).toContain("emoji: '🎲'")
  })

  it('paid_media and successful_payment are marked warn:true', () => {
    expect(handlerBody('paid_media')).toMatch(/warn:\s*true/)
    expect(handlerBody('successful_payment')).toMatch(/warn:\s*true/)
  })

  it('successful_payment logs the structured payment fields', () => {
    // Money-flow events need a reconciliation-friendly stderr line.
    const body = handlerBody('successful_payment')
    expect(body).toContain('currency=')
    expect(body).toContain('total_amount=')
    expect(body).toContain('telegram_charge=')
  })
})

// ─── Refusal handler ─────────────────────────────────────────────────────

describe('inbound message-type handlers: passport_data refusal', () => {
  it('passport_data uses handleRefusal and NEVER calls handleInbound', () => {
    const body = handlerBody('passport_data')
    expect(body).toMatch(/handleRefusal\(/)
    // Critical: passport data is regulated identity material. Even a
    // diagnostic forward path would leak it onto the agent's wire.
    expect(body).not.toMatch(/handleInbound\(/)
    expect(body).not.toMatch(/ipcServer\.broadcast/)
  })

  it('passport_data refusal text mentions Telegram Passport', () => {
    // The user gets a polite explanation so they don't think the
    // message was simply dropped on the floor.
    const body = handlerBody('passport_data')
    expect(body).toMatch(/Telegram Passport/)
  })
})

// ─── Shared helper invariants ────────────────────────────────────────────

describe('inbound message-type helpers: handleAckOnly + handleRefusal', () => {
  it('handleAckOnly is declared and gates before reacting', () => {
    // The function must consult gate() so non-allowlisted senders
    // don't get a reaction (which would confirm the bot exists to
    // a stranger).
    expect(SRC).toMatch(/async function handleAckOnly\(/)
    const fnStart = SRC.indexOf('async function handleAckOnly(')
    const fnSlice = SRC.slice(fnStart, fnStart + 2000)
    expect(fnSlice).toContain('gate(ctx)')
    // #3155: the reaction now routes through the gated `sendReaction` helper
    // (send gate + flood breaker, cosmetic) instead of a raw
    // `bot.api.setMessageReaction`. The invariant is unchanged: it gates, THEN
    // reacts.
    expect(fnSlice).toContain('sendReaction(')
  })

  it('handleAckOnly drops non-allowlisted senders silently', () => {
    const fnStart = SRC.indexOf('async function handleAckOnly(')
    const fnSlice = SRC.slice(fnStart, fnStart + 2000)
    expect(fnSlice).toMatch(/action === 'drop'/)
  })

  it('handleAckOnly is wrapped in try/catch', () => {
    const fnStart = SRC.indexOf('async function handleAckOnly(')
    const fnSlice = SRC.slice(fnStart, fnStart + 2000)
    expect(fnSlice).toMatch(/try\s*\{/)
    expect(fnSlice).toMatch(/catch\s*\(/)
  })

  it('handleRefusal is declared and sends a reply via sendMessage', () => {
    expect(SRC).toMatch(/async function handleRefusal\(/)
    const fnStart = SRC.indexOf('async function handleRefusal(')
    const fnSlice = SRC.slice(fnStart, fnStart + 2000)
    expect(fnSlice).toContain('gate(ctx)')
    expect(fnSlice).toContain('sendMessage')
    // SECURITY-tagged log line so operators see the refusal in
    // their stderr scrape.
    expect(fnSlice).toMatch(/SECURITY/)
  })

  it('handleRefusal sits behind the gate (no leak to strangers)', () => {
    // Mirrors handleAckOnly — we don't even confirm the bot exists
    // to a sender who isn't allowlisted.
    const fnStart = SRC.indexOf('async function handleRefusal(')
    const fnSlice = SRC.slice(fnStart, fnStart + 2000)
    expect(fnSlice).toMatch(/action === 'drop'/)
  })
})

// ─── Decision-matrix completeness ────────────────────────────────────────

describe('inbound message-type decisions cover all 13 types from #1077', () => {
  it('every kind in the matrix has exactly one decision', () => {
    const forwardSet = new Set<string>(FORWARDING)
    const ackSet = new Set<string>(ACK_ONLY)
    const refusalSet = new Set<string>(['passport_data'])
    for (const kind of ALL_KINDS) {
      const inForward = forwardSet.has(kind)
      const inAck = ackSet.has(kind)
      const inRefusal = refusalSet.has(kind)
      const count = Number(inForward) + Number(inAck) + Number(inRefusal)
      expect(count, `${kind} should appear in exactly one bucket, got ${count}`).toBe(1)
    }
  })

  it('matrix totals: 7 forward, 5 ack-only, 1 refuse', () => {
    expect(FORWARDING.length).toBe(7)
    expect(ACK_ONLY.length).toBe(5)
    // All 13 covered, no extras dropped.
    expect(FORWARDING.length + ACK_ONLY.length + 1).toBe(ALL_KINDS.length)
  })
})
