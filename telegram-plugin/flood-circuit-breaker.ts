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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
  renameSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { recordFlood429, flood429LedgerPathFromFloodState } from './flood-429-ledger.js'

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
 *
 * It ALSO appends to the sibling 429 pressure ledger. `flood-wait.json` holds
 * only the CURRENT window — every 429 overwrites the last — so the run-up to
 * a ban is destroyed at exactly the moment it becomes evidence. That is why
 * the 2026-07-27 4.4h ban had days of escalating penalties behind it that
 * nothing could see. The ledger keeps that history and `switchroom doctor`
 * classifies it (`src/cli/doctor-flood-pressure.ts`).
 *
 * Recording here rather than at the gateway callsites is deliberate: this is
 * the one function EVERY `onFloodWait` wiring goes through, so no future
 * callsite can record a window without also recording its history. The live
 * wirings are `gateway/gateway.ts:5715` (`robustApiCall`) and `:5849`
 * (`nonEssentialApiCall`), plus `gateway/outbox-sweep.ts:582` — and
 * `scripts/check-retry-flood-hooks.mjs` fails the build if a new
 * `createRetryApiCall` site omits either breaker hook.
 *
 * (Until #3863 this docblock also cited `shared/bot-runtime.ts`'s
 * `createRobustApiCall` as a live wiring. It had zero production callers and
 * its breaker hooks were OPTIONAL, so it was deleted rather than counted.
 * Cite only wirings the lint gate can see.)
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
    try {
      recordFlood429(flood429LedgerPathFromFloodState(path), { ts: t, retryAfterSec }, log)
    } catch {
      /* best-effort — the pressure ledger must never break the breaker */
    }
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

// ─── Restart-proof SCOPED flood windows (#3084 PR 2, part3-design §7) ────────
//
// The single-object `flood-wait.json` above records ONE global per-bot window
// (all #3094's `makeFloodWaitProbe` needs). PR 2's send gate opens windows at
// finer scopes (`global` | `chat:<id>` | `group:<id>` | `msg-edit:<id>`) and
// must survive a restart so a container that boots mid-ban does not immediately
// resend into the open flood — exactly the retry-storm that escalates bans.
//
// Rather than overload the single-object schema (which would break #3094's
// probe), scoped windows live in a SIBLING file `flood-windows.json` — an array
// of `{ scopeKey, untilTs, retryAfterSrc, observedAt }`. `flood-wait.json` is
// left untouched, so the existing probe keeps working unchanged.

/** One persisted scoped flood window (part3-design §7). */
export interface FloodWindowRecord {
  /** `global` | `chat:<id>` | `group:<id>` | `msg-edit:<id>`. */
  scopeKey: string
  /** Epoch ms until which the scope admits nothing. */
  untilTs: number
  /** Provenance of the window (`429` retry_after, `boot`, …) for diagnostics. */
  retryAfterSrc: string
  /** Epoch ms the window was (re)recorded. */
  observedAt: number
  /**
   * Epoch ms an operator alert was sent for THIS window (#3084 PR 3, §6). The
   * at-most-once anchor: persisted so a restart mid-window never re-alerts.
   * Unset until the observer alerts.
   */
  alertedAt?: number
}

/** Sibling file holding the scoped-window array. */
export const FLOOD_WINDOWS_FILE = 'flood-windows.json'

/** Resolve the scoped-windows file path from a telegram state dir. */
export function floodWindowsPath(stateDir: string): string {
  return join(stateDir, FLOOD_WINDOWS_FILE)
}

