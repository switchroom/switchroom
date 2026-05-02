/**
 * `!`-prefix interrupt marker — closes #575 / part of `reference/steer-or-queue-mid-flight.md`.
 *
 * The product contract: when the user starts a Telegram message with
 * `!`, they're saying "drop what you're doing and handle this
 * instead." The gateway:
 *   1. Bypasses the inbound coalescer so the `!` always lands at
 *      the start of the parsed text (otherwise an earlier non-`!`
 *      message inside the same coalesce window would prepend itself
 *      and the marker would no longer be at position 0).
 *   2. Sends SIGINT to the agent service so any in-flight turn dies.
 *   3. Forwards the message with the `!` stripped as a fresh turn,
 *      so the agent sees clean intent without the marker character
 *      bleeding into its prompt.
 *
 * Pure helper — no side effects. Parses the marker; the gateway
 * decides what to do with the verdict. Tested in
 * `tests/interrupt-marker.test.ts` without grammY.
 */

export interface InterruptParseResult {
  /** True iff the message is a deliberate interrupt request. */
  isInterrupt: boolean
  /** The text the agent should see, minus the marker + leading whitespace. */
  body: string
  /** True iff the body would be empty (just `!` with nothing useful after).
   *  Caller may want to send a clarifying reply rather than forward an
   *  empty turn to the agent. */
  emptyBody: boolean
}

/**
 * Parse an inbound text body for the `!` interrupt marker.
 *
 * Rules:
 *   - Marker is `!` at position 0 of the trimmed body.
 *   - Doubled `!!` is NOT an interrupt — common typo / emphasis. The
 *     agent sees the literal `!!...` text. Single `!` is the rule.
 *   - Markdown-bold `*!*` or any other escape is NOT an interrupt.
 *     Strict literal match keeps the rule learnable.
 *   - The marker is consumed; the body returned is everything after,
 *     leading whitespace trimmed. So `! do this instead` → body `do
 *     this instead`.
 *
 * Why not other prefixes (e.g. `/stop`, `STOP`, `interrupt`):
 *   - `/`-prefixed strings are reserved for Telegram bot commands.
 *   - Word prefixes collide with normal speech ("Stop, that's wrong").
 *   - `!` is a single keystroke, hard to type by accident, easy to
 *     teach. Same convention as e.g. linuz90/claude-telegram-bot.
 */
export function parseInterruptMarker(text: string): InterruptParseResult {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('!')) {
    return { isInterrupt: false, body: text, emptyBody: false }
  }
  // Doubled `!!` is intentional emphasis or typo — not a marker.
  if (trimmed.startsWith('!!')) {
    return { isInterrupt: false, body: text, emptyBody: false }
  }
  const body = trimmed.slice(1).trimStart()
  return {
    isInterrupt: true,
    body,
    emptyBody: body.length === 0,
  }
}
