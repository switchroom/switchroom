#!/usr/bin/env bun
/**
 * Persistent Telegram gateway — owns the bot connection, polling, all admin
 * commands, inbound message routing, and outbound tool execution. Stays
 * alive across Claude Code session restarts via systemd.
 *
 * Bridge instances (one per agent/topic) connect over a Unix domain socket
 * (IPC), register, and exchange tool calls + session events. When no bridge
 * is connected, inbound LLM messages get a "⏳ Agent is restarting…" reply.
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy'
import { run, type RunnerHandle } from '@grammyjs/runner'
import type { ReactionTypeEmoji } from 'grammy/types'
import { randomBytes } from 'crypto'
import { execFileSync, execSync, spawn } from 'child_process'
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  statSync, renameSync, realpathSync, chmodSync, openSync, closeSync,
  existsSync, unlinkSync,
} from 'fs'
import { homedir } from 'os'
import { join, extname, sep, basename } from 'path'

import { installPluginLogger } from '../plugin-logger.js'
import { StatusReactionController } from '../status-reactions.js'
import { isTelegramReplyTool, isTelegramSurfaceTool } from '../tool-names.js'
import { type DraftStreamHandle } from '../draft-stream.js'
import { handlePtyPartialPure, type PtyHandlerState } from '../pty-partial-handler.js'
import { handleStreamReply } from '../stream-reply-handler.js'
import { createChatLock } from '../chat-lock.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { buildAttachmentPath, assertInsideInbox } from '../attachment-path.js'
import { createPinManager } from '../progress-card-pin-manager.js'
import { logStreamingEvent } from '../streaming-metrics.js'
import { type SessionEvent } from '../session-tail.js'
import { createProgressDriver, type ProgressDriver } from '../progress-card-driver.js'
import {
  shouldSuppressToolActivity,
} from '../pty-tail.js'
import { clearStaleTelegramPollingState } from '../startup-reset.js'
import {
  parseAuthSubCommand,
  checkRemoveSafety,
  formatSlotList,
  type SlotListingFromCli,
} from '../auth-slot-parser.js'
import {
  buildDashboard,
  buildRemoveConfirmKeyboard,
  parseCallbackData,
  encodeCallbackData,
  isQuotaHot,
  type DashboardState,
  type DashboardSlot,
  type SlotHealth,
} from '../auth-dashboard.js'
import {
  initHistory, recordInbound, recordOutbound, recordEdit,
  deleteFromHistory, query as queryHistory, getLatestInboundMessageId,
} from '../history.js'
import { parseQueuePrefix, parseSteerPrefix, formatPriorAssistantPreview } from '../steering.js'
import { markdownToHtml, splitHtmlChunks, repairEscapedWhitespace } from '../format.js'
import {
  startText as buildStartText,
  helpText as buildHelpText,
  statusPairedText as buildStatusPairedText,
  statusPendingText as buildStatusPendingText,
  statusUnpairedText as buildStatusUnpairedText,
  switchroomHelpText as buildSwitchroomHelpText,
  restartAckText as buildRestartAckText,
  newSessionAckText as buildNewSessionAckText,
  resetSessionAckText as buildResetSessionAckText,
  TELEGRAM_BASE_COMMANDS,
  TELEGRAM_SWITCHROOM_COMMANDS,
  type AgentMetadata, type AuthSummary,
} from '../welcome-text.js'
import {
  isContextExhaustionText,
  shouldArmOrphanedReplyTimeout,
  ORPHANED_REPLY_TIMEOUT_MS,
} from '../context-exhaustion.js'
import {
  decideTurnFlush,
  isTurnFlushSafetyEnabled,
} from '../turn-flush-safety.js'
import {
  resolveAgentDirFromEnv,
  consumeHandoffTopic,
  shouldShowHandoffLine,
  formatHandoffLine,
  writeLastTurnSummary,
  type HandoffFormat,
} from '../handoff-continuity.js'
import {
  readActivePins,
  addActivePin,
  removeActivePin,
  clearActivePins,
} from '../active-pins.js'
import { sweepActivePins, sweepBotAuthoredPins } from '../active-pins-sweep.js'
import {
  addActiveReaction,
  removeActiveReaction,
  clearActiveReactions,
} from '../active-reactions.js'
import { sweepActiveReactions } from '../active-reactions-sweep.js'
import { fetchQuota, formatQuotaBlock } from '../quota-check.js'
import {
  evaluateFallbackTrigger,
  performAutoFallback,
  emptyLockout,
  nextLockout,
  type LockoutRecord,
} from '../auto-fallback.js'
import { markSlotQuotaExhausted } from '../../src/auth/accounts.js'
import { fallbackToNextSlot, currentActiveSlot } from '../../src/auth/manager.js'

import { createIpcServer, type IpcClient, type IpcServer } from './ipc-server.js'
import type {
  ToolCallMessage,
  ToolCallResult,
  SessionEventForward,
  PermissionRequestForward,
  HeartbeatMessage,
  InboundMessage,
} from './ipc-protocol.js'

// ─── Stderr logging ───────────────────────────────────────────────────────
installPluginLogger()

// ─── Env + state dir ──────────────────────────────────────────────────────
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')

try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch (err) {
  // ENOENT is the expected "no .env yet" path and not worth logging.
  // Anything else (permission denied, truncated, IO error) should surface
  // so a misconfigured install isn't silently missing env vars.
  const code = (err as NodeJS.ErrnoException)?.code
  if (code !== 'ENOENT') {
    process.stderr.write(
      `telegram gateway: warning — failed to load ${ENV_FILE}: ${(err as Error).message}\n`,
    )
  }
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write(
    `telegram gateway: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE}\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...\n`,
  )
  process.exit(1)
}

const STATIC = process.env.TELEGRAM_ACCESS_MODE === 'static'
const TOPIC_ID = process.env.TELEGRAM_TOPIC_ID ? Number(process.env.TELEGRAM_TOPIC_ID) : undefined

// ─── Bot + chat lock ──────────────────────────────────────────────────────
const bot = new Bot(TOKEN)
const chatLock = createChatLock()
const lockedBot = chatLock.wrapBot({ api: bot.api as unknown as Record<string, unknown> }) as unknown as typeof bot
let botUsername = ''

// ─── Access control ───────────────────────────────────────────────────────

type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  parseMode?: 'html' | 'markdownv2' | 'text'
  disableLinkPreview?: boolean
  coalescingGapMs?: number
  statusReactions?: boolean
  historyEnabled?: boolean
  historyRetentionDays?: number
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

const MAX_CHUNK_LIMIT = 4096
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

function assertSendable(f: string): void {
  // Reject non-absolute paths to prevent relative path traversal
  if (!f.startsWith('/')) {
    throw new Error(`refusing to send file with relative path: ${f}`)
  }
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    // Fail closed: if we can't resolve the real path (broken symlink, no
    // permission, etc.), refuse to send. The old behavior silently allowed
    // the file through on resolution failure.
    throw new Error(`refusing to send file — cannot resolve real path: ${f}`)
  }
  // Block sending any channel state files (access.json, .env, history.db, etc.)
  // except files in the inbox directory (which are user-downloaded attachments).
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
  // Block known sensitive paths
  const SENSITIVE_PREFIXES = ['/proc/', '/sys/']
  const SENSITIVE_EXACT = ['/etc/shadow', '/etc/gshadow']
  for (const prefix of SENSITIVE_PREFIXES) {
    if (real.startsWith(prefix)) {
      throw new Error(`refusing to send system file: ${f}`)
    }
  }
  for (const exact of SENSITIVE_EXACT) {
    if (real === exact) {
      throw new Error(`refusing to send system file: ${f}`)
    }
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: parsed.allowFrom ?? [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      parseMode: parsed.parseMode,
      disableLinkPreview: parsed.disableLinkPreview,
      coalescingGapMs: parsed.coalescingGapMs,
      statusReactions: parsed.statusReactions,
      historyEnabled: parsed.historyEnabled,
      historyRetentionDays: parsed.historyRetentionDays,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try { renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`) } catch {}
    process.stderr.write(`telegram gateway: access.json is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

const BOOT_ACCESS: Access | null = STATIC
  ? (() => {
      const a = readAccessFile()
      if (a.dmPolicy === 'pairing') {
        process.stderr.write('telegram gateway: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      return a
    })()
  : null

function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

function assertAllowedChat(chat_id: string): void {
  const access = loadAccess()
  if (access.allowFrom.includes(chat_id)) return
  if (chat_id in access.groups) return
  throw new Error(`chat ${chat_id} is not allowlisted — add via /telegram:access`)
}

function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}

function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

// ─── History ──────────────────────────────────────────────────────────────
const HISTORY_ACCESS = loadAccess()
const HISTORY_ENABLED = HISTORY_ACCESS.historyEnabled !== false
if (HISTORY_ENABLED) {
  try {
    initHistory(STATE_DIR, HISTORY_ACCESS.historyRetentionDays ?? 30)
    process.stderr.write(`telegram gateway: history capture enabled at ${join(STATE_DIR, 'history.db')}\n`)
  } catch (err) {
    process.stderr.write(`telegram gateway: history init failed (${(err as Error).message}) — capture disabled\n`)
  }
}

// ─── Approval polling ─────────────────────────────────────────────────────
function checkApprovals(): void {
  let files: string[]
  try { files = readdirSync(APPROVED_DIR) } catch { return }
  for (const senderId of files) {
    const file = join(APPROVED_DIR, senderId)
    void bot.api.sendMessage(senderId, "Paired! Say hi to Claude.").then(
      () => rmSync(file, { force: true }),
      err => {
        process.stderr.write(`telegram gateway: failed to send approval confirm: ${err}\n`)
        rmSync(file, { force: true })
      },
    )
  }
}
if (!STATIC) setInterval(checkApprovals, 5000).unref()

// ─── Thread / status / stream state ───────────────────────────────────────
const chatThreadMap = new Map<string, number>()
const activeStatusReactions = new Map<string, StatusReactionController>()
const activeReactionMsgIds = new Map<string, { chatId: string; messageId: number }>()
const activeTurnStartedAt = new Map<string, number>()
const pendingRestarts = new Map<string, number>()  // agentName -> timestamp when restart was requested
const activeDraftStreams = new Map<string, DraftStreamHandle>()
const activeDraftParseModes = new Map<string, 'HTML' | 'MarkdownV2' | undefined>()
const suppressPtyPreview = new Set<string>()
const lastPtyPreviewByChat = new Map<string, string>()
const progressUpdateLastSent = new Map<string, number>()
const progressUpdateTurnCount = new Map<string, number>()

let currentSessionChatId: string | null = null
let currentTurnStartedAt = 0
let currentSessionThreadId: number | undefined = undefined
let currentTurnReplyCalled = false
let currentTurnCapturedText: string[] = []
let orphanedReplyTimeoutId: ReturnType<typeof setTimeout> | null = null

const CONTEXT_EXHAUSTION_COOLDOWN_MS = 10 * 60 * 1000
let lastContextExhaustionWarningAt = 0

let pendingPtyPartial: string | null = null

function statusKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

function streamKey(chatId: string, threadId?: number): string {
  return `${chatId}:${threadId ?? '_'}`
}

function purgeReactionTracking(key: string): void {
  const msgInfo = activeReactionMsgIds.get(key)
  activeStatusReactions.delete(key)
  activeReactionMsgIds.delete(key)
  activeTurnStartedAt.delete(key)
  if (msgInfo) {
    const agentDir = resolveAgentDirFromEnv()
    if (agentDir != null) removeActiveReaction(agentDir, msgInfo.chatId, msgInfo.messageId)
  }

  // If no more active turns and a restart is pending, perform it now.
  //
  // Cycle BOTH the agent unit and the gateway unit (us). Rationale: users
  // who ran `switchroom agent restart <name> --graceful-restart` after a
  // code change expect their telegram-plugin edits to land, and that code
  // only reloads when this gateway process restarts. Restarting only the
  // agent unit leaves us running the stale code until something else kicks
  // us over, which is a foot-gun (as observed on 2026-04-21 when a
  // klanker gateway ran pre-reorder progress-card code for half a day).
  //
  // Use detached spawn for the combined restart so the systemctl job
  // survives us getting killed by our own restart. Fire-and-forget;
  // response to the client was already sent when the restart was
  // scheduled, so nobody is waiting on this.
  if (activeTurnStartedAt.size === 0 && pendingRestarts.size > 0) {
    for (const [agentName, _timestamp] of pendingRestarts.entries()) {
      process.stderr.write(`telegram gateway: turn completed, restarting ${agentName} (agent + gateway) now\n`);
      try {
        spawn(
          'sh',
          [
            '-c',
            // Sleep briefly so our stderr flush lands before systemd kills us.
            `sleep 0.3 && systemctl --user restart switchroom-${agentName}.service switchroom-${agentName}-gateway.service`,
          ],
          { detached: true, stdio: 'ignore' },
        ).unref();
      } catch (err) {
        process.stderr.write(`telegram gateway: restart spawn failed for ${agentName}: ${err}\n`);
      }
      pendingRestarts.delete(agentName);
    }
  }
}

function endStatusReaction(chatId: string, threadId: number | undefined, outcome: 'done' | 'error'): void {
  const key = statusKey(chatId, threadId)
  const ctrl = activeStatusReactions.get(key)
  if (!ctrl) return
  if (outcome === 'done') ctrl.setDone()
  else ctrl.setError()
  purgeReactionTracking(key)
}

function resolveThreadId(chat_id: string, explicit?: string | number | null): number | undefined {
  if (explicit != null) return Number(explicit)
  return chatThreadMap.get(chat_id)
}

// ─── Handoff continuity ───────────────────────────────────────────────────
let pendingHandoffTopic: string | null = null

function initHandoffContinuity(): void {
  if (!shouldShowHandoffLine()) { pendingHandoffTopic = null; return }
  const agentDir = resolveAgentDirFromEnv()
  if (agentDir == null) { pendingHandoffTopic = null; return }
  pendingHandoffTopic = consumeHandoffTopic(agentDir)
}

function takeHandoffPrefix(format: HandoffFormat): string {
  if (pendingHandoffTopic == null) return ''
  const line = formatHandoffLine(pendingHandoffTopic, format)
  pendingHandoffTopic = null
  return line
}

// ─── Text chunking ────────────────────────────────────────────────────────
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

function escapeMarkdownV2(text: string): string {
  const specialChars = /[_*\[\]()~`>#+\-=|{}.!\\]/g
  const parts: string[] = []
  let last = 0
  const codeRe = /(```[\s\S]*?```|`[^`\n]+`)/g
  let m: RegExpExecArray | null
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index).replace(specialChars, '\\$&'))
    parts.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last).replace(specialChars, '\\$&'))
  return parts.join('')
}

// ─── Typing indicator ─────────────────────────────────────────────────────
const typingIntervals = new Map<string, ReturnType<typeof setInterval>>()
// Track pending backoff-retry timers so shutdown and stop can cancel them.
const typingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
let typingBackoffMs = 0
const TYPING_BACKOFF_MAX = 5 * 60 * 1000

function startTypingLoop(chat_id: string): void {
  stopTypingLoop(chat_id)
  const send = () => {
    bot.api.sendChatAction(chat_id, 'typing').then(
      () => { typingBackoffMs = 0 },
      (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('401') || msg.includes('Unauthorized')) {
          typingBackoffMs = Math.min(Math.max(typingBackoffMs * 2 || 1000, 1000), TYPING_BACKOFF_MAX)
          stopTypingLoop(chat_id)
          const retry = setTimeout(() => {
            typingRetryTimers.delete(chat_id)
            startTypingLoop(chat_id)
          }, typingBackoffMs)
          typingRetryTimers.set(chat_id, retry)
        }
      },
    )
  }
  send()
  typingIntervals.set(chat_id, setInterval(send, 4000))
}

function stopTypingLoop(chat_id: string): void {
  const iv = typingIntervals.get(chat_id)
  if (iv) { clearInterval(iv); typingIntervals.delete(chat_id) }
  const retry = typingRetryTimers.get(chat_id)
  if (retry) { clearTimeout(retry); typingRetryTimers.delete(chat_id) }
}

// ─── Robust API call wrapper ──────────────────────────────────────────────
// Extracted to telegram-plugin/retry-api-call.ts so it's unit-testable in
// isolation; the gateway just composes the pure policy with its own logger.
const robustApiCall = createRetryApiCall({
  log: (line) => process.stderr.write(line),
})

// ─── Structured outbound log ──────────────────────────────────────────────
function logOutbound(
  path: 'reply' | 'stream_reply' | 'backstop' | 'pty_preview' | 'edit' | 'forward',
  chatId: string, messageId: number | null, chars: number, extra?: string,
): void {
  const ts = new Date().toISOString()
  process.stderr.write(
    `telegram gateway [outbound] ${ts} path=${path} chat=${chatId} ` +
    `msg_id=${messageId ?? 'pending'} chars=${chars}` +
    (extra ? ` ${extra}` : '') + '\n',
  )
}

// ─── Permission handling ──────────────────────────────────────────────────
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const pendingPermissions = new Map<string, { tool_name: string; description: string; input_preview: string; startedAt: number }>()
const PERMISSION_TTL_MS = 10 * 60_000

// Reauth flows
const pendingReauthFlows = new Map<string, { agent: string; startedAt: number }>()
const REAUTH_INTERCEPT_TTL_MS = 10 * 60_000

// Vault
const vaultPassphraseCache = new Map<string, { passphrase: string; expiresAt: number }>()
const VAULT_PASSPHRASE_TTL_MS = 30 * 60 * 1000
type PendingVaultOp =
  | { kind: 'passphrase'; op: 'list' | 'get' | 'delete' | 'set'; key?: string; startedAt: number }
  | { kind: 'value'; op: 'set'; key: string; passphrase: string; startedAt: number }
const VAULT_INPUT_TTL_MS = 5 * 60 * 1000
const pendingVaultOps = new Map<string, PendingVaultOp>()

// ─── TTL reaper ───────────────────────────────────────────────────────────
// Pending state maps above all grow whenever a flow starts and only shrink
// when the flow completes. Users abandoning a flow (closing Telegram, losing
// connection, hitting cancel on client) leaves entries behind. Without a
// reaper, long-running gateways leak memory across days/weeks. A single
// 60-second sweep drops anything past its documented TTL.
const pendingStateReaper = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of pendingReauthFlows) {
    if (now - v.startedAt > REAUTH_INTERCEPT_TTL_MS) pendingReauthFlows.delete(k)
  }
  for (const [k, v] of pendingVaultOps) {
    if (now - v.startedAt > VAULT_INPUT_TTL_MS) pendingVaultOps.delete(k)
  }
  for (const [k, v] of pendingPermissions) {
    if (now - v.startedAt > PERMISSION_TTL_MS) pendingPermissions.delete(k)
  }
  for (const [k, v] of vaultPassphraseCache) {
    if (now > v.expiresAt) vaultPassphraseCache.delete(k)
  }
}, 60_000)
pendingStateReaper.unref()

/**
 * Does a message look like a Claude setup-token browser code?
 *
 * The intercept path in the inbound-message handler uses this to decide
 * whether to treat a pending-reauth chat's next message as `/auth code`.
 * Return value drives whether the gateway hijacks the message or lets
 * it through to the agent bridge — false negatives are user-visible as
 * 'I pasted my code and nothing happened'.
 *
 * Format evolution:
 *   - Legacy:  opaque 20+ char alphanum+underscore+hyphen token
 *   - 2025+:   `sk-ant-...` API tokens emitted by setup-token
 *   - 2026+:   `<code>#<state>` format from the claude.com/cai
 *              authorize URL (see parseSetupTokenUrl regex). The `#`
 *              in the middle was the breakage surfaced 2026-04-22 —
 *              user's code starting with `tle0rm...#00EySj...` fell
 *              through because the character class missed `#`.
 *
 * Character class now includes `#` and `.` for future-proofing (dot
 * is common in JWT-style tokens). Length cap raised to 500 because
 * the new dual-section format is ~90+ chars and will likely grow.
 */