/**
 * How long a fail-SAFE conservative global window suppresses for when the
 * scoped-windows file exists but cannot be trusted (unreadable/corrupt/junk).
 *
 * The scoped-windows file gates whether a booting gateway resends into an open
 * ban. If we cannot tell what windows are open, the ONLY safe move is to assume
 * a ban may be open and hold non-essential/coalesced traffic for a bounded
 * conservative window — the exact opposite of `flood-wait.json`'s essential-send
 * probe, which must fail OPEN so a marker problem never gags the user's reply.
 * The asymmetry is deliberate: this file drives boot-time shedding, not the
 * user's reply, so failing safe here is the right call, while failing open
 * resends straight into a ban (H2/M1, #3106 posture).
 *
 * Note the blast radius is NOT only cosmetic: this conservative window is
 * `FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS` (5 min), which exceeds the send gate's
 * `criticalFailFastMs` (60s) ceiling — so while it is open a CRITICAL reply also
 * fail-fasts with a structured `FLOOD_WAIT_ACTIVE` (a retryable error carrying
 * `untilTs`, NOT a silent drop and NOT a hang) for up to 5 min after each boot.
 * That only fires with the send gate flag ON and a genuinely corrupt/unreadable
 * persisted file; the fail-fast is a real signal to the caller, so the posture
 * is defensible — but it is fail-fast criticals, not merely suppressed cosmetics.
 */
export const FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS = 5 * 60_000

/**
 * Read persisted scoped windows, pruning any whose `untilTs` is already in the
 * past.
 *
 * Fail-SAFE, not fail-open (M1/H2): a genuinely ABSENT file (ENOENT) is the
 * only "no windows" answer. If the file exists but is unreadable (EACCES/EIO),
 * corrupt, or not a JSON array, we CANNOT tell whether a ban is open — so we
 * synthesize a conservative `global` window (`FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS`)
 * and log loudly, rather than booting into an open flood with no windows.
 */
export function readFloodWindows(
  path: string,
  now: number,
  log: (line: string) => void = (l) => process.stderr.write(l),
): FloodWindowRecord[] {
  // ENOENT is the ONLY honest "no windows". Anything else = we can't tell.
  if (!existsSync(path)) return []
  const failSafe = (why: string): FloodWindowRecord[] => {
    log(
      `telegram gateway: flood-breaker: scoped-windows file ${path} is ${why} — ` +
        `failing SAFE: opening a conservative ${FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS}ms global ` +
        `window rather than booting into a possible open ban with no windows (issue #3106)\n`,
    )
    return [
      {
        scopeKey: 'global',
        untilTs: now + FLOOD_WINDOWS_CORRUPT_SUPPRESS_MS,
        retryAfterSrc: `failsafe:${why}`,
        observedAt: now,
      },
    ]
  }
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return [] // vanished between stat and read
    return failSafe(`unreadable (${code ?? 'error'})`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return failSafe('corrupt (invalid JSON)')
  }
  if (!Array.isArray(raw)) return failSafe('corrupt (not an array)')
  const out: FloodWindowRecord[] = []
  for (const r of raw) {
    const rec = r as Partial<FloodWindowRecord>
    if (typeof rec.scopeKey !== 'string' || typeof rec.untilTs !== 'number') continue
    if (rec.untilTs <= now) continue // prune expired
    out.push({
      scopeKey: rec.scopeKey,
      untilTs: rec.untilTs,
      retryAfterSrc: typeof rec.retryAfterSrc === 'string' ? rec.retryAfterSrc : 'unknown',
      observedAt: typeof rec.observedAt === 'number' ? rec.observedAt : now,
      // Preserve the at-most-once alert anchor (#3084 PR 3) across reads so a
      // restart mid-window does not re-alert.
      ...(typeof rec.alertedAt === 'number' ? { alertedAt: rec.alertedAt } : {}),
    })
  }
  return out
}

/**
 * Write-through a single scoped window (best-effort, atomic rename). Merges
 * with the on-disk set: EXTENDS an existing scope's window (never shortens — a
 * restart must not shrink a ban), prunes expired scopes, and drops the scope
 * entirely if the new window is already in the past. Atomic via temp-file +
 * rename so a concurrent reader never sees a half-written file.
 */
