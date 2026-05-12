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

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs'
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
  /** Plain-text remediation hint shown beneath the degraded row in the
   *  boot card. Per `reference/principles.md` principle 1, every failure
   *  should tell the user what to do next — naming the failure without a
   *  next step is the explicit ❌ Bad pattern. Omitted on ok rows (they
   *  don't render) and on degraded rows where no actionable hint exists.
   */
  nextStep?: string
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
      return {
        status: 'degraded',
        label: 'Account',
        detail: 'not signed in',
        nextStep: 'Run `switchroom auth login <agent>` to start the OAuth flow',
      }
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

    const nextStep = status === 'fail'
      ? 'OAuth token expired — run `switchroom auth login <agent>` to re-authenticate'
      : status === 'degraded'
        ? 'Token expiring soon — run `switchroom auth login <agent>` before it lapses'
        : undefined
    return {
      status,
      label: 'Account',
      detail: `${acc.emailAddress} · ${plan}${tokenStr}`,
      ...(nextStep ? { nextStep } : {}),
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
 * Filesystem injection point for the docker-mode /proc walk so tests can
 * drive synthetic `/proc/<pid>/{comm,stat,status}` strings without
 * touching the real host fs.
 */
export interface ProcFsImpl {
  readdir: (path: string) => string[]
  readFile: (path: string) => string
}

const realProcFs: ProcFsImpl = {
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, 'utf-8'),
}

type AgentCandidate = {
  pid: number
  rssKb: number
  comm: string
  starttime: number
}

/**
 * Walk `/proc` from inside the current pid-namespace and pick the
 * heaviest claude/node process. Used for the docker-mode agent probe:
 * inside an agent container, we share the namespace with claude, so a
 * /proc walk replaces the systemctl-driven cgroup walk used under
 * systemd. Skips wrappers (tmux/expect/script/bash/sh) and our own
 * gateway PID. Exported for tests.
 */
export function findAgentProcessInContainer(
  fs: ProcFsImpl = realProcFs,
): AgentCandidate | null {
  let entries: string[]
  try {
    entries = fs.readdir('/proc')
  } catch {
    return null
  }
  const candidates: AgentCandidate[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (!Number.isFinite(pid) || pid <= 0) continue
    if (pid === process.pid) continue
    let comm = ''
    try {
      comm = fs.readFile(`/proc/${pid}/comm`).trim()
    } catch {
      continue
    }
    let rssKb = 0
    try {
      const status = fs.readFile(`/proc/${pid}/status`)
      const m = status.match(/^VmRSS:\s+(\d+)/m)
      if (m) rssKb = parseInt(m[1], 10) || 0
    } catch {
      continue
    }
    let starttime = 0
    try {
      const stat = fs.readFile(`/proc/${pid}/stat`)
      // /proc/<pid>/stat format: pid (comm-with-parens) state ppid ...
      // field 22 (1-indexed) is starttime in clock ticks since boot.
      // comm can contain spaces/parens — use the LAST ')' as the
      // anchor so we tokenize the remainder safely.
      const close = stat.lastIndexOf(')')
      const tail = close >= 0 ? stat.slice(close + 2) : stat
      const fields = tail.trim().split(/\s+/)
      // After the "(comm)" group, the remaining fields are state, ppid,
      // ... with starttime at index 19 (0-indexed) of `tail` because
      // field 3 (state) is `tail[0]`.
      const st = Number(fields[19])
      if (Number.isFinite(st) && st > 0) starttime = st
    } catch {
      continue
    }
    candidates.push({ pid, rssKb, comm, starttime })
  }
  if (candidates.length === 0) return null

  const isAgent = (c: AgentCandidate): boolean => c.comm === 'claude'
  const isWrapper = (c: AgentCandidate): boolean =>
    c.comm === 'tmux' || c.comm.startsWith('tmux:') ||
    c.comm === 'expect' || c.comm === 'script' ||
    c.comm === 'bash' || c.comm === 'sh' ||
    c.comm === 'tini' || c.comm === 'sleep'

  const claudeMatches = candidates.filter(isAgent)
  if (claudeMatches.length > 0) {
    claudeMatches.sort((a, b) => b.rssKb - a.rssKb)
    return claudeMatches[0]
  }
  // No `claude` comm — fall back to heaviest non-wrapper node process.
  const nodeMatches = candidates
    .filter(c => c.comm === 'node' && !isWrapper(c))
    .sort((a, b) => b.rssKb - a.rssKb)
  if (nodeMatches.length > 0) return nodeMatches[0]
  return null
}

