/**
 * `/model` and `/effort` slash commands extracted verbatim from gateway.ts
 * (switchroom#2996 P6 bot.command drain).
 *
 * Pure-logic helpers (parse/plan/menu/handle from model-command.ts,
 * effort-command.ts, pending-session-command.ts) are imported directly;
 * every gateway-local surface (busy resolver, deps factories, reply/queue
 * plumbing, history recording) is injected via `deps` (repo factory-deps
 * precedent, same shape as registerOpsInfoCommands). `bot` is injected so
 * grammy registration order is preserved at the original call site.
 */

import type { Bot, Context, InlineKeyboard } from 'grammy'
import { richMessage } from '../rich-send.js'
import { hardenCardBreaks } from '../format.js'
import { escapeHtmlForTg } from '../shared/bot-runtime.js'
import {
  parseModelCommand,
  planModelCommand,
  buildModelMenu,
  handleModelCommand,
  modelCommandReceiptLine,
  type ModelMenuDeps,
  type ModelCommandDeps,
  type ModelMenuReply,
  type ParsedModelCommand,
} from './model-command.js'
import {
  parseEffortCommand,
  handleEffortCommand,
  buildEffortMenu,
  type EffortCommandDeps,
  type EffortMenuReply,
} from './effort-command.js'
import {
  ackText as pendingCmdAckText,
  type PendingSessionCommand,
} from './pending-session-command.js'

export interface ModelEffortCommandDeps {
  isAuthorizedSender: (ctx: Context) => boolean
  getMyAgentName: () => string
  resolveThreadId: (chat_id: string, explicit?: string | number | null) => number | undefined
  /** Stale-aware busy resolver (#3262) shared by /model and /effort. */
  resolveModelEffortBusy: () => { currentTurnActive: boolean; turnInFlight: boolean }
  historyEnabled: boolean
  recordInbound: (args: {
    chat_id: string
    thread_id: number | null
    message_id: number
    user: string | null
    user_id: string | null
    ts: number
    text: string
  }) => void
  buildModelDeps: (restartCtx?: { chatId: string; threadId: number | undefined }) => ModelMenuDeps & ModelCommandDeps
  buildEffortDeps: () => EffortCommandDeps
  modelMenuReplyMarkup: (reply: ModelMenuReply) => InlineKeyboard | undefined
  effortMenuReplyMarkup: (reply: EffortMenuReply) => InlineKeyboard | undefined
  enqueueSessionCommand: (cmd: PendingSessionCommand) => void
  switchroomReply: (
    ctx: Context,
    text: string,
    options?: { html?: boolean; reply_markup?: InlineKeyboard },
  ) => Promise<void>
  modelMenuEnabled: () => boolean
  /** stderr log sink. */
  log: (line: string) => void
}

