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
 *   | HttpError (grammy transport failure)          | exponential backoff retry, 3 attempts     |
 *   | Raw network error (fetch failed / ECONN…)     | exponential backoff retry, 3 attempts     |
 *   | ENOSPC/EDQUOT/EIO/ENOMEM (local exhaustion)   | throw `LOCAL_RESOURCE_EXHAUSTED`, no retry|
 *   | Anything else                                 | rethrow immediately                       |
 *
 * The three "swallow" rows are the DEFAULT, not the law: a call site whose
 * contract is "did the target message survive?" sets `rethrowBenign400: true`
 * and gets the original `GrammyError` instead, so it can classify the failure
 * itself. See that option's docblock for the #4065 inertness bug it exists for.
 *
 * The network row is classified by TYPE (`isTransientTransportError`), not by a
 * substring of the message: grammy rewrites every transport failure's message
 * to `Network request for '<method>' failed!`, so the substring form of this
 * row never matched in production and the retry was dead code (#4123).
 */

import { GrammyError, HttpError } from 'grammy'
import { AsyncLocalStorage } from 'async_hooks'

// ─── retry-attempt context (#3931) ────────────────────────────────────────

/**
 * What the retry policy knows about the attempt currently on the wire.
 *
 * Published so the layer BELOW the policy — the `tg-post` observability
 * transformer in `shared/bot-runtime.ts`, which runs inside `fn()` and
 * therefore sees a failure *before* the policy decides what to do with it —
 * can label a doomed-but-non-terminal attempt honestly instead of as a
 * delivery failure. Without it, a 429 that the policy sleeps and retries
 * SUCCESSFULLY still wrote `status=err` to the gateway log, and fleet-health's
 * per-line `reply-delivery-failure` detector escalated a delivered reply
 * (#3931).
 */
export interface TgAttemptContext {
  /** 0-based index of the attempt currently executing. */
  attempt: number
  /** Total attempts this policy will make. */
  maxRetries: number
  /** Longest 429 `retry_after` the policy will sleep in-process. */
  maxFloodSleepMs: number
}

const attemptStore = new AsyncLocalStorage<TgAttemptContext>()

/** The attempt context of the enclosing `retryApiCall`, or undefined outside one. */
export function _getTgAttemptContext(): TgAttemptContext | undefined {
  return attemptStore.getStore()
}

/** Run `fn` with `ctx` visible to `_getTgAttemptContext()` for its whole async chain. */
function withAttemptContext<T>(ctx: TgAttemptContext, fn: () => Promise<T>): Promise<T> {
  return attemptStore.run(ctx, fn)
}

/**
 * Substring classifier for a RAW transport error message (an undici/node error
 * that has not been through grammy's wrapping).
 *
 * NOT sufficient on its own for anything that came out of `bot.api.*` — see
 * `isTransientTransportError`, which is what the retry loop actually calls.
 * grammy rewrites the message of every transport failure, so this predicate
 * returns false for 100% of production send failures if used alone (#4123).
 */
export function isTransientNetworkMessage(msg: string): boolean {
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed') ||
    msg.includes('ENOTFOUND')
  )
}

/**
 * True for a cancellation: `AbortController.abort()` surfaces as a
 * `DOMException`/`Error` with `name === 'AbortError'` (node also sets
 * `code === 'ABORT_ERR'`). Checked structurally rather than by `instanceof`
 * because the shape differs across the fetch implementations grammy can be
 * handed (undici, node-fetch, a test double).
 */
function isAbortError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown } | null
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR'
}

