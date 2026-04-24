#!/usr/bin/env bun
/**
 * Foreman — always-on admin bot for the switchroom fleet.
 *
 * Unlike per-agent gateways, the foreman is not bound to a single agent.
 * It provides fleet-wide read-only and write visibility (Phase 3a + 3b).
 *
 * Configuration:
 *   ~/.switchroom/foreman/.env          TELEGRAM_BOT_TOKEN=<token>
 *   ~/.switchroom/foreman/access.json   { "allowFrom": ["<userId>"] }
 *
 * Phase 3a commands (read-only):
 *   /start, /help   — greeting + command list
 *   /status, /list  — fleet summary via `switchroom agent list --json`
 *   /logs <agent> [--tail N]  — journalctl output, paginated > 3 KB
 *   /auth [agent]   — fleet auth dashboard (per-agent, agent-name-parametric)
 *
 * Phase 3b commands (write):
 *   /restart <agent>        — systemctl --user restart switchroom-<agent>
 *   /delete <agent>         — 2-step confirm → archive dir + destroy unit
 *   /update                 — switchroom update (paginated output)
 *   /create-agent [name]    — multi-turn flow: profile → bot token → OAuth
 */

import { Bot, InlineKeyboard, type Context } from 'grammy'
import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { installPluginLogger } from '../plugin-logger.js'
import {
  escapeHtmlForTg,
  isAllowedSender,
  makeSwitchroomExec,
  makeSwitchroomExecCombined,
  makeSwitchroomExecJson,
  makeSwitchroomReply,
  runPollingLoop,
} from '../shared/bot-runtime.js'
import {
  assertSafeAgentName,
  buildFleetSummary,
  handleLogsCommand,
  handleRestartCommand,
  handleDeleteCommand,
  executeDeleteAgent,
  handleUpdateCommand,
} from './foreman-handlers.js'
import {
  buildDashboard,
  isQuotaHot,
  type DashboardState,
  type DashboardSlot,
  type SlotHealth,
} from '../auth-dashboard.js'
import { parseAuthSubCommand } from '../auth-slot-parser.js'
import {
  getState,
  setState,
  clearState,
  listActiveFlows,
} from './state.js'
import {
  startCreateFlow,
  handleFlowText,
  makeInitialState,
  advanceState,
  stepLabel,
} from './foreman-create-flow.js'
import { listAvailableProfiles } from '../../src/agents/profiles.js'
import { createAgent, completeCreation } from '../../src/agents/create-orchestrator.js'
import { validateBotToken } from '../../src/setup/telegram-api.js'

// ─── Stderr logging ───────────────────────────────────────────────────────
installPluginLogger()

// ─── Config dir ───────────────────────────────────────────────────────────
const FOREMAN_DIR = process.env.SWITCHROOM_FOREMAN_DIR
  ?? join(homedir(), '.switchroom', 'foreman')
const ENV_FILE = join(FOREMAN_DIR, '.env')
const ACCESS_FILE = join(FOREMAN_DIR, 'access.json')

// ─── Load .env ────────────────────────────────────────────────────────────
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch (err) {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code !== 'ENOENT') {
    process.stderr.write(
      `foreman: warning — failed to load ${ENV_FILE}: ${(err as Error).message}\n`,
    )
  }
}

