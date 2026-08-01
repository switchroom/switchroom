/**
 * Telegram 429 pressure ledger — the "was anything watching?" half of the
 * 2026-07-27 flood-ban incident.
 *
 * ## Why this exists
 *
 * On 2026-07-27T20:19:57Z an agent's bot token took a `retry_after=15908`
 * (4.4 hour) flood ban. The *rate* cause was fixed separately (#3847,
 * edit-flood-fuse ceilings + outbound class propagation). This module closes
 * the second, independent gap: **nothing observed the run-up**. Telegram
 * escalates its penalty as a bot keeps tripping the limit, so the size of
 * `parameters.retry_after` over the preceding days is a genuine leading
 * indicator of a multi-hour outage — and it was sitting unexamined in a log
 * file the whole time.
 *
 * `flood-circuit-breaker.ts` already sees every single 429: `retryApiCall`
 * calls `onFloodWait(retry_after, opts)` (telegram-plugin/retry-api-call.ts,
 * in the `error_code === 429` branch) BEFORE either of its two log lines, and
 * every wiring of that hook goes through `makeFloodWaitRecorder`. But the
 * breaker keeps only the CURRENT window in `flood-wait.json` — each 429
 * overwrites the last, so history is destroyed at exactly the moment it
 * becomes evidence. This ledger is the sibling file that keeps it.
 *
 * ## What is recorded — episodes, not observations
 *
 * A single ban is re-observed on every subsequent send: the 2026-07-27 ban
 * produced ~100 log lines in 8 minutes, each with a `retry_after` 5s smaller
 * than the last (the same window, counting down). Storing raw observations
 * would let one ban evict weeks of history from any bounded file, and would
 * make any count-based signal explode during the outage it is supposed to
 * predict.
 *
 * So the write path folds observations into EPISODES, keyed on the implied
 * ban expiry (`ts + retry_after`). Two observations belong to the same
 * episode when they imply the same expiry (within `EPISODE_MERGE_MS`) or when
 * the later one lands inside the earlier one's still-open window. Validated
 * against the real incident: `20:19:56.704 + 15908s` and
 * `21:00:36.999 + 13468s` both resolve to `2026-07-28T00:45:04Z` — one
 * episode, 101 observations.
 *
 * ## What is NOT here
 *
 * Interpretation is deliberately split from recording, but both live in this
 * file so the plugin (writer) and `switchroom doctor` (reader) can never
 * disagree about what a ledger means. `src/cli/doctor-flood-pressure.ts`
 * imports the pure classifier below; it does not reimplement it.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One observed 429, as handed to the `onFloodWait` hook. */
export interface Flood429Observation {
  /** Epoch ms the 429 was seen. */
  ts: number
  /** Telegram's `parameters.retry_after`, in seconds. */
  retryAfterSec: number
}

/**
 * A collapsed run of observations that all describe the SAME Telegram ban
 * window. `peakRetryAfterSec` is the headline number (the ban as Telegram
 * first stated it); `count` preserves how hard we kept knocking.
 */
export interface Flood429Episode {
  /** Epoch ms of the first observation folded into this episode. */
  firstTs: number
  /** Epoch ms of the most recent observation folded into this episode. */
  lastTs: number
  /** Largest `retry_after` (seconds) seen for this window. */
  peakRetryAfterSec: number
  /** Latest implied ban expiry (epoch ms) — the episode's merge key. */
  untilTs: number
  /** How many 429s were folded in. */
  count: number
}

/** Ledger filename inside the agent's telegram state dir. */
export const FLOOD_429_LEDGER_FILE = '429-ledger.json'

/**
 * 0644 — deliberately world-READABLE, for the same reason
 * `FLOOD_STATE_MODE` is (see flood-circuit-breaker.ts): the telegram state
 * dir is shared by processes running under different uids (a `root:` agent's
 * gateway is uid 0, a normal agent's is its allocated uid), and `switchroom
 * doctor` reads this file from the host as yet another uid. The payload is
 * integers; there is nothing here worth 0600.
 */
export const FLOOD_429_LEDGER_MODE = 0o644

/**
 * Two observations belong to the same episode when their implied expiries are
 * within this much of each other. 60s absorbs both the countdown drift of a
 * long ban re-observed every ~5s and the sub-second jitter of a short one
 * retried twice.
 */
