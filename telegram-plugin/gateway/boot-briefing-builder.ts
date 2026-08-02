/**
 * Pure builders for the gateway boot-time conversation briefing
 * (`session_continuity.briefing: gateway`).
 *
 * Why this exists: the legacy handoff path reorients a fresh session from
 * artifacts a *previous* process had to write on the way down (the Stop-hook
 * `.handoff.md`, or `bin/handoff-briefing.sh` run from start.sh). Both are
 * crash-dependent and land in `--append-system-prompt`, where every restart
 * invalidates the system-prompt prefix cache. This module instead assembles
 * the briefing at BOOT, from the durable gateway SQLite history
 * (`telegram-plugin/history.ts` — the same `messages` table behind
 * `get_recent_messages`), and the gateway injects it as a synthetic first
 * user turn (`<channel source="boot_briefing">`) over the spool transport —
 * so the system-prompt prefix stays byte-stable across sessions and the
 * briefing survives any crash shape (the DB is written per-message, not at
 * shutdown).
 *
 * Design contract (mirrors `resume-inbound-builder.ts`):
 *   - This module stays PURE — no bun:sqlite import, no fs, no env reads.
 *     The DB arrives through the minimal `BriefingDb` seam and file/env
 *     access through explicit parameters, so every bound (surface scoping,
 *     depth, budget, dedup, error tolerance) is unit-testable without a
 *     gateway. The impure orchestration lives in `boot-briefing-wiring.ts`.
 *   - SURFACE-SCOPED, never a global tail: messages are grouped per
 *     (chat_id, thread_id) surface. A DM agent yields one section
 *     (`thread_id IS NULL`); a forum agent renders the most-recently-active
 *     surface at full depth and every other surface active in the last 48h
 *     as a two-line header + its last message.
 *   - Bounded: hard character budget (~1.5–2K tokens at ~4 chars/token),
 *     per-message truncation, oldest-first within the primary section.
 *   - Crash/contention tolerant: any DB error (SQLITE_BUSY, timeout,
 *     corruption) yields an EMPTY briefing — boot is never blocked and
 *     never throws through this module.
 *   - Resume dedup: messages already covered by a synthetic resume
 *     inbound's interrupted-turn window (same surface, ts >= the turn's
 *     started_at) are ELIDED so this briefing and
 *     `resume-inbound-builder.ts` never double-inject the same exchange.
 */

import type { InboundMessage } from './ipc-protocol.js'
import { humanizeElapsed, RESUME_SYNTHETIC_PROMPT_PREFIX } from './resume-inbound-builder.js'

/** `meta.source` of the synthetic briefing inbound. The bridge forwards it
 *  verbatim, so the model sees `<channel source="boot_briefing">` and knows
 *  this is a reorientation turn, not a human message. */
export const BOOT_BRIEFING_SOURCE = 'boot_briefing'

/** Hard character budget for the rendered briefing. ~7000 chars ≈ 1.75K
 *  tokens at the ~4 chars/token heuristic — inside the design's 1.5–2K
 *  token budget. (Deliberately a CHAR bound: the builder has no tokenizer,
 *  and a conservative chars-per-token divisor keeps the guarantee real.) */
export const BRIEFING_CHAR_BUDGET = 7000

/** Per-message truncation bound (chars), before budget accounting. */
export const BRIEFING_PER_MESSAGE_MAX_CHARS = 400

/** Full-depth message count for the most-recently-active surface. */
export const BRIEFING_PRIMARY_DEPTH = 15

/** Only surfaces active within this window are included at all. */
export const BRIEFING_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000

/** Cap on the number of surfaces rendered (primary + secondaries). */
export const BRIEFING_MAX_SURFACES = 8

/** TTL on the spooled briefing inbound: a briefing that could not be
 *  delivered within this window is stale context — the spool's
 *  `meta.expiresAt` filter drops it instead of delivering old news. */
export const BRIEFING_TTL_MS = 60 * 60 * 1000

/** The history writer's boot self-check sentinel chat (see
 *  `verifyHistoryWritable` in history.ts). Never a real surface; excluded
 *  defensively even though the self-check deletes its rows. */
const HISTORY_SELFCHECK_CHAT = '__history_selfcheck__'

/**
 * Minimal read seam over the history DB. Matches the `prepare(...).all(...)`
 * subset of `bun:sqlite`'s Database that history.ts already types, so the
 * wiring can hand the live handle straight through while tests inject a
 * fake (including one that throws SQLITE_BUSY).
 */
export interface BriefingDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
}

/** One recorded message, as rendered into the briefing. `ts` is unix
 *  SECONDS (the history schema's unit). */
export interface BriefingMessageRow {
  role: string
  user: string | null
  ts: number
  text: string
}

