/**
 * Per-chat FIFO serialization for outbound Telegram API calls.
 *
 * Without this, concurrent MCP tool handlers (reply, stream_reply, react,
 * edit_message, delete_message, pin_message, forward_message) all call
 * `bot.api.*` independently. When two calls race, HTTP latency can flip
 * their delivery order — a later `reply` can land before an earlier
 * `stream_reply` edit, or a `react` can resolve before the `reply` it
 * reacts to.
 *
 * The fix is a per-chat promise chain: every handler acquires the lock
 * for its `chat_id`, dispatches its API call, then releases. Granularity
 * is `chat_id` (not chat+thread) — different chats run concurrently.
 */

export interface ChatLock {
  /** Run `fn` serialized against other work on the same `chatId`. */
  run<T>(chatId: string, fn: () => Promise<T>): Promise<T>
  /** Wrap a bot.api-shaped object so every method auto-locks on its first arg. */
  wrapBot<B extends { api: Record<string, unknown> }>(bot: B): B
}

export function createChatLock(): ChatLock {
  const chains = new Map<string, Promise<unknown>>()

  function run<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(chatId) ?? Promise.resolve()
    // Swallow the prior result/error for the chain we're about to build on,
    // so one failure doesn't poison the whole chat's queue.
    const next = prior.then(fn, fn)
    // Keep the chain alive only while work is pending. When this call is
    // the tail, clear the map entry to avoid unbounded growth.
    const tracked = next.finally(() => {
      if (chains.get(chatId) === tracked) chains.delete(chatId)
    })
    chains.set(chatId, tracked)
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
          // (getMe, getFile, setMyCommands) fall through as a string of
          // their own — which is fine; they don't need per-chat ordering.
          const first = args[0]
          const key =
            typeof first === 'string' || typeof first === 'number'
              ? String(first)
              : '__global__'
          return run(key, () =>
            (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          )
        }
      },
    }) as B['api']
    return { ...bot, api: wrappedApi }
  }

  return { run, wrapBot }
}
