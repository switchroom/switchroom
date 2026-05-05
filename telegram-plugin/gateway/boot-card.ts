/**
 * Boot card — posts a quiet, contextual ack at gateway startup. Closes
 * #60 and is PR 1 of 3 in #142's "telegram surfaces: quiet, contextual
 * cards" workstream.
 *
 * Default state is a single line: `✅ <agent> back up · <version>`.
 *
 * Probes still run, but only at a settle window (6s by default) — long
 * enough that systemd transients (`deactivating`, `activating`, crons
 * mid-re-register) self-heal before any row could surface. If after the
 * settle a probe is genuinely degraded or failed, the card edits to
 * append a row for THAT probe only. Healthy probes never produce rows.
 *
 * What's deleted (relative to pre-#142):
 *   - The always-rendered six-row checklist (Account/Agent/Gateway/
 *     Quota/Hindsight/Crons) — all replaced by the silent-when-healthy
 *     contract.
 *   - The skeleton "probing…" placeholder edit dance — the immediate
 *     post is now the final post for healthy boots.
 *   - The session-greeting card written by scaffold.ts (~750 lines of
 *     curl + heredoc bash that baked Profile/Tools/Skills/Limits/
 *     Channel/Memory at scaffold time and re-posted on every
 *     SessionStart). That content moves to the future `/status`
 *     command (PR 3).
 *
 * What's kept:
 *   - The probe layer in `boot-probes.ts` — same probe set, same shapes,
 *     same defensive-against-throw discipline.
 *   - `BotApiForBootCard` / `BootCardHandle` / dedupe gate
 *     (`shouldSkipDuplicateBootCard`) — public API stable for the
 *     gateway's two call sites (boot path + bridge-reconnect).
 *   - `BootCardHandle` / `complete()` (called from the first user-turn handler).
 */

import type { ProbeResult, GatewayRuntimeInfo } from './boot-probes.js'
import type { AccountSummary } from '../auth-dashboard.js'
import { formatAccountQuotaLine } from '../auth-dashboard.js'
import {
  probeAccount,
  probeAgentProcess,
  probeGateway,
  probeQuota,
  probeHindsight,
  probeCronTimers,
  watchAgentProcess,
  AGENT_LIVE_WINDOW_MS,
  AGENT_LIVE_POLL_INTERVAL_MS,
} from './boot-probes.js'
import { escapeHtml } from '../card-format.js'
import { join } from 'path'
import { loadConfig as _loadSwitchroomConfig } from '../../src/config/loader.js'

// ─── Persona name resolution ─────────────────────────────────────────────────

/**
 * Resolve the display name for an agent from its config's soul.name field.
 *
 * The slug (e.g. "finn") is an operator-facing identifier: agent directory,
 * systemd unit name, vault key prefix. It should never appear in
 * user-facing Telegram output. soul.name (e.g. "Finn") is the persona
 * the user knows through the bot username, topic emoji, and conversation.
 *
 * Falls back to the slug when:
 *   - soul is not set in the agent config
 *   - the agent key is not found in switchroom.yaml
 *   - the config cannot be loaded (gateway running outside a switchroom env)
 *
 * The optional `loadConfig` override exists purely for unit-test injection.
 * Production callers pass no second argument and get the live config.
 *
 * Closes #169.
 */
