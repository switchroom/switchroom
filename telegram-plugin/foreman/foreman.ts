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
 *   /setup [slug]           — guided new-agent wizard (slug → persona → model → emoji → token → allowlist → start)
 */

import { Bot, InlineKeyboard, type Context } from 'grammy'
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { listWorktrees } from '../../src/worktree/list.js'
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
  handleVersionCommand,
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
import { resolveAgentsDir, loadConfig } from '../../src/config/loader.js'
import {
  getSetupState,
  setSetupState,
  clearSetupState,
  listActiveSetupFlows,
} from './setup-state.js'
import {
  startSetupFlow,
  handleSetupText,
  makeSetupInitialState,
  advanceSetupState,
  setupStepLabel,
} from './setup-flow.js'

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
    '  /version — show versions + running agent health',
    '',
    'Write commands:',
    '  /restart &lt;agent&gt; — restart an agent',
    '  /delete &lt;agent&gt; — delete an agent (2-step confirm)',
    '  /update — update switchroom',
    '  /setup [slug] — guided new-agent wizard',
    '  /create-agent [name] — create a new agent (legacy multi-turn)',
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
    '/setup [slug] — guided wizard: slug → persona → model → emoji → token → start',
    '/create-agent [name] — legacy interactive new-agent wizard',
    '',
    '<b>Examples:</b>',
    '<code>/logs gymbro --tail 100</code>',
    '<code>/restart gymbro</code>',
    '<code>/setup gymbro</code>',
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

// ─── /version ─────────────────────────────────────────────────────────────
bot.command('version', async ctx => {
  const result = handleVersionCommand(switchroomExecCombined)
  for (const reply of result.replies) {
    await switchroomReply(ctx, reply.text, { html: reply.html })
  }
})

// ─── /worktrees ───────────────────────────────────────────────────────────
bot.command('worktrees', async ctx => {
  try {
    const { worktrees } = listWorktrees()
    if (worktrees.length === 0) {
      await switchroomReply(ctx, 'No active worktrees.', { html: false })
      return
    }
    const lines = ['<b>Active worktrees</b>', '']
    for (const w of worktrees) {
      const ageMin = Math.floor(w.ageSeconds / 60)
      const hbMin = Math.floor(w.heartbeatAgeSeconds / 60)
      const owner = w.ownerAgent ? ` (${escapeHtmlForTg(w.ownerAgent)})` : ''
      lines.push(
        `• <code>${escapeHtmlForTg(w.repoName)}</code>${owner} — branch <code>${escapeHtmlForTg(w.branch)}</code>, age ${ageMin}m, hb ${hbMin}m`,
      )
    }
    await switchroomReply(ctx, lines.join('\n'), { html: true })
  } catch (err) {
    await switchroomReply(ctx, `<b>worktrees failed:</b> ${escapeHtmlForTg((err as Error).message)}`, { html: true })
  }
})

// ─── /setup ───────────────────────────────────────────────────────────────
//
// Guided wizard: slug → persona name → model → emoji → bot token → allowlist
// confirmation → reconcile (createAgent) + start.
//
// Deferral notes:
//   // TODO(#188): BotFather auto-flow — currently user creates bot manually
//   // TODO(#189): OAuth code paste step — currently shows manual terminal instruction
//   // TODO(#190): Skills selector — currently shows placeholder message

