/**
 * Discriminating policy for the gateway's `unhandledRejection` handler.
 *
 * Background: gateway.ts crashes the process on every unhandledRejection
 * (it calls `shutdown()` from the handler). Some Telegram API errors
 * surface here as benign 400s — "message is not modified", "message to
 * edit not found" — and crashing the gateway over them creates restart
 * loops (issue #99 + lawgpt's 11:36 crash family).
 *
 * Pure helper so it can be tested without spinning up the gateway.
 */

import { GrammyError } from 'grammy'

export type RejectionAction = 'shutdown' | 'log_only'

export interface RejectionPolicyOptions {
  /** Allow tests to inject error type detection without depending on grammy. */
  isGrammyError?: (err: unknown) => boolean
}

/**
 * Decide whether an unhandledRejection should crash the gateway.
 *
 * Returns:
 *   - `'log_only'` for benign Telegram 400s the bot already tolerates
 *     elsewhere (see retry-api-call.ts). Logging surfaces the leak; not
 *     crashing prevents restart loops.
 *   - `'shutdown'` for everything else. Genuine bugs still crash, which
 *     systemd will surface as a restart and we want that signal.
 *
 * The set of benign descriptions is intentionally narrow — only the
 * specific 400s the wrapper already swallows. Any other 400 still
 * triggers shutdown so we don't silently mask new bugs.
 */
export function classifyRejection(
  err: unknown,
  opts: RejectionPolicyOptions = {},
): RejectionAction {
  const isGrammy =
    opts.isGrammyError != null
      ? opts.isGrammyError(err)
      : err instanceof GrammyError

  if (!isGrammy) return 'shutdown'

  const e = err as { error_code?: number; description?: string }
  if (e.error_code !== 400) return 'shutdown'

  const desc = (e.description ?? '').toLowerCase()
  if (
    desc.includes('message is not modified') ||
    desc.includes('message to edit not found') ||
    desc.includes('message to delete not found') ||
    // HTML parse errors (e.g. formatDuration sub-second output like "<1s"
    // interpreted as a tag). These are transient render bugs — log the
    // failure so we can fix the root cause, but don't crash the gateway
    // into a restart loop (issue #101).
    desc.includes("can't parse entities") ||
    desc.includes('unsupported start tag')
  ) {
    return 'log_only'
  }
  return 'shutdown'
}
