/**
 * Shared bot runtime helpers — extracted from gateway.ts as a reusable
 * core that callers can build on without duplicating the boilerplate.
 * Used today by the per-agent gateway; historically also by the
 * standalone foreman bot before its retirement.
 *
 * What lives here:
 *   - `installTgPostLogger` / `installRichMarkdownGuard` /
 *     `installSystemMessageObserver` — the grammy API transformers every
 *     outbound call transits. This layer, not any caller-side wrapper, is the
 *     one seam no `ctx.*` helper or raw `bot.api.*` call can bypass.
 *   - `makeSwitchroomExec` / `makeSwitchroomExecCombined` — factory fns for
 *     the switchroom CLI exec helpers (callers pass their own CLI path / config
 *     env so each process can be configured independently).
 *   - `escapeHtmlForTg`, `preBlock`, `stripAnsi`, `formatSwitchroomOutput` —
 *     pure text-formatting helpers used by both gateways.
 *   - `makeSwitchroomReply` — factory that returns a `switchroomReply`-like
 *     function bound to a thread-resolver; gateway keeps its own resolver.
 *   - `runPollingLoop` — thin wrapper around the grammyjs/runner `run()` call
 *     with built-in 409 retry logic, matching the loop in gateway.ts.
 *
 * IMPORTANT: This module MUST NOT import anything from gateway.ts — the
 * dependency is the other way around. Only import from grammy, node builtins,
 * or other telegram-plugin/shared or telegram-plugin/*.ts modules.
 */

