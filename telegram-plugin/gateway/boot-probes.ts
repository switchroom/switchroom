/**
 * Boot-card probes — live evidential data gathered at gateway startup.
 *
 * Each probe returns a ProbeResult within its timeout budget. All probes
 * are run concurrently via Promise.allSettled; callers supply a 2.5s wall
 * clock budget and let this module own the per-probe 2s guard.
 *
 * Probes are defensive by design: every file read guards ENOENT, every
 * network call is wrapped in a race timeout, every field access uses
 * optional-chaining. A failure in one probe must never surface to the
 * caller as a thrown error — only as ProbeResult{ status:'fail', ... }.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

import { readQuotaCache, writeQuotaCache } from './quota-cache.js'

const execFile = promisify(execFileCb)

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProbeStatus = 'ok' | 'degraded' | 'fail'

export interface ProbeResult {
  status: ProbeStatus
  label: string
  detail: string
  /** True when a 429 caused the probe to skip the live check. Used by
   *  writeQuotaCache to select the short RATE_LIMIT_TTL_MS instead of the
   *  default 5-min TTL. Keying off this boolean avoids matching on the
   *  user-facing detail string, which is a maintenance trap. */
  rateLimited?: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 2000

/**
 * Race a probe against a hard timeout. Returns a fail ProbeResult if the
 * probe doesn't settle within timeoutMs.
 */
async function withTimeout<T extends ProbeResult>(
  label: string,
  p: Promise<T>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'fail', label, detail: 'timed out' }), timeoutMs)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r > 0 ? `${m}m ${r}s` : `${m}m`
}

function formatDaysFromNow(expiresAt: number): string {
  const days = Math.round((expiresAt - Date.now()) / 86_400_000)
  if (days < 0) return 'expired'
  return `token ${days}d`
}

// ─── Probe: Account ──────────────────────────────────────────────────────────

interface ClaudeJson {
  oauthAccount?: {
    emailAddress?: string
    displayName?: string
    billingType?: string
    hasExtraUsageEnabled?: boolean
  }
}

interface OauthTokenMeta {
  expiresAt?: number
  createdAt?: number
}

function mapPlan(billingType?: string, hasExtra?: boolean): string {
  if (!billingType) return 'unknown plan'
  if (billingType === 'stripe_subscription') {
    return hasExtra ? 'Pro+' : 'Pro'
  }
  if (billingType.toLowerCase().includes('max')) return 'Max'
  return billingType
}

/**
 * Threshold below which a still-valid OAuth token is treated as
 * `degraded` so the boot card surfaces it before the user is locked
 * out mid-turn. 7 days is the smallest window that still gives
 * comfortable lead time for a manual reauth in normal use.
 */
const TOKEN_EXPIRING_SOON_DAYS = 7

/**
 * Read account info from the agent's .claude.json.
 * agentDir: e.g. /home/user/.switchroom/agents/clerk
 */
