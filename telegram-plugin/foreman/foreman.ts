#!/usr/bin/env bun
/**
 * Foreman — always-on admin bot for the switchroom fleet.
 *
 * Unlike per-agent gateways, the foreman is not bound to a single agent.
 * It provides fleet-wide read-only visibility (Phase 3a) with write ops
 * coming in Phase 3b.
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
 */

import { Bot } from 'grammy'
import { readFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

import { installPluginLogger } from '../plugin-logger.js'
import {
  escapeHtmlForTg,
  preBlock,
  stripAnsi,
  formatSwitchroomOutput,
  isAllowedSender,
  makeSwitchroomExec,
  makeSwitchroomExecJson,
  makeSwitchroomReply,
  runPollingLoop,
} from '../shared/bot-runtime.js'
import {
  buildDashboard,
  isQuotaHot,
  type DashboardState,
  type DashboardSlot,
  type SlotHealth,
} from '../auth-dashboard.js'
import { parseAuthSubCommand } from '../auth-slot-parser.js'

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
const switchroomExecJson = makeSwitchroomExecJson()

// ─── Bot ──────────────────────────────────────────────────────────────────
const bot = new Bot(TOKEN)

// No forum-topic routing in foreman — it's always a DM.
const switchroomReply = makeSwitchroomReply(() => undefined)

// ─── Auth guard middleware ────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (!ctx.from) return
  const allowFrom = loadAllowFrom()
  if (!isAllowedSender(ctx, allowFrom)) {
    process.stderr.write(`foreman: rejected message from user ${ctx.from.id}\n`)
    return
  }
  await next()
})

// ─── Helpers ─────────────────────────────────────────────────────────────

function assertSafeAgentName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`invalid agent name: ${name}`)
  }
}

function statusIcon(status: string): string {
  if (status === 'active' || status === 'running') return '🟢'
  if (status === 'inactive' || status === 'stopped' || status === 'dead') return '🔴'
  if (status === 'failed') return '⚠️'
  return '⚪'
}

/** Chunk text into Telegram-safe parts (max 4096 chars per message). */
function chunkText(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let pos = 0
  while (pos < text.length) {
    chunks.push(text.slice(pos, pos + maxLen))
    pos += maxLen
  }
  return chunks
}

/** Fetch fleet summary as formatted HTML. */
type AgentListEntry = {
  name: string; status: string; uptime: string;
  template?: string | null; topic_name?: string | null;
}

function buildFleetSummary(): string {
  try {
    const data = switchroomExecJson<{ agents: AgentListEntry[] }>(['agent', 'list'])
    if (!data || data.agents.length === 0) return '<i>No agents defined</i>'
    const lines = ['<b>Fleet status</b>']
    for (const a of data.agents) {
      lines.push(
        `${statusIcon(a.status)} <b>${escapeHtmlForTg(a.name)}</b> · ${escapeHtmlForTg(a.status)} · ${escapeHtmlForTg(a.uptime)}`,
      )
      if (a.template || a.topic_name) {
        const meta = [a.template, a.topic_name].filter(Boolean).map(s => escapeHtmlForTg(s!)).join(' → ')
        lines.push(`  <i>${meta}</i>`)
      }
    }
    return lines.join('\n')
  } catch (err) {
    return `<b>agent list failed:</b>\n${preBlock(formatSwitchroomOutput((err as Error).message))}`
  }
}

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
    'Read-only fleet commands:',
    '  /status — fleet summary',
    '  /list — same as /status',
    '  /logs &lt;agent&gt; [--tail N] — last N log lines (default 50)',
    '  /auth [agent] — auth dashboard for agent',
    '',
    '<i>Write commands (create, restart, delete) coming in Phase 3b.</i>',
  ].join('\n'), { html: true })
})

// ─── /help ───────────────────────────────────────────────────────────────
bot.command('help', async ctx => {
  await switchroomReply(ctx, [
    '<b>Foreman commands</b>',
    '',
    '/status, /list — show fleet status',
    '/logs &lt;agent&gt; [--tail N] — show agent journal logs',
    '/auth [agent] — auth slot dashboard for an agent',
    '',
    '<b>Examples:</b>',
    '<code>/logs gymbro --tail 100</code>',
    '<code>/auth gymbro</code>',
  ].join('\n'), { html: true })
})

// ─── /status + /list ──────────────────────────────────────────────────────
bot.command(['status', 'list'], async ctx => {
  const summary = buildFleetSummary()
  await switchroomReply(ctx, summary, { html: true })
})

// ─── /logs ───────────────────────────────────────────────────────────────
const LOG_PAGE_BYTES = 3 * 1024 // 3 KB — paginate above this

bot.command('logs', async ctx => {
  const raw = (ctx.match ?? '').trim()
  const args = raw.split(/\s+/).filter(Boolean)

  if (args.length === 0) {
    await switchroomReply(ctx, 'Usage: /logs &lt;agent&gt; [--tail N]', { html: true })
    return
  }

  const agentName = args[0]
  try { assertSafeAgentName(agentName) } catch {
    await switchroomReply(ctx, 'Invalid agent name.', { html: true })
    return
  }

  // Parse --tail N
  let tailN = 50
  const tailIdx = args.indexOf('--tail')
  if (tailIdx !== -1 && args[tailIdx + 1]) {
    const parsed = parseInt(args[tailIdx + 1], 10)
    if (!isNaN(parsed) && parsed > 0) tailN = Math.min(parsed, 500)
  }

  let output: string
  try {
    output = stripAnsi(execSync(
      `journalctl --user -u "switchroom-${agentName}" -n ${tailN} --no-pager --output=short-monotonic 2>&1`,
      {
        encoding: 'utf-8',
        timeout: 10000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      },
    ))
  } catch (err) {
    const msg = (err as { stdout?: string; stderr?: string; message?: string })
    const detail = msg.stdout || msg.stderr || msg.message || 'unknown error'
    await switchroomReply(ctx,
      `<b>logs failed for ${escapeHtmlForTg(agentName)}:</b>\n${preBlock(formatSwitchroomOutput(stripAnsi(detail)))}`,
      { html: true },
    )
    return
  }

  const trimmed = output.trim()
  if (!trimmed) {
    await switchroomReply(ctx, `No logs found for <code>${escapeHtmlForTg(agentName)}</code>.`, { html: true })
    return
  }

  // Paginate if output > LOG_PAGE_BYTES
  if (Buffer.byteLength(trimmed, 'utf8') > LOG_PAGE_BYTES) {
    const chunks = chunkText(trimmed, 3800)
    for (let i = 0; i < chunks.length; i++) {
      const label = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : ''
      await switchroomReply(ctx, preBlock(chunks[i]) + (label ? `\n<i>${label}</i>` : ''), { html: true })
    }
  } else {
    await switchroomReply(ctx, preBlock(trimmed), { html: true })
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

// ─── Unrecognised text (DM only) ──────────────────────────────────────────
bot.on('message:text', async ctx => {
  if (ctx.chat?.type !== 'private') return
  await switchroomReply(ctx, 'Unknown command. Try /help.', { html: true })
})

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
      ])
    } catch (err) {
      process.stderr.write(`foreman: setMyCommands failed: ${err}\n`)
    }
  },
  on409: (attempt, delayMs) => {
    process.stderr.write(`foreman: 409 Conflict attempt=${attempt} retry_in_ms=${delayMs}\n`)
  },
})
