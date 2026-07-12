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
 *   | GrammyError 429 (retry_after <= ceiling)      | sleep retry_after seconds, retry          |
 *   | GrammyError 429 (retry_after >  ceiling)      | record window, throw `FLOOD_WAIT_ACTIVE`  |
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
  /**
   * Chat type of the destination (private / group / supergroup / channel).
   * Consumed by the outbound send gate (#3084, send-gate.ts) to key the
   * per-group bucket. Optional and additive — the retry policy ignores it.
   */
  chatType?: 'private' | 'group' | 'supergroup' | 'channel'
  /**
   * For edit calls: the target message id. Enables the send gate's
   * per-message edit floor + last-write-wins coalescing. Retry policy ignores.
   */
  messageId?: number
  /**
   * For edit calls: the rendered payload the send gate hashes to skip no-op
   * edits (identical → dropped) and to coalesce. Retry policy ignores it.
   */
  editPayload?: unknown
  /**
   * Priority class for the outbound send gate's shedding + degraded mode
   * (#3084 PR 2, send-gate.ts). The retry policy itself ignores it; it only
   * governs how the gate treats the call when it is under pressure or a flood
   * window is open:
   *   - `critical`  — final reply chunks, approval / vault cards, error
   *     notices. Never shed; queued unbounded. In degraded mode a critical
   *     send waits for a short window but fails fast (structured
   *     `FLOOD_WAIT_ACTIVE`) when the remaining window is long.
   *   - `useful`    — progress-card creation, worker handbacks, checklists,
   *     boot/config cards. Queued with a TTL; dropped when stale. DEFAULT
   *     when unset.
   *   - `cosmetic`  — typing, reactions, all card EDITS, stream updates,
   *     heartbeats. Shed immediately when no token is free OR any flood
   *     window is open.
   */
  priorityClass?: 'critical' | 'useful' | 'cosmetic'
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
  /**
   * Ceiling (ms) on how long a single 429 flood-wait may be slept IN-PROCESS.
   * A `retry_after` above this is not slept at all — the window is recorded and
   * `FLOOD_WAIT_ACTIVE` is thrown instead (see #3084). Defaults to
   * `DEFAULT_MAX_FLOOD_SLEEP_MS`.
   */
  maxFloodSleepMs?: number
  /**
   * Remaining ms of a KNOWN-OPEN per-bot flood window, or 0 when none.
   *
   * Wired to the #2923 circuit-breaker state file (see
   * `makeFloodWaitProbe`). When the remaining window is LONGER than
   * `maxFloodSleepMs`, `retryApiCall` short-circuits BEFORE issuing the call:
   * the ban is per-bot-token, so nothing can succeed while it's open, and
   * every attempt only feeds the flood counter (#3084). Fails OPEN — a
   * missing/corrupt/throwing probe means "no window", never a silenced bot.
   */
  floodWaitRemainingMs?: () => number
  /** Sleep helper — injected so tests can use fake timers. */
  sleep?: (ms: number) => Promise<void>
  /** Optional observer hooks. */
  observer?: RetryObserver
  /** Optional log sink for flood-wait / network lines. */
  log?: (line: string) => void
  /**
   * Fires whenever a Telegram 429 flood-wait is observed, BEFORE the sleep.
   * The circuit-breaker (#2923) persists the flood-wait window here so that
   * a container restart during an active ban can suppress non-essential
   * sends (boot cards) instead of feeding the same per-bot-token flood
   * counter and prolonging the ban. Best-effort; a throw here is swallowed.
   *
   * The call's `opts` are passed through (#3111) so the hook can open a
   * SCOPE-PRECISE send-gate window: this fires even for a SHORT slept-and-retried
   * 429 that never throws `FLOOD_WAIT_ACTIVE`, so without the opts the gateway
   * could only open a blanket `global` window for those. Existing callers that
   * ignore the second argument are unaffected.
   */
  onFloodWait?: (retryAfterSec: number, opts?: RetryCallOpts) => void
}

/**
 * True when the thrown error is a LOCAL resource-exhaustion failure —
 * ENOSPC (disk/tmpfs full), EDQUOT (quota), EIO, or ENOMEM — rather than a
 * remote Telegram API failure. Issue #2923: an agent's tmpfs filling up
 * wedges the outbound send's local staging step; retrying that as if it
 * were a transient REMOTE failure hammers the Bot API and trips a per-bot
 * flood ban. A local disk error must NOT drive remote retries — surface it
 * as a distinct, non-retryable degraded state instead.
 */