export async function probeAccount(agentDir: string): Promise<ProbeResult> {
  return withTimeout('Account', (async (): Promise<ProbeResult> => {
    const claudeDir = join(agentDir, '.claude')
    const claudeJsonPath = join(claudeDir, '.claude.json')
    let cfg: ClaudeJson = {}
    try {
      const raw = readFileSync(claudeJsonPath, 'utf8')
      cfg = JSON.parse(raw) as ClaudeJson
    } catch {
      return { status: 'fail', label: 'Account', detail: 'no .claude.json' }
    }

    const acc = cfg.oauthAccount
    if (!acc?.emailAddress) {
      return { status: 'degraded', label: 'Account', detail: 'not signed in' }
    }

    const plan = mapPlan(acc.billingType, acc.hasExtraUsageEnabled)

    // Read token expiry. Status is driven by the days-remaining bucket:
    //   < 0 days  → fail     (already expired — agent is locked out)
    //   < 7 days  → degraded (surface so the user can reauth in time)
    //   ≥ 7 days  → ok       (no row in the boot card)
    let tokenStr = ''
    let status: ProbeStatus = 'ok'
    for (const candidate of [
      join(claudeDir, '.oauth-token.meta.json'),
      join(claudeDir, 'accounts', 'default', '.oauth-token.meta.json'),
    ]) {
      if (existsSync(candidate)) {
        try {
          const meta = JSON.parse(readFileSync(candidate, 'utf8')) as OauthTokenMeta
          if (meta.expiresAt) {
            tokenStr = ' · ' + formatDaysFromNow(meta.expiresAt)
            const daysLeft = Math.round((meta.expiresAt - Date.now()) / 86_400_000)
            if (daysLeft < 0) status = 'fail'
            else if (daysLeft < TOKEN_EXPIRING_SOON_DAYS) status = 'degraded'
          }
        } catch {}
        break
      }
    }

    return {
      status,
      label: 'Account',
      detail: `${acc.emailAddress} · ${plan}${tokenStr}`,
    }
  })())
}

// ─── Probe: Agent process ────────────────────────────────────────────────────

function parseSystemctlKv(output: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }
  return result
}

function formatUptime(activeEnterTimestamp: string): string {
  if (!activeEnterTimestamp || activeEnterTimestamp === '0') return ''
  // systemctl outputs like "Thu 2026-04-26 10:15:30 UTC" or epoch microseconds
  let ms: number
  const epoch = Number(activeEnterTimestamp)
  if (!isNaN(epoch) && epoch > 0) {
    ms = Date.now() - Math.round(epoch / 1000)
  } else {
    const d = new Date(activeEnterTimestamp)
    if (isNaN(d.getTime())) return ''
    ms = Date.now() - d.getTime()
  }
  return ms > 0 ? `up ${formatMs(ms)}` : ''
}

function formatMemory(memoryCurrent: string): string {
  const bytes = Number(memoryCurrent)
  if (!isFinite(bytes) || bytes <= 0) return ''
  const mb = Math.round(bytes / 1024 / 1024)
  return `${mb} MB`
}

/**
 * How often to retry after a non-active state during the re-probe loop.
 * Exported for test injection.
 */
export const AGENT_RETRY_INTERVAL_MS = 1500

/**
 * Maximum additional wait beyond the settle window before committing to
 * whatever the final state is. Exported for test injection.
 */
export const AGENT_RETRY_MAX_MS = 12_000

/**
 * How long the boot-card live-agent-status loop keeps polling and editing
 * the card in-place after the initial probe run. The loop exits early as
 * soon as the agent reaches `active`. If the window expires without the
 * agent becoming active, the card commits to whatever state is current.
 *
 * 45 s covers the typical systemd restart cycle (deactivating → inactive →
 * activating → active) even under load, while staying short enough that a
 * genuinely stuck unit (still `inactive` at 45 s) is a real problem.
 * Exported for test injection.
 */
export const AGENT_LIVE_WINDOW_MS = 45_000

/**
 * How often the live-watch loop re-polls systemd while waiting for the
 * agent to become active. Exported for test injection.
 */
export const AGENT_LIVE_POLL_INTERVAL_MS = 2_000

/**
 * After the live window expires with the agent still not `active`, the
 * generator schedules ONE follow-up re-poll this many ms later. If the
 * agent has reached `active` by then, an updated ✅ ProbeResult is
 * yielded and the boot card edits in place. Otherwise no further yield.
 *
 * Pre-#296 fix the generator returned immediately at window-expiry, so
 * an agent that became active 1-30s after the window stayed visibly
 * 🟡 "service inactive" forever (until the user noticed and asked).
 *
 * 30 s is the recommended-by-issue-author value: long enough to catch
 * the common late-boot scenario (slow disk, claude-cli npm install
 * ticking down), short enough that genuinely stuck units still surface
 * as a real problem within ~75 s total.
 */
