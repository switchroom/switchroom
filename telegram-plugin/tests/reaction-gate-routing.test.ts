/**
 * #3155 — `setMessageReaction` must route through the send gate + flood breaker.
 *
 * Before this change ~13 raw `bot.api.setMessageReaction(...)` /
 * `lockedBot.api.setMessageReaction(...)` call sites (early-ack 👀, status
 * reactions, stop/interrupt ⚡, permission verdict ✅/❌, refusal 🚫, ack-only,
 * the MCP `react` tool, the crash-recovery sweeps, the auth-code 🔑 redact)
 * fired reactions OUTSIDE both:
 *
 *   (a) the send gate — so reaction churn was never paced/shed under flood
 *       pressure even with the gate ON; and
 *   (b) the flood circuit breaker — a 429 from a reaction never reached the
 *       retry module's `onFloodWait` hook, so the ban went unrecorded.
 *
 * Reactions were therefore a residual flood vector even when the gate is on.
 * The gateway now funnels every reaction through ONE seam,
 * `robustApiCall(() => lockedBot.api.setMessageReaction(...), { priorityClass:
 * 'cosmetic', verb: 'set-message-reaction' })`.
 *
 * Two levels of coverage:
 *   1. BEHAVIOURAL — compose the real `send-gate` + `retry-api-call` modules the
 *      same way `gateway.ts` wires `robustApiCall`, and prove a cosmetic
 *      reaction is (a) shed when a flood window is open and (b) visible to
 *      `onFloodWait` on a 429.
 *   2. LOAD-BEARING SOURCE SCAN — assert the gateway has exactly ONE runtime
 *      `setMessageReaction` call and that it is the cosmetic seam. This FAILS if
 *      any future change re-introduces a raw (ungated, breaker-blind) reaction.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSendGate, type Clock } from '../send-gate.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { errors } from './fake-bot-api.js'

const GATEWAY_SRC = fileURLToPath(new URL('../gateway/gateway.ts', import.meta.url))

/** Fixed-time clock; `sleep` is a no-op so nothing actually waits under test. */
function fixedClock(now: number): Clock {
  return { now: () => now, sleep: () => Promise.resolve() }
}

/**
 * Reconstruct the gateway's outbound wiring for reactions: `robustApiCall =
 * gate(rawRetry)`, and a `sendReaction` closure that tags the call `cosmetic`
 * exactly like `gatedSetMessageReaction` in gateway.ts.
 */
function wireReactionPath(opts: {
  clock: Clock
  enabled: boolean
  windowUntilTs?: number
  onFloodWait?: (retryAfterSec: number) => void
}) {
  const setMessageReaction = vi.fn(async () => true as const)
  const sendGate = createSendGate({
    enabled: opts.enabled,
    clock: opts.clock,
    ...(opts.windowUntilTs != null
      ? { initialWindows: [{ scopeKey: 'global', untilTs: opts.windowUntilTs }] }
      : {}),
  })
  const rawRetry = createRetryApiCall({
    maxRetries: 2,
    sleep: async () => {},
    ...(opts.onFloodWait ? { onFloodWait: opts.onFloodWait } : {}),
  })
  const robustApiCall = <T>(
    fn: () => Promise<T>,
    o?: Parameters<typeof rawRetry<T>>[1],
  ): Promise<T> => sendGate.gate(() => rawRetry(fn, o), o)

  // Mirrors gateway.ts `gatedSetMessageReaction` / `sendReaction`.
  const sendReaction = (chatId: string, messageId: number, emoji: string): Promise<unknown> =>
    robustApiCall(() => setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]), {
      chat_id: chatId,
      verb: 'set-message-reaction',
      priorityClass: 'cosmetic',
    })

  return { sendReaction, setMessageReaction, sendGate }
}

