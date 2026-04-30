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
import { createTypingWrapper } from '../typing-wrap.js'
import { type DraftStreamHandle } from '../draft-stream.js'
import { allocateDraftId } from '../draft-transport.js'
import { handlePtyPartialPure, type PtyHandlerState } from '../pty-partial-handler.js'
import { handleStreamReply } from '../stream-reply-handler.js'
import { createChatLock } from '../chat-lock.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { buildAttachmentPath, assertInsideInbox } from '../attachment-path.js'
import { createPinManager } from '../progress-card-pin-manager.js'
import { createPinWatchdog } from '../progress-card-pin-watchdog.js'
import { logStreamingEvent } from '../streaming-metrics.js'
import * as signalTracker from '../turn-signal-tracker.js'
import { createAnswerStream, type AnswerStreamHandle } from '../answer-stream.js'
import { type SessionEvent } from '../session-tail.js'
import {
  createProgressDriver,
  type ApiFailureInfo,
  type ProgressDriver,
} from '../progress-card-driver.js'
import {
  shouldSuppressToolActivity,
} from '../pty-tail.js'
import { clearStaleTelegramPollingState } from '../startup-reset.js'
import { gatewayStartupRetry } from './startup-network-retry.js'
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
  recordReaction,
} from '../history.js'
import { parseQueuePrefix, parseSteerPrefix, formatPriorAssistantPreview, formatReplyToText } from '../steering.js'
import {
  renderOperatorEvent,
  shouldEmitOperatorEvent,
  type OperatorEvent,
  type OperatorEventKind,
} from '../operator-events.js'
import { recordOperatorEvent } from '../operator-events-history.js'
import { startRestartWatchdog } from './restart-watchdog.js'
import { validateStringArray } from './access-validator.js'

/**
 * Truncation cap for the `reply_to_text` channel-meta attribute (issue #119).
 * Same value as in server.ts — kept in sync because the two paths produce
 * identical envelope shapes.
 */
const REPLY_TO_TEXT_MAX = 200
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
import { recoverProseFromProgressCard } from '../turn-flush-prose-recovery.js'
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
import { fallbackToNextSlot, currentActiveSlot, type AuthCodeOutcome } from '../../src/auth/manager.js'
import { loadConfig as loadSwitchroomConfig } from '../../src/config/loader.js'
import type { AgentAudit } from '../welcome-text.js'
import { shouldSweepChatAtBoot } from './boot-sweep-filter.js'

import { createIpcServer, type IpcClient, type IpcServer } from './ipc-server.js'
import { createPollHealthCheck, type PollHealthCheckHandle } from './poll-health.js'
import type {
  ToolCallMessage,
  ToolCallResult,
  SessionEventForward,
  PermissionRequestForward,
  HeartbeatMessage,
  ScheduleRestartMessage,
  OperatorEventForward,
  InboundMessage,
} from './ipc-protocol.js'
import { writePidFile, clearPidFile } from './pid-file.js'
import { acquireStartupLock, releaseStartupLock } from './startup-mutex.js'
import { drainShutdown } from './shutdown-drain.js'
import {
  writeSessionMarker,
  readSessionMarker,
  shouldFireRestartBanner,
  type SessionMarker,
} from './session-marker.js'
import {
  writeCleanShutdownMarker,
  readCleanShutdownMarker,
  // clearCleanShutdownMarker is intentionally NOT imported here —
  // the marker is a single self-overwriting file; staleness is bounded by
  // `shouldSuppressRecoveryBanner` (DEFAULT_MAX_AGE_MS), so leaving it on
  // disk is harmless. Pre-#142 the agent-side `session-greeting.sh` did
  // the cleanup after rendering its "Restarted <reason>" row; that script
  // was deleted in #142 PR 1.
  shouldSuppressRecoveryBanner,
  resolveShutdownMarker,
  DEFAULT_MAX_AGE_MS as CLEAN_SHUTDOWN_MAX_AGE_MS,
} from './clean-shutdown-marker.js'
import { runPipeline } from '../secret-detect/pipeline.js'
import { StagingMap } from '../secret-detect/staging.js'
import { maskToken } from '../secret-detect/mask.js'
import { defaultVaultWrite, defaultVaultList } from '../secret-detect/vault-write.js'
import { detectSecrets } from '../secret-detect/index.js'
import { ADMIN_COMMAND_NAMES, parseCommandName } from '../admin-commands/index.js'
import {
  startSubagentWatcher,
  type SubagentWatcherHandle,
} from '../subagent-watcher.js'
import {
  startBootCard,
  resolvePersonaName,
  type BootCardHandle,
} from './boot-card.js'
import { determineRestartReason } from './boot-reason.js'
import { shouldSkipDuplicateBootCard, type RestartReason } from './boot-card.js'
import {
  VERSION,
  COMMIT_SHA,
  COMMIT_DATE,
  LATEST_PR,
  COMMITS_AHEAD_OF_TAG,
} from '../../src/build-info.js'
import { classifyRejection } from './unhandled-rejection-policy.js'
import {
  statusViaBroker,
  lockViaBroker,
  unlockViaBroker,
  mintGrantViaBroker,
  listViaBroker,
  listGrantsViaBroker,
  revokeGrantViaBroker,
} from '../../src/vault/broker/client.js'
import {
  openTurnsDb,
  markOrphanedAsRestarted,
  recordTurnStart,
  recordTurnEnd,
  findMostRecentInterruptedTurn,
  findRecentTurnsForChat,
} from '../registry/turns-schema.js'
import { applySubagentsSchema } from '../registry/subagents-schema.js'
import { formatIdleFooter } from '../idle-footer.js'
import { resolveCallingSubagent } from './resolve-calling-subagent.js'

// ─── Stderr logging ───────────────────────────────────────────────────────
installPluginLogger()

// ─── Env + state dir ──────────────────────────────────────────────────────
const STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const APPROVED_DIR = join(STATE_DIR, 'approved')
const ENV_FILE = join(STATE_DIR, '.env')
const INBOX_DIR = join(STATE_DIR, 'inbox')

/**
 * Format the version string shown in the boot-card ack line. Two shapes
 * matching the deleted greeting card's behavior:
 *   - on a tag (commits_ahead = 0 or null):   "v0.2.0 · #44 · 2h ago"
 *     (omit "#44 ·" when no PR was parsed)
 *   - ahead of a tag (commits_ahead > 0):     "v0.2.0+3 · db6de9e · 2m ago"
 *     (always show short SHA when ahead, omit PR)
 * Age segment is omitted if no commit date is available (npm consumer).
 */
function formatBootVersion(): string {
  const ago = formatRelativeAgo(COMMIT_DATE)
  const onTag = COMMITS_AHEAD_OF_TAG === 0 || COMMITS_AHEAD_OF_TAG === null

  if (onTag) {
    const parts: string[] = [`v${VERSION}`]
    if (LATEST_PR != null) parts.push(`#${LATEST_PR}`)
    if (ago) parts.push(ago)
    return parts.join(' · ')
  }

  const parts: string[] = [`v${VERSION}+${COMMITS_AHEAD_OF_TAG}`]
  if (COMMIT_SHA) parts.push(COMMIT_SHA)
  if (ago) parts.push(ago)
  return parts.join(' · ')
}

function formatRelativeAgo(iso: string | null): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

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

// When SWITCHROOM_AGENT_ADMIN=true (set by generateGatewayUnit when admin:true
// is configured), the gateway intercepts admin slash commands locally and never
// forwards them to Claude. When false (default), every message goes to Claude.
const AGENT_ADMIN = process.env.SWITCHROOM_AGENT_ADMIN === 'true'

// ─── Bot + chat lock ──────────────────────────────────────────────────────
const bot = new Bot(TOKEN)