import { GrammyError, type Bot, type Context } from 'grammy'
import { run, type RunnerHandle } from '@grammyjs/runner'
import { execFileSync, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import { clearStaleTelegramPollingState } from '../startup-reset.js'
import { classifyBenignTelegram400, willRetryTelegramFailure } from '../retry-api-call.js'
import { RICH_MESSAGE_MAX_CHARS } from '../format.js'
import { shouldEmitTgPost, type TgPostStatus } from './gw-trace-gate.js'
import { guardAccidentalFormatting } from '../rich-send.js'

// ─── tg-post tag plumbing ─────────────────────────────────────────────────

/**
 * Per-call tag context for `tg-post` log lines. Callers wrap a Telegram
 * API invocation in `withTgPostTags({ turnKey, cardMessageId, ... }, () => ...)`
 * and the transformer reads the tags off the active store and appends them
 * `key=value` after the existing fields. Used to correlate progress-card
 * sends/edits to a turnKey + cardMessageId in days-old session audits.
 *
 * Untagged callers are unaffected — when no store is active, no tag fields
 * are emitted and the existing log shape is byte-for-byte unchanged.
 */
export type TgPostTags = Record<string, string | number>

const tgPostTagStore = new AsyncLocalStorage<TgPostTags>()

/**
 * Run `fn` with the given tags attached to any `tg-post` lines emitted from
 * the inner Telegram API calls. Tags are inherited across awaits within
 * the same async chain (AsyncLocalStorage semantics). Pass an empty record
 * or omit tags entirely to fall back to the untagged shape.
 */
export function withTgPostTags<T>(tags: TgPostTags, fn: () => T): T {
  return tgPostTagStore.run(tags, fn)
}

/** Exposed for the transformer (and tests). Returns undefined when no store is active. */
export function _getTgPostTags(): TgPostTags | undefined {
  return tgPostTagStore.getStore()
}

function formatTgPostTags(tags: TgPostTags | undefined): string {
  if (!tags) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(tags)) {
    if (v == null) continue
    // Sanitise: tag values land in a single-line space-separated log
    // record. Strip whitespace + collapse to keep grep happy.
    const s = String(v).replace(/\s+/g, '_')
    parts.push(`${k}=${s}`)
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

// ─── tg-post observability transformer ────────────────────────────────────

/**
 * Sanitise a Telegram error description for single-line log output —
 * collapse whitespace, strip newlines, cap at 80 chars, `-` when absent.
 * PII-safe: Telegram error descriptions are server-generated and don't
 * echo the request body.
 */
function shortDesc(raw: string | undefined): string {
  if (!raw) return '-'
  return raw.replace(/\s+/g, ' ').slice(0, 80).replace(/[\r\n]/g, ' ') || '-'
}

/**
 * Installs an API transformer on the bot that emits one stderr line per
 * outbound Telegram Bot API POST. This is the single catchment point for
 * correlating user-visible duplicate-message reports (switchroom #656,
 * #657) against the actual outbound calls — the transformer runs inside
 * grammY immediately before each HTTP POST and again on the response, so
 * it sees every call regardless of whether it was routed through the
 * `robustApiCall` retry helper or made directly via `bot.api.*`.
 *
 * Log shape (one line per POST, on both success and failure):
 *
 *   tg-post method=<m> chat=<id> thread=<id|-> parse_mode=<HTML|MarkdownV2|none> bytes=<n> hash=<sha1-12> status=<ok|benign|retry|err> err=<class-or--> code=<http-or--> desc=<short|-->
 *
 * TRUTHFULNESS (#3927): grammY resolves the transformer chain with the raw
 * `ApiResponse`, and only converts `{ok:false}` into a thrown `GrammyError`
 * AFTER the chain returns — verified in the pinned grammy 1.44.0,
 * `out/core/client.js:95-100`:
 *
 *     const data = await this.call(method, payload, signal)   // chain
 *     if (data.ok) return data.result
 *     else throw toGrammyError(data, method, payload)          // OUTSIDE
 *
 * So EVERY Telegram-level rejection (429 flood-wait, 400, 403) arrives here
 * as a RESOLVED response, and the `catch` below only ever sees transport
 * (`HttpError`) failures. Before this was fixed the logger reported every
 * one of them as `status=ok err=- code=- desc=-` — a rate-limited
 * `unpinAllChatMessages` logged as SUCCESS 3ms before the retry policy
 * logged `429 rate limited, waiting 3s`. We therefore inspect the resolved
 * body and report `status=err err=telegram_<code>` from it.
 *
 * The narrow set of benign 400s the retry policy already swallows
 * ("message is not modified", "message to edit/delete not found" —
 * classified by the shared `classifyBenignTelegram400`) gets `status=benign`
 * instead, so promoting real rejections out of `status=ok` doesn't bury
 * `grep status=err` under high-volume card-repaint no-ops.
 *
 * ATTEMPT vs OUTCOME (#3931): this transformer runs INSIDE `fn()`, i.e. below
 * the retry policy, so it sees each attempt separately. A 429 that
 * `createRetryApiCall` sleeps and then retries successfully is not a delivery
 * failure — but it used to write `status=err`, and fleet-health's
 * `reply-delivery-failure` detector (`src/fleet-health/detect.ts`) matches per
 * LINE, so every retried-and-DELIVERED reply raised a severity-3 alert. The
 * retry policy now publishes its attempt context (`_getTgAttemptContext`), and
 * a failure the policy is about to retry is logged `status=retry` instead.
 * `status=err` is therefore an OUTCOME: the logical send is over and nothing
 * landed. Nothing is hidden — the retry lines are still emitted verbatim.
 *
 * Body content is never logged — only its length and a 12-char sha1 prefix
 * so we can recognise repeated identical sends without leaking PII. The
 * `code` field carries the Telegram error_code (400/403/429/etc.) on
 * failure and the short `desc` is the first ~80 chars of the API
 * description — together these let us correlate "duplicate message"
 * reports with the precise rejection reason (issue #657).
 *
 * Pure observability: no behaviour change, no error swallowing, no retry
 * effects. The transformer always re-throws after logging.
 */
export function installTgPostLogger(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const p = (payload ?? {}) as Record<string, unknown>
    const chat = p.chat_id != null ? String(p.chat_id) : '-'
    const thread = p.message_thread_id != null ? String(p.message_thread_id) : '-'
    const parseMode = (p.parse_mode as string | undefined) ?? 'none'
    const text = typeof p.text === 'string' ? p.text : ''
    const bytes = text.length
    const hash = bytes > 0
      ? createHash('sha1').update(text).digest('hex').slice(0, 12)
      : '-'
    const tagSuffix = formatTgPostTags(_getTgPostTags())
    const emit = (status: TgPostStatus, errClass: string, code: string, desc: string) => {
      // #3025: suppress zero-signal per-poll heartbeats (getUpdates/getMe
      // status=ok, one line per ~30s long-poll tick) unless the operator
      // set SWITCHROOM_GW_TRACE. Errors and all other methods still log.
      if (!shouldEmitTgPost(method, status)) return
      process.stderr.write(
        `tg-post method=${method} chat=${chat} thread=${thread} parse_mode=${parseMode} bytes=${bytes} hash=${hash} status=${status} err=${errClass} code=${code} desc=${desc}${tagSuffix}\n`,
      )
    }
    try {
      const res = await prev(method, payload, signal)
      // A RESOLVED response can still be a Telegram-level rejection — grammy
      // converts `{ok:false}` to a thrown GrammyError only after this chain
      // returns (see the docblock). Same defensive shape as the edit fuse's
      // `runObserved` (edit-flood-fuse.ts).
      const r = res as unknown as {
        ok?: boolean
        error_code?: number
        description?: string
        parameters?: { retry_after?: number }
      }
      if (r != null && typeof r === 'object' && r.ok === false) {
        const code = r.error_code
        const benign = classifyBenignTelegram400(code, r.description)
        // #3931 — an attempt the enclosing retry policy is about to repeat is
        // not an outcome; label it `retry` so it is never read as a delivery
        // failure. Terminal rejections keep `status=err`.
        const retrying =
          benign === null &&
          willRetryTelegramFailure({
            errorCode: code ?? null,
            retryAfterSec: r.parameters?.retry_after ?? null,
            message: r.description ?? null,
          })
        emit(
          benign !== null ? 'benign' : retrying ? 'retry' : 'err',
          `telegram_${code ?? 'unknown'}`,
          code != null ? String(code) : '-',
          shortDesc(r.description),
        )
        return res
      }
      emit('ok', '-', '-', '-')
      return res
    } catch (err) {
      const errClass = err instanceof GrammyError
        ? `grammy_${(err as GrammyError).error_code}`
        : (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'Error'
      const code = err instanceof GrammyError ? String((err as GrammyError).error_code) : '-'
      const rawDesc = err instanceof GrammyError
        ? (err as GrammyError).description
        : (err instanceof Error ? err.message : '')
      // #3931 — same attempt-vs-outcome rule as the resolved-rejection branch
      // above. This branch carries the transport (`HttpError`) failures, whose
      // transient members the retry policy backs off and repeats.
      //
      // #4123 — pass `cause`, not just `message`. grammy rewrites every
      // transport failure's message to `Network request for '<method>' failed!`,
      // so a message-only shape classified EVERY transport blip as terminal and
      // wrote `status=err` — which fleet-health escalates as a
      // `reply-delivery-failure` even when the next attempt delivers. The
      // predicate needs the error itself to classify by type.
      const retrying = willRetryTelegramFailure({
        errorCode: err instanceof GrammyError ? (err as GrammyError).error_code : null,
        retryAfterSec:
          err instanceof GrammyError
            ? ((err as GrammyError).parameters?.retry_after ?? null)
            : null,
        message: err instanceof Error ? err.message : String(err ?? ''),
        cause: err,
      })
      emit(retrying ? 'retry' : 'err', errClass, code, shortDesc(rawDesc))
      throw err
    }
  })
}

/**
 * Universal accidental-formatting guard, installed as a grammy API transformer
 * on the single production Bot (#3252/#3463 follow-up). This is the REAL
 * universal seam — not `richMessage()`. `richMessage()` only guards bodies its
 * callers remember to wrap; the correctness audit found ~6 sites that build a
 * raw `{ markdown }` and call `sendRichMessage` / `editMessageText` directly,
 * bypassing it (`shared/bot-runtime.ts` switchroomReply html path,
 * `slot-banner-driver.ts` OAuth banners, and edits in `folder-picker-handler`,
 * `approval-callback`, `inline-keyboard-callbacks`). A transformer at the
 * grammy `bot.api.config.use` layer sees every rich send regardless of the
 * call site, `ctx.*` sugar, `lockedBot`, or `bot.api.raw`, so it closes the
 * whole bypass class deterministically.
 *
 * Payload shape (verified against grammy 1.44.0 `out/core/api.js`, the pinned
 * lockfile version):
 *   - `sendRichMessage(chat_id, rich_message, ...)` → raw payload
 *     `{ chat_id, rich_message: { markdown }, ... }`
 *   - `editMessageText(chat_id, message_id, arg, ...)` → raw payload
 *     `{ ..., rich_message: { markdown } }` when `arg` is an object, or
 *     `{ ..., text }` when `arg` is a plain string.
 * The markdown therefore lives at `payload.rich_message.markdown`, NOT
 * `payload.markdown` (gating on the latter matches nothing — a silent no-op).
 * Gating on `rich_message?.markdown` also structurally skips every literal /
 * plain-string edit (they carry `text`, not `rich_message`), so those pass
 * through byte-identical. `sendRichMessageDraft` is not wired in the repo
 * (draft streaming uses sendMessage+editMessageText); extend the method gate
 * here if a future draft adopter starts using it.
 *
 * The composed `guardAccidentalFormatting` is idempotent, so double-guarding a
 * `richMessage()`-wrapped body that also passes through here is byte-identical
 * (the internal guard in `richMessage()` is kept belt-and-braces).
 *
 * We clone `rich_message` before mutating: callers can share the object by
 * reference (e.g. `richMessage()` output reused across a retry), and a
 * transformer must not mutate the caller's input.
 */
export function installRichMarkdownGuard(bot: Bot): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (
      (method === 'sendRichMessage' || method === 'editMessageText') &&
      payload != null
    ) {
      const p = payload as Record<string, unknown>
      const rich = p.rich_message as { markdown?: unknown } | undefined
      if (rich != null && typeof rich.markdown === 'string') {
        const guarded = guardAccidentalFormatting(rich.markdown)
        if (guarded !== rich.markdown) {
          // Clone rather than mutate the caller's shared object.
          p.rich_message = { ...rich, markdown: guarded }
        }
      }
    }
    return prev(method, payload, signal)
  })
}