export const AGENT_LIVE_FOLLOWUP_REPOLL_MS = 30_000

type ExecFileResult = { stdout: string; stderr: string }
type ExecFileFnType = (
  cmd: string,
  args: string[],
) => Promise<ExecFileResult>

/**
 * Query systemctl for the agent service and return a snapshot of its state.
 * Extracted so the re-probe loop can call it multiple times.
 */
async function queryAgentState(
  agentName: string,
  execFileImpl: ExecFileFnType,
): Promise<{
  state: string
  kv: Record<string, string>
} | { error: string }> {
  let stdout: string
  try {
    const result = await execFileImpl('systemctl', [
      '--user', 'show',
      `switchroom-${agentName}.service`,
      '-p', 'MainPID,ActiveState,MemoryCurrent,ActiveEnterTimestamp',
    ])
    stdout = result.stdout
  } catch (err: unknown) {
    return { error: `systemctl failed: ${(err as Error).message ?? String(err)}` }
  }
  const kv = parseSystemctlKv(stdout)
  return { state: kv['ActiveState'] ?? 'unknown', kv }
}

export async function probeAgentProcess(
  agentName: string,
  opts: {
    retryIntervalMs?: number
    retryMaxMs?: number
    /** Override for tests — replaces real delays */
    sleepImpl?: (ms: number) => Promise<void>
    /** Override for tests — replaces real execFile calls */
    execFileImpl?: ExecFileFnType
  } = {},
): Promise<ProbeResult> {
  const retryIntervalMs = opts.retryIntervalMs ?? AGENT_RETRY_INTERVAL_MS
  const retryMaxMs = opts.retryMaxMs ?? AGENT_RETRY_MAX_MS
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const execFileFn: ExecFileFnType = opts.execFileImpl ?? execFile

  return withTimeout('Agent', (async (): Promise<ProbeResult> => {
    const startMs = Date.now()

    // Re-probe loop: if state is not yet `active`, retry every retryIntervalMs
    // up to retryMaxMs total elapsed. Transients (deactivating, activating,
    // auto-restart) typically resolve within one or two retries.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const snapshot = await queryAgentState(agentName, execFileFn)

      if ('error' in snapshot) {
        return { status: 'fail', label: 'Agent', detail: snapshot.error }
      }

      const { state, kv } = snapshot

      if (state === 'active') {
        const pid = kv['MainPID'] ?? '?'
        const uptime = formatUptime(kv['ActiveEnterTimestamp'] ?? '')
        const mem = formatMemory(kv['MemoryCurrent'] ?? '')
        const parts = [`PID ${pid}`, uptime, mem].filter(Boolean)
        return { status: 'ok', label: 'Agent', detail: parts.join(' · ') }
      }

      const elapsedMs = Date.now() - startMs
      if (elapsedMs >= retryMaxMs) {
        // Committed to the current non-active state.
        // `deactivating`, `activating`, and `auto-restart` are unambiguous
        // transients — honest severity is degraded (🟡), not fail (🔴).
        // Any other non-active state (inactive, failed, …) is a hard fail.
        const isTransient =
          state === 'deactivating' ||
          state === 'activating' ||
          state === 'auto-restart'
        const status = isTransient ? 'degraded' : 'fail'
        return { status, label: 'Agent', detail: `service ${state}` }
      }

      // Still within retry budget — wait and try again.
      await sleep(retryIntervalMs)
    }
  })(), PROBE_TIMEOUT_MS + retryMaxMs)  // extend outer timeout to cover full retry budget
}

