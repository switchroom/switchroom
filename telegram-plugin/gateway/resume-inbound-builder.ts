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

/**
 * A sub-agent that was still in flight when the turn was interrupted. The
 * gateway derives these from the registry (`listNonTerminalSubagentsForTurn`)
 * — every non-terminal (`running` / `stalled`) worker of the interrupted turn.
 * Kept to just the display fields so the builder stays pure (no SQLite import).
 */
export interface InterruptedSubagent {
  /** Agent type / label (e.g. 'worker', 'researcher'). */
  agentType?: string | null
  /** Human-readable dispatch prompt / task description. */
  description?: string | null
  /** Current registry status ('running' | 'stalled'). Informational only. */
  status?: string | null
}

/** Max chars of each sub-agent's dispatch prompt included in the inbound. */
const SUBAGENT_PROMPT_MAX = 200
/** Max number of sub-agents listed (the rest are summarised as a count). */
const SUBAGENT_LIST_CAP = 10

function truncatePrompt(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  // Codepoint-safe truncation: slice by code POINTS, not UTF-16 code units —
  // a naive `.slice()` can split a surrogate pair (emoji, astral-plane CJK)
  // and leave a lone surrogate that renders as U+FFFD in the inbound.
  const points = Array.from(t)
  if (points.length <= max) return t
  return points.slice(0, max - 1).join('').trimEnd() + '…'
}

/**
 * Render the compact "these workers died with the restart" block appended to
 * an interrupted-turn inbound. Empty string when there were no in-flight
 * sub-agents (so the inbound is unchanged in the common case). Bounded: at
 * most `SUBAGENT_LIST_CAP` entries, each prompt truncated to
 * `SUBAGENT_PROMPT_MAX` chars, with an overflow count for the remainder.
 *
 * The closing instruction is mode-aware, mirroring the two builders'
 * contracts:
 *   - `assertive: true` (the `resume_interrupted` path, whose inbound already
 *     says "just resume") → imperative: re-dispatch the ones still needed
 *     before declaring the task done.
 *   - `assertive: false` (the `resume_watchdog_timeout` path — an ask-first
 *     contract: "Do NOT silently resume … ask whether to retry") → deferred:
 *     IF the user asks to retry, the workers will need re-dispatching. An
 *     unconditional re-dispatch imperative here would contradict that
 *     hang-safety gate.
 */
export function renderInterruptedSubagentsBlock(
  subs: InterruptedSubagent[] | undefined,
  opts: { assertive: boolean } = { assertive: true },
): string {
  if (!subs || subs.length === 0) return ''
  const shown = subs.slice(0, SUBAGENT_LIST_CAP)
  const lines = shown.map((s, i) => {
    const type = s.agentType?.trim() ? s.agentType.trim() : 'sub-agent'
    const desc = s.description?.trim()
      ? truncatePrompt(s.description, SUBAGENT_PROMPT_MAX)
      : '(no task description recorded)'
    return `  ${i + 1}. [${type}] ${desc}`
  })
  const overflow =
    subs.length > SUBAGENT_LIST_CAP
      ? `\n  …and ${subs.length - SUBAGENT_LIST_CAP} more.`
      : ''
  const count = subs.length
  const closing = opts.assertive
    ? `\nRe-dispatch the ones still needed before declaring the task done — ` +
      `don't assume their work landed.`
    : `\nIf the user asks you to retry, they'll need re-dispatching — ` +
      `don't assume their work landed.`
  return (
    `\n\nWhen the restart hit, ${count} sub-agent${count === 1 ? ' was' : 's were'} still ` +
    `in flight. These sub-agents were killed by the restart and did NOT complete:\n` +
    lines.join('\n') +
    overflow +
    closing
  )
}