/** One (chat, thread) surface with its selected messages, newest surface
 *  first in the collector's output. `messages` is oldest-first. */
export interface BriefingSurface {
  chatId: string
  threadId: number | null
  /** unix seconds of the surface's most recent message. */
  lastTs: number
  messages: BriefingMessageRow[]
}

/**
 * The interrupted-turn window a synthetic resume inbound already covers.
 * Messages on this surface at/after `sinceMs` are elided from the briefing
 * so the two boot synthetics never double-inject the same exchange.
 */
export interface BriefingExcludeWindow {
  chatId: string
  threadId: number | null
  sinceMs: number
}

export interface CollectBriefingOptions {
  nowMs: number
  activeWindowMs?: number
  primaryDepth?: number
  maxSurfaces?: number
  exclude?: BriefingExcludeWindow | null
}

/**
 * Derive the resume-dedup exclusion window from an already-built boot
 * resume/report inbound. Returns null when there is no resume synthetic
 * (the common clean-boot case) or its meta is missing the anchors.
 */
export function excludeWindowFromResumeInbound(
  msg: InboundMessage | null | undefined,
): BriefingExcludeWindow | null {
  if (msg == null) return null
  const chatId = msg.meta?.chat_id
  const startedAt = Number(msg.meta?.started_at)
  if (typeof chatId !== 'string' || chatId.length === 0) return null
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null
  const threadRaw = msg.meta?.message_thread_id
  const threadNum = threadRaw != null && threadRaw !== '' ? Number(threadRaw) : null
  return {
    chatId,
    threadId: threadNum != null && Number.isFinite(threadNum) ? threadNum : null,
    sinceMs: startedAt,
  }
}

function sameSurface(
  a: { chatId: string; threadId: number | null },
  b: { chatId: string; threadId: number | null },
): boolean {
  return a.chatId === b.chatId && (a.threadId ?? null) === (b.threadId ?? null)
}

/**
 * Query the history DB for the agent's active surfaces and their messages.
 *
 * Surface-scoped by construction: surfaces are the distinct
 * (chat_id, thread_id) pairs with `role IN ('user','assistant')` activity
 * inside the active window, most-recent first. The first surface gets
 * `primaryDepth` messages; every other surface gets its single last
 * message (rendered as a header + preview).
 *
 * NEVER throws: any DB failure (SQLITE_BUSY under writer contention, a
 * missing table, corruption) returns `[]` so the caller degrades to an
 * empty briefing instead of blocking or crashing boot.
 */
export function collectBriefingSurfaces(
  db: BriefingDb,
  opts: CollectBriefingOptions,
): BriefingSurface[] {
  const activeWindowMs = opts.activeWindowMs ?? BRIEFING_ACTIVE_WINDOW_MS
  const primaryDepth = opts.primaryDepth ?? BRIEFING_PRIMARY_DEPTH
  const maxSurfaces = opts.maxSurfaces ?? BRIEFING_MAX_SURFACES
  const cutoffSec = Math.floor((opts.nowMs - activeWindowMs) / 1000)
  try {
    const surfaceRows = db
      .prepare(
        `SELECT chat_id, thread_id, MAX(ts) AS last_ts
           FROM messages
          WHERE role IN ('user','assistant')
            AND ts >= ?
            AND chat_id <> ?
          GROUP BY chat_id, thread_id
          ORDER BY last_ts DESC
          LIMIT ?`,
      )
      .all(cutoffSec, HISTORY_SELFCHECK_CHAT, maxSurfaces) as Array<{
      chat_id: string
      thread_id: number | null
      last_ts: number
    }>
    const out: BriefingSurface[] = []
    for (let i = 0; i < surfaceRows.length; i++) {
      const s = surfaceRows[i]!
      const depth = i === 0 ? primaryDepth : 1
      const threadClause = s.thread_id == null ? 'thread_id IS NULL' : 'thread_id = ?'
      const params: unknown[] = [s.chat_id]
      if (s.thread_id != null) params.push(s.thread_id)
      params.push(depth)
      const msgRows = db
        .prepare(
          `SELECT role, user, ts, text
             FROM messages
            WHERE chat_id = ? AND ${threadClause}
              AND role IN ('user','assistant')
            ORDER BY ts DESC, message_id DESC
            LIMIT ?`,
        )
        .all(...(params as [unknown, ...unknown[]])) as Array<{
        role: string
        user: string | null
        ts: number
        text: string | null
      }>
      msgRows.reverse() // oldest-first for rendering
      let messages: BriefingMessageRow[] = msgRows.map((r) => ({
        role: r.role,
        user: r.user ?? null,
        ts: r.ts,
        text: r.text ?? '',
      }))
      // Resume dedup: elide messages the resume synthetic's interrupted-turn
      // window already covers (same surface, at/after the turn's started_at).
      const ex = opts.exclude
      if (
        ex != null &&
        sameSurface({ chatId: s.chat_id, threadId: s.thread_id ?? null }, ex)
      ) {
        const sinceSec = Math.floor(ex.sinceMs / 1000)
        messages = messages.filter((m) => m.ts < sinceSec)
      }
      if (messages.length === 0) continue // fully elided / empty — drop surface
      out.push({
        chatId: s.chat_id,
        threadId: s.thread_id ?? null,
        lastTs: s.last_ts,
        messages,
      })
    }
    return out
  } catch {
    // SQLITE_BUSY / timeout / schema drift — an empty briefing, never a
    // blocked or crashed boot.
    return []
  }
}