/**
 * Async generator that watches the agent systemd unit and yields a
 * ProbeResult each time the meaningful state changes, for up to
 * `liveWindowMs` total. Exits early as soon as the unit reaches `active`.
 *
 * Designed for the boot-card live-update loop in `boot-card.ts`: the
 * caller iterates, edits the card on each yielded result, and breaks once
 * it sees `status === 'ok'` or the generator exhausts.
 *
 * Key contract:
 *   - First yield is immediate (no initial delay) so the card can show
 *     the current state right away.
 *   - Subsequent yields happen every `pollIntervalMs`.
 *   - `inactive` and `activating` within the window → status `degraded`
 *     (🟡 "starting"), not `fail`. Only `failed` or window-expired-`inactive`
 *     commits to `fail`.
 *   - When the window expires without `active` the generator yields a
 *     final committed result and then ends.
 */
export async function* watchAgentProcess(
  agentName: string,
  opts: {
    liveWindowMs?: number
    pollIntervalMs?: number
    /**
     * Wait this many ms after the live window expires before doing one
     * follow-up state check. If the agent reached `active` in that
     * window, yield an updated ✅ ProbeResult so the boot card flips
     * from 🟡 "service inactive" to ✅. See #296. Set to 0 to disable.
     */
    followupRepollMs?: number
    /** Override for tests — replaces real delays */
    sleepImpl?: (ms: number) => Promise<void>
    /** Override for tests — replaces real execFile calls */
    execFileImpl?: ExecFileFnType
    /**
     * Override for tests. Defaults to Date.now. The within-window
     * check uses this; injecting lets tests advance "time" without
     * real sleeps.
     */
    nowImpl?: () => number
  } = {},
): AsyncGenerator<ProbeResult> {
  const liveWindowMs = opts.liveWindowMs ?? AGENT_LIVE_WINDOW_MS
  const pollIntervalMs = opts.pollIntervalMs ?? AGENT_LIVE_POLL_INTERVAL_MS
  const followupRepollMs = opts.followupRepollMs ?? AGENT_LIVE_FOLLOWUP_REPOLL_MS
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const execFileFn: ExecFileFnType = opts.execFileImpl ?? execFile
  const now = opts.nowImpl ?? (() => Date.now())

  const startMs = now()
  let lastYieldedDetail: string | null = null

  /**
   * Convert a raw systemd state into a ProbeResult suitable for the boot card.
   * Within the live window: inactive, activating, auto-restart, and
   * deactivating are all 🟡 "starting" — we don't know they're stuck yet.
   * Only `failed` is immediately 🔴. Everything else (unknown) is also 🔴.
   */
  function toProbeResult(
    state: string,
    kv: Record<string, string>,
    withinWindow: boolean,
  ): ProbeResult {
    if (state === 'active') {
      const pid = kv['MainPID'] ?? '?'
      const uptime = formatUptime(kv['ActiveEnterTimestamp'] ?? '')
      const mem = formatMemory(kv['MemoryCurrent'] ?? '')
      const parts = [`PID ${pid}`, uptime, mem].filter(Boolean)
      return { status: 'ok', label: 'Agent', detail: parts.join(' · ') }
    }
    if (withinWindow) {
      // Treat all non-active states as transient while still within the
      // window. `failed` is the only exception — hard fail even in-window.
      if (state === 'failed') {
        return { status: 'fail', label: 'Agent', detail: 'service failed' }
      }
      return { status: 'degraded', label: 'Agent', detail: 'service starting' }
    }
    // Window expired — commit to the actual state.
    const isTransient =
      state === 'deactivating' ||
      state === 'activating' ||
      state === 'auto-restart' ||
      state === 'inactive'
    const status = isTransient ? 'degraded' : 'fail'
    return { status, label: 'Agent', detail: `service ${state}` }
  }

  while (true) {
    const elapsedMs = now() - startMs
    const withinWindow = elapsedMs < liveWindowMs

    const snapshot = await queryAgentState(agentName, execFileFn)

    if ('error' in snapshot) {
      yield { status: 'fail', label: 'Agent', detail: snapshot.error }
      return
    }

    const result = toProbeResult(snapshot.state, snapshot.kv, withinWindow)

    // Only yield when the result detail actually changed — avoids
    // redundant card edits ("service starting" → "service starting").
    if (result.detail !== lastYieldedDetail) {
      lastYieldedDetail = result.detail
      yield result
    }

    // Terminal states: active (ok) or genuinely failed.
    if (result.status === 'ok' || (result.status === 'fail' && snapshot.state === 'failed')) {
      return
    }

    // If window expired, we already yielded the final committed result.
    if (!withinWindow) {
      // #296 follow-up: schedule ONE re-poll after the live window so a
      // late-boot transition (active arriving 1-30s after the window) flips
      // the card from 🟡 "service inactive" to ✅ instead of staying stale
      // until the next user-driven event. Skipped when:
      //   - followupRepollMs <= 0 (test override / explicit disable)
      //   - the final result was already 'ok' (handled by the early-return above)
      //   - the final result was 'fail' due to systemd reporting `failed`
      //     (also handled above) — anything reaching here is degraded
      if (followupRepollMs <= 0) return
      await sleep(followupRepollMs)
      const followup = await queryAgentState(agentName, execFileFn)
      if ('error' in followup) return
      // Only yield on a state we DIDN'T see before — silently no-op if the
      // agent is still inactive/activating/etc., to avoid card flapping.
      if (followup.state !== 'active') return
      const okResult = toProbeResult(followup.state, followup.kv, false)
      if (okResult.detail !== lastYieldedDetail) {
        yield okResult
      }
      return
    }

    await sleep(pollIntervalMs)
  }
}