function looksLikeAuthCode(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  if (trimmed.startsWith('session_')) return true
  if (trimmed.startsWith('sk-ant-')) return true
  if (/^[A-Za-z0-9_.#-]{6,500}$/.test(trimmed)) return true
  return false
}

// ─── Coalescing ───────────────────────────────────────────────────────────
type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

type CoalesceEntry = {
  texts: string[]
  ctx: Context
  downloadImage?: () => Promise<string | undefined>
  attachment?: AttachmentMeta
  timer: ReturnType<typeof setTimeout>
}

const coalesceBuffer = new Map<string, CoalesceEntry>()

function coalesceKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`
}

// ─── Progress card + session/PTY tail state ───────────────────────────────
const streamMode = process.env.SWITCHROOM_TG_STREAM_MODE ?? 'checklist'
const TURN_FLUSH_SAFETY_ENABLED = isTurnFlushSafetyEnabled()
let progressDriver: ProgressDriver | null = null
let unpinProgressCardForChat: ((chatId: string, threadId: number | undefined) => void) | null = null

// ─── IPC server ───────────────────────────────────────────────────────────
const SOCKET_PATH = process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(STATE_DIR, 'gateway.sock')
// Ensure the directory for the socket exists
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

const ipcServer: IpcServer = createIpcServer({
  socketPath: SOCKET_PATH,

  onClientRegistered(client: IpcClient) {
    process.stderr.write(`telegram gateway: bridge registered — agent=${client.agentName}\n`)
    client.send({ type: 'status', status: 'agent_connected' })

    // If the agent reconnected after a /restart, clear the marker and
    // notify the user so Telegram doesn't stay stuck on "restarting…".
    const marker = readRestartMarker()
    if (marker) {
      clearRestartMarker()
      const ageMs = Date.now() - marker.ts
      if (ageMs < 5 * 60_000) {
        const ageSec = Math.max(1, Math.round(ageMs / 1000))
        const text = `🎛️ Switchroom restarted — ready. (took ~${ageSec}s)`
        lockedBot.api.sendMessage(marker.chat_id, text, {
          parse_mode: 'HTML', link_preview_options: { is_disabled: true },
          ...(marker.thread_id != null ? { message_thread_id: marker.thread_id } : {}),
          ...(marker.ack_message_id != null ? { reply_parameters: { message_id: marker.ack_message_id } } : {}),
        }).then(sent => {
          if (HISTORY_ENABLED) { try { recordOutbound({ chat_id: marker.chat_id, thread_id: marker.thread_id, message_ids: [sent.message_id], texts: [text], attachment_kinds: [] }) } catch {} }
        }).catch(() => {})
      }
    }
  },

  onClientDisconnected(client: IpcClient) {
    process.stderr.write(`telegram gateway: bridge disconnected — agent=${client.agentName}\n`)

    // Flush all in-flight status reactions to 👍 so user messages don't stay
    // stuck on intermediate emoji (🤔, 🔥, etc.) after an agent crash/restart.
    for (const [key, ctrl] of activeStatusReactions.entries()) {
      ctrl.setDone()
      activeStatusReactions.delete(key)
      activeReactionMsgIds.delete(key)
      activeTurnStartedAt.delete(key)
    }
    { const ad = resolveAgentDirFromEnv(); if (ad) clearActiveReactions(ad) }

    // Stop the progress-card driver's heartbeat + coalesce timers so it
    // can't emit into deleted draft streams and spawn duplicate messages.
    progressDriver?.dispose()

    // Finalize any open draft streams so they don't hang mid-edit.
    for (const [key, stream] of activeDraftStreams.entries()) {
      if (!stream.isFinal()) void stream.finalize().catch(() => {})
      activeDraftStreams.delete(key)
      activeDraftParseModes.delete(key)
    }
  },

  async onToolCall(client: IpcClient, msg: ToolCallMessage): Promise<ToolCallResult> {
    try {
      const result = await executeToolCall(msg.tool, msg.args)
      return { type: 'tool_call_result', id: msg.id, success: true, result }
    } catch (err) {
      return {
        type: 'tool_call_result',
        id: msg.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  onSessionEvent(_client: IpcClient, msg: SessionEventForward) {
    const ev = msg.event as unknown as SessionEvent
    // Pass the envelope's chatId so non-enqueue events can route to the
    // correct card even when the driver's currentChatId is stale.
    const chatHint = msg.chatId || null
    const threadHint = msg.threadId != null ? String(msg.threadId) : undefined
    progressDriver?.ingest(ev, chatHint, threadHint)
    handleSessionEvent(ev)
  },

  onPermissionRequest(_client: IpcClient, msg: PermissionRequestForward) {
    const { requestId, toolName, description, inputPreview } = msg
    pendingPermissions.set(requestId, { tool_name: toolName, description, input_preview: inputPreview, startedAt: Date.now() })
    const access = loadAccess()
    const text = `🔐 Permission: ${toolName}`
    const keyboard = new InlineKeyboard()
      .text('See more', `perm:more:${requestId}`)
      .text('✅ Allow', `perm:allow:${requestId}`)
      .text('❌ Deny', `perm:deny:${requestId}`)
    for (const chat_id of access.allowFrom) {
      void bot.api.sendMessage(chat_id, text, { reply_markup: keyboard }).catch(e => {
        process.stderr.write(`telegram gateway: permission_request send to ${chat_id} failed: ${e}\n`)
      })
    }
  },

  onHeartbeat(_client: IpcClient, _msg: HeartbeatMessage) {
    // Heartbeat received — no action needed, the server tracks lastHeartbeat
  },

  onScheduleRestart(client: IpcClient, msg: ScheduleRestartMessage) {
    const { agentName } = msg;

    // Check if any turn is currently in flight
    const turnInFlight = activeTurnStartedAt.size > 0;

    if (!turnInFlight) {
      // No active turn, restart immediately. Cycle both the agent unit and
      // the gateway unit (us) so telegram-plugin code changes always
      // propagate. Send the client response FIRST, then spawn a detached
      // shell to run the combined systemctl restart after a brief delay.
      // The delay ensures the IPC response has flushed before systemd
      // kills us; the detach ensures the systemctl job survives our death.
      try {
        client.send({
          type: 'schedule_restart_result',
          success: true,
          restartedImmediately: true,
        });
        spawn(
          'sh',
          [
            '-c',
            `sleep 0.3 && systemctl --user restart switchroom-${agentName}.service switchroom-${agentName}-gateway.service`,
          ],
          { detached: true, stdio: 'ignore' },
        ).unref();
        process.stderr.write(`telegram gateway: scheduled immediate restart of ${agentName} (agent + gateway)\n`);
      } catch (err) {
        client.send({
          type: 'schedule_restart_result',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        process.stderr.write(`telegram gateway: restart spawn failed for ${agentName}: ${err}\n`);
      }
    } else {
      // Turn is active, schedule restart for when turn completes
      process.stderr.write(`telegram gateway: scheduling restart for ${agentName} after current turn\n`);

      // Set a flag that will be checked when turns complete
      pendingRestarts.set(agentName, Date.now());

      client.send({
        type: 'schedule_restart_result',
        success: true,
        waitingForTurn: true,
      });
    }
  },

  log: (msg) => process.stderr.write(`telegram gateway: ipc — ${msg}\n`),
})

// ─── Tool execution ──────────────────────────────────────────────────────

/** Allowlisted tool names that bridges may invoke via IPC. Prevents a rogue
 *  bridge from calling arbitrary functions by name. */
const ALLOWED_TOOLS = new Set([
  'reply', 'stream_reply', 'progress_update', 'react', 'download_attachment',
  'edit_message', 'send_typing', 'pin_message', 'delete_message',
  'forward_message', 'get_recent_messages',
])

async function executeToolCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!ALLOWED_TOOLS.has(tool)) {
    throw new Error(`tool not allowed: ${tool}`)
  }
  switch (tool) {
    case 'reply':
      return executeReply(args)
    case 'stream_reply':
      return executeStreamReply(args)
    case 'progress_update':
      return executeProgressUpdate(args)
    case 'react':
      return executeReact(args)
    case 'download_attachment':
      return executeDownloadAttachment(args)
    case 'edit_message':
      return executeEditMessage(args)
    case 'send_typing':
      return executeSendTyping(args)
    case 'pin_message':
      return executePinMessage(args)
    case 'delete_message':
      return executeDeleteMessage(args)
    case 'forward_message':
      return executeForwardMessage(args)
    case 'get_recent_messages':
      return executeGetRecentMessages(args)
    default:
      throw new Error(`unknown tool: ${tool}`)
  }
}

async function executeReply(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const chat_id = args.chat_id as string
  if (!chat_id) throw new Error('reply: chat_id is required')
  const rawText = args.text as string | undefined
  if (rawText == null || rawText === '') throw new Error('reply: text is required and cannot be empty')
  const text = repairEscapedWhitespace(rawText)
  const files = (args.files as string[] | undefined) ?? []
  const quoteOptIn = args.quote !== false
  let reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
  const access = loadAccess()
  const configParseMode = access.parseMode ?? 'html'
  const format = (args.format as string | undefined) ?? configParseMode
  const disableLinkPreview = args.disable_web_page_preview != null
    ? Boolean(args.disable_web_page_preview)
    : (access.disableLinkPreview ?? true)

  let parseMode: 'HTML' | 'MarkdownV2' | undefined
  let effectiveText: string
  if (format === 'html') {
    parseMode = 'HTML'
    effectiveText = markdownToHtml(text)
  } else if (format === 'markdownv2') {
    parseMode = 'MarkdownV2'
    effectiveText = escapeMarkdownV2(text)
  } else {
    parseMode = undefined
    effectiveText = text
  }

  {
    const prefix = takeHandoffPrefix(
      format === 'html' ? 'html' : format === 'markdownv2' ? 'markdownv2' : 'text',
    )
    if (prefix.length > 0) effectiveText = prefix + effectiveText
  }

  assertAllowedChat(chat_id)

  let threadId = resolveThreadId(chat_id, args.message_thread_id as string | undefined)

  if (reply_to == null && quoteOptIn && HISTORY_ENABLED) {
    try {
      const latest = getLatestInboundMessageId(chat_id, threadId ?? null)
      if (latest != null) reply_to = latest
    } catch (err) {
      process.stderr.write(`telegram gateway: quote-reply lookup failed: ${(err as Error).message}\n`)
    }
  }

  for (const f of files) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  const limit = Math.max(1, Math.min(access.textChunkLimit ?? 4000, MAX_CHUNK_LIMIT))
  const replyMode = access.replyToMode ?? 'first'
  const chunks = parseMode === 'HTML'
    ? splitHtmlChunks(effectiveText, limit)
    : chunk(effectiveText, limit, access.chunkMode ?? 'length')
  const sentIds: number[] = []

  const replySKey = streamKey(chat_id, threadId)
  suppressPtyPreview.add(replySKey)
  let previewMessageId: number | null = null
  const openStream = activeDraftStreams.get(replySKey)
  if (openStream && !openStream.isFinal()) {
    await openStream.finalize().catch(() => {})
    previewMessageId = openStream.getMessageId()
    activeDraftStreams.delete(replySKey)
    activeDraftParseModes.delete(replySKey)
    lastPtyPreviewByChat.delete(replySKey)
  }

  const deleteStalePreview = async (id: number): Promise<void> => {
    try {
      await lockedBot.api.deleteMessage(chat_id, id)
    } catch (err) {
      process.stderr.write(`telegram gateway: failed to delete stale preview ${id}: ${(err as Error).message}\n`)
    }
  }

  logStreamingEvent({
    kind: 'reply_called',
    chatId: chat_id,
    charCount: effectiveText.length,
    replacedPreview: previewMessageId != null,
    previewMessageId,
  })

  if (previewMessageId != null && reply_to != null && replyMode !== 'off') {
    await deleteStalePreview(previewMessageId)
    previewMessageId = null
  }

  startTypingLoop(chat_id)

  try {
    for (let i = 0; i < chunks.length; i++) {
      const shouldReplyTo =
        reply_to != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
      const sendOpts = {
        ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to } } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(threadId != null ? { message_thread_id: threadId } : {}),
        ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
      }

      if (i === 0 && previewMessageId != null) {
        const editOpts: Record<string, unknown> = {}
        if (parseMode) editOpts.parse_mode = parseMode
        if (disableLinkPreview) editOpts.link_preview_options = { is_disabled: true }
        try {
          await robustApiCall(
            () => lockedBot.api.editMessageText(chat_id, previewMessageId!, chunks[i], editOpts),
            { threadId, chat_id },
          )
          sentIds.push(previewMessageId!)
          previewMessageId = null
          continue
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (/not modified/i.test(msg)) {
            sentIds.push(previewMessageId!)
            previewMessageId = null
            continue
          }
          process.stderr.write(`telegram gateway: preview edit-in-place failed (${msg}), sending fresh\n`)
          await deleteStalePreview(previewMessageId!)
          previewMessageId = null
        }
      }

      try {
        const sent = await robustApiCall(
          () => lockedBot.api.sendMessage(chat_id, chunks[i], sendOpts),
          { threadId, chat_id },
        )
        sentIds.push(sent.message_id)
        logOutbound('reply', chat_id, sent.message_id, chunks[i].length, `chunk=${i + 1}/${chunks.length}`)
      } catch (err) {
        if (err instanceof Error && err.message === 'THREAD_NOT_FOUND') {
          threadId = undefined
          const retryOpts = { ...sendOpts }
          delete (retryOpts as any).message_thread_id
          const sent = await lockedBot.api.sendMessage(chat_id, chunks[i], retryOpts)
          sentIds.push(sent.message_id)
        } else {
          throw err
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
  } finally {
    stopTypingLoop(chat_id)
  }

  for (const f of files) {
    const ext = extname(f).toLowerCase()
    const input = new InputFile(f)
    const baseOpts = {
      ...(reply_to != null && replyMode !== 'off' ? { reply_parameters: { message_id: reply_to } } : {}),
      ...(threadId != null ? { message_thread_id: threadId } : {}),
    }
    if (PHOTO_EXTS.has(ext)) {
      const sent = await robustApiCall(() => lockedBot.api.sendPhoto(chat_id, input, baseOpts), { threadId, chat_id })
      sentIds.push(sent.message_id)
    } else {
      const sent = await robustApiCall(() => lockedBot.api.sendDocument(chat_id, input, baseOpts), { threadId, chat_id })
      sentIds.push(sent.message_id)
    }
  }

  const result = sentIds.length === 1
    ? `sent (id: ${sentIds[0]})`
    : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`

  if (HISTORY_ENABLED && sentIds.length > 0) {
    try {
      const fileCount = files.length
      const textCount = sentIds.length - fileCount
      const texts: string[] = []
      const attachKinds: (string | null)[] = []
      for (let i = 0; i < textCount; i++) { texts.push(chunks[i] ?? ''); attachKinds.push(null) }
      for (let i = 0; i < fileCount; i++) {
        const ext = extname(files[i] ?? '').toLowerCase()
        texts.push(`(${PHOTO_EXTS.has(ext) ? 'photo' : 'document'}: ${files[i]})`)
        attachKinds.push(PHOTO_EXTS.has(ext) ? 'photo' : 'document')
      }
      recordOutbound({ chat_id, thread_id: threadId ?? null, message_ids: sentIds, texts, attachment_kinds: attachKinds })
    } catch (err) {
      process.stderr.write(`telegram gateway: history recordOutbound (reply) failed: ${err}\n`)
    }
  }

  unpinProgressCardForChat?.(chat_id, threadId)

  return { content: [{ type: 'text', text: result }] }
}

async function executeStreamReply(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('stream_reply: chat_id is required')
  if (args.text == null || args.text === '') throw new Error('stream_reply: text is required and cannot be empty')
  const access = loadAccess()
  const result = await handleStreamReply(
    {
      chat_id: args.chat_id as string,
      text: args.text as string,
      done: Boolean(args.done),
      message_thread_id: args.message_thread_id as string | undefined,
      format: args.format as string | undefined,
      reply_to: args.reply_to as string | undefined,
      quote: args.quote as boolean | undefined,
    },
    { activeDraftStreams, activeDraftParseModes, suppressPtyPreview },
    {
      bot: lockedBot,
      retry: robustApiCall,
      markdownToHtml,
      escapeMarkdownV2,
      repairEscapedWhitespace,
      takeHandoffPrefix,
      assertAllowedChat,
      resolveThreadId,
      disableLinkPreview: access.disableLinkPreview !== false,
      defaultFormat: access.parseMode ?? 'html',
      logStreamingEvent,
      endStatusReaction,
      historyEnabled: HISTORY_ENABLED,
      recordOutbound,
      ...(HISTORY_ENABLED ? { getLatestInboundMessageId } : {}),
      writeError: (line) => process.stderr.write(line),
      throttleMs: 600,
      progressCardActive: streamMode === 'checklist',
    },
  )
  if (result.status === 'finalized') {
    const srChatId = args.chat_id as string
    const srThreadId = resolveThreadId(srChatId, args.message_thread_id as string | undefined)
    unpinProgressCardForChat?.(srChatId, srThreadId)
  }
  return { content: [{ type: 'text', text: `${result.status} (id: ${result.messageId ?? 'pending'})` }] }
}

async function executeProgressUpdate(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('progress_update: chat_id is required')
  if (!args.text) throw new Error('progress_update: text is required')

  const chat_id = args.chat_id as string
  let text = args.text as string
  const threadId = resolveThreadId(chat_id, args.message_thread_id as string | undefined)
  const key = statusKey(chat_id, threadId)

  assertAllowedChat(chat_id)

  // Truncate to 300 chars
  if (text.length > 300) {
    text = text.slice(0, 299) + '…'
  }

  const now = Date.now()

  // Rate limit: ≥ 20s between calls
  const lastSent = progressUpdateLastSent.get(key)
  if (lastSent != null) {
    const elapsed = now - lastSent
    if (elapsed < 20_000) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, reason: 'too_soon', retryAfterMs: 20_000 - elapsed }),
          },
        ],
      }
    }
  }

  // Turn cap: max 5 calls per turn
  const turnStart = activeTurnStartedAt.get(key)
  if (turnStart != null) {
    const currentCount = progressUpdateTurnCount.get(key) ?? 0
    if (currentCount >= 5) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, reason: 'turn_limit' }),
          },
        ],
      }
    }
    progressUpdateTurnCount.set(key, currentCount + 1)
  }

  // Send plain message (no quote-reply)
  const access = loadAccess()
  const configParseMode = access.parseMode ?? 'html'
  const parseMode = configParseMode === 'html' ? 'HTML' : undefined
  const effectiveText = configParseMode === 'html' ? markdownToHtml(text) : text

  const sendOpts = {
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(threadId != null ? { message_thread_id: threadId } : {}),
  }

  const sent = await robustApiCall(
    () => lockedBot.api.sendMessage(chat_id, effectiveText, sendOpts),
    { verb: 'sendMessage', chat_id, threadId },
  )

  // Record in sent-message history
  if (HISTORY_ENABLED) {
    recordOutbound({
      chat_id,
      thread_id: threadId ?? null,
      message_ids: [sent.message_id],
      text,
    })
  }

  progressUpdateLastSent.set(key, now)

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, message_id: sent.message_id }),
      },
    ],
  }
}