/** Codepoint-safe truncation (mirrors resume-inbound-builder's
 *  `truncatePrompt` — a naive .slice can split a surrogate pair). Also
 *  collapses whitespace runs so each message renders as one line. */
function truncateOneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const points = Array.from(t)
  if (points.length <= max) return t
  return points.slice(0, max - 1).join('').trimEnd() + '…'
}

function surfaceLabel(s: { chatId: string; threadId: number | null }): string {
  return s.threadId != null ? `chat ${s.chatId}, topic ${s.threadId}` : `chat ${s.chatId}`
}

function renderMessageLine(
  m: BriefingMessageRow,
  nowMs: number,
  perMessageMax: number,
): string {
  const label = m.role === 'user' ? (m.user && m.user.trim() ? m.user.trim() : 'user') : 'you'
  const age = humanizeElapsed(Math.max(0, nowMs - m.ts * 1000))
  return `- [${age} ago] ${label}: ${truncateOneLine(m.text, perMessageMax)}`
}

export interface RenderBriefingOptions {
  nowMs: number
  /** Restart-reason breadcrumb (`.restart-reason` / SWITCHROOM_PENDING_*),
   *  folded into the header when present. */
  restartReason?: string | null
  charBudget?: number
  perMessageMax?: number
}

/**
 * Render the briefing text. Empty string when there is nothing to brief
 * (no active surfaces) — the caller must then inject NOTHING.
 *
 * Deliberately starts with `RESUME_SYNTHETIC_PROMPT_PREFIX` ("You just
 * restarted.") — the same machine-stable token every synthetic boot
 * inbound leads with — so if the briefing turn is itself interrupted, the
 * boot-resume loop-guard (`isResumeSyntheticTurn`) classifies it as a
 * synthetic turn and never auto-resumes it into a restart→briefing chain.
 *
 * Budgeting: the primary section is trimmed OLDEST-first (newest messages
 * are the ones worth keeping) until the total fits `charBudget`; secondary
 * surface blocks are then appended most-recent-first only while they fit.
 * The returned string is always <= charBudget.
 */
export function renderBootBriefing(
  surfaces: BriefingSurface[],
  opts: RenderBriefingOptions,
): string {
  if (surfaces.length === 0) return ''
  const charBudget = opts.charBudget ?? BRIEFING_CHAR_BUDGET
  const perMessageMax = opts.perMessageMax ?? BRIEFING_PER_MESSAGE_MAX_CHARS
  const reasonClause =
    opts.restartReason && opts.restartReason.trim()
      ? ` The previous session ended via: ${truncateOneLine(opts.restartReason, 120)}.`
      : ''
  const header =
    `${RESUME_SYNTHETIC_PROMPT_PREFIX} This is an automatic boot briefing assembled ` +
    `from your durable message history — context to reorient you, NOT a new user ` +
    `request.${reasonClause} Read it, then: if nothing in it is unfinished or owed, ` +
    `do NOT message the user (end the turn with NO_REPLY); if something was clearly ` +
    `left unfinished or owed, briefly pick it up. The full history is available via ` +
    `get_recent_messages.`

  const primary = surfaces[0]!
  const primaryTitle =
    `## Active conversation — ${surfaceLabel(primary)} ` +
    `(last active ${humanizeElapsed(Math.max(0, opts.nowMs - primary.lastTs * 1000))} ago)`
  const primaryLines = primary.messages.map((m) =>
    renderMessageLine(m, opts.nowMs, perMessageMax),
  )

  const assemble = (lines: string[], secondaries: string[]): string => {
    const parts = [header, '', primaryTitle, ...lines]
    if (secondaries.length > 0) {
      parts.push('', '## Other recent surfaces (active in the last 48h)', ...secondaries)
    }
    return parts.join('\n')
  }

  // Trim the primary section oldest-first until the briefing (without any
  // secondaries yet) fits the budget. Always keep at least the newest line.
  const kept = [...primaryLines]
  while (kept.length > 1 && assemble(kept, []).length > charBudget) {
    kept.shift()
  }
  if (assemble(kept, []).length > charBudget) {
    // Degenerate (budget smaller than header + one line): hard-truncate.
    return assemble(kept, []).slice(0, charBudget)
  }

  // Append secondary surfaces (header + last-message preview — the
  // "2-line header + last message" shape) while they fit.
  const secondaries: string[] = []
  for (const s of surfaces.slice(1)) {
    const last = s.messages[s.messages.length - 1]!
    const block =
      `- ${surfaceLabel(s)} — last active ` +
      `${humanizeElapsed(Math.max(0, opts.nowMs - s.lastTs * 1000))} ago:\n` +
      `  ${renderMessageLine(last, opts.nowMs, perMessageMax).slice(2)}`
    if (assemble(kept, [...secondaries, block]).length > charBudget) break
    secondaries.push(block)
  }
  return assemble(kept, secondaries)
}