// ─── Probe: Gateway ──────────────────────────────────────────────────────────

export interface GatewayRuntimeInfo {
  pid: number
  startedAtMs: number
  lastPollMs?: number
}

export async function probeGateway(info: GatewayRuntimeInfo): Promise<ProbeResult> {
  return withTimeout('Gateway', (async (): Promise<ProbeResult> => {
    const uptime = formatMs(Date.now() - info.startedAtMs)
    const lastPoll = info.lastPollMs != null
      ? `last poll ${formatMs(Date.now() - info.lastPollMs)} ago`
      : ''
    const parts = [`PID ${info.pid}`, `up ${uptime}`, lastPoll].filter(Boolean)
    return { status: 'ok', label: 'Gateway', detail: parts.join(' · ') }
  })())
}

// ─── Probe: Quota ─────────────────────────────────────────────────────────────

const QUOTA_DEBUG_FILE = 'quota-debug.json'

/**
 * Attempt to read quota info via the /api/oauth/usage endpoint.
 * The response schema is undocumented — we probe defensively and
 * save the raw response to a debug file on first 2xx hit.
 *
 * Result is cached for 5 min in `~/.switchroom/quota-cache.json` and
 * shared across all agents. Without the cache, every gateway boot +
 * bridge-reconnect across 4 agents hits the endpoint, triggering 429s
 * that surface as 🟡 "rate limited" in the boot card. See `quota-cache.ts`.
 *
 * Tests can override the cache path via SWITCHROOM_QUOTA_CACHE_PATH.
 */