// ─── Bot token ────────────────────────────────────────────────────────────
const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `foreman: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

// ─── Access list ──────────────────────────────────────────────────────────
function loadAllowFrom(): string[] {
  try {
    const raw = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as { allowFrom?: unknown }
    if (Array.isArray(raw.allowFrom)) {
      return (raw.allowFrom as unknown[]).map(String)
    }
  } catch {
    /* fall through — return empty */
  }
  return []
}

// ─── CLI exec helpers ─────────────────────────────────────────────────────
const switchroomExec = makeSwitchroomExec()
const switchroomExecCombined = makeSwitchroomExecCombined()
const switchroomExecJson = makeSwitchroomExecJson()

// ─── Bot ──────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN)

// No forum-topic routing in foreman — it's always a DM.
const switchroomReply = makeSwitchroomReply(() => undefined)

// ─── Auth guard middleware ────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  // Silently ignore any message that is not a private DM.
  // If the foreman bot is ever added to a group, this prevents fleet info
  // from leaking to all group members even when the sender is allowlisted.
  if (ctx.chat?.type !== 'private') return
  if (!ctx.from) return
  const allowFrom = loadAllowFrom()
  if (!isAllowedSender(ctx, allowFrom)) {
    process.stderr.write(`foreman: rejected message from user ${ctx.from.id}\n`)
    return
  }
  await next()
})

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Fetch auth dashboard state for a named agent. */
function fetchForemanDashboardState(agent: string): DashboardState | null {
  type SlotListing = {
    slots: Array<{
      slot: string; active: boolean; health: string;
      quota_exhausted_until?: number | null;
    }>
  }
  let slots: DashboardSlot[] = []
  try {
    const listing = switchroomExecJson<SlotListing>(['auth', 'list', agent, '--json'])
    if (listing && Array.isArray(listing.slots)) {
      slots = listing.slots.map(s => ({
        slot: s.slot,
        active: s.active,
        health: (s.health as SlotHealth) ?? 'missing',
        quotaExhaustedUntil: s.quota_exhausted_until ?? null,
        fiveHourPct: null,
        sevenDayPct: null,
      }))
    }
  } catch {
    return null
  }

  let plan: string | null = null
  let rateLimitTier: string | null = null
  try {
    type AuthStatusResp = {
      agents: Array<{ name: string; subscription_type: string | null; rate_limit_tier?: string | null }>
    }
    const statusData = switchroomExecJson<AuthStatusResp>(['auth', 'status'])
    const thisAgent = statusData?.agents?.find(a => a.name === agent)
    if (thisAgent?.subscription_type) plan = thisAgent.subscription_type
    if (thisAgent?.rate_limit_tier) rateLimitTier = thisAgent.rate_limit_tier
  } catch { /* best-effort */ }

  return {
    agent,
    bankId: agent,
    plan,
    rateLimitTier,
    slots,
    quotaHot: isQuotaHot(slots),
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
}

// ─── /start ──────────────────────────────────────────────────────────────
bot.command('start', async ctx => {
  await switchroomReply(ctx, [
    '<b>Foreman — switchroom fleet admin</b>',
    '',
    'Read-only commands:',
    '  /status, /list — fleet summary',
    '  /logs &lt;agent&gt; [--tail N] — last N log lines (default 50)',
    '  /auth [agent] — auth dashboard',
    '',
    'Write commands:',
    '  /restart &lt;agent&gt; — restart an agent',
    '  /delete &lt;agent&gt; — delete an agent (2-step confirm)',
    '  /update — update switchroom',
    '  /create-agent [name] — create a new agent (multi-turn)',
  ].join('\n'), { html: true })
})

// ─── /help ───────────────────────────────────────────────────────────────
bot.command('help', async ctx => {
  await switchroomReply(ctx, [
    '<b>Foreman commands</b>',
    '',
    '<b>Fleet info:</b>',
    '/status, /list — show fleet status',
    '/logs &lt;agent&gt; [--tail N] — show agent journal logs',
    '/auth [agent] — auth slot dashboard for an agent',
    '',
    '<b>Fleet management:</b>',
    '/restart &lt;agent&gt; — restart an agent via systemctl',
    '/delete &lt;agent&gt; — delete agent (confirms, then archives dir)',
    '/update — pull latest switchroom + reconcile agents',
    '/create-agent [name] — interactive new-agent wizard',
    '',
    '<b>Examples:</b>',
    '<code>/logs gymbro --tail 100</code>',
    '<code>/restart gymbro</code>',
    '<code>/create-agent gymbro</code>',
  ].join('\n'), { html: true })
})

// ─── /status + /list ──────────────────────────────────────────────────────
bot.command(['status', 'list'], async ctx => {
  const summary = buildFleetSummary(switchroomExecJson)
  await switchroomReply(ctx, summary, { html: true })
})

// ─── /logs ───────────────────────────────────────────────────────────────
bot.command('logs', async ctx => {
  const result = handleLogsCommand((ctx.match ?? '') as string)
  for (const reply of result.replies) {
    await switchroomReply(ctx, reply.text, { html: reply.html })
  }
})

// ─── /auth ────────────────────────────────────────────────────────────────
bot.command('auth', async ctx => {
  const rawArgs = ((ctx.match ?? '') as string).trim()

  // Determine which agents to show
  let agentNames: string[]

  if (rawArgs) {
    // User specified an agent name
    const parsed = parseAuthSubCommand(rawArgs)
    const agentArg = parsed.agent || rawArgs.split(/\s+/)[0]
    try { assertSafeAgentName(agentArg) } catch {
      await switchroomReply(ctx, 'Invalid agent name.', { html: true })
      return
    }
    agentNames = [agentArg]
  } else {
    // Enumerate all agents
    try {
      const data = switchroomExecJson<{ agents: Array<{ name: string }> }>(['agent', 'list'])
      agentNames = data?.agents?.map(a => a.name) ?? []
    } catch {
      agentNames = []
    }
    if (agentNames.length === 0) {
      await switchroomReply(ctx, '<i>No agents found. Try <code>/auth &lt;agentname&gt;</code>.</i>', { html: true })
      return
    }
  }

  // Render dashboard per agent
  for (const agent of agentNames) {
    const state = fetchForemanDashboardState(agent)
    if (!state) {
      await switchroomReply(ctx,
        `<b>/auth ${escapeHtmlForTg(agent)}</b> — no data (agent missing or CLI unreachable)`,
        { html: true },
      )
      continue
    }
    const { text, keyboard } = buildDashboard(state)
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } })
  }
})

// ─── /restart ─────────────────────────────────────────────────────────────
bot.command('restart', async ctx => {
  const result = handleRestartCommand((ctx.match ?? '') as string)
  await switchroomReply(ctx, result.text, { html: result.html })
})

// ─── /delete ──────────────────────────────────────────────────────────────

/**
 * In-memory map of chatId → pending delete agent name.
 * Cleared when the user confirms or the conversation moves on.
 * For lightweight 2-step confirm — no SQLite needed since this is ephemeral.
 */
const pendingDeletes = new Map<string, string>()

bot.command('delete', async ctx => {
  const result = handleDeleteCommand((ctx.match ?? '') as string)
  for (const reply of result.replies) {
    await switchroomReply(ctx, reply.text, { html: reply.html })
  }
  if (result.needsConfirm && result.agentForConfirm) {
    const chatId = String(ctx.chat!.id)
    pendingDeletes.set(chatId, result.agentForConfirm)
  }
})

// ─── /update ──────────────────────────────────────────────────────────────
bot.command('update', async ctx => {
  await switchroomReply(ctx, 'Running <code>switchroom update</code>…', { html: true })
  const result = handleUpdateCommand(switchroomExecCombined)
  for (const reply of result.replies) {
    await switchroomReply(ctx, reply.text, { html: reply.html })
  }
})

// ─── /create-agent ────────────────────────────────────────────────────────

bot.command('create_agent', async ctx => {
  await handleCreateAgentCommand(ctx, (ctx.match ?? '') as string)
})
// Also register with hyphen (Telegram normalises _ and - differently per client)
bot.command('create-agent', async ctx => {
  await handleCreateAgentCommand(ctx, (ctx.match ?? '') as string)
})

async function handleCreateAgentCommand(ctx: Context, match: string): Promise<void> {
  const chatId = String(ctx.chat!.id)
  const inlineName = match.trim().split(/\s+/)[0] || null

  let profiles: string[]
  try {
    profiles = listAvailableProfiles()
  } catch {
    await switchroomReply(ctx, 'Could not load profiles. Is switchroom installed correctly?', { html: false })
    return
  }

  const action = startCreateFlow(inlineName, profiles)

  if (action.kind === 'error') {
    await switchroomReply(ctx, action.message, { html: true })
    return
  }

  if (action.kind === 'ask-name') {
    const state = makeInitialState(chatId, null)
    setState(state)
    await switchroomReply(ctx, 'What should the new agent be named? (lowercase, hyphens/underscores OK)', { html: false })
    return
  }

  if (action.kind === 'ask-profile') {
    const state = makeInitialState(chatId, inlineName)
    setState(state)
    const kb = new InlineKeyboard()
    for (const p of profiles) {
      kb.text(p, `cf:profile:${p}`).row()
    }
    await ctx.reply(
      `Choose a profile for <b>${escapeHtmlForTg(inlineName!)}</b>:`,
      { parse_mode: 'HTML', reply_markup: kb },
    )
    return
  }
}

// ─── Create-agent: callback_query for profile selection ───────────────────

bot.on('callback_query:data', async ctx => {
  // Defense-in-depth: the global bot.use middleware already fires a
  // `ctx.chat?.type !== 'private'` check, but callback_query updates from
  // inline messages can arrive without a ctx.chat (callback_query.message
  // is populated but ctx.chat may be undefined in edge cases). The global
  // guard does `undefined !== 'private'` = true = ALLOW, so re-check here
  // explicitly. If this isn't a private chat, silently drop.
  if (ctx.chat?.type !== 'private') {
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const data = ctx.callbackQuery.data
  const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id)

  if (data.startsWith('cf:profile:')) {
    const profile = data.slice('cf:profile:'.length)
    await ctx.answerCallbackQuery()

    const state = getState(chatId)
    if (!state || (state.step !== 'asked-name' && state.step !== 'asked-profile')) {
      await ctx.reply('No active create-agent flow. Use /create-agent to start.')
      return
    }

    const profiles = listAvailableProfiles()
    if (!profiles.includes(profile)) {
      await ctx.reply('Unknown profile. Use /create-agent to restart.')
      return
    }

    const updated = advanceState(state, { step: 'asked-bot-token', profile })
    setState(updated)

    await ctx.reply(
      `Profile <b>${escapeHtmlForTg(profile)}</b> selected.\n\nPaste the BotFather token for the new agent's Telegram bot:\n<i>(Note: this token will be visible in this chat)</i>`,
      { parse_mode: 'HTML' },
    )
    return
  }

  // Unknown callback — ignore
  await ctx.answerCallbackQuery()
})