export interface ResumeInboundContext {
  /** The interrupted turn, straight from the registry. */
  turn: Turn
  /** Wall-clock ms. Drives `ts`, `messageId`, and the elapsed framing.
   *  Defaults to Date.now(). */
  nowMs?: number
  /** Sub-agents that were still non-terminal when the turn was interrupted.
   *  Rendered into the inbound so the resumed session knows what to
   *  re-dispatch. Omitted / empty → the inbound is unchanged. */
  subagents?: InterruptedSubagent[]
  /** Why the framework itself triggered the restart, when it did (e.g. the
   *  bridge-dead escalation, #3038). Surfaced verbatim in the inbound text
   *  (`note`) and as `meta.restart_cause` (`reason`) so the resume is
   *  HONEST about the cause — a bridge-dead bounce must not read as an
   *  operator restart or masquerade as a watchdog timeout. Omitted → the
   *  inbound is unchanged (the common human-restart/crash case). */
  restartCause?: { reason: string; note: string }
}

/** Render the optional framework-restart-cause block appended to a resume /
 *  report inbound. Empty string when no cause was recorded. */
function renderRestartCauseBlock(cause: { note: string } | undefined): string {
  if (!cause || cause.note.trim().length === 0) return ''
  return `\n\nWhy this restart happened: ${cause.note.trim()}`
}

/**
 * Machine-stable leading token shared by EVERY synthetic boot inbound this
 * module mints (resume, watchdog-report, deferred-report). It is the anchor
 * the loop-guard keys on: a turn whose `user_prompt_preview` starts with
 * this string was itself started by a synthetic boot inbound, so building
 * ANOTHER resume for it would replay already-resumed work and could chain
 * unboundedly across repeated restarts.
 *
 * `extractUserPromptPreview` strips the `<channel …>` wrapper before storing
 * the preview, so the stored text begins with this prose prefix (not the
 * `meta.source` attribute, which the preview drops). Every builder below
 * MUST keep this as the first characters of its `text`; `resume-inbound-
 * builder.test.ts` pins that contract so a prose edit can't silently break
 * the loop-guard.
 */
export const RESUME_SYNTHETIC_PROMPT_PREFIX = 'You just restarted.'

/**
 * Loop-guard predicate: was this interrupted turn ITSELF started by one of
 * this module's synthetic boot inbounds? Detected via the stored
 * `user_prompt_preview` prefix. Used at boot to cap the auto-resume chain at
 * depth 1 — a resume turn that is itself interrupted is NOT re-resumed
 * (which would double-execute the resumed side effects and could loop
 * forever); the caller downgrades to a passive deferred-report instead.
 */
export function isResumeSyntheticTurn(turn: Turn): boolean {
  const p = turn.user_prompt_preview
  return typeof p === 'string' && p.startsWith(RESUME_SYNTHETIC_PROMPT_PREFIX)
}

function threadIdNum(turn: Turn): number | undefined {
  if (turn.thread_id == null) return undefined
  const n = Number(turn.thread_id)
  return Number.isFinite(n) ? n : undefined
}

function promptClause(turn: Turn): string {
  const p = turn.user_prompt_preview?.trim()
  if (!p) return ''
  // The stored preview is already capped at the first ~200 chars of the user
  // message (TURN_PREVIEW_MAX). Include it verbatim as a hint — do NOT
  // re-truncate (the old 160-char slice dropped instructions that lived in the
  // tail of a longer request). The FULL original is recovered via
  // get_recent_messages; the resume body tells the model to do that.
  return ` The start of the request was: "${p}".`
}

/**
 * Build the `resume_interrupted` inbound — a clean mid-flight interrupt
 * the agent should pick back up.
 */