export async function probeQuota(
  claudeConfigDir: string,
  agentDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  return withTimeout('Quota', (async (): Promise<ProbeResult> => {
    // Cache hit → return early (avoids the rate-limit cascade)
    const cached = readQuotaCache()
    if (cached) {
      return cached
    }

    // Read token
    let token: string | null = null
    for (const candidate of [
      join(claudeConfigDir, '.oauth-token'),
      join(claudeConfigDir, 'accounts', 'default', '.oauth-token'),
    ]) {
      if (existsSync(candidate)) {
        try {
          const raw = readFileSync(candidate, 'utf8').trim()
          if (raw.length > 0) { token = raw; break }
        } catch {}
      }
    }
    if (!token) {
      return { status: 'degraded', label: 'Quota', detail: 'no OAuth token' }
    }

    let resp: Response
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 1800)
      resp = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'switchroom-boot/0.1',
        },
        signal: controller.signal,
      })
      clearTimeout(t)
    } catch (err: unknown) {
      return { status: 'fail', label: 'Quota', detail: `request failed: ${(err as Error).message ?? String(err)}` }
    }

    if (resp.status === 429) {
      // A 429 from /api/oauth/usage means the endpoint is rate-limiting our
      // probe calls — it does NOT mean the user is out of quota. Conflating
      // the two is the root cause of the false 🟡 "rate limited" alarm
      // reported in #210. Return ok-with-note and cache it for 30 s so
      // simultaneous fleet restarts read the cached result instead of piling
      // up on the same endpoint (see quota-cache.ts: RATE_LIMIT_TTL_MS).
      //
      // We assume 429 from /api/oauth/usage signals endpoint rate-limiting,
      // not quota exhaustion. Anthropic uses 403 / 200-with-flag for the
      // latter today; if that changes, revisit this 🟢 mapping.
      const rateLimitResult: ProbeResult = {
        status: 'ok',
        label: 'Quota',
        detail: 'quota check skipped: rate limited',
        rateLimited: true,
      }
      writeQuotaCache(rateLimitResult)
      return rateLimitResult
    }
    if (!resp.ok) {
      return { status: 'degraded', label: 'Quota', detail: `HTTP ${resp.status}` }
    }

    let body: unknown
    try {
      body = await resp.json()
    } catch {
      return { status: 'degraded', label: 'Quota', detail: 'invalid JSON response' }
    }

    // Defensive schema discovery — save raw response for tightening
    const debugPath = join(agentDir, 'telegram', QUOTA_DEBUG_FILE)
    try {
      // Redact token/UUID fields before saving
      const redacted = JSON.parse(JSON.stringify(body, (k, v) => {
        if (/token|uuid|id|key/i.test(k) && typeof v === 'string' && v.length > 10) return '[REDACTED]'
        return v
      }))
      mkdirSync(join(agentDir, 'telegram'), { recursive: true })
      writeFileSync(debugPath, JSON.stringify({ capturedAt: new Date().toISOString(), body: redacted }, null, 2))
    } catch {}

    // Try common field paths — schema not yet locked
    const b = body as Record<string, unknown>
    const sessionQuota =
      (b?.['data'] as Record<string, unknown> | undefined)?.['session_quota'] ??
      b?.['session_quota'] ??
      (b?.['quota'] as Record<string, unknown> | undefined)?.['session'] ??
      (b?.['usage'] as Record<string, unknown> | undefined)?.['session']

    if (!sessionQuota) {
      return {
        status: 'degraded',
        label: 'Quota',
        detail: `schema unknown — first call captured (debug: ${debugPath})`,
      }
    }

    const sq = sessionQuota as Record<string, unknown>
    const parts: string[] = []
    if (typeof sq['sonnet_used_pct'] === 'number') parts.push(`Sonnet ${Math.round(sq['sonnet_used_pct'] as number)}%`)
    if (typeof sq['opus_used_pct'] === 'number') parts.push(`Opus ${Math.round(sq['opus_used_pct'] as number)}%`)
    if (typeof sq['used_pct'] === 'number') parts.push(`${Math.round(sq['used_pct'] as number)}% used`)
    if (typeof sq['resets_in_sec'] === 'number') {
      const sec = sq['resets_in_sec'] as number
      const h = Math.floor(sec / 3600)
      const m = Math.round((sec % 3600) / 60)
      parts.push(`resets in ${h}h ${m}m`)
    }

    if (parts.length === 0) {
      return { status: 'degraded', label: 'Quota', detail: 'schema unknown — saving raw response' }
    }
    const result: ProbeResult = { status: 'ok', label: 'Quota', detail: parts.join(' · ') }
    writeQuotaCache(result)
    return result
  })())
}

// ─── Probe: Hindsight ────────────────────────────────────────────────────────