async function executeReact(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('react: chat_id is required')
  if (!args.message_id) throw new Error('react: message_id is required')
  if (!args.emoji) throw new Error('react: emoji is required')
  assertAllowedChat(args.chat_id as string)
  await lockedBot.api.setMessageReaction(args.chat_id as string, Number(args.message_id), [
    { type: 'emoji', emoji: args.emoji as ReactionTypeEmoji['emoji'] },
  ])
  return { content: [{ type: 'text', text: 'reacted' }] }
}

async function executeDownloadAttachment(args: Record<string, unknown>): Promise<unknown> {
  if (!args.file_id) throw new Error('download_attachment: file_id is required')
  const file_id = String(args.file_id)
  // Validate file_id format — Telegram file IDs are alphanumeric with dashes/underscores
  if (!/^[\w-]{10,200}$/.test(file_id)) {
    throw new Error('download_attachment: invalid file_id format')
  }
  const file = await bot.api.getFile(file_id)
  if (!file.file_path) throw new Error('Telegram returned no file_path — file may have expired')
  // Build download URL — token is embedded but NEVER included in error messages
  const downloadUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
  let res: Response
  try {
    res = await fetch(downloadUrl)
  } catch (err) {
    // Sanitize: never leak the token in network error messages
    throw new Error(`download failed: network error`)
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const dlPath = buildAttachmentPath({
    inboxDir: INBOX_DIR,
    telegramFilePath: file.file_path,
    fileUniqueId: file.file_unique_id,
    now: Date.now(),
  })
  mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })
  assertInsideInbox(INBOX_DIR, dlPath)
  writeFileSync(dlPath, buf, { mode: 0o600 })
  return { content: [{ type: 'text', text: dlPath }] }
}

async function executeEditMessage(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('edit_message: chat_id is required')
  if (!args.message_id) throw new Error('edit_message: message_id is required')
  if (args.text == null || args.text === '') throw new Error('edit_message: text is required and cannot be empty')
  assertAllowedChat(args.chat_id as string)
  const editAccess = loadAccess()
  const editConfigMode = editAccess.parseMode ?? 'html'
  const editFormat = (args.format as string | undefined) ?? editConfigMode
  const editRawText = repairEscapedWhitespace(args.text as string)
  let editParseMode: 'HTML' | 'MarkdownV2' | undefined
  let editText: string
  if (editFormat === 'html') {
    editParseMode = 'HTML'
    editText = markdownToHtml(editRawText)
  } else if (editFormat === 'markdownv2') {
    editParseMode = 'MarkdownV2'
    editText = escapeMarkdownV2(editRawText)
  } else {
    editParseMode = undefined
    editText = editRawText
  }
  const edited = await robustApiCall(
    () => lockedBot.api.editMessageText(
      args.chat_id as string, Number(args.message_id), editText,
      ...(editParseMode ? [{ parse_mode: editParseMode }] : []),
    ),
  )
  const id = typeof edited === 'object' && edited ? (edited as any).message_id : args.message_id
  if (HISTORY_ENABLED) {
    try {
      recordEdit({ chat_id: args.chat_id as string, message_id: Number(args.message_id), text: args.text as string })
    } catch (err) {
      process.stderr.write(`telegram gateway: history recordEdit failed: ${err}\n`)
    }
  }
  return { content: [{ type: 'text', text: `edited (id: ${id})` }] }
}

async function executeSendTyping(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('send_typing: chat_id is required')
  const stChatId = args.chat_id as string
  assertAllowedChat(stChatId)
  startTypingLoop(stChatId)
  setTimeout(() => stopTypingLoop(stChatId), 30000)
  for (const [key, ctrl] of activeStatusReactions.entries()) {
    if (key.startsWith(`${stChatId}:`)) ctrl.setTool()
  }
  return { content: [{ type: 'text', text: 'typing indicator sent (auto-refreshes every 4s, stops after 30s or next reply)' }] }
}

async function executePinMessage(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('pin_message: chat_id is required')
  if (!args.message_id) throw new Error('pin_message: message_id is required')
  assertAllowedChat(args.chat_id as string)
  await lockedBot.api.pinChatMessage(args.chat_id as string, Number(args.message_id))
  return { content: [{ type: 'text', text: `pinned message ${args.message_id}` }] }
}

async function executeDeleteMessage(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('delete_message: chat_id is required')
  if (!args.message_id) throw new Error('delete_message: message_id is required')
  const delChatId = args.chat_id as string
  const delMessageId = Number(args.message_id)
  assertAllowedChat(delChatId)
  await robustApiCall(() => lockedBot.api.deleteMessage(delChatId, delMessageId), { chat_id: delChatId })
  if (HISTORY_ENABLED) {
    try { deleteFromHistory({ chat_id: delChatId, message_id: delMessageId }) } catch (err) {
      process.stderr.write(`telegram gateway: history deleteFromHistory failed: ${err}\n`)
    }
  }
  return { content: [{ type: 'text', text: `deleted message ${delMessageId}` }] }
}

async function executeForwardMessage(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('forward_message: chat_id is required')
  if (!args.from_chat_id) throw new Error('forward_message: from_chat_id is required')
  if (!args.message_id) throw new Error('forward_message: message_id is required')
  const fwdChatId = args.chat_id as string
  const fwdFromChatId = args.from_chat_id as string
  const fwdMsgId = Number(args.message_id)
  assertAllowedChat(fwdChatId)
  const threadId = resolveThreadId(fwdChatId, args.message_thread_id as string | undefined)
  const fwd = await robustApiCall(
    () => lockedBot.api.forwardMessage(fwdChatId, fwdFromChatId, fwdMsgId, {
      ...(threadId != null ? { message_thread_id: threadId } : {}),
    }),
    { threadId, chat_id: fwdChatId },
  )
  if (HISTORY_ENABLED) {
    try {
      recordOutbound({
        chat_id: fwdChatId,
        thread_id: threadId ?? null,
        message_ids: [fwd.message_id],
        texts: [`(forwarded from ${fwdFromChatId}/${fwdMsgId})`],
      })
    } catch (err) {
      process.stderr.write(`telegram gateway: history recordOutbound (forward) failed: ${err}\n`)
    }
  }
  return { content: [{ type: 'text', text: `forwarded (id: ${fwd.message_id})` }] }
}

async function executeGetRecentMessages(args: Record<string, unknown>): Promise<unknown> {
  if (!HISTORY_ENABLED) {
    return {
      content: [{ type: 'text', text: 'history capture is disabled — set historyEnabled: true in access.json and restart' }],
      isError: true,
    }
  }
  if (!args.chat_id) throw new Error('get_recent_messages: chat_id is required')
  const chat_id = args.chat_id as string
  assertAllowedChat(chat_id)
  const rawThread = args.message_thread_id as string | undefined
  let thread_id: number | null | undefined
  if (rawThread === undefined) thread_id = undefined
  else if (rawThread === '' || rawThread === '0' || rawThread === 'null') thread_id = null
  else thread_id = Number(rawThread)
  const limit = args.limit != null ? Number(args.limit) : 10
  const before_message_id = args.before_message_id != null ? Number(args.before_message_id) : undefined

  const rows = queryHistory({ chat_id, thread_id, limit, before_message_id })
  const summary = rows
    .map(r => {
      const who = r.role === 'user' ? r.user ?? 'user' : 'assistant'
      const time = new Date(r.ts * 1000).toISOString()
      const attach = r.attachment_kind ? ` [${r.attachment_kind}]` : ''
      return `[${time}] ${who}${attach}: ${r.text}`
    })
    .join('\n')
  return {
    content: [
      { type: 'text', text: summary || '(no recent messages)' },
      { type: 'text', text: JSON.stringify({ chat_id, thread_id: thread_id ?? null, count: rows.length, messages: rows }, null, 2) },
    ],
  }
}

// ─── Session event handling ───────────────────────────────────────────────

function resetOrphanedReplyTimeout(): void {
  if (orphanedReplyTimeoutId != null) {
    clearTimeout(orphanedReplyTimeoutId)
    orphanedReplyTimeoutId = null
  }
  if (shouldArmOrphanedReplyTimeout({
    currentSessionChatId,
    capturedTextCount: currentTurnCapturedText.length,
    replyCalled: currentTurnReplyCalled,
    progressCardActive: progressDriver != null,
  })) {
    orphanedReplyTimeoutId = setTimeout(() => {
      orphanedReplyTimeoutId = null
      if (shouldArmOrphanedReplyTimeout({
        currentSessionChatId,
        capturedTextCount: currentTurnCapturedText.length,
        replyCalled: currentTurnReplyCalled,
        progressCardActive: progressDriver != null,
      })) {
        process.stderr.write(
          `telegram gateway: orphaned-reply timeout (${ORPHANED_REPLY_TIMEOUT_MS}ms) — forcing backstop\n`,
        )
        handleSessionEvent({ kind: 'turn_end', durationMs: -1 })
      }
    }, ORPHANED_REPLY_TIMEOUT_MS)
  }
}

function closeActivityLane(chatId: string, threadId: number | undefined): void {
  const key = `${chatId}:${threadId ?? '_'}:activity`
  const stream = activeDraftStreams.get(key)
  if (stream == null) return
  activeDraftStreams.delete(key)
  activeDraftParseModes.delete(key)
  void stream.finalize().catch(() => {})
}

function closeProgressLane(chatId: string, threadId: number | undefined): void {
  // Progress-card streams include a turnKey suffix in their key
  // (e.g. "chatId:_:progress:chatId:1"). Iterate and match by prefix
  // so the backstop actually finds the stream.
  const prefix = `${chatId}:${threadId ?? '_'}:progress`
  for (const [key, stream] of activeDraftStreams) {
    if (key.startsWith(prefix)) {
      activeDraftStreams.delete(key)
      activeDraftParseModes.delete(key)
      void stream.finalize().catch(() => {})
    }
  }
}

function handleSessionEvent(ev: SessionEvent): void {
  switch (ev.kind) {
    case 'enqueue': {
      if (ev.chatId) {
        currentSessionChatId = ev.chatId
        currentSessionThreadId = ev.threadId != null ? Number(ev.threadId) : undefined
        currentTurnReplyCalled = false
        currentTurnCapturedText = []
        currentTurnStartedAt = Date.now()
        if (pendingPtyPartial != null) {
          const pending = pendingPtyPartial
          pendingPtyPartial = null
          handlePtyPartial(pending)
        }
      }
      return
    }
    case 'dequeue': return
    case 'thinking': {
      if (currentSessionChatId == null) return
      const ctrl = activeStatusReactions.get(statusKey(currentSessionChatId, currentSessionThreadId))
      if (ctrl) ctrl.setThinking()
      return
    }
    case 'tool_use': {
      if (currentSessionChatId == null) return
      const ctrl = activeStatusReactions.get(statusKey(currentSessionChatId, currentSessionThreadId))
      const name = ev.toolName
      if (isTelegramReplyTool(name)) {
        currentTurnReplyCalled = true
        if (orphanedReplyTimeoutId != null) {
          clearTimeout(orphanedReplyTimeoutId)
          orphanedReplyTimeoutId = null
        }
      }
      if (!ctrl) return
      if (isTelegramSurfaceTool(name)) return
      ctrl.setTool(name)
      return
    }
    case 'text': {
      if (currentSessionChatId != null) {
        currentTurnCapturedText.push(ev.text)
      }
      resetOrphanedReplyTimeout()

      if (isContextExhaustionText(ev.text) && currentSessionChatId != null) {
        const chatId = currentSessionChatId
        const threadId = currentSessionThreadId
        const now = Date.now()
        if (now - lastContextExhaustionWarningAt < CONTEXT_EXHAUSTION_COOLDOWN_MS) return
        lastContextExhaustionWarningAt = now
        process.stderr.write(`telegram gateway: context exhaustion detected — notifying user\n`)
        const warnOpts = {
          parse_mode: 'HTML' as const,
          ...(threadId != null ? { message_thread_id: threadId } : {}),
        }
        void bot.api.sendMessage(
          chatId,
          '⚠️ <b>Context window full</b> — send <code>/restart</code> to start a fresh session.',
          warnOpts,
        ).catch(() => {})
        const ctrl = activeStatusReactions.get(statusKey(chatId, threadId))
        if (ctrl) ctrl.setError()
        purgeReactionTracking(statusKey(chatId, threadId))
        currentSessionChatId = null
        currentSessionThreadId = undefined
        currentTurnReplyCalled = false
        currentTurnCapturedText = []
      }
      return
    }
    case 'tool_result': return
    case 'turn_end': {
      if (orphanedReplyTimeoutId != null) {
        clearTimeout(orphanedReplyTimeoutId)
        orphanedReplyTimeoutId = null
      }
      if (currentSessionChatId == null) return
      const chatId = currentSessionChatId
      const threadId = currentSessionThreadId
      const ctrl = activeStatusReactions.get(statusKey(chatId, threadId))

      const flushDecision = decideTurnFlush({
        chatId: currentSessionChatId,
        replyCalled: currentTurnReplyCalled,
        capturedText: currentTurnCapturedText,
        flushEnabled: TURN_FLUSH_SAFETY_ENABLED,
      })
      if (flushDecision.kind === 'skip' && flushDecision.reason !== 'reply-called') {
        process.stderr.write(
          `telegram gateway: turn-flush skipped — reason=${flushDecision.reason}\n`,
        )
      }
      if (flushDecision.kind === 'flush') {
        const capturedText = flushDecision.text
        const backstopChatId = chatId
        const backstopThreadId = threadId
        const backstopCtrl = ctrl

        currentSessionChatId = null
        currentSessionThreadId = undefined
        currentTurnReplyCalled = false
        currentTurnCapturedText = []

        void (async () => {
          await new Promise<void>(resolve => setTimeout(resolve, 500))
          if (HISTORY_ENABLED) {
            try {
              const { getRecentOutboundCount } = await import('../history.js')
              const recentCount = getRecentOutboundCount(backstopChatId, 2)
              if (recentCount > 0) {
                process.stderr.write(`telegram gateway: turn-flush suppressed — reply tool sent ${recentCount} message(s) within 2s\n`)
                if (backstopCtrl) backstopCtrl.setDone()
                purgeReactionTracking(statusKey(backstopChatId, backstopThreadId))
                return
              }
            } catch {}
          }

          process.stderr.write(
            `telegram gateway: turn-flush firing — ${capturedText.length} chars without reply tool (chat=${backstopChatId})\n`,
          )
          const sendOpts = {
            parse_mode: 'HTML' as const,
            ...(backstopThreadId != null ? { message_thread_id: backstopThreadId } : {}),
            link_preview_options: { is_disabled: true },
          }
          const renderedText = markdownToHtml(capturedText)
          const limit = 4000
          const htmlChunks = splitHtmlChunks(renderedText, limit)
          const sentIds: number[] = []
          try {
            for (const c of htmlChunks) {
              const sent = await bot.api.sendMessage(backstopChatId, c, sendOpts)
              sentIds.push(sent.message_id)
            }
            if (HISTORY_ENABLED && sentIds.length > 0) {
              try {
                recordOutbound({
                  chat_id: backstopChatId,
                  thread_id: backstopThreadId ?? null,
                  message_ids: sentIds,
                  texts: htmlChunks,
                })
              } catch {}
            }
            if (backstopCtrl) backstopCtrl.setDone()
          } catch (err) {
            process.stderr.write(`telegram gateway: turn-flush send failed: ${(err as Error).message}\n`)
            if (backstopCtrl) backstopCtrl.setError()
          } finally {
            purgeReactionTracking(statusKey(backstopChatId, backstopThreadId))
          }
        })()
        return
      }

      if (ctrl) ctrl.setDone()
      purgeReactionTracking(statusKey(chatId, threadId))
      {
        const sKey = streamKey(chatId, threadId)
        logStreamingEvent({
          kind: 'turn_end',
          chatId,
          durationMs: currentTurnStartedAt > 0 ? Date.now() - currentTurnStartedAt : 0,
          suppressClearedCount: suppressPtyPreview.has(sKey) ? 1 : 0,
        })
      }
      lastPtyPreviewByChat.delete(statusKey(chatId, threadId))
      pendingPtyPartial = null
      closeActivityLane(chatId, threadId)
      closeProgressLane(chatId, threadId)
      currentSessionChatId = null
      currentSessionThreadId = undefined
      currentTurnReplyCalled = false
      currentTurnCapturedText = []
      return
    }
  }
}