/**
 * Read /proc/uptime to derive the agent process's uptime from its
 * starttime (clock ticks since boot). Returns null on any failure.
 *
 * SC_CLK_TCK (the units of `starttime` in /proc/<pid>/stat) is a stable
 * kernel ABI value, hardcoded to 100 on x86_64 across Debian/Ubuntu/
 * Alpine/RHEL. If we ever ship on arm64 hosts where some kernels use
 * 250, uptimes will look 2.5× too large and we'll revisit.
 */
export function uptimeMsForStarttime(
  starttimeTicks: number,
  fs: ProcFsImpl = realProcFs,
): number | null {
  try {
    const uptimeRaw = fs.readFile('/proc/uptime').trim()
    const bootUptimeSec = Number(uptimeRaw.split(/\s+/)[0])
    if (!Number.isFinite(bootUptimeSec) || bootUptimeSec <= 0) return null
    const HZ = 100
    const procUptimeSec = bootUptimeSec - starttimeTicks / HZ
    if (procUptimeSec < 0) return null
    return Math.round(procUptimeSec * 1000)
  } catch {
    return null
  }
}

function probeAgentProcessDocker(): ProbeResult {
  const found = findAgentProcessInContainer()
  if (!found) {
    return { status: 'fail', label: 'Agent', detail: 'claude process not found' }
  }
  const uptimeMs = uptimeMsForStarttime(found.starttime)
  const mb = Math.round(found.rssKb / 1024)
  const parts = [
    `PID ${found.pid}`,
    uptimeMs != null ? `up ${formatMs(uptimeMs)}` : '',
    mb > 0 ? `${mb} MB` : '',
  ].filter(Boolean)
  return { status: 'ok', label: 'Agent', detail: parts.join(' · ') }
}

/**
 * Resolve the "real" agent PID under tmux supervisor by walking the
 * unit's cgroup and picking the heaviest-RSS claude/node process.
 *
 * Returns null on any failure — caller should fall back to MainPID.
 *
 * Mirrors `resolveAgentPid()` in `src/agents/lifecycle.ts` and
 * `agent_main_pid()` in `bin/bridge-watchdog.sh`. Kept duplicated rather
 * than imported because the gateway runs in a separate package and we
 * don't want a cross-package import for a 30-line helper.
 */
