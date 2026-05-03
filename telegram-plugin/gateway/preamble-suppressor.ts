/**
 * Preamble-text suppression for the answer-stream path (#549).
 *
 * When the agent emits assistant text BEFORE a tool call within the
 * same turn, that text is "preamble" — think-out-loud guidance about
 * what's about to happen. The progress-card driver consumes preamble
 * text as a narrative row for the upcoming tool. Independently, the
 * answer-stream path was also sending the same text to chat as a
 * standalone message — so the user saw the same line twice (#549).
 *
 * This module isolates the buffering policy:
 *
 *   - `onText(chunk)` — append to the pending buffer; (re)start the
 *     flush timer. If no `onTool` arrives within `bufferMs`, the timer
 *     fires and treats the buffered text as ANSWER text (the agent
 *     emitted it as the reply, not as preamble).
 *
 *   - `onTool({ isReplyTool })` — a non-reply tool consumes the
 *     pending buffer as preamble (drop). A reply/stream_reply tool is
 *     itself the answer surface; flush so its text isn't suppressed
 *     when delivered via separate paths.
 *
 *   - `flushNow()` — force-flush whatever's pending (used at turn_end
 *     when no preamble-claiming tool ever arrived).
 *
 *   - `dropNow()` — drop without flushing (used when the answer
 *     stream is being torn down for an unrelated reason).
 *
 *   - `reset()` — clear ALL state including `answerTextOnly` (called
 *     at fresh-turn enqueue).
 *
 * The class owns its own state so the gateway's module-level mutable
 * state stays bounded. Pure aside from the supplied `flushFn` and
 * `setTimer` / `clearTimer` (injected for tests so vi.useFakeTimers
 * can drive them).
 */

export interface PreambleSuppressorDeps {
  /**
   * Called when a chunk has been promoted from "pending" to "answer
   * text." Receives the cumulative answer text since the last reset()
   * — caller should treat it as the full answer-stream payload.
   */
  emitAnswer: (cumulativeAnswerText: string) => void

  /**
   * Buffer window in ms. Default 150ms — long enough that a
   * tool_use following a text emit comfortably arrives within the
   * window, short enough that a true answer-text reply still feels
   * snappy. Override in tests with `vi.useFakeTimers()`.
   */
  bufferMs?: number

  /**
   * Injected for testability. Defaults to global setTimeout/clearTimeout.
   */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const DEFAULT_BUFFER_MS = 150

export class PreambleSuppressor {
  private readonly emitAnswer: (text: string) => void
  private readonly bufferMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private answerTextOnly = ''
  private pendingBuffer = ''
  private pendingTimer: unknown = null

  constructor(deps: PreambleSuppressorDeps) {
    this.emitAnswer = deps.emitAnswer
    this.bufferMs = deps.bufferMs ?? DEFAULT_BUFFER_MS
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Append a text chunk and (re)arm the flush timer. */
  onText(chunk: string): void {
    if (chunk.length === 0) return
    this.pendingBuffer += chunk
    if (this.pendingTimer != null) this.clearTimer(this.pendingTimer)
    this.pendingTimer = this.setTimer(() => this.flushNow(), this.bufferMs)
  }

  /**
   * Tool-use signal. Non-reply tools consume the buffer as preamble
   * (drop). Reply/stream_reply tools flush the buffer as answer text
   * (their own payload IS the answer surface; flushing here keeps the
   * chat-side state consistent).
   */
  onTool(opts: { isReplyTool: boolean }): void {
    if (opts.isReplyTool) {
      this.flushNow()
    } else {
      this.dropNow()
    }
  }

  /** Force-flush any pending text as answer text. Idempotent. */
  flushNow(): void {
    if (this.pendingTimer != null) {
      this.clearTimer(this.pendingTimer)
      this.pendingTimer = null
    }
    if (this.pendingBuffer.length === 0) return
    this.answerTextOnly += this.pendingBuffer
    this.pendingBuffer = ''
    this.emitAnswer(this.answerTextOnly)
  }

  /** Drop pending text without flushing. Idempotent. */
  dropNow(): void {
    if (this.pendingTimer != null) {
      this.clearTimer(this.pendingTimer)
      this.pendingTimer = null
    }
    this.pendingBuffer = ''
  }

  /**
   * Full reset — clears the cumulative answer-text-only memory plus
   * the pending buffer. Call on fresh-turn enqueue.
   */
  reset(): void {
    if (this.pendingTimer != null) {
      this.clearTimer(this.pendingTimer)
      this.pendingTimer = null
    }
    this.pendingBuffer = ''
    this.answerTextOnly = ''
  }

  // ─── Test introspection ───────────────────────────────────────────────

  /** True if the buffer holds text waiting for a flush decision. */
  hasPending(): boolean {
    return this.pendingBuffer.length > 0
  }

  /** Current cumulative answer-text-only payload. */
  currentAnswerText(): string {
    return this.answerTextOnly
  }
}