// ─── PTY partial handler ─────────────────────────────────────────────────
function handlePtyPartial(text: string): void {
  const state: PtyHandlerState = {
    currentSessionChatId,
    currentSessionThreadId,
    pendingPtyPartial: pendingPtyPartial != null ? { text: pendingPtyPartial } : null,
    activeDraftStreams,
    activeDraftParseModes,
    suppressPtyPreview,
    lastPtyPreviewByChat,
  }
  handlePtyPartialPure(text, state, {
    bot,
    retry: robustApiCall,
    renderText: markdownToHtml,
    logEvent: logStreamingEvent,
    onStreamSend: (chatId, messageId, charCount) => {
      logOutbound('pty_preview', chatId, messageId, charCount, 'initial_send')
      logStreamingEvent({ kind: 'draft_send', chatId, messageId, charCount })
    },
    onStreamEdit: (chatId, messageId, charCount) =>
      logStreamingEvent({ kind: 'draft_edit', chatId, messageId, charCount, sameAsLast: false }),
    onFirstPartial: (chatId, charCount) => {
      process.stderr.write(`telegram gateway: pty first partial — chat=${chatId} chars=${charCount}\n`)
    },
    writeError: (line) => process.stderr.write(line),
  })
  pendingPtyPartial = state.pendingPtyPartial?.text ?? null
}

function handlePtyActivity(text: string): void {
  if (currentSessionChatId == null) return
  if (shouldSuppressToolActivity(text)) return
  const chatId = currentSessionChatId
  const threadId = currentSessionThreadId
  const access = loadAccess()
  void handleStreamReply(
    {
      chat_id: chatId,
      text,
      done: false,
      message_thread_id: threadId != null ? String(threadId) : undefined,
      format: 'text',
      lane: 'activity',
    },
    { activeDraftStreams, activeDraftParseModes },
    {
      bot,
      retry: robustApiCall,
      markdownToHtml,
      escapeMarkdownV2,
      repairEscapedWhitespace,
      takeHandoffPrefix: () => '',
      assertAllowedChat,
      resolveThreadId,
      disableLinkPreview: access.disableLinkPreview !== false,
      defaultFormat: 'text',
      logStreamingEvent,
      endStatusReaction,
      historyEnabled: false,
      recordOutbound,
      writeError: (line) => process.stderr.write(line),
      throttleMs: 600,
    },
  ).catch((err) => {
    process.stderr.write(`telegram gateway: pty activity stream failed: ${(err as Error).message}\n`)
  })
}

// ─── Gate / inbound routing ───────────────────────────────────────────────

type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function gate(ctx: Context): GateResult {
  const access = loadAccess()
  const pruned = pruneExpired(access)
  if (pruned) saveAccess(access)
  if (access.dmPolicy === 'disabled') return { action: 'drop' }
  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        saveAccess(access)
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }
    const code = randomBytes(3).toString('hex')
    const now = Date.now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000,
      replies: 1,
    }
    saveAccess(access)
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if (requireMention && !isMentioned(ctx, access.mentionPatterns)) return { action: 'drop' }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}

function isMentioned(ctx: Context, extraPatterns?: string[]): boolean {
  const entities = ctx.message?.entities ?? ctx.message?.caption_entities ?? []
  const text = ctx.message?.text ?? ctx.message?.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention') {
      const mentioned = text.slice(e.offset, e.offset + e.length)
      if (mentioned.toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    }
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  if (ctx.message?.reply_to_message?.from?.username === botUsername) return true
  for (const pat of extraPatterns ?? []) {
    try { if (new RegExp(pat, 'i').test(text)) return true } catch {}
  }
  return false
}

function isAuthorizedSender(ctx: Context): boolean {
  const from = ctx.from
  if (!from) return false
  const senderId = String(from.id)
  const access = loadAccess()
  if (ctx.chat?.type === 'private') return access.allowFrom.includes(senderId)
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    const groupId = String(ctx.chat.id)
    const policy = access.groups[groupId]
    if (!policy) return false
    const groupAllowFrom = policy.allowFrom ?? []
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return false
    return true
  }
  return false
}

function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

// ─── Inbound message handling ─────────────────────────────────────────────

async function handleInboundCoalesced(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  if (downloadImage || attachment) return handleInbound(ctx, text, downloadImage, attachment)
  const access = loadAccess()
  const gapMs = access.coalescingGapMs ?? 1500
  if (gapMs <= 0) return handleInbound(ctx, text, undefined, undefined)

  const from = ctx.from
  if (!from) return
  const chatId = String(ctx.chat!.id)
  const userId = String(from.id)
  const key = coalesceKey(chatId, userId)

  const existing = coalesceBuffer.get(key)
  if (existing) {
    clearTimeout(existing.timer)
    existing.texts.push(text)
    existing.ctx = ctx
    existing.timer = setTimeout(() => flushCoalesce(key), gapMs)
  } else {
    const entry: CoalesceEntry = {
      texts: [text],
      ctx,
      timer: setTimeout(() => flushCoalesce(key), gapMs),
    }
    coalesceBuffer.set(key, entry)
  }
}

function flushCoalesce(key: string): void {
  const entry = coalesceBuffer.get(key)
  if (!entry) return
  coalesceBuffer.delete(key)
  void handleInbound(entry.ctx, entry.texts.join('\n'), entry.downloadImage, entry.attachment)
}

async function handleInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment?: AttachmentMeta,
): Promise<void> {
  const isTopicMessage = ctx.message?.is_topic_message ?? false
  const messageThreadId = ctx.message?.message_thread_id

  if (TOPIC_ID != null) {
    if (!isTopicMessage || messageThreadId !== TOPIC_ID) return
  }

  const result = gate(ctx)
  if (result.action === 'drop') return
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return
  }

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  if (messageThreadId != null) chatThreadMap.set(chat_id, messageThreadId)

  // Permission-reply intercept
  const permMatch = PERMISSION_REPLY_RE.exec(text)
  if (permMatch) {
    // Forward permission reply to connected bridge
    const behavior = permMatch[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
    const request_id = permMatch[2]!.toLowerCase()
    ipcServer.broadcast({
      type: 'permission',
      requestId: request_id,
      behavior,
    })
    if (msgId != null) {
      const emoji = behavior === 'allow' ? '✅' : '❌'
      void bot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }
    return
  }

  // Auth-code intercept
  const pendingReauth = pendingReauthFlows.get(chat_id)
  if (pendingReauth && looksLikeAuthCode(text)) {
    const elapsed = Date.now() - pendingReauth.startedAt
    if (elapsed < REAUTH_INTERCEPT_TTL_MS) {
      pendingReauthFlows.delete(chat_id)
      try {
        const output = stripAnsi(switchroomExecCombined(['auth', 'code', pendingReauth.agent, text.trim()], 30000))
        const formatted = formatAuthOutputForTelegram(output)
        await switchroomReply(ctx, formatted.text, { html: true })
      } catch (err: unknown) {
        const error = err as { stderr?: string; message?: string }
        const detail = stripAnsi(error.stderr?.trim() || error.message || 'unknown error')
        await switchroomReply(ctx, `<b>auth code failed:</b>\n${preBlock(formatSwitchroomOutput(detail))}`, { html: true })
      }
      if (msgId != null) {
        void bot.api.setMessageReaction(chat_id, msgId, [
          { type: 'emoji', emoji: '🔑' as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
      return
    }
    pendingReauthFlows.delete(chat_id)
  }

  // Vault intercept
  const pendingVault = pendingVaultOps.get(chat_id)
  if (pendingVault) {
    const elapsed = Date.now() - pendingVault.startedAt
    if (elapsed > VAULT_INPUT_TTL_MS) {
      pendingVaultOps.delete(chat_id)
    } else {
      pendingVaultOps.delete(chat_id)
      if (pendingVault.kind === 'passphrase') {
        const passphrase = text.trim()
        if (!passphrase) {
          await switchroomReply(ctx, 'Passphrase cannot be empty. Try /vault again.', { html: true })
          return
        }
        vaultPassphraseCache.set(chat_id, { passphrase, expiresAt: Date.now() + VAULT_PASSPHRASE_TTL_MS })
        if (msgId != null) void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
        await executeVaultOp(ctx, chat_id, pendingVault.op, pendingVault.key, passphrase, undefined)
      } else {
        let value = text
        const codeBlockMatch = /^```[\w]*\n?([\s\S]*?)```$/m.exec(text)
        if (codeBlockMatch) value = codeBlockMatch[1]!
        if (msgId != null) void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
        await executeVaultOp(ctx, chat_id, 'set', pendingVault.key, pendingVault.passphrase, value.trim())
      }
      return
    }
  }

  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

  // Parse explicit prefixes first. `/steer ` / `/s ` opts IN to steering;
  // `/queue ` / `/q ` are legacy aliases that opt in to the new default (queued).
  const parsedSteer = parseSteerPrefix(text)
  const isSteerPrefix = parsedSteer.steering
  const parsedQueue = isSteerPrefix ? { queued: false, body: parsedSteer.body } : parseQueuePrefix(text)
  const isQueuedPrefix = parsedQueue.queued
  const effectiveText = isSteerPrefix ? parsedSteer.body : (isQueuedPrefix ? parsedQueue.body : text)

  // Status reaction controller
  let isSteering = false
  let priorTurnStartedAt: number | undefined
  if (msgId != null) {
    const key = statusKey(chat_id, messageThreadId)
    const priorActive = activeStatusReactions.get(key)
    const priorTurnInFlight = priorActive != null
    // New default: mid-turn messages are queued unless the user explicitly
    // steers. isSteering is true only when the steer prefix is present.
    // (Legacy: without any prefix the old behavior was isSteering=true; now
    // it's false so the message goes through as queued="true".)
    isSteering = priorTurnInFlight && isSteerPrefix
    if (priorTurnInFlight) priorTurnStartedAt = activeTurnStartedAt.get(key)

    if (access.statusReactions !== false) {
      if (isSteering) {
        // Explicit steer: mark with 🤝 on the inbound message; leave the
        // existing StatusReactionController running for the in-flight turn.
        void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '🤝' }]).catch(() => {})
      } else if (priorTurnInFlight) {
        // Queued mid-turn message (new default): don't touch the existing
        // controller; just ack the inbound message with 👀 so the user
        // knows we received it, without disrupting the in-flight reaction.
        void bot.api.setMessageReaction(chat_id, msgId, [{ type: 'emoji', emoji: '👀' }]).catch(() => {})
      } else {
        // Fresh turn (no prior turn in flight): cancel any stale controller
        // and start a new one for this message.
        if (priorActive) {
          priorActive.cancel()
          purgeReactionTracking(key)
        }
        const sKey = streamKey(chat_id, messageThreadId)
        const priorStream = activeDraftStreams.get(sKey)
        if (priorStream && !priorStream.isFinal()) {
          void priorStream.finalize().catch(() => {})
          activeDraftStreams.delete(sKey)
          activeDraftParseModes.delete(sKey)
        }
        suppressPtyPreview.delete(sKey)

        const ctrl = new StatusReactionController(async (emoji) => {
          await bot.api.setMessageReaction(chat_id, msgId, [
            { type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] },
          ])
        })
        activeStatusReactions.set(key, ctrl)
        activeReactionMsgIds.set(key, { chatId: chat_id, messageId: msgId })
        activeTurnStartedAt.set(key, Date.now())
        progressUpdateTurnCount.set(key, 0)  // Reset turn counter
        ctrl.setQueued()
        const agentDir = resolveAgentDirFromEnv()
        if (agentDir != null) {
          addActiveReaction(agentDir, { chatId: chat_id, messageId: msgId, threadId: messageThreadId ?? null, reactedAt: Date.now() })
        }
      }
    } else if (access.ackReaction) {
      void bot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
    }
  }

  // Start a new progress card only for fresh turns (no prior turn in flight).
  // Queued mid-turn messages piggyback on the existing card; steer messages
  // also don't start a new card (the in-flight turn owns it).
  if (!isSteering && priorTurnStartedAt == null) {
    try {
      progressDriver?.startTurn({
        chatId: chat_id,
        threadId: messageThreadId != null ? String(messageThreadId) : undefined,
        userText: effectiveText,
      })
    } catch (err) {
      process.stderr.write(`telegram gateway: progress-card startTurn failed: ${(err as Error).message}\n`)
    }
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  if (HISTORY_ENABLED) {
    try {
      recordInbound({
        chat_id,
        thread_id: messageThreadId ?? null,
        message_id: msgId,
        user: from.username ?? String(from.id),
        user_id: String(from.id),
        ts: ctx.message?.date ?? Math.floor(Date.now() / 1000),
        text: effectiveText,
        attachment_kind: attachment?.kind,
      })
    } catch (err) {
      process.stderr.write(`telegram gateway: history recordInbound failed: ${err}\n`)
    }
  }

  // Build steering meta.
  // priorTurnInProgress is true for ANY mid-turn follow-up (queued or steering).
  // isSteering = explicit /steer or /s prefix was used.
  // isQueuedMidTurn = prior turn was in flight and no steer prefix (new default).
  const priorTurnInProgress = isSteering || (priorTurnStartedAt != null)
  const isQueuedMidTurn = priorTurnInProgress && !isSteering
  let secondsSinceTurnStart: number | undefined
  let priorAssistantPreview: string | undefined
  if (priorTurnInProgress) {
    if (priorTurnStartedAt != null) {
      secondsSinceTurnStart = Math.max(0, Math.floor((Date.now() - priorTurnStartedAt) / 1000))
    }
    if (HISTORY_ENABLED) {
      try {
        const rows = queryHistory({ chat_id, thread_id: messageThreadId ?? null, limit: 10 })
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i]!
          if (r.role === 'assistant' && r.text && r.text.length > 0) {
            priorAssistantPreview = formatPriorAssistantPreview(r.text, 200)
            break
          }
        }
      } catch {}
    }
  }

  // Dispatch to connected bridge via IPC
  const inboundMsg: InboundMessage = {
    type: 'inbound',
    chatId: chat_id,
    ...(messageThreadId != null ? { threadId: messageThreadId } : {}),
    messageId: msgId ?? 0,
    user: from.username ?? String(from.id),
    userId: from.id,
    ts: ctx.message?.date ?? Math.floor(Date.now() / 1000),
    text: effectiveText,
    ...(imagePath ? { imagePath } : {}),
    ...(attachment ? {
      attachment: {
        fileId: attachment.file_id,
        mimeType: attachment.mime ?? 'application/octet-stream',
        ...(attachment.name ? { fileName: attachment.name } : {}),
      },
    } : {}),
    meta: {
      chat_id,
      ...(msgId != null ? { message_id: String(msgId) } : {}),
      user: from.username ?? String(from.id),
      user_id: String(from.id),
      ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
      ...(messageThreadId != null ? { message_thread_id: String(messageThreadId) } : {}),
      ...(imagePath ? { image_path: imagePath } : {}),
      // queued="true" when mid-turn with no steer prefix (new default), or
      // with explicit /queue or /q prefix (legacy alias).
      ...((isQueuedMidTurn || isQueuedPrefix) ? { queued: 'true' } : {}),
      // steering="true" only when explicit /steer or /s prefix used.
      ...(isSteering ? { steering: 'true' } : {}),
      ...(priorTurnInProgress ? { prior_turn_in_progress: 'true' } : {}),
      ...(priorTurnInProgress && secondsSinceTurnStart != null ? { seconds_since_turn_start: String(secondsSinceTurnStart) } : {}),
      ...(priorTurnInProgress && priorAssistantPreview != null && priorAssistantPreview.length > 0 ? { prior_assistant_preview: priorAssistantPreview } : {}),
      ...(attachment ? {
        attachment_kind: attachment.kind,
        attachment_file_id: attachment.file_id,
        ...(attachment.size != null ? { attachment_size: String(attachment.size) } : {}),
        ...(attachment.mime ? { attachment_mime: attachment.mime } : {}),
        ...(attachment.name ? { attachment_name: attachment.name } : {}),
      } : {}),
    },
  }

  // Try to send to a connected bridge. If no bridge connected, tell the user.
  ipcServer.broadcast(inboundMsg)
  const delivered = ipcServer.clientCount() > 0

  if (!delivered) {
    const threadOpts = messageThreadId != null ? { message_thread_id: messageThreadId } : {}
    void bot.api.sendMessage(
      chat_id,
      '⏳ Agent is restarting, please wait…',
      { ...threadOpts },
    ).catch(() => {})
  }
}