// ─── Inbound text router for multi-turn flows ─────────────────────────────

bot.on('message:text', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const chatId = String(ctx.chat.id)
  const text = ctx.message.text ?? ''

  // 1. Check for pending delete confirmation
  const pendingDelete = pendingDeletes.get(chatId)
  if (pendingDelete && text.trim().toUpperCase() === 'YES') {
    pendingDeletes.delete(chatId)
    const result = executeDeleteAgent(pendingDelete, switchroomExec)
    for (const reply of result.replies) {
      await switchroomReply(ctx, reply.text, { html: reply.html })
    }
    return
  }
  if (pendingDelete) {
    // Any non-YES text cancels the pending delete
    pendingDeletes.delete(chatId)
    await switchroomReply(ctx, 'Deletion cancelled.', { html: false })
    return
  }

  // 2. Check for active create-agent flow
  const flowState = getState(chatId)
  if (flowState && flowState.step !== 'done') {
    await handleCreateFlowText(ctx, chatId, text, flowState)
    return
  }

  // 3. Unknown text
  await switchroomReply(ctx, 'Unknown command. Try /help.', { html: true })
})

async function handleCreateFlowText(
  ctx: Context,
  chatId: string,
  text: string,
  flowState: NonNullable<ReturnType<typeof getState>>,
): Promise<void> {
  const profiles = listAvailableProfiles()
  const action = handleFlowText({ state: flowState, text, profiles })

  switch (action.kind) {
    case 'ask-name':
      await switchroomReply(ctx, 'What should the new agent be named?', { html: false })
      return

    case 'ask-profile': {
      // Update name in state if we just got it
      const updatedName = text.trim()
      const newState = advanceState(flowState, { step: 'asked-profile', name: updatedName })
      setState(newState)
      const kb = new InlineKeyboard()
      for (const p of profiles) {
        kb.text(p, `cf:profile:${p}`).row()
      }
      await ctx.reply(
        `Choose a profile for <b>${escapeHtmlForTg(updatedName)}</b>:`,
        { parse_mode: 'HTML', reply_markup: kb },
      )
      return
    }

    case 'ask-bot-token': {
      const newState = advanceState(flowState, { step: 'asked-bot-token', profile: action.profile })
      setState(newState)
      await switchroomReply(ctx, `Profile <b>${escapeHtmlForTg(action.profile)}</b> selected.\n\nPaste the BotFather token for <b>${escapeHtmlForTg(action.name)}</b>'s Telegram bot:\n<i>(Note: this token will be visible in this chat)</i>`, { html: true })
      return
    }

    case 'call-create-agent': {
      const { name, profile, botToken } = action
      // Validate token via Telegram API before scaffold
      await switchroomReply(ctx, 'Validating token…', { html: false })
      try {
        await validateBotToken(botToken)
      } catch (err) {
        await switchroomReply(ctx, `Token rejected by Telegram — ${(err as Error).message}. Try again:`, { html: false })
        return
      }

      await switchroomReply(ctx, `Token OK. Creating agent <b>${escapeHtmlForTg(name)}</b>…`, { html: true })
      try {
        const result = await createAgent({
          name,
          profile,
          telegramBotToken: botToken,
          // Clean up scaffold/systemd/yaml on mid-flow failure so the user
          // can retry /create-agent with the same name without conflicts.
          rollbackOnFail: true,
        })
        const newState = advanceState(flowState, {
          step: 'asked-oauth-code',
          name,
          profile,
          botToken,
          authSessionName: result.sessionName,
          loginUrl: result.loginUrl ?? null,
        })
        setState(newState)

        if (result.loginUrl) {
          const kb = new InlineKeyboard().url('Open OAuth URL', result.loginUrl)
          await ctx.reply(
            'Open this URL to log in, then paste the code back here:',
            { reply_markup: kb },
          )
        } else {
          await switchroomReply(ctx, 'Auth session started. Paste the OAuth code back here:', { html: false })
        }
      } catch (err) {
        await switchroomReply(ctx, `<b>createAgent failed:</b> ${escapeHtmlForTg((err as Error).message)}`, { html: true })
        clearState(chatId)
      }
      return
    }

    case 'call-complete-creation': {
      const { name, code } = action
      await switchroomReply(ctx, 'Submitting OAuth code…', { html: false })
      try {
        const result = await completeCreation(name, code)
        if (result.outcome.kind === 'success' && result.started) {
          clearState(chatId)
          await switchroomReply(ctx, `<b>${escapeHtmlForTg(name)}</b> is online! DM its bot to say hi.`, { html: true })
        } else if (result.outcome.kind === 'success') {
          clearState(chatId)
          await switchroomReply(ctx, `Auth succeeded but agent start failed. Try: <code>switchroom agent start ${escapeHtmlForTg(name)}</code>`, { html: true })
        } else {
          // Bad code — stay in asked-oauth-code step
          await switchroomReply(ctx, `Code rejected (${result.outcome.kind}). Paste the code again, or use /create-agent to restart:`, { html: false })
        }
      } catch (err) {
        await switchroomReply(ctx, `<b>completeCreation failed:</b> ${escapeHtmlForTg((err as Error).message)}`, { html: true })
        clearState(chatId)
      }
      return
    }

    case 'error': {
      await switchroomReply(ctx, action.message, { html: true })
      if (!action.stayInStep) {
        clearState(chatId)
      }
      return
    }

    case 'cancel':
    case 'done':
      // No active flow — fall through to unknown command
      await switchroomReply(ctx, 'Unknown command. Try /help.', { html: true })
      return
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────
process.on('unhandledRejection', err => {
  process.stderr.write(`foreman: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`foreman: uncaught exception: ${err}\n`)
})

void runPollingLoop(bot, {
  onReady: (username) => {
    process.stderr.write(`foreman: ready as @${username}\n`)
  },
  onOneTimeSetup: async (username) => {
    process.stderr.write(`foreman: one-time setup done @${username}\n`)
    // Register bot commands so they show in the Telegram UI
    try {
      await bot.api.setMyCommands([
        { command: 'start', description: 'Start / intro' },
        { command: 'help', description: 'Command list' },
        { command: 'status', description: 'Fleet status' },
        { command: 'list', description: 'Fleet status (alias)' },
        { command: 'logs', description: 'Agent logs: /logs <agent> [--tail N]' },
        { command: 'auth', description: 'Auth dashboard: /auth [agent]' },
        { command: 'restart', description: 'Restart agent: /restart <agent>' },
        { command: 'delete', description: 'Delete agent (with confirm): /delete <agent>' },
        { command: 'update', description: 'Update switchroom' },
        { command: 'create_agent', description: 'Create new agent: /create-agent [name]' },
      ])
    } catch (err) {
      process.stderr.write(`foreman: setMyCommands failed: ${err}\n`)
    }

    // Resume any in-progress create-agent flows that survived a restart
    try {
      const activeFlows = listActiveFlows(60 * 60 * 1000) // 1 hour
      for (const flow of activeFlows) {
        try {
          await bot.api.sendMessage(
            flow.chatId,
            `Picking up create-agent flow for <b>${escapeHtmlForTg(flow.name ?? '?')}</b> (${stepLabel(flow.step)})…\n\nType your response to continue, or /create-agent to restart.`,
            { parse_mode: 'HTML' },
          )
        } catch (err) {
          process.stderr.write(`foreman: failed to resume flow for chat ${flow.chatId}: ${err}\n`)
        }
      }
    } catch (err) {
      process.stderr.write(`foreman: failed to list active flows: ${err}\n`)
    }
  },
  on409: (attempt, delayMs) => {
    process.stderr.write(`foreman: 409 Conflict attempt=${attempt} retry_in_ms=${delayMs}\n`)
  },
})