// ─── outbound send observation (#4571 / #4599) ────────────────────────────

/**
 * The call-site metadata a send observer wants but the wire payload cannot
 * supply. Structurally the same shape as `ObservedCallOpts` in
 * `gateway/system-message-observer.ts`; declared here so this module keeps its
 * no-imports-from-gateway rule.
 */
export interface TgSendContext {
  chat_id?: string
  threadId?: number
  /** The caller's own label for what this send IS (`activity-summary.send`). */
  verb?: string
}

const sendContextStore = new AsyncLocalStorage<TgSendContext | undefined>()

/**
 * Publish the enclosing call's `{chat_id, threadId, verb}` to the API
 * transformer layer for the duration of `fn`'s async chain. `gateway.ts`'s
 * `robustApiCall` wraps every call it issues; anything sent outside it (a
 * `ctx.reply*` helper, a raw `bot.api.*`) simply observes with no verb.
 */
export function withTgSendContext<T>(ctx: TgSendContext | undefined, fn: () => T): T {
  return sendContextStore.run(ctx, fn)
}

/** Exposed for the transformer (and tests). Undefined outside a wrapped call. */
export function _getTgSendContext(): TgSendContext | undefined {
  return sendContextStore.getStore()
}

/**
 * Install the card-history send observer as a grammy API TRANSFORMER — the
 * real universal outbound seam (#4599).
 *
 * #4571 hooked the observer onto `gateway.ts`'s `robustApiCall`, and
 * `system-message-observer.ts` claimed that was "the ONE chokepoint every
 * gateway outbound already goes through … enforced by the
 * `check-bot-api-wrapping` lint guard". That claim was false on both halves.
 * grammY's `ctx.*` sugar builds the payload and calls `bot.api.*` directly, so
 * `switchroomReply` (`gateway.ts`, the helper every SLASH-COMMAND card answers
 * through — `/usage`, `/model`, `/auth`, `/approvals`, `/start`, `/help`) sends
 * via `ctx.replyWithRichMessage` and never transits `robustApiCall` at all; and
 * the lint guard could not have caught it, because its verb pattern matched
 * only `(bot|lockedBot|ctx)\.api\.<verb>` — it never mentioned `sendRichMessage`
 * and structurally cannot match a `ctx.replyWith*` helper.
 *
 * Measured, not inferred: on a live agent's buffer the `/usage` card at id
 * 20938 left NO row, while the `tg-post` transformer in this very file logged
 * its `sendRichMessage` POST. The transformer layer SAW the send the recorder
 * missed. That is the whole argument for moving here: grammy resolves this
 * chain immediately around the HTTP POST, below every helper, every `ctx.*`
 * shorthand, `lockedBot`, and `bot.api.raw` — there is no call shape that
 * reaches Telegram without passing through it, so no future verb can silently
 * opt out the way `switchroomReply` did.
 *
 * `observe` is injected rather than imported: this module must not depend on
 * anything under `gateway/` (see the file header). The caller keeps ownership
 * of the history writers, the `isGatewayMain && HISTORY_ENABLED` gate, and the
 * empty-body alarm.
 *
 * Only a RESOLVED, `ok:true` response is observed. grammy hands this chain the
 * raw `ApiResponse` and converts `{ok:false}` into a thrown `GrammyError` only
 * after the chain returns (see `installTgPostLogger`'s docblock), so a
 * rejection arrives here as a resolved body and must be skipped — recording a
 * Telegram error object as a card body is exactly the empty-row failure #4576
 * was. Non-message results (`getUpdates` arrays, `getMe`, `true` from
 * `answerCallbackQuery`) are filtered by the observer's own shape test.
 *
 * Pure observation: the response is returned untouched and nothing here can
 * throw into the send path.
 */