export const EPISODE_MERGE_MS = 60_000

/** Hard cap on stored episodes — oldest-first eviction. */
export const FLOOD_429_LEDGER_MAX_EPISODES = 400

/** Episodes older than this are dropped on write. */
export const FLOOD_429_LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * At or below this `retry_after`, Telegram is nudging a per-second send rate,
 * not imposing a penalty: `retryApiCall` sleeps it and the send succeeds, and
 * no human ever notices.
 *
 * Calibrated against 16 days of real gateway logs (2026-07-12 → 2026-07-27,
 * 170 observations): the modal value is exactly `3`, the largest benign one is
 * `5`, and the smallest value belonging to an actual outage is `282`. There is
 * no observed traffic between 5 and 282, so 60 sits in a wide empty band —
 * this threshold is not fitted to a boundary case.
 */
export const TRIVIAL_RETRY_AFTER_SEC = 60

/**
 * At or above this `retry_after`, the bot is silent for long enough that the
 * operator experiences it as an outage rather than a hiccup. 600s = 10 minutes.
 */
export const SEVERE_RETRY_AFTER_SEC = 600

/**
 * How far back penalty episodes are considered. Telegram's escalation memory
 * is multi-day: the 2026-07-25T23:43Z ban (3713s) and the 2026-07-27T20:19Z
 * ban (15908s, a 4.3x escalation) are 44 hours apart. A 24h window would have
 * treated the second as a first offence.
 */
export const PENALTY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Window for the low-grade "constantly at the rate limit" pressure signal. */
export const TRIVIAL_PRESSURE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Trivial 429s in 24h that earn a WARN on their own.
 *
 * The busiest benign day in the 16-day sample (2026-07-19) logged 12 trivial
 * 429s, so 20 clears the observed background with headroom and never fires on
 * a healthy agent. This is the only count-based rule in the classifier, and it
 * is deliberately the WEAKEST tier — see `classifyFlood429Pressure`.
 */
export const TRIVIAL_PRESSURE_WARN_COUNT = 20

/** Resolve the ledger path from a telegram state dir. */
export function flood429LedgerPath(stateDir: string): string {
  return join(stateDir, FLOOD_429_LEDGER_FILE)
}

/**
 * Resolve the ledger path from the flood-wait marker path, so the recorder
 * can derive one from the other without a second env lookup.
 */
export function flood429LedgerPathFromFloodState(floodStatePath: string): string {
  return join(dirname(floodStatePath), FLOOD_429_LEDGER_FILE)
}

/** True when `obs` describes the same ban window as `ep`. */
function belongsToEpisode(ep: Flood429Episode, obs: Flood429Observation): boolean {
  const impliedUntil = obs.ts + Math.max(0, obs.retryAfterSec) * 1000
  if (Math.abs(impliedUntil - ep.untilTs) <= EPISODE_MERGE_MS) return true
  // Observed while the episode's window was still open — by definition the
  // same ban (a fresh, unrelated ban cannot start inside an open one).
  return obs.ts >= ep.firstTs && obs.ts <= ep.untilTs
}

/**
 * Pure: fold one observation into an episode list, then prune.
 *
 * Only the LAST episode is considered for merging — observations arrive in
 * time order, so an out-of-order merge would mean a clock jump, and inventing
 * a repair for that would hide it. Returns a new array; never mutates input.
 */
export function foldFlood429Observation(
  episodes: readonly Flood429Episode[],
  obs: Flood429Observation,
  now: number = obs.ts,
): Flood429Episode[] {
  const retryAfterSec = Math.max(0, Math.floor(obs.retryAfterSec))
  const impliedUntil = obs.ts + retryAfterSec * 1000
  const next = episodes.slice()
  const last = next[next.length - 1]

  if (last && belongsToEpisode(last, obs)) {
    next[next.length - 1] = {
      firstTs: Math.min(last.firstTs, obs.ts),
      lastTs: Math.max(last.lastTs, obs.ts),
      peakRetryAfterSec: Math.max(last.peakRetryAfterSec, retryAfterSec),
      untilTs: Math.max(last.untilTs, impliedUntil),
      count: last.count + 1,
    }
  } else {
    next.push({
      firstTs: obs.ts,
      lastTs: obs.ts,
      peakRetryAfterSec: retryAfterSec,
      untilTs: impliedUntil,
      count: 1,
    })
  }

  return pruneFlood429Episodes(next, now)
}

