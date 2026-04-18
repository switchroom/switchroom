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
