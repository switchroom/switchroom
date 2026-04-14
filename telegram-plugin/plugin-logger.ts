/**
 * Centralized stderr logger for the telegram plugin.
 *
 * Background: every `process.stderr.write(...)` call in server.ts goes to
 * the bun subprocess's stderr, which Claude Code does NOT forward anywhere.
 * That makes the plugin effectively blind in production. This module
 * installs a one-time redirect at startup so every stderr write is ALSO
 * appended to a logfile at `~/.switchroom/logs/telegram-plugin.log` (override
 * via `SWITCHROOM_TELEGRAM_LOG_PATH`), with simple size-based rotation.
 *
 * Design choices:
 * - Wrap `process.stderr.write` rather than editing every callsite. The
 *   original stderr is preserved (still flows to bun), the file sink is
 *   additional.
 * - Synchronous `fs.appendFileSync` / `fs.renameSync`: stderr.write is
 *   already sync-ish in the rest of the codebase and we want the log
 *   line to survive a crash happening on the next tick.
 * - Rotation is cheap (rename current → `.1`) and capped at a single
 *   backup. Logs are debug-grade; no one needs a week of history.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const DEFAULT_LOG_PATH = join(homedir(), '.switchroom', 'logs', 'telegram-plugin.log')
const ROTATE_AT_BYTES = 5 * 1024 * 1024 // 5 MB

export interface PluginLoggerHandle {
  /** Stop intercepting and restore the original stderr.write. */
  uninstall(): void
  /** The resolved logfile path (after env override + dir creation). */
  readonly logPath: string
}

let activeHandle: PluginLoggerHandle | null = null

/**
 * Resolve the effective logfile path. Env override wins; otherwise the
 * default under the user's home dir. Exposed so tests can assert the
 * resolution logic without actually installing the interceptor.
 */
export function resolveLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SWITCHROOM_TELEGRAM_LOG_PATH
  if (override && override.length > 0) return override
  return DEFAULT_LOG_PATH
}

function ensureDir(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // If we can't create the dir, the appendFileSync call will fail and
    // we'll swallow — the original stderr still flows regardless.
  }
}

function rotateIfNeeded(path: string): void {
  try {
    const st = statSync(path)
    if (st.size < ROTATE_AT_BYTES) return
    const backup = `${path}.1`
    renameSync(path, backup)
  } catch {
    // File doesn't exist yet, or rotation failed — either way, keep going.
  }
}

/**
 * Install the stderr interceptor. Idempotent: a second call returns the
 * existing handle. Returns a handle with an `uninstall()` method primarily
 * for tests (production installs once at server bootstrap).
 */
export function installPluginLogger(env: NodeJS.ProcessEnv = process.env): PluginLoggerHandle {
  if (activeHandle != null) return activeHandle

  const logPath = resolveLogPath(env)
  ensureDir(logPath)

  const originalWrite = process.stderr.write.bind(process.stderr)

  const wrapped = function write(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void,
  ): boolean {
    // Forward to original stderr first so behavior is unchanged for anyone
    // reading stderr directly.
    const ok = (originalWrite as (c: unknown, e?: unknown, cb?: unknown) => boolean)(
      chunk,
      encodingOrCb,
      cb,
    )

    // Also append to the logfile. Best-effort: never throw from stderr.write.
    try {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      rotateIfNeeded(logPath)
      appendFileSync(logPath, text)
    } catch {
      // Swallow — we never want the logger to break the host.
    }

    return ok
  } as typeof process.stderr.write

  process.stderr.write = wrapped

  activeHandle = {
    logPath,
    uninstall(): void {
      if (activeHandle == null) return
      process.stderr.write = originalWrite
      activeHandle = null
    },
  }
  return activeHandle
}

/** Exposed for tests that need to reset module-level state. */
export function _resetForTests(): void {
  if (activeHandle != null) {
    try {
      activeHandle.uninstall()
    } catch {
      // ignore
    }
  }
  activeHandle = null
}

/** Constants exported for tests. */
export const _internals = {
  DEFAULT_LOG_PATH,
  ROTATE_AT_BYTES,
}