async function resolveTmuxSupervisorPid(
  agentName: string,
  execFileImpl: ExecFileFnType,
): Promise<number | null> {
  try {
    const { stdout: cgOut } = await execFileImpl('systemctl', [
      '--user', 'show', `switchroom-${agentName}.service`,
      '-p', 'ControlGroup', '--value',
    ])
    const cgroup = cgOut.trim()
    if (!cgroup) return null
    const procsPath = `/sys/fs/cgroup${cgroup}/cgroup.procs`
    if (!existsSync(procsPath)) return null
    const pidsRaw = readFileSync(procsPath, 'utf-8')
    const pids = pidsRaw.split('\n').map(s => s.trim()).filter(Boolean)
    if (pids.length === 0) return null

    type Candidate = { pid: number; rss: number; comm: string }
    const candidates: Candidate[] = []
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10)
      if (!Number.isFinite(pid) || pid <= 0) continue
      let rss = 0
      let comm = ''
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf-8')
        const rssLine = status.split('\n').find(l => l.startsWith('VmRSS:'))
        if (rssLine) {
          const m = rssLine.match(/(\d+)/)
          if (m) rss = parseInt(m[1], 10) || 0
        }
      } catch {
        continue
      }
      try {
        comm = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim()
      } catch { /* ignore */ }
      candidates.push({ pid, rss, comm })
    }
    if (candidates.length === 0) return null

    const isAgent = (c: Candidate): boolean => c.comm === 'claude' || c.comm === 'node'
    const isWrapper = (c: Candidate): boolean =>
      c.comm === 'tmux' || c.comm.startsWith('tmux:') ||
      c.comm === 'expect' || c.comm === 'script' ||
      c.comm === 'bash' || c.comm === 'sh'

    const agentMatches = candidates.filter(isAgent)
    if (agentMatches.length > 0) {
      agentMatches.sort((a, b) => b.rss - a.rss)
      return agentMatches[0].pid
    }
    const nonWrapper = candidates.filter(c => !isWrapper(c))
    if (nonWrapper.length > 0) {
      nonWrapper.sort((a, b) => b.rss - a.rss)
      return nonWrapper[0].pid
    }
    // Candidates enumerated but every one was a wrapper (tmux/expect/
    // script/bash/sh). Emit a breadcrumb mirroring the one in
    // src/agents/lifecycle.ts:resolveAgentPid so journalctl shows the
    // same state on both sides. The boot-window race (zero pids) returns
    // earlier without logging, by design.
    process.stderr.write(
      `[switchroom] resolveTmuxSupervisorPid: cgroup walk found ${candidates.length} processes, no claude match — falling back to MainPID for unit=switchroom-${agentName}.service\n`,
    )
    return null
  } catch {
    return null
  }
}

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
    /** When true, resolve PID via cgroup walk (heaviest claude/node) — under
     *  tmux supervisor MainPID is the tmux server (~2MB) which is misleading. */
    tmuxSupervisor?: boolean
    /** When true, skip systemctl entirely. The gateway is running INSIDE the
     *  agent container alongside claude, so we walk /proc directly. There's
     *  no "service deactivating/activating" model under docker — claude is
     *  either there or it isn't, so we return single-shot without retry. */
    dockerMode?: boolean
    /** Test override — defaults to the real probeAgentProcessDocker(). */
    dockerProbeImpl?: () => ProbeResult
  } = {},
): Promise<ProbeResult> {
  if (opts.dockerMode) {
    const impl = opts.dockerProbeImpl ?? probeAgentProcessDocker
    return withTimeout('Agent', Promise.resolve(impl()))
  }
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
        let pid: string = kv['MainPID'] ?? '?'
        if (opts.tmuxSupervisor) {
          const resolved = await resolveTmuxSupervisorPid(agentName, execFileFn)
          if (resolved && resolved > 0) pid = String(resolved)
        }
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
    /** When true, resolve PID via cgroup walk (heaviest claude/node). */
    tmuxSupervisor?: boolean
    /** When true, skip systemctl: yield once with the current /proc-derived
     *  state and exit. Mirrors probeAgentProcess's docker-mode shortcut. */
    dockerMode?: boolean
    /** Test override — defaults to the real probeAgentProcessDocker(). */
    dockerProbeImpl?: () => ProbeResult
  } = {},
): AsyncGenerator<ProbeResult> {
  if (opts.dockerMode) {
    const impl = opts.dockerProbeImpl ?? probeAgentProcessDocker
    yield impl()
    return
  }
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
  async function toProbeResult(
    state: string,
    kv: Record<string, string>,
    withinWindow: boolean,
  ): Promise<ProbeResult> {
    if (state === 'active') {
      let pid: string = kv['MainPID'] ?? '?'
      if (opts.tmuxSupervisor) {
        const resolved = await resolveTmuxSupervisorPid(agentName, execFileFn)
        if (resolved && resolved > 0) pid = String(resolved)
      }
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

    const result = await toProbeResult(snapshot.state, snapshot.kv, withinWindow)

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
      const okResult = await toProbeResult(followup.state, followup.kv, false)
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

// ─── Probe: Scheduler (in-container agent-scheduler since Phase 4) ───────────

/**
 * Default lock and audit-jsonl paths inside the agent container.
 * Mirrored from src/agent-scheduler/index.ts:194-197 — kept in sync there.
 */
const SCHEDULER_LOCK_PATH_DEFAULT = '/state/agent/scheduler.lock'
const SCHEDULER_JSONL_PATH_DEFAULT = '/state/agent/scheduler.jsonl'

/**
 * How long after PID 1 started we treat a missing/dead scheduler as
 * "still settling" rather than a hard fail. Boot-card already has its
 * own 6 s settle window before probes run, so this only matters for
 * /status hits during the first ~30 s of a container's life — long
 * enough to cover supervisor + bun startup on a slow host without
 * hiding a genuinely wedged scheduler.
 */
const SCHEDULER_FRESH_BOOT_MS = 30_000

/**
 * Read PID 1's start time inside the container (ms since epoch). Used
 * to soften scheduler probe verdicts during the early-boot window.
 * Mirrors `readContainerBootTimeMs` from src/agent-scheduler/lock.ts —
 * we duplicate the small reader here rather than import across the
 * src/telegram-plugin boundary, since the plugin is built standalone.
 *
 * Returns null on any /proc parse failure → caller skips the softening.
 */
function readContainerBootTimeMsForProbe(): number | null {
  try {
    const stat1 = readFileSync('/proc/1/stat', 'utf8')
    const lastParen = stat1.lastIndexOf(')')
    if (lastParen < 0) return null
    const after = stat1.slice(lastParen + 1).trim().split(/\s+/)
    const starttimeTicks = Number(after[19])
    if (!Number.isFinite(starttimeTicks)) return null
    const procStat = readFileSync('/proc/stat', 'utf8')
    const btimeLine = procStat.split('\n').find((l) => l.startsWith('btime '))
    if (!btimeLine) return null
    const btimeSec = Number(btimeLine.split(/\s+/)[1])
    if (!Number.isFinite(btimeSec)) return null
    const CLK_TCK = 100
    return (btimeSec + starttimeTicks / CLK_TCK) * 1000
  } catch {
    return null
  }
}

/**
 * Filesystem injection point for the scheduler probe. Same shape as
 * ProcFsImpl but read-only against arbitrary paths. Tests inject a
 * synthetic fs to drive lockfile contents and jsonl tails without
 * touching disk.
 */
export interface SchedulerFsImpl {
  readFile: (path: string) => string
  /** stat-mtime, ms-since-epoch. Used to age the audit jsonl. */
  mtimeMs: (path: string) => number
  exists: (path: string) => boolean
}

const realSchedulerFs: SchedulerFsImpl = {
  readFile: (p) => readFileSync(p, 'utf-8'),
  mtimeMs: (p) => {
    // `existsSync` shaped path keeps the probe defensive — caller checks
    // exists() first. statSync is imported via the readdirSync chain.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { statSync } = require('fs') as typeof import('fs')
    return statSync(p).mtimeMs
  },
  exists: (p) => existsSync(p),
}

/**
 * Probe the in-container agent-scheduler (cron-fold-in cutover, Phase 4
 * — see CLAUDE.md "Cron-fold-in note"). Replaces the pre-Phase-4 probe
 * that queried `systemctl --user list-timers switchroom-<agent>-cron-*`
 * (those timers no longer exist) and the dockerMode short-circuit that
 * lied with "managed by switchroom-cron" (that container was retired in
 * PR #893).
 *
 * The scheduler is a sibling sidecar started by start.sh's
 * _switchroom_supervise wrapper. It writes a pidfile-with-liveness lock
 * at /state/agent/scheduler.lock (src/agent-scheduler/lock.ts) and an
 * audit row per fire to /state/agent/scheduler.jsonl
 * (src/agent-scheduler/index.ts:256, src/scheduler/audit.ts).
 *
 *   ok       — lockfile present, holder PID alive
 *   degraded — lockfile present but PID dead (supervisor mid-restart, or
 *              sched crashed and supervisor hasn't relaunched yet)
 *   fail     — lockfile missing (sidecar never started or supervisor
 *              gave up after restart-cap)
 *
 * Outside dockerMode the probe is silent (returns ok with "n/a"). Phase
 * 4 deleted the host-side scheduler entirely; non-docker callers
 * (legacy systemd installs, tests) have no scheduler to probe.
 */
export async function probeScheduler(
  _agentName: string,
  opts: {
    dockerMode?: boolean
    fs?: SchedulerFsImpl
    /** Override the lockfile path. Defaults to env
     *  `SWITCHROOM_AGENT_SCHEDULER_LOCK` (matches the override the
     *  scheduler itself reads at src/agent-scheduler/index.ts:196), then
     *  to `/state/agent/scheduler.lock`. */
    lockPath?: string
    /** Override the audit-jsonl path. Defaults to env
     *  `SWITCHROOM_AGENT_SCHEDULER_JSONL`, then to
     *  `/state/agent/scheduler.jsonl` (mirrors index.ts:194). */
    jsonlPath?: string
    /** Liveness check for the holder PID — defaults to process.kill(pid, 0). */
    isAlive?: (pid: number) => boolean
    now?: () => number
    /** Container PID-1 start time in ms since epoch. When set AND the
     *  current time is within `SCHEDULER_FRESH_BOOT_MS` of it, scheduler
     *  fail/degraded verdicts are softened to "still settling". Pass
     *  `null` to disable the softening (e.g. unit tests pinning a hard
     *  fail). Defaults to `readContainerBootTimeMsForProbe()`. */
    containerBootTimeMs?: number | null
  } = {},
): Promise<ProbeResult> {
  if (!opts.dockerMode) {
    return { status: 'ok', label: 'Scheduler', detail: 'n/a (non-docker)' }
  }
  return withTimeout('Scheduler', (async (): Promise<ProbeResult> => {
    const fs = opts.fs ?? realSchedulerFs
    const lockPath = opts.lockPath
      ?? process.env.SWITCHROOM_AGENT_SCHEDULER_LOCK
      ?? SCHEDULER_LOCK_PATH_DEFAULT
    const jsonlPath = opts.jsonlPath
      ?? process.env.SWITCHROOM_AGENT_SCHEDULER_JSONL
      ?? SCHEDULER_JSONL_PATH_DEFAULT
    const now = opts.now ?? Date.now
    const isAlive = opts.isAlive ?? ((pid: number) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    const bootTimeMs = 'containerBootTimeMs' in opts
      ? opts.containerBootTimeMs
      : readContainerBootTimeMsForProbe()
    const stillSettling = bootTimeMs != null
      && (now() - bootTimeMs) < SCHEDULER_FRESH_BOOT_MS
    const settlingNote = stillSettling ? ' (still settling)' : ''

    if (!fs.exists(lockPath)) {
      // During the first ~30 s of a container's life, "no lockfile" is
      // the supervisor + bun still starting up. /status hit at that
      // moment shouldn't show 🔴 for a non-issue.
      return {
        status: stillSettling ? 'degraded' : 'fail',
        label: 'Scheduler',
        detail: `sidecar not running (no lockfile)${settlingNote}`,
      }
    }
    let holderPid: number | null = null
    try {
      const raw = fs.readFile(lockPath).trim()
      const parsed = Number.parseInt(raw, 10)
      if (Number.isInteger(parsed) && parsed > 0) holderPid = parsed
    } catch {
      return { status: 'degraded', label: 'Scheduler', detail: 'lockfile unreadable' }
    }
    if (holderPid == null) {
      return { status: 'degraded', label: 'Scheduler', detail: 'lockfile contents invalid' }
    }
    if (!isAlive(holderPid)) {
      return {
        status: 'degraded',
        label: 'Scheduler',
        detail: `lock holder pid ${holderPid} not alive (supervisor restart in progress?)`,
      }
    }

    // Sidecar is up. Add a freshness hint from scheduler.jsonl if present
    // — gives the user signal that fires are actually happening, not just
    // that the daemon is breathing. Absence is fine: a freshly booted
    // agent or a 0-entry agent has no fires to report.
    let detail = `running (pid ${holderPid})`
    if (fs.exists(jsonlPath)) {
      try {
        const ageMs = now() - fs.mtimeMs(jsonlPath)
        if (Number.isFinite(ageMs) && ageMs >= 0) {
          detail += ` · last fire ${formatMs(ageMs)} ago`
        }
      } catch {
        // mtime read failed — keep the basic detail; non-blocking.
      }
    }
    return { status: 'ok', label: 'Scheduler', detail }
  })())
}

// ─── Probe: Vault broker / approval kernel reachability ──────────────────────

/**
 * Generic UDS-reachability probe used for both vault-broker and
 * approval-kernel. Path-as-identity invariant (CLAUDE.md "Per-agent
 * socket model") — bind paths are mounted into each agent container at
 * /run/switchroom/{broker,kernel}/<agent>/sock. ENOENT means the
 * compose volume isn't mounted (broker container down or no agent dir
 * yet); ECONNREFUSED means the bind disappeared between us and the
 * daemon (rare, broker shutdown removes the socket).
 *
 * Connect-test only — we do NOT send a wire request. The probe must not
 * authenticate as the agent or do any vault/grant work; that's the
 * agent's job. We just want to know "is something listening on this
 * socket". Connection is closed immediately on success.
 */
async function probeUds(
  label: string,
  socketPath: string | undefined,
  opts: { dockerMode?: boolean; connectImpl?: (path: string) => Promise<void> } = {},
): Promise<ProbeResult> {
  if (!opts.dockerMode) {
    return { status: 'ok', label, detail: 'n/a (non-docker)' }
  }
  if (!socketPath) {
    return { status: 'fail', label, detail: 'socket path not configured' }
  }
  return withTimeout(label, (async (): Promise<ProbeResult> => {
    if (!opts.connectImpl) {
      // Cheap pre-check: stat the file. Saves the connect round-trip on
      // the common "broker container down → bind mount empty" case.
      if (!existsSync(socketPath)) {
        return { status: 'fail', label, detail: `socket missing: ${socketPath}` }
      }
    }
    const connect = opts.connectImpl ?? defaultUdsConnect
    try {
      await connect(socketPath)
      return { status: 'ok', label, detail: 'reachable' }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      const msg = (err as Error)?.message ?? String(err)
      if (code === 'ENOENT') return { status: 'fail', label, detail: 'socket missing' }
      if (code === 'ECONNREFUSED') return { status: 'fail', label, detail: 'connection refused' }
      return { status: 'fail', label, detail: `connect failed: ${msg}` }
    }
  })())
}

/**
 * Default UDS connect — opens a stream, then immediately closes it.
 * Resolves on `connect` event, rejects on `error`. 1s connect timeout
 * is plenty for a local socket (the per-probe timeout in withTimeout
 * is the outer guard).
 */
function defaultUdsConnect(socketPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const net = require('net') as typeof import('net')
  return new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath })
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error('connect timeout'))
    }, 1000)
    sock.once('connect', () => {
      clearTimeout(t)
      sock.end()
      resolve()
    })
    sock.once('error', (err) => {
      clearTimeout(t)
      sock.destroy()
      reject(err)
    })
  })
}

