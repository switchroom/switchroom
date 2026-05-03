/**
 * Per-sub-agent pinned status card registry.
 *
 * Sits alongside the existing parent progress card in
 * `progress-card-driver.ts`. Where the driver tracks one
 * `PerChatState` per turn (and renders sub-agents as nested
 * `<blockquote expandable>` rows inside it), this registry tracks one
 * `SubAgentCardState` per running sub-agent and emits a separate pinned
 * Telegram message for each — driving the CLI-style status row +
 * TaskList block via the pure `renderAgentCard` / `projectAgentSlice`
 * helpers.
 *
 * Lifecycle:
 *   - Spawn lazily on the first *content* event for an agentId (the
 *     sub-agent has a `currentTool`, `currentNarrative`,
 *     `firstNarrativeText`, or has completed at least one tool). Avoids
 *     empty placeholder cards for orphan starts.
 *   - Each sync schedules a coalesced emit so bursts don't multiply
 *     edits; `lastEmittedAt` enforces the per-card hard floor.
 *   - On the sub-agent's terminal state (`done` / `failed`) the
 *     registry emits one final card with `done=true` and stops
 *     tracking. The gateway's existing `pinMgr.completeTurn` path
 *     unpins it.
 *
 * The registry uses a synthetic turnKey of the form
 * `${parentTurnKey}::${agentId}` for each sub-agent card. The
 * gateway's stream-reply infrastructure keys on turnKey for stream
 * identity so distinct turnKeys yield distinct messages — this keeps
 * sub-agent cards independent of the parent card without parallel
 * stream-reply plumbing.
 *
 * Gating:
 *   The registry only acts when `PROGRESS_CARD_PER_AGENT_PINS=1` is
 *   set (or the explicit `enabled` config flag passed by tests). Off
 *   by default for soft rollout — the legacy parent card with
 *   sub-agent expandables stays the default until per-agent pins are
 *   validated in production.
 */

import type {
  ProgressCardState,
  SubAgentState,
} from './progress-card.js'
import {
  projectAgentSlice,
  renderAgentCard,
} from './progress-card.js'

/**
 * Synthetic turnKey for a sub-agent card. Uses `::` as a separator —
 * not a legal character in real turnKeys (which are
 * `${chatId}:${threadId}:${seq}`) so collisions are impossible.
 */
export function subAgentTurnKey(parentTurnKey: string, agentId: string): string {
  return `${parentTurnKey}::${agentId}`
}

export interface SubAgentCardEmitArgs {
  chatId: string
  threadId?: string
  /** Synthetic turnKey unique to this sub-agent card. */
  turnKey: string
  /** Sub-agent identity for the pin manager. */
  agentId: string
  html: string
  done: boolean
  /** True only on the very first emit for this card. */
  isFirstEmit: boolean
}

export interface SubAgentCardRegistryDeps {
  emit: (args: SubAgentCardEmitArgs) => void
  /** Wall-clock ms. Defaults to `Date.now`. */
  now?: () => number
  /** Coalesce burst window. Defaults to 400ms. */
  coalesceMs?: number
  /** Per-card hard floor between edits. Defaults to 500ms. */
  minIntervalMs?: number
  /**
   * Multi-card coalesce window (raised when ≥ 2 cards active in the
   * same chat+thread). Defaults to 800ms — the existing per-chat
   * Telegram edit budget is shared across N cards so N-card bursts
   * benefit from a wider coalesce window.
   */
  multiCardCoalesceMs?: number
  /**
   * Heartbeat for the elapsed-counter tick when no events flow.
   * Defaults to 5000ms. Set 0 to disable.
   */
  heartbeatMs?: number
  /** Logger. Defaults to no-op. */
  log?: (line: string) => void
  /** Test injection. */
  setT?: (fn: () => void, ms: number) => { ref: unknown }
  clearT?: (handle: { ref: unknown }) => void
  setI?: (fn: () => void, ms: number) => { ref: unknown }
  clearI?: (handle: { ref: unknown }) => void
}

export interface SubAgentCardConfig {
  /**
   * Required opt-in. Off by default — parent-card-with-expandables
   * remains the default until per-agent pins are validated.
   * Tests pass `true`; production reads `PROGRESS_CARD_PER_AGENT_PINS=1`
   * via {@link isPerAgentPinsEnabled}.
   */
  enabled: boolean
}