export function buildResumeInterruptedInbound(ctx: ResumeInboundContext): InboundMessage {
  const ts = ctx.nowMs ?? Date.now()
  const elapsed = humanizeElapsed(ts - ctx.turn.started_at)
  const threadId = threadIdNum(ctx.turn)
  const meta: Record<string, string> = {
    source: 'resume_interrupted',
    // Carry the originating chat/topic as model-visible channel attributes
    // (mirrors the real-inbound + subagent_handback shapes — see
    // gateway.ts:10753 and subagent-handback-inbound-builder.ts:115-121).
    // Without meta.chat_id the enqueue's channel XML has no chat_id, so the
    // gateway's enqueue handler (gateway.ts `if (ev.chatId)`) never builds a
    // currentTurn for the resume turn — meaning no progress card, no
    // silence-poke protection, and the reply falling back to the agent's
    // default chat instead of the topic the interrupted work lived in.
    chat_id: ctx.turn.chat_id,
    ...(threadId != null ? { message_thread_id: String(threadId) } : {}),
    // message_id rounds-trips the fabricated `ts` through the enqueue's
    // channel XML so the deliver-until-acked queue can ack THIS synthetic by
    // its own enqueue id (gateway trackRedeliveredInbound carve-in). It is
    // never used as a Telegram reply_to: the model's reply tool quotes the
    // real prior user message via getLatestInboundMessageId (role='user',
    // synthetics aren't in history), and the activity feed anchors with
    // allow_sending_without_reply. Required so tracking the resume can ack and
    // never re-delivers forever.
    message_id: String(ts),
    resume_turn_key: ctx.turn.turn_key,
    interrupted_via: ctx.turn.ended_via ?? 'restart',
    started_at: String(ctx.turn.started_at),
  }
  if (ctx.turn.user_prompt_preview) meta.original_prompt = ctx.turn.user_prompt_preview
  if (ctx.restartCause) meta.restart_cause = ctx.restartCause.reason
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
      ` That quoted text is only the first ~200 characters of the original ` +
      `request, and you've lost your in-memory context across the restart — so ` +
      `BEFORE you continue, call get_recent_messages for this chat to read your ` +
      `full original message and the surrounding conversation, so you resume the ` +
      `COMPLETE task (including any instructions in the tail of a long request), ` +
      `not just the truncated preview. Then pick that work back up and carry it ` +
      `through to completion. In your first message, briefly let the user know ` +
      `you're resuming what was interrupted (mention roughly how long ago in ` +
      `plain language) so they're not left wondering — then carry on with the ` +
      `actual task. Do not ask whether to resume; just resume. If even after ` +
      `reading the recent messages you genuinely can't tell what the work was, ` +
      `say so and ask.` +
      renderInterruptedSubagentsBlock(ctx.subagents) +
      renderRestartCauseBlock(ctx.restartCause),
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
  const threadId = threadIdNum(ctx.turn)
  const meta: Record<string, string> = {
    source: 'resume_watchdog_timeout',
    // Origin chat/topic as channel attributes so the report turn gets a
    // currentTurn (progress card + silence-poke) and the "your last turn was
    // interrupted" notice lands in the topic the work lived in, not the
    // agent's default chat. Same rationale as buildResumeInterruptedInbound.
    chat_id: ctx.turn.chat_id,
    ...(threadId != null ? { message_thread_id: String(threadId) } : {}),
    resume_turn_key: ctx.turn.turn_key,
    interrupted_via: 'timeout',
    idle_ms: String(ctx.idleMs),
    started_at: String(ctx.turn.started_at),
  }
  if (ctx.turn.tool_call_count != null) meta.tool_call_count = String(ctx.turn.tool_call_count)
  if (ctx.turn.user_prompt_preview) meta.original_prompt = ctx.turn.user_prompt_preview
  if (ctx.restartCause) meta.restart_cause = ctx.restartCause.reason
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
      `speculate about a deeper root cause you can't see.` +
      // Deferred (non-assertive) form: this is the ask-first path — the killed
      // workers are listed as facts, but re-dispatch waits on the user's call.
      renderInterruptedSubagentsBlock(ctx.subagents, { assertive: false }) +
      renderRestartCauseBlock(ctx.restartCause),
    meta,
  }
}

/** Why an auto-resume was declined in favour of a passive notice. */
export type ResumeDeferReason = 'clean-restart-suppressed' | 'loop-guard'

