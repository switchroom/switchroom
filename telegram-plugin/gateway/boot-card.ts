/**
 * Boot card — posts and live-updates a pinned Telegram message at gateway
 * startup showing real, evidential agent state.
 *
 * Flow:
 *   1. postInitialBootCard() sends the skeleton (all rows ⚪ "probing…").
 *   2. runProbesAndUpdateCard() runs all probes concurrently; edits the card
 *      as each probe settles. At 2.5s budget anything still pending → 🔴.
 *   3. A sentinel turn key "${chatId}:boot" is used in the pin manager so
 *      the boot card's lifecycle is independent from user-turn cards.
 *   4. The card is unpinned when the first user turn starts (caller
 *      responsibility — call completeBootCard() from the turn handler).
 *
 * Rendering uses plain Telegram HTML (no grammy helpers required).
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

const REASON_EMOJI: Record<RestartReason, string> = {
  planned:  '🔄',
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

function renderRestartRow(reason: RestartReason, ageMs?: number): string {
  const emoji = REASON_EMOJI[reason]
  const label = REASON_LABEL[reason]
  if (ageMs != null && ageMs > 0) {
    const ageSec = (ageMs / 1000).toFixed(1)
    return `${emoji} <b>Restart</b>  ${escapeHtml(label)} · ${ageSec}s ago`
  }
  return `${emoji} <b>Restart</b>  ${escapeHtml(label)}`
}

const DOT: Record<string, string> = {
  ok: '🟢',
  degraded: '🟡',
  fail: '🔴',
  probing: '⚪',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

const PROBE_LABELS: Record<ProbeKey, string> = {
  account: 'Account',
  agent:   'Agent  ',
  gateway: 'Gateway',
  quota:   'Quota  ',
  hindsight: 'Hindsight',
  crons:   'Crons  ',
}

function renderRow(key: ProbeKey, result: ProbeResult | null | undefined): string {
  if (result == null) {
    return `${DOT.probing} <b>${PROBE_LABELS[key]}</b>  <i>probing…</i>`
  }
  const dot = DOT[result.status] ?? DOT.fail
  return `${dot} <b>${PROBE_LABELS[key]}</b>  ${escapeHtml(result.detail)}`
}

export function renderBootCard(
  probes: ProbeMap,
  restartReason?: RestartReason,
  restartAgeMs?: number,
): string {
  const rows: string[] = [
    '🎛️ <b>Switchroom boot</b>',
    '',
  ]
  if (restartReason != null) {
    rows.push(renderRestartRow(restartReason, restartAgeMs))
    rows.push('')
  }
  rows.push(
    renderRow('account',   probes.account),
    renderRow('agent',     probes.agent),
    renderRow('gateway',   probes.gateway),
    renderRow('quota',     probes.quota),
    renderRow('hindsight', probes.hindsight),
    renderRow('crons',     probes.crons),
  )
  return rows.join('\n')
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

const BUDGET_MS = 2500

export interface RunProbesOpts {
  agentName: string
  agentDir: string
  gatewayInfo: GatewayRuntimeInfo
  bankName?: string
  /** Why the gateway is starting — shown as a top row in the card. */
  restartReason?: RestartReason
  /** Age of the restart in milliseconds (for "X.Xs ago" display). */
  restartAgeMs?: number
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch
}

export async function postInitialBootCard(
  chatId: string,
  threadId: number | undefined,
  bot: BotApiForBootCard,
  ackMessageId?: number,
  opts?: Pick<RunProbesOpts, 'restartReason' | 'restartAgeMs'>,
): Promise<number> {
  const text = renderBootCard({}, opts?.restartReason, opts?.restartAgeMs)
  const sent = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(ackMessageId != null ? { reply_parameters: { message_id: ackMessageId } } : {}),
  })
  // Pin it — fire and forget; failure is non-fatal
  bot.pinChatMessage(chatId, sent.message_id, { disable_notification: true }).catch(() => {})
  return sent.message_id
}

export async function runProbesAndUpdateCard(
  messageId: number,
  chatId: string,
  threadId: number | undefined,
  bot: BotApiForBootCard,
  opts: RunProbesOpts,
): Promise<ProbeMap> {
  const claudeDir = join(opts.agentDir, '.claude')
  const probes: ProbeMap = {}

  async function editCard(): Promise<void> {
    try {
      await bot.editMessageText(
        chatId,
        messageId,
        renderBootCard(probes, opts.restartReason, opts.restartAgeMs),
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(threadId != null ? { message_thread_id: threadId } : {}),
        },
      )
    } catch {
      // Edit failures are non-fatal; another edit will follow
    }
  }

  // Launch all probes in parallel; edit the card as each settles
  const start = Date.now()

  const allProbes: Array<Promise<void>> = [
    probeAccount(opts.agentDir).then(async r => {
      probes.account = r; await editCard()
    }),
    probeAgentProcess(opts.agentName).then(async r => {
      probes.agent = r; await editCard()
    }),
    probeGateway(opts.gatewayInfo).then(async r => {
      probes.gateway = r; await editCard()
    }),
    probeQuota(claudeDir, opts.agentDir, opts.fetchImpl).then(async r => {
      probes.quota = r; await editCard()
    }),
    probeHindsight(opts.bankName, opts.fetchImpl).then(async r => {
      probes.hindsight = r; await editCard()
    }),
    probeCronTimers(opts.agentName).then(async r => {
      probes.crons = r; await editCard()
    }),
  ]

  // Wait up to BUDGET_MS for all probes
  const budget = new Promise<void>((resolve) => setTimeout(resolve, BUDGET_MS))
  await Promise.race([Promise.allSettled(allProbes), budget])

  // Mark any still-null entries as timed-out
  const keys: ProbeKey[] = ['account', 'agent', 'gateway', 'quota', 'hindsight', 'crons']
  let anyTimedOut = false
  for (const key of keys) {
    if (probes[key] == null) {
      probes[key] = { status: 'fail', label: PROBE_LABELS[key].trim(), detail: 'no response' }
      anyTimedOut = true
    }
  }

  const elapsed = Date.now() - start
  process.stderr.write(`telegram gateway: boot-card: probes settled in ${elapsed}ms anyTimedOut=${anyTimedOut}\n`)

  // Final edit with settled state
  await editCard()
  return probes
}

/**
 * Posts and runs the full boot card lifecycle.
 * Returns a handle for completing (unpinning) the card later.
 */
export async function startBootCard(
  chatId: string,
  threadId: number | undefined,
  bot: BotApiForBootCard,
  opts: RunProbesOpts,
  ackMessageId?: number,
  log?: (line: string) => void,
): Promise<BootCardHandle> {
  const logger = log ?? ((l: string) => process.stderr.write(l))

  let messageId: number
  try {
    messageId = await postInitialBootCard(chatId, threadId, bot, ackMessageId, opts)
    logger(`telegram gateway: boot-card: posted msgId=${messageId} chatId=${chatId}\n`)
  } catch (err: unknown) {
    logger(`telegram gateway: boot-card: failed to post initial card: ${(err as Error)?.message ?? String(err)}\n`)
    return { messageId: -1, complete: () => {} }
  }

  // Run probes async — don't block the caller
  runProbesAndUpdateCard(messageId, chatId, threadId, bot, opts).catch((err: unknown) => {
    logger(`telegram gateway: boot-card: probe orchestration error: ${(err as Error)?.message ?? String(err)}\n`)
  })

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
