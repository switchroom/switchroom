/**
 * silent-end.ts — gateway-side state-file writer for the Stop hook.
 *
 * The Stop hook (`telegram-plugin/hooks/silent-end-interrupt-stop.mjs`)
 * reads `$TELEGRAM_STATE_DIR/silent-end-pending.json` to decide whether
 * to block-and-re-prompt or allow the session to end. Pre-#1122 PR3 the
 * file was written from inside the progress-card driver's `onSilentEnd`
 * callback. PR3 deleted the driver and accidentally removed the writer.
 * The hook still ran on every Stop, but the file never appeared, so the
 * hook always allowed the stop → users could ask a question, see 👀
 * fire, and then get nothing back if the model failed to call `reply`.
 *
 * This module is the deterministic replacement. The gateway calls
 * `writeSilentEndState(...)` when a fresh user-message turn ends with
 * zero outbound messages, and `clearSilentEndState(...)` the moment a
 * reply lands. The Stop hook reads the same file and makes its
 * decision — no prompt dependency, no model behaviour required.
 *
 * Retry semantics: on first silent-end the hook blocks the stop with
 * a re-prompt; on the second silent-end (retryCount >= MAX_RETRIES in
 * the hook) the hook lets the session end. We inherit retryCount from
 * any prior state file IFF the prior file's `turnKey` matches — a new
 * turn always starts at retryCount=0.
 *
 * The state file is per-agent (each agent has its own
 * TELEGRAM_STATE_DIR), so two agents going silent at the same time
 * don't collide.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface SilentEndState {
  /** The chat the silent turn was for — used by operator-facing diagnostics. */
  chatId: string
  /** Optional forum thread id, stringified or null. */
  threadId: number | null
  /** Stable identifier for the in-flight turn (statusKey shape). */
  turnKey: string
  /** Incremented each time the Stop hook blocks for this turn. */
  retryCount: number
  /** Wall-clock ms of last write. */
  timestamp: number
}

export interface SilentEndDeps {
  /** State dir root (defaults to `TELEGRAM_STATE_DIR` env). */
  stateDir?: string
  /** stderr writer (defaults to `process.stderr.write`). */
  log?: (line: string) => void
}

function resolveStateDir(deps?: SilentEndDeps): string {
  if (deps?.stateDir != null) return deps.stateDir
  const env = process.env.TELEGRAM_STATE_DIR
  if (env != null && env !== '') return env
  // Same fallback the gateway (`gateway.ts STATE_DIR`) and the Stop
  // hook (`silent-end-interrupt-stop.mjs getStateDir`) already use.
  // Discovered during UAT overnight 2026-05-13: test-harness ran
  // without `TELEGRAM_STATE_DIR` set, so the writer returned null
  // path → no state file ever appeared → hook always read "no
  // silent-end pending" → silent-end recovery never engaged. The
  // hook + writer have to agree on the path.
  //
  // Prefer `process.env.HOME` over `node:os` `homedir()` so the
  // fallback is overridable in tests. Bun's `os.homedir()` reads
  // the system home once at startup and ignores subsequent
  // `process.env.HOME` mutations, which breaks the bun-test pass
  // of `silent-end.test.ts` even though the vitest pass is fine
  // (Node's `os.homedir()` documents `HOME` as the first source).
  // In production both branches yield the same path — `HOME` is
  // always set under the agent's tini-supervised process tree.
  const home = process.env.HOME ?? homedir()
  return join(home, '.claude', 'channels', 'telegram')
}

function resolveStatePath(deps?: SilentEndDeps): string {
  return join(resolveStateDir(deps), 'silent-end-pending.json')
}

function emitLog(deps: SilentEndDeps | undefined, line: string): void {
  if (deps?.log != null) deps.log(line)
  else process.stderr.write(line)
}

/**
 * Write the silent-end state file for the given turn. Inherits
 * retryCount from a prior write IFF the prior write's turnKey matches.
 * Otherwise resets to 0.
 *
 * State path: `${TELEGRAM_STATE_DIR ?? ~/.claude/channels/telegram}/
 * silent-end-pending.json` — exactly matching the path the Stop hook
 * (silent-end-interrupt-stop.mjs) reads. The parent dir is created
 * with `mkdir -p` if it doesn't exist (fresh-install case).
 */
export function writeSilentEndState(
  args: { chatId: string; threadId: number | null; turnKey: string },
  deps?: SilentEndDeps,
): void {
  const statePath = resolveStatePath(deps)
  let retryCount = 0
  try {
    if (existsSync(statePath)) {
      const prev = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SilentEndState>
      if (prev.turnKey === args.turnKey && typeof prev.retryCount === 'number') {
        retryCount = prev.retryCount
      }
    }
  } catch {
    retryCount = 0
  }
  const state: SilentEndState = {
    chatId: args.chatId,
    threadId: args.threadId,
    turnKey: args.turnKey,
    retryCount,
    timestamp: Date.now(),
  }
  try {
    // The fallback path may not exist on a fresh install — mkdir-p
    // before writing. Cheap and idempotent. Without this the writer
    // throws ENOENT in environments where the operator hasn't booted
    // claude before (the dir is normally created by claude itself
    // on first run).
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(state), 'utf8')
    emitLog(
      deps,
      `silent-end: wrote state file turnKey=${args.turnKey} retryCount=${retryCount}\n`,
    )
  } catch (err) {
    emitLog(
      deps,
      `silent-end: failed to write state file: ${(err as Error).message}\n`,
    )
  }
}

/**
 * Clear the silent-end state file IFF it belongs to the given turnKey.
 * Called the moment a reply / stream_reply first-emit lands so the
 * Stop hook doesn't fire a stale block on the next stop.
 *
 * Fail-silent: missing file, mismatched turnKey, or read/unlink errors
 * are all benign. The Stop hook itself defends against stale files via
 * the retryCount mechanism.
 */
export function clearSilentEndState(turnKey: string, deps?: SilentEndDeps): void {
  const statePath = resolveStatePath(deps)
  if (!existsSync(statePath)) return
  try {
    const prev = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SilentEndState>
    if (prev.turnKey !== turnKey) return
    unlinkSync(statePath)
    emitLog(deps, `silent-end: cleared state file turnKey=${turnKey}\n`)
  } catch {
    // best-effort
  }
}

/**
 * Read the state file (for tests + diagnostics). Returns null when
 * absent or unparsable.
 */
export function readSilentEndState(deps?: SilentEndDeps): SilentEndState | null {
  const statePath = resolveStatePath(deps)
  if (!existsSync(statePath)) return null
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as SilentEndState
  } catch {
    return null
  }
}
