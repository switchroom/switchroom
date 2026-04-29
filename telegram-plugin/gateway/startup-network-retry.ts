/**
 * Bounded exponential-backoff retry for gateway startup network errors.
 *
 * On 2026-04-29 all five switchroom gateways silently broke at boot because
 * `api.telegram.org` was unreachable for ~27 minutes after system boot (the
 * network stack wasn't fully usable when `network-online.target` fired).
 * Grammy threw `HttpError: Network request for 'deleteWebhook'/'getMe' failed!`
 * and the gateway's catch block logged the error and **returned** — leaving the
 * process alive but not polling. No crash, so systemd's `Restart=always` never
 * fired. Telegram → agent delivery was dead until manual restarts.
 *
 * This module provides:
 *
 *   `isBootNetworkError(err)`  — recognises network-layer errors thrown by
 *       grammy's HttpError wrapper and by raw fetch/Node network failures.
 *
 *   `STARTUP_RETRY_DELAYS_MS`  — the chosen backoff schedule.
 *
 *   `gatewayStartupRetry(fn, opts)` — drives the retry loop. Calls `fn()` up to
 *       `maxAttempts` times with delays from `delaysMs`. On success it resolves.
 *       On exhaustion it calls `opts.onExhausted()` (default: `process.exit(1)`)
 *       so systemd's `Restart=always` can restart the unit cleanly.
 *
 * The function is extracted from `gateway.ts`'s top-level IIFE so it can be
 * unit-tested without spinning up the full bot runtime.
 */

export interface StartupRetryOpts {
  /**
   * Delay schedule in milliseconds. Each attempt waits the corresponding
   * element before the NEXT attempt. Length determines max extra attempts
   * (total = delays.length + 1 initial attempt).
   *
   * Defaults to `STARTUP_RETRY_DELAYS_MS` (~2 min budget).
   */
  delaysMs?: number[]

  /** Inject a sleep helper so tests can use fake timers. */
  sleep?: (ms: number) => Promise<void>

  /**
   * Called when all attempts are exhausted. Should NOT return (exit/throw).
   * Defaults to `process.exit(1)`.
   */
  onExhausted?: (lastError: unknown) => never

  /** Log sink for retry progress messages. Defaults to process.stderr.write. */
  log?: (line: string) => void
}

/**
 * Default backoff schedule: 1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 64 s.
 * Total budget including 8 attempts: ~2 min 7 s. Chosen so a typical
 * post-boot network settle (empirically <90 s) is covered with headroom.
 */
export const STARTUP_RETRY_DELAYS_MS: number[] = [
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  32_000,
  64_000,
]

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Returns true if `err` is a transient network-level failure that the startup
 * retry loop should absorb. Covers:
 *
 * - Grammy's `HttpError` (name === 'HttpError'), which wraps fetch/ECONN errors
 *   during `deleteWebhook` and `getMe`.
 * - Raw Node/fetch errors: ECONNRESET, ETIMEDOUT, ENOTFOUND, ECONNREFUSED,
 *   fetch failed, etc.
 */
export function isBootNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // Grammy wraps network errors in HttpError (name is set in the constructor)
  if (err.name === 'HttpError') return true
  const msg = err.message
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('fetch failed') ||
    msg.includes('Network request')
  )
}

/**
 * Attempt `fn()` and retry on `isBootNetworkError` failures using the
 * provided delay schedule.
 *
 * - On success: returns whatever `fn()` resolved to.
 * - On non-network error: re-throws immediately (not a transient boot issue).
 * - On exhausted retries: calls `opts.onExhausted(lastError)` which must not
 *   return (it should exit or throw). The default is `process.exit(1)` so
 *   systemd's `Restart=always` picks up the dead unit.
 */
export async function gatewayStartupRetry<T>(
  fn: () => Promise<T>,
  opts: StartupRetryOpts = {},
): Promise<T> {
  const delays = opts.delaysMs ?? STARTUP_RETRY_DELAYS_MS
  const sleep = opts.sleep ?? DEFAULT_SLEEP
  const onExhausted: (err: unknown) => never =
    opts.onExhausted ??
    ((err: unknown) => {
      process.stderr.write(
        `telegram gateway: startup failed after ${delays.length + 1} attempts — exiting so systemd can restart: ${err}\n`,
      )
      process.exit(1)
    })
  const log =
    opts.log ??
    ((line: string) => {
      process.stderr.write(line.endsWith('\n') ? line : line + '\n')
    })

  const maxAttempts = delays.length + 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isBootNetworkError(err)) throw err
      lastError = err
      if (attempt >= maxAttempts) break
      const delayMs = delays[attempt - 1]
      log(
        `telegram gateway: startup network error (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s: ${err}`,
      )
      await sleep(delayMs)
    }
  }

  return onExhausted(lastError)
}
