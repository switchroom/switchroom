/**
 * Pure builder for the synthetic `subagent_progress` inbound the
 * gateway injects when a *background* sub-agent emits a narrative line
 * (`sub_agent_text`) past a bucket boundary while still running.
 *
 * Why this exists (conversational-pacing beat 3 — mid-flight progress
 * for background workers):
 *
 *   - Foreground sub-agents stream their narrative into the parent's
 *     turn natively; the parent can surface progress in its own voice
 *     as the work unfolds.
 *   - Background sub-agents are decoupled from any turn boundary. The
 *     parent is typically idle while the worker runs. Without a wake,
 *     the user sees nothing between dispatch and the eventual handback
 *     (beat 4, #1719). The cross-turn ambient ticker in
 *     `pending-work-progress.ts` keeps the parent's last reply alive
 *     ("— still working (Nm)") but says NOTHING about *what's
 *     happening* — it's liveness, not content.
 *
 * The watcher already captures `lastResultText` on every
 * `sub_agent_text` emission (`subagent-watcher.ts:607-622`). We
 * piggyback on that event stream: every `progressIntervalMs` worth of
 * elapsed time, the next narrative line minted by the worker becomes
 * a synthetic `<channel source="subagent_progress">` inbound. The
 * parent wakes, sees the cue, and surfaces one user-facing line of
 * progress in its own voice. No timer-driven polling, no TaskOutput
 * sampling, no `expected_duration` parameter.
 *
 * Two divergences from the #1719 handback envelope:
 *
 *   1. Determinism by BUCKET, not by jsonl id alone. The spool dedup
 *      id is `s:progress:<jsonl_agent_id>:<bucketIdx>` where
 *      `bucketIdx = floor(elapsedMs / progressIntervalMs)`. A worker
 *      that emits 10 narrative lines inside a single bucket window
 *      still produces exactly one envelope; the next bucket gets its
 *      own envelope. Monotonic, idempotent across restarts.
 *
 *   2. TTL — every progress envelope sets `meta.expiresAt` to
 *      `nowMs + 2 × progressIntervalMs`. A 4-hour-stale
 *      "still working (5m)" delivered after a long downtime would be a
 *      lie; handback envelopes don't have this asymmetry (they're
 *      "deliver-eventually OK"). The spool's `liveEntries()` skips
 *      expired entries — see `inbound-spool.ts`.
 *
 * Shape contract mirrors `subagent-handback-inbound-builder.ts`: the
 * `meta.source` string is load-bearing for the channel wrapper.
 */

import type { InboundMessage } from './ipc-protocol.js'

/** Cap on the latest-summary text carried in the inbound. The model
 *  synthesises a one-line update from it; the full transcript is never
 *  needed and an unbounded paste bloats the parent's context. */
export const PROGRESS_RESULT_MAX = 800
/** Cap on the dispatch-time task description echoed back for context. */
export const PROGRESS_DESC_MAX = 200
/** Default bucket size — how often a fresh progress envelope may fire
 *  for a given sub-agent. 5 min is well past the conversational-pacing
 *  beat 2/3 boundary and matches the refined RFC. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 5 * 60 * 1000

export interface SubagentProgressContext {
  /** Telegram chat the work was dispatched from. */
  chatId: string
  /** Supergroup topic (message_thread_id) the work was dispatched from,
   *  so the progress wake-up turn and the model's reply land in the
   *  originating topic. Omitted for DM-shaped chats. */
  threadId?: number
  /** JSONL-derived sub-agent id (stable per Claude Code spawn). Pinned
   *  into the spool id so envelopes for the same worker dedup across
   *  buckets cleanly and survive gateway restarts. */
  subagentJsonlId: string
  /** Dispatch-time task description (the sub-agent's `description`). */
  taskDescription: string
  /** Worker's most recent narrative line — the cue payload. May be
   *  empty when the worker emits a tool-use without prose; the
   *  envelope is still useful (it tells the parent "still alive"). */
  latestSummary: string
  /** ms elapsed since the worker was dispatched. */
  elapsedMs: number
  /** Bucket index = floor(elapsedMs / progressIntervalMs). The
   *  determinism axis. */
  bucketIdx: number
  /** Window size (ms) used to compute `bucketIdx`. The envelope's TTL
   *  is `2 × progressIntervalMs` past `nowMs`. */
  progressIntervalMs: number
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

