/**
 * Pure builders for the synthetic inbounds the gateway injects at boot
 * when it inherits an interrupted turn from the previous process.
 *
 * Two shapes, selected by how the prior turn ended (see
 * `selectResumeBuilder`):
 *
 *   - `resume_interrupted` — the turn was cut off mid-flight by an
 *     operator restart / SIGTERM / crash while it was still making
 *     progress. The agent should pick the work back up and tell the user
 *     it's resuming. Blanket resume regardless of how long ago — the
 *     elapsed time rides along so the model can frame it ("picking up the
 *     X you asked ~3h ago").
 *
 *   - `resume_watchdog_timeout` — the turn stalled with no tool progress
 *     for the full hang-watchdog window and was (or would have been)
 *     killed as a hang. The agent must NOT silently resume; it reports
 *     what happened honestly and asks whether to retry or take a
 *     different angle. The honest cause is "no observable progress for N
 *     minutes" — the framework deliberately does not invent a deeper root
 *     cause, and neither should the model.
 *
 * Why a separate module (mirrors `vault-grant-inbound-builders.ts`): the
 * InboundMessage shape is load-bearing. `meta.source` is what the bridge
 * forwards verbatim and Claude Code renders as `<channel source="…">`, so
 * the model keys on it to know this is a boot-resume turn rather than a
 * human message. `meta.resume_turn_key` is the dedup anchor the spool
 * uses (see `spoolId`) so a multi-restart sequence resumes a given turn
 * exactly once. Pinning the builders against fixture tests keeps that
 * contract honest without booting a real gateway.
 */

import type { InboundMessage } from './ipc-protocol.js'
import type { Turn, TurnEndedVia } from '../registry/turns-schema.js'

/** Render an elapsed duration as a coarse, human-friendly approximation
 *  the model can drop straight into prose ("~3h ago"). Deliberately
 *  coarse — minute/hour/day buckets, never "2h 47m" precision the user
 *  doesn't care about on a resume. */
export function humanizeElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown amount of time'
  const sec = Math.round(ms / 1000)
  if (sec < 45) return 'moments'
  const min = Math.round(sec / 60)
  if (min < 60) return `~${min} min`
  const hr = Math.round(min / 60)
  if (hr < 24) return `~${hr}h`
  const days = Math.round(hr / 24)
  return `~${days} day${days === 1 ? '' : 's'}`
}

export interface ResumeInboundContext {
  /** The interrupted turn, straight from the registry. */
  turn: Turn
  /** Wall-clock ms. Drives `ts`, `messageId`, and the elapsed framing.
   *  Defaults to Date.now(). */
  nowMs?: number
}

function threadIdNum(turn: Turn): number | undefined {
  if (turn.thread_id == null) return undefined
  const n = Number(turn.thread_id)
  return Number.isFinite(n) ? n : undefined
}

function promptClause(turn: Turn): string {
  const p = turn.user_prompt_preview?.trim()
  if (!p) return ''
  // Quote-trim so a long preview doesn't bloat the channel body.
  const snippet = p.length > 160 ? p.slice(0, 160) + '…' : p
  return ` The request was: "${snippet}".`
}

/**
 * Build the `resume_interrupted` inbound — a clean mid-flight interrupt
 * the agent should pick back up.
 */
