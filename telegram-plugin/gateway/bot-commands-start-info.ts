/**
 * Basic info slash commands extracted verbatim from gateway.ts
 * (switchroom#2996 P6 bot.command drain): `/start`, `/help`, `/status`,
 * `/agents`.
 *
 * Pure read-only info surfaces (welcome/help text, pairing status, agent
 * list) with no send-path or turn-lifecycle coupling. Every gateway-local
 * helper they close over is passed in via `deps` (repo factory-deps
 * precedent, same shape as registerOpsInfoCommands) so the module never
 * back-references the gateway singleton. `bot` is injected so grammy
 * registration order is preserved at the original call site.
 */

import type { Bot, Context } from 'grammy'
import { richMessage } from '../rich-send.js'
import {
  startText as buildStartText,
  helpText as buildHelpText,
  statusPairedText as buildStatusPairedText,
  statusPendingText as buildStatusPendingText,
  statusUnpairedText as buildStatusUnpairedText,
  type AgentMetadata,
} from '../welcome-text.js'
import { escapeHtmlForTg } from '../shared/bot-runtime.js'
import type { Access } from './gateway.js'

export interface StartInfoCommandDeps {
  /** #894 backport gate: silent drop on disabled / non-allowlisted senders. */
  dmCommandGate: (ctx: Context) => { access: Access; senderId: string } | null
  isAuthorizedSender: (ctx: Context) => boolean
  getMyAgentName: () => string
  getCommandArgs: (ctx: Context) => string
  hasDemoFlag: (args: string) => boolean
  buildAgentMetadata: (agentName: string) => Promise<AgentMetadata>
  runSwitchroomCommandFormatted: (
    ctx: Context,
    args: string[],
    label: string,
    formatter: () => string | null,
  ) => Promise<void>
  switchroomExecJson: <T = unknown>(args: string[]) => T | null
  statusIcon: (status: string) => string
}

export function registerStartInfoCommands(bot: Bot, deps: StartInfoCommandDeps): void {
  const {
    dmCommandGate,
    isAuthorizedSender,
    getMyAgentName,
    getCommandArgs,
    hasDemoFlag,
    buildAgentMetadata,
    runSwitchroomCommandFormatted,
    switchroomExecJson,
    statusIcon,
  } = deps

  bot.command('start', async ctx => {
    // dmCommandGate (#894 backport): silent drop on disabled or
    // non-allowlisted senders so the bot doesn't leak its existence.
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const disabled = gated.access.dmPolicy === 'disabled'
    await ctx.replyWithRichMessage(richMessage(buildStartText(getMyAgentName(), disabled)))
  })
  bot.command('help', async ctx => {
    if (!dmCommandGate(ctx)) return
    await ctx.replyWithRichMessage(richMessage(buildHelpText(getMyAgentName())))
  })
  bot.command('status', async ctx => {
    // dmCommandGate (#894 backport) drops disabled / non-allowlisted in
    // allowlist mode. Pairing-mode users still fall through to either
    // the pending-code branch or the unpaired branch.
    const gated = dmCommandGate(ctx)
    if (!gated) return
    const { access, senderId } = gated
    const from = ctx.from!
    if (access.allowFrom.includes(senderId)) {
      const demo = hasDemoFlag(getCommandArgs(ctx))
      const userTag = from.username ? `@${from.username}` : senderId
      const meta = await buildAgentMetadata(getMyAgentName())
      await ctx.replyWithRichMessage(richMessage(buildStatusPairedText({ user: userTag, meta, demo })))
      return
    }
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        await ctx.replyWithRichMessage(richMessage(buildStatusPendingText(code)))
        return
      }
    }
    await ctx.reply(buildStatusUnpairedText())
  })
  bot.command('agents', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    await runSwitchroomCommandFormatted(ctx, ['agent', 'list'], 'agent list', () => {
      type AgentListResp = { agents: Array<{ name: string; status: string; uptime: string; template: string; topic_name: string; topic_emoji?: string }> }
      const data = switchroomExecJson<AgentListResp>(['agent', 'list'])
      if (!data) return null
      if (data.agents.length === 0) return '_No agents defined_'
      const lines = ['**Agents**']
      for (const a of data.agents) {
        lines.push(`${statusIcon(a.status)} **${escapeHtmlForTg(a.name)}** · ${escapeHtmlForTg(a.status)} · ${escapeHtmlForTg(a.uptime)}`)
        lines.push(`    _${escapeHtmlForTg(a.template)} → ${escapeHtmlForTg(a.topic_name)}${a.topic_emoji ? ' ' + a.topic_emoji : ''}_`)
      }
      return lines.join('\n')
    })
  })
}
