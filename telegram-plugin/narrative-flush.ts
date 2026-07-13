/**
 * Time-boxed narrative early-paint — the TIMER half of the JSONL-text-narrative
 * primitive, and the pure, fully-unit-testable kernel of it (companion to
 * `narrative-dedup.ts`, which owns the SHOW-vs-SUPPRESS decision).
 *
 * ## Why this exists
 * A `text` / `sub_agent_text` block is parked for ONE lookahead step so the
 * reducer can tell DRAFT-THEN-SEND (suppress — it duplicates the reply) from
 * WORKING NARRATION (show). On a normal turn the lookahead is the FIRST real
 * `tool_use`, so the opening narration ("On it, pulling the logs…") only painted
 * when that tool landed — a visible gap while the agent thinks before its first
 * tool.
 *
 * This kernel adds a deterministic timer: when a block is parked, arm a short
 * timer. If a lookahead event (tool_use / next text / turn_end) arrives first,
 * the normal path resolves the block and the timer is CANCELLED. If the timer
 * fires first, the parked narration is painted EARLY — so it surfaces
 * ~`flushMs` into the turn instead of waiting for the first tool.
 *
 * ## Anti-double-print guarantee (the correctness core)
 * The whole reason the decision is deferred is that a parked block might turn out
 * to be the outgoing reply, which must NEVER surface as a card narration step AND
 * as the canonical reply. The timer introduces a window where a block is painted
 * BEFORE its lookahead reply arrives. This kernel keeps the guarantee
 * deterministically, NOT by hoping the window hides the race:
 *   - A block painted by the timer is remembered (`timerShown`).
 *   - When the reply/stream_reply lookahead finally arrives (on a tool or at
 *     turn_end), if it is a draft-then-send of the timer-painted block
 *     (`isDraftOfReply`), the kernel emits a RETRACT effect so the caller removes
 *     the prematurely-shown step. Correctness therefore does not depend on the
 *     250ms window winning the race — the retract is the guarantee; the timer is
 *     only the early-paint trigger.
 *
 * ## Purity
 * No I/O, no real timers, no state of its own beyond the two explicit slots. All
 * effects (paint a step, retract a step, arm/disarm a real timer) are injected,
 * so the kernel is driven deterministically in tests with fake timers. The caller
 * (gateway reducer for the main agent, subagent-watcher for sub/worker) owns the
 * effects and the per-turn lifetime.
 */

import { REPLY_TOOLS, isDraftOfReply } from './narrative-dedup.js'

/**
 * Time-box for the parked-narrative early-paint (the kernel's home for the
 * constant so BOTH callers share ONE source of truth):
 *   - the main-agent gateway path drives the kernel with a real `setTimeout`
 *     scheduler (`makeNarrativeGate`, gateway.ts);
 *   - the worker / sub-agent watcher drives the SAME kernel with a POLL-driven
 *     scheduler (stamp `deadline = nowFn()+flushMs`; flush on the next poll
 *     tick once `nowFn() >= deadline`) — see `subagent-watcher.ts`.
 * If a parked opening narration gets no lookahead event (tool_use / next text /
 * turn_end) within this window — the "narrate, then think before the first
 * tool" gap — it is painted EARLY instead of waiting for the first tool. Chosen
 * so a normal draft-then-send `reply` (emitted right after the text block)
 * resolves the block FIRST; correctness does NOT depend on that race — a
 * timer-painted block that later proves to be the reply is deterministically
 * retracted (main path) or is structurally harmless (worker path: the reply is
 * a Telegram-surface tool that never renders on the card). Named const so a
 * test can pin it.
 */
export const PENDING_NARRATIVE_FLUSH_MS = 250

/** Side effects the kernel drives. The caller owns rendering + retraction. */
export interface NarrativeFlushEffects {
  /** Paint a narrative block as a transient liveness step (SHOW). */
  show(text: string): void
  /**
   * Retract a previously-SHOWN narration step (it turned out to draft the reply).
   * Caller removes it from the feed. No-op-safe if already gone.
   */
  retractShown(text: string): void
}