/**
 * Read the restart-reason breadcrumb the legacy handoff-briefing.sh folds
 * in: `<agentDir>/.restart-reason` (first line), overridden by
 * `SWITCHROOM_PENDING_ENDED_VIA` when set (same precedence as the shell
 * script). Pure via the injected `readFile`; never throws.
 */
export function readRestartBreadcrumb(opts: {
  restartReasonPath: string | null
  env: Record<string, string | undefined>
  readFile: (path: string) => string
}): string | null {
  let reason: string | null = null
  if (opts.restartReasonPath) {
    try {
      const raw = opts.readFile(opts.restartReasonPath)
      const first = raw.split('\n')[0]?.replace(/\r/g, '').trim()
      if (first) reason = first
    } catch {
      /* missing / unreadable breadcrumb — fine */
    }
  }
  const envVia = opts.env.SWITCHROOM_PENDING_ENDED_VIA
  if (typeof envVia === 'string' && envVia.trim().length > 0) reason = envVia.trim()
  return reason
}

/** Feature-flag / suppression decision for the gateway briefing. Pure. */
export interface BootBriefingDecision {
  build: boolean
  reason:
    | 'ok'
    | 'flag-legacy'
    | 'force-fresh'
    | 'transcript-replay-possible'
}

/**
 * Decide whether this boot should build a gateway briefing at all.
 *
 *   - `briefingMode !== 'gateway'` → legacy path owns continuity; build
 *     nothing (the default until the gateway path has soaked).
 *   - `.force-fresh-session` marker present (a /reset · /new restart) →
 *     the user explicitly asked for a clean slate; re-injecting recent
 *     context would defeat the reset.
 *   - `resumeMode` 'continue' or 'auto' → the inner claude launch may
 *     replay the full transcript via `--continue`; a briefing on top would
 *     duplicate it. ('auto' can still fall back to a fresh session for an
 *     oversized/stale transcript — the gateway forks before start.sh's
 *     inner pass computes CONTINUE_FLAG, so we suppress conservatively;
 *     documented follow-up.)
 */
export function decideBootBriefing(opts: {
  briefingMode: string | undefined
  resumeMode: string | undefined
  forceFreshMarker: boolean
}): BootBriefingDecision {
  if (opts.briefingMode !== 'gateway') return { build: false, reason: 'flag-legacy' }
  if (opts.forceFreshMarker) return { build: false, reason: 'force-fresh' }
  if (opts.resumeMode === 'continue' || opts.resumeMode === 'auto') {
    return { build: false, reason: 'transcript-replay-possible' }
  }
  return { build: true, reason: 'ok' }
}

/**
 * Build the synthetic briefing inbound. Routed to the primary (most
 * recently active) surface so the turn gets a currentTurn / progress card
 * in the conversation the context belongs to — same rationale as the
 * resume builders' `meta.chat_id`. Carries `meta.expiresAt` so the spool's
 * TTL filter drops a briefing that went stale before delivery.
 */
export function buildBootBriefingInbound(args: {
  chatId: string
  threadId: number | null
  text: string
  nowMs?: number
  ttlMs?: number
}): InboundMessage {
  const ts = args.nowMs ?? Date.now()
  const ttlMs = args.ttlMs ?? BRIEFING_TTL_MS
  const meta: Record<string, string> = {
    source: BOOT_BRIEFING_SOURCE,
    chat_id: args.chatId,
    ...(args.threadId != null ? { message_thread_id: String(args.threadId) } : {}),
    // message_id mirrors the resume builders: rides the enqueue's channel
    // XML so the deliver-until-acked queue can ack THIS synthetic. Never
    // used as a Telegram reply_to.
    message_id: String(ts),
    expiresAt: String(ts + ttlMs),
  }
  return {
    type: 'inbound',
    chatId: args.chatId,
    ...(args.threadId != null ? { threadId: args.threadId } : {}),
    messageId: ts,
    user: 'switchroom',
    userId: 0,
    ts,
    text: args.text,
    meta,
  }
}