export function writeFloodWindow(
  path: string,
  record: FloodWindowRecord,
  now: number,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const existing = readFloodWindows(path, now)
    const byScope = new Map<string, FloodWindowRecord>()
    for (const r of existing) byScope.set(r.scopeKey, r)
    if (record.untilTs > now) {
      const prior = byScope.get(record.scopeKey)
      // Monotonic: keep the LATER expiry (never shorten an open window).
      const untilTs = prior && prior.untilTs > record.untilTs ? prior.untilTs : record.untilTs
      // Preserve a prior `alertedAt` when a window is EXTENDED (#3084 PR 3): a
      // fresh 429 recorder call carries no alertedAt, and dropping it would
      // re-arm the at-most-once alert for a window we already alerted on.
      const alertedAt = record.alertedAt ?? prior?.alertedAt
      byScope.set(record.scopeKey, {
        ...record,
        untilTs,
        ...(alertedAt != null ? { alertedAt } : {}),
      })
    }
    const arr = [...byScope.values()]
    const tmp = `${path}.tmp-${process.pid}`
    // 0o644, NOT 0o600 (H2, #3106): the telegram state dir is shared by
    // processes running under DIFFERENT uids; a 0600 marker created by whoever
    // wrote first is unreadable to every other uid, which silently defeats the
    // restart-proof windows — a restart under a different uid boots blind and
    // resends into the ban. Match `flood-wait.json` (FLOOD_STATE_MODE).
    writeFileSync(tmp, JSON.stringify(arr), { mode: FLOOD_STATE_MODE })
    renameSync(tmp, path)
    // `mode:` only applies at CREATE; chmod so a marker left 0600 by an earlier
    // build (or a root gateway) becomes readable to the agent uid. Best-effort:
    // if we don't own it, the read path fails SAFE rather than silently open.
    try {
      chmodSync(path, FLOOD_STATE_MODE)
    } catch {
      /* not the owner — read path fails safe */
    }
  } catch {
    /* best-effort — a persistence failure must not crash the send path */
  }
}

/**
 * Persist an `alertedAt` marker on the window for `scopeKey` (#3084 PR 3, §6).
 *
 * The at-most-once anchor for the operator flood alert: once written, a restart
 * that re-reads the still-open window sees `alertedAt` set and does not re-alert.
 * Best-effort and a no-op if the scope is no longer open (already pruned) — the
 * window has closed, so at-most-once still holds. Reuses `writeFloodWindow`'s
 * merge (it keeps the LATER `untilTs` and now carries `alertedAt` through).
 */
export function markFloodWindowAlerted(
  path: string,
  scopeKey: string,
  alertedAt: number,
  now: number,
): void {
  const open = readFloodWindows(path, now).find((w) => w.scopeKey === scopeKey)
  if (!open) return
  writeFloodWindow(path, { ...open, alertedAt }, now)
}

/**
 * Build the `onWindowOpen` callback the send gate calls whenever it opens /
 * extends a scope window (on a 429, or at boot). Persists write-through so the
 * window survives a restart (part3-design §7).
 */
export function makeFloodWindowRecorder(
  path: string,
  now: () => number = Date.now,
): (scopeKey: string, untilTs: number, retryAfterSrc?: string) => void {
  return (scopeKey: string, untilTs: number, retryAfterSrc = '429') => {
    const t = now()
    writeFloodWindow(path, { scopeKey, untilTs, retryAfterSrc, observedAt: t }, t)
  }
}

/**
 * Assemble the `initialWindows` the send gate is constructed with at boot
 * (part3-design §7). Combines the global window from the single-object
 * `flood-wait.json` (#3094 / #2923) with every future-dated scoped window from
 * the sibling `flood-windows.json`, pruning expired ones. The gate applies
 * these BEFORE any outbound call so a boot mid-ban does not resend into it.
 */
export function loadInitialFloodWindows(
  floodStateFilePath: string,
  floodWindowsFilePath: string,
  now: number,
): { scopeKey: string; untilTs: number }[] {
  const out: { scopeKey: string; untilTs: number }[] = []
  const global = readFloodState(floodStateFilePath)
  if (global && global.untilTs > now) out.push({ scopeKey: 'global', untilTs: global.untilTs })
  for (const w of readFloodWindows(floodWindowsFilePath, now)) {
    out.push({ scopeKey: w.scopeKey, untilTs: w.untilTs })
  }
  return out
}
