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
    desc.includes('chat not found') ||
    // Pin-rights failure in a supergroup where the bot is not an admin (or
    // lacks the "pin messages" right). Telegram returns this as a 400, not a
    // 403: "not enough rights to manage pinned messages in the chat". The
    // auto status-pin driver is best-effort and cosmetic — a bot that can't
    // pin should skip the pin, never crash-loop the gateway. This was the
    // exact 400 that took marko's gateway down (2026-07-01): the fire-and-
    // forget `void reconcileStatusPin(...)` leaked the rejection and this
    // handler shut the process down. reconcileStatusPin now absorbs its own
    // errors (primary fix); this entry is defense-in-depth so ANY leaked
    // pin-rights 400 from any path is log-only, not fatal.
    desc.includes('not enough rights') ||
    // 'group chat was upgraded to a supergroup chat' fires when a send
    // targets a basic-group chat_id that Telegram has since migrated to
    // a supergroup (new id format -100xxxxxxxxxx). Telegram sometimes
    // surfaces the replacement id via `error.parameters.migrate_to_chat_id`
    // but not reliably for every send method, so this handler can't always
    // auto-repair the stale id — it can only make the failure non-fatal.
    // This crashed marko's gateway on 2026-07-09 (and recurred from the
    // same stale-id root cause on 2026-06-07 and 2026-06-09): a send to an
    // old pre-migration group id crashed the WHOLE gateway process for
    // every agent/chat, not just the one stale chat. A single unmigrated
    // chat_id in cached state must never be fatal — log it so the stale id
    // can be tracked down and fixed, but keep serving every other chat.
    desc.includes('group chat was upgraded to a supergroup chat') ||
    // Broader class: any 400 whose description signals the target
    // chat_id itself is no longer valid (migrated, deactivated, or
    // otherwise unresolvable). These are all "this one destination is
    // broken", never "the gateway is broken" — same log-only posture as
    // 'chat not found' above.
    desc.includes('chat_id is empty') ||
    desc.includes('group chat was deactivated')
  ) {
    return 'log_only'
  }
  return 'shutdown'
}
