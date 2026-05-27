/**
 * Per-(chat, thread) FIFO serialization for outbound Telegram API calls.
 *
 * Without this, concurrent MCP tool handlers (reply, stream_reply, react,
 * edit_message, delete_message, pin_message, forward_message) all call
 * `bot.api.*` independently. When two calls race, HTTP latency can flip
 * their delivery order — a later `reply` can land before an earlier
 * `stream_reply` edit, or a `react` can resolve before the `reply` it
 * reacts to.
 *
 * The fix is a per-key promise chain: every handler acquires the lock
 * for its `(chat_id, message_thread_id)` pair, dispatches its API call,
 * then releases. Granularity moved from `chat_id` to `(chat, thread)`
 * in PR2 of the supergroup-mode rollout (CPO ratified 2026-05-27,
 * decision #8=B): for a supergroup agent owning many topics, the old
 * per-chat lock artificially serialized cross-topic sends (an
 * `#alerts` digest queueing behind eight `#planning` stream edits).
 * Now different threads in the same chat dispatch concurrently;
 * per-thread ordering is still preserved (`sendMessage` then
 * `editMessageText` on the returned message_id can't race).
 *
 * Methods without `message_thread_id` in their options (edits,
 * deletes, reactions, pins — Telegram infers thread from message_id)
 * key by `chat_id` alone via the canonical `chatKey(chat, null)`
 * collapse — same behavior as before for those callsites.
 *
 * Telegram's per-chat rate ceiling is still respected via grammY's
 * autoRetry transformer; if two topics in the same chat both burst
 * past the limit, grammY backs off per the Retry-After header — same
 * worst-case behavior as the old per-chat lock, just hit differently.
 * See docs/rfcs/supergroup-mode.md and the
 * `tests/outbound-ordering.test.ts` 429-isolation row.
 */

import { chatKey } from './gateway/chat-key.js'

export interface ChatLock {
  /** Run `fn` serialized against other work on the same `key`. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
  /**
   * Wrap a bot.api-shaped object so every method auto-locks by
   * `(chat_id, message_thread_id)` pair extracted from its arguments.
   */
  wrapBot<B extends { api: Record<string, unknown> }>(bot: B): B
}

export function createChatLock(): ChatLock {
  const chains = new Map<string, Promise<unknown>>()

  function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(key) ?? Promise.resolve()
    // Swallow the prior result/error for the chain we're about to build on,
    // so one failure doesn't poison the whole queue.
    const next = prior.then(fn, fn)
    // Keep the chain alive only while work is pending. When this call is
    // the tail, clear the map entry to avoid unbounded growth.
    const tracked = next.finally(() => {
      if (chains.get(key) === tracked) chains.delete(key)
    })
    chains.set(key, tracked)
    return next
  }

  function wrapBot<B extends { api: Record<string, unknown> }>(bot: B): B {
    const wrappedApi = new Proxy(bot.api, {
      get(target, prop, receiver) {
        const orig = Reflect.get(target, prop, receiver)
        if (typeof orig !== 'function') return orig
        return function (this: unknown, ...args: unknown[]) {
          // By Telegram Bot API convention, the first positional arg of
          // every chat-scoped method is `chat_id`. Methods without one
          // (getMe, getFile, setMyCommands) fall through to a global
          // lane — they have no per-chat ordering constraint.
          const first = args[0]
          if (typeof first !== 'string' && typeof first !== 'number') {
            return run('__global__', () =>
              (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            )
          }
          const chatId = String(first)
          // Try to extract `message_thread_id` from the LAST arg if it's
          // a plain options object. Telegram API convention: options bag
          // is the last positional. Arrays (e.g. `setMessageReaction`'s
          // reactions list) are explicitly excluded — only plain objects
          // can carry message_thread_id. Edits / deletes / reactions /
          // pins infer thread from message_id; they fall through with
          // `null` thread and serialize per-chat as before.
          const last = args[args.length - 1]
          const threadFromOpts =
            last != null &&
            typeof last === 'object' &&
            !Array.isArray(last)
              ? (last as Record<string, unknown>).message_thread_id
              : undefined
          const tid = typeof threadFromOpts === 'number' ? threadFromOpts : null
          return run(chatKey(chatId, tid), () =>
            (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          )
        }
      },
    }) as B['api']
    return { ...bot, api: wrappedApi }
  }

  return { run, wrapBot }
}