/**
 * Is `err` a transient TRANSPORT failure the policy should back off and repeat?
 *
 * This is the single classifier the retry loop and `willRetryTelegramFailure`
 * both call, so the policy and the logging tier cannot disagree about what
 * counts as retryable (#3931).
 *
 * Why this is a TYPE test and not a message test (#4123): grammy funnels every
 * fetch rejection through `toHttpError` (grammy 1.44.0, `out/core/client.js:58`
 * → `out/core/error.js:76-83`), which throws away the original error text and
 * renders `Network request for '<method>' failed!`. The underlying
 * `fetch failed` / `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` string is preserved
 * only on `HttpError.error`, and is appended to the message only when
 * `client.sensitiveLogs` is on — which we deliberately leave off, because it
 * writes the bot-token URL into logs. So a substring match over the message
 * matched NOTHING in production: the network-retry branch was dead code and a
 * single connection blip terminally failed the send.
 *
 * The classes, and why each lands where it does:
 *
 *   - `GrammyError`  — an API-LEVEL rejection: Telegram answered, and said no.
 *     Never part of the network class. 429 has its own sleep-and-retry branch
 *     above; everything else (400/403/404/…) is terminal and must NOT be
 *     retried. This is the invariant the old `!isGrammyErr` guard at the
 *     callsite protected; it now lives here, in one place, next to the reason.
 *   - local resource exhaustion — ENOSPC/EDQUOT/EIO/ENOMEM is a LOCAL disk or
 *     memory failure. Retrying it in a tight loop is what tripped the per-bot
 *     flood ban (#2923). Excluded even when grammy wrapped it.
 *   - `HttpError`    — transport by construction: it exists only on the
 *     "the fetch never produced a Telegram response" path (connection reset,
 *     DNS failure, request timeout, unparseable proxy 5xx). Retryable.
 *   - anything else  — a raw error that never went through grammy (or a nested
 *     cause): fall back to the errno/message classifier.
 */
export function isTransientTransportError(err: unknown): boolean {
  if (err instanceof GrammyError) return false
  if (isLocalResourceError(err)) return false
  if (err instanceof HttpError) {
    // grammy stashes the original rejection on `.error`.
    const inner = (err as HttpError).error
    // A local disk failure during a multipart upload can surface here; it
    // stays non-retryable (#2923).
    if (isLocalResourceError(inner)) return false
    // A CALLER-initiated cancellation is not a transient failure — retrying it
    // only re-aborts three times and adds backoff sleeps to shutdown. grammy's
    // own request TIMEOUT is NOT this case: `createTimeout` rejects the race
    // with a plain `Error("Request to '<m>' timed out after Ns")` BEFORE it
    // aborts the controller (grammy 1.44.0, out/core/client.js:168-178), so a
    // timeout arrives as that Error and remains retryable. An `AbortError`
    // here means something aborted the signal we were handed (`bot.stop()`).
    if (isAbortError(inner)) return false
    return true
  }
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (isTransientNetworkMessage(msg)) return true
  // One level of standard cause-chaining (`new Error(x, { cause })`), so a
  // wrapper that preserves the transport error is still classified correctly.
  const cause = (err as { cause?: unknown } | null)?.cause
  if (cause == null || cause === err) return false
  if (isLocalResourceError(cause)) return false
  return isTransientNetworkMessage(cause instanceof Error ? cause.message : String(cause))
}

/** The parts of a Telegram failure that decide retryability. */
export interface TgFailureShape {
  /** Telegram `error_code`, or null/undefined for a transport-level error. */
  errorCode?: number | null
  /** Telegram `parameters.retry_after`, seconds. */
  retryAfterSec?: number | null
  /** Transport-level error message (only consulted when `errorCode` is absent). */
  message?: string | null
  /**
   * The thrown error itself, when the caller has it.
   *
   * STRONGLY PREFERRED over `message` for anything that came out of `bot.api.*`:
   * grammy rewrites the message of every transport failure, so a message-only
   * shape cannot tell a retryable `HttpError` from a terminal one (#4123). Pass
   * the error and the predicate classifies by type, exactly as the loop does.
   */
  cause?: unknown
}

