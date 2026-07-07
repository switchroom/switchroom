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
  /**
   * Has a genuine assistant reply been delivered to this chat (optionally
   * scoped to thread) at or after `sinceMs`? Same predicate shape as
   * `history.hasOutboundDeliveredSince` / the represent-guard's dep
   * (`gateway/represent-guard.ts`) — injected here so the exhaustion check
   * below is a pure, testable decision. When omitted (history unavailable,
   * or callers that don't wire it), the check is skipped and the guard
   * falls back to the pre-existing turnKey/retryCount bookkeeping only —
   * never suppress on doubt.
   */
  hasOutboundDeliveredSince?: (chatId: string, sinceMs: number, threadId?: number | null) => boolean
}

/**
 * How many times the Stop hook re-prompts a silent-end turn before it
 * gives up. MUST stay in sync with `MAX_RETRIES` in the Stop hook
 * (`telegram-plugin/hooks/silent-end-interrupt-stop.mjs`) — the hook is a
 * standalone `.mjs` and can't import this module.
 *
 * 2026-05-25 bump from 1 → 2. With the original budget of 1, a model
 * that stubbornly emitted `type:"text"` + `stop_reason:"end_turn"` twice
 * in a row (instead of calling the reply tool) fell through to the
 * gateway's 5-minute silence-poke framework-fallback. Second-retry
 * cases now get a chance before the user-visible nudge fires. Memory:
 * the Stop hook prompt itself is explicit ("only text sent through the
 * reply tool is delivered. Send your final answer now"), so a second
 * nudge isn't redundant — it's giving a different sample from the
 * model under the same prompt.
 */
export const SILENT_END_MAX_RETRIES = 2

/**
 * User-facing fallback text delivered when a user-message turn ends with no
 * final answer AND the deterministic Stop-hook re-prompt has already been
 * exhausted (#1161). Without this the user only sees the progress card
 * vanish; silence must never be the failure mode.
 *
 * PR #2892 (reference/rfcs/deterministic-turn-liveness.md Phase 2
 * hardening): include the turn's elapsed so the fallback is honest about
 * how long the user actually waited, instead of a generic apology with no
 * timing. A degenerate/unknown duration (missing, non-finite, or <= 0 —
 * e.g. a turn whose `startedAt` was never stamped) omits the waited clause
 * rather than printing a nonsensical "(waited 0s)".
 *
 * Lives here (not gateway.ts) so the transport-boundary tests exercise the
 * REAL string (tests/silent-end-transport.test.ts), not a hand-maintained
 * copy — gateway.ts is not importable in tests.
 */