/** Pure: drop episodes past the retention window, then cap the count. */
export function pruneFlood429Episodes(
  episodes: readonly Flood429Episode[],
  now: number,
): Flood429Episode[] {
  const floor = now - FLOOD_429_LEDGER_RETENTION_MS
  const kept = episodes.filter((e) => e.lastTs >= floor)
  return kept.length > FLOOD_429_LEDGER_MAX_EPISODES
    ? kept.slice(kept.length - FLOOD_429_LEDGER_MAX_EPISODES)
    : kept
}

/** Coerce one parsed JSON entry into an episode, or null if it is junk. */
function parseEpisode(raw: unknown): Flood429Episode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  const firstTs = num(r.firstTs)
  const untilTs = num(r.untilTs)
  const peak = num(r.peakRetryAfterSec)
  if (firstTs === null || untilTs === null || peak === null) return null
  return {
    firstTs,
    lastTs: num(r.lastTs) ?? firstTs,
    peakRetryAfterSec: peak,
    untilTs,
    count: num(r.count) ?? 1,
  }
}

/**
 * Why a read produced no episodes. `absent` is the only status that honestly
 * means "this agent has never been 429'd"; the others mean the ledger exists
 * and we could not use it, which is a different thing an operator must be
 * told about. Conflating the two is the bug #3106 exists to fix, and the same
 * trap applies here: a silently-unreadable ledger looks exactly like a
 * perfectly healthy agent.
 */
export type Flood429ReadStatus = 'ok' | 'absent' | 'corrupt' | 'unreadable'

export interface Flood429ReadResult {
  status: Flood429ReadStatus
  episodes: Flood429Episode[]
  /** Populated for `corrupt` / `unreadable`. */
  error?: string
}

/**
 * Read the ledger, reporting WHY there are no episodes.
 *
 * No `existsSync` pre-check — it is a `stat`, not an `access`, so it cannot
 * separate "missing" from "unreadable", and pre-checking would race. We read
 * and classify the error instead.
 */
export function readFlood429LedgerResult(
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf-8'),
): Flood429ReadResult {
  let text: string
  try {
    text = readFile(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent', episodes: [] }
    return {
      status: 'unreadable',
      episodes: [],
      error: `${code ?? 'EUNKNOWN'}: ${(err as Error)?.message ?? String(err)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { status: 'corrupt', episodes: [], error: (err as Error)?.message ?? String(err) }
  }
  if (!Array.isArray(parsed)) {
    return { status: 'corrupt', episodes: [], error: 'ledger is not a JSON array' }
  }
  const out: Flood429Episode[] = []
  let dropped = 0
  for (const raw of parsed) {
    const ep = parseEpisode(raw)
    if (ep) out.push(ep)
    else dropped += 1
  }
  if (dropped > 0 && out.length === 0) {
    return { status: 'corrupt', episodes: [], error: `${dropped} unparseable entr(ies)` }
  }
  return { status: 'ok', episodes: out }
}

/**
 * Read the ledger, yielding whatever episodes are parseable.
 *
 * The write path uses this: a diagnostic record that cannot be read must
 * never break the send path, and starting a fresh ledger is strictly better
 * than throwing out of `onFloodWait`. Anything making an operator-facing
 * JUDGEMENT should use `readFlood429LedgerResult` so "no ban" and "cannot
 * tell" stay distinguishable.
 */
export function readFlood429Ledger(
  path: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf-8'),
): Flood429Episode[] {
  return readFlood429LedgerResult(path, readFile).episodes
}

/**
 * Persist the ledger, self-healing a file left unowned by another uid.
 *
 * Mirrors `writeFloodState`'s two heals for the same reason (issue #3106):
 * `mode` only applies at create time, and the state dir is shared across
 * uids. Best-effort throughout — a failed diagnostic write must never
 * propagate into the send path.
 */
export function writeFlood429Ledger(
  path: string,
  episodes: readonly Flood429Episode[],
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const payload = JSON.stringify(episodes)
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    /* best-effort */
  }
  try {
    writeFileSync(path, payload, { mode: FLOOD_429_LEDGER_MODE })
    try {
      chmodSync(path, FLOOD_429_LEDGER_MODE)
    } catch {
      /* not the owner — the read path degrades to [] */
    }
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'EACCES' && code !== 'EPERM') {
      log(`telegram gateway: 429-ledger: could not persist ${path} (${code ?? 'error'})\n`)
      return
    }
    try {
      unlinkSync(path)
      writeFileSync(path, payload, { mode: FLOOD_429_LEDGER_MODE })
    } catch (err2) {
      log(
        `telegram gateway: 429-ledger: cannot persist the 429 pressure ledger to ${path} ` +
          `(${code}, recreate failed: ${(err2 as Error)?.message ?? String(err2)}). ` +
          `Flood-pressure history will be missing from \`switchroom doctor\`\n`,
      )
    }
  }
}