/**
 * Will the enclosing retry policy issue ANOTHER attempt after this failure?
 *
 * `true` means the failure is non-terminal: a later attempt may still deliver,
 * so it must not be logged (or detected) as a delivery failure. `false` means
 * either there is no retry policy above this call, or this attempt is the last
 * one, or the error class is not retryable — i.e. the failure IS the outcome.
 *
 * Mirrors `createRetryApiCall`'s loop exactly:
 *   - no enclosing policy                           ⇒ terminal
 *   - last attempt (`attempt >= maxRetries-1`)      ⇒ terminal (loop falls through)
 *   - 429 with `retry_after` over the sleep ceiling ⇒ terminal (FLOOD_WAIT_ACTIVE)
 *   - 429 under the ceiling                         ⇒ retried
 *   - transient transport error                     ⇒ retried
 *   - anything else                                 ⇒ terminal (rethrown)
 */
export function willRetryTelegramFailure(
  failure: TgFailureShape,
  ctx: TgAttemptContext | undefined = _getTgAttemptContext(),
): boolean {
  if (ctx == null) return false
  if (ctx.attempt >= ctx.maxRetries - 1) return false
  if (failure.errorCode === 429) {
    const retryAfter = Number(failure.retryAfterSec ?? 5)
    const delayMs = (Number.isFinite(retryAfter) ? retryAfter : 5) * 1000
    return delayMs <= ctx.maxFloodSleepMs
  }
  if (failure.errorCode != null) return false
  // Classify by TYPE when the caller handed us the error (the seam that
  // matters — see `isTransientTransportError`); fall back to the message only
  // for shapes reconstructed from a log line, which have nothing else.
  if (failure.cause != null) return isTransientTransportError(failure.cause)
  return isTransientTransportError(new Error(failure.message ?? ''))
}

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
   *     boot/config cards. Queued with a TTL; dropped when stale.
   *   - `cosmetic`  — typing, reactions, all card EDITS, stream updates,
   *     heartbeats. Shed immediately when no token is free OR any flood
   *     window is open.
   *
   * UNTAGGED default — NOT `useful`. This doc said "`useful` — DEFAULT when
   * unset" and was factually wrong (#3664); it is the comment a reader
   * reasoning about droppability lands on, so read the corrected rule:
   *
   *   - An untagged non-edit SEND admits as `UNTAGGED_SEND_CLASS` in
   *     `send-gate.ts`, which is `'critical'` — non-droppable, never shed.
   *   - An untagged EDIT is recorded `useful`, but the gate only SHEDS edits
   *     classed `cosmetic`; an untagged edit coalesces (latest payload wins)
   *     rather than dropping.
   *
   * So nothing is droppable unless a call site OPTS IN by tagging
   * `useful`/`cosmetic`. See the `PriorityClass` docblock in send-gate.ts for
   * the authoritative statement.
   */
  priorityClass?: 'critical' | 'useful' | 'cosmetic'
  /**
   * Opt OUT of the benign-400 swallow for this one call (#4065 follow-up).
   *
   * By default `retryApiCall` treats the benign 400s
   * (`classifyBenignTelegram400`: not-modified / message-to-edit-not-found /
   * message-to-delete-not-found) as non-events and RESOLVES `undefined`. That
   * is right for fire-and-forget card repaints, and wrong — silently, and in
   * the worst direction — for any caller whose contract is "tell me whether
   * the target message still exists".
   *
   * The concrete failure this exists for: the rollout narration card's edit
   * relay (`gateway/rollout-status-edit.ts`) infers edit success from the
   * ABSENCE of a throw and reports it to hostd. A seeded-resume narrator
   * holding a carried `narration_message_id` for a card the operator deleted
   * gets `400 "message to edit not found"` — which the default swallow turns
   * into a resolved promise, so the handler replies `{ok:true}` and hostd
   * records a frozen card as live and never re-posts. The `gone` signal — the
   * whole reason that feature exists — is unreachable on the production path
   * for its primary trigger. Classification has to happen where the error
   * still exists, so the call site asks for the error instead of a
   * lie-shaped success.
   *
   * When true, a benign 400 is RETHROWN unchanged (still `GrammyError`, with
   * its `description` intact) after `observer.onBenign` fires, so the caller
   * classifies it itself. Everything else — 429 handling, the flood breaker,
   * network retries, `THREAD_NOT_FOUND` — is untouched. Default `false`:
   * every existing call site keeps today's exact behaviour.
   *
   * Note this covers BOTH benign kinds deliberately. `not modified` also
   * resolves `undefined` today, which coincidentally matches the intended
   * semantics for an edit relay (the live card already carries this body =
   * success) — but "coincidentally right" is not a contract. Rethrowing both
   * puts ONE classifier in charge (the caller's), so the two kinds can never
   * drift apart on the swallow boundary.
   */
  rethrowBenign400?: boolean
}