export function silentEndFallbackText(turnDurationMs: number | undefined): string {
  const elapsed =
    typeof turnDurationMs === 'number' && Number.isFinite(turnDurationMs) && turnDurationMs > 0
      ? ` (waited ${Math.round(turnDurationMs / 1000)}s)`
      : ''
  return (
    '⚠️ The agent finished working but didn’t send a reply' +
    elapsed +
    ' — your last message may not have been answered. Please try asking again.'
  )
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
 * Pre-#1664 (`commit f664cde8`) state files lacked a `turnKey` field
 * entirely. The strict `prev.turnKey !== turnKey` check meant
 * `undefined !== <anything>` was always true, so legacy files survived
 * every clear path and remained readable by the Stop hook indefinitely.
 * In production this stranded clerk with `retryCount=1` for ~hours
 * across two container restarts, breaking the Stop hook's retry budget
 * for every subsequent silent-end (the 2026-05-25 incident).
 *
 * Tolerance: treat a missing `prev.turnKey` as "stale unknown, unlink
 * it" rather than "preserve". Strict comparison still applies when
 * both sides are present, so the same-turn invariant is preserved.
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
    if (prev.turnKey != null && prev.turnKey !== turnKey) return
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

/**
 * Record a user-message turn that ended WITHOUT the model delivering a
 * final answer, and report whether the deterministic re-prompt has been
 * exhausted. This is the gateway's single entry point for the main
 * turn-end path.
 *
 * #1664 — the trigger generalized from "zero outbound" to "no final
 * answer delivered". Two cases reach here now:
 *   1. Zero outbound — the turn ended with nothing sent at all (the
 *      original #1122/#1161 silent-end case).
 *   2. Interim-ack only — the model sent an ack via reply/stream_reply
 *      but ended the turn with its real answer as plain transcript text
 *      (rendered into an ephemeral answer-lane draft that gets retracted
 *      at turn_end, never finalized). The gateway tracks this via
 *      `CurrentTurn.finalAnswerDelivered`; case 1 is just the subset
 *      where that flag is false because nothing landed.
 * In both cases the model still owes the user an answer, so the same
 * re-prompt safety net applies — the framework re-prompts; the model
 * re-delivers via the reply tool (never the framework materializing a
 * message from the draft — see `reference/principles.md`).
 *
 *   - First undelivered turn-end (no prior state, or prior `retryCount`
 *     still below `SILENT_END_MAX_RETRIES`) → writes the state file via
 *     `writeSilentEndState`, so `silent-end-interrupt-stop.mjs` blocks
 *     the stop and re-prompts the agent. Returns `{ exhausted: false }`.
 *
 *   - An undelivered turn-end where the prior state for the SAME turn
 *     already shows `retryCount >= SILENT_END_MAX_RETRIES` → the Stop
 *     hook already spent its re-prompt and the agent is STILL
 *     undelivered. Recovery has failed. Clears the state file (so the
 *     Stop hook on this final turn finds nothing pending and allows the
 *     stop cleanly) and returns `{ exhausted: true }` — the caller MUST
 *     then deliver a user-facing fallback so the turn never just
 *     vanishes (#1161).
 *
 * Chat-less autonomous wakeup turns never reach here: the gateway only
 * creates a `currentTurn` (and therefore only runs a turn-end handler)
 * when the inbound event carries a chat id. Cron-fired turns DO carry a
 * topic chat and reach this path — a cron task that means to stay silent
 * must emit a NO_REPLY sentinel, which routes to the gateway's
 * silent-marker branch and never gets a fallback.
 */
export function recordSilentTurnEnd(
  args: { chatId: string; threadId: number | null; turnKey: string },
  deps?: SilentEndDeps,
): { exhausted: boolean } {
  const prev = readSilentEndState(deps)
  if (
    prev != null &&
    prev.turnKey === args.turnKey &&
    prev.retryCount >= SILENT_END_MAX_RETRIES
  ) {
    // Staleness guard (mirrors the represent-guard's #2472 fix,
    // `gateway/represent-guard.ts:shouldSuppressRepresent`): `turnKey` here
    // is `statusKey(chatId, threadId)` — stable across every turn on the
    // same chat/thread, NOT a per-turn nonce (unlike the obligation
    // ledger's `originTurnId`). The whole mechanism depends on a reply
    // ALWAYS clearing this state file via `clearSilentEndState` at the
    // send-site. `clearSilentEndState` is fail-silent by design (state
    // corruption / a write race must never crash the gateway), so if a
    // clear is ever missed, a stale `retryCount >= MAX_RETRIES` record
    // from an OLD, already-answered turn would be misread as "this
    // brand-new dark turn already exhausted its re-prompt budget" —
    // firing the user-facing fallback immediately, without the turn ever
    // going through the Stop-hook re-prompt ladder. Before trusting that
    // reading, verify against real delivery history: has a genuine reply
    // landed on this chat/thread since the stale record was last written?
    // If so, the record is satisfied-but-misdetected — drop it silently
    // and let this dark turn start its OWN fresh retry cycle instead of
    // inheriting someone else's spent budget.
    if (deps?.hasOutboundDeliveredSince?.(args.chatId, prev.timestamp, args.threadId)) {
      emitLog(
        deps,
        `silent-end: stale exhausted record for turnKey=${args.turnKey} ` +
          `(retryCount=${prev.retryCount}) but a reply was delivered since ` +
          `${prev.timestamp} — treating as satisfied-but-misdetected, not exhausted\n`,
      )
      // MUST clear before writing (adversarial review of #2892):
      // writeSilentEndState re-inherits retryCount whenever the on-disk
      // turnKey matches — which it ALWAYS does here, since turnKey is the
      // stable statusKey(chatId, threadId). Writing over the stale record
      // directly would start the "fresh" ladder at retryCount=MAX: the
      // Stop hook would see retryCount >= MAX_RETRIES and never re-prompt,
      // while this call just returned exhausted:false so no fallback fires
      // either — pure silence, strictly worse than the pre-fix behaviour.
      // Clearing first makes the new record genuinely start at retryCount=0.
      clearSilentEndState(args.turnKey, deps)
      writeSilentEndState(args, deps)
      return { exhausted: false }
    }
    clearSilentEndState(args.turnKey, deps)
    emitLog(
      deps,
      `silent-end: re-prompt exhausted for turnKey=${args.turnKey} ` +
        `(retryCount=${prev.retryCount} >= ${SILENT_END_MAX_RETRIES}) — ` +
        `caller should deliver a fallback\n`,
    )
    return { exhausted: true }
  }
  writeSilentEndState(args, deps)
  return { exhausted: false }
}

/**
 * #1664 — semantic alias for `recordSilentTurnEnd`. The trigger is now
 * "no final answer delivered", of which "zero outbound" is one case; new
 * callsites should prefer this name so the intent reads correctly. The
 * behaviour, retry semantics, and `{exhausted}` contract are identical —
 * `recordSilentTurnEnd` is kept for the existing callers and tests.
 */
export const recordUndeliveredTurnEnd = recordSilentTurnEnd
