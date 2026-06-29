/**
 * Retry wrapper for Telegram Bot API calls — the single policy the rest
 * of the plugin relies on for flood-wait handling, benign 400 swallowing,
 * and thread-not-found fallback.
 *
 * Extracted from gateway.ts so that:
 *   - it's unit-testable (the previous in-gateway definition couldn't be
 *     exercised without spinning up the whole bot runner)
 *   - stream-reply-handler / server.ts can share one implementation
 *     instead of each threading a `retry` dep through every callsite
 *   - callers can install an observer (`onRetry`, `onGiveUp`) for tests
 *     and production logging without reaching into the function body.
 *
 * Behaviour contract — each case is independently tested in
 * `tests/retry-api-call.test.ts`:
 *
 *   | Thrown error                                  | This wrapper does                          |
 *   |-----------------------------------------------|--------------------------------------------|
 *   | GrammyError 429                               | sleep retry_after seconds, retry          |
 *   | GrammyError 400 "message is not modified"     | swallow, return undefined                 |
 *   | GrammyError 400 "message to edit not found"   | swallow, return undefined                 |
 *   | GrammyError 400 "message to delete not found" | swallow, return undefined                 |
 *   | GrammyError 400 "thread not found" (w/ opts)  | throw `THREAD_NOT_FOUND` wrapper          |
 *   | Network error (fetch failed / ECONN…)         | exponential backoff retry, 3 attempts     |
 *   | Anything else                                 | rethrow immediately                       |
 */

import { GrammyError } from 'grammy'

export interface RetryCallOpts {
  /**
   * The forum-topic thread id, used only to decide whether the
   * "thread not found" 400 is retryable for a fallback path. If both
   * `threadId` and `chat_id` are set, a thread-not-found 400 is rethrown
   * as `THREAD_NOT_FOUND` so callers can drop the thread and retry on
   * the main chat.
   */
  threadId?: number
  chat_id?: string
  /**
   * Optional caller-supplied label for the API call (e.g. "sendMessage",
   * "editMessageText"). Currently informational only — accepted to allow
   * call sites to self-document. Future: surface in retry logs / metrics.
   */
  verb?: string
}

export interface RetryObserver {
  /** Fires just before sleeping for a retry. */
  onRetry?(info: { attempt: number; reason: 'flood_wait' | 'network'; delayMs: number }): void
  /** Fires when max retries is reached and the wrapper gives up. */
  onGiveUp?(info: { attempts: number; error: unknown }): void
  /** Fires for each benign error we swallowed (not-modified, not-found). */
  onBenign?(info: { kind: 'not_modified' | 'message_not_found' | 'delete_not_found' }): void
}

export interface RetryApiCallConfig {
  /** Max retries before giving up. Defaults to 3. */
  maxRetries?: number
  /** Sleep helper — injected so tests can use fake timers. */
  sleep?: (ms: number) => Promise<void>
  /** Optional observer hooks. */
  observer?: RetryObserver
  /** Optional log sink for flood-wait / network lines. */
  log?: (line: string) => void
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Wrap a Telegram API call with the standard retry policy.
 *
 * Returns `fn`'s resolved value on success. Returns `undefined` for the
 * swallowed-400 cases (caller must tolerate this — the typical caller is
 * a `bot.api.editMessageText` which returns `true` on success, so
 * `undefined` cleanly flags "no-op, target gone or identical"). Throws
 * on 3rd network-error attempt or on any non-retryable error.
 */
export function createRetryApiCall(
  config: RetryApiCallConfig = {},
): <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T> {
  const maxRetries = config.maxRetries ?? 3
  const sleep = config.sleep ?? DEFAULT_SLEEP
  const observer = config.observer
  const log = config.log

  return async function retryApiCall<T>(
    fn: () => Promise<T>,
    opts?: RetryCallOpts,
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        const isGrammyErr = err instanceof GrammyError
        const msg = err instanceof Error ? err.message : String(err)
        const desc = isGrammyErr ? (err as GrammyError).description : msg

        // Flood-wait — sleep retry_after and try again.
        if (isGrammyErr && (err as GrammyError).error_code === 429) {
          const retryAfter = Number(
            (err as GrammyError).parameters?.retry_after ?? 5,
          )
          const delayMs = retryAfter * 1000
          log?.(`telegram gateway: 429 rate limited, waiting ${retryAfter}s\n`)
          observer?.onRetry?.({ attempt, reason: 'flood_wait', delayMs })
          await sleep(delayMs)
          continue
        }

        // Swallow "message is not modified" — Telegram's no-op-on-equal-text.
        if (
          isGrammyErr &&
          (err as GrammyError).error_code === 400 &&
          desc.includes('not modified')
        ) {
          observer?.onBenign?.({ kind: 'not_modified' })
          return undefined as unknown as T
        }

        // Swallow "message to edit/delete not found" — target vanished.
        if (
          isGrammyErr &&
          (err as GrammyError).error_code === 400 &&
          (desc.includes('message to edit not found') ||
            desc.includes('message to delete not found'))
        ) {
          observer?.onBenign?.({
            kind: desc.includes('edit') ? 'message_not_found' : 'delete_not_found',
          })
          return undefined as unknown as T
        }

        // Stale forum-thread — caller may want to fall back to main chat.
        if (
          isGrammyErr &&
          (err as GrammyError).error_code === 400 &&
          desc.includes('thread not found') &&
          opts?.threadId &&
          opts?.chat_id
        ) {
          throw Object.assign(new Error('THREAD_NOT_FOUND'), { original: err })
        }

        // Network-level transient errors — exponential backoff, bounded.
        if (
          !isGrammyErr &&
          (msg.includes('ECONNRESET') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('fetch failed') ||
            msg.includes('ENOTFOUND'))
        ) {
          if (attempt < maxRetries - 1) {
            const delayMs = Math.pow(2, attempt) * 1000
            log?.(
              `telegram gateway: network error, retrying in ${delayMs / 1000}s: ${msg}\n`,
            )
            observer?.onRetry?.({ attempt, reason: 'network', delayMs })
            await sleep(delayMs)
            continue
          }
        }

        observer?.onGiveUp?.({ attempts: attempt + 1, error: err })
        throw err
      }
    }
    const giveUpErr = new Error('retryApiCall: max retries exceeded')
    observer?.onGiveUp?.({ attempts: maxRetries, error: giveUpErr })
    throw giveUpErr
  }
}

