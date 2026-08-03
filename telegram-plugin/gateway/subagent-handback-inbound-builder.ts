/**
 * Pure builder for the synthetic `subagent_handback` inbound the gateway
 * injects when a *background* sub-agent (worker / researcher) finishes.
 *
 * Why this exists (conversational-pacing beat 4 — the handback):
 * A foreground sub-agent hands its result straight back as the `Task`
 * tool result, in the parent's own turn — the model sees it in-context.
 * A background sub-agent does not: it finishes decoupled from any turn
 * boundary, and when it completes the parent agent is typically idle
 * with no turn in flight to receive the result. Claude Code surfaces a
 * background result only on the parent's *next* turn — for a Telegram
 * agent that means the user must send another message before they ever
 * hear back. The agent never proactively says "the worker's done".
 *
 * This builder produces the InboundMessage that closes that gap. The
 * gateway's subagent-watcher `onFinish` callback (which already knows
 * the moment a background sub-agent terminates) feeds the worker's
 * result text in here; the gateway delivers the envelope through the
 * same idle-drain path cron and vault-grant wake-ups use. The model
 * wakes, sees `<channel source="subagent_handback">`, and synthesises a
 * user-facing handback in its own voice — beat 4 made deterministic.
 *
 * Shape contract (mirrors `vault-grant-inbound-builders.ts`): the
 * `meta.source` string is load-bearing — the MCP channel notification
 * wraps it as `<channel source="subagent_handback">`. A regression that
 * changes the source string or drops a meta field silently breaks the
 * wake-up. Pinned by `subagent-handback-inbound-builder.test.ts`.
 */

import type { InboundMessage } from './ipc-protocol.js'

/** Cap on the worker result text carried in the inbound. The model
 *  synthesises a fresh handback from it — the full transcript is never
 *  needed, and an unbounded paste bloats the parent's context. */
export const HANDBACK_RESULT_MAX = 3000
/** Cap on the dispatch-time task description echoed back for context. */
export const HANDBACK_DESC_MAX = 200