export function installSystemMessageObserver(
  bot: Bot,
  observe: (result: unknown, opts?: TgSendContext) => void,
): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal)
    try {
      const r = res as unknown as { ok?: boolean; result?: unknown }
      if (r != null && typeof r === 'object' && r.ok === true) {
        observe(r.result, resolveSendContext(payload))
      }
    } catch {
      /* observing a send must never break the send */
    }
    return res
  })
}

/**
 * Merge the caller-published context with what the outbound PAYLOAD itself
 * carries. The context wins where both exist (it is the caller's own intent);
 * the payload is what keeps an unwrapped `ctx.reply*` send attributable to a
 * chat and topic at all. The response's own `chat.id` still outranks both
 * downstream — this is only the fallback tier.
 */
function resolveSendContext(payload: unknown): TgSendContext | undefined {
  const ctx = sendContextStore.getStore()
  const p = (payload ?? {}) as Record<string, unknown>
  const rawChat = p.chat_id
  const chat_id =
    ctx?.chat_id ??
    (typeof rawChat === 'string' || typeof rawChat === 'number' ? String(rawChat) : undefined)
  const rawThread = p.message_thread_id
  const threadId = ctx?.threadId ?? (typeof rawThread === 'number' ? rawThread : undefined)
  if (chat_id == null && threadId == null && ctx?.verb == null) return undefined
  return {
    ...(chat_id != null ? { chat_id } : {}),
    ...(threadId != null ? { threadId } : {}),
    ...(ctx?.verb != null ? { verb: ctx.verb } : {}),
  }
}

