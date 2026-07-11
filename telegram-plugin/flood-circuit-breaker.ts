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

import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs'
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
 * Marker file mode — 0644, deliberately world-READABLE (#3106).
 *
 * The marker was 0600 and that silently defeated the entire breaker. The
 * telegram state dir is shared by processes running under DIFFERENT uids: a
 * `root: true` agent's gateway runs as uid 0 (`src/agents/compose.ts:1967`),
 * a normal agent's as its deterministic uid (`compose.ts:1969`), and the same
 * bind-mounted dir survives a container being flipped between the two. Whoever
 * CREATES the marker owns it; at 0600 nobody else can ever read it again. On
 * the live box `overlord`'s marker is `root:root 0600` while its siblings are
 * agent-uid — the moment that agent runs non-root, every flood probe EACCESes.
 *
 * The payload is three integers (`untilTs`, `retryAfterSec`, `recordedTs`) —
 * no secret, nothing worth 0600. `fleet-health/ledger.json` is the working
 * precedent for a state file multiple uids must read: 0644.
 */
export const FLOOD_STATE_MODE = 0o644

/**
 * Outcome of a marker read. The whole point of this type is that "no ban" and
 * "I cannot tell" stop being the same value (#3106).
 *
 *   - `ok`         → a window was read (may be expired; `floodWaitRemainingMs` decides)
 *   - `absent`     → ENOENT, no marker has ever been written. Genuinely "no ban".
 *   - `corrupt`    → readable but the JSON/shape is junk. Content problem.
 *   - `unreadable` → the file exists and we could NOT read it (EACCES/EPERM/EIO).
 *                    The breaker is BLIND. This is NOT "no ban".
 */
export type FloodReadStatus = 'ok' | 'absent' | 'corrupt' | 'unreadable'

export interface FloodReadResult {
  status: FloodReadStatus
  state: FloodWaitState | null
  /** Populated for `unreadable` / `corrupt` — the underlying error message. */
  error?: string
}

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

/**
 * Read the persisted marker, reporting WHY there is no state (#3106).
 *
 * No `existsSync` pre-check: it is a `stat`, not an `access`, so it cannot
 * tell "missing" from "unreadable" — and pre-checking would race. We read and
 * classify the error instead. ENOENT (and a missing parent dir, ENOTDIR) is
 * the only honest "no marker". Everything else that isn't a parse/shape
 * failure means the breaker could not see its own state.
 */
export function readFloodStateResult(path: string): FloodReadResult {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent', state: null }
    return {
      status: 'unreadable',
      state: null,
      error: `${code ?? 'EUNKNOWN'}: ${(err as Error)?.message ?? String(err)}`,
    }
  }
  try {
    const raw = JSON.parse(text) as Partial<FloodWaitState>
    if (typeof raw.untilTs !== 'number' || !Number.isFinite(raw.untilTs)) {
      return { status: 'corrupt', state: null, error: 'untilTs is not a finite number' }
    }
    return {
      status: 'ok',
      state: {
        untilTs: raw.untilTs,
        retryAfterSec: typeof raw.retryAfterSec === 'number' ? raw.retryAfterSec : 0,
        recordedTs: typeof raw.recordedTs === 'number' ? raw.recordedTs : 0,
      },
    }
  } catch (err) {
    return { status: 'corrupt', state: null, error: (err as Error)?.message ?? String(err) }
  }
}

/**
 * Read persisted flood state; null on absence / parse failure / unreadable.
 *
 * Kept for callers that only want the window. It CANNOT distinguish "no ban"
 * from "cannot tell" — that is the bug #3106 exists to fix — so anything
 * making a suppress/proceed DECISION must use `readFloodStateResult`.
 */
export function readFloodState(path: string): FloodWaitState | null {
  return readFloodStateResult(path).state
}

/**
 * Persist flood state (best-effort — a write failure must not crash the send
 * path), and SELF-HEAL a marker left unreadable by another uid (#3106).
 *
 * Two heals, both needed because the `mode` option only applies at CREATE time:
 *   1. `chmodSync` to 0644 after every write, so a marker created 0600 by an
 *      earlier build (or by a root gateway) becomes readable to the agent uid.
 *   2. On EACCES/EPERM (we can't overwrite a file some other uid owns), unlink
 *      and recreate. The state DIR is owned by the agent uid, so a non-root
 *      gateway can unlink a root-owned marker inside it even though it cannot
 *      write through it. Without this the recorder is as blind as the reader.
 */
export function writeFloodState(
  path: string,
  state: FloodWaitState,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const payload = JSON.stringify(state)
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    /* best-effort */
  }
  try {
    writeFileSync(path, payload, { mode: FLOOD_STATE_MODE })
    try {
      chmodSync(path, FLOOD_STATE_MODE)
    } catch {
      /* not the owner — the read path will report it */
    }
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'EACCES' && code !== 'EPERM') {
      log(`telegram gateway: flood-breaker: could not persist ${path} (${code ?? 'error'})\n`)
      return
    }
    // Owned by a different uid. Unlink + recreate so the CURRENT uid owns it.
    try {
      unlinkSync(path)
      writeFileSync(path, payload, { mode: FLOOD_STATE_MODE })
      log(
        `telegram gateway: flood-breaker: recreated ${path} — it was owned by another uid ` +
          `and could not be updated (${code}); the breaker was blind (issue #3106)\n`,
      )
    } catch (err2) {
      log(
        `telegram gateway: flood-breaker: BLIND — cannot persist the flood-wait window to ${path} ` +
          `(${code}, and recreate failed: ${(err2 as Error)?.message ?? String(err2)}). ` +
          `Flood bans will NOT be recorded. Fix the file's ownership/mode (issue #3106)\n`,
      )
    }
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
  log: (line: string) => void = (l) => process.stderr.write(l),
): (retryAfterSec: number) => void {
  return (retryAfterSec: number) => {
    const t = now()
    const next = computeFloodWait(readFloodState(path), retryAfterSec, t)
    writeFloodState(path, next, log)
  }
}