/**
 * Compose a swallowing wrapper around a `retryApiCall` instance.
 *
 * Use this for **fire-and-forget** Telegram API callsites — boot/issues/
 * subagent cards, "agent restarting" notices, reactions on stale targets,
 * anything where the caller previously had `.catch(() => {})`. The wrapper
 * resolves to `undefined` on the cases retryApiCall throws (THREAD_NOT_FOUND,
 * give-up after network retries, GrammyError 403/400-not-chat, …) and logs
 * a one-line note to `log` so the failure is at least visible in stderr.
 *
 * Why not just `.catch(() => {})` at the callsite? Two reasons:
 *
 *   1. We want THREAD_NOT_FOUND specifically to NOT crash but to be
 *      *visible* — `.catch(() => {})` silently swallows everything, which
 *      hid #1075 for months. The log here surfaces it.
 *   2. Callers shouldn't have to remember to wrap each raw `bot.api.*`
 *      with the retry policy AND the swallow — this is one function.
 *
 * For callsites that legitimately need to inspect failure (e.g. drop
 * thread_id and retry on main chat), use `retryApiCall` directly and
 * handle `THREAD_NOT_FOUND` explicitly — see `gateway.ts:2806` for the
 * canonical pattern (the reply chunk loop).
 */
export function createSwallowingRetryApiCall(
  retry: <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T>,
  log?: (line: string) => void,
): <T>(fn: () => Promise<T>, opts?: RetryCallOpts) => Promise<T | undefined> {
  return async function swallow<T>(
    fn: () => Promise<T>,
    opts?: RetryCallOpts,
  ): Promise<T | undefined> {
    try {
      return await retry(fn, opts)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const verb = opts?.verb ?? 'api-call'
      log?.(`telegram gateway: ${verb} swallowed: ${msg}\n`)
      return undefined
    }
  }
}

/**
 * Helper for callsites that pass `message_thread_id` and want to fall
 * back to the main chat when the thread is deleted.
 *
 * The caller provides a `send` closure that takes `threadId?: number` and
 * builds its own request. On THREAD_NOT_FOUND, `send(undefined)` is invoked
 * once more — the wrapper drops the thread id and re-tries; everything
 * else falls through to the underlying retry policy.
 *
 * Returns the final API response (typed as `T` — fallback resolved, or
 * threadId-bearing call resolved). On non-thread errors, propagates as
 * `retry` does.
 */
export async function retryWithThreadFallback<T>(
  retry: <U>(fn: () => Promise<U>, opts?: RetryCallOpts) => Promise<U>,
  send: (threadId: number | undefined) => Promise<T>,
  opts: { threadId: number | undefined; chat_id: string; verb?: string },
): Promise<T> {
  try {
    return await retry(() => send(opts.threadId), {
      ...(opts.threadId != null ? { threadId: opts.threadId } : {}),
      chat_id: opts.chat_id,
      ...(opts.verb != null ? { verb: opts.verb } : {}),
    })
  } catch (err) {
    if (err instanceof Error && err.message === 'THREAD_NOT_FOUND') {
      // Drop the thread id and retry once on the main chat. Don't pass
      // threadId in opts so a *second* thread-not-found (shouldn't
      // happen) just propagates as a normal error.
      return await retry(() => send(undefined), {
        chat_id: opts.chat_id,
        ...(opts.verb != null ? { verb: opts.verb } : {}),
      })
    }
    throw err
  }
}

/**
 * True when Telegram rejected a message because it couldn't parse the
 * markdown entities we sent on the rich-message path (#2669). There is no
 * new rich-specific error class in grammy 1.44 — a malformed-markdown
 * failure still throws `GrammyError` with the standard
 * `{ ok:false, error_code:400, description }` shape, the same family as the
 * legacy "can't parse entities" 400. These 400s are deliberately NOT
 * swallowed or retried by `retryApiCall` (only not-modified / not-found /
 * thread-not-found are) — they surface to the caller, which recovers by
 * resending the chunk as plain text (no rich-message wrapper, so the
 * parser never runs). Same "caller-level fallback" shape as the
 * THREAD_NOT_FOUND contract above.
 */
export function isHtmlParseRejectError(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 400) return false
  const d = (err.description || '').toLowerCase()
  return (
    d.includes("can't parse entities") ||
    d.includes('can’t parse entities') ||
    d.includes("can't parse") ||
    d.includes('can’t parse') ||
    d.includes('parse markdown') ||
    d.includes('parse rich') ||
    d.includes('unsupported start tag') ||
    d.includes('unclosed start tag') ||
    d.includes("can't find end of the entity") ||
    d.includes('can’t find end of the entity') ||
    // covers both "expected end tag" and "unexpected end tag"
    d.includes('expected end tag')
  )
}