export interface SubAgentCardRegistry {
  /**
   * Reconcile the registry against a ProgressCardState. Spawns cards
   * for newly-content-bearing sub-agents, schedules emits for ongoing
   * ones, finalizes terminals.
   */
  syncFromParent(args: {
    state: ProgressCardState
    chatId: string
    threadId?: string
    parentTurnKey: string
    now: number
  }): void
  /**
   * Force-finalize every card under a parentTurnKey. Used on parent
   * `turn_end` so any sub-agent whose `sub_agent_turn_end` was missed
   * still gets a final emit + unpin signal.
   */
  finalizeAll(parentTurnKey: string, now: number): void
  /**
   * Stop all timers, clear state. Idempotent.
   */
  dispose(): void
  /** Test-only: snapshot of currently-tracked agentIds for a parent turn. */
  trackedAgentIds(parentTurnKey: string): ReadonlyArray<string>
}

/**
 * Read the per-agent-pins env flag. Centralised so the gateway, driver,
 * and parent-card render share one definition of "is the new path on?"
 */
export function isPerAgentPinsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROGRESS_CARD_PER_AGENT_PINS === '1'
}

interface CardRecord {
  agentId: string
  chatId: string
  threadId?: string
  parentTurnKey: string
  synthTurnKey: string
  spawnedAt: number
  /**
   * Wall-clock ms when the first emit for this card fired. Used as the
   * card's own elapsed clock. 0 until first emit.
   */
  cardStartedAt: number
  lastEmittedAt: number
  lastEmittedHtml: string
  pendingTimer: { ref: unknown } | null
  glyphTick: number
  isFirstEmit: boolean
  /** True once the registry has emitted with done=true for this card. */
  finalEmitted: boolean
}

/**
 * True when a sub-agent has produced at least one signal worth showing
 * — used to gate lazy spawn so we don't pin empty placeholder cards
 * for orphan or about-to-die sub-agents.
 */
function hasContentSignal(sa: SubAgentState): boolean {
  if (sa.currentTool != null) return true
  if (sa.currentNarrative != null && sa.currentNarrative.length > 0) return true
  if (sa.firstNarrativeText != null && sa.firstNarrativeText.length > 0) return true
  if (sa.toolCount > 0) return true
  if (sa.tasks.length > 0) return true
  if (sa.lastCompletedTool != null) return true
  // Already terminal (e.g. cold-jsonl synth) — emit one final card so
  // the user sees what the sub-agent did before it closed.
  if (sa.state === 'done' || sa.state === 'failed') return true
  return false
}