/**
 * Record one observed 429 into the ledger at `path`. Read-fold-write; safe to
 * call at the ~5s cadence a long ban produces, because the fold collapses
 * those into a single episode instead of growing the file.
 *
 * Read-fold-write is not atomic across processes. Today every writer lives in
 * the gateway process (its two `createRetryApiCall` wirings plus the outbox
 * sweep's, all on one event loop), but the ledger is keyed by state DIR, so a
 * second process wiring the breaker could drop one episode on a simultaneous
 * 429. That is deliberate — the alternative is a lock
 * on the send path's error handler, and the cost of losing an episode is
 * nil: a penalty stays on the ledger for seven days and is re-recorded by the
 * next 429, so no verdict tier turns on a single write landing.
 */
export function recordFlood429(
  path: string,
  obs: Flood429Observation,
  log: (line: string) => void = (l) => process.stderr.write(l),
): void {
  const folded = foldFlood429Observation(readFlood429Ledger(path), obs, obs.ts)
  writeFlood429Ledger(path, folded, log)
}

// ─── Interpretation ─────────────────────────────────────────────────────────

/** Verdict tiers, matching `switchroom doctor`'s `CheckStatus`. */
export type Flood429Status = 'warn' | 'fail'

export interface Flood429Verdict {
  status: Flood429Status
  /** Stable machine-readable reason, so tests assert intent not prose. */
  reason:
    | 'ban_open'
    | 'repeat_penalty'
    | 'severe_penalty'
    | 'single_penalty'
    | 'trivial_pressure'
  detail: string
  /** Penalty episodes inside the window, oldest first. */
  penalties: Flood429Episode[]
  /** Trivial 429 observations inside the 24h pressure window. */
  trivialCount24h: number
}

/** True when this episode is a real Telegram penalty, not a rate nudge. */
export function isPenaltyEpisode(ep: Flood429Episode): boolean {
  return ep.peakRetryAfterSec > TRIVIAL_RETRY_AFTER_SEC
}

function fmtDuration(sec: number): string {
  if (sec < 90) return `${sec}s`
  if (sec < 5400) return `${Math.round(sec / 60)}min`
  return `${(sec / 3600).toFixed(1)}h`
}

/**
 * Pure: turn a ledger into an operator verdict, or `null` when nothing is
 * worth saying.
 *
 * The tiers, strongest first — every one of them is about the SIZE of the
 * penalty, not the number of 429s, because raw count is actively misleading:
 * in the real 16-day sample the highest-count day (2026-07-19, 12 events) was
 * entirely benign, while the day that preceded the 4.4h outage
 * (2026-07-25, 4 events) contained a 62-minute ban.
 *
 *   1. `ban_open`        — FAIL. A window recorded here has not expired: the
 *                          bot is silenced RIGHT NOW.
 *   2. `repeat_penalty`  — FAIL. Two or more penalty episodes in 7 days.
 *                          Telegram escalates on repeat, so a second penalty
 *                          predicts a bigger third. (2026-07-12 21397s →
 *                          2026-07-13 27951s; 2026-07-25 3713s →
 *                          2026-07-27 15908s.)
 *   3. `severe_penalty`  — FAIL. One penalty ≥ 10 minutes. Already an outage,
 *                          and the first rung of the escalation ladder.
 *   4. `single_penalty`  — WARN. One sub-10-minute penalty in 7 days. Not yet
 *                          an outage; the bot has left the benign band.
 *   5. `trivial_pressure`— WARN. ≥20 rate nudges in 24h with no penalty at
 *                          all. The weakest signal, and the only count-based
 *                          one: sustained pressure without a penalty yet.
 */