// ─── Switchroom CLI helpers ───────────────────────────────────────────────
const SWITCHROOM_CLI = process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
const SWITCHROOM_CONFIG = process.env.SWITCHROOM_CONFIG

function switchroomExec(args: string[], timeoutMs = 15000): string {
  const fullArgs = SWITCHROOM_CONFIG ? ['--config', SWITCHROOM_CONFIG, ...args] : args
  return execFileSync(SWITCHROOM_CLI, fullArgs, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 4 * 1024 * 1024,
  })
}

function switchroomExecCombined(args: string[], timeoutMs = 15000): string {
  const fullArgs = SWITCHROOM_CONFIG ? ['--config', SWITCHROOM_CONFIG, ...args] : args
  const quoted = [SWITCHROOM_CLI, ...fullArgs].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ')
  return execSync(`${quoted} 2>&1`, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    maxBuffer: 4 * 1024 * 1024,
    shell: '/bin/bash',
  })
}

function formatSwitchroomOutput(output: string, maxLen = 4000): string {
  const trimmed = output.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 20) + '\n... (truncated)'
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

function escapeHtmlForTg(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function preBlock(text: string): string {
  return '<pre>' + escapeHtmlForTg(text) + '</pre>'
}

type SwitchroomReplyMarkup =
  | InlineKeyboard
  | { force_reply: true; input_field_placeholder?: string; selective?: boolean }

async function switchroomReply(
  ctx: Context,
  text: string,
  options: { html?: boolean; reply_markup?: SwitchroomReplyMarkup } = {},
): Promise<void> {
  const chatId = String(ctx.chat!.id)
  const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
  await ctx.reply(text, {
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(options.html ? { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } } : {}),
    ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
  })
}

function getCommandArgs(ctx: Context): string {
  const fromMatch = typeof ctx.match === 'string' ? ctx.match.trim() : ''
  if (fromMatch) return fromMatch
  const text = (ctx.msg as { text?: string } | undefined)?.text ?? (ctx.message as { text?: string } | undefined)?.text ?? ''
  const m = text.match(/^\/\S+\s+([\s\S]*)$/)
  return m ? m[1].trim() : ''
}

/** Validate that a string looks like a safe agent/resource name.
 *  Agent names should be alphanumeric with hyphens/underscores only.
 *  This prevents shell metacharacter injection even though both exec
 *  functions already handle quoting. Defense in depth. */
function assertSafeAgentName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) && name !== 'all') {
    throw new Error(`invalid agent name: ${name}`)
  }
}

function getMyAgentName(): string {
  const fromEnv = process.env.SWITCHROOM_AGENT_NAME
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
  return basename(process.cwd())
}

function isSelfTargetingCommand(name: string): boolean {
  if (name === 'all') return true
  return name === getMyAgentName()
}

// ─── Restart marker ───────────────────────────────────────────────────────
type RestartMarker = { chat_id: string; thread_id: number | null; ack_message_id: number | null; ts: number }

function restartMarkerPath(): string | null {
  const agentDir = resolveAgentDirFromEnv()
  if (!agentDir) return null
  return join(agentDir, 'restart-pending.json')
}
function writeRestartMarker(marker: RestartMarker): void {
  const p = restartMarkerPath(); if (!p) return
  try { writeFileSync(p, JSON.stringify(marker)) } catch (err) {
    process.stderr.write(`telegram gateway: writeRestartMarker failed: ${err}\n`)
  }
}
function readRestartMarker(): RestartMarker | null {
  const p = restartMarkerPath(); if (!p) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as RestartMarker } catch { return null }
}
function clearRestartMarker(): void {
  const p = restartMarkerPath(); if (!p) return
  try { rmSync(p, { force: true }) } catch {}
}

/**
 * Fire-and-forget a detached `switchroom` CLI invocation.
 *
 * `onFailure`, if provided, is called with the child's exit code and the
 * tail of `detached-spawn.log` when the child exits non-zero BEFORE
 * ~5 seconds have passed (the rough window during which the gateway is
 * still alive and hasn't yet been SIGTERM'd by its own restart). This
 * lets us surface "agent not found in switchroom.yaml" and other
 * fail-fast CLI errors to the Telegram user instead of silently
 * swallowing them into detached-spawn.log.
 */
function spawnSwitchroomDetached(
  args: string[],
  onFailure?: (info: { code: number; tail: string }) => void,
): void {
  const fullArgs = SWITCHROOM_CONFIG ? ['--config', SWITCHROOM_CONFIG, ...args] : args
  const logPath = join(STATE_DIR, 'detached-spawn.log')
  let outFd: number | null = null
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    outFd = openSync(logPath, 'a')
    writeFileSync(logPath, `\n[${new Date().toISOString()}] spawn ${SWITCHROOM_CLI} ${fullArgs.join(' ')}\n`, { flag: 'a' })
  } catch {}
  const child = spawn(SWITCHROOM_CLI, fullArgs, {
    detached: true,
    stdio: outFd != null ? ['ignore', outFd, outFd] : 'ignore',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  if (outFd != null) { try { closeSync(outFd) } catch {} }

  if (onFailure) {
    const started = Date.now()
    child.on('exit', (code) => {
      // Only surface "obvious-fail" exits — non-zero within 5 seconds.
      // A successful restart kills us before we'd ever see the exit
      // event, so any exit we DO observe here is almost certainly
      // fail-fast (bad agent name, bad args, missing config).
      if (code == null || code === 0) return
      if (Date.now() - started > 5000) return
      let tail = ''
      try {
        const full = readFileSync(logPath, 'utf8')
        tail = full.split('\n').slice(-30).join('\n').trim()
      } catch { /* best effort */ }
      try { onFailure({ code, tail }) } catch (err) {
        process.stderr.write(`telegram gateway: spawn onFailure handler threw: ${err}\n`)
      }
    })
    child.on('error', (err) => {
      try { onFailure({ code: -1, tail: String(err) }) } catch { /* ignore */ }
    })
  }

  child.unref()
}

/**
 * Build an `onFailure` handler that posts a user-facing error reply back
 * to the Telegram chat when a detached `switchroom` child fails fast.
 * Also clears the restart marker so the "🎛️ restarted — ready" follow-up
 * doesn't get stuck forever.
 */
function notifyDetachedFailure(
  chatId: string,
  threadId: number | null,
  label: string,
): (info: { code: number; tail: string }) => void {
  return ({ code, tail }) => {
    clearRestartMarker()
    const snippet = tail ? tail.slice(-800) : '(no output captured)'
    const text =
      `❌ <b>${escapeHtmlForTg(label)} failed</b> (exit ${code}):\n` +
      preBlock(snippet)
    // Fire-and-forget — we're off the command-handler context and don't
    // have an await to block on anyway.
    lockedBot.api
      .sendMessage(chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(threadId != null ? { message_thread_id: threadId } : {}),
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `telegram gateway: notifyDetachedFailure send failed: ${err}\n`,
        )
      })
  }
}

async function sweepBeforeSelfRestart(): Promise<void> {
  const agentDir = resolveAgentDirFromEnv()
  if (agentDir == null) return
  try {
    await sweepActivePins(
      agentDir,
      (chatId, messageId) => lockedBot.api.unpinChatMessage(chatId, messageId),
      { log: (msg) => process.stderr.write(`telegram gateway: pre-restart pin sweep — ${msg}\n`) },
    )
  } catch (err) {
    process.stderr.write(`telegram gateway: pre-restart pin sweep threw: ${(err as Error).message}\n`)
  }
  try {
    await sweepActiveReactions(
      agentDir,
      (chatId, messageId) => lockedBot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👍' as ReactionTypeEmoji['emoji'] }]),
      { log: (msg) => process.stderr.write(`telegram gateway: pre-restart reaction sweep — ${msg}\n`) },
    )
  } catch (err) {
    process.stderr.write(`telegram gateway: pre-restart reaction sweep threw: ${(err as Error).message}\n`)
  }
}

/**
 * Shape the `switchroom auth ...` CLI stdout into a Telegram-friendly
 * HTML block. Returns the body text AND the OAuth authorize URL (if
 * one was present in the output) so the caller can wire a tappable
 * InlineKeyboardButton in addition to the inline link.
 *
 * The URL-in-text is kept on its own line at the bottom as a fallback:
 * if the inline button ever fails to render (old client, unusual scope)
 * the user still has a copy-paste-able URL.
 */
function formatAuthOutputForTelegram(output: string): { text: string; url: string | null } {
  const trimmed = stripAnsi(output).trim()
  const url = trimmed.match(/https:\/\/\S+/)?.[0] ?? null
  const lines = trimmed.split(/\n+/).map(l => l.trim()).filter(Boolean)
  if (!url) return { text: preBlock(formatSwitchroomOutput(trimmed)), url: null }
  // Drop the `switchroom auth code ...` and `switchroom auth cancel ...`
  // CLI hints. In Telegram the user never types those — they just reply
  // with the code (intercepted by the pendingReauthFlows flow above) or
  // tap the inline button. Surfacing shell syntax is confusing noise on
  // a phone.
  const body = lines.filter(line => {
    if (line === url) return false
    if (line.startsWith('switchroom auth code')) return false
    if (line.startsWith('switchroom auth cancel')) return false
    if (line.startsWith("Use 'tmux attach")) return false
    if (line.startsWith('After Claude shows you a browser code')) return false
    if (line.startsWith('Then finish with:')) return false
    if (line.startsWith('Cancel with:')) return false
    return true
  })
  const rendered = body.map(line => {
    if (line.startsWith('Started Claude auth') || line.startsWith('Auth session already running')) return `<b>${escapeHtmlForTg(line)}</b>`
    if (line.startsWith('Open this URL')) return `<i>${escapeHtmlForTg(line)}</i>`
    return escapeHtmlForTg(line)
  })
  // Mobile-native post-script: tap the inline button below, then reply
  // to this chat with the browser code. No command prefix needed.
  rendered.push(
    '',
    '👇 Tap the button below to open Claude auth.',
    'Then <b>reply here with the browser code</b> (just paste it).',
    '',
    `<a href="${escapeHtmlForTg(url)}">${escapeHtmlForTg(url)}</a>`,
  )
  return { text: rendered.join('\n'), url }
}

/**
 * Build the inline keyboard shown under an auth-flow response that has
 * an OAuth URL. The button gives users a direct tap-to-browser action
 * without having to select the inline text link— the native pattern on
 * mobile per the keep-my-subscription-honest JTBD ("user can state in
 * one sentence what they're paying for" → one-tap auth action).
 */
function buildAuthUrlKeyboard(authorizeUrl: string): InlineKeyboard {
  return new InlineKeyboard().url('🔐 Open Claude auth', authorizeUrl)
}

async function runSwitchroomAuthCommand(ctx: Context, args: string[], label: string): Promise<void> {
  try {
    const output = switchroomExecCombined(args, 30000)
    const formatted = formatAuthOutputForTelegram(output)
    const keyboard = formatted.url ? buildAuthUrlKeyboard(formatted.url) : undefined
    await switchroomReply(ctx, formatted.text, { html: true, reply_markup: keyboard })
    // If this flow produced an OAuth URL, follow up with a ForceReply
    // prompt so Telegram's text-input bar shows a "Paste browser code"
    // placeholder. The user's next message (whether they 'reply' to
    // this explicitly or just type) is auto-captured by the existing
    // pendingReauthFlows intercept in the inbound-message handler.
    if (formatted.url) {
      try {
        await switchroomReply(ctx, '📋 Paste the browser code here ↓', {
          reply_markup: { force_reply: true, input_field_placeholder: 'Paste browser code', selective: true },
        })
      } catch {
        // ForceReply is UX garnish — if it fails the flow still works
        // via the pending-intercept. Don't escalate.
      }
    }
  } catch (err: unknown) {
    const error = err as { status?: number; stderr?: string; message?: string }
    if (error.message?.includes('ENOENT')) { await switchroomReply(ctx, 'switchroom CLI not found.', { html: true }); return }
    if (error.message?.includes('ETIMEDOUT') || error.message?.includes('timed out')) { await switchroomReply(ctx, `${label}: timed out`); return }
    const detail = stripAnsi(error.stderr?.trim() || error.message || 'unknown error')
    await switchroomReply(ctx, `<b>${escapeHtmlForTg(label)} failed:</b>\n${preBlock(formatSwitchroomOutput(detail))}`, { html: true })
  }
}

function runVaultCli(args: string[], passphrase: string, stdinValue?: string): { ok: boolean; output: string } {
  const env = { ...process.env, SWITCHROOM_VAULT_PASSPHRASE: passphrase }
  try {
    let result: string
    if (stdinValue !== undefined) {
      result = execFileSync(process.env.SWITCHROOM_CLI_PATH ?? 'switchroom', ['vault', ...args], { input: stdinValue, encoding: 'utf8', env, timeout: 10000 })
    } else {
      result = execFileSync(process.env.SWITCHROOM_CLI_PATH ?? 'switchroom', ['vault', ...args], { encoding: 'utf8', env, timeout: 10000 })
    }
    return { ok: true, output: result.trim() }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim() }
  }
}

async function executeVaultOp(ctx: Context, chatId: string, op: 'list' | 'get' | 'set' | 'delete', key: string | undefined, passphrase: string, setValue: string | undefined): Promise<void> {
  if (op === 'list') {
    const r = runVaultCli(['list'], passphrase)
    if (!r.ok) { await switchroomReply(ctx, `<b>vault list failed:</b>\n${preBlock(r.output)}`, { html: true }); return }
    const keys = r.output.split('\n').filter(Boolean)
    if (keys.length === 0) { await switchroomReply(ctx, 'Vault is empty.', { html: true }) }
    else { await switchroomReply(ctx, `<b>Vault keys (${keys.length}):</b>\n${keys.map(k => `• <code>${escapeHtmlForTg(k)}</code>`).join('\n')}`, { html: true }) }
  } else if (op === 'get') {
    const r = runVaultCli(['get', key!], passphrase)
    if (!r.ok) { await switchroomReply(ctx, `<b>vault get failed:</b>\n${preBlock(r.output)}`, { html: true }); return }
    await switchroomReply(ctx, `<code>${escapeHtmlForTg(key!)}</code> =\n<code>${escapeHtmlForTg(r.output)}</code>`, { html: true })
  } else if (op === 'set') {
    if (setValue === undefined) {
      pendingVaultOps.set(chatId, { kind: 'value', op: 'set', key: key!, passphrase, startedAt: Date.now() })
      await switchroomReply(ctx, `Send the value for <code>${escapeHtmlForTg(key!)}</code>.`, { html: true })
      return
    }
    const r = runVaultCli(['set', key!], passphrase, setValue)
    if (!r.ok) { await switchroomReply(ctx, `<b>vault set failed:</b>\n${preBlock(r.output)}`, { html: true }) }
    else { await switchroomReply(ctx, `✅ <code>${escapeHtmlForTg(key!)}</code> saved to vault.`, { html: true }) }
  } else if (op === 'delete') {
    const r = runVaultCli(['remove', key!], passphrase)
    if (!r.ok) { await switchroomReply(ctx, `<b>vault delete failed:</b>\n${preBlock(r.output)}`, { html: true }) }
    else { await switchroomReply(ctx, `✅ <code>${escapeHtmlForTg(key!)}</code> removed from vault.`, { html: true }) }
  }
}

async function runSwitchroomCommand(ctx: Context, args: string[], label: string): Promise<void> {
  try {
    const output = stripAnsi(switchroomExec(args))
    const formatted = formatSwitchroomOutput(output)
    if (formatted) { await switchroomReply(ctx, preBlock(formatted), { html: true }) }
    else { await switchroomReply(ctx, `${label}: done (no output)`) }
  } catch (err: unknown) {
    const error = err as { status?: number; stderr?: string; message?: string }
    if (error.message?.includes('ENOENT')) { await switchroomReply(ctx, 'switchroom CLI not found.', { html: true }); return }
    if (error.message?.includes('ETIMEDOUT') || error.message?.includes('timed out')) { await switchroomReply(ctx, `${label}: timed out`); return }
    const detail = stripAnsi(error.stderr?.trim() || error.message || 'unknown error')
    await switchroomReply(ctx, `<b>${escapeHtmlForTg(label)} failed:</b>\n${preBlock(formatSwitchroomOutput(detail))}`, { html: true })
  }
}

function switchroomExecJson<T = unknown>(args: string[]): T | null {
  try {
    const output = switchroomExec([...args, '--json'])
    return JSON.parse(stripAnsi(output)) as T
  } catch { return null }
}

