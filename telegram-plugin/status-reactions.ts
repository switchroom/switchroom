/**
 * Status reaction state machine for Telegram bot messages.
 *
 * Reflective state machine — see issue #1713 for the canonical contract.
 *
 * The reaction on a user's inbound message represents CURRENT TURN
 * ACTIVITY, not delivery state. Working states (`thinking`, `tool`,
 * `coding`, `web`, `compacting`) cycle freely and bidirectionally —
 * the same state can re-enter multiple times within one turn. No state
 * is "higher" than another. Mid-turn replies (plain or streamed) are
 * non-events for the reaction.
 *
 * Only ONE method terminates the controller: `finalize(reason)`. The
 * Stop hook (delivered to the gateway as the `turn_end` IPC event) is
 * the single terminal trigger. `setError()` paints 😱 but is NON-
 * terminal — recovery to a working state is allowed.
 *
 * Three load-bearing properties (kept from the openclaw port):
 *
 *  1. Debounce intermediate transitions (3500ms by default — see #1713
 *     decision: 3-5s) so a model that flashes thinking → tool →
 *     thinking → tool doesn't burn the Telegram rate limit. Coalesce
 *     same-state-within-window into a single emit.
 *
 *  2. The terminal `finalize()` bypasses debounce.
 *
 *  3. Serialize all API calls through a single chain promise so two
 *     concurrent transitions never race the Telegram API. Telegram's
 *     setMessageReaction replaces atomically — no removeReaction needed.
 *
 * Stall watchdogs auto-promote to 🥱 / 😨 if no transition arrives within
 * 30s / 90s, so a stuck/dead inference loop is visually distinguishable
 * from a long but healthy one.
 */

/** Telegram allows only this fixed set of emoji as bot reactions. */
export const TELEGRAM_REACTION_WHITELIST = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨',
  '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
  '🤷‍♂', '🤷', '🤷‍♀', '😡',
])

/** Logical reaction states the controller tracks. */
export type ReactionState =
  | 'queued'
  | 'thinking'
  | 'coding'
  | 'web'
  | 'tool'
  | 'compacting'
  | 'awaiting'
  | 'done'
  | 'error'
  | 'stallSoft'
  | 'stallHard'

/**
 * Per-state emoji preference, with fallbacks if the first isn't allowed
 * in this particular chat. Modeled on openclaw's
 * TELEGRAM_STATUS_REACTION_VARIANTS.
 *
 * Semantic split — do not conflate these three tiers:
 *   READ     👀  = "I have seen your message" (acknowledgement only)
 *   WORKING  ✍   = actively doing something (tools, coding, compacting)
 *   FINISHED 👍/💯/🎉 = turn over (turn_end fired)
 *
 * 🔥 is reserved for genuine 5xx server errors (operator-events.ts).
 * It reads as "on fire / broken" — keep it out of normal active-work states.
 */
export const REACTION_VARIANTS: Record<ReactionState, string[]> = {
  queued:    ['👀', '🤔', '🤓'],     // READ: I see your message
  thinking:  ['🤔', '🤓', '👀'],
  tool:      ['✍', '⚡', '👌'],      // WORKING: actively using a tool
  coding:    ['👨‍💻', '✍', '⚡'],     // WORKING: writing / running code
  web:       ['⚡', '🤔', '👌'],      // WORKING: lookup in motion
  compacting:['✍', '🤔', '👀'],
  awaiting:  ['🙏', '🤔', '👀'],      // BLOCKED ON HUMAN: parked on a permission card
  done:      ['👍', '💯', '🎉'],      // FINISHED: turn_end fired
  error:     ['😱', '😨', '🤯'],      // NON-TERMINAL — recovery allowed
  stallSoft: ['🥱', '😴', '🤔'],
  stallHard: ['😨', '🤯', '😱'],
}

/**
 * Map a tool name string from a CallToolRequest into the appropriate
 * reaction state. Falls back to generic 'tool' for anything we don't
 * have a more specific bucket for.
 */
export function resolveToolReactionState(toolName: string): ReactionState {
  const n = toolName.toLowerCase()
  if (n.includes('bash') || n.includes('exec') || n.includes('shell')) return 'coding'
  if (n.includes('read') || n.includes('write') || n.includes('edit')
    || n.includes('multiedit') || n.includes('notebook') || n.includes('glob')
    || n.includes('grep')) return 'coding'
  if (n.includes('webfetch') || n.includes('websearch') || n.includes('browser')
    || n.includes('fetch') || n.includes('search')) return 'web'
  return 'tool'
}

/** Reason passed to `finalize()` — selects the terminal emoji.  */
export type FinalizeReason = 'done' | 'error'

/** Configuration knobs the controller respects. */
export interface StatusReactionConfig {
  /** Milliseconds to wait before applying a non-immediate transition. Default 3500 (#1713). */
  debounceMs?: number
  /** Milliseconds without progress before promoting to stallSoft. Default 30000. */
  stallSoftMs?: number
  /** Milliseconds without progress before promoting to stallHard. Default 90000. */
  stallHardMs?: number
  /** Optional logger for debugging — receives a single string per event. */
  log?: (msg: string) => void
}

