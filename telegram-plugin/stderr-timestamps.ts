/**
 * Per-line timestamp wrapper for `process.stderr.write`.
 *
 * The gateway's stderr is captured to `/var/log/switchroom/gateway-supervisor.log`
 * by `start.sh`'s `_switchroom_supervise` redirect. The capture has NO
 * line-level timestamps, which makes it impossible to measure the gap between
 * events (e.g., `bridge registered` → first `dispatch stage=bridge_recover` →
 * first `tg-post method=sendMessage`). Without those gaps the cold-start TTFO
 * RFC's optimization claims (PR #1589) are unverifiable.
 *
 * This module installs a one-time wrapper on `process.stderr.write` that
 * prepends an ISO-8601 timestamp (`[YYYY-MM-DDTHH:MM:SS.mmmZ]`) at the start
 * of each logical line. Line-buffered: partial writes that don't end in `\n`
 * are buffered until they do. Newlines mid-chunk split the chunk into
 * multiple timestamped lines.
 *
 * Layered separately from `plugin-logger.ts`'s file mirror so each can be
 * toggled independently. Order at install time: this wrapper runs FIRST
 * (closest to the original write), then plugin-logger's file mirror sees
 * the timestamped text.
 *
 * Kill switch: `SWITCHROOM_LOG_TIMESTAMPS=0` disables. Default ON.
 */

let installed = false
let originalWrite: typeof process.stderr.write | null = null
let partialBuffer = ''

function isoTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Wrap `process.stderr.write` to prepend an ISO timestamp at each line
 * boundary. Idempotent — second call is a no-op.
 *
 * Returns true when the wrapper was installed (or was already), false when
 * the kill-switch env var disabled it.
 */
export function installStderrTimestamps(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SWITCHROOM_LOG_TIMESTAMPS === '0') return false
  if (installed) return true

  const origin = process.stderr.write.bind(process.stderr)
  originalWrite = origin as typeof process.stderr.write

  const wrapped = function write(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const stamped = stampLines(text)
    return (origin as (c: unknown, e?: unknown, cb?: unknown) => boolean)(
      stamped,
      encodingOrCb,
      cb,
    )
  } as typeof process.stderr.write

  process.stderr.write = wrapped
  installed = true
  return true
}

/**
 * Internal: split `text` into lines, prepend `[ISO] ` to each complete
 * line, leave any trailing partial line buffered for the next call.
 *
 * Exported for tests only.
 */
export function stampLines(text: string, now: () => string = isoTimestamp): string {
  if (text === '') return ''

  let out = ''
  let i = 0
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    if (nl === -1) {
      // No more newlines in this chunk — buffer the rest.
      partialBuffer += text.slice(i)
      break
    }
    // We have a complete line: anything in partialBuffer + slice up to \n.
    const line = partialBuffer + text.slice(i, nl + 1)
    partialBuffer = ''
    out += `[${now()}] ${line}`
    i = nl + 1
  }
  return out
}

/** Test hook: reset module state. */
export function __resetForTests(): void {
  if (installed && originalWrite) {
    process.stderr.write = originalWrite
  }
  installed = false
  originalWrite = null
  partialBuffer = ''
}

/** Test hook: read the current partial buffer (debug-only). */
export function __getPartialBufferForTests(): string {
  return partialBuffer
}