export function resolvePersonaName(
  slug: string,
  loadConfig?: () => { agents?: Record<string, { soul?: { name?: string } | null }> } | null,
): string {
  try {
    const config = loadConfig ? loadConfig() : _loadSwitchroomConfig()
    const name = config?.agents?.[slug]?.soul?.name
    return name && name.trim().length > 0 ? name : slug
  } catch {
    // Config unreadable (gateway running in a test env or outside a
    // switchroom workspace). Degrade gracefully to the slug.
    return slug
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type RestartReason = 'planned' | 'graceful' | 'crash' | 'fresh'

export type ProbeKey = 'account' | 'agent' | 'gateway' | 'quota' | 'hindsight' | 'crons'

export type ProbeMap = Partial<Record<ProbeKey, ProbeResult | null>>

export interface BotApiForBootCard {
  sendMessage(
    chatId: string,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown>
}

export interface BootCardHandle {
  messageId: number
  /** Call when the first user turn starts. */
  complete(): void
}

export type BootCardSite = 'boot' | 'bridge-reconnect'

export interface BootCardGate {
  /**
   * Set after the boot path successfully posts a card. The bridge-reconnect
   * path checks this to avoid posting a second card on the same gateway
   * lifetime — observed in the wild as klanker msgId 2245 + 2248 within 5s
   * (2026-04-26 11:19:47).
   */
  activeBootCard: { messageId: number } | null
  /**
   * True while a boot card emission is in-flight (sendMessage round-trip
   * not yet resolved). Closes the race window where bridge-reconnect ran
   * during the boot path's await and saw activeBootCard still null —
   * observed as klanker msgId 4715 + 4716 (2026-05-01 10:13:15, issue #489).
   * Optional for backward compatibility with callers that pre-date the flag.
   */
  bootCardPending?: boolean
}

export interface BootCardSkipDecision {
  skip: boolean
  /** Human-readable reason (only present when skip=true). */
  reason?: string
}

/**
 * Decide whether to skip posting the boot card based on gateway state.
 *
 * Two emit sites contend on every gateway lifetime:
 *
 *   - `boot`: the gateway IIFE startup path (long: probes session
 *     marker, clean-shutdown marker, restart marker, etc).
 *   - `bridge-reconnect`: fires when the agent's IPC client connects
 *     to the gateway socket.
 *
 * Earlier versions of this gate special-cased `boot` as "primary"
 * and let it post unconditionally. Empirically that assumption is
 * wrong: when the agent process boots faster than the gateway IIFE
 * reaches its emit, bridge-reconnect runs first, posts its card,
 * and then boot fires its own card too — both with reason=graceful
 * within ~100ms (observed in finn 2026-05-02: msgId 673 + 674
 * with both `posted` log lines on consecutive lines).
 *
 * The fix is first-write-wins: whichever site fires first claims
 * `bootCardPending` synchronously, posts the card, and releases.
 * The other site sees pending or active and defers. Both sites'
 * chat resolution is identical (same restart-marker / clean-shutdown
 * / session-marker pipeline), so it doesn't matter which one wins.
 */
export function shouldSkipDuplicateBootCard(
  gate: BootCardGate,
  site: BootCardSite,
): BootCardSkipDecision {
  if (gate.bootCardPending) {
    return { skip: true, reason: `in-flight-other-site site=${site}` }
  }
  if (gate.activeBootCard != null) {
    return {
      skip: true,
      reason: `already-posted-msgId=${gate.activeBootCard.messageId} site=${site}`,
    }
  }
  return { skip: false }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Settle window before probes run. Long enough that systemd transients
 * (`deactivating`/`activating`, dbus contention during reload, crons
 * mid-re-register) self-heal so a transient red can't reach the user.
 *
 * Constant by design — not a config field. The issue is explicit:
 * "Falls out of design, not a config knob." 6s is at the high end of the
 * 5–7s range called out in #142 for headroom under load.
 */
const SETTLE_WINDOW_MS = 6000

const DOT: Record<string, string> = {
  ok: '🟢',
  degraded: '🟡',
  fail: '🔴',
}

const PROBE_LABELS: Record<ProbeKey, string> = {
  account:   'Account',
  agent:     'Agent',
  gateway:   'Gateway',
  quota:     'Quota',
  hindsight: 'Hindsight',
  crons:     'Crons',
}

const PROBE_KEYS: ReadonlyArray<ProbeKey> = [
  'account', 'agent', 'gateway', 'quota', 'hindsight', 'crons',
]

const REASON_EMOJI: Record<RestartReason, string> = {
  planned:  '✅',
  graceful: '✅',
  crash:    '⚠️',
  fresh:    '🆕',
}

const REASON_LABEL: Record<RestartReason, string> = {
  planned:  'planned restart',
  graceful: 'graceful restart',
  crash:    'crash recovery',
  fresh:    'fresh start',
}

export interface RenderBootCardOpts {
  agentName: string
  /** Pre-formatted version string, e.g. "v0.3.0+44" or "v0.3.0 · #143 · 2h ago". */
  version: string
  /** Probe results (only present after the settle window). When absent or
   *  empty, the card is the bare ack line — no probe rows. */
  probes?: ProbeMap
  /** What kind of restart this is. Crash flips the ack emoji to ⚠️ AND
   *  appends a "Crash recovery" row underneath. Other reasons just set
   *  the emoji. */
  restartReason?: RestartReason
  /** Age of the restart marker in ms — shown in the crash row. */
  restartAgeMs?: number
  /**
   * Per-account quota snapshots to render below the probe rows.
   * One line per enabled account showing 5h % / 7d % and the
   * nearest reset countdown so users see headroom without running
   * `/auth` or `/usage` after every restart.
   *
   * Empty / undefined hides the section entirely — preserves the
   * silent-when-healthy contract for callers that don't pass account
   * data (tests, harnesses, gateways without the auth model).
   *
   * Closes #708.
   */
  accounts?: ReadonlyArray<AccountSummary>
  /** Clock injection point for tests; defaults to `new Date()`. */
  now?: Date
}

/**
 * Render the boot card. Single line by default; appends one row per
 * fail/degraded probe (and one for crash recovery, if applicable).
 *
 * Healthy probes never produce a row. The ack line is sufficient — the
 * user only needs to know the agent came back up. Anything red catches
 * the eye; everything else stays out of the way.
 */
export function renderBootCard(opts: RenderBootCardOpts): string {
  const { agentName, version, probes, restartReason, restartAgeMs } = opts
  const ackEmoji = restartReason ? REASON_EMOJI[restartReason] : '✅'
  const ack = `${ackEmoji} <b>${escapeHtml(agentName)}</b> back up · ${escapeHtml(version)}`

  const degradedRows: string[] = []

  // Crash recovery: surface explicitly so the user can tell whether
  // their next message will land on a fresh process. The agent-crashed
  // operator event from #92/#147 is a separate notification surface;
  // this row exists for users who only check the boot card.
  if (restartReason === 'crash') {
    const ageStr = restartAgeMs != null && restartAgeMs > 0
      ? ` · ${(restartAgeMs / 1000).toFixed(1)}s ago`
      : ''
    degradedRows.push(`⚠️ <b>Restart</b>  ${escapeHtml(REASON_LABEL.crash)}${ageStr}`)
  }

  // Probe rows — only those that surfaced as degraded/fail. Healthy
  // (`ok`) probes don't render at all.
  if (probes) {
    for (const key of PROBE_KEYS) {
      const r = probes[key]
      if (!r) continue
      if (r.status === 'ok') continue
      const dot = DOT[r.status] ?? DOT.fail
      degradedRows.push(`${dot} <b>${PROBE_LABELS[key]}</b>  ${escapeHtml(r.detail)}`)
    }
  }

  // Per-account quota section (issue #708) — one line per enabled
  // account showing 5h % / 7d % / nearest reset, with the active
  // account marked. Renders alongside the ack line so users see
  // headroom without running /auth or /usage.
  const accountRows = renderAccountRows(opts.accounts, opts.now ?? new Date())

  const sections: string[] = [ack]
  if (degradedRows.length > 0) sections.push('', ...degradedRows)
  if (accountRows.length > 0) sections.push('', ...accountRows)
  if (sections.length === 1) return ack
  return sections.join('\n')
}

/**
 * Render the per-account quota rows. Returns an empty array when no
 * accounts are passed — keeping the boot card's silent-when-healthy
 * default for callers that don't supply account data.
 *
 * Reuses the dashboard's `formatAccountQuotaLine` so the two surfaces
 * speak with one voice.
 */
export function renderAccountRows(
  accounts: ReadonlyArray<AccountSummary> | undefined,
  now: Date,
): string[] {
  if (!accounts || accounts.length === 0) return []
  const rows: string[] = []
  rows.push(`<b>Accounts (${accounts.length})</b>`)
  const nowMs = now.getTime()
  for (const a of accounts) {
    const marker = a.activeForThisAgent ? '▶' : '↳'
    const labelHtml = `<code>${escapeHtml(a.label)}</code>`
    // formatAccountQuotaLine returns HTML (with <i> tags) so we don't
    // re-escape — pass it through verbatim.
    const quotaLine = formatAccountQuotaLine(a, nowMs)
    rows.push(quotaLine ? `${marker} ${labelHtml}  ${quotaLine}` : `${marker} ${labelHtml}`)
  }
  return rows
}

// ─── Probe orchestration ─────────────────────────────────────────────────────

export interface RunProbesOpts {
  /** Persona display name — used only for rendering (ack line, probe rows). */
  agentName: string
  /** Lowercase systemd slug (e.g. "klanker") — used for systemctl unit targets.
   *  Must differ from agentName when the soul.name differs in case from the slug.
   *  Falls back to agentName when not provided (backwards-compat). */
  agentSlug?: string
  /** Pre-formatted version string passed through to the renderer. */
  version: string
  agentDir: string
  gatewayInfo: GatewayRuntimeInfo
  bankName?: string
  /** Why the gateway is starting — feeds the ack-line emoji and the
   *  optional crash-recovery row. */
  restartReason?: RestartReason
  /** Age of the restart marker in ms — shown in the crash row. */
  restartAgeMs?: number
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
  /** Override settle window for tests; production uses SETTLE_WINDOW_MS. */
  settleWindowMs?: number
  /** Override setTimeout for tests. */
  setTimeoutImpl?: typeof setTimeout
  /**
   * How long the live-agent-status loop keeps editing the card after the
   * initial probe run. Defaults to AGENT_LIVE_WINDOW_MS (45s). Set to 0
   * to disable the live loop entirely (e.g. in tests that only need the
   * one-shot settle-window behaviour).
   */
  agentLiveWindowMs?: number
  /** How often the live loop re-polls systemd. Defaults to
   *  AGENT_LIVE_POLL_INTERVAL_MS (2s). Override in tests for speed. */
  agentLivePollIntervalMs?: number
  /** Override for tests — replaces real execFile calls in the initial probe run
   *  (probeAgentProcess + probeCronTimers). Distinct from agentLiveExecFileImpl
   *  which covers the post-settle live-watch loop. */
  probeExecFileImpl?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  /** Override for tests — replaces real execFile calls in the live loop. */
  agentLiveExecFileImpl?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  /** Override for tests — replaces real delays in the live loop. */
  agentLiveSleepImpl?: (ms: number) => Promise<void>
  /**
   * Loader for the per-account rows that get appended below the probe
   * rows on the boot card (issue #708). Returns the account list
   * synchronously or via a Promise; an empty array / null disables
   * the section. Skipped on the immediate ack post — only consulted
   * during the post-settle re-render so the first paint stays fast.
   */
  loadAccounts?: () =>
    | ReadonlyArray<AccountSummary>
    | null
    | Promise<ReadonlyArray<AccountSummary> | null>
}

/** Run all six probes concurrently with their own per-probe timeouts.
 *  Used by both the production startBootCard flow and any caller that
 *  wants the probe set without the post/edit dance. */
export async function runAllProbes(opts: RunProbesOpts): Promise<ProbeMap> {
  const claudeDir = join(opts.agentDir, '.claude')
  const probes: ProbeMap = {}
  // Use the explicit slug for systemd unit targets; fall back to agentName for
  // callers that haven't been updated yet (backwards-compat).
  const slug = opts.agentSlug ?? opts.agentName

  await Promise.allSettled([
    probeAccount(opts.agentDir).then(r => { probes.account = r }),
    probeAgentProcess(slug, { execFileImpl: opts.probeExecFileImpl }).then(r => { probes.agent = r }),
    probeGateway(opts.gatewayInfo).then(r => { probes.gateway = r }),
    probeQuota(claudeDir, opts.agentDir, opts.fetchImpl).then(r => { probes.quota = r }),
    probeHindsight(opts.bankName, opts.fetchImpl).then(r => { probes.hindsight = r }),
    probeCronTimers(slug, { execFileImpl: opts.probeExecFileImpl }).then(r => { probes.crons = r }),
  ])

  return probes
}

/** Post the boot card, then run probes after a settle window and edit
 *  the card in-place if any probe came back degraded/failed. Healthy
 *  boots stay as the bare ack line forever.
 *
 *  Returns a handle. The probe edit
 *  is fire-and-forget — failures are swallowed so the ack line is never
 *  rolled back to a worse state. */
export async function startBootCard(
  chatId: string,
  threadId: number | undefined,
  bot: BotApiForBootCard,
  opts: RunProbesOpts,
  ackMessageId?: number,
  log?: (line: string) => void,
): Promise<BootCardHandle> {
  const logger = log ?? ((l: string) => process.stderr.write(l))
  const setTimeoutFn = opts.setTimeoutImpl ?? setTimeout
  const settleMs = opts.settleWindowMs ?? SETTLE_WINDOW_MS

  // Render and post the bare ack line immediately. The user gets
  // confirmation that the agent is back without waiting on probes.
  const ackText = renderBootCard({
    agentName: opts.agentName,
    version: opts.version,
    restartReason: opts.restartReason,
    restartAgeMs: opts.restartAgeMs,
  })

  let messageId: number
  try {
    const sent = await bot.sendMessage(chatId, ackText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(threadId != null ? { message_thread_id: threadId } : {}),
      ...(ackMessageId != null ? { reply_parameters: { message_id: ackMessageId } } : {}),
    })
    messageId = sent.message_id
    logger(`telegram gateway: boot-card: posted msgId=${messageId} chatId=${chatId} reason=${opts.restartReason ?? '-'}\n`)
  } catch (err: unknown) {
    logger(`telegram gateway: boot-card: failed to post ack: ${(err as Error)?.message ?? String(err)}\n`)
    return { messageId: -1, complete: () => {} }
  }

  // Determine the live window for agent-service status updates. Callers
  // can pass 0 to disable the live loop (e.g. in tests that only need
  // the one-shot settle-window behaviour). Defaults to AGENT_LIVE_WINDOW_MS.
  const liveWindowMs = opts.agentLiveWindowMs ?? AGENT_LIVE_WINDOW_MS

  // Schedule the post-settle probe run + live agent-status loop. Wrapped
  // in setTimeout so the boot path returns the handle immediately — the
  // gateway can continue setup without waiting on probes.
  setTimeoutFn(() => {
    void (async () => {
      try {
        // ── Phase 1: one-shot probe run after the settle window ───────────
        // Run all probes concurrently. If the agent probe comes back ok at
        // this point, no live loop is needed. If it's degraded/fail we
        // start the live watch (Phase 2) to keep updating the card.
        const probes = await runAllProbes(opts)

        // Per-account rows (issue #708). Loaded best-effort
        // alongside probes; failures are swallowed so the card still
        // renders correctly with no accounts section.
        let accountRows: ReadonlyArray<AccountSummary> | null = null
        if (opts.loadAccounts) {
          try {
            accountRows = await opts.loadAccounts()
          } catch (loadErr: unknown) {
            logger(
              `telegram gateway: boot-card: loadAccounts failed: ${
                (loadErr as Error)?.message ?? String(loadErr)
              }\n`,
            )
          }
        }

        // Render with current probe state and edit if anything changed.
        let currentText = renderBootCard({
          agentName: opts.agentName,
          version: opts.version,
          probes,
          restartReason: opts.restartReason,
          restartAgeMs: opts.restartAgeMs,
          ...(accountRows ? { accounts: accountRows } : {}),
        })

        if (currentText !== ackText) {
          try {
            await bot.editMessageText(chatId, messageId, currentText, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              ...(threadId != null ? { message_thread_id: threadId } : {}),
            })
            logger(`telegram gateway: boot-card: probes settled with degraded rows msgId=${messageId}\n`)
          } catch (editErr: unknown) {
            logger(`telegram gateway: boot-card: probe-edit error msgId=${messageId}: ${(editErr as Error)?.message ?? String(editErr)}\n`)
          }
        } else {
          logger(`telegram gateway: boot-card: probes settled all-green msgId=${messageId}\n`)
        }

        // ── Phase 2: live agent-status watch loop ─────────────────────────
        // If the agent probe is already ok, no need to keep watching.
        if (probes.agent?.status === 'ok' || liveWindowMs <= 0) {
          return
        }

        // Iterate watchAgentProcess — it yields on each meaningful state
        // change and exits when active, failed, or the window expires.
        // Use the slug for the systemd unit target, not the display name.
        const watcher = watchAgentProcess(opts.agentSlug ?? opts.agentName, {
          liveWindowMs,
          pollIntervalMs: opts.agentLivePollIntervalMs,
          sleepImpl: opts.agentLiveSleepImpl,
          execFileImpl: opts.agentLiveExecFileImpl,
        })

        for await (const agentResult of watcher) {
          // Merge the new agent result into the probes snapshot so all
          // probe rows are re-rendered consistently.
          const updatedProbes: ProbeMap = { ...probes, agent: agentResult }
          const updatedText = renderBootCard({
            agentName: opts.agentName,
            version: opts.version,
            probes: updatedProbes,
            restartReason: opts.restartReason,
            restartAgeMs: opts.restartAgeMs,
            ...(accountRows ? { accounts: accountRows } : {}),
          })

          if (updatedText === currentText) continue

          try {
            await bot.editMessageText(chatId, messageId, updatedText, {
              parse_mode: 'HTML',
              link_preview_options: { is_disabled: true },
              ...(threadId != null ? { message_thread_id: threadId } : {}),
            })
            logger(`telegram gateway: boot-card: live agent update msgId=${messageId} state=${agentResult.status} "${agentResult.detail}"\n`)
            currentText = updatedText
          } catch (editErr: unknown) {
            // Swallow edit errors — the card may have been deleted or the
            // user dismissed it. Don't let this crash the whole loop.
            logger(`telegram gateway: boot-card: live edit error msgId=${messageId}: ${(editErr as Error)?.message ?? String(editErr)}\n`)
          }

          // Once agent is active (ok), we're done — no more edits needed.
          if (agentResult.status === 'ok') break
        }
      } catch (err: unknown) {
        logger(`telegram gateway: boot-card: probe-edit error msgId=${messageId}: ${(err as Error)?.message ?? String(err)}\n`)
      }
    })()
  }, settleMs)

  let completed = false
  return {
    messageId,
    complete() {
      if (completed) return
      completed = true
      logger(`telegram gateway: boot-card: completed msgId=${messageId}\n`)
    },
  }
}