/** Arms / disarms the real early-paint timer. Injected so tests can fake it. */
export interface NarrativeFlushScheduler {
  /** Arm the timer; MUST cancel any prior armed callback first (at-most-one). */
  arm(fn: () => void, ms: number): void
  /** Cancel the armed callback if any. Idempotent. */
  disarm(): void
}

/**
 * Pure park/timer/retract state machine for one turn (or one sub-agent entry).
 * Construct once per turn with the effect + scheduler wiring; discard at teardown.
 */
export class NarrativeFlushController {
  /** Block parked awaiting its lookahead event. Null when nothing pending. */
  private pending: string | null = null
  /** Block the timer painted EARLY, retained for possible retract. */
  private timerShown: string | null = null

  constructor(
    private readonly effects: NarrativeFlushEffects,
    private readonly scheduler: NarrativeFlushScheduler,
    private readonly flushMs: number,
  ) {}

  /** Test/inspection accessors (no behaviour). */
  get pendingText(): string | null {
    return this.pending
  }
  get timerShownText(): string | null {
    return this.timerShown
  }

  /**
   * Gate step 1: a new narrative block arrived. It is itself the lookahead for
   * the previously-parked block (pure narration — a draft is followed by a reply,
   * not more text) → SHOW the old one, then park the new one and arm the timer.
   */
  stage(text: string): void {
    this.scheduler.disarm()
    if (this.pending != null) {
      this.effects.show(this.pending)
    }
    this.pending = text
    this.scheduler.arm(() => this.onTimerFire(), this.flushMs)
  }

  /**
   * The early-paint timer fired: no lookahead arrived within the window. If the
   * block is still parked, SHOW it now and remember it so a later draft-then-send
   * reply can retract it.
   */
  private onTimerFire(): void {
    if (this.pending == null) return // a lookahead already consumed it
    const text = this.pending
    this.pending = null
    this.timerShown = text
    this.effects.show(text)
  }

  /**
   * Gate step 2: a tool_use lookahead arrived. Cancel the timer, retract a
   * timer-painted block if THIS reply drafts it, then resolve the parked block:
   * SUPPRESS a reply-draft, else SHOW.
   */
  resolveOnTool(toolName: string, input: Record<string, unknown> | undefined): void {
    this.scheduler.disarm()
    const replyText =
      REPLY_TOOLS.has(toolName) && typeof input?.text === 'string' ? (input.text as string) : null
    if (replyText != null) this.maybeRetract(replyText)
    const pending = this.pending
    if (pending == null) return
    this.pending = null
    if (replyText != null && isDraftOfReply(pending, replyText)) return // draft → SUPPRESS
    this.effects.show(pending)
  }

  /**
   * Gate step 3: turn_end — the terminal lookahead. Cancel the timer, retract a
   * timer-painted block if the delivered reply drafts it, then SHOW a genuine
   * trailing narration (or SUPPRESS a trailing draft of the answer).
   */
  flushAtTurnEnd(lastReplyText: string): void {
    this.scheduler.disarm()
    if (lastReplyText.length > 0) this.maybeRetract(lastReplyText)
    const pending = this.pending
    if (pending == null) return
    this.pending = null
    if (lastReplyText.length > 0 && isDraftOfReply(pending, lastReplyText)) return // trailing draft
    this.effects.show(pending)
  }

  /** Turn teardown: cancel the timer so it can neither leak nor fire late. */
  teardown(): void {
    this.scheduler.disarm()
    this.pending = null
    this.timerShown = null
  }

  /** Retract the timer-painted block iff this reply is its draft-then-send. */
  private maybeRetract(replyText: string): void {
    const shown = this.timerShown
    if (shown == null) return
    if (!isDraftOfReply(shown, replyText)) return
    this.timerShown = null
    this.effects.retractShown(shown)
  }
}
