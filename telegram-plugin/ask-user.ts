/**
 * Pure helpers for the `ask_user` MCP tool.
 *
 * The runtime side (sending the question, opening a deferred promise,
 * waiting for a Telegram callback or a timeout, returning the chosen
 * option to the agent) lives in `gateway/gateway.ts`. This file owns
 * the parts that have no I/O — argument validation, callback-data
 * encoding/decoding, ID generation — so they can be unit-tested
 * without a grammY mock or a live IPC server.
 *
 * Callback data shape: `aq:<idx>:<askId>` where:
 *   - `aq` is the prefix the gateway's callback dispatcher matches
 *   - `<idx>` is the zero-based index into the `options` array (0-7)
 *   - `<askId>` is an 8-char lowercase-hex token
 *
 * Why an integer index instead of the option text itself: Telegram
 * caps callback_data at 64 bytes, and option text can easily exceed
 * that. The index is constant-size; the gateway resolves it back to
 * the option text from the `pendingAskUser` map at callback time.
 */

import { randomBytes } from 'crypto'

/** Default TTL when caller doesn't pass timeout_ms. 5 min. */
export const ASK_USER_DEFAULT_TIMEOUT_MS = 300_000

/** Hard cap on TTL. 30 min. Beyond this the user has lost context;
 *  the agent should re-ask in the next turn. */
export const ASK_USER_MAX_TIMEOUT_MS = 1_800_000

/** Floor on TTL. 5s. Below this the prompt is impossible to answer. */
export const ASK_USER_MIN_TIMEOUT_MS = 5_000

/** Telegram inline keyboards practically support 8 buttons stacked
 *  vertically before the chat layout gets ugly. The agent should
 *  collapse longer choice sets into category questions. */
export const ASK_USER_MAX_OPTIONS = 8

export interface AskUserArgs {
  chat_id: string
  question: string
  options: string[]
  message_thread_id?: string
  timeout_ms?: number
  reply_to?: string
}

export interface ValidatedAskUserArgs {
  chatId: string
  question: string
  options: string[]
  threadId?: number
  timeoutMs: number
  replyTo?: number
}

/**
 * Validate raw arguments and return a normalised shape. Throws with
 * a user-facing message on any violation. Pure — no I/O.
 */
export function validateAskUserArgs(args: AskUserArgs): ValidatedAskUserArgs {
  if (typeof args.chat_id !== 'string' || args.chat_id.length === 0) {
    throw new Error('ask_user: chat_id is required')
  }
  if (typeof args.question !== 'string' || args.question.trim().length === 0) {
    throw new Error('ask_user: question is required')
  }
  // Telegram message body limit is 4096 chars; leave headroom for the
  // reply markup wrapper. Question over 3500 should be a reply, not a
  // forced-choice question.
  if (args.question.length > 3500) {
    throw new Error('ask_user: question too long (max 3500 chars). Send a reply for prose; ask_user is for short choices.')
  }
  if (!Array.isArray(args.options) || args.options.length < 2) {
    throw new Error('ask_user: options must be an array with at least 2 entries')
  }
  if (args.options.length > ASK_USER_MAX_OPTIONS) {
    throw new Error(`ask_user: too many options (max ${ASK_USER_MAX_OPTIONS})`)
  }
  for (let i = 0; i < args.options.length; i++) {
    const opt = args.options[i]
    if (typeof opt !== 'string' || opt.trim().length === 0) {
      throw new Error(`ask_user: options[${i}] must be a non-empty string`)
    }
    // Telegram inline button text limit: 64 bytes (UTF-8). Reject early
    // with a clear message instead of letting Telegram return a generic
    // 400. Approximate via length — a long emoji-heavy label can fail
    // earlier; catch that at send-time.
    if (opt.length > 64) {
      throw new Error(`ask_user: options[${i}] too long (max 64 chars). Use shorter button labels.`)
    }
  }
  // Optional fields.
  let threadId: number | undefined
  if (args.message_thread_id != null) {
    threadId = Number(args.message_thread_id)
    if (!Number.isFinite(threadId) || threadId <= 0) {
      throw new Error('ask_user: message_thread_id must be a positive integer string')
    }
  }
  let replyTo: number | undefined
  if (args.reply_to != null) {
    replyTo = Number(args.reply_to)
    if (!Number.isFinite(replyTo) || replyTo <= 0) {
      throw new Error('ask_user: reply_to must be a positive integer string')
    }
  }
  // Clamp timeout: floor to 5s, ceiling to 30min, default 5min.
  let timeoutMs = args.timeout_ms ?? ASK_USER_DEFAULT_TIMEOUT_MS
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    throw new Error('ask_user: timeout_ms must be a number')
  }
  if (timeoutMs < ASK_USER_MIN_TIMEOUT_MS) timeoutMs = ASK_USER_MIN_TIMEOUT_MS
  if (timeoutMs > ASK_USER_MAX_TIMEOUT_MS) timeoutMs = ASK_USER_MAX_TIMEOUT_MS

  return {
    chatId: args.chat_id,
    question: args.question,
    options: args.options,
    threadId,
    timeoutMs,
    replyTo,
  }
}

/**
 * Generate a callback-id token. 8 hex chars = 4 bytes random. Plenty
 * of collision resistance for the small set of in-flight asks at any
 * one time (typically 0-1 per chat); much smaller than a UUID, which
 * would eat the 64-byte callback_data budget when concatenated with
 * an option index.
 */
export function generateAskId(): string {
  return randomBytes(4).toString('hex')
}

/**
 * Encode a callback for option `idx` of a given ask. Asserts the
 * encoded length stays within Telegram's 64-byte callback_data budget.
 */
export function encodeAskCallback(askId: string, idx: number): string {
  if (!/^[0-9a-f]{8}$/.test(askId)) {
    throw new Error(`ask_user: invalid askId shape (expected 8 hex chars, got ${askId})`)
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= ASK_USER_MAX_OPTIONS) {
    throw new Error(`ask_user: invalid option index ${idx}`)
  }
  // Resulting shape: aq:<idx>:<askId> e.g. "aq:3:1a2b3c4d" — 14 bytes,
  // safely under the 64-byte cap.
  return `aq:${idx}:${askId}`
}

export interface DecodedAskCallback {
  askId: string
  idx: number
}

/**
 * Parse a callback-data string. Returns null when the string is not
 * an ask_user callback (caller should fall through to the next
 * dispatch arm in that case — same convention as the existing
 * permission and op: callbacks).
 */
export function decodeAskCallback(data: string): DecodedAskCallback | null {
  const m = /^aq:(\d+):([0-9a-f]{8})$/.exec(data)
  if (!m) return null
  const idx = Number(m[1])
  if (idx < 0 || idx >= ASK_USER_MAX_OPTIONS) return null
  return { askId: m[2], idx }
}

/**
 * Outcome union returned to the agent as the ask_user tool result.
 * Keep this stable — agents will branch on `kind` in their prompts.
 */
export type AskUserOutcome =
  | { kind: 'answered'; choice: string; idx: number }
  | { kind: 'timeout' }
  | { kind: 'cancelled'; reason: string }