/**
 * The inbound the boot-resume block should mint for an interrupted turn:
 *   - 'resume'           → active resume (buildResumeInterruptedInbound)
 *   - 'report'           → watchdog report (buildResumeWatchdogReportInbound)
 *   - 'defer-loop'       → loop-guard passive notice (deferred-report)
 *   - 'defer-suppressed' → boot_resume:never passive notice (deferred-report)
 *   - null               → nothing (turn finished cleanly)
 */
export type BootResumeKind = 'resume' | 'report' | 'defer-loop' | 'defer-suppressed' | null

/**
 * Pure boot-resume decision, extracted from the gateway so the precedence
 * (esp. the bounded resume-chain loop-guard) is unit-testable without
 * booting a gateway. Precedence, highest first:
 *
 *   1. loop-guard — the interrupted turn was ITSELF a synthetic resume/report
 *      turn (`isResumeSyntheticTurn`). NEVER mint another resume for it: that
 *      would replay already-partly-executed work and could chain
 *      restart→resume→restart forever. The at-most-once `resumed_at` ledger
 *      bounds each individual turn, but each resume spawns a NEW turn, so
 *      without this the CHAIN is unbounded. Cap it at one auto-resume by
 *      downgrading to a passive deferred-report ('defer-loop').
 *   2. suppressed — `boot_resume: never` on a fresh clean restart. Downgrade
 *      to a passive deferred-report ('defer-suppressed') — a notice, never
 *      silence.
 *   3. otherwise — the normal age/ended_via policy (`selectResumeBuilder`).
 */
export function decideBootResumeKind(args: {
  pending: Turn
  suppressed: boolean
  ageMs: number
  maxAgeMs: number
}): BootResumeKind {
  if (isResumeSyntheticTurn(args.pending)) return 'defer-loop'
  if (args.suppressed) return 'defer-suppressed'
  return selectResumeBuilder(args.pending.ended_via, {
    ageMs: args.ageMs,
    maxAgeMs: args.maxAgeMs,
  })
}

/**
 * Build the `resume_deferred` inbound — a passive notice delivered when the
 * framework declines to AUTO-resume interrupted work but must NOT stay
 * silent (silence when work was in flight is never acceptable). Two reasons:
 *
 *   - 'clean-restart-suppressed' — `session_continuity.boot_resume: never`
 *     is set and the prior shutdown was a fresh, deliberate restart. Per
 *     that opt-in posture we don't replay the work unprompted, but we still
 *     tell the user what was in flight so they can ask us to continue.
 *
 *   - 'loop-guard' — the interrupted turn was ITSELF a synthetic resume/
 *     report turn (see `isResumeSyntheticTurn`). Auto-resuming a resume that
 *     was interrupted again risks an unbounded restart→resume→restart chain
 *     and double-executed side effects, so we cap the chain: report instead
 *     of resuming, and let the user decide whether to keep going.
 *
 * Like the watchdog report, this is a REPORT (source `resume_deferred`), not
 * a resume: the agent must not silently pick the work back up. The text
 * starts with RESUME_SYNTHETIC_PROMPT_PREFIX so a further restart during
 * THIS turn is itself detected as a synthetic turn and stays capped.
 */
