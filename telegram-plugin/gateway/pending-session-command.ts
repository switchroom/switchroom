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
 * This is a PER-KIND slot store (one slot for `model`, one for `effort`):
 * same-kind last-write-wins — a rapid `/model fable` then `/model opus`
 * queues only the latest (the earlier ack card is edited to "superseded") —
 * while cross-kind requests coexist (a queued `/effort` never displaces a
 * queued `/model`; both apply at idle). It reuses the same idle-gate
 * discipline as `pendingRestarts` / proactive `/compact` — drained at the
 * model-idle gate (`activeTurnStartedAt.size === 0`) with a bounded reaper
 * fallback so a session that never cleanly idles still applies-or-reports.
 * The reaper cap DEFERS while a turn is genuinely in flight (see
 * `drainCapDecision`): forcing mid-turn would hit the typed handler's busy
 * refusal (dropping the choice) or type into the live claude input.
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

export interface PendingSessionCommandSlots {
  /** The queued command of that kind, or null when its slot is empty. */
  get(kind: PendingCommandKind): PendingSessionCommand | null
  /**
   * Enqueue. SAME-KIND last-write-wins: returns the same-kind command it
   * DISPLACED (if any) so the caller can edit that stale ack card into a
   * "superseded" note. CROSS-KIND commands coexist — a `/effort` never
   * displaces a queued `/model` and vice versa.
   */
  set(cmd: PendingSessionCommand): PendingSessionCommand | null
  /** Atomically remove and return the queued command of that kind. */
  take(kind: PendingCommandKind): PendingSessionCommand | null
  /**
   * Atomically remove and return ALL queued commands in enqueue order (a
   * same-kind re-enqueue moves to the back). The drain's and shutdown's read.
   */
  takeAll(): PendingSessionCommand[]
  /** Snapshot of every queued command WITHOUT removing (the reaper's overdue check). */
  list(): PendingSessionCommand[]
  /** Drop every queued command without applying it. */
  clear(): void
  /** 0..2 — mirrors the `pendingRestarts.size` gate shape. */
  readonly size: number
}

/** Create an empty per-kind slot store. */
export function createPendingSessionCommandSlots(): PendingSessionCommandSlots {
  const slots = new Map<PendingCommandKind, PendingSessionCommand>()
  return {
    get: (kind: PendingCommandKind) => slots.get(kind) ?? null,
    set(cmd: PendingSessionCommand): PendingSessionCommand | null {
      const displaced = slots.get(cmd.kind) ?? null
      // Delete-then-set so a same-kind re-enqueue moves to the BACK of the
      // enqueue order — takeAll applies in latest-request order.
      slots.delete(cmd.kind)
      slots.set(cmd.kind, cmd)
      return displaced
    },
    take(kind: PendingCommandKind): PendingSessionCommand | null {
      const cur = slots.get(kind) ?? null
      slots.delete(kind)
      return cur
    },
    takeAll(): PendingSessionCommand[] {
      const all = [...slots.values()]
      slots.clear()
      return all
    },
    list: () => [...slots.values()],
    clear(): void {
      slots.clear()
    },
    get size(): number {
      return slots.size
    },
  }
}

/**
 * IO seams the drain iteration needs from the gateway. Extracted so the
 * iteration ORDER + loss-safety invariants (#3042 blocker 1) are unit-testable
 * without booting the bot.
 */
export interface DrainIo {
  /** Is a session relaunch pending (the live session is going away)? */
  restartPending: () => boolean
  /** Is a turn in flight right now (re-checked per command)? */
  turnInFlight: () => boolean
  /** Apply the command via the real handler; returns the reply body. */
  apply: (cmd: PendingSessionCommand) => Promise<string>
  /** Does this reply body mean "refused because busy" (not applied)? */
  isBusyRefusal: (text: string) => boolean
  /** Resolve a command that must ride the restart carriers; returns card text. */
  resolveForRestartText: (cmd: PendingSessionCommand) => string
  /** Edit the command's ack card. Best-effort. */
  editCard: (cmd: PendingSessionCommand, text: string) => Promise<void>
  /** Re-enqueue a command the drain could not safely apply. */
  reEnqueue: (cmd: PendingSessionCommand) => void
  /** Render the apply-threw failure card text. */
  failureText: (cmd: PendingSessionCommand, err: unknown) => string
}

/**
 * Drain iteration over the commands takeAll() returned. The loss-safety
 * invariant (#3042 blocker 1): when the loop must stop early (turn raced in,
 * or the handler returned a busy refusal), EVERY not-yet-applied taken
 * command — including the current one — is re-enqueued. takeAll() can hold
 * both a model AND an effort command; breaking after re-enqueueing only the
 * current one would silently drop the other with its ack card stuck at
 * "queued" forever.
 */
export async function drainTakenCommands(
  taken: readonly PendingSessionCommand[],
  io: DrainIo,
): Promise<void> {
  for (let i = 0; i < taken.length; i++) {
    const cmd = taken[i]
    if (io.restartPending()) {
      // The live session is going away — carry the choice across the bounce
      // via the durable carriers (or the re-issue fallback).
      await io.editCard(cmd, io.resolveForRestartText(cmd))
      continue
    }
    // Race guard: a new turn may have started before the drain reached this
    // command. Applying now would hit the handlers' busy refusals and stamp
    // "not applied" onto the ack card as a false final state.
    if (io.turnInFlight()) {
      for (const rest of taken.slice(i)) io.reEnqueue(rest)
      return
    }
    let body: string
    try {
      body = await io.apply(cmd)
    } catch (err) {
      await io.editCard(cmd, io.failureText(cmd, err))
      continue
    }
    // The handler itself refused because a turn raced in — not applied.
    if (io.isBusyRefusal(body)) {
      for (const rest of taken.slice(i)) io.reEnqueue(rest)
      return
    }
    await io.editCard(cmd, body)
  }
}