function statusIcon(status: string): string {
  if (status === 'active' || status === 'running') return '🟢'
  if (status === 'inactive' || status === 'stopped' || status === 'dead') return '🔴'
  if (status === 'failed') return '⚠️'
  return '⚪'
}

async function runSwitchroomCommandFormatted(ctx: Context, args: string[], label: string, formatter: () => string | null): Promise<void> {
  try {
    const formatted = formatter()
    if (formatted) { await switchroomReply(ctx, formatted, { html: true }); return }
    await runSwitchroomCommand(ctx, args, label)
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    const detail = stripAnsi(error.stderr?.trim() || error.message || 'unknown error')
    await switchroomReply(ctx, `<b>${escapeHtmlForTg(label)} failed:</b>\n${preBlock(formatSwitchroomOutput(detail))}`, { html: true })
  }
}

// ─── Bot commands ─────────────────────────────────────────────────────────

// Build an AgentMetadata snapshot for the current agent by shelling out
// to `switchroom agent list --json` and `switchroom auth status --json`.
// Best-effort — any missing piece renders as a placeholder in the text
// templates rather than blocking the reply.
function buildAgentMetadata(agentName: string): AgentMetadata {
  type AgentListResp = {
    agents: Array<{
      name: string; status: string; uptime: string;
      extends?: string | null; template?: string | null;
      topic_name?: string | null; topic_emoji?: string | null;
      model?: string | null;
    }>
  }
  type AuthStatusResp = {
    agents: Array<{
      name: string; authenticated: boolean; auth_source: string | null;
      subscription_type: string | null; expires_in: string | null;
    }>
  }
  const list = switchroomExecJson<AgentListResp>(['agent', 'list'])
  const auth = switchroomExecJson<AuthStatusResp>(['auth', 'status'])
  const a = list?.agents?.find(x => x.name === agentName) ?? null
  const au = auth?.agents?.find(x => x.name === agentName) ?? null
  const authSummary: AuthSummary | null = au
    ? {
        authenticated: au.authenticated,
        subscription_type: au.subscription_type,
        expires_in: au.expires_in,
        auth_source: au.auth_source,
      }
    : null
  return {
    agentName,
    model: a?.model ?? null,
    extendsProfile: (a?.extends ?? a?.template) ?? null,
    topicName: a?.topic_name ?? null,
    topicEmoji: a?.topic_emoji ?? null,
    uptime: a?.uptime ?? null,
    status: a?.status ?? null,
    auth: authSummary,
  }
}

bot.command('start', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const access = loadAccess()
  const disabled = access.dmPolicy === 'disabled'
  await ctx.reply(buildStartText(getMyAgentName(), disabled), { parse_mode: 'HTML' })
})

bot.command('help', async ctx => {
  if (ctx.chat?.type !== 'private') return
  await ctx.reply(buildHelpText(getMyAgentName()), { parse_mode: 'HTML' })
})

bot.command('status', async ctx => {
  if (ctx.chat?.type !== 'private') return
  const from = ctx.from; if (!from) return
  const senderId = String(from.id)
  const access = loadAccess()
  if (access.allowFrom.includes(senderId)) {
    const userTag = from.username ? `@${from.username}` : senderId
    const meta = buildAgentMetadata(getMyAgentName())
    await ctx.reply(buildStatusPairedText({ user: userTag, meta }), { parse_mode: 'HTML' })
    return
  }
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      await ctx.reply(buildStatusPendingText(code), { parse_mode: 'HTML' })
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
    if (data.agents.length === 0) return '<i>No agents defined</i>'
    const lines = ['<b>Agents</b>']
    for (const a of data.agents) {
      lines.push(`${statusIcon(a.status)} <b>${escapeHtmlForTg(a.name)}</b> · ${escapeHtmlForTg(a.status)} · ${escapeHtmlForTg(a.uptime)}`)
      lines.push(`    <i>${escapeHtmlForTg(a.template)} → ${escapeHtmlForTg(a.topic_name)}${a.topic_emoji ? ' ' + a.topic_emoji : ''}</i>`)
    }
    return lines.join('\n')
  })
})

bot.command('switchroomstart', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const name = ctx.match?.trim() || getMyAgentName()
  try { assertSafeAgentName(name) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  await runSwitchroomCommand(ctx, ['agent', 'start', name], `start ${name}`)
})

bot.command('stop', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const name = ctx.match?.trim() || getMyAgentName()
  try { assertSafeAgentName(name) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  await runSwitchroomCommand(ctx, ['agent', 'stop', name], `stop ${name}`)
})

bot.command('restart', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const name = ctx.match?.trim() || getMyAgentName()
  try { assertSafeAgentName(name) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  if (isSelfTargetingCommand(name)) {
    const existing = readRestartMarker()
    if (existing && Date.now() - existing.ts < 15_000) {
      await switchroomReply(ctx, `⏳ Restart already in progress — ignoring duplicate.`, { html: true })
      return
    }
    const chatId = String(ctx.chat!.id)
    const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
    const ackText = buildRestartAckText(name)
    let ackId: number | null = null
    try {
      const sent = await lockedBot.api.sendMessage(chatId, ackText, {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(threadId != null ? { message_thread_id: threadId } : {}),
      })
      ackId = sent.message_id
      if (HISTORY_ENABLED) {
        try { recordOutbound({ chat_id: chatId, thread_id: threadId ?? null, message_ids: [sent.message_id], texts: [`🔄 Restarting ${name}…`], attachment_kinds: [] }) } catch {}
      }
    } catch {}
    writeRestartMarker({ chat_id: chatId, thread_id: threadId ?? null, ack_message_id: ackId, ts: Date.now() })
    await sweepBeforeSelfRestart()
    spawnSwitchroomDetached(
      ['agent', 'restart', name, '--force'],
      notifyDetachedFailure(chatId, threadId ?? null, `restart ${name}`),
    )
    return
  }
  await runSwitchroomCommand(ctx, ['agent', 'restart', name], `restart ${name}`)
})

// ─── /new and /reset ──────────────────────────────────────────────────────
// Start a fresh session: flush .handoff.md + .handoff-topic so the restarted
// claude session isn't primed with the prior conversation, then trigger a
// restart. MEMORY.md, workspace/, skills/ are preserved. A1/N1/C6 from the
// OpenClawification review pass all applied.
function flushAgentHandoff(agentDir: string): number {
  let removed = 0
  for (const fname of ['.handoff.md', '.handoff-topic']) {
    const p = join(agentDir, fname)
    try {
      if (existsSync(p)) { unlinkSync(p); removed++ }
    } catch (err) {
      process.stderr.write(`telegram gateway: flushAgentHandoff ${fname}: ${(err as Error).message}\n`)
    }
  }
  return removed
}

async function handleNewOrResetCommand(ctx: Context, kind: 'new' | 'reset'): Promise<void> {
  if (!isAuthorizedSender(ctx)) return
  const name = (ctx.match ?? '').trim() || getMyAgentName()
  try { assertSafeAgentName(name) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  // N1: `all` passes isSelfTargetingCommand (for /restart), but /new and
  // /reset semantically require flushing each agent's handoff before
  // restarting it — only that agent's own gateway can do that. If we let
  // /new all through we'd flush ONLY this agent's handoff and restart every
  // agent, leaving the others with stale briefings.
  if (name === 'all') {
    await switchroomReply(
      ctx,
      `/${kind} only supports a single agent — “all” would leave other agents with stale handoff briefings. ` +
        `Run /${kind} from each agent’s own topic, or use <code>switchroom agent restart all</code> if you just want a plain restart without flushing sessions.`,
      { html: true },
    )
    return
  }
  // A1: Cross-agent /new is refused — this gateway can only flush its own
  // handoff. Silently wiping our handoff while restarting another agent is a
  // footgun.
  if (!isSelfTargetingCommand(name)) {
    await switchroomReply(
      ctx,
      `/${kind} only supports the current agent (<b>${escapeHtmlForTg(getMyAgentName())}</b>). ` +
        `To restart another agent with a fresh session, run /${kind} from its own topic, ` +
        `or use <code>switchroom agent restart ${escapeHtmlForTg(name)}</code>.`,
      { html: true },
    )
    return
  }
  // C6: debounce — /new and /reset are functionally self-restarts. Without
  // the same 15s marker guard /restart uses, a double-tap (because the ack
  // hasn't landed yet) would stack systemctl restarts.
  const existing = readRestartMarker()
  if (existing && Date.now() - existing.ts < 15_000) {
    await switchroomReply(
      ctx,
      `⏳ Restart of <b>${escapeHtmlForTg(name)}</b> already in progress (${Math.round((Date.now() - existing.ts) / 1000)}s ago) — ignoring duplicate /${kind}.`,
      { html: true },
    )
    return
  }
  // Flush handoff first — if we crash between here and the restart the
  // worst case is the next boot has no briefing, which is the intent anyway.
  const agentDir = resolveAgentDirFromEnv()
  const flushed = agentDir != null ? flushAgentHandoff(agentDir) : 0

  const chatId = String(ctx.chat!.id)
  const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
  const ackText = kind === 'new'
    ? buildNewSessionAckText(name, flushed > 0)
    : buildResetSessionAckText(name, flushed > 0)
  let ackId: number | null = null
  try {
    const sent = await lockedBot.api.sendMessage(chatId, ackText, {
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(threadId != null ? { message_thread_id: threadId } : {}),
    })
    ackId = sent.message_id
    if (HISTORY_ENABLED) {
      try { recordOutbound({ chat_id: chatId, thread_id: threadId ?? null, message_ids: [sent.message_id], texts: [ackText], attachment_kinds: [] }) } catch {}
    }
  } catch {}
  writeRestartMarker({ chat_id: chatId, thread_id: threadId ?? null, ack_message_id: ackId, ts: Date.now() })

  // Force-fresh-session marker: tell start.sh to skip --continue on next
  // boot so the user actually gets a new Claude session (and therefore a
  // SessionStart greeting). Flushing .handoff.md alone is not enough,
  // because start.sh auto-mode picks --continue whenever the JSONL
  // session file still exists under ~/.claude/projects/<slug>/. The
  // marker is consumed (removed) by start.sh on that one boot, so normal
  // resume behavior returns immediately after.
  if (agentDir != null) {
    try {
      writeFileSync(join(agentDir, '.force-fresh-session'), `${kind} at ${new Date().toISOString()}\n`, 'utf8')
    } catch (err) {
      process.stderr.write(`telegram gateway: failed to write force-fresh marker: ${err}\n`)
    }
  }

  await sweepBeforeSelfRestart()
  spawnSwitchroomDetached(
    ['agent', 'restart', name, '--force'],
    notifyDetachedFailure(chatId, threadId ?? null, `${kind} ${name}`),
  )
}

bot.command('new', async ctx => handleNewOrResetCommand(ctx, 'new'))
bot.command('reset', async ctx => handleNewOrResetCommand(ctx, 'reset'))

// ─── /approve, /deny, /pending ────────────────────────────────────────────
// Slash-command alternatives to the inline-button approval flow (useful for
// desktop-only sessions and power-users). Share pendingPermissions state
// with the button handler; emit the same `permission` IPC broadcast.
function isValidPermissionRequestId(id: string): boolean {
  return /^[a-z0-9-]{1,32}$/.test(id)
}

async function handlePermissionSlash(ctx: Context, behavior: 'allow' | 'deny'): Promise<void> {
  if (!isAuthorizedSender(ctx)) return
  const access = loadAccess()
  const senderId = String(ctx.from?.id ?? '')
  if (!access.allowFrom.includes(senderId)) {
    await switchroomReply(ctx, 'Not authorized to answer permission prompts.')
    return
  }
  const raw = (ctx.match ?? '').trim()
  let request_id = raw
  if (!request_id) {
    // Default to most-recently created pending permission. Map preserves
    // insertion order so Array.from(...).at(-1) gives us that.
    const entries = Array.from(pendingPermissions.keys())
    request_id = entries[entries.length - 1] ?? ''
  }
  if (!request_id) {
    await switchroomReply(ctx, 'No pending permission prompts right now.')
    return
  }
  // C2: sanity-check the id shape so we don't look up (or echo back)
  // arbitrary user input. Claude Code's request_ids are short alphanumeric
  // slugs; the button handler enforces /^[a-km-z]{5}$/. The slash path is
  // looser for forward compat but still rejects obvious junk.
  if (!isValidPermissionRequestId(request_id)) {
    await switchroomReply(ctx, `Invalid permission id. Expected lowercase alphanumeric / dashes up to 32 chars.`)
    return
  }
  const details = pendingPermissions.get(request_id)
  if (!details) {
    await switchroomReply(
      ctx,
      `No pending permission for id <code>${escapeHtmlForTg(request_id)}</code>. It may have already been answered or timed out.`,
      { html: true },
    )
    return
  }
  // Forward to connected bridges — same IPC the button handler uses.
  ipcServer.broadcast({ type: 'permission', requestId: request_id, behavior })
  pendingPermissions.delete(request_id)
  process.stderr.write(
    `[telegram gateway] slash-${behavior} request_id=${request_id} tool=${details.tool_name} by=${senderId}\n`,
  )
  const lbl = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  const suffix = details.tool_name ? ` (<code>${escapeHtmlForTg(details.tool_name)}</code>)` : ''
  await switchroomReply(
    ctx,
    `${lbl}${suffix} via /${behavior} <code>${escapeHtmlForTg(request_id)}</code>`,
    { html: true },
  )
}

bot.command('approve', async ctx => handlePermissionSlash(ctx, 'allow'))
bot.command('deny', async ctx => handlePermissionSlash(ctx, 'deny'))

// /pending — list current pending permission prompts with their ids, so the
// user can target a specific one via /approve <id> or /deny <id>.
// Restricted to access.allowFrom DMs to match /approve and /deny — it
// wouldn't make sense to let a group member see which permissions are
// pending when they can't actually answer them.
bot.command('pending', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const access = loadAccess()
  const senderId = String(ctx.from?.id ?? '')
  if (!access.allowFrom.includes(senderId)) {
    await switchroomReply(ctx, 'Not authorized to view pending permission prompts.')
    return
  }
  if (pendingPermissions.size === 0) {
    await switchroomReply(ctx, 'No pending permission prompts.')
    return
  }
  const lines: string[] = ['<b>Pending permission prompts</b>']
  for (const [id, details] of pendingPermissions.entries()) {
    lines.push(`• <code>${escapeHtmlForTg(id)}</code> — ${escapeHtmlForTg(details.tool_name)}`)
  }
  await switchroomReply(ctx, lines.join('\n'), { html: true })
})

bot.command('interrupt', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const name = ctx.match?.trim() || getMyAgentName()
  try { assertSafeAgentName(name) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  await runSwitchroomCommand(ctx, ['agent', 'interrupt', name], `interrupt ${name}`)
})

// Shared auto-fallback state. `lockout` is a per-process in-memory
// guard against rapid re-fire between the scheduled poll and a
// manual /authfallback trigger (see telegram-plugin/auto-fallback.ts).
let autoFallbackLockout: LockoutRecord = emptyLockout()

type AutoFallbackCheckResult =
  | { kind: 'no-action'; reason: string; decision: 'noop' | 'fallback-skipped' }
  | { kind: 'executed'; previousSlot: string; newSlot: string }
  | { kind: 'exhausted-all'; activeSlot: string }
  | { kind: 'error'; message: string }

async function runAutoFallbackCheck(opts: { trigger: 'scheduled' | 'manual' }): Promise<AutoFallbackCheckResult> {
  try {
    const agentDir = resolveAgentDirFromEnv()
    const agentName = getMyAgentName()
    const active = currentActiveSlot(agentDir)
    const quota = await fetchQuota({ claudeConfigDir: join(agentDir, '.claude') })
    const decision = evaluateFallbackTrigger({
      quota,
      activeSlot: active,
      now: Date.now(),
      lockout: autoFallbackLockout,
    })
    if (decision.action !== 'fallback') {
      return { kind: 'no-action', reason: decision.reason, decision: 'noop' }
    }
    const plan = performAutoFallback({
      agentDir,
      agentName,
      decision,
      deps: { currentActiveSlot, markSlotQuotaExhausted, fallbackToNextSlot },
    })
    const ownerChatId = loadAccess().allowFrom[0]
    if (ownerChatId) {
      try {
        await bot.api.sendMessage(ownerChatId, plan.notificationHtml, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      } catch (err) {
        process.stderr.write(`telegram gateway: auto-fallback notify failed (${opts.trigger}): ${err}\n`)
      }
    }
    if (plan.kind === 'executed') {
      try { assertSafeAgentName(plan.agentName) }
      catch {
        return { kind: 'error', message: `invalid agent name: ${plan.agentName}` }
      }
      try {
        switchroomExec(['agent', 'restart', plan.agentName])
      } catch (err) {
        process.stderr.write(`telegram gateway: auto-fallback restart failed: ${err}\n`)
      }
      autoFallbackLockout = nextLockout(plan.previousSlot, Date.now())
      return { kind: 'executed', previousSlot: plan.previousSlot, newSlot: plan.newSlot }
    }
    autoFallbackLockout = nextLockout(plan.activeSlot, Date.now())
    return { kind: 'exhausted-all', activeSlot: plan.activeSlot }
  } catch (err) {
    process.stderr.write(`telegram gateway: auto-fallback ${opts.trigger} poll error: ${err}\n`)
    return { kind: 'error', message: String((err as Error).message ?? err) }
  }
}

bot.command('authfallback', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const result = await runAutoFallbackCheck({ trigger: 'manual' })
  if (result.kind === 'executed') {
    await switchroomReply(ctx, `✅ Switched slot <code>${escapeHtmlForTg(result.previousSlot)}</code> → <code>${escapeHtmlForTg(result.newSlot)}</code>. Agent restarted.`, { html: true })
    return
  }
  if (result.kind === 'exhausted-all') {
    await switchroomReply(ctx, `🚨 All slots quota-exhausted. Run <code>/auth add</code> to attach another subscription.`, { html: true })
    return
  }
  if (result.kind === 'error') {
    await switchroomReply(ctx, `❌ /authfallback error: ${escapeHtmlForTg(result.message)}`, { html: true })
    return
  }
  await switchroomReply(ctx, `No action: ${escapeHtmlForTg(result.reason)}`, { html: true })
})