export function isLocalResourceError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  if (typeof code === 'string' && ['ENOSPC', 'EDQUOT', 'EIO', 'ENOMEM'].includes(code)) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return (
    // Word-boundaried so a substring can't false-match; covers the same set
    // as the errno code list above (ENOSPC/EDQUOT/EIO/ENOMEM).
    /\b(ENOSPC|EDQUOT|EIO|ENOMEM)\b/.test(msg) ||
    /no space left on device/i.test(msg) ||
    /disk quota exceeded/i.test(msg)
  )
}

/**
 * Marker error thrown when `retryApiCall` refuses to retry a LOCAL
 * resource-exhaustion failure (#2923). Callers can detect this to surface a
 * "degraded: local disk full" state rather than treating it like a remote
 * send failure worth retrying.
 */
export const LOCAL_RESOURCE_EXHAUSTED = 'LOCAL_RESOURCE_EXHAUSTED'

/**
 * Thrown when every retry is exhausted — a network partition, a Telegram 5xx
 * outage, or a short-but-persistent 429 (only 429s longer than the in-process
 * sleep ceiling raise FLOOD_WAIT_ACTIVE; shorter ones are slept, retried, and
 * end here). Exported as a constant because `approval-hold.ts:holdReasonFor`
 * classifies on it to decide whether an undeliverable approval is HELD — a
 * string that drifts would silently reopen the auto-deny hole.
 */
export const GIVE_UP_MESSAGE = 'retryApiCall: max retries exceeded'

/**
 * Marker error thrown when Telegram's reported `retry_after` exceeds the
 * in-process sleep ceiling (#3084) — i.e. the bot is under a LONG per-bot
 * flood ban, not a momentary rate-limit blip.
 *
 * Carries `{ retryAfterSec, untilTs, original }` so a caller can render a
 * useful degraded state ("rate-limited by Telegram until HH:MM") instead of
 * being parked on an await for hours.
 */
export const FLOOD_WAIT_ACTIVE = 'FLOOD_WAIT_ACTIVE'

/**
 * Shape of the error thrown for an over-ceiling flood-wait.
 *
 * It deliberately carries Telegram's OWN 429 field shape (`error_code: 429`,
 * `parameters.retry_after`) in addition to the friendlier fields. Several
 * best-effort card surfaces duck-type their rate-limit cooldown on exactly
 * those two fields rather than on `instanceof GrammyError`:
 *
 *   - `worker-activity-feed.ts` `extractRetryAfterSecs` → `noteRateLimited`
 *   - `issues-card.ts` `extractRetryAfterSecs`
 *   - `pending-work-progress.ts` (its catch assumes upstream retry_after backoff)
 *
 * All three route through `robustApiCall`, so once retryApiCall stops sleeping
 * a long ban and starts THROWING, they see this marker instead of the raw
 * GrammyError. Without `error_code`/`parameters` they would classify it as a
 * generic 'transient' error, arm NO cooldown, and let their 5-6s heartbeats
 * re-drive a fresh Bot API call into the still-open ban — thousands of requests
 * over a 4.6h window, feeding the very flood counter #2923 exists to starve.
 * Carrying the 429 shape makes the existing cooldown gates fire on the full
 * window with no change to those modules.
 *
 * It remains a plain `Error` (NOT a `GrammyError`), so the `instanceof`-based
 * probes — `isHtmlParseRejectError`, `isMessageTooLongError`,
 * `isPhotoDimensionRejectError` — still correctly do not match it.
 */
export interface FloodWaitActiveError extends Error {
  /** Telegram's reported retry_after, in seconds. */
  retryAfterSec: number
  /** Epoch ms at which the flood window is expected to expire. */
  untilTs: number
  /** Telegram's 429 code — see the duck-typing note above. */
  error_code: 429
  /** Telegram's 429 payload — see the duck-typing note above. */
  parameters: { retry_after: number }
  /** The originating GrammyError, or null for a pre-call short-circuit. */
  original: unknown
}

/**
 * Build the marker with the full Telegram-429 duck-type shape.
 *
 * Exported so the outbound send gate (#3084 PR 2) can COMPOSE the same
 * structured error for its own degraded-mode fail-fast (a critical send into a
 * long open flood window) rather than duplicating the 429 duck-type shape. One
 * error shape means every downstream cooldown gate + the MCP reply path treat a
 * gate fail-fast identically to a retry-layer flood-wait.
 */