export async function probeBroker(
  socketPath?: string,
  opts: { dockerMode?: boolean; connectImpl?: (path: string) => Promise<void> } = {},
): Promise<ProbeResult> {
  // SWITCHROOM_VAULT_BROKER_SOCK is the canonical client-side env name
  // — matches what src/vault/broker/client.ts:293 and the secret-guard
  // hook (telegram-plugin/hooks/secret-guard-pretool.mjs:36) read.
  // The broker SERVER reads SWITCHROOM_BROKER_SOCKET as its bind-path
  // env (in the broker container only). Pre-fix the probe + compose
  // both used SWITCHROOM_BROKER_SOCKET in the agent container — wrong
  // name, fell through to dangling-symlink fallback, false-failed.
  return probeUds('Broker', socketPath ?? process.env.SWITCHROOM_VAULT_BROKER_SOCK, opts)
}

export async function probeKernel(
  socketPath?: string,
  opts: { dockerMode?: boolean; connectImpl?: (path: string) => Promise<void> } = {},
): Promise<ProbeResult> {
  return probeUds('Kernel', socketPath ?? process.env.SWITCHROOM_KERNEL_SOCKET, opts)
}

// ─── Probe: Skills (symlink validity) ────────────────────────────────────────

/**
 * Validate that every entry under <agentDir>/.claude/skills/ resolves
 * to a readable file. Skills are normally symlinks into the global pool
 * `~/.switchroom/skills/` (src/agents/scaffold.ts:639); a renamed or
 * deleted skill in the pool dangles silently — claude won't surface the
 * skill, the user wonders why /<skill> doesn't work.
 *
 *   ok       — every entry resolves OR the dir doesn't exist (no skills
 *              configured is a normal state, not a failure)
 *   degraded — at least one symlink dangles; rendered detail names them
 *              up to a cap so the row doesn't wrap forever
 */