bot.command('auth', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const parts = getCommandArgs(ctx).split(/\s+/).filter(Boolean)
  const currentAgent = getMyAgentName()
  const intent = parseAuthSubCommand(parts, currentAgent)

  if (intent.kind === 'error' || intent.kind === 'usage') {
    await switchroomReply(ctx, intent.message)
    return
  }

  if (intent.kind === 'login' || intent.kind === 'reauth' || intent.kind === 'link') {
    await runSwitchroomAuthCommand(ctx, intent.cliArgs, intent.label)
    if (intent.registerReauth) pendingReauthFlows.set(String(ctx.chat!.id), { agent: intent.agent, startedAt: Date.now() })
    return
  }
  if (intent.kind === 'code') {
    await runSwitchroomCommand(ctx, intent.cliArgs, intent.label)
    pendingReauthFlows.delete(String(ctx.chat!.id))
    return
  }
  if (intent.kind === 'cancel') {
    await runSwitchroomCommand(ctx, intent.cliArgs, intent.label)
    pendingReauthFlows.delete(String(ctx.chat!.id))
    return
  }

  // --- Slot management verbs ---

  if (intent.kind === 'add') {
    await runSwitchroomAuthCommand(ctx, intent.cliArgs, intent.label)
    pendingReauthFlows.set(String(ctx.chat!.id), { agent: intent.agent, startedAt: Date.now() })
    return
  }

  if (intent.kind === 'use') {
    await runSwitchroomCommand(ctx, intent.cliArgs, intent.label)
    // Restart the agent so the new OAuth token is picked up.
    try { assertSafeAgentName(intent.agent) } catch { return }
    await runSwitchroomCommand(ctx, ['agent', 'restart', intent.agent], `restart ${intent.agent}`)
    return
  }

  if (intent.kind === 'list') {
    await runSwitchroomCommandFormatted(ctx, intent.cliArgs, intent.label, () => {
      const data = switchroomExecJson<SlotListingFromCli>(intent.cliArgs)
      if (!data) return null
      return formatSlotList({ ...data, agent: data.agent ?? intent.agent })
    })
    return
  }

  if (intent.kind === 'rm') {
    // Safety check against current slot listing unless --force.
    if (!intent.force) {
      const listing = switchroomExecJson<SlotListingFromCli>(['auth', 'list', intent.agent, '--json'])
      if (listing) {
        const err = checkRemoveSafety({ ...listing, agent: listing.agent ?? intent.agent }, intent.slot, intent.force)
        if (err) { await switchroomReply(ctx, err); return }
      }
    }
    await runSwitchroomCommand(ctx, intent.cliArgs, intent.label)
    return
  }

  // intent.kind === 'status' — render the inline-keyboard dashboard.
  // For the dashboard we're the bot-bound agent: we don't list every
  // agent in the switchroom config; we show THIS bot's agent with its
  // slots and actions.
  await sendAuthDashboard(ctx, intent.agent ?? currentAgent)
})

/**
 * Gather DashboardState for an agent and send the dashboard as a fresh
 * message (on `/auth` command) or editMessageText (on callback refresh).
 *
 * Implementation note: we could poll fetchQuota here to populate the
 * fiveHour/sevenDay utilization per slot. Skipping for the initial
 * landing — quota-check is expensive (one Anthropic API call per poll)
 * and the background auto-fallback already surfaces quota-exhausted
 * state. Dashboard renders the CLI-side health badges and omits
 * utilization numbers when they're absent; a future PR can wire
 * quota-check in.
 */
async function sendAuthDashboard(
  ctx: Context,
  agent: string,
  opts: { edit?: boolean } = {},
): Promise<void> {
  const state = fetchDashboardState(agent)
  if (!state) {
    await switchroomReply(
      ctx,
      `<b>/auth</b> — no data (agent "${escapeHtmlForTg(agent)}" missing from switchroom.yaml or CLI unreachable)`,
      { html: true },
    )
    return
  }
  const { text, keyboard } = buildDashboard(state)
  if (opts.edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } })
      return
    } catch {
      // Message may have been deleted or identical content
      // (editMessageText throws MESSAGE_NOT_MODIFIED) — fall through
      // to sending a new one.
    }
  }
  await switchroomReply(ctx, text, { html: true, reply_markup: keyboard })
}

function fetchDashboardState(agent: string): DashboardState | null {
  // Slots come from switchroom auth list --json.
  let slots: DashboardSlot[] = []
  try {
    const listing = switchroomExecJson<SlotListingFromCli>(['auth', 'list', agent, '--json'])
    if (listing && Array.isArray(listing.slots)) {
      slots = listing.slots.map((s) => ({
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

  // Plan + bank come from switchroom auth status for THIS agent.
  let plan: string | null = null
  let bankId = agent
  try {
    type AuthStatusResp = { agents: Array<{ name: string; subscription_type: string | null; rate_limit_tier?: string | null }> }
    const statusData = switchroomExecJson<AuthStatusResp>(['auth', 'status'])
    const thisAgent = statusData?.agents?.find((a) => a.name === agent)
    if (thisAgent?.subscription_type) plan = thisAgent.subscription_type
  } catch {
    /* best-effort */
  }

  return {
    agent,
    bankId,
    plan,
    slots,
    quotaHot: isQuotaHot(slots),
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
}

/**
 * Handle a callback_query from an auth dashboard button. Parses the
 * callback_data, runs the matching action, acknowledges the tap with a
 * toast, and refreshes the dashboard in-place via editMessageText.
 */
async function handleAuthDashboardCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? ''
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  const action = parseCallbackData(data)

  switch (action.kind) {
    case 'refresh': {
      await ctx.answerCallbackQuery({ text: 'Refreshed' }).catch(() => {})
      await sendAuthDashboard(ctx, action.agent, { edit: true })
      return
    }
    case 'reauth': {
      await ctx.answerCallbackQuery({ text: 'Starting reauth…' }).catch(() => {})
      await runSwitchroomAuthCommand(
        ctx,
        action.slot ? ['auth', 'reauth', action.agent, '--slot', action.slot] : ['auth', 'reauth', action.agent],
        `auth reauth ${action.agent}`,
      )
      pendingReauthFlows.set(String(ctx.chat!.id), { agent: action.agent, startedAt: Date.now() })
      return
    }
    case 'add': {
      await ctx.answerCallbackQuery({ text: 'Adding slot…' }).catch(() => {})
      await runSwitchroomAuthCommand(ctx, ['auth', 'add', action.agent], `auth add ${action.agent}`)
      pendingReauthFlows.set(String(ctx.chat!.id), { agent: action.agent, startedAt: Date.now() })
      return
    }
    case 'use': {
      await ctx.answerCallbackQuery({ text: `Switching to ${action.slot}…` }).catch(() => {})
      await runSwitchroomCommand(ctx, ['auth', 'use', action.agent, action.slot], `auth use ${action.agent} ${action.slot}`)
      try { assertSafeAgentName(action.agent) } catch { return }
      await runSwitchroomCommand(ctx, ['agent', 'restart', action.agent], `restart ${action.agent}`)
      await sendAuthDashboard(ctx, action.agent, { edit: true })
      return
    }
    case 'rm': {
      // Two-step confirm — swap the dashboard keyboard for a
      // confirmation keyboard before doing anything destructive.
      await ctx.answerCallbackQuery({ text: `Confirm remove ${action.slot}?` }).catch(() => {})
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: buildRemoveConfirmKeyboard(action.agent, action.slot) })
      } catch { /* ignore */ }
      return
    }
    case 'confirm-rm': {
      await ctx.answerCallbackQuery({ text: `Removing ${action.slot}…` }).catch(() => {})
      const listing = switchroomExecJson<SlotListingFromCli>(['auth', 'list', action.agent, '--json'])
      if (listing) {
        const err = checkRemoveSafety({ ...listing, agent: listing.agent ?? action.agent }, action.slot, false)
        if (err) {
          await switchroomReply(ctx, err)
          await sendAuthDashboard(ctx, action.agent, { edit: true })
          return
        }
      }
      await runSwitchroomCommand(ctx, ['auth', 'rm', action.agent, action.slot], `auth rm ${action.agent} ${action.slot}`)
      await sendAuthDashboard(ctx, action.agent, { edit: true })
      return
    }
    case 'fallback': {
      await ctx.answerCallbackQuery({ text: 'Triggering fallback…' }).catch(() => {})
      const result = await runAutoFallbackCheck({ trigger: 'manual' })
      if (result.kind === 'executed') {
        await switchroomReply(ctx, `✅ Switched <code>${escapeHtmlForTg(result.previousSlot)}</code> → <code>${escapeHtmlForTg(result.newSlot)}</code>.`, { html: true })
      } else if (result.kind === 'exhausted-all') {
        await switchroomReply(ctx, `🚨 All slots quota-exhausted. Tap ➕ Add slot.`, { html: true })
      } else if (result.kind === 'error') {
        await switchroomReply(ctx, `❌ Fallback error: ${escapeHtmlForTg(result.message)}`, { html: true })
      } else {
        await switchroomReply(ctx, `No action: ${escapeHtmlForTg(result.reason)}`, { html: true })
      }
      await sendAuthDashboard(ctx, action.agent, { edit: true })
      return
    }
    case 'usage': {
      await ctx.answerCallbackQuery({ text: 'Fetching quota…' }).catch(() => {})
      const agentDir = resolveAgentDirFromEnv()
      try {
        const quota = await fetchQuota({ claudeConfigDir: join(agentDir, '.claude') })
        if (!quota.ok) {
          await switchroomReply(ctx, `<b>Quota:</b> ${escapeHtmlForTg(quota.reason)}`, { html: true })
        } else {
          await switchroomReply(ctx, formatQuotaBlock(quota.data), { html: true })
        }
      } catch (err) {
        await switchroomReply(ctx, `Quota fetch failed: ${escapeHtmlForTg(String(err))}`, { html: true })
      }
      return
    }
    case 'noop':
    default: {
      await ctx.answerCallbackQuery().catch(() => {})
      return
    }
  }
}

bot.command('reauth', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const raw = getCommandArgs(ctx).trim()
  const name = getMyAgentName()
  const chatId = String(ctx.chat!.id)
  if (!raw) {
    await runSwitchroomAuthCommand(ctx, ['auth', 'reauth', name], `auth reauth ${name}`)
    pendingReauthFlows.set(chatId, { agent: name, startedAt: Date.now() })
    return
  }
  if (raw.startsWith('http') || looksLikeAuthCode(raw)) {
    await runSwitchroomCommand(ctx, ['auth', 'code', name, raw], `auth code ${name}`)
    pendingReauthFlows.delete(chatId)
    return
  }
  // raw is treated as an agent name
  try { assertSafeAgentName(raw) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  await runSwitchroomAuthCommand(ctx, ['auth', 'reauth', raw], `auth reauth ${raw}`)
  pendingReauthFlows.set(chatId, { agent: raw, startedAt: Date.now() })
})

bot.command('vault', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const chatId = String(ctx.chat!.id)
  const args = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean)
  const sub = args[0]?.toLowerCase()
  const key = args[1]
  if (!sub || sub === 'help') {
    await switchroomReply(ctx, [
      '<b>Vault commands</b>',
      '/vault list — list all secret keys',
      '/vault get &lt;key&gt; — read a secret value',
      '/vault set &lt;key&gt; — set a secret',
      '/vault delete &lt;key&gt; — remove a secret',
    ].join('\n'), { html: true })
    return
  }
  if (!['list', 'get', 'set', 'delete', 'remove'].includes(sub)) {
    await switchroomReply(ctx, `Unknown vault subcommand: <code>${escapeHtmlForTg(sub)}</code>`, { html: true })
    return
  }
  if ((sub === 'get' || sub === 'delete' || sub === 'remove') && !key) { await switchroomReply(ctx, `Usage: /vault ${sub} &lt;key&gt;`, { html: true }); return }
  if (sub === 'set' && !key) { await switchroomReply(ctx, 'Usage: /vault set &lt;key&gt;', { html: true }); return }

  const cached = vaultPassphraseCache.get(chatId)
  const passphrase = cached && cached.expiresAt > Date.now() ? cached.passphrase : undefined
  if (!passphrase) {
    const opSub = (sub === 'remove' ? 'delete' : sub) as 'list' | 'get' | 'delete' | 'set'
    pendingVaultOps.set(chatId, { kind: 'passphrase', op: opSub, key, startedAt: Date.now() })
    await switchroomReply(ctx, '🔐 Send your vault passphrase:', { html: true })
    return
  }
  await executeVaultOp(ctx, chatId, (sub === 'remove' ? 'delete' : sub) as 'list' | 'get' | 'set' | 'delete', key, passphrase, undefined)
})

bot.command('topics', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  await runSwitchroomCommand(ctx, ['topics', 'list'], 'topics list')
})

bot.command('logs', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const parts = getCommandArgs(ctx).split(/\s+/).filter(Boolean)
  let name: string; let linesArg: string | undefined
  if (parts.length === 0) { name = getMyAgentName() }
  else if (parts.length === 1 && /^\d+$/.test(parts[0])) { name = getMyAgentName(); linesArg = parts[0] }
  else { name = parts[0]; linesArg = parts[1] }
  try { assertSafeAgentName(name) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  const lines = linesArg ? parseInt(linesArg, 10) : 20
  const lineCount = isNaN(lines) || lines < 1 ? 20 : Math.min(lines, 200)
  await runSwitchroomCommand(ctx, ['agent', 'logs', name, '--lines', String(lineCount)], `logs ${name}`)
})

bot.command('memory', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const query = ctx.match?.trim()
  if (!query) { await switchroomReply(ctx, 'Usage: /memory <search query>'); return }
  await runSwitchroomCommand(ctx, ['memory', 'search', query], 'memory search')
})

bot.command('usage', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const agentDir = resolveAgentDirFromEnv()
  if (!agentDir) {
    await switchroomReply(ctx, '<b>/usage:</b> cannot resolve agent dir.', { html: true })
    return
  }
  const result = await fetchQuota({ claudeConfigDir: join(agentDir, '.claude') })
  if (!result.ok) {
    await switchroomReply(ctx, `<b>/usage:</b> ${escapeHtmlForTg(result.reason)}`, { html: true })
    return
  }
  await switchroomReply(ctx, formatQuotaBlock(result.data), { html: true })
})

bot.command('doctor', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  try {
    let output: string
    try { output = switchroomExecCombined(['doctor'], 30000) }
    catch (err: unknown) { output = (err as any).stdout ?? (err as any).message ?? 'doctor failed' }
    const trimmed = stripAnsi(output).trim()
    if (!trimmed) { await switchroomReply(ctx, 'doctor: no output'); return }
    const pretty = trimmed.replace(/^( *)✓ /gm, '$1🟢 ').replace(/^( *)✗ /gm, '$1🔴 ').replace(/^( *)! /gm, '$1🟡 ')
    await switchroomReply(ctx, preBlock(formatSwitchroomOutput(pretty)), { html: true })
  } catch (err: unknown) {
    await switchroomReply(ctx, `<b>doctor failed:</b>\n${preBlock(formatSwitchroomOutput((err as any).message ?? 'unknown error'))}`, { html: true })
  }
})

bot.command('reconcile', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const arg = (ctx.match ?? '').trim() || getMyAgentName()
  try { assertSafeAgentName(arg) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  if (isSelfTargetingCommand(arg)) {
    const existing = readRestartMarker()
    if (existing && Date.now() - existing.ts < 15_000) {
      await switchroomReply(ctx, `⏳ Reconcile already in progress — ignoring duplicate.`, { html: true })
      return
    }
    const chatId = String(ctx.chat!.id)
    const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
    const ackText = `🔁 Reconciling <b>${escapeHtmlForTg(arg)}</b> and restarting…`
    try {
      const sent = await lockedBot.api.sendMessage(chatId, ackText, {
        parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(threadId != null ? { message_thread_id: threadId } : {}),
      })
      if (HISTORY_ENABLED) { try { recordOutbound({ chat_id: chatId, thread_id: threadId ?? null, message_ids: [sent.message_id], texts: [ackText], attachment_kinds: [] }) } catch {} }
    } catch {}
    writeRestartMarker({ chat_id: chatId, thread_id: threadId ?? null, ack_message_id: null, ts: Date.now() })
    await sweepBeforeSelfRestart()
    spawnSwitchroomDetached(
      ['agent', 'reconcile', arg, '--restart'],
      notifyDetachedFailure(chatId, threadId ?? null, `reconcile ${arg}`),
    )
    return
  }
  await runSwitchroomCommand(ctx, ['agent', 'reconcile', arg, '--restart'], `reconcile ${arg}`)
})

bot.command('grant', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const parts = getCommandArgs(ctx).split(/\s+/).filter(Boolean)
  if (parts.length === 0) { await switchroomReply(ctx, 'Usage: /grant <tool>  or  /grant <agent> <tool>'); return }
  let agentName: string; let tool: string
  if (parts.length === 1) { agentName = getMyAgentName(); tool = parts[0] }
  else { agentName = parts[0]; tool = parts.slice(1).join(' ') }
  try { assertSafeAgentName(agentName) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  await runSwitchroomCommand(ctx, ['agent', 'grant', agentName, tool], `grant ${agentName} ${tool}`)
})