// ─── robustApiCall factory: REMOVED (#3863) ───────────────────────────────
//
// `createRobustApiCall` used to live here as a second `createRetryApiCall`
// wiring "pre-wired with stderr logging", kept for a standalone foreman bot
// that was retired. It had ZERO production callers, and its breaker hooks were
// OPTIONAL (`floodStatePath` defaulted to absent), so the one thing a second
// wiring must never be — a send path blind to the shared flood window — was
// its default. Docblocks in `flood-circuit-breaker.ts` and `flood-429-ledger.ts`
// cited it as a live wiring, which is how a dead function became load-bearing
// documentation for the breaker's completeness argument.
//
// There is one retry wiring per process, built at its own callsite with both
// breaker hooks (`gateway.ts`'s `robustApiCall`, `outbox-sweep.ts`'s sweep
// caller) and enforced by `scripts/check-retry-flood-hooks.mjs`. Do not
// reintroduce a convenience factory here: it re-creates the hook-optional
// default this deletion removed. `tests/no-robust-api-call-factory.test.ts`
// guards that.

// ─── Markdown escape helpers (#2669) ──────────────────────────────────────

/**
 * Escape GFM-markdown specials in a dynamic value interpolated into prose.
 * Kept under the legacy `escapeHtmlForTg` name so callers don't churn.
 */