export function buildResumeDeferredReportInbound(
  ctx: ResumeInboundContext & { reason: ResumeDeferReason },
): InboundMessage {
  const ts = ctx.nowMs ?? Date.now()
  const elapsed = humanizeElapsed(ts - ctx.turn.started_at)
  const threadId = threadIdNum(ctx.turn)
  const meta: Record<string, string> = {
    source: 'resume_deferred',
    // Origin chat/topic as channel attributes so the report turn gets a
    // currentTurn (progress card + silence-poke) and the notice lands in the
    // topic the work lived in. Same rationale as the other builders.
    chat_id: ctx.turn.chat_id,
    ...(threadId != null ? { message_thread_id: String(threadId) } : {}),
    resume_turn_key: ctx.turn.turn_key,
    interrupted_via: ctx.turn.ended_via ?? 'restart',
    defer_reason: ctx.reason,
    started_at: String(ctx.turn.started_at),
  }
  if (ctx.turn.user_prompt_preview) meta.original_prompt = ctx.turn.user_prompt_preview
  if (ctx.restartCause) meta.restart_cause = ctx.restartCause.reason
  const cause =
    ctx.reason === 'loop-guard'
      ? `Your previous turn was ALREADY a resume of earlier interrupted work, ` +
        `and it was interrupted again by another restart ${elapsed} ago. To ` +
        `avoid an endless restart→resume loop (and re-running work that may ` +
        `have already partly executed), the framework has stopped ` +
        `auto-resuming this chain.`
      : `Your previous turn was interrupted ${elapsed} ago by a deliberate ` +
        `restart, before it finished. This agent is configured NOT to ` +
        `auto-resume work across deliberate restarts (boot_resume: never), so ` +
        `it was not replayed automatically.`
  return {
    type: 'inbound',
    chatId: ctx.turn.chat_id,
    ...(threadId != null ? { threadId } : {}),
    messageId: ts,
    user: 'switchroom',
    userId: 0,
    ts,
    text:
      `${RESUME_SYNTHETIC_PROMPT_PREFIX} ${cause}` +
      promptClause(ctx.turn) +
      ` Do NOT silently resume it. Instead, briefly tell the user what was in ` +
      `flight (call get_recent_messages for this chat if you need the full ` +
      `original request — the quoted preview is only the first ~200 ` +
      `characters), then ask whether they want you to pick it back up or drop ` +
      `it. If you genuinely can't tell what the work was, say so and ask.` +
      // Deferred (non-assertive) form, same as the watchdog path: this is an
      // ask-first inbound — killed workers are named as facts, but
      // re-dispatch waits on the user's call.
      renderInterruptedSubagentsBlock(ctx.subagents, { assertive: false }) +
      renderRestartCauseBlock(ctx.restartCause),
    meta,
  }
}

/**
 * Decide which resume inbound (if any) a given interrupt warrants. Pure —
 * the gateway calls this with the classified `ended_via` so the
 * report-vs-resume policy lives in one testable place.
 *
 *   - 'timeout'                                → 'report'  (watchdog kill)
 *   - 'restart'|'reaped_stale'|'sigterm'|'unknown' → 'resume' (clean interrupt)
 *   - 'stop'                                   → null      (finished; nothing to do)
 *
 * #3555: `'reaped_stale'` (mid-session stale-row sweep) is treated exactly
 * like `'restart'` here — it is the same clean interrupt, just no longer
 * mislabelled as a restart in the data.
 */
export function selectResumeBuilder(
  endedVia: TurnEndedVia | null,
  // 3h staleness failsafe (operator spec, 2026-06-03): when the interrupted
  // turn is older than `maxAgeMs`, an AUTO-resume is downgraded to the passive
  // `report` — silently re-injecting hours-old work could act on long-stale
  // context (a tax figure, a "send it" the user has moved on from). Pass both
  // to enable; omit (default) keeps the legacy blanket-resume behaviour.
  opts?: { ageMs?: number; maxAgeMs?: number },
): 'resume' | 'report' | null {
  let kind: 'resume' | 'report' | null
  if (endedVia === 'timeout') kind = 'report'
  else if (
    endedVia === 'restart' ||
    endedVia === 'reaped_stale' ||
    endedVia === 'sigterm' ||
    endedVia === 'unknown'
  ) kind = 'resume'
  else if (endedVia == null) kind = 'resume' // still-open at boot = killed mid-flight
  else kind = null
  if (
    kind === 'resume' &&
    opts?.ageMs != null &&
    opts?.maxAgeMs != null &&
    opts.ageMs > opts.maxAgeMs
  ) {
    return 'report' // too old to safely auto-resume — passive notice only
  }
  return kind
}