bot.command('dangerous', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const parts = getCommandArgs(ctx).split(/\s+/).filter(Boolean)
  let agentName: string; let off = false
  if (parts.length === 0) { agentName = getMyAgentName() }
  else if (parts.length === 1 && parts[0] === 'off') { agentName = getMyAgentName(); off = true }
  else { agentName = parts[0]; if (parts[1] === 'off') off = true }
  try { assertSafeAgentName(agentName) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  const args = ['agent', 'dangerous', agentName]; if (off) args.push('--off')
  await runSwitchroomCommand(ctx, args, `dangerous ${agentName}${off ? ' off' : ''}`)
})

bot.command('permissions', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  const agentName = (ctx.match ?? '').trim() || getMyAgentName()
  try { assertSafeAgentName(agentName) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
  await runSwitchroomCommand(ctx, ['agent', 'permissions', agentName], `permissions ${agentName}`)
})

bot.command('update', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  await switchroomReply(ctx, '🔄 Running <b>switchroom update</b>… back in ~30 seconds.', { html: true })
  await sweepBeforeSelfRestart()
  const chatId = String(ctx.chat!.id)
  const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
  spawnSwitchroomDetached(
    ['update'],
    notifyDetachedFailure(chatId, threadId ?? null, 'update'),
  )
})

bot.command('switchroomhelp', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  await switchroomReply(ctx, buildSwitchroomHelpText(getMyAgentName()), { html: true })
})

async function registerSwitchroomBotCommands(): Promise<void> {
  // Slash-menu is deliberately trimmed from the full command catalogue.
  // See telegram-plugin/welcome-text.ts TELEGRAM_MENU_COMMANDS for the
  // rationale (mobile UX focus; ops primitives stay typable but out of
  // the autocomplete clutter). /switchroomhelp surfaces the full list.
  await bot.api.setMyCommands(
    [...TELEGRAM_BASE_COMMANDS, ...TELEGRAM_SWITCHROOM_COMMANDS],
    { scope: { type: 'all_private_chats' } },
  )
  // Group chats don't support /start pairing, so only the switchroom
  // commands are registered there.
  await bot.api.setMyCommands(
    TELEGRAM_SWITCHROOM_COMMANDS,
    { scope: { type: 'all_group_chats' } },
  )
}

// ─── Inline-button handler (permissions) ──────────────────────────────────
// Handles `perm:(allow|deny|more):<id>` — permission request buttons
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data

  // Auth dashboard buttons (`auth:<verb>:<agent>[:<slot>]`). Route
  // through a dedicated handler that maps each action onto the
  // existing CLI invocations plus dashboard refresh.
  if (data.startsWith('auth:')) {
    await handleAuthDashboardCallback(ctx)
    return
  }

  // Permission request buttons.
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(data)
  if (!m) { await ctx.answerCallbackQuery().catch(() => {}); return }
  const access = loadAccess()
  const senderId = String(ctx.from.id)
  if (!access.allowFrom.includes(senderId)) { await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {}); return }
  const [, behavior, request_id] = m

  if (behavior === 'more') {
    const details = pendingPermissions.get(request_id)
    if (!details) { await ctx.answerCallbackQuery({ text: 'Details no longer available.' }).catch(() => {}); return }
    const { tool_name, description, input_preview } = details
    let prettyInput: string
    try { prettyInput = JSON.stringify(JSON.parse(input_preview), null, 2) } catch { prettyInput = input_preview }
    const expanded = `🔐 Permission: ${tool_name}\n\ntool_name: ${tool_name}\ndescription: ${description}\ninput_preview:\n${prettyInput}`
    const keyboard = new InlineKeyboard().text('✅ Allow', `perm:allow:${request_id}`).text('❌ Deny', `perm:deny:${request_id}`)
    await ctx.editMessageText(expanded, { reply_markup: keyboard }).catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }

  // Forward permission decision to connected bridges
  ipcServer.broadcast({
    type: 'permission',
    requestId: request_id,
    behavior: behavior as 'allow' | 'deny',
  })
  pendingPermissions.delete(request_id)
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const msg = ctx.callbackQuery.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${label}`).catch(() => {})
  }
})

// ─── Inbound message handlers ─────────────────────────────────────────────
bot.on('message:text', async ctx => { await handleInboundCoalesced(ctx, ctx.message.text, undefined) })

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await handleInbound(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      // Build download URL — token is embedded in the URL but never exposed
      // in error messages or logs (caught and sanitized below)
      const downloadUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`
      const res = await fetch(downloadUrl)
      if (!res.ok) {
        process.stderr.write(`telegram gateway: photo download failed: HTTP ${res.status}\n`)
        return undefined
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const dlPath = buildAttachmentPath({
        inboxDir: INBOX_DIR,
        telegramFilePath: file.file_path,
        fileUniqueId: best.file_unique_id,
        now: Date.now(),
      })
      mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })
      assertInsideInbox(INBOX_DIR, dlPath)
      writeFileSync(dlPath, buf, { mode: 0o600 })
      return dlPath
    } catch (err) {
      // Sanitize error to avoid leaking bot token in logs
      const msg = err instanceof Error ? err.message : 'unknown error'
      process.stderr.write(`telegram gateway: photo download failed: ${msg.replace(TOKEN!, '<REDACTED>')}\n`)
      return undefined
    }
  })
})

bot.on('message:document', async ctx => {
  const doc = ctx.message.document
  const name = safeName(doc.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(document: ${name ?? 'file'})`, undefined, { kind: 'document', file_id: doc.file_id, size: doc.file_size, mime: doc.mime_type, name })
})

bot.on('message:voice', async ctx => {
  const voice = ctx.message.voice
  await handleInbound(ctx, ctx.message.caption ?? '(voice message)', undefined, { kind: 'voice', file_id: voice.file_id, size: voice.file_size, mime: voice.mime_type })
})

bot.on('message:audio', async ctx => {
  const audio = ctx.message.audio
  const name = safeName(audio.file_name)
  await handleInbound(ctx, ctx.message.caption ?? `(audio: ${safeName(audio.title) ?? name ?? 'audio'})`, undefined, { kind: 'audio', file_id: audio.file_id, size: audio.file_size, mime: audio.mime_type, name })
})

bot.on('message:video', async ctx => {
  const video = ctx.message.video
  await handleInbound(ctx, ctx.message.caption ?? '(video)', undefined, { kind: 'video', file_id: video.file_id, size: video.file_size, mime: video.mime_type, name: safeName(video.file_name) })
})

bot.on('message:video_note', async ctx => {
  const vn = ctx.message.video_note
  await handleInbound(ctx, '(video note)', undefined, { kind: 'video_note', file_id: vn.file_id, size: vn.file_size })
})

bot.on('message:sticker', async ctx => {
  const sticker = ctx.message.sticker
  const emoji = sticker.emoji ? ` ${sticker.emoji}` : ''
  await handleInbound(ctx, `(sticker${emoji})`, undefined, { kind: 'sticker', file_id: sticker.file_id, size: sticker.file_size })
})

// ─── Error handler ────────────────────────────────────────────────────────
bot.catch(err => {
  process.stderr.write(`telegram gateway: handler error (polling continues): ${err.error}\n`)
})

// ─── Shutdown ─────────────────────────────────────────────────────────────
let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('telegram gateway: shutting down\n')

  // Clean up all timers and pending state.
  // Snapshot timer handles before clearing so a late-firing timer can't
  // invalidate the iterator by deleting its own entry during cleanup.
  for (const iv of [...typingIntervals.values()]) clearInterval(iv)
  typingIntervals.clear()
  for (const t of [...typingRetryTimers.values()]) clearTimeout(t)
  typingRetryTimers.clear()

  for (const t of [...coalesceBuffer.values()].map((e) => e.timer)) clearTimeout(t)
  coalesceBuffer.clear()

  clearInterval(pendingStateReaper)
  pendingReauthFlows.clear()
  pendingVaultOps.clear()
  pendingPermissions.clear()
  vaultPassphraseCache.clear()

  if (orphanedReplyTimeoutId != null) {
    clearTimeout(orphanedReplyTimeoutId)
    orphanedReplyTimeoutId = null
  }

  // Notify bridges and close IPC
  ipcServer.broadcast({ type: 'status', status: 'gateway_shutting_down' })
  await ipcServer.close()

  // Safety net: force exit after 3 seconds if graceful stop hangs
  const forceExitTimer = setTimeout(() => process.exit(0), 3000)
  forceExitTimer.unref()

  try {
    if (runnerHandle != null) {
      await runnerHandle.stop()
    } else {
      await bot.stop()
    }
  } catch (err) {
    process.stderr.write(`telegram gateway: error during bot stop: ${err}\n`)
  }
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

// ─── Stale reaction sweep (gateway crash recovery) ────────────────────────
{
  const startupAgentDir = resolveAgentDirFromEnv()
  if (startupAgentDir != null) {
    void sweepActiveReactions(
      startupAgentDir,
      (chatId, messageId) => lockedBot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: '👍' as ReactionTypeEmoji['emoji'] }]),
      { log: (msg) => process.stderr.write(`telegram gateway: startup reaction sweep — ${msg}\n`) },
    )
  }
}

// ─── Progress card driver ─────────────────────────────────────────────────
if (streamMode === 'checklist') {
  const startupAgentDir = resolveAgentDirFromEnv()
  if (startupAgentDir != null) {
    void sweepActivePins(
      startupAgentDir,
      (chatId, messageId) => lockedBot.api.unpinChatMessage(chatId, messageId),
      { log: (msg) => process.stderr.write(`telegram gateway: startup pin sweep — ${msg}\n`) },
    )
  }

  // Pin lifecycle: extracted to progress-card-pin-manager.ts. The manager
  // owns the `progressPinnedMsgIds` map, the `unpinnedTurnKeys` dedupe
  // set, the active-pins sidecar calls, and the pin/unpin API wiring —
  // previously all inline here.
  const pinMgr = createPinManager({
    pin: (chatId, messageId, opts) => lockedBot.api.pinChatMessage(chatId, messageId, opts),
    unpin: (chatId, messageId) => lockedBot.api.unpinChatMessage(chatId, messageId),
    deleteMessage: (chatId, messageId) => lockedBot.api.deleteMessage(chatId, messageId),
    addPin: (entry) => {
      const agentDir = resolveAgentDirFromEnv()
      if (agentDir != null) addActivePin(agentDir, entry)
    },
    removePin: (chatId, messageId) => {
      const agentDir = resolveAgentDirFromEnv()
      if (agentDir != null) removeActivePin(agentDir, chatId, messageId)
    },
    log: (line) => process.stderr.write(line),
  })

  bot.on('message:pinned_message', async ctx => {
    const chatId = String(ctx.chat.id)
    const serviceMessageId = ctx.message.message_id
    const pinned = ctx.message.pinned_message
    if (!pinned) return
    pinMgr.captureServiceMessage({
      chatId,
      pinnedMessageId: pinned.message_id,
      serviceMessageId,
    })
  })

  unpinProgressCardForChat = (chatId: string, threadId: number | undefined): void => {
    pinMgr.unpinForChat(chatId, threadId)
  }

  progressDriver = createProgressDriver({
    emit: ({ chatId, threadId, turnKey, html, done, isFirstEmit }) => {
      const args = {
        chat_id: chatId, text: html, done, message_thread_id: threadId,
        lane: 'progress', format: 'html', turnKey,
      }
      handleStreamReply(args, { activeDraftStreams, activeDraftParseModes, suppressPtyPreview }, {
        bot: lockedBot, retry: robustApiCall, markdownToHtml, escapeMarkdownV2, repairEscapedWhitespace,
        takeHandoffPrefix: () => '', assertAllowedChat, resolveThreadId, disableLinkPreview: true,
        defaultFormat: 'html', logStreamingEvent, endStatusReaction,
        historyEnabled: false, recordOutbound: () => {},
        writeError: (line) => process.stderr.write(line),
      }).then((result) => {
        if (!result?.messageId) return
        pinMgr.considerPin({
          chatId,
          threadId,
          turnKey,
          messageId: result.messageId,
          isFirstEmit,
        })
      }).catch((err: Error) => {
        process.stderr.write(`telegram gateway: progress-card emit failed: ${err.message}\n`)
      })
    },
    onTurnEnd: (summary) => {
      const agentDir = resolveAgentDirFromEnv()
      if (agentDir != null) writeLastTurnSummary(agentDir, summary)
    },
    onTurnComplete: ({ chatId, threadId, turnKey, summary }) => {
      pinMgr.completeTurn({ chatId, threadId, turnKey })
      if (threadId != null) {
        lockedBot.api.sendMessage(chatId, `✅ Done — ${summary}`).catch((err: Error) => {
          process.stderr.write(`telegram gateway: completion message failed: ${err.message}\n`)
        })
      }
    },
    maxIdleMs: 5 * 60_000,
  })
  process.stderr.write('telegram gateway: progress-card driver active\n')
}

// ─── Startup ──────────────────────────────────────────────────────────────
initHandoffContinuity()

process.on('unhandledRejection', err => {
  process.stderr.write(`telegram gateway: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram gateway: uncaught exception: ${err}\n`)
})

let runnerHandle: RunnerHandle | null = null

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      // Clear any orphan long-poll from a previous gateway process
      // before we start our own. See clearStaleTelegramPollingState
      // docstring for the production incident that motivates this.
      await clearStaleTelegramPollingState(bot.api)

      const me = await bot.api.getMe()
      botUsername = me.username
      process.stderr.write(`telegram gateway: polling as @${me.username}\n`)
      if (TOPIC_ID != null) process.stderr.write(`telegram gateway: topic filter active — thread_id=${TOPIC_ID}\n`)
      void registerSwitchroomBotCommands().catch(() => {})

      // Boot-time pin sweep
      try {
        const bootAccess = loadAccess()
        const chatSet = new Set<string>(bootAccess.allowFrom)
        for (const gid of Object.keys(bootAccess.groups)) chatSet.add(gid)
        const chatIds = [...chatSet]
        if (chatIds.length > 0) {
          void sweepBotAuthoredPins(
            chatIds, me.id,
            async (chatId) => {
              const chat = await lockedBot.api.getChat(chatId)
              const pinned = (chat as { pinned_message?: { message_id: number; from?: { id: number } } }).pinned_message
              if (!pinned) return null
              return { messageId: pinned.message_id, fromId: pinned.from?.id ?? null }
            },
            (chatId, messageId) => lockedBot.api.unpinChatMessage(chatId, messageId),
            { log: (msg) => process.stderr.write(`telegram gateway: bot-authored pin sweep — ${msg}\n`) },
          ).catch(() => {})
        }
      } catch {}

      // Restart follow-up
      try {
        const marker = readRestartMarker()
        if (marker) {
          clearRestartMarker()
          const ageMs = Date.now() - marker.ts
          if (ageMs < 5 * 60_000) {
            const ageSec = Math.max(1, Math.round(ageMs / 1000))
            const text = `🎛️ Switchroom restarted — ready. (took ~${ageSec}s)`
            try {
              const sent = await lockedBot.api.sendMessage(marker.chat_id, text, {
                parse_mode: 'HTML', link_preview_options: { is_disabled: true },
                ...(marker.thread_id != null ? { message_thread_id: marker.thread_id } : {}),
                ...(marker.ack_message_id != null ? { reply_parameters: { message_id: marker.ack_message_id } } : {}),
              })
              if (HISTORY_ENABLED) { try { recordOutbound({ chat_id: marker.chat_id, thread_id: marker.thread_id, message_ids: [sent.message_id], texts: [text], attachment_kinds: [] }) } catch {} }
            } catch {}
          }
        }
      } catch {}

      // Crash recovery
      try {
        const marker = readRestartMarker()
        if (!marker) {
          const bootAccess = loadAccess()
          const ownerChatId = bootAccess.allowFrom[0]
          if (ownerChatId && HISTORY_ENABLED) {
            try {
              const recent = queryHistory({ chat_id: ownerChatId, limit: 1 })
              if (recent.length > 0) {
                const lastTs = recent[0].ts * 1000
                const downtime = Date.now() - lastTs
                if (downtime < 30 * 60_000) {
                  const downSec = Math.max(1, Math.round(downtime / 1000))
                  const text = `⚡ Recovered from unexpected restart. (down ~${downSec}s)`
                  const sent = await lockedBot.api.sendMessage(ownerChatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
                  if (HISTORY_ENABLED) { try { recordOutbound({ chat_id: ownerChatId, thread_id: null, message_ids: [sent.message_id], texts: [text], attachment_kinds: [] }) } catch {} }
                }
              }
            } catch {}
          }
        }
      } catch {}

      // Auto-fallback on quota exhaustion. Periodically polls
      // the active slot's rate-limit headers; when utilization >= 99.5%
      // or a 429 is observed, marks the slot exhausted, swaps to the
      // next healthy slot via src/auth, restarts the agent, and posts
      // a notification to the owner chat. See telegram-plugin/auto-fallback.ts
      // for the pure decision logic + notification builder.
      //
      // Default poll cadence: every 60 minutes. Set
      // SWITCHROOM_AUTO_FALLBACK_POLL_MS=0 to disable the background
      // poller (users can still trigger a check via /authfallback).
      const AUTO_FALLBACK_POLL_MS = Number(process.env.SWITCHROOM_AUTO_FALLBACK_POLL_MS ?? 60 * 60_000)
      if (AUTO_FALLBACK_POLL_MS > 0) {
        setInterval(() => { void runAutoFallbackCheck({ trigger: 'scheduled' }) }, AUTO_FALLBACK_POLL_MS).unref()
      }

      runnerHandle = run(bot)
      await runnerHandle.task()
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        process.stderr.write(`telegram gateway: 409 Conflict, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      process.stderr.write(`telegram gateway: polling failed: ${err}\n`)
      return
    }
  }
})()