/**
 * How long a blind (unreadable-marker) breaker suppresses non-essential sends
 * for. Nominal — the caller only checks `> 0`. Not a real ban estimate; we
 * have no idea how long the ban is, that is the whole problem.
 */
export const FLOOD_BLIND_SUPPRESS_MS = 60_000

/** Throttle for the BLIND warning: once per path per interval, so a per-call probe can't spam. */
const BLIND_LOG_INTERVAL_MS = 60_000
const blindLoggedAt = new Map<string, number>()

/** Test seam — clear the BLIND-warning throttle between cases. */
export function resetFloodBlindLogThrottle(): void {
  blindLoggedAt.clear()
}

function warnBlind(path: string, error: string | undefined, now: number, log: (l: string) => void) {
  const last = blindLoggedAt.get(path)
  if (last !== undefined && now - last < BLIND_LOG_INTERVAL_MS) return
  blindLoggedAt.set(path, now)
  log(
    `telegram gateway: flood-breaker: BLIND — cannot read the flood-wait marker ${path} ` +
      `(${error ?? 'unknown error'}). The breaker cannot tell whether a Telegram flood ban is ` +
      `open. Essential sends PROCEED (fail-open); non-essential sends (boot card, typing) are ` +
      `SUPPRESSED. Fix the file's ownership/mode (issue #3106)\n`,
  )
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
 * Fails OPEN on absent / corrupt / UNREADABLE — this probe gates EVERY api
 * call including the user's reply, and no marker problem may ever mute the
 * bot. But an unreadable marker is no longer SILENT: it is a blind breaker,
 * and it says so, loudly and repeatedly (throttled to once a minute), because
 * a breaker that cannot see its own state while reporting "all clear" is the
 * worst state this system can be in (#3106).
 */
export function makeFloodWaitProbe(
  path: string,
  now: () => number = Date.now,
  log: (line: string) => void = (l) => process.stderr.write(l),
): () => number {
  return () => {
    const t = now()
    const res = readFloodStateResult(path)
    if (res.status === 'unreadable') {
      warnBlind(path, res.error, t, log)
      return 0 // fail OPEN — never gag an essential send on a permissions error
    }
    return floodWaitRemainingMs(res.state, t)
  }
}

/**
 * Why a non-essential send is being held back.
 *
 *   - `flood_wait` → we can see an open ban window. Suppress (that is #2923).
 *   - `blind`      → we CANNOT read the marker. Suppress.
 */
export type NonEssentialSuppression =
  | { suppress: false }
  | { suppress: true; reason: 'flood_wait'; remainingMs: number }
  | { suppress: true; reason: 'blind'; error: string }

/**
 * Decide whether a NON-ESSENTIAL send (boot card, config summary, typing
 * indicator) should be held back.
 *
 * This is where "cannot tell" is allowed to fail CLOSED, and the asymmetry is
 * deliberate (#3106):
 *
 *   - Absent / corrupt → PROCEED. A missing or junk marker is a content
 *     problem, and #3094's posture stands: a broken state file must never
 *     become a silent gag.
 *   - Unreadable → SUPPRESS. A permissions error means the breaker is blind,
 *     and blind is not clear. Restarting into an open ban with a boot card is
 *     exactly the amplification #2923 exists to prevent, and the cost of being
 *     wrong here is bounded and tiny: the operator misses a courtesy card or a
 *     typing bubble. It CANNOT mute the agent — every essential send still
 *     goes through the fail-open probe above. That bound is what makes
 *     fail-closed safe HERE and unsafe on the probe.
 */
export function nonEssentialSendSuppression(path: string, now: number): NonEssentialSuppression {
  const res = readFloodStateResult(path)
  if (res.status === 'unreadable') {
    return { suppress: true, reason: 'blind', error: res.error ?? 'unknown error' }
  }
  const remainingMs = floodWaitRemainingMs(res.state, now)
  if (remainingMs > 0) return { suppress: true, reason: 'flood_wait', remainingMs }
  return { suppress: false }
}

/**
 * Ms-shaped shim over `nonEssentialSendSuppression` for callers that only ask
 * "> 0?". A blind breaker returns `FLOOD_BLIND_SUPPRESS_MS` (a nominal
 * non-zero), and warns. Callers that want to explain WHICH reason to the
 * operator should use `nonEssentialSendSuppression` directly.
 */
export function suppressNonEssentialSendMs(
  path: string,
  now: number,
  log: (line: string) => void = (l) => process.stderr.write(l),
): number {
  const s = nonEssentialSendSuppression(path, now)
  if (!s.suppress) return 0
  if (s.reason === 'blind') {
    warnBlind(path, s.error, now, log)
    return FLOOD_BLIND_SUPPRESS_MS
  }
  return s.remainingMs
}
