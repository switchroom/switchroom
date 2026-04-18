/**
 * Structured logger for pin/unpin lifecycle events.
 *
 * Every call to `pinChatMessage` or `unpinChatMessage` — whether from the
 * live turn path or the crash/restart sweeps — emits one JSON-encoded line
 * on stderr, prefixed with `pin-event:`. This gives an out-of-band audit
 * trail operators can grep without parsing free-form log text.
 *
 * Pure helper. No globals. The write target is injectable for tests.
 */

export type PinEventName =
  | 'pin'
  | 'unpin'
  | 'unpin-retry'
  | 'sweep-pin'
  | 'sweep-auth'
  | 'audit-orphan'

export type PinEventOutcome =
  | 'ok'
  | 'fail'
  | 'rate-limited'
  | 'forbidden'
  | 'timeout'
  | 'observed'

export interface PinEvent {
  event: PinEventName
  chatId: string
  messageId?: number
  turnKey?: string
  outcome: PinEventOutcome
  error?: string
  durationMs?: number
}

export type PinEventWriter = (line: string) => void

const defaultWriter: PinEventWriter = (line) => {
  process.stderr.write(line)
}

export function logPinEvent(event: PinEvent, write: PinEventWriter = defaultWriter): void {
  const payload = JSON.stringify(event)
  write(`pin-event: ${payload}\n`)
}

/**
 * Classify a thrown Error from the Telegram API into a stable outcome
 * category. Grammy surfaces rate-limit errors with `error_code: 429` and
 * permission errors with `error_code: 403`; everything else is generic
 * failure. We match on the message body as a last resort for the error
 * shapes that don't surface `error_code` (network timeouts, HTTP-level
 * 429s in the wrapper, etc.) so the category is useful even when the
 * Grammy wrapper hides the structured field.
 */
export function classifyPinError(err: unknown): PinEventOutcome {
  if (err == null) return 'fail'
  const anyErr = err as { error_code?: number; description?: string; message?: string }
  const code = anyErr.error_code
  if (code === 429) return 'rate-limited'
  if (code === 403) return 'forbidden'
  const msg = (anyErr.description ?? anyErr.message ?? String(err)).toLowerCase()
  if (msg.includes('too many requests') || msg.includes('rate')) return 'rate-limited'
  if (msg.includes('forbidden') || msg.includes('not enough rights')) return 'forbidden'
  if (msg.includes('timeout') || msg.includes('etimedout')) return 'timeout'
  return 'fail'
}

export function errorMessage(err: unknown): string {
  if (err == null) return ''
  if (err instanceof Error) return err.message
  const anyErr = err as { description?: string; message?: string }
  return anyErr.description ?? anyErr.message ?? String(err)
}