export function escapeHtmlForTg(text: string): string {
  return text.replace(/([\\`*_~=\[\]|])/g, '\\$1')
}

/**
 * Wrap CLI / command output in a fenced code block. Inside a fence the
 * content is literal (no escaping), so we pass `text` through verbatim —
 * except a fence-closing ``` sequence in the content, which we defuse so it
 * can't terminate the block early.
 */
export function preBlock(text: string): string {
  const safe = text.replace(/```/g, '`​``')
  return '```\n' + safe + '\n```'
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

// Default truncation budget for CLI output bound for Telegram. Post-#2669 the
// rich-message wire cap is RICH_MESSAGE_MAX_CHARS (32768), not the legacy 4096
// plain-text limit; the preBlock fence framing (~8 chars) easily fits the
// remaining headroom.
export function formatSwitchroomOutput(output: string, maxLen = RICH_MESSAGE_MAX_CHARS): string {
  const trimmed = output.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 20) + '\n... (truncated)'
}

// ─── CLI exec factories ───────────────────────────────────────────────────

export interface CliConfig {
  /** Path to the switchroom CLI binary. Defaults to 'switchroom'. */
  cliPath?: string
  /** Optional --config path forwarded to every CLI invocation. */
  configPath?: string
}

/** Returns a function that calls the CLI and returns stdout. */
export function makeSwitchroomExec(cfg: CliConfig = {}) {
  const cli = cfg.cliPath ?? process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
  const config = cfg.configPath ?? process.env.SWITCHROOM_CONFIG

  return function switchroomExec(args: string[], timeoutMs = 15000): string {
    const fullArgs = config ? ['--config', config, ...args] : args
    return execFileSync(cli, fullArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 4 * 1024 * 1024,
    })
  }
}

/** Returns a function that calls the CLI with stderr merged into stdout. */
export function makeSwitchroomExecCombined(cfg: CliConfig = {}) {
  const cli = cfg.cliPath ?? process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
  const config = cfg.configPath ?? process.env.SWITCHROOM_CONFIG

  // Pre-#28 fix this used `execSync(\`${quoted} 2>&1\`, { shell: '/bin/bash' })`,
  // hand-quoting each argument. The shell-quoting was correct today, but the
  // structural shape meant any future caller passing user-controlled input
  // would re-introduce a command-injection class of bug. spawnSync with
  // argv array eliminates the shell entirely; we then concat stdout + stderr
  // ourselves to preserve the merged-output contract callers depend on.
  return function switchroomExecCombined(args: string[], timeoutMs = 15000): string {
    const fullArgs = config ? ['--config', config, ...args] : args
    const result = spawnSync(cli, fullArgs, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 4 * 1024 * 1024,
    })
    const stdout = (result.stdout as string | undefined) ?? ''
    const stderr = (result.stderr as string | undefined) ?? ''
    const merged = stderr.length > 0 ? stdout + stderr : stdout
    if (result.error) throw result.error
    if (result.status !== 0) {
      // Mirror execSync's behaviour: throw on non-zero exit, attaching the
      // merged output so callers (which catch and inspect .stdout) can read it.
      const err = new Error(`Command failed: ${cli} ${fullArgs.join(' ')}`) as Error & {
        stdout?: string
        stderr?: string
        status?: number | null
      }
      err.stdout = merged
      err.stderr = stderr
      err.status = result.status
      throw err
    }
    return merged
  }
}

/** Returns a CLI exec wrapper that parses JSON output (--json flag). */
export function makeSwitchroomExecJson(cfg: CliConfig = {}) {
  const exec = makeSwitchroomExec(cfg)
  return function switchroomExecJson<T = unknown>(args: string[]): T | null {
    try {
      const output = exec([...args, '--json'])
      return JSON.parse(output) as T
    } catch {
      return null
    }
  }
}

// ─── Reply helper factory ─────────────────────────────────────────────────

import { InlineKeyboard } from 'grammy'

export type SwitchroomReplyMarkup =
  | InlineKeyboard
  | { force_reply: true; input_field_placeholder?: string; selective?: boolean }

/**
 * Creates a `switchroomReply` function that sends an HTML reply to the
 * chat in `ctx`, optionally threaded.
 *
 * @param resolveThreadId - returns the thread ID to use for the given
 *   chat_id + optional explicit thread (mirrors gateway's resolveThreadId).
 *   Pass `() => undefined` for bots that don't use forum topics.
 */
export function makeSwitchroomReply(
  resolveThreadId: (chatId: string, explicit?: number | null) => number | undefined,
) {
  return async function switchroomReply(
    ctx: Context,
    text: string,
    options: { html?: boolean; reply_markup?: SwitchroomReplyMarkup } = {},
  ): Promise<void> {
    const chatId = String(ctx.chat!.id)
    const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
    const opts = {
      ...(threadId != null ? { message_thread_id: threadId } : {}),
      ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
    }
    // #2669: `options.html:true` now means "render `text` as GFM markdown via
    // the rich-message path" (legacy field name kept). Plain otherwise.
    if (options.html) {
      await ctx.replyWithRichMessage({ markdown: text }, opts)
    } else {
      await ctx.reply(text, opts)
    }
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────

export interface PollingLoopCallbacks {
  /** Fired once after `getMe()` on the first (non-409) attempt. */
  onReady?: (botUsername: string, botId: number) => void | Promise<void>
  /**
   * Fired exactly once per process lifetime (not on 409 retries) after
   * `onReady`. Use for one-time startup work (command registration, sweeps,
   * intervals).
   */
  onOneTimeSetup?: (botUsername: string) => void | Promise<void>
  /** Fired when the polling loop exits cleanly (runner task resolved). */
  onStop?: () => void | Promise<void>
  /** Called each time a 409 is detected (useful for logging). */
  on409?: (attempt: number, delayMs: number) => void
}

/**
 * Runs a grammyjs/runner polling loop with built-in 409 retry backoff,
 * matching the loop structure in gateway.ts.
 *
 * Returns the RunnerHandle so callers can call `.stop()` on SIGTERM.
 *
 * The promise resolves when the polling loop exits cleanly.
 * The promise rejects on non-409, non-Aborted errors.
 */
export async function runPollingLoop(
  bot: Bot,
  callbacks: PollingLoopCallbacks = {},
): Promise<void> {
  let didOneTimeSetup = false

  for (let attempt = 1; ; attempt++) {
    try {
      await clearStaleTelegramPollingState(bot.api)

      const me = await bot.api.getMe()
      process.stderr.write(`bot-runtime: polling as @${me.username}\n`)

      if (callbacks.onReady) {
        await callbacks.onReady(me.username ?? '', me.id)
      }

      if (!didOneTimeSetup) {
        didOneTimeSetup = true
        if (callbacks.onOneTimeSetup) {
          await callbacks.onOneTimeSetup(me.username ?? '')
        }
      }

      process.stderr.write(`bot-runtime: starting runner pid=${process.pid}\n`)
      const handle: RunnerHandle = run(bot)
      await handle.task()
      if (callbacks.onStop) await callbacks.onStop()
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        if (callbacks.on409) callbacks.on409(attempt, delay)
        process.stderr.write(
          `bot-runtime: 409 Conflict attempt=${attempt} retry_in_ms=${delay}\n`,
        )
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      process.stderr.write(`bot-runtime: polling failed: ${err}\n`)
      throw err
    }
  }
}

// ─── Access guard ─────────────────────────────────────────────────────────

/**
 * Returns true if the sender's user ID is in the allowFrom list.
 * Used by the gateway for sender-allowlist auth gating.
 */
export function isAllowedSender(ctx: Context, allowFrom: string[]): boolean {
  const from = ctx.from
  if (!from) return false
  return allowFrom.includes(String(from.id))
}