/**
 * What the reaper's bounded drain-cap should do this tick.
 *
 *   - 'wait'                 — nothing queued long enough; keep waiting.
 *   - 'defer-turn-in-flight' — something IS overdue, but a turn is genuinely
 *     in flight. Forcing a drain now would destroy the queued command: the
 *     typed model path hits handleModelCommand's busy gate (the old "try
 *     again" refusal, choice dropped) and /effort would type into the live
 *     claude input. The cap only rescues the MISSED-IDLE-GATE case, so keep
 *     waiting — the idle gate drains at turn end.
 *   - 'force'                — overdue AND idle: the idle gate was missed;
 *     force the apply-or-report so the ack card never dangles unresolved.
 */
export type DrainCapDecision = 'wait' | 'defer-turn-in-flight' | 'force'

export function drainCapDecision(
  queued: readonly PendingSessionCommand[],
  now: number,
  capMs: number,
  turnInFlight: boolean,
): DrainCapDecision {
  const overdue = queued.some(c => now - c.requestedAt > capMs)
  if (!overdue) return 'wait'
  return turnInFlight ? 'defer-turn-in-flight' : 'force'
}

/** One best-effort ack-card edit the caller should perform. */
export interface PendingCommandCardEdit {
  chatId: string
  messageId: number
  text: string
}

/**
 * What the gateway should DURABLY record for a queued command that can't
 * apply live because the session is going away (gateway shutdown or a pending
 * session relaunch). #3039: instead of telling the operator to re-issue, the
 * choice is persisted to the durable carriers (`.session-model` /
 * `.session-effort`) that start.sh honors on every boot — so the queued
 * command still deterministically applies, just via the relaunch.
 *
 *   - 'model'        — persist `arg` as the `.session-model` override
 *   - 'effort'       — persist `arg` as the `.session-effort` override
 *   - 'clear-model'  — the queued command was `/model default`: clear the carrier
 *   - 'clear-effort' — the queued command was `/effort default`: clear the carrier
 *   - null           — not offline-resolvable (a `mdl:s:<tag>` menu selection
 *                      needs live picker discovery to become a token); the
 *                      operator is asked to re-issue after boot.
 */
export type ShutdownPersistKind = 'model' | 'effort' | 'clear-model' | 'clear-effort' | null

export interface ShutdownResolutionAction {
  cmd: PendingSessionCommand
  persist: ShutdownPersistKind
  /** The canonical token / allowlisted level to persist (when persist != null). */
  arg: string
  /** Ack-card edit when the durable write succeeds. */
  persistedText: string
  /** Ack-card edit when persist is null or the durable write failed. */
  reissueText: string
}

const EFFORT_MENU_SELECT_PREFIX = 'eff:s:'

function classifyShutdownPersist(cmd: PendingSessionCommand): { persist: ShutdownPersistKind; arg: string } {
  if (cmd.kind === 'effort') {
    const level = cmd.origin === 'menu' && cmd.arg.startsWith(EFFORT_MENU_SELECT_PREFIX)
      ? cmd.arg.slice(EFFORT_MENU_SELECT_PREFIX.length)
      : cmd.arg
    if (level === 'default') return { persist: 'clear-effort', arg: level }
    return { persist: 'effort', arg: level }
  }
  // model
  if (cmd.origin === 'menu') return { persist: null, arg: cmd.arg } // mdl:s:<tag> — needs live discovery
  if (cmd.arg === 'default') return { persist: 'clear-model', arg: cmd.arg }
  return { persist: 'model', arg: cmd.arg }
}

function persistedText(cmd: PendingSessionCommand, escapeHtml: (s: string) => string): string {
  const noun = KIND_NOUN[cmd.kind]
  const isClear = cmd.arg === 'default' || cmd.targetLabel === 'default'
  if (isClear) {
    return `💾 The session is restarting — your ${noun} override was cleared as requested; the agent boots on the configured default.`
  }
  return `💾 The session is restarting — your \`${escapeHtml(cmd.targetLabel)}\` ${noun} choice is saved and applies as the agent boots.`
}

/**
 * Empty the slots and return, per queued command, what to persist and which
 * ack-card edit to make. The gateway performs the durable writes (this module
 * stays fs-free and unit-testable) and edits with `persistedText` on success
 * or `reissueText` on a null/failed persist. Shared by the SIGTERM shutdown
 * handler AND the drain's pending-restart branch — a queued choice is never
 * dropped with a bare "re-issue" when it can be carried across the bounce.
 */
export function shutdownResolutionActions(
  slots: PendingSessionCommandSlots,
  escapeHtml: (s: string) => string,
): ShutdownResolutionAction[] {
  return slots.takeAll().map(cmd => resolveForRestart(cmd, escapeHtml))
}

/** Single-command form of shutdownResolutionActions (the drain's pending-restart branch). */
export function resolveForRestart(
  cmd: PendingSessionCommand,
  escapeHtml: (s: string) => string,
): ShutdownResolutionAction {
  const { persist, arg } = classifyShutdownPersist(cmd)
  return {
    cmd,
    persist,
    arg,
    persistedText: persistedText(cmd, escapeHtml),
    reissueText: restartSupersededText(cmd, escapeHtml),
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