/**
 * Function the controller calls to actually emit a reaction. Receives the
 * resolved emoji (already filtered through the chat's allowed set) and
 * should return a promise that resolves once the API call completes.
 *
 * The function should NOT throw on Telegram errors — silently swallow
 * unsupported-reaction failures so the controller can move on.
 */
export type ReactionEmitter = (emoji: string) => Promise<void>

/**
 * Controller managing the reaction lifecycle for a single inbound message.
 *
 * Lifecycle: construct → setQueued() → arbitrary intermediate transitions
 * (setThinking / setTool / setCompacting / setError — all bidirectional
 * and non-terminal) → finalize() to terminate. Only `finalize()` ends
 * the controller; after termination, all further calls are no-ops.
 */
export class StatusReactionController {
  private currentEmoji: string | null = null
  private pendingEmoji: string | null = null
  private chainPromise: Promise<unknown> = Promise.resolve()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private stallSoftTimer: ReturnType<typeof setTimeout> | null = null
  private stallHardTimer: ReturnType<typeof setTimeout> | null = null
  private finished = false
  private held = false
  private readonly debounceMs: number
  private readonly stallSoftMs: number
  private readonly stallHardMs: number
  private readonly log?: (msg: string) => void

  constructor(
    private readonly emit: ReactionEmitter,
    /** Chat reactions allowed in this specific chat (null = all whitelisted). */
    private readonly allowedReactions: Set<string> | null = null,
    config: StatusReactionConfig = {},
  ) {
    this.debounceMs = config.debounceMs ?? 3500
    this.stallSoftMs = config.stallSoftMs ?? 30000
    this.stallHardMs = config.stallHardMs ?? 90000
    this.log = config.log
  }

  /** 👀 — message received and queued for processing. Bypasses debounce. */
  setQueued(): void {
    this.scheduleState('queued', { immediate: true })
  }

  /** 🤔 — model is generating. Debounced, non-terminal, bidirectional. */
  setThinking(): void {
    this.scheduleState('thinking')
  }

  /** Tool-specific reaction. Debounced, non-terminal, bidirectional. */
  setTool(toolName?: string): void {
    const state = toolName ? resolveToolReactionState(toolName) : 'tool'
    this.scheduleState(state)
  }

  /** ✍ — context compaction in progress. Debounced, non-terminal, bidirectional. */
  setCompacting(): void {
    this.scheduleState('compacting')
  }

  /**
   * 🙏 — the turn is parked on a human decision (a permission card is
   * waiting for the operator to tap Allow/Deny). Immediate, non-terminal,
   * and crucially SUSPENDS the stall watchdog: a turn blocked on the
   * operator is not stalled, so it must NOT promote to 🥱/😨 while the
   * card sits unanswered. The next working transition (setTool /
   * setThinking, fired when the verdict resumes the turn) re-arms the
   * watchdog normally. Bypasses debounce so 🙏 lands as soon as the card
   * is posted.
   */
  setAwaiting(): void {
    if (this.finished) return
    this.scheduleState('awaiting', { immediate: true, skipStallReset: true })
    this.clearStallTimers()
  }

  /**
   * 😱 — non-terminal error indicator. Paints the error emoji but does
   * NOT end the controller — recovery to a working state is permitted
   * (see #1713). Use `finalize('error')` to actually terminate with
   * the error emoji as the final state.
   */
  setError(): void {
    this.scheduleState('error')
  }

  /**
   * Terminal — sets the controller to `finished` and emits the final
   * emoji (👍 for 'done', 😱 for 'error'). This is the ONLY method
   * that ends the controller; all other setX calls are non-terminal.
   *
   * Driven by the `turn_end` IPC event (Stop hook) and the disconnect
   * / boot-sweep backstops. Bypasses debounce so the terminal emoji
   * lands promptly. Subsequent calls are no-ops.
   */
  finalize(reason: FinalizeReason = 'done'): void {
    const state: ReactionState = reason === 'error' ? 'error' : 'done'
    this.finishWithState(state)
  }

  /**
   * Back-compat shim — equivalent to `finalize('done')`. Prefer
   * `finalize()` in new call sites so the terminal contract is
   * explicit at the call site.
   *
   * @deprecated Use `finalize('done')` — kept so external callers don't
   * break mid-rollout. Will be removed once all callers migrate.
   */
  setDone(): void {
    this.finalize('done')
  }

  /** Stop the controller without applying any new reaction. Terminal. */
  cancel(): void {
    if (this.finished) return
    this.finished = true
    this.held = false
    this.clearDebounceTimer()
    this.clearStallTimers()
  }