// ─── sendMessageDraft boot probe ──────────────────────────────────────────
// grammY 1.x exposes all Telegram Bot API methods through bot.api.raw.
// bot.api.sendMessageDraft (the typed wrapper) takes chat_id as number, but
// answer-stream passes chatId as string, so we bridge through raw with an
// explicit Number() cast and positional → object param translation.
const _rawSendMessageDraft = (bot.api.raw as unknown as Record<string, unknown>).sendMessageDraft
const GRAMMY_VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL('../../node_modules/grammy/package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()
const sendMessageDraftFn: (
  (chatId: string, draftId: number, text: string, params?: { message_thread_id?: number }) => Promise<unknown>
) | undefined =
  typeof _rawSendMessageDraft === 'function'
    ? (chatId, draftId, text, params) =>
        (_rawSendMessageDraft as (args: Record<string, unknown>) => Promise<unknown>)({
          chat_id: Number(chatId),
          draft_id: draftId,
          text,
          ...(params ?? {}),
        })
    : undefined

// ─── sendChecklist / editMessageChecklist boot probes ─────────────────────
// grammY 1.x exposes new Telegram Bot API methods via bot.api.raw before the
// typed wrapper is generated. We probe for availability at boot so callers
// can detect degraded mode gracefully instead of throwing at call time.
const _rawSendChecklist = (bot.api.raw as unknown as Record<string, unknown>).sendChecklist
const _rawEditMessageChecklist = (bot.api.raw as unknown as Record<string, unknown>).editMessageChecklist

/** True when the connected Telegram Bot API supports native checklists. */
const CHECKLIST_API_AVAILABLE =
  typeof _rawSendChecklist === 'function' &&
  typeof _rawEditMessageChecklist === 'function'

if (!CHECKLIST_API_AVAILABLE) {
  process.stderr.write(
    `telegram gateway: sendChecklist / editMessageChecklist not available in this grammY/Bot API version (${GRAMMY_VERSION}) — checklist tools will error gracefully\n`,
  )
}

/**
 * Send a native Telegram checklist message.
 * Wraps bot.api.raw.sendChecklist with string→number coercion (chat_id) and
 * a 30-task cap enforced before the API call.
 */
async function rawSendChecklist(args: {
  chat_id: string
  title: string
  tasks: Array<{ text: string; done?: boolean }>
  message_thread_id?: number
  reply_to_message_id?: number
  protect_content?: boolean
}): Promise<{ message_id: number }> {
  if (!CHECKLIST_API_AVAILABLE) {
    throw new Error('sendChecklist is not available in this grammY/Telegram Bot API version')
  }
  const MAX_TASKS = 30
  if (args.tasks.length > MAX_TASKS) {
    throw new Error(`checklist exceeds ${MAX_TASKS}-task limit (got ${args.tasks.length})`)
  }
  const result = await (_rawSendChecklist as (p: Record<string, unknown>) => Promise<{ message_id: number }>)({
    chat_id: Number(args.chat_id),
    title: args.title,
    tasks: args.tasks.map(t => ({ text: t.text, ...(t.done != null ? { is_completed: t.done } : {}) })),
    ...(args.message_thread_id != null ? { message_thread_id: args.message_thread_id } : {}),
    ...(args.reply_to_message_id != null ? { reply_to_message_id: args.reply_to_message_id } : {}),
    ...(args.protect_content === true ? { protect_content: true } : {}),
  })
  return { message_id: result.message_id }
}

/**
 * Edit (patch) an existing Telegram checklist message.
 * Supports updating title, adding/removing tasks, and marking tasks done/undone.
 * Task objects with an `id` field target existing tasks; those without are added.
 */
async function rawEditMessageChecklist(args: {
  chat_id: string
  message_id: string
  title?: string
  tasks?: Array<{ id?: string; text?: string; done?: boolean }>
}): Promise<void> {
  if (!CHECKLIST_API_AVAILABLE) {
    throw new Error('editMessageChecklist is not available in this grammY/Telegram Bot API version')
  }
  await (_rawEditMessageChecklist as (p: Record<string, unknown>) => Promise<unknown>)({
    chat_id: Number(args.chat_id),
    message_id: Number(args.message_id),
    ...(args.title != null ? { title: args.title } : {}),
    ...(args.tasks != null
      ? {
          tasks: args.tasks.map(t => ({
            ...(t.id != null ? { id: Number(t.id) } : {}),
            ...(t.text != null ? { text: t.text } : {}),
            ...(t.done != null ? { is_completed: t.done } : {}),
          })),
        }
      : {}),
  })
}

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
    const allowFrom = validateStringArray('allowFrom', parsed.allowFrom ?? [])
    const groups: Record<string, GroupPolicy> = {}
    for (const [chatId, policy] of Object.entries(parsed.groups ?? {})) {
      groups[chatId] = {
        ...policy,
        allowFrom: validateStringArray(`groups.${chatId}.allowFrom`, policy.allowFrom ?? []),
      }
    }
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom,
      groups,
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

// ─── Turn-tracking registry (Stage 3a of simplify-restart, Phase 0 of #250) ─
// On boot, open the per-agent registry.db and stamp any rows that never got
// an ended_at as ended_via='restart'. Those are turns where the previous
// gateway died mid-flight (SIGKILL / OOM / hard reboot — any path that
// skipped the SIGTERM handler). Stages 3b/3c will populate new rows during
// turn enqueue/end and on graceful shutdown; Stage 4 reads on cold start.
let turnsDb: ReturnType<typeof openTurnsDb> | null = null
try {
  // STATE_DIR is `<agentDir>/telegram` in production. openTurnsDb expects
  // the parent (agent dir) and joins `telegram/registry.db` itself.
  const agentDir = STATE_DIR.endsWith('/telegram')
    ? STATE_DIR.slice(0, -'/telegram'.length)
    : STATE_DIR
  turnsDb = openTurnsDb(agentDir)
  // Apply subagents schema in the same DB. openTurnsDb only applies the turns
  // schema; subagents lives alongside in registry.db. Idempotent — safe on
  // pre-existing DBs (handles the jsonl_agent_id column migration).
  applySubagentsSchema(turnsDb)
  const reaped = markOrphanedAsRestarted(turnsDb)
  if (reaped > 0) {
    process.stderr.write(`telegram gateway: turn-registry boot-reaper stamped ${reaped} orphaned turn(s) as ended_via='restart'\n`)
  } else {
    process.stderr.write(`telegram gateway: turn-registry initialized at ${join(agentDir, 'telegram', 'registry.db')}\n`)
  }

  // Stage 4: surface the most-recently-interrupted turn to start.sh as a
  // shell-sourceable env file. The agent's start.sh reads this on next
  // boot, exports the env vars to the spawned `claude` process, and
  // deletes the file (one-shot — only ever applies to the immediately
  // following session). If there's no interrupted turn (clean previous
  // shutdown), we delete any stale file so the resume protocol doesn't
  // mis-fire.
  const pendingEnvPath = join(agentDir, '.pending-turn.env')
  try {
    const pending = findMostRecentInterruptedTurn(turnsDb)
    if (pending != null) {
      const lines = [
        `SWITCHROOM_PENDING_TURN=true`,
        `SWITCHROOM_PENDING_TURN_KEY=${pending.turn_key}`,
        `SWITCHROOM_PENDING_CHAT_ID=${pending.chat_id}`,
        pending.thread_id != null ? `SWITCHROOM_PENDING_THREAD_ID=${pending.thread_id}` : `SWITCHROOM_PENDING_THREAD_ID=`,
        pending.last_user_msg_id != null ? `SWITCHROOM_PENDING_USER_MSG_ID=${pending.last_user_msg_id}` : `SWITCHROOM_PENDING_USER_MSG_ID=`,
        `SWITCHROOM_PENDING_ENDED_VIA=${pending.ended_via ?? 'unknown'}`,
        `SWITCHROOM_PENDING_STARTED_AT=${pending.started_at}`,
      ]
      writeFileSync(pendingEnvPath, lines.join('\n') + '\n', { mode: 0o600 })
      process.stderr.write(`telegram gateway: pending-turn env written to ${pendingEnvPath} turnKey=${pending.turn_key} endedVia=${pending.ended_via ?? 'open'}\n`)
    } else if (existsSync(pendingEnvPath)) {
      rmSync(pendingEnvPath, { force: true })
      process.stderr.write(`telegram gateway: pending-turn env cleared (clean previous shutdown)\n`)
    }
  } catch (err) {
    process.stderr.write(`telegram gateway: pending-turn env write failed (${(err as Error).message}) — resume protocol may not fire\n`)
  }
} catch (err) {
  process.stderr.write(`telegram gateway: turn-registry init failed (${(err as Error).message}) — turn tracking disabled\n`)
  turnsDb = null
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

// Issue #416 — pre-allocated stream_reply draft id, populated on inbound DM
// receipt so the user sees a placeholder draft within ~1 s. Consumed by the
// agent's first stream_reply call (which uses this draftId instead of
// allocating a fresh one). Cleared on turn_end if the agent never called
// stream_reply. DM-only: keyed by chatId since DMs don't have threads.
interface PreAllocatedDraft {
  draftId: number
  allocatedAt: number
}
const preAllocatedDrafts = new Map<string, PreAllocatedDraft>()

let currentSessionChatId: string | null = null
let currentTurnStartedAt = 0
let currentSessionThreadId: number | undefined = undefined
let currentTurnReplyCalled = false
let currentTurnCapturedText: string[] = []
let orphanedReplyTimeoutId: ReturnType<typeof setTimeout> | null = null
// Stage 3b: per-turn registry-key (chat:thread:startTs). Set on enqueue,
// cleared after recordTurnEnd. Used by turn_end / SIGTERM / schedule_restart
// paths to stamp the right row.
let currentTurnRegistryKey: string | null = null
// Last assistant outbound message id for the current turn — populated on
// reply / stream_reply emit, captured into recordTurnEnd. Stage 4 reads
// this on resume to thread-jump back to the in-flight conversation.
let currentTurnLastAssistantMsgId: string | null = null
// Whether the current turn produced a stream_reply with done=true. The
// resume protocol uses this to decide "did the previous turn actually
// finish a reply, or was it interrupted before commit?".
let currentTurnLastAssistantDone = false
// Phase 1 of #332: count of tool_use events in the current turn, for the
// tool_call_count column in the turns registry.
let currentTurnToolCallCount = 0

// Issue #195 — answer-lane streaming.
// Lazily created on the first text event of a turn (once enough text has
// accumulated, the stream itself gates on minInitialChars). Materialized
// and cleared at turn_end. One per active turn; supersession protection
// on the answer-stream handle covers race with rapid steers/queues.
let activeAnswerStream: AnswerStreamHandle | null = null
let currentTurnIsDm = false
let currentTurnGatewayReceiveAt = 0

/**
 * Telegram chat-id convention: positive ids are private chats (DM with a
 * user; chat.id === user.id). Negative ids are groups, supergroups, or
 * channels. Used to pick the answer-stream transport without an extra
 * getChat round-trip.
 */
function isDmChatId(chatId: string | null | undefined): boolean {
  if (!chatId) return false
  const id = Number(chatId)
  return Number.isFinite(id) && id > 0
}

// Phase 1 of #332: extract the plain-text body from the channel XML wrapper
// produced by the Telegram MCP plugin. The wrapper looks like:
//   <channel source="telegram" chat_id="..." ...>user text here</channel>
// We strip the outer tag and return a ~200-char preview for the turns table.
const TURN_PREVIEW_MAX = 200
function extractUserPromptPreview(rawContent: string): string | null {
  const m = rawContent.match(/<channel[^>]*>([\s\S]*?)<\/channel>/)
  const body = m ? m[1].trim() : rawContent.trim()
  if (!body) return null
  return body.length > TURN_PREVIEW_MAX ? body.slice(0, TURN_PREVIEW_MAX) : body
}

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

const typingWrapper = createTypingWrapper({
  startTypingLoop,
  stopTypingLoop,
  isSurfaceTool: isTelegramSurfaceTool,
})

// ─── Robust API call wrapper ──────────────────────────────────────────────
// Extracted to telegram-plugin/retry-api-call.ts so it's unit-testable in
// isolation; the gateway just composes the pure policy with its own logger.
const robustApiCall = createRetryApiCall({
  log: (line) => process.stderr.write(line),
})

// ─── Structured outbound log ──────────────────────────────────────────────
function logOutbound(
  path: 'reply' | 'stream_reply' | 'backstop' | 'pty_preview' | 'edit' | 'forward' | 'answer_lane',
  chatId: string, messageId: number | null, chars: number, extra?: string,
  opts?: { turnKey?: string; formatHint?: 'html' | 'markdownv2' | 'text'; textPreview?: string },
): void {
  const ts = new Date().toISOString()
  const turnKeyPart = opts?.turnKey ? ` turnKey=${opts.turnKey}` : ''
  const formatPart = opts?.formatHint ? ` formatHint=${opts.formatHint}` : ''
  const previewPart = opts?.textPreview
    ? ` text_preview="${opts.textPreview.replace(/\n/g, '\\n').slice(0, 80)}"`
    : ''
  process.stderr.write(
    `telegram gateway [outbound] ${ts} path=${path} chat=${chatId} ` +
    `msg_id=${messageId ?? 'pending'} chars=${chars}` +
    turnKeyPart + formatPart + previewPart +
    (extra ? ` ${extra}` : '') + '\n',
  )
}

// Issue #109: when a user types just "status" or "status?" they're asking
// because the live progress surface failed to communicate. Anchored regex,
// case-insensitive, optional trailing "?" — must be the entire body.
const STATUS_QUERY_RE = /^\s*status\??\s*$/i

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
  // Issue #44: passphrase entry triggered by tapping "🔓 Unlock vault & save"
  // on a deferred-secret card. After the passphrase is cached we look up the
  // held secret by deferKey and write it directly — no re-paste required.
  | {
      kind: 'passphrase-for-deferred'
      deferKey: string
      cardChatId: string
      cardMessageId: number
      startedAt: number
    }
  // Issue #158: passphrase collected for /vault unlock — sent directly to the
  // broker unlock socket, never logged or cached beyond the op itself.
  | { kind: 'unlock'; startedAt: number }
  // Issue #227: inline-keyboard wizard for /vault grant
  | {
      kind: 'grant-wizard'
      step: 'agent' | 'keys' | 'duration' | 'confirm'
      wizardMsgId?: number      // message to edit for each step
      agent?: string
      selectedKeys?: string[]   // keys toggled on in step 2
      availableKeys?: string[]  // list fetched from broker
      ttlSeconds?: number | null // null = never expires
      expiresLabel?: string     // human-readable label for confirmation
      description?: string
      awaitingCustomDuration?: boolean  // true while waiting for text reply
      startedAt: number
    }
  // Issue #228: waiting for confirmation before revoking a grant.
  | { kind: 'revoke_confirm'; grantId: string; agent: string; keys: string[]; startedAt: number }
const VAULT_INPUT_TTL_MS = 5 * 60 * 1000
const pendingVaultOps = new Map<string, PendingVaultOp>()

// Secret-detection staging: ambiguous hits the user must confirm before we
// store/delete. Also holds the deferred "we need a passphrase before we can
// store this high-confidence hit" cases so the re-run after passphrase entry
// is seamless.
const secretStaging = new StagingMap()
interface DeferredSecret {
  chat_id: string
  original_message_id: number
  text: string
  staged_at: number
  /**
   * Slug suggested by the detector at the time we deferred the secret.
   * Captured up-front so the post-unlock auto-write doesn't have to re-run
   * detection (which would have to handle the no-detection-fired case for
   * Channel B context-rule defers — issue #44). Falls back to a generic
   * slug if detection didn't fire.
   */
  suggested_slug: string
}
const deferredSecrets = new Map<string, DeferredSecret>()
function deferredKey(chat_id: string, message_id: number): string {
  return `${chat_id}:${message_id}`
}

// Channel B context rule — tracks when the gateway has emitted the
// "Paste the browser code here" prompt so that the next inbound message
// in the same chat is treated as auth-flow-sensitive regardless of whether
// the pattern rule fires (belt-and-braces: pattern covers the known shape,
// context rule covers future shape changes).
const awaitingAuthCodeAt = new Map<string, number>()
const AUTH_CODE_CONTEXT_TTL_MS = 5 * 60_000 // 5 min — OAuth code lifetime
const DEFERRED_SECRET_TTL_MS = 24 * 60 * 60_000 // 24 h — ignored one-tap cards

// ─── TTL reaper ───────────────────────────────────────────────────────────
// Pending state maps above all grow whenever a flow starts and only shrink
// when the flow completes. Users abandoning a flow (closing Telegram, losing
// connection, hitting cancel on client) leaves entries behind. Without a
// reaper, long-running gateways leak memory across days/weeks. A single
// Maximum time to wait for an in-flight turn before forcing a pending
// restart (the `--force` SIGKILL fallback documented in the spec).
const PENDING_RESTART_DRAIN_CAP_MS = 60_000

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
  for (const [k, v] of awaitingAuthCodeAt) {
    if (now - v > AUTH_CODE_CONTEXT_TTL_MS) awaitingAuthCodeAt.delete(k)
  }
  for (const [k, v] of deferredSecrets) {
    if (now - v.staged_at > DEFERRED_SECRET_TTL_MS) deferredSecrets.delete(k)
  }
  // Drain cap: if a scheduled restart has been waiting >60s for a turn
  // to complete, force it through anyway (spec: 60s cap → SIGKILL fallback).
  for (const [agentName, requestedAt] of pendingRestarts.entries()) {
    if (now - requestedAt > PENDING_RESTART_DRAIN_CAP_MS) {
      process.stderr.write(`telegram gateway: pending restart drain cap exceeded for ${agentName} (waited ${Math.round((now - requestedAt) / 1000)}s) — forcing restart\n`)
      pendingRestarts.delete(agentName)
      try {
        spawn(
          'sh',
          [
            '-c',
            // The systemctl restart will SIGTERM then SIGKILL after TimeoutStopSec.
            // The currently-running claude process will get SIGKILL via the unit stop.
            `sleep 0.1 && systemctl --user restart switchroom-${agentName}.service switchroom-${agentName}-gateway.service`,
          ],
          { detached: true, stdio: 'ignore' },
        ).unref()
      } catch (err) {
        process.stderr.write(`telegram gateway: forced restart spawn failed for ${agentName}: ${err}\n`)
      }
    }
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

/**
 * Gateway-side emission for an OperatorEvent — the single point where:
 *   - per-agent per-kind cooldown is enforced
 *   - the event is recorded into the in-memory history (feeds /status)
 *   - the rendered card is broadcast to every chat in `access.allowFrom`
 *
 * Producers (the IPC `onOperatorEvent` handler, the boot-card crash
 * detector, the restart-watchdog) all funnel through here so the dedupe,
 * record, and post logic stays in one place.
 *
 * Each step is independently fault-tolerant — a failure to record
 * doesn't block the post; a bad send to one chat doesn't block siblings.
 */
function emitGatewayOperatorEvent(event: OperatorEvent): void {
  const { agent, kind } = event

  if (!shouldEmitOperatorEvent(agent, kind)) {
    process.stderr.write(
      `telegram gateway: operator-event suppressed (cooldown) agent=${agent} kind=${kind}\n`,
    )
    return
  }

  try {
    recordOperatorEvent(event)
  } catch (err) {
    process.stderr.write(
      `telegram gateway: recordOperatorEvent failed agent=${agent} kind=${kind}: ${(err as Error).message}\n`,
    )
  }

  let rendered: ReturnType<typeof renderOperatorEvent>
  try {
    rendered = renderOperatorEvent(event)
  } catch (err) {
    process.stderr.write(
      `telegram gateway: renderOperatorEvent failed agent=${agent} kind=${kind}: ${(err as Error).message}\n`,
    )
    return
  }

  const access = loadAccess()
  if (access.allowFrom.length === 0) {
    process.stderr.write(
      `telegram gateway: operator-event no-allowlist agent=${agent} kind=${kind} (recorded only)\n`,
    )
    return
  }

  process.stderr.write(
    `telegram gateway: operator-event posting agent=${agent} kind=${kind} to ${access.allowFrom.length} chat(s)\n`,
  )
  for (const chat_id of access.allowFrom) {
    void bot.api.sendMessage(chat_id, rendered.text, {
      parse_mode: 'HTML',
      reply_markup: rendered.keyboard,
    }).catch(e => {
      process.stderr.write(
        `telegram gateway: operator-event send to ${chat_id} failed agent=${agent} kind=${kind}: ${e}\n`,
      )
    })
  }
}

/**
 * Legacy "restarted — ready" banner, used when BOOT_CARD_ENABLED=false.
 * Kept as a safe fallback so reverting to the old behavior is one env var flip.
 */
function postLegacyBanner(
  chatId: string,
  threadId: number | undefined,
  ackMessageId: number | undefined,
  ageSec: number,
  site: string,
): void {
  const text = `🎛️ Switchroom restarted — ready. (took ~${ageSec}s)`
  process.stderr.write(`telegram gateway: ${site}: posting legacy banner chat_id=${chatId}\n`)
  lockedBot.api.sendMessage(chatId, text, {
    parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(ackMessageId != null ? { reply_parameters: { message_id: ackMessageId } } : {}),
  }).then(sent => {
    if (HISTORY_ENABLED) { try { recordOutbound({ chat_id: chatId, thread_id: threadId ?? null, message_ids: [sent.message_id], texts: [text], attachment_kinds: [] }) } catch {} }
  }).catch((err: Error) => {
    process.stderr.write(`telegram gateway: ${site}: legacy banner send failed: ${err.message}\n`)
  })
}

// ─── Progress card + session/PTY tail state ───────────────────────────────
const streamMode = process.env.SWITCHROOM_TG_STREAM_MODE ?? 'checklist'
const TURN_FLUSH_SAFETY_ENABLED = isTurnFlushSafetyEnabled()
let progressDriver: ProgressDriver | null = null
let unpinProgressCardForChat: ((chatId: string, threadId: number | undefined) => void) | null = null
let subagentWatcher: SubagentWatcherHandle | null = null

// ─── IPC server ───────────────────────────────────────────────────────────
const SOCKET_PATH = process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(STATE_DIR, 'gateway.sock')
// Ensure the directory for the socket exists
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// PID file + session marker. See pid-file.ts and session-marker.ts for
// the 2026-04-22 incident that motivates these. The PID file lets the
// in-agent plugin distinguish "gateway gone" from "socket blinked on a
// live gateway"; the session marker lets the crash-recovery banner
// distinguish a real process restart from a grammY poll-restart.
const GATEWAY_PID_PATH = process.env.SWITCHROOM_GATEWAY_PID_FILE ?? join(STATE_DIR, 'gateway.pid.json')
const GATEWAY_SESSION_MARKER_PATH = process.env.SWITCHROOM_GATEWAY_SESSION_MARKER ?? join(STATE_DIR, 'gateway-session.json')
// Separate from gateway-session.json (which fires the recovery banner on a
// real process restart) and from restart-pending.json (the user-initiated
// /restart marker carrying chat_id + ack_message_id). This one is written
// by the SIGTERM/SIGINT handler so the next boot can suppress the
// "recovered from unexpected restart" banner for planned shutdowns.
const GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH = process.env.SWITCHROOM_GATEWAY_CLEAN_SHUTDOWN_MARKER ?? join(STATE_DIR, 'clean-shutdown.json')
const GATEWAY_STARTED_AT_MS = Date.now()

// Boot card: feature flag (default on) + handle for unpinning on first turn
const BOOT_CARD_ENABLED = process.env.SWITCHROOM_BOOT_CARD !== 'false'
let activeBootCard: BootCardHandle | null = null

// Startup mutex. Atomic single-writer claim on the PID file so two
// gateway processes can't race on Telegram's getUpdates long-poll.
// See startup-mutex.ts for the 2026-04-23 incident this closes
// (clerk-gateway looped 13+ times on 409 Conflict because the OLD
// process's long-poll TCP socket hadn't FIN'd before the NEW one
// started polling).
//
// Behaviour:
//   - acquired       → we own the file, log boot.lock_acquired, continue
//   - blocked (alive holder)  → log boot.lock_blocked, exit(1).
//                                systemd's restart-burst limiter
//                                (StartLimitBurst=10/IntervalSec=60)
//                                handles the back-off so we don't
//                                hot-loop spawning processes.
//   - acquired with stale recovery → log boot.lock_stale_recovered then
//                                     boot.lock_acquired
//
// We use top-level await so the mutex resolves BEFORE any other module
// code runs (in particular before the bot.start IIFE further down).
{
  const SWITCHROOM_AGENT_NAME = process.env.SWITCHROOM_AGENT_NAME ?? '-'
  try {
    const outcome = await acquireStartupLock({
      path: GATEWAY_PID_PATH,
      record: { pid: process.pid, startedAtMs: GATEWAY_STARTED_AT_MS },
      agentName: SWITCHROOM_AGENT_NAME,
    })
    if (outcome.status === 'blocked') {
      // Another live gateway already owns the lock. Exit non-zero so
      // systemd applies its restart-burst backoff. Logging done by
      // acquireStartupLock; add one extra line so the operator sees
      // WHY we're exiting.
      process.stderr.write(
        `telegram gateway: boot.aborting another_gateway_is_live holder_pid=${outcome.holder.pid} agent=${SWITCHROOM_AGENT_NAME}\n`,
      )
      process.exit(1)
    }
    // Backwards compatibility: the non-atomic writePidFile() that this
    // block REPLACES used to log a `wrote PID file` line. Keep an
    // equivalent so anything grepping older logs still finds it.
    process.stderr.write(
      `telegram gateway: wrote PID file ${GATEWAY_PID_PATH} pid=${process.pid} startedAt=${GATEWAY_STARTED_AT_MS}\n`,
    )
  } catch (err) {
    process.stderr.write(
      `telegram gateway: boot.lock_acquire_failed err=${(err as Error).message} agent=${SWITCHROOM_AGENT_NAME}\n`,
    )
    // Fall through to the legacy non-atomic write so we don't make
    // things WORSE on filesystems where link() doesn't work (FAT, some
    // FUSE mounts). The mutex is best-effort defence-in-depth; the
    // existing pid-file probe + 409-retry loop are still in place.
    try {
      writePidFile(GATEWAY_PID_PATH, { pid: process.pid, startedAtMs: GATEWAY_STARTED_AT_MS })
      process.stderr.write(`telegram gateway: wrote PID file ${GATEWAY_PID_PATH} pid=${process.pid} startedAt=${GATEWAY_STARTED_AT_MS} (mutex-fallback)\n`)
    } catch (writeErr) {
      process.stderr.write(`telegram gateway: writePidFile failed: ${writeErr}\n`)
    }
  }
}

const ipcServer: IpcServer = createIpcServer({
  socketPath: SOCKET_PATH,

  onClientRegistered(client: IpcClient) {
    process.stderr.write(`telegram gateway: bridge registered — agent=${client.agentName}\n`)
    client.send({ type: 'status', status: 'agent_connected' })

    // If the agent reconnected after a /restart (or any restart), post a boot
    // card. The restart-marker carries the ack chat; if absent we fall back to
    // resolveBootChatId so crash-recovery reconnects also get a card.
    //
    // Skip if the boot path already posted a card this lifetime — the boot
    // path runs first (in the IIFE at end of file) and `activeBootCard` is
    // set as soon as it succeeds. Without this guard, both paths fire on a
    // single gateway start (observed: msgId 2245 + 2248 within 5s for klanker
    // at 11:19:47 on 2026-04-26). See `shouldSkipDuplicateBootCard`.
    const dedupeDecision = shouldSkipDuplicateBootCard({ activeBootCard }, 'bridge-reconnect')
    if (dedupeDecision.skip) {
      process.stderr.write(`telegram gateway: bridge-reconnect: skipping boot card (${dedupeDecision.reason})\n`)
    } else {
      const nowMs = Date.now()
      const marker = readRestartMarker()
      const cleanMarker = readCleanShutdownMarker(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH)
      const storedSession = readSessionMarker(GATEWAY_SESSION_MARKER_PATH)
      const markerAgeMs = marker ? nowMs - marker.ts : undefined

      if (marker) {
        const ageSec = Math.max(1, Math.round((markerAgeMs ?? 0) / 1000))
        process.stderr.write(`telegram gateway: bridge-reconnect: restart-marker present, chat_id=${marker.chat_id} age=${ageSec}s agent=${client.agentName}\n`)
        clearRestartMarker()
      }

      const reason = determineRestartReason({ marker, cleanMarker, sessionMarker: storedSession, now: nowMs })
      const target = resolveBootChatId(marker, markerAgeMs)

      if (target) {
        const { chatId, threadId, ackMsgId } = target
        process.stderr.write(`telegram gateway: bridge-reconnect: posting boot card reason=${reason} chat_id=${chatId} thread_id=${threadId ?? '-'} ackReply=${ackMsgId ?? '-'} boot_card=${BOOT_CARD_ENABLED}\n`)
        if (BOOT_CARD_ENABLED) {
          const agentDir = resolveAgentDirFromEnv()
          const agentSlug = process.env.SWITCHROOM_AGENT_NAME ?? client.agentName ?? '-'
          const agentDisplayName = resolvePersonaName(agentSlug)
          const botApiForCard: import('./boot-card.js').BotApiForBootCard = {
            sendMessage: (cid, text, opts) => lockedBot.api.sendMessage(cid, text, opts as Parameters<typeof lockedBot.api.sendMessage>[2]) as Promise<{ message_id: number }>,
            editMessageText: (cid, mid, text, opts) => lockedBot.api.editMessageText(cid, mid, text, opts as Parameters<typeof lockedBot.api.editMessageText>[3]),
          }
          startBootCard(chatId, threadId, botApiForCard, {
            agentName: agentDisplayName,
            agentSlug,
            version: formatBootVersion(),
            agentDir: agentDir ?? (process.env.TELEGRAM_STATE_DIR ? require('path').dirname(process.env.TELEGRAM_STATE_DIR) : '/tmp'),
            gatewayInfo: { pid: process.pid, startedAtMs: GATEWAY_STARTED_AT_MS },
            restartReason: reason,
            restartAgeMs: markerAgeMs,
          }, ackMsgId).then(handle => {
            activeBootCard = handle
          }).catch((err: Error) => {
            process.stderr.write(`telegram gateway: bridge-reconnect: boot card error: ${err.message}\n`)
          })
        } else {
          const ageSec = markerAgeMs != null ? Math.max(1, Math.round(markerAgeMs / 1000)) : 0
          postLegacyBanner(chatId, threadId, ackMsgId, ageSec, 'bridge-reconnect')
        }
      } else {
        process.stderr.write(`telegram gateway: bridge-reconnect: no known chat for boot card (reason=${reason}) — skipping\n`)
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

    // Stop coalesce timers that could emit into a finalized draft stream, but
    // preserve chats with pendingCompletion=true — those have background
    // sub-agents that legitimately outlive the parent bridge disconnect.
    // The heartbeat continues for preserved chats so elapsed-time ticks and
    // the deferred-completion-timeout path remain active. Fix for #393.
    progressDriver?.dispose({ preservePending: true })

    // Finalize any open draft streams so they don't hang mid-edit.
    for (const [key, stream] of activeDraftStreams.entries()) {
      if (!stream.isFinal()) void stream.finalize().catch(() => {})
      activeDraftStreams.delete(key)
      activeDraftParseModes.delete(key)
    }
  },

  async onToolCall(client: IpcClient, msg: ToolCallMessage): Promise<ToolCallResult> {
    process.stderr.write(`telegram gateway: ipc: tool_call tool=${msg.tool} agent=${client.agentName ?? '-'} clientId=${client.id ?? '-'} callId=${msg.id}\n`)
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

  onOperatorEvent(_client: IpcClient, msg: OperatorEventForward) {
    // Bridge has detected an Anthropic API error (or synthetic gateway-side
    // event). chatId on the wire is currently always empty — operator events
    // are agent-level, not tied to a specific user message; the helper
    // resolves the destination from `access.allowFrom`.
    emitGatewayOperatorEvent({
      kind: msg.kind as OperatorEventKind,
      agent: msg.agent,
      detail: msg.detail,
      suggestedActions: [],
      firstSeenAt: new Date(),
    })
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
  'send_checklist', 'update_checklist',
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
    case 'send_checklist':
      return executeSendChecklist(args)
    case 'update_checklist':
      return executeUpdateChecklist(args)
    default:
      throw new Error(`unknown tool: ${tool}`)
  }
}

async function executeSendChecklist(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const chat_id = args.chat_id as string
  if (!chat_id) throw new Error('send_checklist: chat_id is required')
  const title = args.title as string | undefined
  if (!title) throw new Error('send_checklist: title is required')
  const tasks = args.tasks as Array<{ text: string; done?: boolean }> | undefined
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('send_checklist: tasks must be a non-empty array')
  const threadId = args.message_thread_id != null ? Number(args.message_thread_id) : undefined
  const replyTo = args.reply_to != null ? Number(args.reply_to) : undefined
  const protectContent = args.protect_content === true

  assertAllowedChat(chat_id)

  const sent = await rawSendChecklist({
    chat_id,
    title,
    tasks,
    ...(threadId != null ? { message_thread_id: threadId } : {}),
    ...(replyTo != null ? { reply_to_message_id: replyTo } : {}),
    ...(protectContent ? { protect_content: true } : {}),
  })

  process.stderr.write(`telegram gateway: send_checklist: sent chatId=${chat_id} messageId=${sent.message_id} tasks=${tasks.length}\n`)
  return { content: [{ type: 'text', text: `checklist sent (id: ${sent.message_id})` }] }
}

async function executeUpdateChecklist(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const chat_id = args.chat_id as string
  if (!chat_id) throw new Error('update_checklist: chat_id is required')
  const message_id = args.message_id as string | undefined
  if (!message_id) throw new Error('update_checklist: message_id is required')
  const title = args.title as string | undefined
  const tasks = args.tasks as Array<{ id?: string; text?: string; done?: boolean }> | undefined

  assertAllowedChat(chat_id)

  await rawEditMessageChecklist({ chat_id, message_id, title, tasks })

  process.stderr.write(`telegram gateway: update_checklist: updated chatId=${chat_id} messageId=${message_id}\n`)
  return { content: [{ type: 'text', text: `checklist updated (id: ${message_id})` }] }
}

async function executeReply(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  const chat_id = args.chat_id as string
  if (!chat_id) throw new Error('reply: chat_id is required')
  const rawText = args.text as string | undefined
  if (rawText == null || rawText === '') throw new Error('reply: text is required and cannot be empty')
  const text = repairEscapedWhitespace(rawText)
  process.stderr.write(`telegram channel: reply: invoked chatId=${chat_id} charCount=${text.length} preview=${JSON.stringify(text.slice(0, 80))}\n`)
  const files = (args.files as string[] | undefined) ?? []
  const quoteOptIn = args.quote !== false
  let reply_to = args.reply_to != null ? Number(args.reply_to) : undefined
  const protectContent = args.protect_content === true
  const quoteText = args.quote_text as string | undefined
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
        ...(shouldReplyTo
          ? {
              reply_parameters: {
                message_id: reply_to,
                ...(quoteText != null ? { quote: { text: quoteText, position: 0 } } : {}),
              },
            }
          : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(threadId != null ? { message_thread_id: threadId } : {}),
        ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
        ...(protectContent ? { protect_content: true } : {}),
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

  // Issue #137: signal to the progress driver that an actual outbound
  // landed, so a turn-end with replyToolCalled=true but zero deliveries
  // can render the "⚠️ Reply attempted but not delivered" variant.
  if (sentIds.length > 0) {
    try {
      progressDriver?.recordOutboundDelivered(
        chat_id,
        threadId != null ? String(threadId) : undefined,
      )
    } catch { /* best-effort signal */ }
    // #203: fresh sendMessage from reply tool is a user-visible signal.
    signalTracker.noteSignal(statusKey(chat_id, threadId), Date.now())
  }

  process.stderr.write(`telegram channel: reply: finalized chatId=${chat_id} messageIds=[${sentIds.join(',')}] chunks=${chunks.length}\n`)
  return { content: [{ type: 'text', text: result }] }
}

async function executeStreamReply(args: Record<string, unknown>): Promise<unknown> {
  if (!args.chat_id) throw new Error('stream_reply: chat_id is required')
  if (args.text == null || args.text === '') throw new Error('stream_reply: text is required and cannot be empty')
  const access = loadAccess()
  // Detect chat type for draft-transport selection.
  // Private (DM) chats have positive numeric IDs; groups/channels are negative.
  // Forum topics have a message_thread_id set — sendMessageDraft is unsupported there.
  const streamChatId = args.chat_id as string
  const streamIsPrivate = isDmChatId(streamChatId)
  const streamIsForumTopic = args.message_thread_id != null && args.message_thread_id !== ''
  // Issue #416: consume any pre-allocated draft for this DM. The gateway
  // populates this map on inbound; the first stream_reply hands it off to
  // the draft-stream so the existing placeholder is edited in place rather
  // than a fresh draft being allocated and visibly flickering. Forum topics
  // never have a pre-alloc entry (gateway skips them).
  const preAllocated = streamIsPrivate ? preAllocatedDrafts.get(streamChatId) : undefined
  if (preAllocated != null) {
    preAllocatedDrafts.delete(streamChatId)
  }
  const result = await handleStreamReply(
    {
      chat_id: streamChatId,
      text: args.text as string,
      done: Boolean(args.done),
      message_thread_id: args.message_thread_id as string | undefined,
      format: args.format as string | undefined,
      reply_to: args.reply_to as string | undefined,
      quote: args.quote as boolean | undefined,
      ...(args.protect_content === true ? { protect_content: true } : {}),
      ...(args.quote_text != null ? { quote_text: args.quote_text as string } : {}),
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
      isPrivateChat: streamIsPrivate,
      isForumTopic: streamIsForumTopic,
      ...(sendMessageDraftFn != null ? { sendMessageDraft: sendMessageDraftFn } : {}),
      ...(preAllocated != null ? { preAllocatedDraftId: preAllocated.draftId } : {}),
      // Issue #310: deliver the outbound count bump BEFORE forceCompleteTurn
      // so the terminal render sees outboundDeliveredCount > 0. The handler
      // calls this dep in that order internally.
      recordOutboundDelivered: (chatId, threadId) => {
        progressDriver?.recordOutboundDelivered(
          chatId,
          threadId != null ? String(threadId) : undefined,
        )
      },
      forceCompleteTurn: (chatId, threadId) => {
        progressDriver?.forceCompleteTurn({
          chatId,
          threadId: threadId != null ? String(threadId) : undefined,
        })
      },
      historyEnabled: HISTORY_ENABLED,
      recordOutbound,
      ...(HISTORY_ENABLED ? { getLatestInboundMessageId } : {}),
      writeError: (line) => process.stderr.write(line),
      throttleMs: 600,
      progressCardActive: streamMode === 'checklist',
    },
  )
  // Issue #137: bump the per-turn outbound counter on every successful
  // stream_reply call (partial OR final). Even a single chunk landing
  // proves the delivery path worked. messageId may be null when the
  // call only updated the streaming draft and didn't sendMessage on
  // this invocation — that case still counts as activity.
  if (result.messageId != null) {
    try {
      progressDriver?.recordOutboundDelivered(
        args.chat_id as string,
        args.message_thread_id as string | undefined,
      )
    } catch { /* best-effort signal */ }
    // Issue #203: stream_reply is the agent's primary reply path. Without
    // ticking the silent-gap tracker here, turn_signal_gap reports the
    // entire turn duration as silent for any turn that uses stream_reply
    // — which per CLAUDE.md guidance is most of them. The metric would be
    // worse than no metric. Tick on every successful delivery (partial or
    // final) so the gap measurement reflects real silent intervals.
    try {
      const threadIdNum = args.message_thread_id != null
        ? Number(args.message_thread_id)
        : undefined
      signalTracker.noteSignal(
        statusKey(args.chat_id as string, threadIdNum),
        Date.now(),
      )
    } catch { /* best-effort signal */ }
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

  // Issue #305 Option A — try the card-injection path first.
  // If the call originates from a sub-agent and the parent has an active
  // pinned card, narrative lands as the sub-agent's row body. Falls through
  // to the message-send path on miss (parent-agent calls, no active card,
  // race with watcher backfill, etc).
  const agentIdHint = (typeof args.agent_id === 'string' && args.agent_id) || null
  const toolUseIdHint = (typeof args.tool_use_id === 'string' && args.tool_use_id) || null
  const subAgent = resolveCallingSubagent({
    db: turnsDb,
    chatId: chat_id,
    threadId,
    agentIdHint,
    toolUseIdHint,
  })
  if (subAgent != null && progressDriver != null) {
    const cardText = text.length > 200 ? text.slice(0, 199) + '…' : text
    const result = progressDriver.recordSubAgentNarrative({
      chatId: chat_id,
      threadId: threadId != null ? String(threadId) : undefined,
      agentId: subAgent.agentId,
      text: cardText,
    })
    if (result.ok) {
      progressUpdateLastSent.set(key, now)
      try {
        signalTracker.noteSignal(key, Date.now())
      } catch { /* best-effort signal */ }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, mode: 'card', agent_id: subAgent.agentId }),
          },
        ],
      }
    }
    // Otherwise fall through to message-send below.
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

  // Issue #203: progress_update is a user-visible signal — tick the
  // silent-gap tracker so it doesn't count as silent time.
  try {
    signalTracker.noteSignal(key, Date.now())
  } catch { /* best-effort signal */ }

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
      // Match server.ts get_recent_messages format exactly — both code paths
      // serve the same MCP tool, so the agent's parsing must not depend on
      // which entry point handled the call. See issue #119 for replyCtx;
      // reaction tag added in #297 with the server.ts format as canonical.
      const replyCtx = r.reply_to_message_id != null
        ? ` ↪️#${r.reply_to_message_id}${r.reply_to_text ? `:"${r.reply_to_text.slice(0, 60)}${r.reply_to_text.length > 60 ? '…' : ''}"` : ''}`
        : ''
      const reactionTag = r.user_reaction ? ` [reaction: ${r.user_reaction}]` : ''
      return `[${time}] ${who}${attach}${replyCtx}: ${r.text}${reactionTag}`
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
      // Drain any orphaned typing-wrap entries left over from a crashed
      // prior turn before resetting focus.
      typingWrapper.drainAll()
      if (ev.chatId) {
        // Issue #195: if a previous turn left an answer-lane stream open
        // (rapid steer/queue), force it to a new generation so its in-flight
        // edits don't mutate the new turn's message. Materialize is best-effort
        // — we don't await here because turn_end on the prior turn should
        // have already done it; this is a defensive supersession guard.
        if (activeAnswerStream != null) {
          activeAnswerStream.forceNewMessage()
          activeAnswerStream.stop()
          activeAnswerStream = null
        }
        currentSessionChatId = ev.chatId
        currentSessionThreadId = ev.threadId != null ? Number(ev.threadId) : undefined
        currentTurnReplyCalled = false
        currentTurnCapturedText = []
        currentTurnStartedAt = Date.now()
        currentTurnLastAssistantMsgId = null
        currentTurnLastAssistantDone = false
        currentTurnToolCallCount = 0
        // Stage 3b: stamp turn-start in the registry. turn_key is
        // chat:thread:startTs — unique per turn, distinct from the
        // progress-card-driver's per-chat sequence number (these are two
        // independent identifier schemes and don't need to align).
        if (turnsDb != null) {
          const turnKey = `${ev.chatId}:${ev.threadId ?? '_'}:${currentTurnStartedAt}`
          currentTurnRegistryKey = turnKey
          // Phase 1 of #332: capture first ~200 chars of the user's message.
          const userPromptPreview = extractUserPromptPreview(ev.rawContent)
          // Non-blocking: defer the DB write so it doesn't stall the turn handler.
          // The SIGTERM path writes synchronously (see shutdown handler below).
          const _db = turnsDb
          setImmediate(() => {
            try {
              recordTurnStart(_db, {
                turnKey,
                chatId: String(ev.chatId),
                threadId: ev.threadId != null ? String(ev.threadId) : null,
                lastUserMsgId: ev.messageId != null ? String(ev.messageId) : null,
                userPromptPreview,
              })
            } catch (err) {
              process.stderr.write(`telegram gateway: recordTurnStart failed turnKey=${turnKey}: ${(err as Error).message}\n`)
            }
          })
        }
        // Issue #195: capture transport selection + time-to-ack baseline
        // up-front so the per-turn answer-stream config is determined before
        // the first text event arrives.
        currentTurnIsDm = isDmChatId(ev.chatId)
        currentTurnGatewayReceiveAt = currentTurnStartedAt
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
      // Phase 1 of #332: count every tool_use in the current turn.
      currentTurnToolCallCount++
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
      if (ev.toolUseId) {
        typingWrapper.onToolUse(ev.toolUseId, currentSessionChatId, name)
      }
      return
    }
    case 'text': {
      if (currentSessionChatId != null) {
        currentTurnCapturedText.push(ev.text)
        // Issue #195: feed the answer-lane stream. The stream itself
        // gates on minInitialChars and throttles edits — short replies
        // stay below the threshold and never spawn a message.
        if (activeAnswerStream == null) {
          activeAnswerStream = createAnswerStream({
            chatId: currentSessionChatId,
            isPrivateChat: currentTurnIsDm,
            threadId: currentSessionThreadId,
            sendMessageDraft: sendMessageDraftFn,
            sendMessage: async (chatId, text, params) => {
              const msg = await bot.api.sendMessage(chatId, text, {
                parse_mode: params?.parse_mode,
                ...(params?.message_thread_id != null
                  ? { message_thread_id: params.message_thread_id }
                  : {}),
                ...(params?.link_preview_options != null
                  ? { link_preview_options: params.link_preview_options }
                  : {}),
                ...(params?.reply_parameters != null
                  ? { reply_parameters: params.reply_parameters }
                  : {}),
              })
              return { message_id: msg.message_id }
            },
            editMessageText: (chatId, messageId, text, params) =>
              bot.api.editMessageText(chatId, messageId, text, {
                parse_mode: params?.parse_mode,
                ...(params?.message_thread_id != null
                  ? { message_thread_id: params.message_thread_id }
                  : {}),
                ...(params?.link_preview_options != null
                  ? { link_preview_options: params.link_preview_options }
                  : {}),
              }),
            deleteMessage: (chatId, messageId) =>
              bot.api.deleteMessage(chatId, messageId),
            log: (msg) => process.stderr.write(`telegram gateway: ${msg}\n`),
            warn: (msg) => process.stderr.write(`telegram gateway: ${msg}\n`),
            // Issue #203: route answer-lane events through the streaming
            // metrics sink. Each successful update/edit/draft and the final
            // materialize emit one event. Also tick the silent-gap tracker
            // so answer-lane activity doesn't count as silent.
            onMetric: (ev) => {
              logStreamingEvent(ev)
              if (currentSessionChatId != null) {
                signalTracker.noteSignal(
                  statusKey(currentSessionChatId, currentSessionThreadId),
                  Date.now(),
                )
              }
            },
          })
        }
        activeAnswerStream.update(currentTurnCapturedText.join(''))
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
        // Issue #195: tear down the answer-lane stream on context-exhaustion
        // bail-out. The user is being told the session needs /restart, so any
        // partially-streamed answer would be misleading.
        if (activeAnswerStream != null) {
          activeAnswerStream.stop()
          activeAnswerStream = null
        }
        currentSessionChatId = null
        currentSessionThreadId = undefined
        currentTurnReplyCalled = false
        currentTurnCapturedText = []
      }
      return
    }
    case 'tool_result': {
      if (ev.toolUseId) typingWrapper.onToolResult(ev.toolUseId)
      return
    }
    case 'sub_agent_tool_use': {
      if (currentSessionChatId == null) return
      if (!ev.toolUseId) return
      typingWrapper.onToolUse(ev.toolUseId, currentSessionChatId, ev.toolName)
      return
    }
    case 'sub_agent_tool_result': {
      if (ev.toolUseId) typingWrapper.onToolResult(ev.toolUseId)
      return
    }
    case 'turn_end': {
      // Drain any still-pending tool dispatch typing entries — covers
      // transcript truncation or a Claude Code crash mid-tool.
      typingWrapper.drainAll()
      if (orphanedReplyTimeoutId != null) {
        clearTimeout(orphanedReplyTimeoutId)
        orphanedReplyTimeoutId = null
      }
      // Issue #195: materialize the answer-lane stream as a fresh
      // sendMessage so the user's device gets a push notification on
      // turn completion (edits don't fire pushes).
      //
      // Guard with !currentTurnReplyCalled: the existing reply path is
      // authoritative for the user-visible answer text. The agent normally
      // calls reply/stream_reply during the turn, which posts the canonical
      // message. Materializing the answer-lane on top of that produces a
      // duplicate. Only materialize when no reply tool was invoked — which
      // covers the case where the model emitted text but the agent never
      // committed it via a tool call (rare, but the JTBD wants the user to
      // see SOMETHING in that case rather than nothing).
      //
      // Either way we stop+null the stream — even when the reply path won,
      // we don't want a leaked stream lingering past turn_end.
      if (activeAnswerStream != null) {
        const stream = activeAnswerStream
        activeAnswerStream = null
        if (!currentTurnReplyCalled) {
          void stream
            .materialize()
            .catch((err) => {
              process.stderr.write(
                `telegram gateway: answer-stream materialize failed: ${
                  err instanceof Error ? err.message : String(err)
                }\n`,
              )
            })
            .finally(() => {
              stream.stop()
            })
        } else {
          // Reply path won — retract any preliminary answer-lane message
          // so the user sees only the canonical stream_reply output.
          // Issue #251: without retraction the answer-stream's raw-markdown
          // preview (sent when captured text hit the minInitialChars threshold)
          // coexists with the properly-rendered stream_reply message, producing
          // a duplicate ~26 s apart with different formatting.
          // retract() is best-effort: if deleteMessage fails the preliminary
          // message lingers but no exception escapes to break turn_end.
          void stream.retract().catch((err) => {
            process.stderr.write(
              `telegram gateway: answer-stream retract failed: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            )
          })
        }
      }
      if (currentSessionChatId == null) return
      const chatId = currentSessionChatId
      const threadId = currentSessionThreadId
      const ctrl = activeStatusReactions.get(statusKey(chatId, threadId))

      // ── #51: prose-as-step recovery ──────────────────────────────────
      // The capturedText accumulator gates push on currentSessionChatId,
      // while progressDriver.ingest uses the IPC envelope's chatHint. When
      // those views disagree, prose can land in the progress card's
      // narrative steps while capturedText stays empty — `decideTurnFlush`
      // then returns `empty-text` and the user sees nothing. Recover from
      // the card state so the flush path can send what the user already
      // sees in the step list.
      if (currentTurnCapturedText.length === 0 && progressDriver != null) {
        const peek = progressDriver.peek(
          chatId,
          threadId != null ? String(threadId) : undefined,
        )
        const recovered = recoverProseFromProgressCard(peek)
        // Issue #81 diagnostic: record both the success and the empty-recover
        // path so we can correlate "card showed tool-count" with "recovery
        // had nothing to give either". The narrative count tells us whether
        // the issue is at capture time (no narratives ever made it into the
        // state) or at parse time (narratives existed but produced empty
        // text after trim).
        const narrativeCount = peek?.narratives.length ?? 0
        if (recovered.length > 0) {
          process.stderr.write(
            `telegram gateway: turn-flush prose-recovery — recovered ${recovered.length} chars from progress-card narratives chat=${chatId} turnKey=${currentTurnStartedAt}\n`,
          )
          process.stderr.write(
            `progress-card.diag: prose-recovery hit chatId=${chatId} turnKey=${currentTurnStartedAt} ` +
            `narrative_count=${narrativeCount} recovered_len=${recovered.length}\n`,
          )
          currentTurnCapturedText.push(recovered)
        } else {
          process.stderr.write(
            `progress-card.diag: prose-recovery miss chatId=${chatId} turnKey=${currentTurnStartedAt} ` +
            `narrative_count=${narrativeCount} peek_state=${peek == null ? 'null' : 'present'}\n`,
          )
        }
      }

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
        // Ghost-reply detection (#45): the model ended a Telegram-inbound turn
        // without calling reply/stream_reply AND without emitting any assistant
        // text that the turn-flush could forward. The user will see only the
        // progress card disappear — no visible output. Log a prominent warning
        // so this silent-drop pattern is immediately visible in the logs.
        if (
          flushDecision.reason === 'empty-text' &&
          !currentTurnReplyCalled &&
          currentSessionChatId != null
        ) {
          process.stderr.write(
            `telegram gateway: WARN ghost-reply detected — turn ended with zero outbound messages` +
            ` chat=${chatId} turnStartedAt=${currentTurnStartedAt} replyCalled=false capturedText=empty` +
            ` — the progress card steps were the only thing the user saw (#45)\n`,
          )
        }
      }

      // ── Sentinel suppression (NO_REPLY / HEARTBEAT_OK) ──────────────────
      // When the model's only output is a silent-turn sentinel we must:
      //  1. NOT finalise the progress card (that would push a "Done" edit).
      //  2. NOT send any reply message to the user.
      //  3. Unpin the progress card so no orphaned ⚙️ Working… lingers.
      //  4. Log at debug level and fall through to normal state cleanup.
      if (flushDecision.kind === 'skip' && flushDecision.reason === 'silent-marker') {
        // Don't try to distinguish NO_REPLY vs HEARTBEAT_OK in the log line:
        // `isSilentFlushMarker` accepts trailing punctuation (e.g. "NO_REPLY.")
        // and case variants, so a strict equality check would print the wrong
        // reason. The flushDecision.reason is the source of truth.
        process.stderr.write(
          `telegram gateway: silent-turn-suppression: chat=${chatId} turnKey=${currentTurnStartedAt} reason=silent-marker\n`,
        )
        // Drop progress-card streams without finalising — the normal
        // closeProgressLane call below would call stream.finalize() which
        // sends a final "Done" edit to Telegram. Skip that for silent turns.
        const suppressPrefix = `${chatId}:${threadId ?? '_'}:progress`
        for (const [key] of activeDraftStreams) {
          if (key.startsWith(suppressPrefix)) {
            activeDraftStreams.delete(key)
            activeDraftParseModes.delete(key)
          }
        }
        // Unpin without editing the message so no orphaned card lingers.
        unpinProgressCardForChat?.(chatId, threadId)
        // Fall through to normal state cleanup (ctrl.setDone, purge, etc.)
        // but skip the regular closeProgressLane so we don't re-finalize.
        if (ctrl) ctrl.setDone()
        purgeReactionTracking(statusKey(chatId, threadId))
        // Match the normal turn_end path's telemetry so silent-marker turns
        // still appear in turn-duration graphs.
        {
          const sKey = streamKey(chatId, threadId)
          const turnDurationMs = currentTurnStartedAt > 0 ? Date.now() - currentTurnStartedAt : 0
          logStreamingEvent({
            kind: 'turn_end',
            chatId,
            durationMs: turnDurationMs,
            suppressClearedCount: suppressPtyPreview.has(sKey) ? 1 : 0,
          })
          // #203: compute trailing gap (last signal → turn_end) then emit.
          const tKey = statusKey(chatId, threadId)
          signalTracker.noteSignal(tKey, Date.now())
          logStreamingEvent({ kind: 'turn_signal_gap', chatId, longestGapMs: signalTracker.getLongestGap(tKey), turnDurationMs })
          signalTracker.clear(tKey)
        }
        lastPtyPreviewByChat.delete(statusKey(chatId, threadId))
        pendingPtyPartial = null
        closeActivityLane(chatId, threadId)
        // NOTE: closeProgressLane intentionally skipped — streams already dropped above.
        currentSessionChatId = null
        currentSessionThreadId = undefined
        currentTurnReplyCalled = false
        currentTurnCapturedText = []
        return
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
            unpinProgressCardForChat?.(backstopChatId, backstopThreadId)
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
        const turnDurationMs = currentTurnStartedAt > 0 ? Date.now() - currentTurnStartedAt : 0
        logStreamingEvent({
          kind: 'turn_end',
          chatId,
          durationMs: turnDurationMs,
          suppressClearedCount: suppressPtyPreview.has(sKey) ? 1 : 0,
        })
        // #203: compute trailing gap (last signal → turn_end) then emit.
        const tKey = statusKey(chatId, threadId)
        signalTracker.noteSignal(tKey, Date.now())
        logStreamingEvent({ kind: 'turn_signal_gap', chatId, longestGapMs: signalTracker.getLongestGap(tKey), turnDurationMs })
        signalTracker.clear(tKey)
      }
      lastPtyPreviewByChat.delete(statusKey(chatId, threadId))
      pendingPtyPartial = null
      closeActivityLane(chatId, threadId)
      closeProgressLane(chatId, threadId)
      // Stage 3b: stamp turn-end in the registry as endedVia='stop' (clean
      // turn_end emit). The kill paths (schedule_restart / SIGTERM) handle
      // the 'restart' / 'sigterm' cases separately in 3c.
      if (turnsDb != null && currentTurnRegistryKey != null) {
        // Phase 1 of #332: capture first ~200 chars of the assistant's reply.
        const capturedJoined = currentTurnCapturedText.join('')
        const assistantReplyPreview = capturedJoined
          ? capturedJoined.slice(0, TURN_PREVIEW_MAX)
          : null
        // Non-blocking: defer the DB write so it doesn't stall the turn handler.
        // The SIGTERM path writes synchronously (see shutdown handler below).
        const _db = turnsDb
        const _turnKey = currentTurnRegistryKey
        const _endArgs = {
          turnKey: _turnKey,
          endedVia: 'stop' as const,
          lastAssistantMsgId: currentTurnLastAssistantMsgId,
          lastAssistantDone: currentTurnLastAssistantDone,
          assistantReplyPreview,
          toolCallCount: currentTurnToolCallCount,
        }
        setImmediate(() => {
          try {
            recordTurnEnd(_db, _endArgs)
          } catch (err) {
            process.stderr.write(`telegram gateway: recordTurnEnd(stop) failed turnKey=${_turnKey}: ${(err as Error).message}\n`)
          }
        })
      }
      currentTurnRegistryKey = null
      currentSessionChatId = null
      currentSessionThreadId = undefined
      currentTurnReplyCalled = false
      currentTurnCapturedText = []
      currentTurnLastAssistantMsgId = null
      currentTurnLastAssistantDone = false
      currentTurnToolCallCount = 0
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

  // Capture wall-clock receive time for inbound_ack metric (#203).
  // Must be after gate() so early-exit paths (drop/pair) don't skew the delta.
  //
  // Measurement caveat: the `setMessageReaction` API call that posts the 👀
  // is `void`-dispatched (fire-and-forget) before the metric is logged, so
  // `ackDelayMs` measures gateway-receive → reaction-DISPATCH not
  // gateway-receive → reaction-ACKNOWLEDGED-by-Telegram. The optimistic
  // bias is one network RTT (~50–200ms typically). Acceptable for
  // ambient-signal alerting (the dominant variance is reasoning time, not
  // network RTT) but not a user-perceived end-to-end measurement.
  const inboundReceivedAt = Date.now()

  const access = result.access
  const from = ctx.from!
  const chat_id = String(ctx.chat!.id)
  const msgId = ctx.message?.message_id

  if (messageThreadId != null) chatThreadMap.set(chat_id, messageThreadId)

  // Issue #109: when the user has to ask "status?" mid-turn, the live progress
  // surface (pinned card + status reactions) has failed its job. Log the
  // event with a snapshot of the card state so we can count + analyze
  // frequency. We don't intercept the message — it still flows through to
  // the agent, since the agent may have a useful answer the card hasn't
  // surfaced yet.
  //
  // Log shape (grep anchor: "ux-failure: status-query"):
  //   ux-failure: status-query agent=<n> chat_id=<n> thread=<n|none>
  //                            card_stage=<stage> card_turn_age_s=<int>
  //                            card_items=<n> card_subagents=<n>
  //
  // `card_turn_age_s` is always a non-negative integer; `-1` is the
  // sentinel for "no active turn / driver idle" so structured-log parsers
  // (Loki, Datadog, awk) can treat the field as numeric without
  // string-comparison branches.
  if (STATUS_QUERY_RE.test(text)) {
    try {
      const threadKey = messageThreadId != null ? String(messageThreadId) : undefined
      const cardState = progressDriver?.peek(chat_id, threadKey)
      const turnAgeS = cardState?.turnStartedAt
        ? Math.max(0, Math.floor((Date.now() - cardState.turnStartedAt) / 1000))
        : -1
      const stage = cardState?.stage ?? 'idle'
      const itemCount = cardState?.items.length ?? 0
      const subAgentCount = cardState?.subAgents.size ?? 0
      const agentName = process.env.SWITCHROOM_AGENT_NAME ?? '-'
      process.stderr.write(
        `telegram gateway: ux-failure: status-query agent=${agentName} chat_id=${chat_id} thread=${threadKey ?? 'none'} ` +
        `card_stage=${stage} card_turn_age_s=${turnAgeS} card_items=${itemCount} card_subagents=${subAgentCount}\n`,
      )
    } catch (err) {
      process.stderr.write(`telegram gateway: status-query telemetry failed: ${(err as Error).message}\n`)
    }
  }

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
      const { result, errorText } = execAuthCode(pendingReauth.agent, text.trim())
      if (errorText) {
        await switchroomReply(ctx, `<b>auth code failed:</b>\n${preBlock(formatSwitchroomOutput(errorText))}`, { html: true })
      } else if (result) {
        const outcomeMsg = renderAuthCodeOutcome(result.outcome)
        if (outcomeMsg) {
          await switchroomReply(ctx, outcomeMsg, { html: true })
        } else {
          // success or no structured outcome — fall back to formatted text
          const output = result.instructions.join('\n')
          const formatted = formatAuthOutputForTelegram(output)
          await switchroomReply(ctx, formatted.text, { html: true })
        }
      }
      if (msgId != null) {
        void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
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
      } else if (pendingVault.kind === 'unlock') {
        // Issue #158: passphrase for /vault unlock — sent directly to the
        // broker unlock socket, never cached or logged.
        const passphrase = text.trim()
        if (!passphrase) {
          await switchroomReply(ctx, 'Passphrase cannot be empty. Try /vault unlock again.', { html: true })
          return
        }
        if (msgId != null) void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
        const result = await unlockViaBroker(passphrase)
        if (result.ok) {
          await switchroomReply(ctx, '🔓 Vault broker unlocked.', { html: true })
        } else {
          await switchroomReply(ctx, `<b>vault unlock failed:</b> ${escapeHtmlForTg(result.msg ?? 'unknown error')}`, { html: true })
        }
      } else if (pendingVault.kind === 'passphrase-for-deferred') {
        // Issue #44: passphrase entered after tapping "🔓 Unlock vault &
        // save" on the deferred-secret card. Cache the passphrase then
        // auto-write the held secret directly — no re-paste required.
        // The passphrase message itself is deleted so it doesn't linger
        // in chat history (same protection as the original secret got).
        const passphrase = text.trim()
        if (!passphrase) {
          await switchroomReply(ctx, 'Passphrase cannot be empty. Tap the unlock button again.', { html: true })
          return
        }
        vaultPassphraseCache.set(chat_id, { passphrase, expiresAt: Date.now() + VAULT_PASSPHRASE_TTL_MS })
        if (msgId != null) void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
        await executeDeferredSecretSave(ctx, pendingVault.deferKey, passphrase, pendingVault.cardMessageId)
      } else if (pendingVault.kind === 'grant-wizard' && pendingVault.awaitingCustomDuration) {
        // Issue #227: custom duration text reply for grant wizard
        const input = text.trim()
        const ttlSeconds = parseGrantDuration(input)
        if (ttlSeconds === null) {
          // Re-set state so user can try again
          pendingVaultOps.set(chat_id, { ...pendingVault, startedAt: Date.now() })
          await switchroomReply(ctx, '⚠️ Invalid duration. Use <code>Nd</code> (days) or <code>Nh</code> (hours), e.g. <code>30d</code> or <code>12h</code>.', { html: true })
          return
        }
        const newState = { ...pendingVault, ttlSeconds, awaitingCustomDuration: false }
        await grantWizardConfirm(ctx, chat_id, newState)
      } else if (pendingVault.kind === 'grant-wizard') {
        // Text received mid-wizard but not awaiting custom duration — ignore and re-set
        pendingVaultOps.set(chat_id, { ...pendingVault, startedAt: Date.now() })
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

  // --- Secret-detect follow-up command intercept ---
  // `stash NAME` / `ignore` / `rename X` / `forget` on a pending ambiguous
  // detection. The user is replying to our "looks like a high-entropy
  // string — reply `stash NAME` or `ignore`" prompt. We look up the most
  // recent staged detection for this chat and act on it.
  const stagedMatch = /^\s*(stash|ignore|rename|forget)\b\s*(\S+)?/i.exec(text)
  if (stagedMatch) {
    const staged = secretStaging.latestForChat(chat_id)
    if (staged != null) {
      const verb = stagedMatch[1]!.toLowerCase()
      const arg = stagedMatch[2]?.trim()
      if (verb === 'ignore' || verb === 'forget') {
        secretStaging.delete(staged.chat_id, staged.message_id)
        await switchroomReply(ctx, 'ok — ignored. nothing stored.', { html: true })
        if (msgId != null) void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
        return
      }
      if (verb === 'stash' || verb === 'rename') {
        const cached = vaultPassphraseCache.get(chat_id)
        if (!cached || cached.expiresAt <= Date.now()) {
          await switchroomReply(ctx, 'No vault passphrase cached. Run <code>/vault list</code> first (or any /vault command) to unlock, then re-send <code>stash NAME</code>.', { html: true })
          return
        }
        const slugBase = arg && arg.length > 0 ? arg : staged.detection.suggested_slug
        const listed = defaultVaultList(cached.passphrase)
        const existing = new Set(listed.ok ? listed.keys : [])
        let slug = slugBase
        let n = 2
        while (existing.has(slug)) slug = `${slugBase}_${n++}`
        const write = defaultVaultWrite(slug, staged.detection.matched_text, cached.passphrase)
        if (!write.ok) {
          await switchroomReply(ctx, `<b>vault write failed:</b>\n${preBlock(write.output)}`, { html: true })
          return
        }
        secretStaging.delete(staged.chat_id, staged.message_id)
        if (msgId != null) void bot.api.deleteMessage(chat_id, msgId).catch(() => {})
        void bot.api.deleteMessage(chat_id, staged.message_id).catch(() => {})
        await switchroomReply(ctx, `✅ stored as <code>vault:${slug}</code> (masked: <code>${maskToken(staged.detection.matched_text)}</code>)`, { html: true })
        return
      }
    }
    // No staged entry to act on — fall through to normal handling.
  }

  void bot.api.sendChatAction(chat_id, 'typing').catch(() => {})

  // Parse explicit prefixes first. `/steer ` / `/s ` opts IN to steering;
  // `/queue ` / `/q ` are legacy aliases that opt in to the new default (queued).
  const parsedSteer = parseSteerPrefix(text)
  const isSteerPrefix = parsedSteer.steering
  const parsedQueue = isSteerPrefix ? { queued: false, body: parsedSteer.body } : parseQueuePrefix(text)
  const isQueuedPrefix = parsedQueue.queued
  let effectiveText = isSteerPrefix ? parsedSteer.body : (isQueuedPrefix ? parsedQueue.body : text)

  // --- Secret detection + vault-scrub ---
  // If the user pasted a secret, intercept BEFORE we record to history or
  // broadcast to the agent: write to vault, delete the Telegram message,
  // rewrite the prompt so the downstream session .jsonl, Hindsight memory,
  // and IPC payload never see the raw bytes. If there's no cached vault
  // passphrase, high-confidence hits are deferred and the user is asked to
  // unlock first.
  //
  // FAIL-CLOSED: if the pipeline throws, drop the message and warn the user
  // — never fall through to recordInbound/broadcast with raw bytes. See
  // gateway-secret-detect.test.ts and secret-detect-fail-closed.test.ts.
  try {
    // Channel B context rule: if we emitted "Paste the browser code here"
    // recently in this chat, treat the inbound as auth-flow-sensitive —
    // high-confidence secret detection regardless of pattern match. This
    // survives Anthropic changing their token format because it tracks the
    // gateway's own prompt, not the token shape.
    const authCodeSentAt = awaitingAuthCodeAt.get(chat_id)
    const isAuthFlowContext =
      authCodeSentAt !== undefined && Date.now() - authCodeSentAt < AUTH_CODE_CONTEXT_TTL_MS
    if (isAuthFlowContext) {
      process.stderr.write(`[secret-detect] auth-flow context rule active for chat ${chat_id}\n`)
    }

    const cachedPp = vaultPassphraseCache.get(chat_id)
    const passphrase = cachedPp && cachedPp.expiresAt > Date.now() ? cachedPp.passphrase : null
    if (passphrase) {
      const pipeRes = runPipeline({
        chat_id,
        message_id: msgId ?? null,
        text: effectiveText,
        passphrase,
        vaultWrite: defaultVaultWrite,
        vaultList: defaultVaultList,
      })
      if (pipeRes.stored.length > 0) {
        effectiveText = pipeRes.rewritten_text
        if (isAuthFlowContext) {
          awaitingAuthCodeAt.delete(chat_id) // consume: one message per prompt
        }
        if (msgId != null) {
          try {
            await bot.api.deleteMessage(chat_id, msgId)
          } catch (err) {
            process.stderr.write(`[secret-detect] deleteMessage failed: ${(err as Error).message}\n`)
          }
        }
        const lines = pipeRes.stored.map((s) =>
          `• <code>${s.masked}</code> → <code>vault:${s.actual_slug}</code>`,
        )
        await switchroomReply(
          ctx,
          [`🔒 captured ${pipeRes.stored.length} secret${pipeRes.stored.length === 1 ? '' : 's'}:`, ...lines, '', 'reply <code>rename X</code> or <code>forget</code>.'].join('\n'),
          { html: true },
        )
        for (const s of pipeRes.stored) {
          secretStaging.set({
            chat_id,
            message_id: msgId ?? 0,
            detection: { ...s.detection, suggested_slug: s.actual_slug },
            staged_at: Date.now(),
          })
        }
      } else if (isAuthFlowContext && pipeRes.stored.length === 0) {
        // Channel B fallback: pattern didn't fire (Anthropic may have changed
        // the token format) but we know this is an auth code paste because we
        // prompted for it. Delete + stage + warn so no raw bytes leak.
        awaitingAuthCodeAt.delete(chat_id) // consume: one message per prompt
        if (msgId != null) {
          try { await bot.api.deleteMessage(chat_id, msgId) } catch {}
        }
        // Issue #44: even with passphrase cached we hit this branch when the
        // pattern didn't fire — but at this point a vault write would still
        // need the user's intent. Stash with a one-tap unlock+save card so
        // the post-context flow stays seamless.
        const dKey = deferredKey(chat_id, msgId ?? 0)
        const cachedBranchDetection = detectSecrets(effectiveText).find((d) => d.confidence === 'high' && !d.suppressed)
        deferredSecrets.set(dKey, {
          chat_id,
          original_message_id: msgId ?? 0,
          text: effectiveText,
          staged_at: Date.now(),
          suggested_slug: cachedBranchDetection?.suggested_slug ?? (isAuthFlowContext ? 'anthropic_oauth_code' : 'secret'),
        })
        await switchroomReply(
          ctx,
          '🔒 auth-flow secret detected. we deleted it from chat. tap below to save it to the vault — no re-paste needed.',
          { html: true, reply_markup: buildDeferredSecretKeyboard(dKey) },
        )
        return
      } else if (pipeRes.ambiguous.length > 0) {
        for (const d of pipeRes.ambiguous) {
          secretStaging.set({ chat_id, message_id: msgId ?? 0, detection: d, staged_at: Date.now() })
        }
        const top = pipeRes.ambiguous[0]!
        await switchroomReply(
          ctx,
          `👀 looks like a high-entropy string (rule: <code>${escapeHtmlForTg(top.rule_id)}</code>). reply <code>stash NAME</code> to store in vault, or <code>ignore</code>.`,
          { html: true },
        )
        // For ambiguous, we do NOT delete the message or rewrite — let the
        // user confirm first.
      }
    } else {
      // No passphrase cached — detect, but defer. Issue #44 turned this
      // into a one-tap unlock-and-save flow: previously the user had to
      // run `/vault list`, type their passphrase, then re-paste the
      // original secret (six steps for a non-technical user). Now they
      // tap a button and re-enter the passphrase exactly once.
      const detections = detectSecrets(effectiveText)
      const highConfDetection = detections.find((d) => d.confidence === 'high' && !d.suppressed)
      const hasHigh = highConfDetection !== undefined || isAuthFlowContext
      if (hasHigh) {
        if (isAuthFlowContext) {
          awaitingAuthCodeAt.delete(chat_id) // consume: one message per prompt
        }
        // Capture the slug at defer-time so the post-unlock auto-write
        // doesn't have to re-detect (which has a degenerate case for
        // Channel-B context defers where no pattern fired).
        const suggestedSlug =
          highConfDetection?.suggested_slug
          ?? (isAuthFlowContext ? 'anthropic_oauth_code' : 'secret')
        const dKey = deferredKey(chat_id, msgId ?? 0)
        deferredSecrets.set(dKey, {
          chat_id,
          original_message_id: msgId ?? 0,
          text: effectiveText,
          staged_at: Date.now(),
          suggested_slug: suggestedSlug,
        })
        if (msgId != null) {
          try { await bot.api.deleteMessage(chat_id, msgId) } catch {}
        }
        await switchroomReply(
          ctx,
          '🔒 caught a secret. we deleted it from chat. tap below to unlock the vault and save it — no re-paste needed.',
          { html: true, reply_markup: buildDeferredSecretKeyboard(dKey) },
        )
        return
      }
    }
  } catch (err) {
    // FAIL-CLOSED: if the detector throws, we must NOT fall through to
    // recordInbound() / ipcServer.broadcast() with the raw text — that
    // would stamp the secret into SQLite and emit it to the agent
    // unscrubbed. Drop the message on the floor and warn the user.
    process.stderr.write(`[secret-detect] pipeline error: ${(err as Error).message}\n`)
    try {
      await switchroomReply(
        ctx,
        '⚠️ secret-detect pipeline crashed; this message was dropped for safety. please try again or check the agent log.',
        { html: true },
      )
    } catch {}
    if (msgId != null) {
      try { await bot.api.deleteMessage(chat_id, msgId) } catch {}
    }
    return
  }

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
        // #203: time-to-ack metric — measure gateway-receive → ack-post delta.
        logStreamingEvent({ kind: 'inbound_ack', chatId: chat_id, messageId: msgId, ackDelayMs: Date.now() - inboundReceivedAt })
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
          // #203: every status-reaction transition is a user-visible signal.
          signalTracker.noteSignal(key, Date.now())
        })
        activeStatusReactions.set(key, ctrl)
        activeReactionMsgIds.set(key, { chatId: chat_id, messageId: msgId })
        activeTurnStartedAt.set(key, Date.now())
        progressUpdateTurnCount.set(key, 0)  // Reset turn counter
        ctrl.setQueued()
        // #203: time-to-ack metric — setQueued() triggers the initial 👀 reaction
        // asynchronously through the controller chain.
        logStreamingEvent({ kind: 'inbound_ack', chatId: chat_id, messageId: msgId, ackDelayMs: Date.now() - inboundReceivedAt })
        // #203: signal tracker — start tracking silent gaps for this fresh turn.
        signalTracker.reset(statusKey(chat_id, messageThreadId), Date.now())
        const agentDir = resolveAgentDirFromEnv()
        if (agentDir != null) {
          addActiveReaction(agentDir, { chatId: chat_id, messageId: msgId, threadId: messageThreadId ?? null, reactedAt: Date.now() })
        }
      }
    } else if (access.ackReaction) {
      void bot.api.setMessageReaction(chat_id, msgId, [
        { type: 'emoji', emoji: access.ackReaction as ReactionTypeEmoji['emoji'] },
      ]).catch(() => {})
      // #203: time-to-ack metric for the custom-ack-reaction path.
      logStreamingEvent({ kind: 'inbound_ack', chatId: chat_id, messageId: msgId, ackDelayMs: Date.now() - inboundReceivedAt })
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
        replyToMessageId: msgId != null ? msgId : undefined,
      })
    } catch (err) {
      process.stderr.write(`telegram gateway: progress-card startTurn failed: ${(err as Error).message}\n`)
    }

    // Issue #416 — pre-allocate a sendMessageDraft for instant visual feedback
    // in DMs. The agent's first stream_reply consumes this draft id instead
    // of allocating a new one, so the user sees a placeholder draft within
    // ~1 s. Only fires for fresh DM turns; if the agent finishes the turn
    // without calling stream_reply, turn_end clears the orphan.
    if (
      sendMessageDraftFn != null
      && isDmChatId(chat_id)
      && messageThreadId == null
      && !preAllocatedDrafts.has(chat_id)
    ) {
      const draftId = allocateDraftId()
      // Best-effort, non-blocking: any failure (transport down, API not
      // available) falls through to today's behavior.
      void sendMessageDraftFn(chat_id, draftId, '…')
        .then(() => {
          preAllocatedDrafts.set(chat_id, { draftId, allocatedAt: Date.now() })
        })
        .catch((err) => {
          process.stderr.write(
            `telegram gateway: pre-allocate draft failed chatId=${chat_id}: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          )
        })
    }
  }

  const imagePath = downloadImage ? await downloadImage() : undefined

  // Telegram-native reply context (issue #119). Same pattern as server.ts:
  // `replyToText` is raw (for SQLite); `replyToTextEscaped` is XML-escaped
  // (for channel meta).
  const replyToMsg = ctx.message?.reply_to_message
  const replyToMessageId = replyToMsg?.message_id
  const replyToTextRaw = replyToMsg
    ? (replyToMsg.text ?? replyToMsg.caption ?? undefined)
    : undefined
  const replyToText = replyToTextRaw != null
    ? (replyToTextRaw.length > REPLY_TO_TEXT_MAX
        ? replyToTextRaw.slice(0, REPLY_TO_TEXT_MAX - 1) + '…'
        : replyToTextRaw)
    : undefined
  const replyToTextEscaped = formatReplyToText(replyToTextRaw, REPLY_TO_TEXT_MAX)

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
        reply_to_message_id: replyToMessageId ?? null,
        reply_to_text: replyToText ?? null,
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
      // Telegram-native reply context (issue #119). When set, the user
      // long-pressed a prior message and chose "Reply" — the agent should
      // treat this as the antecedent for "this" / "that" / pronoun
      // references in the body, instead of asking the user what they meant.
      ...(replyToMessageId != null ? { reply_to_message_id: String(replyToMessageId) } : {}),
      // Use the XML-escaped form for the meta — the raw form is in the
      // SQLite buffer for verbatim retrieval via get_recent_messages.
      ...(replyToTextEscaped != null && replyToTextEscaped.length > 0 ? { reply_to_text: replyToTextEscaped } : {}),
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

/**
 * In-memory timestamp of the most recent planned restart written by this
 * gateway process. The restart-watchdog reads this (with a freshness
 * window) instead of `readRestartMarker()` to decide whether a NRestarts
 * uptick is user-initiated.
 *
 * The disk marker is unsafe for that purpose because the bridge-reconnect
 * handler clears it within ~1-2s of agent boot, before the next watchdog
 * tick (every 30s by default). That race made every \`/restart agent\`
 * produce a misleading "agent restarted unexpectedly" card. The in-memory
 * timestamp is set on every \`writeRestartMarker\` and survives bridge-
 * reconnect clearing, eliminating the false positive.
 *
 * 60s window is generous enough to cover systemd kill → restart →
 * bridge-reconnect (typically 2–5s) plus the next watchdog tick. After
 * 60s, any further NRestarts increment is genuinely unexpected.
 */
let lastPlannedRestartAt: number | null = null
const PLANNED_RESTART_FRESHNESS_MS = 60_000

function restartMarkerPath(): string | null {
  const agentDir = resolveAgentDirFromEnv()
  if (!agentDir) return null
  return join(agentDir, 'restart-pending.json')
}
function writeRestartMarker(marker: RestartMarker): void {
  const p = restartMarkerPath(); if (!p) return
  try {
    writeFileSync(p, JSON.stringify(marker))
    lastPlannedRestartAt = Date.now()
    process.stderr.write(`telegram gateway: restart-marker: write chat_id=${marker.chat_id} thread_id=${marker.thread_id ?? '-'} ack=${marker.ack_message_id ?? '-'} path=${p}\n`)
  } catch (err) {
    process.stderr.write(`telegram gateway: writeRestartMarker failed: ${err}\n`)
  }
}

/**
 * True when this gateway process initiated a planned restart in the last
 * `PLANNED_RESTART_FRESHNESS_MS`. Used by the restart-watchdog as the
 * authoritative "was this a /restart" signal — see `lastPlannedRestartAt`
 * comment for why the disk marker can't carry this responsibility.
 */
function isPlannedRestartFresh(now: number = Date.now()): boolean {
  if (lastPlannedRestartAt == null) return false
  return now - lastPlannedRestartAt < PLANNED_RESTART_FRESHNESS_MS
}
function readRestartMarker(): RestartMarker | null {
  const p = restartMarkerPath(); if (!p) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as RestartMarker } catch { return null }
}
function clearRestartMarker(): void {
  const p = restartMarkerPath(); if (!p) return
  try {
    rmSync(p, { force: true })
    process.stderr.write(`telegram gateway: restart-marker: cleared path=${p}\n`)
  } catch {}
}

/**
 * Resolve which Telegram chat should receive the boot card.
 *
 * Fallback chain:
 *   1. restart-pending.json chat_id (if present and fresh)
 *   2. SUBAGENT_OWNER_CHAT_ID env var
 *   3. Most recent inbound from history SQLite
 *   4. null → skip (no known chat)
 *
 * TODO: add test coverage for the history-SQLite fallback path
 */
function resolveBootChatId(
  marker: { chat_id: string; thread_id: number | null; ack_message_id: number | null; ts: number } | null,
  ageMs?: number,
): { chatId: string; threadId: number | undefined; ackMsgId: number | undefined } | null {
  // 1. Restart marker
  if (marker != null && (ageMs == null || ageMs < 5 * 60_000)) {
    return {
      chatId: marker.chat_id,
      threadId: marker.thread_id ?? undefined,
      ackMsgId: marker.ack_message_id ?? undefined,
    }
  }
  // 2. Env var
  const envChat = process.env.SUBAGENT_OWNER_CHAT_ID
  if (envChat) return { chatId: envChat, threadId: undefined, ackMsgId: undefined }
  // 3. Most-recent inbound from history
  if (HISTORY_ENABLED) {
    try {
      const access = loadAccess()
      const ownerChatId = access.allowFrom[0]
      if (ownerChatId) {
        const recent = queryHistory({ chat_id: ownerChatId, limit: 1 })
        if (recent.length > 0) return { chatId: ownerChatId, threadId: undefined, ackMsgId: undefined }
      }
    } catch {}
  }
  // 4. No known chat
  return null
}

/**
 * Stamp a user-facing restart reason into the clean-shutdown marker
 * (same file the SIGTERM handler writes to and the next session greeting
 * consumes). Called by /restart, /reconcile, /new, /reset BEFORE the
 * detached `switchroom agent restart …` CLI fires — so the agent-side
 * greeting card shows who asked ("user: /restart from chat") instead of
 * the downstream CLI's "cli: restart" default.
 *
 * Best-effort: if the write fails, the restart still proceeds. The
 * downstream CLI will fall back to its own "cli: restart" marker (the
 * CLI uses preserveExisting to avoid clobbering a fresh user marker).
 */
function stampUserRestartReason(reason: string): void {
  try {
    writeCleanShutdownMarker(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH, {
      ts: Date.now(),
      signal: 'SIGTERM',
      reason,
    })
    process.stderr.write(`telegram gateway: restart-reason.stamped reason=${JSON.stringify(reason)} path=${GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH}\n`)
  } catch (err) {
    process.stderr.write(`telegram gateway: restart-reason.stamp_failed err=${(err as Error).message}\n`)
  }
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
  // Mobile-native post-script. Two paths depending on which Anthropic
  // account the user wants to authorize:
  //
  //   (a) Button: 🔐 Open Claude auth — opens in Telegram's in-app
  //       browser (WebView) on most mobile clients. WebView has its
  //       own cookie jar, separate from the user's main browser. Fine
  //       when the WebView is already signed into the intended Claude
  //       account; wrong when it's signed into a different one.
  //
  //   (b) Long-press the URL text at the bottom of this message — every
  //       mobile Telegram client exposes "Copy Link" / "Open in
  //       Browser" / "Open in Chrome" on long-press. That's the
  //       escape hatch when you need to land in your main browser
  //       where you control which account is signed in.
  //
  // Why not a copy_text button? We tried. Telegram's CopyTextButton.text
  // field caps at 256 chars and OAuth URLs run ~320–340 chars. Result
  // was BUTTON_COPY_TEXT_INVALID. The long-press-the-URL path achieves
  // the same outcome with no API constraint. See PR #30.
  rendered.push(
    '',
    '👇 Tap <b>🔐 Open Claude auth</b> below, then <b>reply with the browser code</b>.',
    '',
    '<i>Wrong Anthropic account getting authorized? Long-press the URL below and choose "Copy Link" or "Open in Browser" — lands in your main browser where the right account is signed in, bypassing Telegram\'s in-app browser cookies.</i>',
    '',
    `<a href="${escapeHtmlForTg(url)}">${escapeHtmlForTg(url)}</a>`,
  )
  return { text: rendered.join('\n'), url }
}

/**
 * Build the inline keyboard shown under an auth-flow response that has
 * an OAuth URL. Single button:
 *
 *   [🔐 Open Claude auth]   — `url` button. On mobile Telegram clients
 *                             this typically opens in the app's in-app
 *                             browser (WebView).
 *
 * We previously tried adding a `[📋 Copy URL]` button using Telegram's
 * Bot API 7.7 `copy_text` type but it capped at 256 chars for the
 * copyable text. OAuth URLs (~320–340 chars) exceed that and produce
 * `BUTTON_COPY_TEXT_INVALID`. Instead, the message body renders the
 * URL as a tappable link; users long-press the URL text to get native
 * "Copy Link" / "Open in Browser" actions, bypassing the WebView.
 *
 * Defense in depth: this function's output is validated against
 * Telegram's real field-length constraints in
 * `telegram-plugin/tests/auth-url-keyboard-constraints.test.ts` so
 * future changes that breach a limit fail loudly at CI time rather
 * than silently in production.
 */
function buildAuthUrlKeyboard(authorizeUrl: string): InlineKeyboard {
  return new InlineKeyboard().url('🔐 Open Claude auth', authorizeUrl)
}

/**
 * Issue #44: inline keyboard offering a one-tap unlock-and-save flow for
 * a deferred secret. The two buttons fire `vd:` callback_data which the
 * dispatcher in `bot.on('callback_query:data')` routes to
 * `handleVaultDeferCallback`.
 *
 *   `vd:unlock:<deferKey>` → prompt for passphrase, then auto-write the
 *                            held secret. Replaces the legacy six-step
 *                            "/vault list → re-paste" flow.
 *   `vd:cancel:<deferKey>` → discard the deferred secret without saving.
 *
 * `deferKey` is `<chat_id>:<message_id>` (the same key as
 * `deferredSecrets.set()`). Telegram limits callback_data to 64 bytes;
 * the prefix + key fits well within that on any realistic chat id.
 */
function buildDeferredSecretKeyboard(deferKey: string): InlineKeyboard {
  const unlockData = `vd:unlock:${deferKey}`
  const cancelData = `vd:cancel:${deferKey}`
  if (unlockData.length > 64 || cancelData.length > 64) {
    process.stderr.write(
      `telegram gateway: callback_data overflow — deferKey=${deferKey} unlockLen=${unlockData.length} cancelLen=${cancelData.length}\n`,
    )
    throw new Error(`callback_data overflow: deferKey too long (${deferKey.length} chars)`)
  }
  return new InlineKeyboard()
    .text('🔓 Unlock vault & save', unlockData)
    .text('🗑 Discard', cancelData)
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
      // Channel B context rule: arm unconditionally — record that this chat
      // is awaiting an auth code paste so the inbound handler can treat the
      // next message as auth-flow-sensitive even if the pattern rule misses
      // it. Set BEFORE the ForceReply attempt so a switchroomReply throw
      // doesn't leave Channel B unarmed.
      const authChatId = String(ctx.chat!.id)
      awaitingAuthCodeAt.set(authChatId, Date.now())
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

/**
 * Render an `AuthCodeOutcome` as a user-facing Telegram HTML string.
 * Returns null when the outcome is not present or is `success` (caller
 * can handle success via the existing text path).
 */
function renderAuthCodeOutcome(outcome: AuthCodeOutcome | null | undefined): string | null {
  if (!outcome || outcome.kind === 'success') return null
  const tail = outcome.paneTailText
    ? `\n<i>${escapeHtmlForTg(outcome.paneTailText)}</i>`
    : ''
  switch (outcome.kind) {
    case 'invalid-code':
    case 'expired-code':
      return `Code rejected by Claude — tap <b>Restart flow</b> for a fresh URL.${tail}`
    case 'pane-not-ready':
      return `Auth pane not ready — tap <b>Retry</b>.`
    case 'timeout':
      return `Still waiting after 2 min — tap <b>Retry</b> or check <code>switchroom auth status</code>.${tail}`
  }
}

interface AuthCodeJsonResult {
  completed: boolean
  tokenSaved: boolean
  tokenPath: string | null
  outcome: AuthCodeOutcome | null
  instructions: string[]
}

/**
 * Run `switchroom auth code <agent> <code> --json` with a 150 s timeout
 * (allows for the full 120 s poll budget + startup overhead).
 *
 * Returns the parsed `AuthCodeJsonResult`, or null on exec failure.
 * On exec failure, `errorText` holds a formatted error string for the caller.
 */
function execAuthCode(
  agent: string,
  code: string,
): { result: AuthCodeJsonResult; errorText: null } | { result: null; errorText: string } {
  try {
    const output = switchroomExec(['auth', 'code', agent, code, '--json'], 150_000)
    const parsed = JSON.parse(stripAnsi(output)) as AuthCodeJsonResult
    return { result: parsed, errorText: null }
  } catch (err: unknown) {
    const error = err as { stderr?: string; stdout?: string; message?: string }
    // `auth code` exits 0 even on timeout/failure (it prints instructions).
    // However if the process itself fails (ENOENT, killed, etc.) we land here.
    // Try to salvage a JSON body from stdout if present.
    const rawOut = error.stdout ?? ''
    if (rawOut.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(stripAnsi(rawOut)) as AuthCodeJsonResult
        return { result: parsed, errorText: null }
      } catch { /* fall through */ }
    }
    const detail = stripAnsi(error.stderr?.trim() || error.message || 'unknown error')
    return { result: null, errorText: detail }
  }
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

// ─── Admin-command gating middleware ─────────────────────────────────────
// When AGENT_ADMIN=false (default), admin slash commands like /agents, /logs,
// /restart etc. should fall through to Claude rather than being executed
// locally. Grammy's bot.command() handlers fire BEFORE bot.on('message:text'),
// so without this middleware the commands would silently execute (or no-op
// due to isAuthorizedSender) and never reach handleInboundCoalesced.
//
// Middleware registered BEFORE bot.command() calls intercepts text messages
// first. If admin gating is off and the command is in ADMIN_COMMAND_NAMES, we
// redirect to handleInboundCoalesced so Claude sees the message.
//
// Invariant: when AGENT_ADMIN=true, this middleware is a no-op — bot.command()
// handlers run normally and Claude never sees admin commands.
bot.use(async (ctx, next) => {
  if (!AGENT_ADMIN && ctx.message?.text) {
    const cmd = parseCommandName(ctx.message.text)
    if (cmd !== null && ADMIN_COMMAND_NAMES.has(cmd)) {
      // Redirect admin command text to Claude via the normal inbound path.
      // We intentionally do NOT call next() so bot.command() never fires.
      process.stderr.write(
        `telegram gateway: admin-gate redirect cmd=/${cmd} agent=${process.env.SWITCHROOM_AGENT_NAME ?? '-'} (AGENT_ADMIN=false)\n`,
      )
      await handleInboundCoalesced(ctx, ctx.message.text, undefined)
      return
    }
  }
  await next()
})

// ─── Bot commands ─────────────────────────────────────────────────────────

/**
 * Build the optional audit details surfaced on `/status` (Profile, Tools,
 * Skills, Limits, Channel, Memory, Version). Populated from switchroom.yaml
 * at request time so the values reflect the live config.
 *
 * Pre-#142 this content was baked into a SessionStart curl script and
 * pushed on every restart. Now it's pulled on demand via /status (#142
 * PR 3) — server-side render of the same row shape.
 *
 * Best-effort: any failure (yaml unreadable, agent missing, etc.) returns
 * undefined so /status falls back to its previous (auth + uptime + agent
 * name) shape rather than blocking the reply.
 */
function buildAgentAudit(agentName: string): AgentAudit | undefined {
  try {
    const config = loadSwitchroomConfig()
    const agentConfig = config.agents?.[agentName]
    if (!agentConfig) return undefined

    // Tools allowlist — same shape as the deleted greeting:
    //   "all" / first 5 names + "+N more" / "none (default)".
    const allow = agentConfig.tools?.allow
    const tools = allow?.includes('all')
      ? 'all'
      : (allow?.slice(0, 5).join(', ') ?? 'none (default)')
        + ((allow?.length ?? 0) > 5 ? ` +${(allow?.length ?? 0) - 5} more` : '')

    const denyList = agentConfig.tools?.deny
    const toolsDeny = denyList?.length ? denyList.join(', ') : null

    // Skills cap at 6 names + "…+N more" so the row never wraps 4+
    // mobile lines (matches the deleted greeting's behavior).
    const skillsList = agentConfig.skills
    let skills: string | null = null
    if (skillsList?.length) {
      const max = 6
      skills = skillsList.length <= max
        ? skillsList.join(', ')
        : `${skillsList.slice(0, max).join(', ')}, …+${skillsList.length - max} more`
    }

    // Session limits — concatenated idle + max-turns, or "unlimited".
    const session: string[] = []
    if (agentConfig.session?.max_idle) session.push(`idle ${agentConfig.session.max_idle}`)
    if (agentConfig.session?.max_turns) session.push(`${agentConfig.session.max_turns} turns`)
    const limits = session.length ? session.join(', ') : 'unlimited (default)'

    const channel = agentConfig.channels?.telegram?.plugin ?? 'switchroom (default)'
    const memoryBank = agentConfig.memory?.collection ?? `${agentName} (default)`

    return {
      version: formatBootVersion(),
      tools,
      toolsDeny,
      skills,
      limits,
      channel,
      memoryBank,
    }
  } catch {
    // Silent failure — gateway runs in agent dirs without switchroom.yaml
    // path resolution always succeeding. /status falls back gracefully.
    return undefined
  }
}

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
    audit: buildAgentAudit(agentName),
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
    // Stamp user attribution into the clean-shutdown marker so the next
    // greeting card shows "Restarted  user: /restart from chat" instead
    // of whatever reason the downstream CLI would default to.
    stampUserRestartReason('user: /restart from chat')
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

  // Stamp user attribution so the next greeting shows "Restarted  user:
  // /new" / "user: /reset" rather than the downstream CLI default.
  stampUserRestartReason(`user: /${kind} from chat`)
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
    // Use structured JSON path so we can render typed outcome messages.
    const { result, errorText } = execAuthCode(intent.agent, intent.code)
    if (errorText) {
      await switchroomReply(ctx, `<b>${escapeHtmlForTg(intent.label)} failed:</b>\n${preBlock(formatSwitchroomOutput(errorText))}`, { html: true })
    } else if (result) {
      const outcomeMsg = renderAuthCodeOutcome(result.outcome)
      if (outcomeMsg) {
        await switchroomReply(ctx, outcomeMsg, { html: true })
      } else {
        const output = result.instructions.join('\n')
        const formatted = formatAuthOutputForTelegram(output)
        await switchroomReply(ctx, formatted.text, { html: true })
      }
    }
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

  // Plan + bank + rateLimitTier come from switchroom auth status for
  // THIS agent. rateLimitTier is the signal users need to verify the
  // correct Anthropic account got authorized during reauth (e.g.
  // max_5x vs max_20x). See 2026-04-22 account-mismatch discussion.
  let plan: string | null = null
  let rateLimitTier: string | null = null
  const bankId = agent
  try {
    type AuthStatusResp = { agents: Array<{ name: string; subscription_type: string | null; rate_limit_tier?: string | null }> }
    const statusData = switchroomExecJson<AuthStatusResp>(['auth', 'status'])
    const thisAgent = statusData?.agents?.find((a) => a.name === agent)
    if (thisAgent?.subscription_type) plan = thisAgent.subscription_type
    if (thisAgent?.rate_limit_tier) rateLimitTier = thisAgent.rate_limit_tier
  } catch {
    /* best-effort */
  }

  // Check for a pending auth session on disk. When present, surface it
  // on the dashboard so the user can tap [♻️ Restart flow] without
  // waiting for the automatic stale-session detection to fire (which
  // only fires on actual PKCE challenge drift).
  const pendingSessionSlot = readPendingSessionSlot(agent)

  return {
    agent,
    bankId,
    plan,
    rateLimitTier,
    slots,
    quotaHot: isQuotaHot(slots),
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    pendingSessionSlot,
  }
}

/**
 * Read the pending auth session's target slot from the agent's
 * `.setup-token.session.json` meta file. Returns null when no session
 * is pending.
 */
function readPendingSessionSlot(agent: string): string | null {
  try {
    const agentDir = resolveAgentDirForName(agent)
    if (!agentDir) return null
    const metaPath = join(agentDir, '.claude', '.setup-token.session.json')
    const raw = readFileSync(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as { slot?: string }
    return meta.slot ?? 'default'
  } catch {
    return null
  }
}

/**
 * Resolve the agent directory for a given name. Tries the local
 * SWITCHROOM_CONFIG-driven lookup first, falls back to scanning
 * known agent-root paths. Used by dashboard path probing without
 * blowing up when configs are split across roots (klanker setup).
 */
function resolveAgentDirForName(agent: string): string | null {
  try {
    // If this gateway is scoped to a specific agent, prefer that.
    if (agent === getMyAgentName()) {
      return resolveAgentDirFromEnv()
    }
  } catch { /* ignore */ }
  // Common split-root layout for klanker.
  const candidates = [
    join(process.env.HOME ?? '/root', `.switchroom-${agent}/agents/${agent}`),
    join(process.env.HOME ?? '/root', `.switchroom/agents/${agent}`),
  ]
  for (const c of candidates) {
    try { readFileSync(join(c, '.claude', 'settings.json'), 'utf-8'); return c } catch { /* try next */ }
  }
  return null
}

/**
 * Handle a callback_query from an auth dashboard button. Parses the
 * callback_data, runs the matching action, acknowledges the tap with a
 * toast, and refreshes the dashboard in-place via editMessageText.
 */
/**
 * Handle op:<action>:<encoded-agent> callbacks from operator-events.ts
 * renderOperatorEvent(). Phase 4b — closes the "buttons do nothing" gap.
 *
 * Actions:
 *   dismiss   — clear keyboard + toast
 *   restart   — systemctl --user restart switchroom-<agent>
 *   reauth    — delegate to runSwitchroomAuthCommand (same flow as /auth reauth)
 *   logs      — post last 30 lines of journalctl for the agent
 *   swap-slot, add-slot — Phase 4c will wire these; for now toast with the
 *                         equivalent CLI command for the user to run manually.
 */
/**
 * Issue #44: handle taps on the deferred-secret card's inline buttons.
 *
 *   `vd:unlock:<deferKey>` — register a `passphrase-for-deferred` pending
 *      vault op and edit the card to ask the user for their passphrase.
 *      The text-handler picks the passphrase up via the existing
 *      pendingVaultOps intercept and calls `executeDeferredSecretSave`
 *      to write the held secret directly. No re-paste required.
 *
 *   `vd:cancel:<deferKey>` — drop the deferred secret and clear the card.
 *      The held bytes are evicted from the in-memory `deferredSecrets`
 *      map (they were never written to disk) so the secret vanishes.
 *
 * Authorization mirrors the operator-event callback: only senders on the
 * configured allowlist get to act on the buttons.
 */
async function handleVaultDeferCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }
  // vd:<action>:<deferKey>. deferKey itself contains a colon (chat:msgId)
  // so we slice rather than split — only the first two segments are
  // structural; the rest is the deferKey verbatim.
  const rest = data.slice('vd:'.length)
  const colon = rest.indexOf(':')
  if (colon < 0) {
    await ctx.answerCallbackQuery({ text: 'Malformed callback.' }).catch(() => {})
    return
  }
  const action = rest.slice(0, colon)
  const deferKey = rest.slice(colon + 1)
  const deferred = deferredSecrets.get(deferKey)
  if (!deferred) {
    await ctx.answerCallbackQuery({ text: 'This card expired. Re-send the secret.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    return
  }

  const cardChatId = String(ctx.chat?.id ?? '')
  const cardMessageId = ctx.callbackQuery.message?.message_id

  if (action === 'cancel') {
    deferredSecrets.delete(deferKey)
    await ctx.answerCallbackQuery({ text: 'Discarded.' }).catch(() => {})
    if (cardMessageId != null) {
      await ctx
        .editMessageText('🗑 Discarded — secret was not saved.', {
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {})
    }
    return
  }

  if (action === 'unlock') {
    // If a passphrase is already cached we can skip straight to the write.
    // Covers the case where the user had unlocked separately between
    // detection and tap.
    const cached = vaultPassphraseCache.get(cardChatId)
    if (cached && cached.expiresAt > Date.now()) {
      await ctx.answerCallbackQuery({ text: 'Saving…' }).catch(() => {})
      await executeDeferredSecretSave(ctx, deferKey, cached.passphrase, cardMessageId)
      return
    }

    if (cardMessageId == null) {
      await ctx.answerCallbackQuery({ text: 'Missing card context.' }).catch(() => {})
      return
    }
    pendingVaultOps.set(cardChatId, {
      kind: 'passphrase-for-deferred',
      deferKey,
      cardChatId,
      cardMessageId,
      startedAt: Date.now(),
    })
    await ctx.answerCallbackQuery({ text: 'Send your passphrase…' }).catch(() => {})
    await ctx
      .editMessageText(
        '🔐 Send your vault passphrase as your next message — we\'ll save the held secret automatically and delete the passphrase message.',
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => {})
    return
  }

  await ctx.answerCallbackQuery({ text: 'Unknown action.' }).catch(() => {})
}

// ─── Grant wizard helpers (Issue #227) ──────────────────────────────────────
// TODO: these helpers duplicate server.ts — extract to a shared module in a
// future refactor once the two entrypoints are proven stable in production.

/** Parse a duration string like "30d", "7h", "365d" into seconds. */
function parseGrantDuration(s: string): number | null {
  const m = /^(\d+)([dh])$/i.exec(s.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  if (n <= 0) return null
  return m[2]!.toLowerCase() === 'd' ? n * 86400 : n * 3600
}

/** Format seconds as a human-readable expiry label. */
function formatGrantExpiry(ttlSeconds: number | null, now: Date = new Date()): string {
  if (ttlSeconds === null) return 'Never'
  const exp = new Date(now.getTime() + ttlSeconds * 1000)
  return exp.toISOString().slice(0, 10)
}

/** Build the Step 1 keyboard: agent selection. */
function buildGrantAgentKeyboard(agents: string[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  // Max 3 per row to keep buttons readable on mobile
  for (let i = 0; i < agents.length; i++) {
    if (i > 0 && i % 3 === 0) kb.row()
    kb.text(agents[i]!, `vg:agent:${agents[i]!}`)
  }
  kb.row().text('Cancel', 'vg:cancel')
  return kb
}

/** Build the Step 2 keyboard: key multi-select toggle. */
function buildGrantKeysKeyboard(keys: string[], selected: Set<string>): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const k of keys) {
    const check = selected.has(k) ? '☑' : '☐'
    kb.row().text(`${check} ${k}`, `vg:key:${k}`)
  }
  kb.row()
    .text('Continue', 'vg:keys-continue')
    .text('Cancel', 'vg:cancel')
  return kb
}

/** Build the Step 3 keyboard: duration selection. */
function buildGrantDurationKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('30 days', 'vg:dur:30d')
    .text('90 days', 'vg:dur:90d')
    .text('1 year', 'vg:dur:1y')
    .row()
    .text('Custom…', 'vg:dur:custom')
    .text('No expiry', 'vg:dur:never')
    .row()
    .text('Back', 'vg:back:duration')
    .text('Cancel', 'vg:cancel')
}

/** Build the Confirm keyboard. */
function buildGrantConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Generate', 'vg:generate')
    .text('Cancel', 'vg:cancel')
}

/** Start the grant wizard (step 1: pick agent). */
async function startGrantWizardStep1(ctx: Context, chatId: string): Promise<void> {
  type AgentListResp = { agents: Array<{ name: string }> }
  const data = switchroomExecJson<AgentListResp>(['agent', 'list'])
  const agents = data?.agents?.map(a => a.name).filter(Boolean) ?? []
  if (agents.length === 0) {
    await switchroomReply(ctx, '⚠️ No agents found in switchroom.yaml.', { html: true })
    return
  }
  const kb = buildGrantAgentKeyboard(agents)
  const sent = await switchroomReply(ctx, '<b>Grant capability token — Step 1/3</b>\n\nWhich agent?', { html: true, reply_markup: kb })
  const wizardMsgId = (sent as { message_id?: number })?.message_id
  pendingVaultOps.set(chatId, {
    kind: 'grant-wizard',
    step: 'agent',
    wizardMsgId,
    startedAt: Date.now(),
  })
}

/** Advance grant wizard to step 2 (pick keys). */
async function grantWizardStep2(ctx: Context, chatId: string, agent: string, wizardMsgId: number | undefined): Promise<void> {
  const keys = await listViaBroker()
  if (!keys) {
    await switchroomReply(ctx, '🔴 Broker is not running (or unreachable). Cannot list vault keys.', { html: true })
    pendingVaultOps.delete(chatId)
    return
  }
  if (keys.length === 0) {
    await switchroomReply(ctx, '⚠️ No vault keys found. Add secrets first with <code>/vault set</code>.', { html: true })
    pendingVaultOps.delete(chatId)
    return
  }
  const selected = new Set<string>()
  const kb = buildGrantKeysKeyboard(keys, selected)
  const text = `<b>Grant capability token — Step 2/3</b>\n\nWhich keys for <code>${escapeHtmlForTg(agent)}</code>?\n<i>Tap to toggle; tap Continue when done.</i>`
  if (wizardMsgId != null) {
    await ctx.api.editMessageText(chatId, wizardMsgId, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
  } else {
    const sent = await switchroomReply(ctx, text, { html: true, reply_markup: kb })
    wizardMsgId = (sent as { message_id?: number })?.message_id
  }
  pendingVaultOps.set(chatId, {
    kind: 'grant-wizard',
    step: 'keys',
    agent,
    selectedKeys: [],
    availableKeys: keys,
    wizardMsgId,
    startedAt: Date.now(),
  })
}

/** Advance grant wizard to step 3 (pick duration). */
async function grantWizardStep3(ctx: Context, chatId: string, state: Extract<PendingVaultOp, { kind: 'grant-wizard' }>): Promise<void> {
  const kb = buildGrantDurationKeyboard()
  const keyList = state.selectedKeys!.map(k => `• <code>${escapeHtmlForTg(k)}</code>`).join('\n')
  const text = `<b>Grant capability token — Step 3/3</b>\n\nKeys for <code>${escapeHtmlForTg(state.agent!)}</code>:\n${keyList}\n\nHow long should this grant be valid?`
  const msgId = state.wizardMsgId
  if (msgId != null) {
    await ctx.api.editMessageText(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
  } else {
    const sent = await switchroomReply(ctx, text, { html: true, reply_markup: kb })
    state.wizardMsgId = (sent as { message_id?: number })?.message_id
  }
  pendingVaultOps.set(chatId, { ...state, step: 'duration' })
}

/** Advance grant wizard to confirmation step. */
async function grantWizardConfirm(ctx: Context, chatId: string, state: Extract<PendingVaultOp, { kind: 'grant-wizard' }>): Promise<void> {
  const kb = buildGrantConfirmKeyboard()
  const expiresLabel = formatGrantExpiry(state.ttlSeconds!)
  const keyList = state.selectedKeys!.map(k => `• <code>${escapeHtmlForTg(k)}</code>`).join('\n')
  const text = [
    '<b>Confirm grant</b>',
    '',
    `Agent: <code>${escapeHtmlForTg(state.agent!)}</code>`,
    `Keys:\n${keyList}`,
    `Expires: <b>${escapeHtmlForTg(expiresLabel)}</b>`,
    '',
    'Tap <b>Generate</b> to mint the token.',
  ].join('\n')
  const msgId = state.wizardMsgId
  if (msgId != null) {
    await ctx.api.editMessageText(chatId, msgId, text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {})
  } else {
    const sent = await switchroomReply(ctx, text, { html: true, reply_markup: kb })
    state.wizardMsgId = (sent as { message_id?: number })?.message_id
  }
  pendingVaultOps.set(chatId, { ...state, step: 'confirm', expiresLabel })
}

/** Execute the grant: call broker mint_grant, write token, reply. */
async function executeGrantWizard(ctx: Context, chatId: string, state: Extract<PendingVaultOp, { kind: 'grant-wizard' }>): Promise<void> {
  pendingVaultOps.delete(chatId)
  // Defence-in-depth: state.agent flows from callback_data into a path
  // join below. A crafted vg:agent:../../etc payload would produce a
  // path traversal. Validate against the same regex the rest of the
  // file uses; on failure, drop silently — the wizard message has
  // already been finalized.
  try { assertSafeAgentName(state.agent!) } catch { return }
  const result = await mintGrantViaBroker({
    agent: state.agent!,
    keys: state.selectedKeys!,
    ttl_seconds: state.ttlSeconds ?? null,
    description: state.description,
  })
  if (result.kind === 'unreachable') {
    await switchroomReply(ctx, `🔴 Broker unreachable: ${escapeHtmlForTg(result.msg)}`, { html: true })
    return
  }
  if (result.kind === 'error') {
    await switchroomReply(ctx, `<b>mint_grant failed:</b> ${escapeHtmlForTg(result.msg)}`, { html: true })
    return
  }
  // Write token to the agent's .vault-token file
  const { token, id } = result
  const tokenPath = join(homedir(), '.switchroom', 'agents', state.agent!, '.vault-token')
  try {
    mkdirSync(join(homedir(), '.switchroom', 'agents', state.agent!), { recursive: true })
    writeFileSync(tokenPath, token, { mode: 0o600 })
  } catch (err) {
    await switchroomReply(ctx, `<b>Grant created but token write failed:</b> ${escapeHtmlForTg(String(err))}`, { html: true })
    return
  }
  // Collapse wizard message to just the outcome
  const msgId = state.wizardMsgId
  const successText = `✅ Grant <code>${escapeHtmlForTg(id)}</code> created. Written to <code>~/.switchroom/agents/${escapeHtmlForTg(state.agent!)}/.vault-token</code>`
  if (msgId != null) {
    await ctx.api.editMessageText(chatId, msgId, successText, { parse_mode: 'HTML' }).catch(() => {})
  } else {
    await switchroomReply(ctx, successText, { html: true })
  }
}

/**
 * Issue #228: handle vault grant management callbacks.
 *
 *   `vg:revoke:<grantId>`  — fetch grant details and show confirmation card.
 *   `vg:confirm:<grantId>` — call broker revoke_grant, reply with success.
 *   `vg:cancel:<grantId>`  — dismiss (clear keyboard, no broker call).
 *
 * Issue #227: also handles /vault grant wizard callbacks.
 *
 *   `vg:cancel`            — cancel wizard at any step.
 *   `vg:agent:<name>`      — step 1: select agent.
 *   `vg:key:<name>`        — step 2: toggle key selection.
 *   `vg:keys-continue`     — step 2 → 3.
 *   `vg:dur:<value>`       — step 3: duration selection.
 *   `vg:back:duration`     — step 3 → back to step 2.
 *   `vg:generate`          — confirm and mint token.
 */
async function handleVaultGrantCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }

  const revokeMatch = /^vg:revoke:(.+)$/.exec(data)
  if (revokeMatch) {
    const grantId = revokeMatch[1]!
    const result = await listGrantsViaBroker(undefined)
    if (result.kind !== 'ok') {
      await ctx.answerCallbackQuery({ text: 'Broker unreachable.' }).catch(() => {})
      return
    }
    const grant = result.grants.find(g => g.id === grantId)
    if (!grant) {
      await ctx.answerCallbackQuery({ text: 'Grant not found (already revoked?).' }).catch(() => {})
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
      return
    }
    const cardText =
      `🗑 Revoke <code>${escapeHtmlForTg(grantId)}</code>?\n` +
      `Agent: <b>${escapeHtmlForTg(grant.agent_slug)}</b>\n` +
      `Keys: <code>${escapeHtmlForTg(grant.key_allow.join(', '))}</code>`
    const confirmKeyboard = new InlineKeyboard()
      .text('✅ Confirm Revoke', `vg:confirm:${grantId}`)
      .text('❌ Cancel', `vg:cancel:${grantId}`)
    await ctx.answerCallbackQuery().catch(() => {})
    await ctx.editMessageText(cardText, {
      parse_mode: 'HTML',
      reply_markup: confirmKeyboard,
    }).catch(async () => {
      const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '')
      const threadId = ctx.callbackQuery.message?.message_thread_id
      if (chatId) {
        await bot.api.sendMessage(chatId, cardText, {
          parse_mode: 'HTML',
          reply_markup: confirmKeyboard,
          ...(threadId != null ? { message_thread_id: threadId } : {}),
        }).catch(() => {})
      }
    })
    return
  }

  const confirmMatch = /^vg:confirm:(.+)$/.exec(data)
  if (confirmMatch) {
    const grantId = confirmMatch[1]!
    const revokeResult = await revokeGrantViaBroker(grantId)
    if (revokeResult.kind === 'unreachable') {
      await ctx.answerCallbackQuery({ text: 'Broker unreachable.' }).catch(() => {})
      return
    }
    if (revokeResult.kind === 'error') {
      await ctx.answerCallbackQuery({ text: `Revoke failed: ${revokeResult.msg}` }).catch(() => {})
      return
    }
    await ctx.answerCallbackQuery({ text: '✅ Revoked' }).catch(() => {})
    await ctx.editMessageText(
      `✅ Grant <code>${escapeHtmlForTg(grantId)}</code> revoked. Token file removed.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
    ).catch(() => {})
    return
  }

  const cancelMatch = /^vg:cancel:(.+)$/.exec(data)
  if (cancelMatch) {
    await ctx.answerCallbackQuery({ text: 'Cancelled.' }).catch(() => {})
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
    return
  }

  // #227 grant wizard callbacks (vg:cancel bare, vg:agent:*, vg:key:*, vg:keys-continue,
  // vg:dur:*, vg:back:*, vg:generate). These come after the management callbacks above
  // because management uses vg:cancel:<id> (with trailing id) while the wizard uses
  // bare vg:cancel — the cancelMatch above only matches the id-suffixed form.
  const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '')
  await ctx.answerCallbackQuery().catch(() => {})

  // Cancel at any wizard step
  if (data === 'vg:cancel') {
    pendingVaultOps.delete(chatId)
    const msg = ctx.callbackQuery.message
    if (msg && 'text' in msg) {
      await ctx.editMessageText('❌ Grant wizard cancelled.').catch(() => {})
    }
    return
  }

  const state = pendingVaultOps.get(chatId)
  if (!state || state.kind !== 'grant-wizard') {
    await ctx.editMessageText('⚠️ Wizard session expired. Run /vault grant to start again.').catch(() => {})
    return
  }

  // vg:agent:<name> — step 1 selection
  if (data.startsWith('vg:agent:')) {
    const agent = data.slice('vg:agent:'.length)
    const msgId = (ctx.callbackQuery.message as { message_id?: number })?.message_id ?? state.wizardMsgId
    await grantWizardStep2(ctx, chatId, agent, msgId)
    return
  }

  // vg:key:<name> — step 2 toggle
  if (data.startsWith('vg:key:')) {
    const key = data.slice('vg:key:'.length)
    if (state.step !== 'keys') return
    const selectedSet = new Set(state.selectedKeys ?? [])
    if (selectedSet.has(key)) {
      selectedSet.delete(key)
    } else {
      selectedSet.add(key)
    }
    const updatedState = { ...state, selectedKeys: [...selectedSet] }
    pendingVaultOps.set(chatId, updatedState)
    const kb = buildGrantKeysKeyboard(state.availableKeys ?? [], selectedSet)
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {})
    return
  }

  // vg:keys-continue — step 2 → 3
  if (data === 'vg:keys-continue') {
    if (state.step !== 'keys') return
    if (!state.selectedKeys || state.selectedKeys.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Select at least one key.' }).catch(() => {})
      return
    }
    await grantWizardStep3(ctx, chatId, state)
    return
  }

  // vg:dur:<value> — step 3 duration selection
  if (data.startsWith('vg:dur:')) {
    if (state.step !== 'duration') return
    const dur = data.slice('vg:dur:'.length)
    if (dur === 'custom') {
      // Ask for text reply with n d|h format
      pendingVaultOps.set(chatId, { ...state, awaitingCustomDuration: true })
      const msg = ctx.callbackQuery.message
      if (msg && 'text' in msg && msg.text) {
        await ctx.editMessageText(
          msg.text + '\n\n<i>Send a duration like <code>30d</code> or <code>12h</code>:</i>',
          { parse_mode: 'HTML', reply_markup: buildGrantDurationKeyboard() },
        ).catch(() => {})
      }
      return
    }
    let ttlSeconds: number | null
    if (dur === 'never') {
      ttlSeconds = null
    } else if (dur === '1y') {
      ttlSeconds = 365 * 86400
    } else {
      ttlSeconds = parseGrantDuration(dur)
      if (ttlSeconds === null) return
    }
    const newState = { ...state, ttlSeconds, awaitingCustomDuration: false }
    await grantWizardConfirm(ctx, chatId, newState)
    return
  }

  // vg:back:duration — go back to step 2 (keys selection) from step 3
  if (data === 'vg:back:duration') {
    if (state.step !== 'duration') return
    const msgId = state.wizardMsgId
    await grantWizardStep2(ctx, chatId, state.agent!, msgId)
    return
  }

  // vg:generate — final step
  if (data === 'vg:generate') {
    if (state.step !== 'confirm') return
    await executeGrantWizard(ctx, chatId, state)
    return
  }

  // Unrecognised vg: sub-action — already answered callbackQuery above
}

/**
 * Issue #44: write a deferred secret to the vault using the now-cached
 * passphrase. Confirms with a masked ref + slug; matches the "captured
 * N secret" UX of the cached-passphrase happy path so the user
 * experience is identical regardless of which path they came in on.
 *
 * Called from two places:
 *   - The `passphrase-for-deferred` branch of the text-handler
 *     pendingVaultOps intercept, after the passphrase is verified.
 *   - The `vd:unlock` callback handler when a passphrase happens to
 *     already be cached (rare but possible).
 *
 * If write fails, the deferred entry is preserved so the user can retry.
 */
async function executeDeferredSecretSave(
  ctx: Context,
  deferKey: string,
  passphrase: string,
  cardMessageId: number | undefined,
): Promise<void> {
  const deferred = deferredSecrets.get(deferKey)
  if (!deferred) {
    if (cardMessageId != null) {
      await ctx.api
        .editMessageText(
          deferKey.split(':')[0]!,
          cardMessageId,
          '⚠️ This card expired before unlock — please re-send the secret.',
          { reply_markup: { inline_keyboard: [] } },
        )
        .catch(() => {})
    }
    return
  }

  // De-duplicate suggested_slug against existing vault keys by appending
  // _2 / _3 / … if needed. Same logic as the cached-passphrase happy
  // path uses (gateway.ts ~L2402 stash command).
  const slugBase = deferred.suggested_slug || 'secret'
  const listed = defaultVaultList(passphrase)
  const existing = new Set(listed.ok ? listed.keys : [])
  let slug = slugBase
  let n = 2
  while (existing.has(slug)) slug = `${slugBase}_${n++}`

  const write = defaultVaultWrite(slug, deferred.text, passphrase)
  if (!write.ok) {
    // Keep the deferred entry so the user can retry by tapping again.
    if (cardMessageId != null) {
      await ctx.api
        .editMessageText(
          deferred.chat_id,
          cardMessageId,
          `⚠️ vault write failed:\n<pre>${escapeHtmlForTg(write.output)}</pre>\n\nRe-tap to retry.`,
          {
            parse_mode: 'HTML',
            reply_markup: buildDeferredSecretKeyboard(deferKey).inline_keyboard.length > 0
              ? buildDeferredSecretKeyboard(deferKey)
              : undefined,
          },
        )
        .catch(() => {})
    }
    return
  }

  deferredSecrets.delete(deferKey)
  const masked = maskToken(deferred.text)
  if (cardMessageId != null) {
    await ctx.api
      .editMessageText(
        deferred.chat_id,
        cardMessageId,
        `✅ stored as <code>vault:${slug}</code> (masked: <code>${masked}</code>)\n\nReply <code>rename NEW_NAME</code> to relabel.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
      )
      .catch(() => {})
  }
  // Stage for follow-up rename, mirroring the cached-passphrase path.
  secretStaging.set({
    chat_id: deferred.chat_id,
    message_id: deferred.original_message_id,
    detection: {
      rule_id: 'deferred',
      matched_text: deferred.text,
      start: 0,
      end: deferred.text.length,
      confidence: 'high' as const,
      suppressed: false,
      suggested_slug: slug,
    },
    staged_at: Date.now(),
  })
}

async function handleOperatorEventCallback(ctx: Context, data: string): Promise<void> {
  const senderId = String(ctx.from?.id ?? '')
  const access = loadAccess()
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return
  }

  // Parse op:<action>:<encoded-agent>
  const parts = data.slice(3).split(':', 2)  // drop "op:", then split action:agent
  if (parts.length !== 2) {
    await ctx.answerCallbackQuery({ text: 'Malformed operator-event callback.' }).catch(() => {})
    return
  }
  const [action, encodedAgent] = parts
  let agent: string
  try {
    agent = decodeURIComponent(encodedAgent)
  } catch {
    await ctx.answerCallbackQuery({ text: 'Bad agent name encoding.' }).catch(() => {})
    return
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,50}$/.test(agent)) {
    await ctx.answerCallbackQuery({ text: 'Invalid agent name.' }).catch(() => {})
    return
  }

  switch (action) {
    case 'dismiss': {
      await ctx.answerCallbackQuery({ text: 'Dismissed' }).catch(() => {})
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
      return
    }
    case 'restart': {
      await ctx.answerCallbackQuery({ text: `Restarting ${agent}…` }).catch(() => {})
      try {
        execFileSync('systemctl', ['--user', 'restart', `switchroom-${agent}`], {
          encoding: 'utf-8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        await ctx.reply(`<b>${agent}</b> restart requested.`, { parse_mode: 'HTML' })
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {})
      } catch (err) {
        // err.message includes concatenated stderr which can contain HTML
        // metacharacters; escape before interpolating into a <pre> block.
        const safeMsg = escapeHtmlForTg((err as Error).message)
        await ctx.reply(`<b>Restart failed for ${agent}:</b>\n<pre>${safeMsg}</pre>`, {
          parse_mode: 'HTML',
        })
      }
      return
    }
    case 'reauth': {
      await ctx.answerCallbackQuery({ text: `Starting reauth for ${agent}…` }).catch(() => {})
      await runSwitchroomAuthCommand(ctx, ['auth', 'reauth', agent], `auth reauth ${agent}`)
      pendingReauthFlows.set(String(ctx.chat!.id), { agent, startedAt: Date.now() })
      return
    }
    case 'logs': {
      await ctx.answerCallbackQuery({ text: 'Fetching logs…' }).catch(() => {})
      try {
        const out = execFileSync(
          'journalctl',
          ['--user', '-u', `switchroom-${agent}`, '-n', '30', '--no-pager', '--output=short-monotonic'],
          { encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
        ) as string
        const trimmed = out.trim().slice(-3500)
        await ctx.reply(
          trimmed
            ? `<pre>${trimmed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
            : `<i>No logs for ${agent}.</i>`,
          { parse_mode: 'HTML' },
        )
      } catch (err) {
        await ctx.reply(
          `<b>logs failed:</b> ${escapeHtmlForTg((err as Error).message)}`,
          { parse_mode: 'HTML' },
        )
      }
      return
    }
    case 'swap-slot':
    case 'add-slot': {
      await ctx.answerCallbackQuery({ text: 'Phase 4c will wire this' }).catch(() => {})
      const cmd = action === 'swap-slot' ? `auth use ${agent} <slot-name>` : `auth add ${agent}`
      await ctx.reply(`Phase 4c will wire ${action} buttons. Until then, run in terminal: <code>switchroom ${cmd}</code>`, {
        parse_mode: 'HTML',
      })
      return
    }
    default: {
      await ctx.answerCallbackQuery({ text: `Unknown action: ${action}` }).catch(() => {})
      return
    }
  }
}

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
    case 'restart-flow': {
      // Kill any pending session + restart the same flow (reauth or
      // add-slot) fresh. Exists for the case where the user wants to
      // start over BEFORE the automatic stale-session detection fires
      // (e.g. closed the browser tab, 2FA failed, waited too long).
      await ctx.answerCallbackQuery({ text: `Restarting ${action.slot} flow…` }).catch(() => {})
      // Step 1: cancel any pending session for this agent.
      try {
        await runSwitchroomCommand(ctx, ['auth', 'cancel', action.agent], `auth cancel ${action.agent}`)
      } catch { /* cancel is best-effort */ }
      // Step 2: re-initiate. Slot == 'default' → reauth; else → add-slot.
      // Both paths print the fresh URL + button + ForceReply prompt via
      // runSwitchroomAuthCommand.
      if (action.slot === 'default') {
        await runSwitchroomAuthCommand(ctx, ['auth', 'reauth', action.agent], `auth reauth ${action.agent}`)
      } else {
        await runSwitchroomAuthCommand(ctx, ['auth', 'add', action.agent, '--slot', action.slot], `auth add ${action.agent} --slot ${action.slot}`)
      }
      pendingReauthFlows.set(String(ctx.chat!.id), { agent: action.agent, startedAt: Date.now() })
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
    const { result, errorText } = execAuthCode(name, raw)
    if (errorText) {
      await switchroomReply(ctx, `<b>auth code ${escapeHtmlForTg(name)} failed:</b>\n${preBlock(formatSwitchroomOutput(errorText))}`, { html: true })
    } else if (result) {
      const outcomeMsg = renderAuthCodeOutcome(result.outcome)
      if (outcomeMsg) {
        await switchroomReply(ctx, outcomeMsg, { html: true })
      } else {
        const output = result.instructions.join('\n')
        const formatted = formatAuthOutputForTelegram(output)
        await switchroomReply(ctx, formatted.text, { html: true })
      }
    }
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
      '/vault status — show broker state',
      '/vault unlock — unlock the broker (prompts for passphrase)',
      '/vault lock — lock the broker',
      '/vault grant — mint a capability token (inline wizard)',
      '/vault grants [agent] — list active capability grants (tap to revoke)',
      '',
      'Your passphrase is cached in memory for 30 min after first use.',
    ].join('\n'), { html: true })
    return
  }

  // Issue #228: /vault grants [agent] — list active grants grouped by agent
  if (sub === 'grants') {
    const agentFilter = args[1]  // optional agent name filter
    const result = await listGrantsViaBroker(agentFilter)
    if (result.kind === 'unreachable') {
      await switchroomReply(ctx, '🔴 Broker is not running (or unreachable).', { html: true })
      return
    }
    if (result.kind === 'error') {
      await switchroomReply(ctx, `🔴 list_grants failed: ${escapeHtmlForTg(result.msg)}`, { html: true })
      return
    }
    const { grants } = result
    if (grants.length === 0) {
      const filterNote = agentFilter ? ` for <code>${escapeHtmlForTg(agentFilter)}</code>` : ''
      await switchroomReply(ctx, `📜 No active grants${filterNote}.`, { html: true })
      return
    }
    // Group grants by agent_slug
    const byAgent = new Map<string, typeof grants>()
    for (const g of grants) {
      const list = byAgent.get(g.agent_slug) ?? []
      list.push(g)
      byAgent.set(g.agent_slug, list)
    }
    // Build message text (grouped) + inline keyboard (one [Revoke] per grant per row)
    const lines: string[] = ['<b>📜 Active grants</b>', '']
    const keyboard = new InlineKeyboard()
    for (const [agentName, agentGrants] of byAgent) {
      lines.push(`<b>${escapeHtmlForTg(agentName)}:</b>`)
      for (const g of agentGrants) {
        const keys = g.key_allow.join(', ')
        const expiry = g.expires_at
          ? new Date(g.expires_at * 1000).toISOString().slice(0, 10)
          : 'no expiry'
        lines.push(`• <code>${escapeHtmlForTg(g.id)}</code> — ${escapeHtmlForTg(keys)}, expires ${expiry}`)
        // callback_data: vg:revoke:<id> — max 64 bytes; grant IDs are "vg_" + 6 chars = 9 chars total → well within limit
        keyboard.text(`🗑 Revoke ${g.id}`, `vg:revoke:${g.id}`).row()
      }
      lines.push('')
    }
    const chatId2 = String(ctx.chat!.id)
    const threadId2 = resolveThreadId(chatId2, ctx.message?.message_thread_id)
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: keyboard,
      ...(threadId2 != null ? { message_thread_id: threadId2 } : {}),
    })
    return
  }

  // Issue #158: broker lifecycle ops (no vault passphrase needed)
  if (sub === 'status') {
    const status = await statusViaBroker()
    if (!status) {
      await switchroomReply(ctx, '🔴 Broker is not running (or unreachable).', { html: true })
      return
    }
    const lockIcon = status.unlocked ? '🔓' : '🔒'
    const lockLabel = status.unlocked ? 'Unlocked' : 'Locked'
    const uptimeSec = Math.round(status.uptimeSec)
    const h = Math.floor(uptimeSec / 3600)
    const m = Math.floor((uptimeSec % 3600) / 60)
    const s = uptimeSec % 60
    const uptime = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
    await switchroomReply(ctx, `${lockIcon} ${lockLabel} · ${status.keyCount} key${status.keyCount === 1 ? '' : 's'} · uptime ${uptime}`, { html: true })
    return
  }

  if (sub === 'lock') {
    const ok = await lockViaBroker()
    if (ok) {
      await switchroomReply(ctx, '🔒 Vault broker locked.', { html: true })
    } else {
      await switchroomReply(ctx, '🔴 Could not lock broker — is it running?', { html: true })
    }
    return
  }

  if (sub === 'unlock') {
    // Prompt for passphrase via the existing pending-op intercept, but never
    // cache it — it goes straight to the broker unlock socket.
    pendingVaultOps.set(chatId, { kind: 'unlock', startedAt: Date.now() })
    await switchroomReply(ctx, '🔐 Send your vault passphrase to unlock the broker (message will be deleted, passphrase never cached):', { html: true })
    return
  }

  // Issue #227: /vault grant — inline-keyboard wizard to mint capability tokens
  if (sub === 'grant') {
    await startGrantWizardStep1(ctx, chatId)
    return
  }

  if (!['list', 'get', 'set', 'delete', 'remove'].includes(sub)) {
    await switchroomReply(ctx, `Unknown vault subcommand: <code>${escapeHtmlForTg(sub)}</code>. Try /vault help`, { html: true })
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

// Deprecated: /reconcile is now /update. Kept for one release with a warning.
bot.command('reconcile', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  await switchroomReply(
    ctx,
    `⚠️ <b>/reconcile is deprecated</b> — use <code>/update</code> instead.\n\nRunning <b>switchroom update</b> now…`,
    { html: true },
  )
  await sweepBeforeSelfRestart()
  const chatId = String(ctx.chat!.id)
  const threadId = resolveThreadId(chatId, ctx.message?.message_thread_id)
  spawnSwitchroomDetached(
    ['update'],
    notifyDetachedFailure(chatId, threadId ?? null, 'update (via deprecated /reconcile)'),
  )
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

bot.command('version', async ctx => {
  if (!isAuthorizedSender(ctx)) return
  try {
    let output: string
    try { output = switchroomExecCombined(['version'], 10000) }
    catch (err: unknown) { output = (err as any).stdout ?? (err as any).message ?? 'version failed' }
    const trimmed = stripAnsi(output).trim()
    if (!trimmed) { await switchroomReply(ctx, 'version: no output'); return }
    await switchroomReply(ctx, preBlock(formatSwitchroomOutput(trimmed)), { html: true })
  } catch (err: unknown) {
    await switchroomReply(ctx, `<b>version failed:</b>\n${preBlock(formatSwitchroomOutput((err as any).message ?? 'unknown error'))}`, { html: true })
  }
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

  // op:<action>:<encoded-agent> callbacks from operator-events.ts
  // renderOperatorEvent(). Agent name is URL-encoded at emit (issue #24).
  // Actions: dismiss, restart, reauth, swap-slot, add-slot, logs.
  if (data.startsWith('op:')) {
    await handleOperatorEventCallback(ctx, data)
    return
  }

  // vd:<action>:<deferKey> callbacks from the deferred-secret card.
  // Actions: unlock (prompt for passphrase + auto-write), cancel.
  // Issue #44.
  if (data.startsWith('vd:')) {
    await handleVaultDeferCallback(ctx, data)
    return
  }

  // Issue #228: vault grant management callbacks.
  // vg:revoke:<id> — show confirmation card
  // vg:confirm:<id> — execute revoke
  // vg:cancel:<id> — dismiss
  if (data.startsWith('vg:')) {
    await handleVaultGrantCallback(ctx, data)
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

// ─── Checklist service message handlers ──────────────────────────────────
// Telegram emits `checklist_tasks_done` and `checklist_tasks_added` service
// messages when users tick or add tasks in a native checklist. These arrive
// as part of the `message` update type, so no extra `allowed_updates` config
// is required — bots already receive them.
//
// We route them to the agent as a new channel event with
// kind="checklist_task_changed" so the agent can react to user actions on
// a checklist it sent.

type ChecklistTaskUpdate = {
  message_checklist?: {
    title?: string
    tasks?: Array<{ id?: number; text?: string; is_completed?: boolean }>
  }
  checklist_tasks_done?: Array<{ id?: number; user?: { id?: number; username?: string }; done?: boolean }>
  checklist_tasks_added?: Array<{ id?: number; text?: string; user?: { id?: number; username?: string } }>
}

function handleChecklistUpdate(
  ctx: Context,
  kind: 'checklist_tasks_done' | 'checklist_tasks_added',
): void {
  try {
    const msg = ctx.message as (typeof ctx.message & ChecklistTaskUpdate) | undefined
    if (!msg) return

    const chat = ctx.chat
    if (!chat) return

    const chat_id = String(chat.id)
    const access = loadAccess()

    // Only notify if this chat is allowlisted — same guard as inbound user messages.
    if (!access.allowFrom.includes(chat_id) && access.allowFrom.length > 0) return

    const message_id = String(msg.message_id)
    const ts = msg.date ?? Math.floor(Date.now() / 1000)

    // Extract task updates depending on service message type
    const tasksDone = msg.checklist_tasks_done ?? []
    const tasksAdded = msg.checklist_tasks_added ?? []
    const allTasks = kind === 'checklist_tasks_done' ? tasksDone : tasksAdded

    // Build per-task channel events and broadcast each to connected bridges.
    for (const task of allTasks) {
      const taskId = task.id != null ? String(task.id) : '?'
      const user = (task.user as { username?: string; id?: number } | undefined)
      const userName = user?.username ?? (user?.id != null ? String(user.id) : 'unknown')
      const state = kind === 'checklist_tasks_done'
        ? ((task as { done?: boolean }).done === false ? 'undone' : 'done')
        : 'added'

      const inboundMsg: InboundMessage = {
        type: 'inbound',
        chatId: chat_id,
        messageId: Number(message_id),
        user: userName,
        userId: user?.id ?? 0,
        ts,
        text: `(checklist task ${state}: id=${taskId})`,
        meta: {
          chat_id,
          message_id,
          kind: 'checklist_task_changed',
          task_id: taskId,
          state,
          user: userName,
          user_id: user?.id != null ? String(user.id) : '0',
          ts: new Date(ts * 1000).toISOString(),
        },
      }
      ipcServer.broadcast(inboundMsg)
      process.stderr.write(
        `telegram gateway: checklist ${kind}: chat_id=${chat_id} message_id=${message_id} task_id=${taskId} state=${state} user=${userName}\n`,
      )
    }
  } catch (err) {
    process.stderr.write(`telegram gateway: checklist handler error (${kind}): ${err}\n`)
  }
}

bot.on('message:checklist_tasks_done' as Parameters<typeof bot.on>[0], (ctx) => {
  handleChecklistUpdate(ctx as unknown as Context, 'checklist_tasks_done')
})

bot.on('message:checklist_tasks_added' as Parameters<typeof bot.on>[0], (ctx) => {
  handleChecklistUpdate(ctx as unknown as Context, 'checklist_tasks_added')
})

// ─── Inbound message_reaction handler ────────────────────────────────────
// Telegram delivers MessageReactionUpdated events when a user adds, changes,
// or removes an emoji reaction from a bot message. We persist the current
// reaction to the SQLite history row so get_recent_messages can surface it.
//
// Only emoji reactions are handled for v1 — custom emoji are silently skipped.
// Requires "message_reaction" in allowed_updates (see run() call below).
bot.on('message_reaction' as Parameters<typeof bot.on>[0], (ctx) => {
  try {
    // The payload is typed loosely via grammy's Context; cast to the
    // Bot API shape we need (MessageReactionUpdated).
    const update = (ctx as unknown as {
      update: {
        message_reaction?: {
          chat: { id: number }
          message_id: number
          old_reaction: Array<{ type: string; emoji?: string }>
          new_reaction: Array<{ type: string; emoji?: string }>
        }
      }
    }).update.message_reaction
    if (!update) return

    const chat_id = String(update.chat.id)
    const message_id = update.message_id
    const oldReaction = update.old_reaction ?? []
    const newReaction = update.new_reaction ?? []

    // Both empty — defensive no-op.
    if (oldReaction.length === 0 && newReaction.length === 0) return

    // Determine action and emoji for logging / storage.
    let action: 'add' | 'remove' | 'change'
    let emoji: string | null

    if (oldReaction.length === 0 && newReaction.length > 0) {
      action = 'add'
      const first = newReaction.find(r => r.type === 'emoji')
      if (!first) return // custom emoji only — skip
      emoji = first.emoji ?? null
    } else if (oldReaction.length > 0 && newReaction.length === 0) {
      action = 'remove'
      emoji = null
    } else {
      action = 'change'
      const first = newReaction.find(r => r.type === 'emoji')
      if (!first) return // custom emoji only — skip
      emoji = first.emoji ?? null
    }

    if (HISTORY_ENABLED) {
      try {
        recordReaction({ chat_id, message_id, emoji })
      } catch (err) {
        process.stderr.write(`telegram gateway: history recordReaction failed: ${err}\n`)
      }
    }

    process.stderr.write(
      `telegram gateway: reaction: chatId=${chat_id} messageId=${message_id} emoji=${emoji ?? '(none)'} action=${action}\n`,
    )
  } catch (err) {
    process.stderr.write(`telegram gateway: message_reaction handler error: ${err}\n`)
  }
})

// ─── Error handler ────────────────────────────────────────────────────────
bot.catch(err => {
  process.stderr.write(`telegram gateway: handler error (polling continues): ${err.error}\n`)
})

// ─── Shutdown ─────────────────────────────────────────────────────────────
//
// 35-second drain budget. The 2026-04-23 incident showed that a 3-second
// hard exit was NOT enough — the kernel hadn't FIN'd the long-poll TCP
// socket before the new gateway process started, so Telegram returned
// 409 Conflict to both pollers for 13+ retries (10–12s backoffs each).
// systemd's TimeoutStopSec is set to 45s in generateGatewayUnit so we
// have headroom.
const SHUTDOWN_DRAIN_BUDGET_MS = 35_000

/** Best-effort in-flight counter for the drain loop. Sums the maps that
 * track outstanding side-effects: permission prompts the user hasn't
 * answered, vault operations mid-passphrase-entry, coalesce timers
 * still buffering an outbound, and reauth flows. The IPC server is
 * stopped explicitly via close() so its inflight isn't counted here. */
function countInFlight(): number {
  return (
    pendingPermissions.size +
    pendingVaultOps.size +
    coalesceBuffer.size +
    pendingReauthFlows.size
  )
}

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  const agentName = process.env.SWITCHROOM_AGENT_NAME ?? '-'
  process.stderr.write('telegram gateway: shutting down\n')

  // Write the clean-shutdown sentinel BEFORE any drain work begins so
  // even if the drain hangs and the +5s force-exit kills us, the marker
  // is already on disk for the next boot to find. This is what tells
  // the next gateway "this restart was planned (systemd/CLI/Coolify),
  // don't post the 'recovered from unexpected restart' banner". Distinct
  // from restart-pending.json, which is the user-initiated /restart
  // marker (chat_id + ack_message_id, posts a quote-reply ack).
  //
  // ONLY write the marker for genuine OS-signal shutdowns. uncaughtException
  // and unhandledRejection ALSO route through shutdown() to release the
  // startup mutex (PR #53 nit fix), but those are real crashes — writing
  // the marker on a crash would suppress its own recovery banner at the
  // next boot, defeating the entire feature.
  //
  // Preserve any reason an initiator stamped microseconds before SIGTERM.
  // CLI/watchdog/user-slash paths call writeRestartReasonMarker(…reason)
  // right before issuing `systemctl restart`; without this readback the
  // shutdown handler would clobber their reason with a signal-only
  // marker, and the next greeting card would render no Restarted row.
  // Falls back to `"systemctl: external restart"` when no initiator
  // stamped a reason (bare `systemctl restart switchroom-<name>-gateway`
  // from an admin terminal) so the greeting always surfaces WHY we
  // bounced. See resolveShutdownMarker() for the full decision table.
  const isOsSignal = signal === 'SIGTERM' || signal === 'SIGINT'
  if (isOsSignal) {
    try {
      const prior = readCleanShutdownMarker(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH)
      const next = resolveShutdownMarker(prior, signal, Date.now())
      writeCleanShutdownMarker(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH, next)
      process.stderr.write(`telegram gateway: shutdown.clean_marker_written signal=${signal} reason=${JSON.stringify(next.reason ?? '')} preserved=${prior?.reason === next.reason && prior != null} path=${GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH}\n`)
    } catch (err) {
      process.stderr.write(`telegram gateway: shutdown.clean_marker_write_failed err=${(err as Error).message}\n`)
    }
  } else {
    process.stderr.write(`telegram gateway: shutdown.clean_marker_skipped signal=${signal} (crash path — banner will fire on next boot)\n`)
  }

  // Stage 3c: stamp any in-flight turn as endedVia='sigterm' (or 'restart'
  // for the schedule_restart-initiated case where pendingRestarts is set).
  // Best-effort — SIGKILL / OOM skip this path entirely and the next-boot
  // reaper catches them as endedVia='restart'.
  if (turnsDb != null && currentTurnRegistryKey != null) {
    const wasScheduledRestart = pendingRestarts.size > 0
    const endedVia = wasScheduledRestart ? 'restart' : 'sigterm'
    try {
      recordTurnEnd(turnsDb, {
        turnKey: currentTurnRegistryKey,
        endedVia,
        lastAssistantMsgId: currentTurnLastAssistantMsgId,
        lastAssistantDone: currentTurnLastAssistantDone,
        // Phase 1 of #332: record how many tools fired before the kill.
        // No assistant_reply_preview here — the reply was never committed.
        toolCallCount: currentTurnToolCallCount,
      })
      process.stderr.write(`telegram gateway: shutdown.turn_stamped turnKey=${currentTurnRegistryKey} endedVia=${endedVia}\n`)
    } catch (err) {
      process.stderr.write(`telegram gateway: shutdown.turn_stamp_failed turnKey=${currentTurnRegistryKey} err=${(err as Error).message}\n`)
    }
    currentTurnRegistryKey = null
  }

  // Stop the long-poll health check before draining so it doesn't trigger
  // a stall-recovery restart while we're already in shutdown.
  pollHealthCheck?.stop()

  // Clean up all timers and pending state.
  // Snapshot timer handles before clearing so a late-firing timer can't
  // invalidate the iterator by deleting its own entry during cleanup.
  subagentWatcher?.stop()
  subagentWatcher = null

  for (const iv of [...typingIntervals.values()]) clearInterval(iv)
  typingIntervals.clear()
  for (const t of [...typingRetryTimers.values()]) clearTimeout(t)
  typingRetryTimers.clear()

  for (const t of [...coalesceBuffer.values()].map((e) => e.timer)) clearTimeout(t)
  // NOTE: don't clear coalesceBuffer yet — the drain wants to observe
  // its size as in_flight. Caveat: clearTimeout cancels the timer but
  // doesn't purge the entry (entries are normally removed by the timer
  // callback itself), so countInFlight() may report phantom coalesce
  // entries during drain. Benign: coalesceBuffer.clear() runs after
  // drain completes, and the drain budget covers the wait.

  clearInterval(pendingStateReaper)
  vaultPassphraseCache.clear()

  if (orphanedReplyTimeoutId != null) {
    clearTimeout(orphanedReplyTimeoutId)
    orphanedReplyTimeoutId = null
  }

  // Notify bridges so they can mark themselves disconnected.
  ipcServer.broadcast({ type: 'status', status: 'gateway_shutting_down' })

  // Hard force-exit safety net at budget + 5s. systemd's TimeoutStopSec
  // is 45s; if we're not done by 40s something is genuinely wedged and
  // we'd rather exit than block the unit.
  // NOTE: this path intentionally skips releaseStartupLock — it only fires
  // when drain genuinely hung, and the next boot's stale-PID auto-recovery
  // (acquireStartupLock) reclaims the lock cleanly.
  const forceExitTimer = setTimeout(() => {
    process.stderr.write('telegram gateway: shutdown.force_exit budget_exceeded\n')
    process.exit(0)
  }, SHUTDOWN_DRAIN_BUDGET_MS + 5_000)
  forceExitTimer.unref()

  // Drain: stop polling, then await in-flight to settle. The drain
  // module logs shutdown.drain_start and shutdown.drain_complete so
  // operators can see exactly how long the long-poll took to die — the
  // KEY signal for diagnosing the next 409-conflict report.
  await drainShutdown({
    signal,
    stopPolling: async () => {
      if (runnerHandle != null) {
        await runnerHandle.stop()
      } else {
        await bot.stop()
      }
    },
    inFlight: countInFlight,
    budgetMs: SHUTDOWN_DRAIN_BUDGET_MS,
    agentName,
  })

  // Now finish the cleanup the drain didn't touch.
  coalesceBuffer.clear()
  pendingReauthFlows.clear()
  pendingVaultOps.clear()
  pendingPermissions.clear()

  try {
    await ipcServer.close()
  } catch (err) {
    process.stderr.write(`telegram gateway: ipc close error: ${err}\n`)
  }

  // Release the startup mutex / clear PID file. Logs shutdown.lock_released.
  // Session marker is intentionally left on disk — it's read by the
  // NEXT gateway process's banner-gate.
  await releaseStartupLock({
    path: GATEWAY_PID_PATH,
    pid: process.pid,
    agentName,
  })
  // Belt-and-braces: legacy clearPidFile is a no-op if the file is
  // already gone (which it should be after releaseStartupLock).
  clearPidFile(GATEWAY_PID_PATH)

  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

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

  // Watchdog: re-pin if Telegram's current pin drifts away from ours
  // mid-turn. Probed on heartbeat emits, rate-limited per turnKey.
  const pinWatchdog = createPinWatchdog({
    getCurrentPinned: async (chatId) => {
      const chat = await lockedBot.api.getChat(chatId)
      // `pinned_message` is present on groups/supergroups when a pin
      // exists; `message_id` is the pinned message's id. Private-chat
      // shape is the same — the field is absent when nothing is pinned.
      const pinnedMessage =
        'pinned_message' in chat
          ? (chat as { pinned_message?: { message_id: number } }).pinned_message
          : undefined
      return pinnedMessage?.message_id
    },
    pin: (chatId, messageId, opts) => lockedBot.api.pinChatMessage(chatId, messageId, opts),
    log: (line) => process.stderr.write(line),
  })

  unpinProgressCardForChat = (chatId: string, threadId: number | undefined): void => {
    pinMgr.unpinForChat(chatId, threadId)
  }

  /**
   * Classify a Telegram API error for the progress-card failure-escalation
   * mechanism. Returns an ApiFailureInfo for reportApiFailure(), or a
   * transient classification for unknown errors.
   */
  function classifyProgressCardApiError(err: unknown): ApiFailureInfo {
    if (err instanceof GrammyError) {
      const code = err.error_code
      const desc = err.description ?? ''
      if (code === 400 && /\bmessage is not modified\b/i.test(desc)) {
        return { code, description: desc, kind: 'benign' }
      }
      // 429 Too Many Requests is explicitly retryable — Telegram includes a
      // retry_after hint. Must short-circuit BEFORE the generic 4xx branch,
      // otherwise a rate-limit burst would count toward the permanent threshold
      // and permanently silence the card.
      if (code === 429) {
        return { code, description: desc, kind: 'transient' }
      }
      if (code >= 400 && code < 500) {
        return { code, description: desc, kind: 'permanent_4xx' }
      }
      return { code, description: desc, kind: 'transient' }
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND')
    ) {
      return { code: 0, description: msg, kind: 'transient' }
    }
    return { code: 0, description: msg, kind: 'transient' }
  }

  progressDriver = createProgressDriver({
    emit: ({ chatId, threadId, turnKey, html, done, isFirstEmit, replyToMessageId }) => {
      const args = {
        chat_id: chatId, text: html, done, message_thread_id: threadId,
        lane: 'progress', format: 'html', turnKey,
        // Pass the source message_id as reply_to on the initial send only
        // (isFirstEmit=true). handleStreamReply only applies reply_to on
        // stream creation (first call for a given sKey), so subsequent
        // edits — which reuse the existing DraftStream — naturally ignore
        // this. Passing it unconditionally would be harmless, but being
        // explicit here documents the "first send only" contract.
        // We also opt out of auto-quote (quote:false) so that if
        // replyToMessageId is absent the progress card sends bare — it
        // doesn't want a random "latest inbound" quote attached.
        quote: false as const,
        ...(isFirstEmit && replyToMessageId != null
          ? { reply_to: String(replyToMessageId) }
          : {}),
      }
      handleStreamReply(args, { activeDraftStreams, activeDraftParseModes, suppressPtyPreview }, {
        bot: lockedBot, retry: robustApiCall, markdownToHtml, escapeMarkdownV2, repairEscapedWhitespace,
        takeHandoffPrefix: () => '', assertAllowedChat, resolveThreadId, disableLinkPreview: true,
        defaultFormat: 'html', logStreamingEvent, endStatusReaction,
        historyEnabled: false, recordOutbound: () => {},
        writeError: (line) => process.stderr.write(line),
      }).then((result) => {
        // Successful API call — reset the consecutive-4xx counter.
        progressDriver?.reportApiSuccess(turnKey)
        // #203: progress-card edit is a user-visible signal.
        signalTracker.noteSignal(statusKey(chatId, threadId != null ? Number(threadId) : undefined), Date.now())
        if (!result?.messageId) return
        pinMgr.considerPin({
          chatId,
          threadId,
          turnKey,
          messageId: result.messageId,
          isFirstEmit,
        })
        // Heartbeat watchdog: after the initial pin has been recorded,
        // every subsequent (non-final) emit probes Telegram to confirm
        // our pin is still the one on display. Rate-limited internally.
        if (!isFirstEmit && !done) {
          const expectedId = pinMgr.pinnedMessageId(turnKey)
          if (expectedId != null) {
            void pinWatchdog.verify({ chatId, turnKey, expectedMessageId: expectedId })
          }
        }
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`telegram gateway: progress-card emit failed: ${msg}\n`)
        progressDriver?.reportApiFailure(turnKey, classifyProgressCardApiError(err))
      })
    },
    onTurnEnd: (summary) => {
      const agentDir = resolveAgentDirFromEnv()
      if (agentDir != null) writeLastTurnSummary(agentDir, summary)
    },
    onTurnComplete: ({ chatId, threadId, turnKey, summary }) => {
      process.stderr.write(`telegram gateway: progress-card: onTurnComplete callback turnKey=${turnKey}\n`)
      pinMgr.completeTurn({ chatId, threadId, turnKey })
      pinWatchdog.clear(turnKey)
      if (threadId != null) {
        lockedBot.api.sendMessage(chatId, `✅ Done — ${summary}`).catch((err: Error) => {
          process.stderr.write(`telegram gateway: completion message failed: ${err.message}\n`)
        })
      }
      // Phase 3 of #332: update the progress-card pin with the idle footer so
      // the user can see at a glance when the agent last replied.
      if (turnsDb != null) {
        try {
          const rows = findRecentTurnsForChat(turnsDb, chatId, 1)
          const turnRows = rows.map(r => ({
            turnKey: r.turn_key,
            chatId: r.chat_id,
            startedAt: r.started_at,
            endedAt: r.ended_at,
          }))
          const footer = formatIdleFooter(turnRows, Date.now())
          const pinnedMsgId = pinMgr.pinnedMessageId(turnKey)
          if (pinnedMsgId != null) {
            lockedBot.api.editMessageText(chatId, pinnedMsgId, footer, { parse_mode: 'HTML' }).catch((err: Error) => {
              process.stderr.write(`telegram gateway: idle-footer edit failed chatId=${chatId} msgId=${pinnedMsgId}: ${err.message}\n`)
            })
          }
        } catch (err) {
          process.stderr.write(`telegram gateway: idle-footer render failed chatId=${chatId}: ${(err as Error).message}\n`)
        }
      }
    },
    onSilentEnd: ({ chatId, turnKey }) => {
      // Write a state file so the Stop hook can detect a silent-end and
      // block the session to re-prompt the agent. The hook increments
      // retryCount; on the second silent-end (retryCount >= 1) it allows
      // the stop so this warning card renders.
      const statePath = join(STATE_DIR, 'silent-end-pending.json')
      let retryCount = 0
      try {
        if (existsSync(statePath)) {
          const prev = JSON.parse(readFileSync(statePath, 'utf8'))
          // Only inherit retryCount from a stale file when it belongs to the
          // SAME turn — otherwise a previous turn's exhausted counter would
          // suppress the retry on a fresh silent-end.
          if (prev.turnKey === turnKey) {
            retryCount = typeof prev.retryCount === 'number' ? prev.retryCount : 0
          }
        }
      } catch {
        retryCount = 0
      }
      const suppressed = retryCount === 0
      try {
        writeFileSync(
          statePath,
          JSON.stringify({ chatId, turnKey, retryCount, timestamp: Date.now() }),
          'utf8',
        )
        process.stderr.write(
          `telegram gateway: silent-end: wrote state file turnKey=${turnKey} retryCount=${retryCount} suppressed=${suppressed}\n`,
        )
      } catch (err) {
        process.stderr.write(
          `telegram gateway: silent-end: failed to write state file: ${(err as Error).message}\n`,
        )
      }
      return { suppressed }
    },
    maxIdleMs: 5 * 60_000,
  })
  process.stderr.write('telegram gateway: progress-card driver active\n')
}

// ─── Startup ──────────────────────────────────────────────────────────────
initHandoffContinuity()

// Top-level error handlers route through shutdown() so the startup lock is
// released cleanly. Without this, a top-level throw would leave the lock
// held until the next boot's stale-PID auto-recovery — workable, but noisy.
// The `shuttingDown` guard inside shutdown() prevents double-invocation if
// SIGTERM races with one of these handlers.
//
// `unhandledRejection` is discriminated through `classifyRejection` so that
// benign Telegram 400s ("message is not modified", "message to edit not
// found") are logged but NOT crashed-on. These leaked through restart loops
// for klanker (#99) and lawgpt's mid-day crash family — see the unit tests
// in `tests/unhandled-rejection-policy.test.ts`.
process.on('unhandledRejection', err => {
  const action = classifyRejection(err)
  process.stderr.write(
    `telegram gateway: unhandled rejection (${action}): ${err}\n`,
  )
  if (action === 'shutdown') {
    void shutdown('unhandledRejection')
  }
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram gateway: uncaught exception: ${err}\n`)
  void shutdown('uncaughtException')
})

let runnerHandle: RunnerHandle | null = null

// Long-poll health-check handle (issue #56). Created once per process, started
// after the runner comes up, stopped on clean shutdown. The `onStall` callback
// stops the runner so the outer retry loop can restart it.
//
// Interval and threshold are configurable via env for ops/testing flexibility:
//   SWITCHROOM_POLL_HEALTH_INTERVAL_MS — default 5 min
//   SWITCHROOM_POLL_HEALTH_THRESHOLD   — default 3
const POLL_HEALTH_INTERVAL_MS = Number(
  process.env.SWITCHROOM_POLL_HEALTH_INTERVAL_MS ?? 5 * 60_000,
)
const POLL_HEALTH_THRESHOLD = Number(
  process.env.SWITCHROOM_POLL_HEALTH_THRESHOLD ?? 3,
)

/** Sentinel error thrown by onStall so the outer for-loop retries rather
 *  than exiting. The catch block recognises this specific message. */
class PollStallError extends Error {
  constructor() {
    super('poll_stall_restart')
    this.name = 'PollStallError'
  }
}

let pollHealthCheck: PollHealthCheckHandle | null = null
if (POLL_HEALTH_INTERVAL_MS > 0) {
  pollHealthCheck = createPollHealthCheck({
    ping: () => bot.api.getMe(),
    onStall: async () => {
      const agentName = process.env.SWITCHROOM_AGENT_NAME ?? '-'
      process.stderr.write(
        `telegram gateway: poll.health_check.stall_recovery stopping runner agent=${agentName}\n`,
      )
      if (runnerHandle != null && runnerHandle.isRunning()) {
        try {
          await runnerHandle.stop()
        } catch (err) {
          process.stderr.write(
            `telegram gateway: poll.health_check.stall_recovery runner.stop error: ${(err as Error).message}\n`,
          )
        }
      }
      // runnerHandle.stop() causes task() to resolve. That would normally
      // hit the `return` below and exit the startup IIFE. Instead we throw
      // PollStallError from inside task()'s continuation by surfacing it
      // through the outer catch block — but task() itself doesn't throw here.
      //
      // The simpler fix: set runnerHandle to a sentinel that the code below
      // `await runnerHandle.task()` checks to decide continue vs return.
      runnerHandle = null
    },
    intervalMs: POLL_HEALTH_INTERVAL_MS,
    failureThreshold: POLL_HEALTH_THRESHOLD,
    log: (msg) => process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n'),
  })
}

// One-shot startup guard. The outer for-loop below re-enters its try block
// on 409 Conflict retries — those are transient polling conflicts, not
// process restarts. Anything that should fire exactly once per gateway
// process (restart-marker send, crash-recovery banner, boot-time pin sweep,
// auto-fallback setInterval, bot-command registration) must be gated by
// this flag. Otherwise every 409 retry re-runs them, producing the
// spurious "⚡ Recovered from unexpected restart" banners observed on
// 2026-04-22 (user received 4+ banners in 2 minutes while PID was constant
// and systemd logged zero lifecycle events — the only signal was the
// grammY 409 retry loop).
let didOneTimeSetup = false

void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      // ── Startup network-retry fence ───────────────────────────────────────
      // On boot the network stack may not be truly usable yet even after
      // network-online.target fires (observed 2026-04-29: all 5 gateways
      // started at ~21:26:26 and couldn't reach api.telegram.org for ~27 min).
      // Grammy throws HttpError for both deleteWebhook and getMe in that case.
      // `gatewayStartupRetry` absorbs those with exponential backoff (1s→64s,
      // 8 total attempts, ~2 min budget). On exhaustion it calls process.exit(1)
      // so systemd's Restart=always can restart the unit from a clean state.
      // Non-network errors (bad token, 403, etc.) are rethrown immediately so
      // the catch block below can handle them as before.
      const me = await gatewayStartupRetry(async () => {
        // Clear any orphan long-poll from a previous gateway process before we
        // start our own. See clearStaleTelegramPollingState docstring for the
        // production incident that motivates this. Safe to re-run on retries.
        await clearStaleTelegramPollingState(bot.api)
        return bot.api.getMe()
      })
      botUsername = me.username
      process.stderr.write(`telegram gateway: polling as @${me.username}\n`)
      if (TOPIC_ID != null) process.stderr.write(`telegram gateway: topic filter active — thread_id=${TOPIC_ID}\n`)

      if (!didOneTimeSetup) {
        didOneTimeSetup = true
        void registerSwitchroomBotCommands().catch(() => {})

        // Boot-time pin sweep
        try {
          const bootAccess = loadAccess()
          const chatSet = new Set<string>(bootAccess.allowFrom)
          for (const gid of Object.keys(bootAccess.groups)) chatSet.add(gid)
          // Filter out user DM IDs (positive integers) — the Bot API returns
          // `400 chat not found` for users who have never messaged the bot.
          // Only sweep group/supergroup IDs (negative integers) at boot.
          const sweepableIds: string[] = []
          const skippedIds: string[] = []
          for (const id of chatSet) {
            if (shouldSweepChatAtBoot(id)) {
              sweepableIds.push(id)
            } else {
              skippedIds.push(id)
            }
          }
          for (const id of skippedIds) {
            process.stderr.write(`telegram gateway: startup: skipped chat ${id} (not yet reachable)\n`)
          }
          if (sweepableIds.length > 0) {
            // Track chats that fail the boot probe so we can surface a
            // user-facing notice after the sweep completes.
            const bootProbeFailures: Array<{ chatId: string; reason: string }> = []
            void sweepBotAuthoredPins(
              sweepableIds, me.id,
              async (chatId) => {
                try {
                  const chat = await lockedBot.api.getChat(chatId)
                  const pinned = (chat as { pinned_message?: { message_id: number; from?: { id: number } } }).pinned_message
                  if (!pinned) return null
                  return { messageId: pinned.message_id, fromId: pinned.from?.id ?? null }
                } catch (err) {
                  // Catch ALL getChat errors at boot — a single unreachable
                  // chat must never kill the gateway (issue #166). Log
                  // structurally so operators can diagnose, then continue.
                  const reason = err instanceof GrammyError
                    ? `${err.error_code} ${err.description}`
                    : (err instanceof Error ? err.message : String(err))
                  process.stderr.write(
                    `telegram gateway: boot-probe-failed: chatId=${chatId} reason=${JSON.stringify(reason)}\n`,
                  )
                  bootProbeFailures.push({ chatId, reason })
                  return null
                }
              },
              (chatId, messageId) => lockedBot.api.unpinChatMessage(chatId, messageId),
              { log: (msg) => process.stderr.write(`telegram gateway: bot-authored pin sweep — ${msg}\n`) },
            ).then(() => {
              // After sweep: post a user-facing notice for each failed probe
              // to the first reachable allowlisted DM chat. Failures here are
              // non-fatal — we never let notification errors crash boot.
              if (bootProbeFailures.length === 0) return
              const notifyChat = bootAccess.allowFrom[0]
              if (!notifyChat) return
              for (const { chatId, reason } of bootProbeFailures) {
                const text = `⚠️ <b>Boot probe failed</b>\nCould not reach chat <code>${chatId}</code> at startup — bot may not be a member.\n<i>${reason}</i>`
                lockedBot.api.sendMessage(notifyChat, text, { parse_mode: 'HTML' }).catch((e: unknown) => {
                  process.stderr.write(`telegram gateway: boot-probe-notify failed: ${e}\n`)
                })
              }
            }).catch(() => {})
          }
        } catch {}

        // Boot card — always post on every gateway start with the restart reason.
        // Gated on session marker so a grammY poll-restart (same process, no
        // actual restart) does NOT re-post.  See session-marker.ts for the
        // 2026-04-22 incident that introduced this gate.
        try {
          const nowMs = Date.now()
          const marker = readRestartMarker()
          const cleanMarker = readCleanShutdownMarker(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH)
          const currentSession: SessionMarker = { pid: process.pid, startedAtMs: GATEWAY_STARTED_AT_MS }
          const storedSession = readSessionMarker(GATEWAY_SESSION_MARKER_PATH)
          const isRealRestart = shouldFireRestartBanner({ stored: storedSession, current: currentSession })

          if (cleanMarker) {
            const ageSec = Math.max(0, Math.round((nowMs - cleanMarker.ts) / 1000))
            const reasonTag = cleanMarker.reason ? ` reason=${JSON.stringify(cleanMarker.reason)}` : ''
            const cleanFresh = shouldSuppressRecoveryBanner(cleanMarker, nowMs, CLEAN_SHUTDOWN_MAX_AGE_MS)
            if (cleanFresh) {
              process.stderr.write(`telegram gateway: boot.clean_shutdown_detected age=${ageSec}s signal=${cleanMarker.signal}${reasonTag}\n`)
            } else {
              process.stderr.write(`telegram gateway: boot.clean_shutdown_marker_stale age=${ageSec}s signal=${cleanMarker.signal}${reasonTag}\n`)
            }
            // No clearCleanShutdownMarker() call — the marker is a single
            // self-overwriting file, age-gated by shouldSuppressRecoveryBanner,
            // so leaving it on disk is harmless. (Pre-#142 the agent-side
            // session-greeting.sh did the cleanup; that script is deleted.)
          }

          if (marker) {
            const ageMs = nowMs - marker.ts
            const ageSec = Math.max(1, Math.round(ageMs / 1000))
            process.stderr.write(`telegram gateway: boot: restart-marker present, chat_id=${marker.chat_id} age=${ageSec}s within5min=${ageMs < 5 * 60_000}\n`)
            clearRestartMarker()
          }

          if (!isRealRestart) {
            process.stderr.write(`telegram gateway: boot: suppressed boot card — session marker matches current process (pid=${process.pid} startedAt=${GATEWAY_STARTED_AT_MS})\n`)
          } else {
            const markerAgeMs = marker ? nowMs - marker.ts : undefined
            const reason = determineRestartReason({ marker, cleanMarker, sessionMarker: storedSession, now: nowMs })
            const target = resolveBootChatId(marker, markerAgeMs)

            // Issue #92: when reason='crash' AND no chat is resolvable,
            // the gateway used to silently skip — the only signal a user
            // got was their next message landing on a fresh process. Now
            // we always surface unplanned crashes via the operator-events
            // pipeline, which broadcasts to access.allowFrom (same path
            // permission requests use). The pipeline's per-agent per-kind
            // cooldown protects against crash loops spamming the chat.
            if (reason === 'crash') {
              const cleanMarkerStale = cleanMarker
                ? !shouldSuppressRecoveryBanner(cleanMarker, nowMs, CLEAN_SHUTDOWN_MAX_AGE_MS)
                : false
              const detailParts: string[] = ['gateway crashed and was auto-restarted by systemd']
              if (cleanMarker?.signal) detailParts.push(`prior signal=${cleanMarker.signal}`)
              if (cleanMarkerStale) detailParts.push('clean-shutdown marker stale')
              emitGatewayOperatorEvent({
                kind: 'agent-crashed',
                agent: process.env.SWITCHROOM_AGENT_NAME ?? '-',
                detail: detailParts.join(' — '),
                suggestedActions: [],
                firstSeenAt: new Date(),
              })
            }

            if (target) {
              const { chatId, threadId, ackMsgId } = target
              process.stderr.write(`telegram gateway: boot: posting boot card reason=${reason} chat_id=${chatId} thread_id=${threadId ?? '-'} ackReply=${ackMsgId ?? '-'} boot_card=${BOOT_CARD_ENABLED}\n`)
              if (BOOT_CARD_ENABLED) {
                const agentDir = resolveAgentDirFromEnv()
                const agentSlug = process.env.SWITCHROOM_AGENT_NAME ?? '-'
                const agentDisplayName = resolvePersonaName(agentSlug)
                const botApiForCard: import('./boot-card.js').BotApiForBootCard = {
                  sendMessage: (cid, text, opts) => lockedBot.api.sendMessage(cid, text, opts as Parameters<typeof lockedBot.api.sendMessage>[2]) as Promise<{ message_id: number }>,
                  editMessageText: (cid, mid, text, opts) => lockedBot.api.editMessageText(cid, mid, text, opts as Parameters<typeof lockedBot.api.editMessageText>[3]),
                }
                try {
                  const handle = await startBootCard(chatId, threadId, botApiForCard, {
                    agentName: agentDisplayName,
                    agentSlug,
                    version: formatBootVersion(),
                    agentDir: agentDir ?? join(homedir(), '.switchroom', 'agents', agentSlug),
                    gatewayInfo: { pid: process.pid, startedAtMs: GATEWAY_STARTED_AT_MS },
                    restartReason: reason,
                    restartAgeMs: markerAgeMs,
                  }, ackMsgId)
                  activeBootCard = handle
                } catch (err) {
                  process.stderr.write(`telegram gateway: boot: boot card error: ${err}\n`)
                }
              } else {
                const ageSec = markerAgeMs != null ? Math.max(1, Math.round(markerAgeMs / 1000)) : 0
                postLegacyBanner(chatId, threadId, ackMsgId, ageSec, 'boot')
              }
            } else {
              process.stderr.write(`telegram gateway: boot: no known chat for boot card (reason=${reason}) — skipping\n`)
            }
          }

          // Always update the session marker so subsequent boots see "stored === current".
          try {
            writeSessionMarker(GATEWAY_SESSION_MARKER_PATH, currentSession)
          } catch (err) {
            process.stderr.write(`telegram gateway: writeSessionMarker failed: ${err}\n`)
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

        // Restart-watchdog: poll systemd's NRestarts for the agent unit.
        // When the count ticks up without a corresponding restart-pending
        // marker (= user-initiated /restart), emit an operator event.
        // Closes #30 task 4 and the 2026-04-21 lessons-learned loop where
        // IPC flaps falsely triggered the gateway's recovery banner.
        // SWITCHROOM_RESTART_WATCHDOG_POLL_MS=0 disables it.
        const RESTART_WATCHDOG_POLL_MS = Number(
          process.env.SWITCHROOM_RESTART_WATCHDOG_POLL_MS ?? 30_000,
        )
        const watchdogAgentName = process.env.SWITCHROOM_AGENT_NAME
        if (RESTART_WATCHDOG_POLL_MS > 0 && watchdogAgentName) {
          startRestartWatchdog({
            agentName: watchdogAgentName,
            pollIntervalMs: RESTART_WATCHDOG_POLL_MS,
            execShow: (unit) =>
              execFileSync(
                'systemctl',
                ['--user', 'show', unit, '-p', 'NRestarts,ActiveEnterTimestampMonotonic'],
                { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] },
              ) as string,
            isPlannedRestartFresh: () => isPlannedRestartFresh(),
            emit: (detail) => {
              emitGatewayOperatorEvent({
                kind: 'agent-restarted-unexpectedly',
                agent: watchdogAgentName,
                detail,
                suggestedActions: [],
                firstSeenAt: new Date(),
              })
            },
            log: (msg) =>
              process.stderr.write(msg.endsWith('\n') ? `telegram gateway: ${msg}` : `telegram gateway: ${msg}\n`),
          })
        }

        // Background sub-agent visibility watcher. Watches the subagents/
        // directory under each session dir for new agent-<id>.jsonl files
        // and surfaces live activity to Telegram via a pinned card +
        // inline notifications. Only started when a valid agentDir is known
        // (gate on streamMode=checklist for progress-card parity).
        if (streamMode === 'checklist') {
          const watcherAgentDir = resolveAgentDirFromEnv()
          if (watcherAgentDir != null) {
            subagentWatcher = startSubagentWatcher({
              agentDir: watcherAgentDir,
              // Bug 0 fix: previously omitted, leaving the watcher unable to
              // write liveness/stall/turn_end updates to the registry DB.
              // Liveness writes are now persisted across the gateway lifetime.
              db: turnsDb,
              sendNotification: (text: string) => {
                const ownerChatId = loadAccess().allowFrom[0]
                if (!ownerChatId) return
                void lockedBot.api.sendMessage(ownerChatId, text, {
                  parse_mode: 'HTML',
                  link_preview_options: { is_disabled: true },
                  ...(TOPIC_ID != null ? { message_thread_id: TOPIC_ID } : {}),
                }).catch((err: Error) => {
                  process.stderr.write(`telegram gateway: subagent-watcher notification failed: ${err.message}\n`)
                })
              },
              log: (msg) => process.stderr.write(`telegram gateway: ${msg}\n`),
              // Option C (#393): route stall detections into the progress-card
              // driver so the pinned card re-renders with a ⚠️ indicator even
              // when the bridge has disconnected and events have stopped flowing.
              onStall: (agentId, idleMs, description) => {
                progressDriver?.onSubAgentStall(agentId, idleMs, description)
              },
            })
            process.stderr.write('telegram gateway: subagent-watcher active\n')
          }
        }
      }

      process.stderr.write(`telegram gateway: answer-stream draft transport=${sendMessageDraftFn != null ? 'available' : 'unavailable'} grammy=${GRAMMY_VERSION}\n`)
      process.stderr.write(`telegram gateway: starting bot polling pid=${process.pid} agent=${process.env.SWITCHROOM_AGENT_NAME ?? '-'} stateDir=${STATE_DIR} historyEnabled=${HISTORY_ENABLED} streamMode=${process.env.SWITCHROOM_TG_STREAM_MODE ?? 'checklist'}\n`)
      runnerHandle = run(bot, {
        runner: {
          fetch: {
            // message_reaction and message_reaction_count are opt-in —
            // Telegram only delivers them when explicitly requested.
            // message_reaction_count (anonymous group reaction tallies) is
            // listed here for completeness but we don't handle it (out of scope).
            allowed_updates: [
              'message', 'edited_message', 'channel_post', 'edited_channel_post',
              'callback_query', 'inline_query', 'chosen_inline_result',
              'shipping_query', 'pre_checkout_query', 'poll', 'poll_answer',
              'my_chat_member', 'chat_member', 'chat_join_request',
              'message_reaction', 'message_reaction_count',
            ],
          },
        },
      })
      // Start the long-poll health-check now that the runner is up.
      // Stop first in case we're re-entering the loop after a stall recovery.
      pollHealthCheck?.stop()
      pollHealthCheck?.start()
      await runnerHandle.task()
      // If onStall fired, it called runnerHandle.stop() which resolved task()
      // above, then set runnerHandle = null. Detect that here and continue the
      // loop to restart the runner. A normal clean exit leaves runnerHandle non-
      // null (the stopped handle is still non-null at this point), so we can
      // distinguish: null means stall-triggered, non-null means clean exit.
      if (runnerHandle === null) {
        const agentName = process.env.SWITCHROOM_AGENT_NAME ?? '-'
        process.stderr.write(
          `telegram gateway: poll.health_check.stall_recovery restarting runner agent=${agentName}\n`,
        )
        // Brief pause so the Telegram API can close the stalled connection.
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      return
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 409) {
        const delay = Math.min(1000 * attempt, 15000)
        const agentName = process.env.SWITCHROOM_AGENT_NAME ?? '-'
        // Two log lines so journalctl has both the WHY (detected) and
        // the WHEN (scheduled). The architectural fix (startup mutex
        // + 35s SIGTERM drain) should eliminate the OLD-process race
        // entirely — if these still appear together with the OLD pid
        // alive, the mutex isn't being honoured and we need to look
        // harder. Keep both lines so the next incident has signal.
        process.stderr.write(
          `telegram gateway: poll.409.detected attempt=${attempt} retry_in_ms=${delay} agent=${agentName}\n`,
        )
        process.stderr.write(
          `telegram gateway: poll.retry_scheduled reason=409 attempt=${attempt} delay_ms=${delay} agent=${agentName}\n`,
        )
        // Legacy line preserved so older grep patterns keep working.
        process.stderr.write(`telegram gateway: 409 Conflict, retrying in ${delay / 1000}s\n`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (err instanceof Error && err.message === 'Aborted delay') return
      process.stderr.write(`telegram gateway: polling failed: ${err}\n`)
      // Exit non-zero so systemd's Restart=always re-runs the unit instead of
      // leaving a live-but-silent process that never polls. Previously this path
      // just `return`ed — that IS the bug from 2026-04-29 where all 5 gateways
      // stayed alive but deaf after a boot-time network failure.
      // Note: network errors at startup are handled earlier by gatewayStartupRetry
      // (with bounded retries before the exit); reaching here means either a
      // non-network fatal error, or an unexpected mid-session failure. Either
      // way, exiting is safer than silently staying alive with polling stopped.
      process.exit(1)
    }
  }
})()