export function buildResumeInterruptedInbound(ctx: ResumeInboundContext): InboundMessage {
  const ts = ctx.nowMs ?? Date.now()
  const elapsed = humanizeElapsed(ts - ctx.turn.started_at)
  const meta: Record<string, string> = {
    source: 'resume_interrupted',
    resume_turn_key: ctx.turn.turn_key,
    interrupted_via: ctx.turn.ended_via ?? 'restart',
    started_at: String(ctx.turn.started_at),
  }
  if (ctx.turn.user_prompt_preview) meta.original_prompt = ctx.turn.user_prompt_preview
  const threadId = threadIdNum(ctx.turn)
  return {
    type: 'inbound',
    chatId: ctx.turn.chat_id,
    ...(threadId != null ? { threadId } : {}),
    messageId: ts,
    user: 'switchroom',
    userId: 0,
    ts,
    text:
      `You just restarted. Your previous turn was interrupted ${elapsed} ago, ` +
      `before it finished — it was cut off by a restart, not completed.` +
      promptClause(ctx.turn) +
      ` Pick that work back up now and continue it through to completion. ` +
      `In your first message, briefly let the user know you're resuming what ` +
      `was interrupted (mention roughly how long ago in plain language) so ` +
      `they're not left wondering — then carry on with the actual task. Do ` +
      `not ask whether to resume; just resume. If you genuinely can't tell ` +
      `what the work was, say so and ask.`,
    meta,
  }
}

/**
 * Build the `resume_watchdog_timeout` inbound — a stalled turn the agent
 * must report (not silently resume).
 *
 * `idleMs` is the no-progress duration the boot classifier measured (the
 * marker age). It is passed explicitly rather than read off the turn so
 * the caller can recover it from the persisted `interrupt_reason` on a
 * later boot when the live marker is gone.
 */
export function buildResumeWatchdogReportInbound(
  ctx: ResumeInboundContext & { idleMs: number },
): InboundMessage {
  const ts = ctx.nowMs ?? Date.now()
  const idle = humanizeElapsed(ctx.idleMs)
  const since = humanizeElapsed(ts - ctx.turn.started_at)
  const toolClause =
    ctx.turn.tool_call_count != null && ctx.turn.tool_call_count > 0
      ? ` You'd run ${ctx.turn.tool_call_count} tool call${ctx.turn.tool_call_count === 1 ? '' : 's'} before it stalled.`
      : ''
  const meta: Record<string, string> = {
    source: 'resume_watchdog_timeout',
    resume_turn_key: ctx.turn.turn_key,
    interrupted_via: 'timeout',
    idle_ms: String(ctx.idleMs),
    started_at: String(ctx.turn.started_at),
  }
  if (ctx.turn.tool_call_count != null) meta.tool_call_count = String(ctx.turn.tool_call_count)
  if (ctx.turn.user_prompt_preview) meta.original_prompt = ctx.turn.user_prompt_preview
  const threadId = threadIdNum(ctx.turn)
  return {
    type: 'inbound',
    chatId: ctx.turn.chat_id,
    ...(threadId != null ? { threadId } : {}),
    messageId: ts,
    user: 'switchroom',
    userId: 0,
    ts,
    text:
      `You just restarted. Your previous turn (started ${since} ago) was ` +
      `killed by the hang-watchdog: it made no observable progress for ${idle} ` +
      `and the watchdog restarts a turn that goes that long without activity.` +
      toolClause +
      promptClause(ctx.turn) +
      ` Do NOT silently resume it — it may hang again the same way. Instead, ` +
      `tell the user plainly what happened: that your last turn was killed ` +
      `after ${idle} of no progress, and roughly what it was doing. Then ask ` +
      `whether they want you to retry it or take a different angle. Report ` +
      `only the honest cause — no observable progress for that long — don't ` +
      `speculate about a deeper root cause you can't see.`,
    meta,
  }
}

/**
 * Decide which resume inbound (if any) a given interrupt warrants. Pure —
 * the gateway calls this with the classified `ended_via` so the
 * report-vs-resume policy lives in one testable place.
 *
 *   - 'timeout'                         → 'report'  (watchdog kill)
 *   - 'restart' | 'sigterm' | 'unknown' → 'resume'  (clean interrupt)
 *   - 'stop'                            → null      (finished; nothing to do)
 */
export function selectResumeBuilder(
  endedVia: TurnEndedVia | null,
): 'resume' | 'report' | null {
  if (endedVia === 'timeout') return 'report'
  if (endedVia === 'restart' || endedVia === 'sigterm' || endedVia === 'unknown') return 'resume'
  if (endedVia == null) return 'resume' // still-open at boot = killed mid-flight
  return null
}