  /**
   * Freeze the controller in a WORKING state pending out-of-turn
   * background work — sub-agent workers that are still running after the
   * parent's `turn_end` fired. Painting the terminal 👍 here would read
   * as "done / nothing happening" while the worker keeps going; instead
   * we hold a working glyph (✍️/⚡) and let the gateway call `finalize()`
   * once the last worker completes.
   *
   * Non-terminal: the controller stays live, so `finalize()` still works
   * afterward. Suppresses stall promotion (🥱/😨) for the held window —
   * the parent turn isn't stalled, a worker is legitimately busy, and the
   * sub-agent watcher owns its own stall detection. Promotes a non-working
   * current state (👀 read-receipt / 🤔 thinking) to an explicit working
   * glyph so the user can tell work is ongoing.
   */
  hold(): void {
    if (this.finished) return
    this.held = true
    this.clearStallTimers()
    const working = this.resolveEmoji('tool')
    if (working != null && working !== this.currentEmoji && working !== this.pendingEmoji) {
      this.clearDebounceTimer()
      this.pendingEmoji = working
      this.enqueue(working)
    }
  }

  // ──────────────────────────────────────────────────────────────────────

  private scheduleState(
    state: ReactionState,
    opts: { immediate?: boolean; skipStallReset?: boolean } = {},
  ): void {
    if (this.finished) return
    const emoji = this.resolveEmoji(state)
    if (emoji == null) {
      if (!opts.skipStallReset) this.resetStallTimers()
      return
    }
    if (emoji === this.currentEmoji || emoji === this.pendingEmoji) {
      // Coalesce same-state-within-window into a single emit.
      if (!opts.skipStallReset) this.resetStallTimers()
      return
    }
    this.pendingEmoji = emoji
    this.clearDebounceTimer()
    if (opts.immediate) {
      this.enqueue(emoji)
    } else {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        this.enqueue(emoji)
      }, this.debounceMs)
    }
    if (!opts.skipStallReset) this.resetStallTimers()
  }

  private finishWithState(state: ReactionState): void {
    if (this.finished) return
    this.finished = true
    this.held = false
    this.clearStallTimers()
    // F1 fix (#553): if a non-terminal reaction is sitting in the
    // debounce window when the turn ends, flush it BEFORE the terminal
    // emoji emits. Without this, every Class B turn that completed in
    // under `debounceMs` would collapse straight to 👀 → terminal with
    // no intermediate working-state signal.
    //
    // Gate on `debounceTimer != null`: a `pendingEmoji` with no timer
    // is already enqueued (immediate emit waiting on chainPromise) and
    // re-enqueuing would produce a duplicate.
    const flushPending = this.debounceTimer != null && this.pendingEmoji != null
      ? this.pendingEmoji
      : null
    this.clearDebounceTimer()
    if (flushPending != null && flushPending !== this.currentEmoji) {
      this.enqueue(flushPending)
    }
    const emoji = this.resolveEmoji(state)
    if (emoji != null && emoji !== this.currentEmoji && emoji !== flushPending) {
      this.enqueue(emoji)
    }
  }

  private enqueue(emoji: string): void {
    this.chainPromise = this.chainPromise.then(async () => {
      try {
        await this.emit(emoji)
        this.currentEmoji = emoji
        if (this.pendingEmoji === emoji) this.pendingEmoji = null
        this.log?.(`reaction → ${emoji}`)
      } catch (err) {
        this.log?.(`reaction emit failed (${emoji}): ${(err as Error).message}`)
      }
    })
  }

  private resolveEmoji(state: ReactionState): string | null {
    const variants = REACTION_VARIANTS[state]
    for (const v of variants) {
      if (!TELEGRAM_REACTION_WHITELIST.has(v)) continue
      if (this.allowedReactions == null || this.allowedReactions.has(v)) {
        return v
      }
    }
    // Last resort: any whitelisted-and-allowed emoji from the broad fallback set
    for (const v of ['👍', '👀', '✍']) {
      if (this.allowedReactions == null || this.allowedReactions.has(v)) {
        return v
      }
    }
    return null
  }

  private resetStallTimers(): void {
    this.clearStallTimers()
    if (this.finished || this.held) return
    this.stallSoftTimer = setTimeout(() => {
      this.stallSoftTimer = null
      // Don't reset the stall timers when the stall transition itself fires —
      // otherwise stallHard would never get a chance to run after stallSoft.
      this.scheduleState('stallSoft', { immediate: true, skipStallReset: true })
    }, this.stallSoftMs)
    this.stallHardTimer = setTimeout(() => {
      this.stallHardTimer = null
      this.scheduleState('stallHard', { immediate: true, skipStallReset: true })
    }, this.stallHardMs)
  }

  private clearStallTimers(): void {
    if (this.stallSoftTimer) {
      clearTimeout(this.stallSoftTimer)
      this.stallSoftTimer = null
    }
    if (this.stallHardTimer) {
      clearTimeout(this.stallHardTimer)
      this.stallHardTimer = null
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}