export function registerModelEffortCommands(bot: Bot, deps: ModelEffortCommandDeps): void {
  const {
    isAuthorizedSender,
    getMyAgentName,
    resolveThreadId,
    resolveModelEffortBusy,
    historyEnabled,
    recordInbound,
    buildModelDeps,
    buildEffortDeps,
    modelMenuReplyMarkup,
    effortMenuReplyMarkup,
    enqueueSessionCommand,
    switchroomReply,
    modelMenuEnabled,
    log,
  } = deps

  bot.command('model', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    const text = ctx.message?.text ?? ctx.channelPost?.text ?? ''
    const parsed: ParsedModelCommand = parseModelCommand(text) ?? { kind: 'show' as const }
    const chatId = String(ctx.chat!.id)
    const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
    // #3177 — durable receipt FIRST. A typed /model must NEVER be invisible: even
    // if every downstream reply is shed/dropped, or the session is in a
    // phantom-idle window (turn atom cleared while claude is still busy), the
    // command leaves a greppable log line + a history row before any branch. This
    // is the fix for the finn 2026-07-12 zero-trace swallow (no log, no reply, no
    // ack, no deferred apply). `busyNow` folds BOTH busy signals (turn atom AND
    // the authoritative delivery-machine/approval gate) — but a STALE atom or a
    // wedged approval older than the hard TTL is discounted as idle (#3262), so a
    // phantom "active turn" on an idle session no longer blocks the switch. Resolve
    // once (it may clear a dangling atom) and reuse for both the receipt log and
    // the routing disposition.
    const modelBusy = resolveModelEffortBusy()
    const busyNow = modelBusy.currentTurnActive || modelBusy.turnInFlight
    log(modelCommandReceiptLine(getMyAgentName(), parsed, busyNow) + '\n')
    if (historyEnabled && ctx.message?.message_id != null) {
      try {
        recordInbound({
          chat_id: chatId,
          thread_id: threadId ?? null,
          message_id: ctx.message.message_id,
          user: ctx.from?.username ?? (ctx.from?.id != null ? String(ctx.from.id) : null),
          user_id: ctx.from?.id != null ? String(ctx.from.id) : null,
          ts: ctx.message.date ?? Math.floor(Date.now() / 1000),
          text,
        })
      } catch (err) {
        log(`telegram gateway: /model recordInbound failed: ${(err as Error)?.message ?? String(err)}\n`)
      }
    }
    const cmdDeps = buildModelDeps({ chatId, threadId })
    // Route on a pure disposition (#3177) that folds BOTH busy signals so a
    // session busy by EITHER measure ack+queues instead of silently injecting
    // into a busy pane. Every branch below produces a visible action.
    const disposition = planModelCommand(parsed, {
      currentTurnActive: modelBusy.currentTurnActive,
      turnInFlight: modelBusy.turnInFlight,
      menuEnabled: modelMenuEnabled(),
    })
    if (disposition.kind === 'menu') {
      const menu = await buildModelMenu(cmdDeps)
      await switchroomReply(ctx, menu.text, { html: true, reply_markup: modelMenuReplyMarkup(menu) })
      return
    }
    // Mid-turn (by either busy signal): instead of dead-ending ("Try again in a
    // moment") or silently injecting into a busy pane, ACK + QUEUE + apply-on-idle
    // + confirm (#3017/#3177). The typed set path either injects into claude's
    // input box or triggers a carrier restart — both unsafe while busy.
    if (disposition.kind === 'queue') {
      const target = disposition.target
      const sent = await ctx.replyWithRichMessage(
        richMessage(hardenCardBreaks(pendingCmdAckText('model', target, escapeHtmlForTg))),
        threadId != null ? { message_thread_id: threadId } : {},
      )
      enqueueSessionCommand({
        kind: 'model',
        origin: 'typed',
        arg: target,
        targetLabel: target,
        chatId,
        threadId,
        ackChatId: chatId,
        ackMessageId: (sent as { message_id: number }).message_id,
        requestedAt: Date.now(),
      })
      return
    }
    // Rev 5: the handler relaunches through the carrier and owns every side effect
    // (override write, carrier, premium-recovery clear). There is no post-hoc
    // recording — /status is reconciled at boot from `.active-session-model`, so
    // an unapplied switch can never be optimistically recorded here.
    const reply = await handleModelCommand(parsed, cmdDeps)
    await switchroomReply(ctx, reply.text, { html: reply.html })
  })
  bot.command('effort', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    const text = ctx.message?.text ?? ctx.channelPost?.text ?? ''
    const parsed = parseEffortCommand(text) ?? { kind: 'show' as const }
    const cmdDeps = buildEffortDeps()
    if (parsed.kind === 'show') {
      const menu = buildEffortMenu(cmdDeps)
      await switchroomReply(ctx, menu.text, { html: true, reply_markup: effortMenuReplyMarkup(menu) })
      return
    }
    // Mid-turn: ACK + QUEUE + apply-on-idle + confirm (#3017) — parity with
    // /model. `applyEffort` mid-turn silently maybe-failed ("couldn't confirm it
    // applied") before this gate existed. Use the SAME stale-aware busy resolver
    // as /model (#3262) so a dangling turn atom older than the hard TTL is
    // discounted as idle and the switch applies instead of queuing forever on an
    // idle session.
    const effortBusy = resolveModelEffortBusy()
    if ((parsed.kind === 'set' || parsed.kind === 'default') && effortBusy.currentTurnActive) {
      const requestedLevel = parsed.kind === 'set' ? parsed.level : 'default'
      const chatId = String(ctx.chat!.id)
      const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
      const sent = await ctx.replyWithRichMessage(
        richMessage(hardenCardBreaks(pendingCmdAckText('effort', requestedLevel, escapeHtmlForTg))),
        threadId != null ? { message_thread_id: threadId } : {},
      )
      enqueueSessionCommand({
        kind: 'effort',
        origin: 'typed',
        arg: requestedLevel,
        targetLabel: requestedLevel,
        chatId,
        threadId,
        ackChatId: chatId,
        ackMessageId: (sent as { message_id: number }).message_id,
        requestedAt: Date.now(),
      })
      return
    }
    const reply = await handleEffortCommand(parsed, cmdDeps)
    await switchroomReply(ctx, reply.text, { html: reply.html })
  })
}
