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
 *   - The pin lifecycle: card gets pinned at post and unpinned by
 *     `complete()` (called from the first user-turn handler).
 */

import type { ProbeResult, GatewayRuntimeInfo } from './boot-probes.js'
import {
  probeAccount,
  probeAgentProcess,
  probeGateway,
  probeQuota,
  probeHindsight,
  probeCronTimers,
} from './boot-probes.js'
import { escapeHtml } from '../card-format.js'
import { join } from 'path'

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
  pinChatMessage(
    chatId: string,
    messageId: number,
    opts?: Record<string, unknown>,
  ): Promise<unknown>
  unpinChatMessage(chatId: string, messageId: number): Promise<unknown>
}

export interface BootCardHandle {
  messageId: number
  /** Call when the first user turn starts — unpins the card. */
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
}

export interface BootCardSkipDecision {
  skip: boolean
  /** Human-readable reason (only present when skip=true). */
  reason?: string
}

/**
 * Decide whether to skip posting the boot card based on gateway state.
 *
 * The boot path runs first (in the gateway IIFE) and sets activeBootCard
 * on success. The bridge-reconnect path runs later when the agent
 * registers; without this guard it posts a duplicate card.
 *
 * Boot path: never skip — it's the primary post site.
 * Bridge-reconnect: skip if a card was already posted this lifetime.
 */
export function shouldSkipDuplicateBootCard(
  gate: BootCardGate,
  site: BootCardSite,
): BootCardSkipDecision {
  if (site === 'boot') return { skip: false }
  if (gate.activeBootCard != null) {
    return {
      skip: true,
      reason: `already-posted-msgId=${gate.activeBootCard.messageId}`,
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

  if (degradedRows.length === 0) return ack
  return [ack, '', ...degradedRows].join('\n')
}

// ─── Probe orchestration ─────────────────────────────────────────────────────

export interface RunProbesOpts {
  agentName: string
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
}

/** Run all six probes concurrently with their own per-probe timeouts.
 *  Used by both the production startBootCard flow and any caller that
 *  wants the probe set without the post/edit dance. */
export async function runAllProbes(opts: RunProbesOpts): Promise<ProbeMap> {
  const claudeDir = join(opts.agentDir, '.claude')
  const probes: ProbeMap = {}

  await Promise.allSettled([
    probeAccount(opts.agentDir).then(r => { probes.account = r }),
    probeAgentProcess(opts.agentName).then(r => { probes.agent = r }),
    probeGateway(opts.gatewayInfo).then(r => { probes.gateway = r }),
    probeQuota(claudeDir, opts.agentDir, opts.fetchImpl).then(r => { probes.quota = r }),
    probeHindsight(opts.bankName, opts.fetchImpl).then(r => { probes.hindsight = r }),
    probeCronTimers(opts.agentName).then(r => { probes.crons = r }),
  ])

  return probes
}

/** Post the boot card, then run probes after a settle window and edit
 *  the card in-place if any probe came back degraded/failed. Healthy
 *  boots stay as the bare ack line forever.
 *
 *  Returns a handle whose `complete()` unpins the card. The probe edit
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

  // Pin the ack — fire-and-forget; pin failures aren't worth rolling
  // back the post for.
  bot.pinChatMessage(chatId, messageId, { disable_notification: true }).catch(() => {})

  // Schedule the post-settle probe run + edit. Wrapped in setTimeout so
  // the boot path returns the handle immediately — the gateway can
  // continue setup without waiting on probes.
  setTimeoutFn(() => {
    void (async () => {
      try {
        const probes = await runAllProbes(opts)
        const updatedText = renderBootCard({
          agentName: opts.agentName,
          version: opts.version,
          probes,
          restartReason: opts.restartReason,
          restartAgeMs: opts.restartAgeMs,
        })
        // Skip the edit when nothing degraded — saves the API call and
        // avoids Telegram's "message is not modified" error.
        if (updatedText === ackText) {
          logger(`telegram gateway: boot-card: probes settled all-green msgId=${messageId}\n`)
          return
        }
        await bot.editMessageText(chatId, messageId, updatedText, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(threadId != null ? { message_thread_id: threadId } : {}),
        })
        logger(`telegram gateway: boot-card: probes settled with degraded rows msgId=${messageId}\n`)
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
      bot.unpinChatMessage(chatId, messageId).catch(() => {})
      logger(`telegram gateway: boot-card: completed (unpinned) msgId=${messageId}\n`)
    },
  }
}
