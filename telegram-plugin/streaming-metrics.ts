/**
 * Streaming observability — pure, dependency-free event emitter.
 *
 * Emits one JSON line per event to stderr, prefixed `[streaming-metrics]`.
 * Gated by `CLERK_STREAMING_METRICS=1` so production stays quiet.
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
 * True iff the env gate is on. Re-read on every call so tests can toggle
 * process.env without needing to reload the module.
 */
function enabled(): boolean {
  return process.env.CLERK_STREAMING_METRICS === '1'
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