export function makeFloodWaitActiveError(
  retryAfterSec: number,
  untilTs: number,
  original: unknown,
): FloodWaitActiveError {
  return Object.assign(new Error(FLOOD_WAIT_ACTIVE), {
    retryAfterSec,
    untilTs,
    error_code: 429 as const,
    parameters: { retry_after: retryAfterSec },
    original,
  })
}

/** True when `err` is the `FLOOD_WAIT_ACTIVE` marker thrown by `retryApiCall`. */
export function isFloodWaitActiveError(err: unknown): err is FloodWaitActiveError {
  return err instanceof Error && err.message === FLOOD_WAIT_ACTIVE
}

/**
 * Default ceiling on a single in-process flood-wait sleep: 120s.
 *
 * Why 120s and not 30-60s: the flood-waits this bot has historically ridden out
 * successfully were 28s and 75s — sleeping through those is the RIGHT behaviour
 * and must not regress, so the ceiling has to sit above 75s with headroom. Why
 * not higher: the ban this guards against (#3084, overlord 2026-07-11) reported
 * retry_after = 16739s (~4.6h). A 120s ceiling bounds the worst case in-process
 * block to maxRetries × 120s (6s→6min at the default 3) instead of hours, which
 * is short enough that a caller — and the human waiting on a reply — gets a
 * degraded answer rather than an apparently-wedged agent.
 */