export function classifyFlood429Pressure(
  episodes: readonly Flood429Episode[],
  now: number,
): Flood429Verdict | null {
  const inPenaltyWindow = episodes.filter((e) => e.lastTs >= now - PENALTY_WINDOW_MS)
  const penalties = inPenaltyWindow.filter(isPenaltyEpisode)
  const trivialCount24h = inPenaltyWindow
    .filter((e) => !isPenaltyEpisode(e) && e.lastTs >= now - TRIVIAL_PRESSURE_WINDOW_MS)
    .reduce((n, e) => n + e.count, 0)

  const base = { penalties, trivialCount24h }

  const open = episodes.filter((e) => e.untilTs > now)
  if (open.length > 0) {
    const worst = open.reduce((a, b) => (b.untilTs > a.untilTs ? b : a))
    const remaining = Math.round((worst.untilTs - now) / 1000)
    return {
      ...base,
      status: 'fail',
      reason: 'ban_open',
      detail:
        `a Telegram flood ban is OPEN — ${fmtDuration(remaining)} remaining ` +
        `(retry_after peaked at ${worst.peakRetryAfterSec}s, first seen ` +
        `${new Date(worst.firstTs).toISOString()}). Outbound sends are being ` +
        `rejected by Telegram; nothing client-side clears it early.`,
    }
  }

  if (penalties.length >= 2) {
    const latest = penalties[penalties.length - 1]
    const prior = penalties[penalties.length - 2]
    const escalating = latest.peakRetryAfterSec > prior.peakRetryAfterSec
    return {
      ...base,
      status: 'fail',
      reason: 'repeat_penalty',
      detail:
        `${penalties.length} Telegram flood bans in the last 7 days ` +
        `(peak retry_after: ${penalties.map((p) => `${p.peakRetryAfterSec}s`).join(' → ')})` +
        (escalating
          ? ` — and the penalty is GROWING (${prior.peakRetryAfterSec}s → ` +
            `${latest.peakRetryAfterSec}s). Telegram escalates on repeat offences, ` +
            `so the next ban will be longer still.`
          : `. Telegram escalates on repeat offences, so the next ban is likely longer.`),
    }
  }

  if (penalties.length === 1 && penalties[0].peakRetryAfterSec >= SEVERE_RETRY_AFTER_SEC) {
    const p = penalties[0]
    return {
      ...base,
      status: 'fail',
      reason: 'severe_penalty',
      detail:
        `a ${fmtDuration(p.peakRetryAfterSec)} Telegram flood ban on ` +
        `${new Date(p.firstTs).toISOString()} (retry_after=${p.peakRetryAfterSec}s, ` +
        `${p.count} rejected send(s)). The bot was silent for that whole window, and ` +
        `Telegram escalates the next penalty from here.`,
    }
  }

  if (penalties.length === 1) {
    const p = penalties[0]
    return {
      ...base,
      status: 'warn',
      reason: 'single_penalty',
      detail:
        `a ${fmtDuration(p.peakRetryAfterSec)} Telegram flood ban on ` +
        `${new Date(p.firstTs).toISOString()} (retry_after=${p.peakRetryAfterSec}s). ` +
        `Short, but above the benign rate-nudge band — the outbound rate is ` +
        `earning penalties, and the next one escalates.`,
    }
  }

  if (trivialCount24h >= TRIVIAL_PRESSURE_WARN_COUNT) {
    return {
      ...base,
      status: 'warn',
      reason: 'trivial_pressure',
      detail:
        `${trivialCount24h} rate-limit 429s in the last 24h (all short, all ` +
        `absorbed by the in-process retry). No penalty ban yet, but the outbound ` +
        `rate is sitting on Telegram's limit — that is where escalating bans start.`,
    }
  }

  return null
}
