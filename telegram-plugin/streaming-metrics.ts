/**
 * Streaming observability — pure, dependency-free event emitter.
 *
 * Emits one JSON line per event to stderr, prefixed `[streaming-metrics]`.
 * Gated by `SWITCHROOM_STREAMING_METRICS=1` so production stays quiet.
 *
 * Event wiring lives in server.ts at well-known locations (PTY partial,
 * reply/stream_reply tool handlers, draft-stream send/edit callbacks,
 * turn_end). Keep this module dependency-free — the companion analyzer
 * streaming-report.ts ingests the JSONL and computes H1-H5 evidence.
 */

export type StreamingEvent =
  | {
      kind: 'pty_partial_received'
      chatId: string | null
      suppressed: boolean
      hasStream: boolean
      charCount: number
      bufferedWithoutChatId: boolean
    }
  | {
      kind: 'stream_reply_called'
      chatId: string
      charCount: number
      done: boolean
      streamExisted: boolean
    }
  | {
      kind: 'reply_called'
      chatId: string
      charCount: number
      replacedPreview: boolean
      previewMessageId: number | null
    }
  | {
      kind: 'draft_send'
      chatId: string
      messageId: number
      charCount: number
    }
  | {
      kind: 'draft_edit'
      chatId: string
      messageId: number
      charCount: number
      sameAsLast: boolean
    }
  | {
      kind: 'turn_end'
      chatId: string | null
      durationMs: number
      suppressClearedCount: number
    }
  /**
   * Emitted when the gateway receives an inbound message (from Telegram)
   * and immediately sets the 👀 ack reaction. Delta = gateway-receive → ack.
   * Acceptance item 7: time-to-ack instrumentation.
   */
  | {
      kind: 'inbound_ack'
      chatId: string
      messageId: number
      ackDelayMs: number
    }
  /**
   * Emitted at turn_end. Records the longest contiguous interval during
   * the turn where no signal (progress-card edit, text event, status
   * reaction update, or answer-lane update) was sent to the user.
   * Acceptance item 7: longest-silent-gap-during-turn instrumentation.
   */
  | {
      kind: 'turn_signal_gap'
      chatId: string
      longestGapMs: number
      turnDurationMs: number
    }
  /**
   * Emitted when the answer-lane sends or edits a message.
   */
  | {
      kind: 'answer_lane_update'
      chatId: string
      messageId: number | undefined
      charCount: number
      transport: 'draft' | 'message' | 'edit'
    }
  /**
   * Emitted when the answer-lane is materialized at turn-end.
   */
  | {
      kind: 'answer_lane_materialized'
      chatId: string
      messageId: number | undefined
    }
  /**
   * Emitted when maybeEarlyAckReaction fires the 👀 pre-coalesce reaction
   * for a private-chat inbound. Lets operators see how often the fast-ack
   * path triggers vs. the regular StatusReactionController path (#553 F2).
   */
  | {
      kind: 'early_ack_reaction'
      chatId: string
      messageId: number
      emoji: string
    }
  /**
   * Emitted when a fresh StatusReactionController is installed for a new turn
   * (group / non-DM path where the controller manages the whole reaction lifecycle).
   */
  | {
      kind: 'status_reaction_install'
      chatId: string
      turnId: string
      messageId: number
    }
  /**
   * Emitted on every emoji transition inside a StatusReactionController.
   * Lets operators trace the full queued→thinking→tool→done lifecycle and
   * see how many state changes occur in a silent turn.
   */
  | {
      kind: 'status_reaction_transition'
      chatId: string
      turnId: string
      emoji: string
    }
  /**
   * Emitted when StatusReactionController.finalize() / setDone() runs
   * (controller disposed at turn_end or disconnect-flush). Terminal event.
   */
  | {
      kind: 'status_reaction_dispose'
      chatId: string
      turnId: string
      reason: 'done' | 'error' | 'disconnect'
    }
  /**
   * Emitted when the FIRST text reply (reply or stream_reply) of a turn is
   * sent to the user. `timeToFirstTextReplyMs` is the wall-clock delta from
   * the inbound-received timestamp to the moment this reply tool fires.
   * Issue #2527 instrumentation: reveals when a turn is reaction-only.
   */
  | {
      kind: 'turn_reply_timing'
      chatId: string
      threadId: number | undefined
      turnId: string
      timeToFirstTextReplyMs: number
    }
  /**
   * Emitted at turn_end when the turn produced ZERO text replies (only
   * reaction-emoji transitions). This is the primary observable for the
   * #2527 failure mode — the user sees only an emoji and the turn is done.
   */
  | {
      kind: 'turn_no_reply_warn'
      chatId: string
      threadId: number | undefined
      turnId: string
      turnDurationMs: number
      reactionCount: number
    }
  /**
   * Emitted when the silence-poke framework-fallback fires and sends its
   * "still working…" ping. Records the silence duration so operators can
   * correlate with reaction-only turns.
   */
  | {
      kind: 'silence_poke_fire'
      chatId: string
      threadId: number | undefined
      silenceMs: number
      fallbackKind: string
    }
  /**
   * Emitted when the silence-poke handler short-circuits because the turn
   * already ended cleanly during the silence window (the late-fire race).
   */
  | {
      kind: 'silence_poke_skip'
      chatId: string
      threadId: number | undefined
      silenceMs: number
      skipReason: string
    }

/**
 * True iff the env gate is on. Re-read on every call so tests can toggle
 * process.env without needing to reload the module.
 */
function enabled(): boolean {
  return process.env.SWITCHROOM_STREAMING_METRICS === '1'
}

/**
 * Write one JSON line per event to stderr. No-op when the env gate is off.
 *
 * Format: `[streaming-metrics] {"ts":123.456,"kind":"...",...}\n`
 *
 * The `ts` field is a monotonic performance.now() reading in ms. Absolute
 * wall-clock time is irrelevant for inter-event analysis — we only care
 * about deltas within a single session.
 */
export function logStreamingEvent(ev: StreamingEvent): void {
  if (!enabled()) return
  const line = JSON.stringify({ ts: monotonicNowMs(), ...ev })
  try {
    process.stderr.write(`[streaming-metrics] ${line}\n`)
  } catch {
    // stderr write must never break the host. Swallow.
  }
}

/**
 * Monotonic clock in milliseconds. Uses performance.now() when available
 * (Node >=8.5 has it on globalThis; Bun exposes it too), falls back to a
 * hrtime-derived counter otherwise.
 */
function monotonicNowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance
  if (perf && typeof perf.now === 'function') return perf.now()
  const hr = process.hrtime()
  return hr[0] * 1000 + hr[1] / 1e6
}