export function createSubAgentCardRegistry(
  config: SubAgentCardConfig,
  deps: SubAgentCardRegistryDeps,
): SubAgentCardRegistry {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const coalesceMs = deps.coalesceMs ?? 400
  const multiCardCoalesceMs = deps.multiCardCoalesceMs ?? 800
  const minIntervalMs = deps.minIntervalMs ?? 500
  const heartbeatMs = deps.heartbeatMs ?? 5_000
  const setT: (fn: () => void, ms: number) => { ref: unknown } =
    deps.setT ??
    ((fn, ms) => ({ ref: setTimeout(fn, ms) }))
  const clearT: (handle: { ref: unknown }) => void =
    deps.clearT ??
    ((handle) => {
      clearTimeout(handle.ref as ReturnType<typeof setTimeout>)
    })
  const setI: (fn: () => void, ms: number) => { ref: unknown } =
    deps.setI ??
    ((fn, ms) => ({ ref: setInterval(fn, ms) }))
  const clearI: (handle: { ref: unknown }) => void =
    deps.clearI ??
    ((handle) => {
      clearInterval(handle.ref as ReturnType<typeof setInterval>)
    })

  // Keyed by synthTurnKey — each sub-agent card is unique across the
  // session.
  const cards = new Map<string, CardRecord>()

  let heartbeatHandle: { ref: unknown } | null = null
  // Captured so the heartbeat can refresh elapsed counters even when
  // no new events flow. Updated on every syncFromParent.
  const lastSyncCtx = new Map<string, {
    state: ProgressCardState
    chatId: string
    threadId?: string
    parentTurnKey: string
  }>()

  function ensureHeartbeat(): void {
    if (config.enabled === false) return
    if (heartbeatMs <= 0) return
    if (heartbeatHandle != null) return
    heartbeatHandle = setI(() => {
      if (cards.size === 0) return
      // Re-render every running card with a fresh `now` so elapsed
      // ticks visibly. We don't refresh `state` — heartbeats only
      // matter for the elapsed counter, and the slice projector is
      // pure-state-of-now anyway.
      for (const card of cards.values()) {
        if (card.finalEmitted) continue
        const ctx = lastSyncCtx.get(card.parentTurnKey)
        if (!ctx) continue
        scheduleEmit(card, ctx, now())
      }
    }, heartbeatMs)
  }

  function maybeStopHeartbeat(): void {
    if (heartbeatHandle == null) return
    if (cards.size > 0) return
    clearI(heartbeatHandle)
    heartbeatHandle = null
  }

  /** All cards belonging to a given chat+thread (for k-of-n labeling). */
  function siblingsFor(chatId: string, threadId: string | undefined): CardRecord[] {
    const out: CardRecord[] = []
    for (const card of cards.values()) {
      if (card.chatId !== chatId) continue
      if (card.threadId !== threadId) continue
      out.push(card)
    }
    // Stable spawn-order so k is deterministic across renders.
    out.sort((a, b) => a.spawnedAt - b.spawnedAt)
    return out
  }

  function renderCard(
    card: CardRecord,
    ctx: { state: ProgressCardState },
    nowMs: number,
  ): string | null {
    const siblings = siblingsFor(card.chatId, card.threadId)
    const k = siblings.findIndex((s) => s === card) + 1
    const n = siblings.length
    if (k <= 0) return null
    const slice = projectAgentSlice({
      state: ctx.state,
      agentId: card.agentId,
      kind: 'sub',
      k: k + 1, // reserve k=1 for the parent card; sub-agents start at #2
      n: n + 1, // include parent in the total
      glyphTick: card.glyphTick,
      now: nowMs,
    })
    if (!slice) return null
    return renderAgentCard(slice)
  }

  function emitNow(card: CardRecord, html: string, done: boolean, nowMs: number): void {
    const isFirst = card.isFirstEmit
    if (isFirst) {
      card.isFirstEmit = false
      card.cardStartedAt = nowMs
    }
    card.lastEmittedHtml = html
    card.lastEmittedAt = nowMs
    card.glyphTick += 1
    if (done) card.finalEmitted = true
    try {
      deps.emit({
        chatId: card.chatId,
        threadId: card.threadId,
        turnKey: card.synthTurnKey,
        agentId: card.agentId,
        html,
        done,
        isFirstEmit: isFirst,
      })
    } catch (err) {
      log(
        `subagent-card: emit failed agentId=${card.agentId} err="${(err as Error)?.message ?? err}"\n`,
      )
    }
  }

  function scheduleEmit(
    card: CardRecord,
    ctx: { state: ProgressCardState; chatId: string; threadId?: string; parentTurnKey: string },
    nowMs: number,
  ): void {
    if (card.finalEmitted) return
    // Cancel any pending coalesce timer — the new event takes over.
    if (card.pendingTimer != null) {
      clearT(card.pendingTimer)
      card.pendingTimer = null
    }
    const sa = ctx.state.subAgents.get(card.agentId)
    const terminal = sa != null && (sa.state === 'done' || sa.state === 'failed')
    const html = renderCard(card, ctx, nowMs)
    if (!html) return
    const timeSinceLast = nowMs - card.lastEmittedAt
    const sibCount = siblingsFor(card.chatId, card.threadId).length
    const window = sibCount > 1 ? multiCardCoalesceMs : coalesceMs
    if (terminal) {
      // Terminal events fire immediately — final emits must not be
      // coalesced lest the card appear "running" forever.
      emitNow(card, html, true, nowMs)
      cards.delete(card.synthTurnKey)
      maybeStopHeartbeat()
      return
    }
    // Allow first emit to fire immediately (subject to the floor); for
    // subsequent emits, coalesce.
    if (card.isFirstEmit) {
      if (timeSinceLast < minIntervalMs && card.lastEmittedAt > 0) {
        // Should not happen on first emit since lastEmittedAt is 0,
        // but guard anyway.
        const wait = minIntervalMs - timeSinceLast
        card.pendingTimer = setT(() => {
          card.pendingTimer = null
          const refreshed = renderCard(card, ctx, now())
          if (refreshed) emitNow(card, refreshed, false, now())
        }, wait)
        return
      }
      // Skip emit if the first event is itself terminal-only with no
      // content — render returned `idle` only, edge case.
      // (Render returns "idle" verb for empty state, that's still
      //  worth pinning so leave as-is.)
      emitNow(card, html, false, nowMs)
      return
    }
    // Subsequent events: coalesce within `window`, but always respect
    // `minIntervalMs` floor.
    const debounce = Math.max(window, minIntervalMs - timeSinceLast)
    card.pendingTimer = setT(() => {
      card.pendingTimer = null
      const refreshed = renderCard(card, ctx, now())
      if (refreshed) emitNow(card, refreshed, false, now())
    }, debounce)
  }

  function spawnCard(args: {
    agentId: string
    chatId: string
    threadId?: string
    parentTurnKey: string
    spawnedAt: number
  }): CardRecord {
    const card: CardRecord = {
      agentId: args.agentId,
      chatId: args.chatId,
      threadId: args.threadId,
      parentTurnKey: args.parentTurnKey,
      synthTurnKey: subAgentTurnKey(args.parentTurnKey, args.agentId),
      spawnedAt: args.spawnedAt,
      cardStartedAt: 0,
      lastEmittedAt: 0,
      lastEmittedHtml: '',
      pendingTimer: null,
      glyphTick: 0,
      isFirstEmit: true,
      finalEmitted: false,
    }
    cards.set(card.synthTurnKey, card)
    log(
      `subagent-card: spawn agentId=${args.agentId} parentTurnKey=${args.parentTurnKey}\n`,
    )
    return card
  }

  return {
    syncFromParent(args) {
      if (!config.enabled) return
      const { state, chatId, threadId, parentTurnKey, now: nowMs } = args
      lastSyncCtx.set(parentTurnKey, { state, chatId, threadId, parentTurnKey })
      // Two-pass: spawn all eligible cards first so `siblingsFor()` —
      // which the emit path consults to compute the k-of-n header — sees
      // every newcomer in this sync. Otherwise the first sibling to emit
      // would render "Agent 2 of 2" and the second "Agent 3 of 3", with
      // the first card's k-of-n stuck at the stale value until its next
      // edit.
      const toSchedule: CardRecord[] = []
      for (const [agentId, sa] of state.subAgents) {
        const synth = subAgentTurnKey(parentTurnKey, agentId)
        let card = cards.get(synth)
        if (card == null) {
          if (!hasContentSignal(sa)) continue
          card = spawnCard({ agentId, chatId, threadId, parentTurnKey, spawnedAt: sa.startedAt })
          ensureHeartbeat()
        }
        toSchedule.push(card)
      }
      for (const card of toSchedule) {
        scheduleEmit(card, { state, chatId, threadId, parentTurnKey }, nowMs)
      }
      // For agents that vanished from state.subAgents (shouldn't
      // normally happen — the reducer never deletes; but defensive),
      // finalize their cards.
      for (const card of [...cards.values()]) {
        if (card.parentTurnKey !== parentTurnKey) continue
        if (state.subAgents.has(card.agentId)) continue
        if (card.finalEmitted) continue
        const html = renderCard(card, { state }, nowMs)
        if (html) emitNow(card, html, true, nowMs)
        cards.delete(card.synthTurnKey)
      }
      maybeStopHeartbeat()
    },

    finalizeAll(parentTurnKey, nowMs) {
      const ctx = lastSyncCtx.get(parentTurnKey)
      for (const card of [...cards.values()]) {
        if (card.parentTurnKey !== parentTurnKey) continue
        if (card.finalEmitted) continue
        if (card.pendingTimer != null) {
          clearT(card.pendingTimer)
          card.pendingTimer = null
        }
        if (ctx != null) {
          const html = renderCard(card, ctx, nowMs)
          if (html) emitNow(card, html, true, nowMs)
        } else {
          // No context to re-render with — best-effort emit using the
          // last rendered HTML so the gateway's final-emit path can
          // still flush the pin into a clean state.
          if (card.lastEmittedHtml) {
            emitNow(card, card.lastEmittedHtml, true, nowMs)
          }
        }
        cards.delete(card.synthTurnKey)
      }
      lastSyncCtx.delete(parentTurnKey)
      maybeStopHeartbeat()
    },

    dispose() {
      for (const card of cards.values()) {
        if (card.pendingTimer != null) clearT(card.pendingTimer)
      }
      cards.clear()
      lastSyncCtx.clear()
      if (heartbeatHandle != null) {
        clearI(heartbeatHandle)
        heartbeatHandle = null
      }
    },

    trackedAgentIds(parentTurnKey) {
      const out: string[] = []
      for (const card of cards.values()) {
        if (card.parentTurnKey === parentTurnKey) out.push(card.agentId)
      }
      out.sort()
      return out
    },
  }
}