/**
 * The three benign Telegram 400s this policy swallows (contract table above).
 */
export type BenignTelegram400Kind = 'not_modified' | 'message_not_found' | 'delete_not_found'

/**
 * Single source of truth for "is this Telegram 400 a benign no-op?".
 *
 * Benign here means exactly what the retry policy already treats as a
 * non-event: the edit was a no-op because the content is identical, or the
 * target message vanished before the edit/delete landed. Both are
 * high-volume on a healthy agent (every coalesced card repaint can produce
 * one) and neither means anything is wrong — so any surface that reports
 * Telegram failures needs to tell them apart from a real rejection WITHOUT
 * maintaining a second copy of the description list (#3927). The retry
 * policy's own swallow branches call this, so there is one list.
 *
 * Returns the benign kind, or `null` for everything else — including 429,
 * 403, and any 400 not on this deliberately narrow list. A new benign
 * description belongs here, not in a caller.
 */
export function classifyBenignTelegram400(
  errorCode: number | undefined,
  description: string | undefined,
): BenignTelegram400Kind | null {
  if (errorCode !== 400) return null
  const desc = (description ?? '').toLowerCase()
  // "message is not modified" / "message was not modified" — Telegram's
  // no-op-on-equal-text.
  if (desc.includes('not modified')) return 'not_modified'
  // "message to edit/delete not found" — the target vanished.
  if (desc.includes('message to edit not found')) return 'message_not_found'
  if (desc.includes('message to delete not found')) return 'delete_not_found'
  return null
}

export interface RetryObserver {
  /** Fires just before sleeping for a retry. */
  onRetry?(info: { attempt: number; reason: 'flood_wait' | 'network'; delayMs: number }): void
  /** Fires when max retries is reached and the wrapper gives up. */
  onGiveUp?(info: { attempts: number; error: unknown }): void
  /**
   * Fires for each benign 400 we CLASSIFIED (not-modified, not-found) —
   * whether it was then swallowed (the default) or rethrown because the call
   * set `rethrowBenign400`. The Telegram-side event is the same either way, so
   * counting it must not depend on the disposition.
   */
  onBenign?(info: { kind: BenignTelegram400Kind }): void
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
        // #3931 — publish the attempt context for the duration of the wire
        // call so the `tg-post` transformer underneath can tell a retried
        // failure from a terminal one.
        return await withAttemptContext({ attempt, maxRetries, maxFloodSleepMs }, fn)
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

        // Swallow the benign 400s — "message is not modified" (Telegram's
        // no-op-on-equal-text) and "message to edit/delete not found" (the
        // target vanished). Classification lives in `classifyBenignTelegram400`
        // so the tg-post logger reports the same family identically (#3927).
        const benignKind = isGrammyErr
          ? classifyBenignTelegram400((err as GrammyError).error_code, desc)
          : null
        if (benignKind !== null) {
          observer?.onBenign?.({ kind: benignKind })
          // #4065 follow-up: a caller whose contract is "does the target
          // message still exist?" opts out of the swallow, because a resolved
          // promise is indistinguishable from a landed edit. Rethrow the
          // ORIGINAL error so the caller classifies off `description`.
          if (opts?.rethrowBenign400) throw err
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
        // Classified by TYPE, not by message substring: grammy rewrites the
        // message of every transport failure, so the old substring test never
        // fired in production and this whole branch was dead (#4123). The
        // `!isGrammyErr` guard that used to sit here now lives inside
        // `isTransientTransportError`, which excludes GrammyError explicitly.
        if (isTransientTransportError(err)) {
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