export const DEFAULT_MAX_FLOOD_SLEEP_MS = 120_000

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
  const maxFloodSleepMs = config.maxFloodSleepMs ?? DEFAULT_MAX_FLOOD_SLEEP_MS
  const sleep = config.sleep ?? DEFAULT_SLEEP
  const observer = config.observer
  const log = config.log
  const onFloodWait = config.onFloodWait
  const floodWaitRemainingMs = config.floodWaitRemainingMs

  /**
   * Remaining ms of a known-open flood window. FAILS OPEN: any throw from the
   * probe (unreadable state dir, corrupt JSON, clock weirdness) is treated as
   * "no window" — a broken marker file must never permanently silence the bot.
   */
  function openWindowMs(): number {
    if (!floodWaitRemainingMs) return 0
    try {
      const ms = floodWaitRemainingMs()
      return Number.isFinite(ms) && ms > 0 ? ms : 0
    } catch {
      return 0
    }
  }

  return async function retryApiCall<T>(
    fn: () => Promise<T>,
    opts?: RetryCallOpts,
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // #3084 — do not send INTO a known-open long ban. Failing the call fast
      // (rather than sleeping it) is only safe if the caller can't just turn
      // around and re-drive it: the card surfaces re-attempt on a 5-6s
      // heartbeat, which over a 4.6h ban would be thousands of requests into
      // the open window — the exact ban-extension the #2923 breaker exists to
      // prevent. So the policy itself refuses to issue the call while the
      // window is open. The ban is per-bot-TOKEN: nothing can succeed during
      // it, so short-circuiting loses no delivery that would otherwise land.
      //
      // Only LONG windows short-circuit (remaining > the sleep ceiling). A
      // short window is left to the normal path — it may already have expired
      // server-side, and today's sleep-and-retry rides it out.
      const remaining = openWindowMs()
      if (remaining > maxFloodSleepMs) {
        const retryAfterSec = Math.ceil(remaining / 1000)
        log?.(
          `telegram gateway: flood window still open for ${retryAfterSec}s — ` +
            `not issuing the ${opts?.verb ?? 'api-call'} (would feed the ban)\n`,
        )
        const gated = makeFloodWaitActiveError(retryAfterSec, Date.now() + remaining, null)
        observer?.onGiveUp?.({ attempts: attempt + 1, error: gated })
        throw gated
      }
      try {
        return await fn()
      } catch (err) {
        const isGrammyErr = err instanceof GrammyError
        const msg = err instanceof Error ? err.message : String(err)
        const desc = isGrammyErr ? (err as GrammyError).description : msg

        // LOCAL resource exhaustion (#2923) — ENOSPC/EDQUOT/EIO/ENOMEM. This
        // is a LOCAL disk/memory failure, not a remote API failure: retrying
        // it in a tight loop is exactly what tripped the per-bot flood ban.
        // Do NOT retry. Throw a distinct, non-retryable marker so the caller
        // surfaces a degraded "local disk full" state and backs off hard.
        if (isLocalResourceError(err)) {
          log?.(
            `telegram gateway: LOCAL resource exhaustion (${(err as { code?: string }).code ?? 'disk/mem'}) — ` +
              `not retrying the send (would feed a flood ban); surfacing degraded state\n`,
          )
          observer?.onGiveUp?.({ attempts: attempt + 1, error: err })
          throw Object.assign(new Error(LOCAL_RESOURCE_EXHAUSTED), { original: err })
        }

        // Flood-wait — sleep retry_after and try again.
        if (isGrammyErr && (err as GrammyError).error_code === 429) {
          const retryAfter = Number(
            (err as GrammyError).parameters?.retry_after ?? 5,
          )
          const delayMs = retryAfter * 1000
          // Persist the flood window so a restart during the ban can suppress
          // non-essential sends instead of extending it (#2923 circuit breaker).
          try {
            onFloodWait?.(retryAfter, opts)
          } catch {
            /* best-effort — never let the breaker hook break the retry path */
          }
          // #3084: a LONG ban must not be slept in-process. On 2026-07-11
          // overlord got retry_after = 16739s (~4.6h); `await sleep(delayMs)`
          // parked the send path — and every caller awaiting it — for hours.
          // That is a wedge primitive, not a retry. Above the ceiling we've
          // already recorded the window (the breaker above suppresses
          // non-essential sends for its duration); now fail FAST with a
          // distinct non-retryable marker so the caller can surface a degraded
          // state. Under the ceiling, behaviour is unchanged: sleep and retry.
          if (delayMs > maxFloodSleepMs) {
            log?.(
              `telegram gateway: 429 flood ban of ${retryAfter}s exceeds the ` +
                `${Math.round(maxFloodSleepMs / 1000)}s in-process sleep ceiling — ` +
                `not sleeping it; surfacing degraded state\n`,
            )
            observer?.onGiveUp?.({ attempts: attempt + 1, error: err })
            throw makeFloodWaitActiveError(retryAfter, Date.now() + delayMs, err)
          }
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
    const giveUpErr = new Error(GIVE_UP_MESSAGE)
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
  // A too-long rejection is a LENGTH error (see isMessageTooLongError) — never
  // route it through the plain-text parse-reject fallback, which would resend
  // the same oversized body and fail again. The caller re-splits instead.
  if (isMessageTooLongError(err)) return false
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

/**
 * True when Telegram rejected the message because the BODY WAS TOO LONG (over
 * the rich-message wire cap), not because the markdown failed to parse.
 *
 * The rich path surfaces this as `RICH_MESSAGE_TEXT_TOO_LONG` (empirically the
 * description for 32769+ chars); the legacy plain-text path used
 * `MESSAGE_TOO_LONG` / "message is too long". A caller that hits this should
 * re-split the body (`splitMarkdownChunks` at a smaller cap) and resend, NOT
 * treat it as a parse-reject (which resends the same oversized payload as
 * plain text). Mirrors rich-send.ts `isLengthError`.
 */
export function isMessageTooLongError(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 400) return false
  const d = (err.description || '').toLowerCase()
  return (
    d.includes('rich_message_text_too_long') ||
    d.includes('message_too_long') ||
    d.includes('text_too_long') ||
    d.includes('message is too long') ||
    d.includes('text is too long')
  )
}

/**
 * True when Telegram rejected a `sendPhoto` / `sendMediaGroup` because the
 * image is unusable AS A PHOTO — dimensions out of range (Telegram caps
 * photos at width+height ≤ 10000 and aspect ratio ≤ 20), the file can't be
 * saved as a photo, or it exceeds the photo-path size ceiling (~10MB;
 * documents allow ~50MB). A tall phone screenshot is the canonical trigger
 * (PHOTO_INVALID_DIMENSIONS in the #klanker 2026-07-10 incident).
 *
 * These 400s are deliberately NOT swallowed or retried by `retryApiCall`
 * (only not-modified / not-found / thread-not-found are) — they surface to
 * the caller, which recovers by re-sending the SAME file as a document
 * (`sendDocument`) so the user still receives it. Same "caller-level
 * fallback" shape as the THREAD_NOT_FOUND and isHtmlParseRejectError
 * contracts above.
 */
export function isPhotoDimensionRejectError(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 400) return false
  const d = (err.description || '').toLowerCase()
  return (
    d.includes('photo_invalid_dimensions') ||
    d.includes('photo_save_file_invalid') ||
    d.includes('photo dimensions') ||
    d.includes('image_process_failed') ||
    // size-driven rejections of the photo path
    d.includes('photo is too big') ||
    d.includes('too big for a photo') ||
    d.includes('image is too big') ||
    d.includes('file is too big')
  )
}