bot.command(['setup', 'createagent'], async ctx => {
  const chatId = String(ctx.chat!.id)
  const inlineSlug = ((ctx.match ?? '') as string).trim().split(/\s+/)[0] || null

  // If there's already an active setup flow, remind the user
  const existing = getSetupState(chatId)
  if (existing && existing.step !== 'done') {
    await switchroomReply(ctx, [
      `A setup wizard is already in progress for <b>${escapeHtmlForTg(existing.slug ?? '?')}</b> (${setupStepLabel(existing.step)}).`,
      '',
      'Continue by sending your answer, or type <code>cancel</code> to abort.',
    ].join('\n'), { html: true })
    return
  }

  const action = startSetupFlow(inlineSlug)

  if (action.kind === 'error') {
    await switchroomReply(ctx, action.message, { html: true })
    return
  }

  if (action.kind === 'ask-slug') {
    const state = makeSetupInitialState(chatId, null)
    setSetupState(state)
    await switchroomReply(ctx, [
      '<b>New agent wizard</b>',
      '',
      'Step 1/5: What slug (short name) should this agent use?',
      '<i>e.g. <code>gymbro</code> — lowercase, hyphens/underscores OK, max 51 chars</i>',
      '',
      'Type <code>cancel</code> at any time to abort.',
    ].join('\n'), { html: true })
    return
  }

  if (action.kind === 'ask-persona') {
    const state = makeSetupInitialState(chatId, inlineSlug)
    setSetupState(state)
    await switchroomReply(ctx, [
      `<b>New agent wizard</b> — slug: <code>${escapeHtmlForTg(inlineSlug!)}</code>`,
      '',
      'Step 2/5: What should this agent\'s persona name be?',
      '<i>e.g. <code>Gym Bro</code> — displayed in greetings and topics</i>',
    ].join('\n'), { html: true })
    return
  }
})

// ─── /cancel (setup wizard abort) ────────────────────────────────────────

bot.command('cancel', async ctx => {
  const chatId = String(ctx.chat!.id)
  const setupState = getSetupState(chatId)
  if (setupState && setupState.step !== 'done') {
    clearSetupState(chatId)
    await switchroomReply(ctx, 'Setup wizard cancelled. Type /setup to start a new one.', { html: false })
    return
  }
  // No active setup flow — check create-agent flow
  const createState = getState(chatId)
  if (createState && createState.step !== 'done') {
    clearState(chatId)
    await switchroomReply(ctx, 'Create-agent flow cancelled.', { html: false })
    return
  }
  await switchroomReply(ctx, 'No active wizard to cancel.', { html: false })
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
  // No pendingDelete on this chat. If the user's text is `YES` or `YES.`,
  // they probably typed it expecting to confirm a delete that was queued
  // before a foreman restart (pendingDeletes is in-memory; #28 item 7).
  // Pre-fix this fell through and eventually rendered "Unknown command",
  // which left the user wondering whether the delete went through. Surface
  // a clear "no pending delete" message instead.
  if (/^yes\.?$/i.test(text.trim())) {
    await switchroomReply(
      ctx,
      'There is no pending delete to confirm — the foreman may have restarted since you ran <code>/delete</code>. Re-run <code>/delete &lt;agent&gt;</code> if you still want to delete.',
      { html: true },
    )
    return
  }

  // 2. Check for active /setup wizard flow
  const setupState = getSetupState(chatId)
  if (setupState && setupState.step !== 'done') {
    await handleSetupFlowText(ctx, chatId, text, setupState)
    return
  }

  // 3. Check for active create-agent flow
  const flowState = getState(chatId)
  if (flowState && flowState.step !== 'done') {
    await handleCreateFlowText(ctx, chatId, text, flowState)
    return
  }

  // 4. Unknown text
  await switchroomReply(ctx, 'Unknown command. Try /help.', { html: true })
})

// ─── Setup wizard: text handler ───────────────────────────────────────────