function formatElapsed(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 60) return `${Math.max(1, totalMin)}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h${m}m`
}

/**
 * Build the synthetic InboundMessage for a mid-flight background
 * sub-agent. Deterministic under a fixed `nowMs` for tests.
 */
export function buildSubagentProgressInbound(opts: {
  ctx: SubagentProgressContext
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const desc = truncate(opts.ctx.taskDescription, PROGRESS_DESC_MAX) || '(no description)'
  const summary = truncate(opts.ctx.latestSummary, PROGRESS_RESULT_MAX)
  const elapsed = formatElapsed(opts.ctx.elapsedMs)
  const expiresAt = ts + 2 * opts.ctx.progressIntervalMs

  const text =
    `🔄 A background worker you dispatched is still running.\n\n` +
    `Task: ${desc}\n` +
    `Elapsed: ${elapsed}\n\n` +
    (summary
      ? `Latest activity:\n${summary}\n\n`
      : `(no narrative line yet — worker has been tool-only)\n\n`) +
    `This is beat 3 — mid-flight progress. Surface ONE short line to ` +
    `the user in your own voice about what the worker is up to. Do ` +
    `NOT paste this raw, do NOT repeat the elapsed time verbatim, do ` +
    `NOT promise completion. The handback (beat 4) will come ` +
    `separately when the worker finishes.`

  return {
    type: 'inbound',
    chatId: opts.ctx.chatId,
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts, // synthetic — no Telegram message id exists
    user: 'subagent-watcher',
    userId: 0,
    ts,
    text,
    meta: {
      source: 'subagent_progress',
      // Originating chat as a model-visible channel attribute — same
      // load-bearing turn-registration role as the handback builder's
      // meta.chat_id (see subagent-handback-inbound-builder.ts): without it
      // the progress turn mints no turn atom (no `turns` row, no
      // `turn-active.json`), so a worker dispatched from inside it can never
      // be attributed to this chat/topic and its surfaces fall to the DM.
      chat_id: opts.ctx.chatId,
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      subagent_jsonl_id: opts.ctx.subagentJsonlId,
      bucket_idx: String(opts.ctx.bucketIdx),
      expiresAt: String(expiresAt),
      elapsed_ms: String(opts.ctx.elapsedMs),
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Progress decision (pure — unit-testable gate for the gateway onProgress path)
// ───────────────────────────────────────────────────────────────────────────

export interface SubagentProgressDecisionInput {
  /** `SWITCHROOM_DISABLE_SUBAGENT_PROGRESS` env var value (any non-empty
   *  value other than '0' disables progress envelopes entirely). */
  disableEnvValue: string | undefined
  /** Whether the sub-agent was a background dispatch. Foreground
   *  sub-agents already surface narrative inside the parent's turn. */
  isBackground: boolean
  /** Chat id from the progress-driver fleet entry; '' if not found. */
  fleetChatId: string
  /** Owner chat fallback (access.json allowFrom[0]); '' if none. */
  ownerChatId: string
  /** Supergroup topic the work was dispatched from. Applied ONLY when
   *  `fleetChatId` resolved (the origin chat won); the DM fallback is
   *  topic-less. */
  originThreadId?: number
  subagentJsonlId: string
  taskDescription: string
  latestSummary: string
  elapsedMs: number
  /** Window size (ms). */
  progressIntervalMs: number
  /** Last bucket idx already emitted for this sub-agent — null if no
   *  envelope has fired yet. The gateway tracks this per-agent and
   *  passes it in; the decision returns the new bucket idx on
   *  `deliver: true` so the caller can update its tracker. */
  lastBucketIdx: number | null
  /** #3233: true for a growth-independent SKELETON liveness cue (empty
   *  `latestSummary`, no step content). It exists ONLY to first-paint /
   *  keep-alive the in-message worker-feed row; the legacy bucket relay would
   *  turn it into a synthesized "still working" inbound with no content — a
   *  blank card. Suppressed deterministically here so the worker-feed-DISABLED
   *  path degrades to a no-op rather than a blank envelope. */
  skeleton?: boolean
  /** Deterministic clock for tests. */
  nowMs?: number
}

export type SubagentProgressSkipReason =
  | 'env-disabled'
  | 'skeleton-liveness'
  | 'foreground'
  | 'no-chat'
  | 'bucket-already-fired'
  | 'first-bucket-suppressed'
  | 'missing-jsonl-id'

export type SubagentProgressDecision =
  | { deliver: false; reason: SubagentProgressSkipReason }
  | { deliver: true; chatId: string; bucketIdx: number; inbound: InboundMessage }

/**
 * Decide whether to deliver a mid-flight progress envelope. Pure — all
 * IO (registry lookup, fleet peek, access.json read) is the caller's
 * job.
 *
 * Gates, in order:
 *   1. kill-switch — `SWITCHROOM_DISABLE_SUBAGENT_PROGRESS=1` disables.
 *   1b. skeleton-liveness (#3233) — a contentless skeleton cue is never
 *       relayed as a synthesized inbound (worker-feed row only).
 *   2. foreground — foreground sub-agents stream natively.
 *   3. no-chat    — nowhere to deliver.
 *   4. missing-jsonl-id — the dedup key. Without it we'd lose
 *      deterministic bucketing across restarts; refuse rather than
 *      degrade silently.
 *   5. first-bucket-suppressed — bucket 0 covers the first
 *      `progressIntervalMs` window when ambient liveness is plenty.
 *      The earliest envelope is bucket 1 (≥ one full window in).
 *   6. bucket-already-fired — same bucket → same spoolId → no-op.
 */
/**
 * Parse a boolean-ish env var. Treats `undefined`, empty string, `'0'`,
 * `'false'`, `'no'`, `'off'` (case-insensitive, trimmed) as OFF. Any
 * other non-empty value is ON.
 *
 * The original gate used `value !== '0'`, which foot-gunned on
 * `'false'` / `'no'` / `'off'` — treating those as enabled instead of
 * disabled. Centralising the parse here keeps the kill-switch
 * interpretation a single hop from the var-read site.
 */
export function isEnvFlagOn(value: string | undefined): boolean {
  if (value == null) return false
  const v = value.trim().toLowerCase()
  if (v === '') return false
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return true
}

export function decideSubagentProgress(
  input: SubagentProgressDecisionInput,
): SubagentProgressDecision {
  if (isEnvFlagOn(input.disableEnvValue)) {
    return { deliver: false, reason: 'env-disabled' }
  }
  // #3233: a skeleton liveness cue carries no step content — never relay it as
  // a synthesized progress inbound (that would be a blank card). Its whole job
  // is the in-message worker-feed row; when that surface is off, degrade to a
  // no-op. Checked before bucketing so it can never advance the bucket tracker.
  if (input.skeleton === true) {
    return { deliver: false, reason: 'skeleton-liveness' }
  }
  if (!input.isBackground) {
    return { deliver: false, reason: 'foreground' }
  }
  const chatId = input.fleetChatId || input.ownerChatId
  if (!chatId) {
    return { deliver: false, reason: 'no-chat' }
  }
  if (!input.subagentJsonlId) {
    return { deliver: false, reason: 'missing-jsonl-id' }
  }
  const bucketIdx = Math.floor(input.elapsedMs / input.progressIntervalMs)
  if (bucketIdx < 1) {
    return { deliver: false, reason: 'first-bucket-suppressed' }
  }
  if (input.lastBucketIdx != null && bucketIdx <= input.lastBucketIdx) {
    return { deliver: false, reason: 'bucket-already-fired' }
  }
  const threadId =
    input.fleetChatId && input.originThreadId != null ? input.originThreadId : undefined
  const inbound = buildSubagentProgressInbound({
    ctx: {
      chatId,
      ...(threadId != null ? { threadId } : {}),
      subagentJsonlId: input.subagentJsonlId,
      taskDescription: input.taskDescription,
      latestSummary: input.latestSummary,
      elapsedMs: input.elapsedMs,
      bucketIdx,
      progressIntervalMs: input.progressIntervalMs,
    },
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  })
  return { deliver: true, chatId, bucketIdx, inbound }
}