export async function probeSkills(
  agentDir: string,
  opts: { fs?: SkillsFsImpl; maxNamesShown?: number; agentName?: string } = {},
): Promise<ProbeResult> {
  return withTimeout('Skills', (async (): Promise<ProbeResult> => {
    const fs = opts.fs ?? realSkillsFs
    const max = opts.maxNamesShown ?? 3
    const skillsDir = join(agentDir, '.claude', 'skills')
    if (!fs.exists(skillsDir)) {
      return { status: 'ok', label: 'Skills', detail: 'no skills dir' }
    }
    let entries: string[]
    try {
      entries = fs.readdir(skillsDir)
    } catch {
      return { status: 'degraded', label: 'Skills', detail: 'skills dir unreadable' }
    }
    if (entries.length === 0) {
      return { status: 'ok', label: 'Skills', detail: '0 skills' }
    }
    const dangling: string[] = []
    for (const name of entries) {
      // Skills are dirs containing a SKILL.md (claude convention). The
      // dangle case we worry about is a symlink whose target was
      // removed — readability of <name>/SKILL.md is the simplest proxy
      // and matches what claude itself would discover.
      const skillPath = join(skillsDir, name)
      if (!fs.exists(skillPath)) {
        dangling.push(name)
        continue
      }
      // Single-file skills exist (rare but allowed); accept them too.
      const skillMd = join(skillPath, 'SKILL.md')
      if (!fs.exists(skillMd) && !fs.exists(skillPath + '.md')) {
        // Only flag as dangling if the entry IS a symlink (a real dir
        // without SKILL.md is weird but not necessarily broken — could
        // be an in-progress local skill). We have no symlink-test in
        // SkillsFsImpl by design; conservatively don't flag as dangling.
        // The user's main risk is removed-pool-target, which existsSync
        // catches above.
        continue
      }
    }
    if (dangling.length === 0) {
      return { status: 'ok', label: 'Skills', detail: `${entries.length} resolved` }
    }
    const named = dangling.slice(0, max).join(', ')
    const more = dangling.length > max ? ` +${dangling.length - max} more` : ''
    const reconcileTarget = opts.agentName ? ` ${opts.agentName}` : ''
    return {
      status: 'degraded',
      label: 'Skills',
      detail: `${dangling.length}/${entries.length} dangling: ${named}${more}`,
      nextStep: `Run \`switchroom agent reconcile${reconcileTarget}\` to rebuild symlinks, or remove unused entries from switchroom.yaml`,
    }
  })())
}

export interface SkillsFsImpl {
  readdir: (p: string) => string[]
  exists: (p: string) => boolean
}

const realSkillsFs: SkillsFsImpl = {
  readdir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
}