async function handleSetupFlowText(
  ctx: Context,
  chatId: string,
  text: string,
  setupState: NonNullable<ReturnType<typeof getSetupState>>,
): Promise<void> {
  const callerId = String(ctx.from?.id ?? '')
  const action = handleSetupText({ state: setupState, text, callerId })

  switch (action.kind) {
    // ── Slug step ──────────────────────────────────────────────────────────
    case 'ask-persona': {
      const updated = advanceSetupState(setupState, { step: 'asked-persona', slug: action.slug })
      setSetupState(updated)
      await switchroomReply(ctx, [
        `Slug: <code>${escapeHtmlForTg(action.slug)}</code>`,
        '',
        'Step 2/5: What persona name should this agent have?',
        '<i>e.g. <code>Gym Bro</code> — displayed in greetings</i>',
      ].join('\n'), { html: true })
      return
    }

    // ── Persona step ───────────────────────────────────────────────────────
    case 'ask-model': {
      const updated = advanceSetupState(setupState, {
        step: 'asked-model',
        slug: action.slug,
        persona: action.persona,
      })
      setSetupState(updated)
      await switchroomReply(ctx, [
        `Persona: <b>${escapeHtmlForTg(action.persona)}</b>`,
        '',
        'Step 3/5: Which Claude model should this agent use?',
        'Options: <code>sonnet</code>, <code>opus</code>, <code>haiku</code>, or a full model ID.',
        'Type <code>skip</code> to use the profile default.',
      ].join('\n'), { html: true })
      return
    }

    // ── Model step ─────────────────────────────────────────────────────────
    case 'ask-emoji': {
      const updated = advanceSetupState(setupState, {
        step: 'asked-emoji',
        model: action.model,
      })
      setSetupState(updated)
      const modelNote = action.model
        ? `Model: <code>${escapeHtmlForTg(action.model)}</code>`
        : 'Model: <i>profile default</i>'
      await switchroomReply(ctx, [
        modelNote,
        '',
        'Step 4/5: What emoji should represent this agent\'s Telegram topic?',
        'Type <code>skip</code> to use the default.',
      ].join('\n'), { html: true })
      return
    }

    // ── Emoji step ─────────────────────────────────────────────────────────
    case 'ask-bot-token': {
      const updated = advanceSetupState(setupState, {
        step: 'asked-bot-token',
        emoji: action.emoji,
      })
      setSetupState(updated)
      const emojiNote = action.emoji
        ? `Emoji: ${action.emoji}`
        : 'Emoji: <i>default</i>'
      // TODO(#188): BotFather auto-flow — currently user creates bot manually
      await switchroomReply(ctx, [
        emojiNote,
        '',
        'Step 5/5: Paste the BotFather token for the new agent\'s bot.',
        '',
        '<b>To create a bot:</b>',
        '1. Open @BotFather in Telegram',
        '2. Send <code>/newbot</code> and follow the prompts',
        '3. Copy and paste the token here',
        '',
        '<i>Note: the token will be briefly visible in this chat.</i>',
      ].join('\n'), { html: true })
      return
    }

    // ── Bot-token step ─────────────────────────────────────────────────────
    case 'confirm-allowlist': {
      const botToken = text.trim()
      const updated = advanceSetupState(setupState, {
        step: 'confirming-allowlist',
        botToken,
      })
      setSetupState(updated)
      await switchroomReply(ctx, [
        'Token received.',
        '',
        `Your Telegram user ID is <code>${escapeHtmlForTg(action.callerId)}</code>.`,
        '',
        'Reply <b>yes</b> to set this as the only allowed user for the new agent,',
        'or paste a different user ID.',
      ].join('\n'), { html: true })
      return
    }

    // ── Allowlist confirmation step → provision agent ──────────────────────
    case 'call-reconcile': {
      const { slug, persona, model, emoji, botToken, allowedUserId } = action
      const updated = advanceSetupState(setupState, {
        step: 'reconciling',
        allowedUserId,
      })
      setSetupState(updated)

      await switchroomReply(ctx, `Validating token…`, { html: false })

      // Validate token first
      let botInfo: { username: string } | null = null
      try {
        botInfo = await validateBotToken(botToken)
      } catch (err) {
        const updatedBack = advanceSetupState(updated, { step: 'asked-bot-token' })
        setSetupState(updatedBack)
        await switchroomReply(ctx, [
          `Token rejected by Telegram — ${escapeHtmlForTg((err as Error).message)}`,
          '',
          'Please get a fresh token from @BotFather and paste it here:',
        ].join('\n'), { html: true })
        return
      }

      const botUsername = botInfo?.username ?? null
      await switchroomReply(ctx, `Token OK (@${escapeHtmlForTg(botUsername ?? '?')}). Provisioning agent <b>${escapeHtmlForTg(slug)}</b>…`, { html: true })

      // Use 'default' profile — skills/profile selection is deferred
      // TODO(#178): Skills selector — currently uses 'default' profile always
      const profile = 'default'

      // Build model override: if user picked a model, set it in persona config
      // after scaffolding. For now we pass it via a comment; the scaffold uses
      // profile defaults. Full model override is handled post-scaffold.
      // TODO(#189): OAuth code paste step — currently shows manual terminal instruction
      try {
        const result = await createAgent({
          name: slug,
          profile,
          telegramBotToken: botToken,
          rollbackOnFail: true,
        })

        // Mark flow done
        const doneState = advanceSetupState(updated, { step: 'done' })
        setSetupState(doneState)
        clearSetupState(chatId)

        const oauthLines = result.loginUrl
          ? [
              '',
              '<b>Complete OAuth:</b>',
              `<a href="${result.loginUrl}">Open this URL to log in</a>`,
              `Then run: <code>switchroom auth code ${escapeHtmlForTg(slug)}</code>`,
            ]
          : [
              '',
              // TODO(#189): OAuth code paste step — currently shows manual terminal instruction
              '<b>Complete OAuth from terminal:</b>',
              `<code>switchroom auth code ${escapeHtmlForTg(slug)}</code>`,
            ]

        // Skills can be added later
        // TODO(#190): Skills selector — currently shows placeholder message
        await switchroomReply(ctx, [
          `<b>${escapeHtmlForTg(persona)}</b> (@${escapeHtmlForTg(botUsername ?? slug)}) is scaffolded!`,
          ...oauthLines,
          '',
          '<i>Skills can be added later via yaml or future /skills command.</i>',
        ].join('\n'), { html: true })
      } catch (err) {
        // Rollback happened inside createAgent — reset to bot-token step
        const updatedBack = advanceSetupState(updated, { step: 'asked-bot-token' })
        setSetupState(updatedBack)
        await switchroomReply(ctx, [
          `<b>Provisioning failed:</b> ${escapeHtmlForTg((err as Error).message)}`,
          '',
          'To retry, paste a bot token again. Or type <code>cancel</code> to abort.',
        ].join('\n'), { html: true })
      }
      return
    }

    // ── Error (validation failure, stayInStep re-prompt) ──────────────────
    case 'error': {
      if (!action.stayInStep) {
        clearSetupState(chatId)
      }
      await switchroomReply(ctx, action.message, { html: true })
      return
    }

    // ── Cancel ─────────────────────────────────────────────────────────────
    case 'cancel': {
      clearSetupState(chatId)
      if (action.reason === 'user-cancelled') {
        await switchroomReply(ctx, 'Setup wizard cancelled. Type /setup to start over.', { html: false })
      } else {
        await switchroomReply(ctx, `Setup wizard stopped (${action.reason}). Type /setup to start over.`, { html: false })
      }
      return
    }

    // ── Done (shouldn't reach here via text) ──────────────────────────────
    case 'done': {
      clearSetupState(chatId)
      await switchroomReply(ctx, 'Setup already complete. Type /setup to create another agent.', { html: false })
      return
    }
  }
}

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
      // Pre-#28 fix this called validateBotToken here AND createAgent
      // (via validateBotTokenMatchesAgent at create-orchestrator.ts:150)
      // would call it again — two sequential Telegram getMe() requests in
      // the happy path. We now trust the orchestrator's check and surface
      // its error if it fails. The /setup flow at line 723 keeps its own
      // pre-check because it uses the returned botInfo.username for UX.
      await switchroomReply(ctx, `Creating agent <b>${escapeHtmlForTg(name)}</b>…`, { html: true })
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
        { command: 'version', description: 'Show versions + running agent health' },
        { command: 'worktrees', description: 'List active git worktrees claimed by sub-agents' },
        { command: 'create_agent', description: 'Create new agent: /create-agent [name]' },
        { command: 'setup', description: 'New agent wizard: /setup [slug]' },
        { command: 'cancel', description: 'Cancel active wizard' },
      ])
    } catch (err) {
      process.stderr.write(`foreman: setMyCommands failed: ${err}\n`)
    }

    // Resume any in-progress setup wizard flows that survived a restart
    try {
      const activeSetupFlows = listActiveSetupFlows(60 * 60 * 1000) // 1 hour
      for (const flow of activeSetupFlows) {
        try {
          await bot.api.sendMessage(
            flow.chatId,
            `Picking up /setup wizard for <b>${escapeHtmlForTg(flow.slug ?? '?')}</b> (${setupStepLabel(flow.step)})…\n\nType your response to continue, or /cancel to abort.`,
            { parse_mode: 'HTML' },
          )
        } catch (err) {
          process.stderr.write(`foreman: failed to resume setup flow for chat ${flow.chatId}: ${err}\n`)
        }
      }
    } catch (err) {
      process.stderr.write(`foreman: failed to list active setup flows: ${err}\n`)
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
