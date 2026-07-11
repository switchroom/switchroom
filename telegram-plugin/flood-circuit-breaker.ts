/**
 * Telegram per-bot flood-wait circuit breaker (issue #2923).
 *
 * When a burst of outbound sends trips Telegram's per-bot-token flood limit,
 * the API returns `429 { retry_after: N }` — a SERVER-SIDE ban on the bot
 * token that no client-side lever clears early (observed retry_after ~4116s,
 * ~68 min). The failure is misleading: the container is `Up`, the gateway is
 * polling, inbound works — but every outbound send is rejected. Worse, each
 * `docker restart` posts a fresh boot/config card = another send INTO the
 * open window, which can reset/extend the flood counter. A local, recoverable
 * disk-full problem thereby amplifies into a remote, unrecoverable ban.
 *
 * This breaker persists the flood-wait window to disk so that:
 *   - `retryApiCall`'s `onFloodWait` hook records it the moment a 429 is seen;
 *   - a restart-time NON-ESSENTIAL send (boot card, config summary) consults
 *     `isFloodWaitActive` and SKIPS while the ban is open, so a restart during
 *     a flood-wait doesn't feed the counter and prolong the ban.
 *
 * The state file is tiny JSON under the agent's telegram state dir. All the
 * logic is pure + injectable so it unit tests without a real clock or bot.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface FloodWaitState {
  /** Epoch ms at which the flood-wait window expires. */
  untilTs: number
  /** The retry_after (seconds) Telegram reported, for diagnostics. */
  retryAfterSec: number
  /** Epoch ms the window was (re)recorded. */
  recordedTs: number
}

/** Default marker filename inside the telegram state dir. */
export const FLOOD_STATE_FILE = 'flood-wait.json'

/**
 * Resolve the flood-wait marker path from a telegram state dir. Kept as a
 * helper so callers share one location.
 */
export function floodStatePath(stateDir: string): string {
  return join(stateDir, FLOOD_STATE_FILE)
}

/**
 * Compute the flood-wait state for an observed `retry_after`. Extends (never
 * shrinks) an existing window: if a fresh 429 reports a shorter remaining ban
 * than we already recorded, we keep the longer expiry — the server is the
 * authority and being conservative avoids sending back into an open window.
 */
export function computeFloodWait(
  prior: FloodWaitState | null,
  retryAfterSec: number,
  now: number,
): FloodWaitState {
  const candidate = now + Math.max(0, retryAfterSec) * 1000
  const untilTs = prior && prior.untilTs > candidate ? prior.untilTs : candidate
  return { untilTs, retryAfterSec, recordedTs: now }
}

/** Remaining ban time in ms (0 when no active window). */
export function floodWaitRemainingMs(state: FloodWaitState | null, now: number): number {
  if (!state) return 0
  return Math.max(0, state.untilTs - now)
}

/** True while the flood-wait ban is still open. */
export function isFloodWaitActive(state: FloodWaitState | null, now: number): boolean {
  return floodWaitRemainingMs(state, now) > 0
}

/** Read persisted flood state; null on absence / parse failure. */
export function readFloodState(path: string): FloodWaitState | null {
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<FloodWaitState>
    if (typeof raw.untilTs !== 'number') return null
    return {
      untilTs: raw.untilTs,
      retryAfterSec: typeof raw.retryAfterSec === 'number' ? raw.retryAfterSec : 0,
      recordedTs: typeof raw.recordedTs === 'number' ? raw.recordedTs : 0,
    }
  } catch {
    return null
  }
}

/** Persist flood state (best-effort — a write failure must not crash the send path). */
export function writeFloodState(path: string, state: FloodWaitState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
  } catch {
    /* best-effort */
  }
}

/**
 * Build the `onFloodWait` callback for `createRetryApiCall`, wired to persist
 * (and extend) the window at `path`. Reads current state, merges the new
 * retry_after, writes it back.
 */
export function makeFloodWaitRecorder(
  path: string,
  now: () => number = Date.now,
): (retryAfterSec: number) => void {
  return (retryAfterSec: number) => {
    const t = now()
    const next = computeFloodWait(readFloodState(path), retryAfterSec, t)
    writeFloodState(path, next)
  }
}

/**
 * Build the `floodWaitRemainingMs` probe for `createRetryApiCall` (#3084).
 *
 * Returns the remaining ms of the persisted flood window, so the retry policy
 * can refuse to issue a call INTO a known-open long ban rather than letting
 * every 5-6s card heartbeat fire another request at the flood counter. Reads
 * fresh each call (the window is written by `makeFloodWaitRecorder`, possibly
 * from another code path in the same process).
 *
 * Fails OPEN: `readFloodState` already returns null on a missing or corrupt
 * marker, which yields 0 = "no window, proceed". A broken state file must
 * never permanently silence the bot.
 */
export function makeFloodWaitProbe(
  path: string,
  now: () => number = Date.now,
): () => number {
  return () => floodWaitRemainingMs(readFloodState(path), now())
}

/**
 * Decide whether a NON-ESSENTIAL restart-time send (boot card, config
 * summary) should be suppressed because a flood-wait is active. Returns the
 * remaining ms when suppressed (>0), or 0 to proceed. Reads state fresh so a
 * concurrently-updated window is honoured.
 */
export function suppressNonEssentialSendMs(path: string, now: number): number {
  return floodWaitRemainingMs(readFloodState(path), now)
}
