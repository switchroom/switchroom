/**
 * Deterministic ack-queue-apply-confirm for the session-mutating Telegram
 * commands (`/model`, `/effort`).
 *
 * The bug this closes (#TODO): a `/model` or `/effort` command issued while
 * the agent is MID-TURN used to dead-end. The typed `/model <name>` path
 * refused with "⏳ … Try again in a moment." and dropped the request; the
 * menu taps toasted the same refusal; `/effort` had no busy gate at all and
 * silently maybe-failed ("sent, but couldn't confirm it applied"). In every
 * case the operator's choice was lost — they had to notice and re-issue it.
 *
 * The contract now, consistent across BOTH commands and BOTH their typed and
 * menu surfaces:
 *
 *   1. immediately APPLICABLE (session idle) → apply + confirm, unchanged.
 *   2. session MID-TURN → immediately ACK ("📥 … the moment this turn
 *      finishes"), deterministically QUEUE the request, then APPLY the moment
 *      the agent goes idle and EDIT the ack card into the confirmation.
 *
 * This is a SINGLE-VALUED per-agent slot, last-write-wins: a rapid `/model
 * fable` then `/model opus` queues only the latest (the earlier ack card is
 * edited to "superseded"). It reuses the same idle-gate discipline as
 * `pendingRestarts` / proactive `/compact` — drained at the model-idle gate
 * (`activeTurnStartedAt.size === 0`) with a bounded reaper fallback so a
 * session that never cleanly idles still applies-or-reports.
 *
 * The apply itself (running the real handler, recording the session-model
 * override, editing the ack card) lives in the gateway — this module is the
 * pure slot + the ack/confirm/superseded text so it is unit-testable without
 * booting the bot. Mirrors the split shape of model-command.ts /
 * effort-command.ts.
 */

export type PendingCommandKind = 'model' | 'effort'
export type PendingCommandOrigin = 'typed' | 'menu'

export interface PendingSessionCommand {
  kind: PendingCommandKind
  /**
   * How the request arrived — `typed` for `/model <name>` / `/effort <level>`,
   * `menu` for an inline-keyboard tap. Determines which handler the drain
   * replays (the typed handler vs the menu-callback handler).
   */
  origin: PendingCommandOrigin
  /**
   * The apply payload the drain replays verbatim:
   *   - typed model  → the (alias-expanded) model token, e.g. `fable`, `sr-glm-5`
   *   - typed effort → the effort level, e.g. `high`
   *   - menu         → the raw callback data (`mdl:s:<tag>` / `mdl:alias:<a>` /
   *                    `mdl:sr:<name>` / `eff:s:<level>`), replayed through the
   *                    menu-callback handler which re-discovers at idle.
   */
  arg: string
  /**
   * Human-facing label for the ack / superseded text (e.g. `fable`, `high`,
   * `Gemini 2.5 Pro`). Display-only — never fed to `claude --model`.
   */
  targetLabel: string
  /** The chat the command came from (for building model deps on the deferred apply). */
  chatId: string
  /** The forum topic, if any. */
  threadId?: number
  /** The chat the ack card was posted to (usually === chatId). */
  ackChatId: string
  /** The ack card's message id — the drain EDITS this into the confirmation. */
  ackMessageId: number
  requestedAt: number
}

export interface PendingSessionCommandSlot {
  /** The queued command, or null when the slot is empty. */
  get(): PendingSessionCommand | null
  /**
   * Enqueue last-write-wins. Returns the command it DISPLACED (if any) so the
   * caller can edit that stale ack card into a "superseded" note.
   */
  set(cmd: PendingSessionCommand): PendingSessionCommand | null
  /** Atomically remove and return the queued command (the drain's read). */
  take(): PendingSessionCommand | null
  /** Drop the queued command without applying it. */
  clear(): void
  /** 0 or 1 — mirrors the `pendingRestarts.size` gate shape. */
  readonly size: number
}

/** Create an empty single-valued slot. */
export function createPendingSessionCommandSlot(): PendingSessionCommandSlot {
  let slot: PendingSessionCommand | null = null
  return {
    get: () => slot,
    set(cmd: PendingSessionCommand): PendingSessionCommand | null {
      const displaced = slot
      slot = cmd
      return displaced
    },
    take(): PendingSessionCommand | null {
      const cur = slot
      slot = null
      return cur
    },
    clear(): void {
      slot = null
    },
    get size(): number {
      return slot == null ? 0 : 1
    },
  }
}

const KIND_NOUN: Record<PendingCommandKind, string> = {
  model: 'model',
  effort: 'effort',
}

const KIND_VERB: Record<PendingCommandKind, string> = {
  model: 'switch to',
  effort: 'set effort to',
}

/**
 * The immediate ACK shown when a command is queued behind a live turn. Names
 * the target so the operator sees their choice was captured, not dropped.
 * `escapeHtml` guards the (already shape-gated) label for the HTML send path.
 */
export function ackText(
  kind: PendingCommandKind,
  targetLabel: string,
  escapeHtml: (s: string) => string,
): string {
  return `📥 Agent is mid-turn — I'll ${KIND_VERB[kind]} \`${escapeHtml(targetLabel)}\` the moment this turn finishes.`
}

/**
 * Edited onto a stale ack card when a NEWER command of the same slot displaces
 * it (last-write-wins). Tells the operator their earlier choice was replaced,
 * not silently lost.
 */
export function supersededText(
  displaced: PendingSessionCommand,
  next: PendingSessionCommand,
  escapeHtml: (s: string) => string,
): string {
  return `↩️ Superseded — queued \`${escapeHtml(next.targetLabel)}\` instead (your earlier \`${escapeHtml(displaced.targetLabel)}\` ${KIND_NOUN[displaced.kind]} request was replaced before it applied).`
}

/**
 * Edited onto the ack card when the queued command could not apply because the
 * session is restarting (a Claude-model / effort session change does not
 * survive the bounce). The operator is told to re-issue after boot rather than
 * being left believing it landed.
 */
export function restartSupersededText(
  cmd: PendingSessionCommand,
  escapeHtml: (s: string) => string,
): string {
  return `↩️ The session is restarting before your \`${escapeHtml(cmd.targetLabel)}\` ${KIND_NOUN[cmd.kind]} change could apply — re-issue \`/${cmd.kind} ${escapeHtml(cmd.targetLabel)}\` once the agent is back.`
}
