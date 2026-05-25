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

import { GrammyError, HttpError } from 'grammy'

export type RejectionAction = 'shutdown' | 'log_only'

export interface RejectionPolicyOptions {
  /** Allow tests to inject error type detection without depending on grammy. */
  isGrammyError?: (err: unknown) => boolean
  /** Allow tests to inject HttpError detection without depending on grammy. */
  isHttpError?: (err: unknown) => boolean
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

  // Transient network-layer failures: grammy throws an `HttpError` wrapping
  // the underlying fetch failure (ECONNRESET, ETIMEDOUT, fetch failed, DNS
  // failures, etc.). These are the SAME class `retry-api-call.ts:146-162`
  // already retries with exponential backoff — if one leaks past the retry
  // policy (3 attempts exhausted, or a fire-and-forget callsite without
  // robustApiCall wrapping), crashing the gateway turns one bad packet into
  // a crash banner. log_only is the right posture: the request failed, the
  // user-visible UX recovers on the next retry cycle, and a daemon that
  // crashes on network errors isn't always-on.
  //
  // Surfaced 2026-05-25 on clerk via the boot-card sendMessage path: an
  // HttpError leaked past the boot-card's try/catch (the async post-settle
  // probe-loop IIFE at boot-card.ts:616 had no .catch on its outer void),
  // triggering an unhandledRejection → shutdown → user-visible
  // "agent-crashed" banner for what was really just a transient network hiccup.
  const isHttp =
    opts.isHttpError != null
      ? opts.isHttpError(err)
      : err instanceof HttpError
  if (isHttp) return 'log_only'

  if (!isGrammy) return 'shutdown'

  const e = err as { error_code?: number; description?: string }

  // 429 (Too Many Requests / flood-wait): grammy's flood-wait response.
  // Already handled in retry-api-call.ts:100-108 with the
  // `parameters.retry_after` backoff. If one leaks past — caller exceeded
  // maxRetries=3 of sustained 429s, or didn't wrap in robustApiCall — the
  // right posture is log_only (matches the HttpError rationale above).
  // The bot is rate-limited; crashing makes it worse (boot fires more
  // API calls that hit fresh 429s).
  //
  // Surfaced 2026-05-25 on clerk via a sendMessage that exceeded the 3-
  // attempt retry budget; the rejection bubbled to this handler, triggered
  // shutdown, and posted an "agent-crashed" operator-event banner.
  if (e.error_code === 429) return 'log_only'

  // 5xx (Bad Gateway / Service Unavailable / Gateway Timeout): Telegram
  // intermittently returns these during their own load events. Same
  // posture as 429 — retry policy already backs off and re-tries; if
  // one leaks past, log don't crash.
  if (typeof e.error_code === 'number' && e.error_code >= 500 && e.error_code < 600) {
    return 'log_only'
  }

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
    desc.includes('unsupported start tag') ||
    // 'chat not found' fires when an allowlisted chat id (typically a
    // group in access.json/groups{}) is no longer reachable — bot was
    // removed, group was deleted, or the id was stale config from a
    // prior bot pairing. Boot-time pin sweep + various other checks
    // call getChat against every allowlisted chat; a single unreachable
    // entry was crashing the gateway into restart loops on ziggy
    // (2026-05-02 12:05) even though boot-probe-failed already logged
    // the failure structurally. The wrapped sweep handles the visible
    // case; this policy entry covers any leaked rejection from the
    // same family so a single bad chat id can't restart-loop the
    // process. The visible boot-probe-failed log is the primary
    // diagnostic; this is the can't-restart-loop guarantee.
    desc.includes('chat not found')
  ) {
    return 'log_only'
  }
  return 'shutdown'
}