describe('#3155 reactions route through the send gate (cosmetic)', () => {
  it('SHEDS a reaction while a flood window is open (paced/shed by the gate)', async () => {
    const now = 1_000_000
    const { sendReaction, setMessageReaction, sendGate } = wireReactionPath({
      clock: fixedClock(now),
      enabled: true,
      windowUntilTs: now + 60_000, // an open global ban window
    })

    const result = await sendReaction('chatA', 42, '👀')

    // Cosmetic + a covering window ⇒ shed: the API is NEVER hit, the promise
    // resolves undefined (fire-and-forget callers .catch nothing), and the gate
    // counts the shed.
    expect(setMessageReaction).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
    expect(sendGate.stats().global.shed).toBe(1)
  })

  it('does NOT shed when the gate is OFF (proves the gate is what sheds)', async () => {
    const now = 1_000_000
    const { sendReaction, setMessageReaction } = wireReactionPath({
      clock: fixedClock(now),
      enabled: false, // gate disabled ⇒ pure passthrough
      windowUntilTs: now + 60_000,
    })

    await sendReaction('chatA', 42, '👀')

    // Flag OFF ⇒ the reaction still fires (the window only bites when enabled).
    expect(setMessageReaction).toHaveBeenCalledTimes(1)
  })

  it('records a 429 on a reaction to the flood breaker via onFloodWait', async () => {
    const now = 1_000_000
    const onFloodWait = vi.fn()
    const { sendReaction, setMessageReaction } = wireReactionPath({
      clock: fixedClock(now),
      enabled: true, // gate on, no open window ⇒ the cosmetic call is admitted
      onFloodWait,
    })
    // The reaction send hits a Telegram 429 flood-wait.
    setMessageReaction.mockRejectedValue(errors.floodWait(7, 'setMessageReaction'))

    // Fire-and-forget semantics: callers swallow. The point is the SIDE EFFECT.
    await sendReaction('chatA', 42, '🤝').catch(() => {})

    // The reaction actually reached the API (was admitted, not shed)...
    expect(setMessageReaction).toHaveBeenCalled()
    // ...and its 429 was recorded by the breaker — the whole gap this closes.
    expect(onFloodWait).toHaveBeenCalledWith(7)
  })
})

describe('#3155 load-bearing: gateway.ts sends no reaction raw', () => {
  const src = readFileSync(GATEWAY_SRC, 'utf-8')
  const lines = src.split('\n')

  /** Non-comment source lines that call `(bot|lockedBot).api.setMessageReaction`. */
  const rawReactionLines = lines
    .map((text, i) => ({ text, n: i + 1 }))
    .filter(({ text }) => {
      const t = text.trim()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false
      return /\b(bot|lockedBot)\.api\.setMessageReaction\b/.test(text)
    })

  it('has EXACTLY ONE runtime setMessageReaction callsite (the shared seam)', () => {
    // If this fails with >1, a raw reaction was re-introduced somewhere —
    // ungated and invisible to the flood breaker. Route it through
    // `sendReaction` / `gatedSetMessageReaction` instead.
    expect(rawReactionLines).toHaveLength(1)
  })

  it('the sole seam is tagged cosmetic and routed through robustApiCall', () => {
    const seamLine = rawReactionLines[0]!.n
    // Look at the seam line + a small window for its opts object.
    const window = lines.slice(seamLine - 2, seamLine + 6).join('\n')
    expect(window).toContain('robustApiCall(')
    expect(window).toContain("priorityClass: 'cosmetic'")
    expect(window).toContain("verb: 'set-message-reaction'")
  })

  it('no reaction is fired as a raw fire-and-forget bot.api call', () => {
    // Belt-and-braces: the old `bot.api.setMessageReaction(...).catch(() => {})`
    // shape must be gone entirely.
    expect(src).not.toMatch(/bot\.api\.setMessageReaction\([^)]*\)\s*\.catch/)
    // And the fire-and-forget callers now go through the helper.
    expect(src).toContain('void sendReaction(')
  })
})
