/**
 * getUpdates heartbeat tracker for the Telegram poll health check.
 *
 * Motivation (incident 2026-06-30):
 *   A single getUpdates TimeoutError left the grammy runner loop silently
 *   frozen. getMe() kept succeeding, so the getMe-only health check
 *   (poll-health.ts) never fired stall recovery. The fleet was deaf for ~2 h.
 *
 * Fix:
 *   Install a grammy API transformer that records the last time getUpdates
 *   completed (success OR error). The poll health check's ping() reads this
 *   timestamp and treats a stale heartbeat as a stall condition — even when
 *   getMe() is healthy.
 *
 *   Updating on error is intentional: a TimeoutError means the runner loop
 *   is still cycling (it retried and got a real error); we only want to
 *   detect a completely frozen loop where getUpdates never returns at all.
 *
 * Usage in gateway.ts:
 *   const heartbeat = createGetUpdatesHeartbeat()
 *   bot.api.config.use(heartbeat.transformer)
 *   // In the poll health check ping:
 *   if (Date.now() - heartbeat.lastMs() > staleThresholdMs) throw ...
 */

/** Grammy API transformer signature (matches bot.api.config.use() parameter). */
export type ApiTransformer = (
  prev: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<unknown>

export interface GetUpdatesHeartbeat {
  /** Grammy API transformer — install via bot.api.config.use(heartbeat.transformer). */
  transformer: ApiTransformer
  /** Milliseconds since epoch of the last getUpdates completion (success or error). */
  lastMs: () => number
  /** Reset the heartbeat to now — call when a new runner starts (e.g. after 409 re-entry). */
  resetToNow: () => void
}

export interface GetUpdatesHeartbeatDeps {
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number
}

/**
 * Creates a getUpdates heartbeat tracker. The returned `transformer` must be
 * installed on bot.api.config before the runner starts.
 *
 * `initialMs` defaults to `now()` to prevent false positives during startup
 * before the runner fires its first poll.
 */
export function createGetUpdatesHeartbeat(
  deps: GetUpdatesHeartbeatDeps = {},
): GetUpdatesHeartbeat {
  const now = deps.now ?? (() => Date.now())
  let lastHeartbeatMs = now()

  const transformer: ApiTransformer = async (prev, method, payload, signal) => {
    try {
      const result = await prev(method, payload, signal)
      if (method === 'getUpdates') lastHeartbeatMs = now()
      return result
    } catch (err) {
      if (method === 'getUpdates') lastHeartbeatMs = now()
      throw err
    }
  }

  return {
    transformer,
    lastMs: () => lastHeartbeatMs,
    resetToNow: () => { lastHeartbeatMs = now() },
  }
}