export interface SubagentHandbackContext {
  /** Telegram chat the work was dispatched from — the synthesized
   *  handback turn lands here so it stays with the conversation. */
  chatId: string
  /** Supergroup topic (message_thread_id) the work was dispatched from.
   *  Carried so the synthesized handback turn — and the model's
   *  in-voice "here's what the worker found" reply — land in the
   *  originating topic, not the chat's last-seen topic. Omitted for
   *  DM-shaped chats (no topics). See `gateway.ts:resolveSubagentOriginChat`. */
  threadId?: number
  /** Dispatch-time task description (the sub-agent's `description`). */
  taskDescription: string
  /** The worker's final result text — its last narrative emission
   *  before terminating. May be empty if the watcher never observed a
   *  text line (rare: a worker that only ran tools then exited). */
  resultText: string
  /** Terminal outcome as classified by the watcher. */
  outcome: 'completed' | 'failed'
  /** JSONL filename stem for this Claude Code spawn — unique per
   *  sub-agent run. Plumbed into `meta.subagent_jsonl_id` so the
   *  spool can mint a deterministic dedup id (`s:handback:<id>`),
   *  closing the #1719 re-fire-on-restart class. Optional only for
   *  back-compat with older builder callers — when present the
   *  spoolId branch fires, when absent the spool falls back to the
   *  legacy ts-based id (status-quo behaviour). */
  jsonlAgentId?: string
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * Build the synthetic InboundMessage for a finished background
 * sub-agent. Deterministic under a fixed `nowMs` for tests.
 */
export function buildSubagentHandbackInbound(opts: {
  ctx: SubagentHandbackContext
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const desc = truncate(opts.ctx.taskDescription, HANDBACK_DESC_MAX) || '(no description)'
  const result = truncate(opts.ctx.resultText, HANDBACK_RESULT_MAX)

  const text =
    opts.ctx.outcome === 'failed'
      ? `🤝 A background worker you dispatched has FAILED.\n\n` +
        `Task: ${desc}\n\n` +
        (result ? `What it reported before failing:\n${result}\n\n` : '') +
        `This is beat 4 — the handback. Tell the user plainly that the ` +
        `delegated work did not complete, what is known, and your ` +
        `recommended next step — one \`reply\` in your own voice. Do not ` +
        `stay silent.`
      : `🤝 A background worker you dispatched has finished.\n\n` +
        `Task: ${desc}\n\n` +
        (result
          ? `What the worker reported:\n${result}\n\n`
          : `The worker left no summary text.\n\n`) +
        `This is beat 4 — the handback. Synthesise this for the user ` +
        `now: one \`reply\` in your own voice covering what the worker ` +
        `found and your recommended next step. Do NOT paste the raw ` +
        `report and do NOT stay silent — the user dispatched this and ` +
        `is waiting to hear back.`

  return {
    type: 'inbound',
    chatId: opts.ctx.chatId,
    // Top-level threadId → the enqueued turn's sessionThreadId, so the
    // handback turn's live activity feed routes to the originating topic.
    ...(opts.ctx.threadId != null ? { threadId: opts.ctx.threadId } : {}),
    messageId: ts, // synthetic — no Telegram message id exists
    user: 'subagent-watcher',
    userId: 0,
    ts,
    text,
    meta: {
      source: 'subagent_handback',
      outcome: opts.ctx.outcome,
      // Carry the originating chat as a model-visible channel attribute
      // (mirrors the real-inbound + resume_interrupted shapes — see
      // inbound-router.ts:buildInboundEnvelope and resume-inbound-builder.ts).
      // LOAD-BEARING for turn registration: the gateway's enqueue handler
      // (`beginTurn`, stream-render.ts) gates the ENTIRE turn-atom mint on
      // `ev.chatId`, which is parsed from the channel XML's `chat_id`
      // attribute — rendered ONLY from meta. Without it a handback turn gets
      // NO `turns` row and NO `turn-active.json` marker, so a worker
      // dispatched from inside that turn cannot be stamped with a
      // `parent_turn_key` at dispatch (#2085) nor attributed by the
      // started_at window backfill — its card + handback then misroute to
      // the owner DM (Telegram msg 6897 incident, 2026-08-04).
      chat_id: opts.ctx.chatId,
      // #3268 — round-trip the fabricated `ts` through `meta.message_id` so it
      // survives to enqueue. `ev.messageId` at enqueue is parsed from the
      // channel envelope's `message_id` attribute, which is rendered ONLY from
      // `meta.message_id` — the top-level `messageId` field does NOT survive the
      // bridge. Without this, enqueue's `deriveTurnId` returns null → the
      // dead-air pre-turn card's identity-based adoption never matches (the card
      // is orphaned + a false "handback never started" reap message fires on
      // every SUCCESSFUL handback). Mirrors resume-inbound-builder.ts's
      // `message_id: String(ts)` for the identical enqueue-round-trip reason. It
      // is NEVER used as a Telegram reply anchor: `parseSourceMessageId` gates
      // the 13-digit synthetic ts out of the reply-anchor path at enqueue.
      message_id: String(ts),
      // meta.message_thread_id is the model-visible channel attribute
      // (mirrors the real-inbound shape) so the model's reply targets
      // the dispatching topic. Mirrors gateway.ts:10557.
      ...(opts.ctx.threadId != null ? { message_thread_id: String(opts.ctx.threadId) } : {}),
      ...(opts.ctx.jsonlAgentId ? { subagent_jsonl_id: opts.ctx.jsonlAgentId } : {}),
    },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Handback decision (pure — unit-testable gate for the gateway onFinish path)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inputs to the handback decision. The gateway's `subagent-watcher`
 * `onFinish` callback does the IO — resolves `isBackground` from the
 * registry DB, `fleetChatId` from the progress-driver fleet, and
 * `ownerChatId` from access.json — then hands the resolved values here.
 * Keeping the *decision* pure makes the gate (which injects turns)
 * testable without standing up a gateway.
 */
export interface SubagentHandbackDecisionInput {
  /** `SWITCHROOM_SUBAGENT_HANDBACK` env var value (any non-'0' = enabled). */
  handbackEnvValue: string | undefined
  /** Terminal outcome the watcher reported. */
  outcome: 'completed' | 'failed' | 'orphan'
  /** Whether the sub-agent was a background dispatch (registry DB flag).
   *  Foreground sub-agents hand back natively in the parent's turn. */
  isBackground: boolean
  /** Chat id from the progress-driver fleet entry; '' if not found. */
  fleetChatId: string
  /** Owner chat fallback (access.json allowFrom[0]); '' if none. */
  ownerChatId: string
  /** Supergroup topic the work was dispatched from (from the parent
   *  turn). Applied ONLY when `fleetChatId` resolved (the origin chat
   *  won) — the `ownerChatId` DM fallback has no topic. */
  originThreadId?: number
  taskDescription: string
  resultText: string
  /** JSONL filename stem for this Claude Code spawn — forwarded into
   *  the built inbound's `meta.subagent_jsonl_id`. See
   *  `SubagentHandbackContext.jsonlAgentId` for the dedup rationale. */
  jsonlAgentId?: string
  /** Deterministic clock for tests. */
  nowMs?: number
}

/** Why a handback was NOT delivered — one of these, or `delivered`. */
export type SubagentHandbackSkipReason =
  | 'env-disabled'
  | 'outcome-not-terminal'
  | 'foreground'
  | 'no-chat'

export type SubagentHandbackDecision =
  | { deliver: false; reason: SubagentHandbackSkipReason }
  | { deliver: true; chatId: string; inbound: InboundMessage }

/**
 * Decide whether a finished sub-agent warrants a handback turn, and if
 * so build the inbound. Pure: all IO is the caller's job.
 *
 * Gates, in order:
 *   1. kill-switch — `SWITCHROOM_SUBAGENT_HANDBACK=0` disables entirely.
 *   2. outcome — only `completed`/`failed` hand back; `orphan` is a
 *      stale historical-at-boot row, not a fresh completion.
 *   3. foreground — a foreground sub-agent already handed its result
 *      back as the Task tool result in the parent's own turn.
 *   4. no-chat — neither the fleet entry nor the owner chat resolved,
 *      so there is nowhere to deliver.
 */
export function decideSubagentHandback(
  input: SubagentHandbackDecisionInput,
): SubagentHandbackDecision {
  if (input.handbackEnvValue === '0') {
    return { deliver: false, reason: 'env-disabled' }
  }
  if (input.outcome !== 'completed' && input.outcome !== 'failed') {
    return { deliver: false, reason: 'outcome-not-terminal' }
  }
  if (!input.isBackground) {
    return { deliver: false, reason: 'foreground' }
  }
  const chatId = input.fleetChatId || input.ownerChatId
  if (!chatId) {
    return { deliver: false, reason: 'no-chat' }
  }
  // Thread only when the origin chat (fleetChatId) won — the ownerChatId
  // DM fallback is topic-less, so a stray thread id would mis-address it.
  const threadId =
    input.fleetChatId && input.originThreadId != null ? input.originThreadId : undefined
  const inbound = buildSubagentHandbackInbound({
    ctx: {
      chatId,
      ...(threadId != null ? { threadId } : {}),
      taskDescription: input.taskDescription,
      resultText: input.resultText,
      outcome: input.outcome,
      ...(input.jsonlAgentId ? { jsonlAgentId: input.jsonlAgentId } : {}),
    },
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
  })
  return { deliver: true, chatId, inbound }
}