export async function probeHindsight(
  bankName?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  return withTimeout('Hindsight', (async (): Promise<ProbeResult> => {
    const base = 'http://127.0.0.1:18888'
    let resp: Response | null = null

    for (const path of ['/health', '/']) {
      try {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), 1800)
        resp = await fetchImpl(`${base}${path}`, { signal: controller.signal })
        clearTimeout(t)
        if (resp.status !== 404) break
      } catch {}
    }

    if (!resp || !resp.ok) {
      return { status: 'fail', label: 'Hindsight', detail: 'unreachable' }
    }

    const bankSuffix = bankName ? ` · bank=${bankName}` : ''
    return { status: 'ok', label: 'Hindsight', detail: `reachable${bankSuffix}` }
  })())
}

// ─── Probe: Cron timers ──────────────────────────────────────────────────────

interface SystemctlTimerEntry {
  next?: string
  left?: string
  last?: string
  unit?: string
  activates?: string
  passed?: string
}

function parseTimerLeft(left: string | undefined): number | null {
  if (!left) return null
  // format: "1h 32min left" or "2min 5s left" or similar
  let ms = 0
  const h = left.match(/(\d+)h/)
  const m = left.match(/(\d+)min/)
  const s = left.match(/(\d+)s/)
  if (h) ms += Number(h[1]) * 3600_000
  if (m) ms += Number(m[1]) * 60_000
  if (s) ms += Number(s[1]) * 1000
  return ms > 0 ? ms : null
}

export async function probeCronTimers(
  agentName: string,
  opts: { execFileImpl?: ExecFileFnType } = {},
): Promise<ProbeResult> {
  const execFileFn: ExecFileFnType = opts.execFileImpl ?? execFile
  return withTimeout('Crons', (async (): Promise<ProbeResult> => {
    let stdout: string
    try {
      const result = await execFileFn('systemctl', [
        '--user', 'list-timers',
        `switchroom-${agentName}-cron-*`,
        '--output=json',
        '--all',
      ])
      stdout = result.stdout.trim()
    } catch (err: unknown) {
      // systemctl exits non-zero when no units match
      const msg = (err as NodeJS.ErrnoException)?.message ?? String(err)
      if (msg.includes('No timers found') || (err as NodeJS.ErrnoException)?.code === 1) {
        return { status: 'ok', label: 'Crons', detail: '0 timers' }
      }
      return { status: 'fail', label: 'Crons', detail: `systemctl failed: ${msg}` }
    }

    if (!stdout || stdout === '[]' || stdout.length === 0) {
      return { status: 'ok', label: 'Crons', detail: '0 timers' }
    }

    let timers: SystemctlTimerEntry[] = []
    try {
      timers = JSON.parse(stdout) as SystemctlTimerEntry[]
    } catch {
      // Fall back to line-count if JSON failed
      const count = stdout.split('\n').filter(l => l.includes('cron')).length
      return { status: 'ok', label: 'Crons', detail: `${count} timers` }
    }

    if (!Array.isArray(timers) || timers.length === 0) {
      return { status: 'ok', label: 'Crons', detail: '0 timers' }
    }

    // Find the timer that fires soonest
    let earliest: { name: string; leftMs: number } | null = null
    for (const t of timers) {
      const ms = parseTimerLeft(t.left)
      const name = (t.unit ?? t.activates ?? '').replace(/^switchroom-[^-]+-cron-/, '').replace(/\.timer$/, '')
      if (ms != null && (earliest == null || ms < earliest.leftMs)) {
        earliest = { name, leftMs: ms }
      }
    }

    const count = timers.length
    if (!earliest) {
      return { status: 'ok', label: 'Crons', detail: `${count} timers` }
    }

    const h = Math.floor(earliest.leftMs / 3600_000)
    const m = Math.round((earliest.leftMs % 3600_000) / 60_000)
    const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`
    return {
      status: 'ok',
      label: 'Crons',
      detail: `${count} timers · next: ${earliest.name} in ${timeStr}`,
    }
  })())
}
