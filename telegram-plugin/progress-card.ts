/**
 * Progress card renderer — event-driven alternative to PTY-snapshot streaming.
 *
 * Turns a stream of `SessionEvent`s (from session-tail.ts) into a stable,
 * flicker-free Telegram HTML message that edits in place as the turn
 * progresses. Solves the root cause of the PTY-stream flicker: Ink's
 * differential re-renders mutate the last line multiple times per tool
 * call, so snapshot-edit based on TUI text wobbles. Event reducer only
 * mutates state on *transitions* (tool start, tool finish, stage change),
 * so nothing above the active line ever rewrites.
 *
 * Pure functions — no IO, no globals, no timers. The outer loop owns
 * flush cadence (500ms hard floor between edits, coalesce 400ms bursts,
 * fire immediately on stage change).
 */

import type { SessionEvent } from './session-tail.js'
import { toolLabel, isHumanDescription } from './tool-labels.js'
import {
  formatDuration as sharedFormatDuration,
  escapeHtml as sharedEscapeHtml,
  truncate as sharedTruncate,
} from './card-format.js'
import { isBenignToolError } from './tool-error-filter.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ItemState = 'pending' | 'running' | 'done' | 'failed'

export interface ChecklistItem {
  /** Index within the current turn — sequential, stable. */
  readonly id: number
  /**
   * Claude Code tool_use content-block id (e.g. "toolu_01ABC…"). Used
   * to pair the tool_result back to its tool_use by id rather than by
   * running-item order — required for correct handling of parallel
   * tool_use calls within a single assistant message. Null when the
   * session JSONL line omitted it (older event shape or synthetic test
   * events), in which case the reducer falls back to FIFO pairing.
   */
  readonly toolUseId: string | null
  /** Claude Code tool name, e.g. "Read", "Bash", "Grep". */
  readonly tool: string
  /** Short human-readable label derived from the tool's input (file path,
   *  command, query, etc.). Empty string when the tool has no natural
   *  label (e.g. TodoWrite) or input was missing. */
  readonly label: string
  /**
   * True when the label came from a human-authored `description` field
   * (Bash/BashOutput/Task/Agent with a non-empty description). The
   * renderer uses this to suppress the tool-name prefix so the card reads
   * "Check commit state" instead of "Bash Check commit state".
   */
  readonly humanAuthored: boolean
  /** Current state. */
  readonly state: ItemState
  /** Unix ms when tool_use fired. */
  readonly startedAt: number
  /** Unix ms when tool_result arrived. Only set on done/failed. */
  readonly finishedAt?: number
  /**
   * Multi-agent: for `Agent`/`Task` tool_use items only, the `agentId`
   * of the correlated sub-agent. Set when `sub_agent_started` lands and
   * matches this item's prompt text. Renderer (later PR) uses it to
   * keep the [Main] line in 🤖 (not ✅) until the parent's tool_result
   * arrives. Null until correlation succeeds.
   */
  readonly spawnedAgentId?: string | null
}

export type Stage = 'plan' | 'run' | 'done'

/**
 * Multi-agent foundation (gated by PROGRESS_CARD_MULTI_AGENT=1):
 *
 * Per-sub-agent state, populated by the new `sub_agent_*` events. Today
 * (in this PR) the renderer doesn't read any of it — it lives alongside
 * the existing per-tool checklist purely as a structural foundation. The
 * later renderer PR consumes `subAgents` and `pendingAgentSpawns` to draw
 * the two-section [Main] / [Sub-agents] card.
 *
 * `parentToolUseId` links a sub-agent back to the parent's `Agent`/`Task`
 * tool_use that spawned it, established by prompt-text correlation in the
 * correlation PR. Null while we haven't yet seen the parent (rare reverse
 * race) or when correlation fails entirely (orphan).
 */
export interface SubAgentState {
  readonly agentId: string
  readonly description: string
  readonly subagentType?: string
  readonly parentToolUseId: string | null
  readonly state: ItemState
  readonly startedAt: number
  readonly finishedAt?: number
  readonly toolCount: number
  /**
   * Monotonically-increasing version counter bumped only on milestone
   * transitions: sub-agent started, finished (done/failed). NOT bumped
   * on per-tool ticks (sub_agent_tool_use, sub_agent_tool_result,
   * sub_agent_text). The render layer uses this to avoid re-rendering
   * the `<blockquote expandable>` section on every throttle tick, which
   * would re-collapse the user's expanded view.
   */
  readonly milestoneVersion: number
  /**
   * The first user-message text from the sub-agent's JSONL — kept so the
   * reverse-race adoption path (orphan first, parent later) can match
   * against incoming pendingAgentSpawns entries.
   */
  readonly firstPromptText?: string
  readonly currentTool?: {
    readonly tool: string
    readonly label: string
    readonly humanAuthored: boolean
    readonly toolUseId: string
    readonly startedAt: number
  }
  /**
   * Per-sub-agent analogue of ProgressCardState.pendingPreamble: the most
   * recent single-line `text` block THIS sub-agent emitted that hasn't
   * yet been paired to a `sub_agent_tool_use`. Set on every
   * `sub_agent_text` event; consumed and cleared by the NEXT
   * `sub_agent_tool_use` for the same agent (sibling tool_uses in the
   * same batch get the filename fallback). Cleared on
   * `sub_agent_turn_end` / `turn_end`. Lives per-agent — a preamble from
   * sub-agent A must not leak onto sub-agent B's tool_use.
   */
  readonly pendingPreamble?: string | null
  /**
   * The sub-agent's first narrative/text line, captured on the first
   * `sub_agent_text` event for this agent. Used as a description fallback
   * when correlation fails (orphan sub-agents) so the user still sees
   * something meaningful instead of "(uncorrelated)". Never cleared.
   */
  readonly firstNarrativeText?: string
  /**
   * Most-recent narrative line pushed via the gateway's `progress_update`
   * MCP tool (issue #305 Option A). Distinct from:
   *   - `firstNarrativeText` — one-shot, used as description fallback
   *   - `pendingPreamble`    — one-shot pre-tool narration from session-tail
   * `currentNarrative` is replace-on-each-call (last write wins). Cleared
   * naturally on terminal-state render via the existing branch.
   */
  readonly currentNarrative?: string | null
  /**
   * The tool most recently completed by this sub-agent. Captured on
   * `sub_agent_tool_result` (before the toolUseId match clears
   * `currentTool`). Used by the render fallback chain when the sub-agent
   * is running-but-between-tools so we show the last thing it did rather
   * than the bare "(idle)" string.
   */
  readonly lastCompletedTool?: {
    readonly tool: string
    readonly label: string
    readonly humanAuthored: boolean
    readonly finishedAt: number
  }
  /**
   * Issue #352: ring buffer of the last 2 completed tools, ordered oldest
   * first. Combined with `lastCompletedTool` and `currentTool` this lets
   * the expandable section show up to 3 recent actions with strikethrough
   * for completed items and a `↳` arrow for the active one.
   *
   * Only `lastCompletedTool` is used for the between-tool fallback chain
   * outside the expandable; `recentCompletedTools` is purely for the
   * expandable view (issue #352).
   */
  readonly recentCompletedTools: ReadonlyArray<{
    readonly tool: string
    readonly label: string
    readonly humanAuthored: boolean
    readonly finishedAt: number
  }>
  /** Sub-sub-agents observed (rendered as `(spawned N)` only, not as rows). */
  readonly nestedSpawnCount: number
  /**
   * Gap 4 (cold-JSONL detection): wall-clock ms of the most recent sub-agent
   * event (sub_agent_tool_use, sub_agent_tool_result, sub_agent_text, etc.).
   * Set on every event that updates this sub-agent's state. When the driver
   * observes that a running sub-agent's `lastEventAt` is more than
   * `coldSubAgentThresholdMs` (default 30s) in the past, it synthesises a
   * `sub_agent_turn_end` so the deferred-completion path can proceed.
   */
  readonly lastEventAt?: number
}

/**
 * A parent `Agent`/`Task` tool_use whose sub-agent JSONL hasn't appeared
 * yet. Once `sub_agent_started` arrives with matching `firstPromptText`
 * the entry is moved into `subAgents` and removed from this map.
 */
export interface PendingAgentSpawn {
  readonly parentToolUseId: string
  readonly description: string
  readonly subagentType?: string
  readonly promptText: string
  readonly startedAt: number
}

export interface NarrativeStep {
  readonly id: number
  readonly text: string
  /**
   * State machine:
   * - `active`: the narrative step is currently the latest, actively narrating.
   * - `done`: the step is complete (next text event or turn_end fired, and no
   *   background sub-agents are pending).
   * - `awaiting-subagent`: the step dispatched one or more background
   *   sub-agents (Agent/Task tool_use) that haven't reached terminal state
   *   yet. Rendered identically to `active` (◉) so the card never shows
   *   "done" while sub-agents are still running. Transitions to `done` once
   *   all entries in `awaitingSubAgentIds` have completed.
   */
  readonly state: 'done' | 'active' | 'awaiting-subagent'
  readonly startedAt: number
  readonly toolCount: number
  /**
   * Agent/Task `toolUseId`s from the parent turn that this narrative step
   * triggered but whose sub-agents haven't yet been correlated (i.e. the
   * `sub_agent_started` event hasn't landed yet). When correlation arrives,
   * the entry migrates from here to `awaitingSubAgentIds`. Allows the step
   * to know about in-flight spawns even before the sub-agent JSONL appears.
   */
  readonly pendingAgentToolUseIds: ReadonlyArray<string>
  /**
   * `agentId`s of sub-agents spawned during this narrative step that are
   * still running. When this set becomes empty and the step is in
   * `awaiting-subagent` state, it flips to `done`.
   */
  readonly awaitingSubAgentIds: ReadonlyArray<string>
}

export interface ProgressCardState {
  /** Unix ms when the turn started (enqueue event). 0 when idle. */
  readonly turnStartedAt: number
  /** User's inbound message text, truncated. */
  readonly userRequest?: string
  /** Ordered checklist items — never reorder, only append and transition. */
  readonly items: ReadonlyArray<ChecklistItem>
  /** Current high-level stage. */
  readonly stage: Stage
  /** Whether the model is currently in a thinking block. */
  readonly thinking: boolean
  /** Latest short `text` content from the assistant (for the thought line). */
  readonly latestText?: string
  /**
   * The most recent single-line `text` block the model emitted that
   * hasn't yet been paired to a `tool_use`. Used by the file/search
   * tools (Read/Write/Edit/Grep/Glob) to show the model's natural
   * preamble ("I'll check foo.ts") instead of the filename fallback
   * in the checklist. Set on every `text` event; consumed and cleared
   * by the NEXT `tool_use` (so sibling tool_uses in the same batch do
   * NOT reuse it). Cleared unconditionally on `turn_end` / `enqueue`.
   */
  readonly pendingPreamble?: string | null
  /** Narrative steps derived from assistant text blocks. */
  readonly narratives: ReadonlyArray<NarrativeStep>
  /**
   * Multi-agent: per-sub-agent state, keyed by `agentId` (sub-agent JSONL
   * filename stem). Empty in single-agent turns. Always present so the
   * shape is stable across flag-on / flag-off renders.
   */
  readonly subAgents: ReadonlyMap<string, SubAgentState>
  /**
   * Multi-agent: parent Agent/Task tool_uses awaiting a sub-agent JSONL
   * to correlate with. Keyed by the parent's `toolUseId`.
   */
  readonly pendingAgentSpawns: ReadonlyMap<string, PendingAgentSpawn>
}

/**
 * True when any sub-agent — correlated or orphan — is still running.
 *
 * Used as both the **display** gate (keep the card showing "Working…" with
 * sub-agent rows) and the **defer** gate (hold `pendingCompletion` past
 * parent turn_end so the card stays pinned until the last sub-agent reports
 * done). Orphans (parentToolUseId == null, e.g. from
 * `Agent({run_in_background: true})`) gate both, so background dispatches
 * stay visible past parent turn-end (#87).
 *
 * Historical context: an earlier design excluded orphans from the defer
 * gate because their `sub_agent_turn_end` could go missing if the parent
 * turn rolled over (ghost-pin risk, #31 / #43). That risk is now bounded
 * by `closeZombie` on next enqueue + the `maxIdleMs` heartbeat ceiling, so
 * orphans gate the defer like correlated sub-agents do.
 */
export function hasAnyRunningSubAgent(state: ProgressCardState): boolean {
  for (const sa of state.subAgents.values()) {
    if (sa.state === 'running') return true
  }
  return false
}

export function initialState(): ProgressCardState {
  return {
    turnStartedAt: 0,
    items: [],
    narratives: [],
    stage: 'plan',
    thinking: false,
    subAgents: new Map(),
    pendingAgentSpawns: new Map(),
  }
}

/**
 * Multi-agent sub-section in progress cards. Always enabled — the two-
 * section [Main]/[Sub-agents] layout activates automatically when sub-
 * agent events are present, and is invisible otherwise. Can be forced
 * off with PROGRESS_CARD_MULTI_AGENT=0 for debugging.
 */
export function isMultiAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROGRESS_CARD_MULTI_AGENT !== '0'
}

// ─── Reducer ────────────────────────────────────────────────────────────────

/**
 * Decide what state an `active` NarrativeStep should transition to when it
 * would normally flip to `done` (on a new `text` event or `turn_end`).
 *
 * If the narrative has dispatched background sub-agents that are still
 * running (i.e. `awaitingSubAgentIds` overlap with sub-agents in `running`
 * state, or `pendingAgentToolUseIds` haven't yet been correlated), we keep
 * it in `awaiting-subagent` rather than immediately marking it `done`.
 *
 * Foreground Agent/Task calls complete before the tool_result returns, so
 * they won't appear in `awaitingSubAgentIds` by the time we reach here —
 * those flip straight to `done` as before (#324 fix, no regression).
 */
function narrativeTransitionFromActive(
  n: NarrativeStep,
  subAgents: ReadonlyMap<string, SubAgentState>,
): NarrativeStep {
  // Any still-running sub-agents this narrative is waiting for?
  const hasRunningAwaited = n.awaitingSubAgentIds.some(
    id => subAgents.get(id)?.state === 'running',
  )
  // Any agent tool_use that hasn't yet been correlated to a sub_agent_started?
  // (Rare race: tool_use fired but sub_agent_started hasn't landed yet.)
  const hasPendingCorrelation = n.pendingAgentToolUseIds.length > 0
  if (hasRunningAwaited || hasPendingCorrelation) {
    return { ...n, state: 'awaiting-subagent' }
  }
  return { ...n, state: 'done' }
}

function extractNarrativeLabel(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const line = trimmed.split('\n')[0]
  return line.length > 200 ? line.slice(0, 199) + '…' : line
}

/**
 * Fold a single event into the state. Events outside the turn lifecycle
 * (stale tool_result before enqueue, duplicate turn_end, etc.) are no-ops.
 */
export function reduce(
  state: ProgressCardState,
  event: SessionEvent,
  now: number,
): ProgressCardState {
  switch (event.kind) {
    case 'enqueue': {
      // New turn starts. Reset state entirely. Extract a short summary
      // from the enqueue's raw content (strip the channel XML wrapper).
      return {
        ...initialState(),
        turnStartedAt: now,
        userRequest: extractUserText(event.rawContent),
        stage: 'plan',
      }
    }

    case 'thinking': {
      if (state.turnStartedAt === 0) return state
      return { ...state, thinking: true, stage: state.stage === 'plan' ? 'plan' : state.stage }
    }

    case 'text': {
      if (state.turnStartedAt === 0) return state
      // Stash the raw text as a candidate preamble for the next
      // tool_use. toolLabel() applies its own single-line + length
      // gate, so we pass the full text through here and let the label
      // layer decide. Multi-line narrative text will be rejected there
      // and the filename/pattern fallback wins — which is what we
      // want for "here's my plan: <long paragraph>" style narration.
      const pendingPreamble = event.text
      const label = extractNarrativeLabel(event.text)
      if (!label) {
        return { ...state, latestText: event.text, thinking: false, pendingPreamble }
      }
      const prevNarratives = state.narratives.map(n =>
        n.state === 'active' ? narrativeTransitionFromActive(n, state.subAgents) : n,
      )
      const newNarrative: NarrativeStep = {
        id: prevNarratives.length,
        text: label,
        state: 'active',
        startedAt: now,
        toolCount: 0,
        pendingAgentToolUseIds: [],
        awaitingSubAgentIds: [],
      }
      return {
        ...state,
        narratives: [...prevNarratives, newNarrative],
        latestText: event.text,
        thinking: false,
        pendingPreamble,
      }
    }

    case 'tool_use': {
      if (state.turnStartedAt === 0) return state
      // Append the new item as running. We do NOT defensively close out
      // prior still-running items: Claude Code emits parallel tool_use
      // blocks within a single assistant message (e.g. Bash + Read
      // batched), and those arrive as separate SessionEvents. Prior
      // logic that auto-closed running items on each new tool_use
      // mis-paired the subsequent tool_results — the first result would
      // land on the WRONG item (by FIFO fallback) because its
      // toolUseId-matched item had already been force-done. Pairing is
      // now entirely up to tool_result (by toolUseId when available).
      // Consume pendingPreamble exactly once — the first tool_use after
      // the text block pairs with it; any sibling tool_uses in the same
      // assistant message fall back to the filename/pattern label. This
      // is why we capture before building the item and clear it in the
      // returned state below.
      const preamble = state.pendingPreamble ?? undefined
      const nextItem: ChecklistItem = {
        id: state.items.length,
        toolUseId: event.toolUseId ?? null,
        tool: event.toolName,
        label: toolLabel(event.toolName, event.input, preamble),
        humanAuthored: isHumanDescription(event.toolName, event.input),
        state: 'running',
        startedAt: now,
      }
      // Multi-agent: if this is an Agent/Task tool_use, stage a pending
      // spawn awaiting the matching sub-agent JSONL. Correlation key is
      // the prompt text (the sub-agent's first user message contains
      // exactly this string). Reverse-race: if a sub-agent already
      // landed as orphan with this prompt text, adopt it now.
      let pendingAgentSpawns = state.pendingAgentSpawns
      let subAgents = state.subAgents
      if (
        (event.toolName === 'Agent' || event.toolName === 'Task') &&
        event.toolUseId &&
        event.input
      ) {
        const promptText = String(event.input.prompt ?? '')
        const description = String(event.input.description ?? '') || promptText.slice(0, 50)
        const subagentType =
          typeof event.input.subagent_type === 'string'
            ? (event.input.subagent_type as string)
            : undefined
        // Reverse-race adoption: scan orphan sub-agents (parentToolUseId
        // null) for a prompt-text match. When multiple orphans match the
        // same prompt (parallel Agent calls with identical `prompt`), we
        // pair the oldest orphan first — `startedAt` as tiebreaker rather
        // than JS Map insertion order, which depends on JSONL file-watch
        // delivery order and can scramble the pairing across concurrent
        // sub-agent processes.
        let adopted = false
        let bestAgentId: string | null = null
        let bestStartedAt = Number.POSITIVE_INFINITY
        for (const [agentId, sa] of subAgents) {
          if (sa.parentToolUseId == null && sa.firstPromptText === promptText) {
            if (sa.startedAt < bestStartedAt) {
              bestStartedAt = sa.startedAt
              bestAgentId = agentId
            }
          }
        }
        if (bestAgentId != null) {
          const sa = subAgents.get(bestAgentId)!
          const next = new Map(subAgents)
          next.set(bestAgentId, {
            ...sa,
            parentToolUseId: event.toolUseId,
            description,
            subagentType,
          })
          subAgents = next
          adopted = true
          process.stderr.write(`telegram gateway: progress-card: tool_use → agent correlation toolUseId=${event.toolUseId} agentId=${bestAgentId} (reverse-race adopt orphan)\n`)
        }
        if (!adopted) {
          process.stderr.write(`telegram gateway: progress-card: tool_use → agent correlation toolUseId=${event.toolUseId} agentId=pending (awaiting sub_agent_started)\n`)
          const nextPending = new Map(pendingAgentSpawns)
          nextPending.set(event.toolUseId, {
            parentToolUseId: event.toolUseId,
            description,
            subagentType,
            promptText,
            startedAt: now,
          })
          pendingAgentSpawns = nextPending
        }
      }
      let narratives = state.narratives
      if (narratives.length > 0) {
        const last = narratives[narratives.length - 1]
        if (last.state === 'active') {
          const isAgentCall =
            (event.toolName === 'Agent' || event.toolName === 'Task') &&
            !!event.toolUseId
          const updatedLast: NarrativeStep = {
            ...last,
            toolCount: last.toolCount + 1,
            // When the active narrative just triggered a background Agent/Task
            // call, record the toolUseId so that when sub_agent_started
            // correlates it, we can link the sub-agent to this narrative step.
            pendingAgentToolUseIds: isAgentCall
              ? [...last.pendingAgentToolUseIds, event.toolUseId!]
              : last.pendingAgentToolUseIds,
          }
          narratives = [...narratives.slice(0, -1), updatedLast]
        }
      }
      // Cap the raw item history. Only the last MAX_VISIBLE_ITEMS are
      // rendered (see renderChecklist), and pairing of tool_result to
      // tool_use happens by toolUseId — not by position — so keeping
      // thousands of historical entries around only slows rendering and
      // leaks memory on long turns. We keep ~10× the visible window so
      // pairings for results arriving after many intervening tool uses
      // still find their running partner.
      const ITEM_HISTORY_CAP = MAX_VISIBLE_ITEMS * 10
      const appended = [...state.items, nextItem]
      const boundedItems =
        appended.length > ITEM_HISTORY_CAP
          ? appended.slice(appended.length - ITEM_HISTORY_CAP)
          : appended
      return {
        ...state,
        items: boundedItems,
        narratives,
        stage: 'run',
        thinking: false,
        pendingAgentSpawns,
        subAgents,
        pendingPreamble: null,
      }
    }

    case 'tool_result': {
      if (state.turnStartedAt === 0) return state
      // Pair by tool_use_id when present: the model can emit parallel
      // tool_use calls in a single assistant message, so FIFO pairing
      // by running-item order is not sufficient. Falls back to the
      // oldest running item when the result has no toolUseId or no
      // running item matches (older JSONL shape, synthetic test events).
      // is_error=true on the tool_result JSONL line flips state to
      // 'failed' (❌).
      let idx = -1
      if (event.toolUseId) {
        idx = state.items.findIndex(
          (it) => it.state === 'running' && it.toolUseId === event.toolUseId,
        )
      }
      if (idx === -1) {
        idx = state.items.findIndex((it) => it.state === 'running')
      }
      if (idx === -1) return state
      const items = state.items.slice()
      // tool_result with is_error=true → 'failed' (❌), unless the error
      // text matches a benign pattern (file-not-found, no-match, etc) in
      // which case render 'done' (✅) — see tool-error-filter.ts.
      //
      // Fail-closed semantics: when isError=true but errorText is missing
      // or empty (older JSONL shapes, malformed lines, tools that error
      // without output), keep the 'failed' state. Suppression requires
      // *evidence* the error is benign; absence of evidence stays loud.
      const nextState: ItemState =
        event.isError === true
          ? (event.errorText && isBenignToolError(event.errorText) ? 'done' : 'failed')
          : 'done'
      items[idx] = { ...items[idx], state: nextState, finishedAt: now }
      // Multi-agent: a parent Agent/Task tool_result is the authoritative
      // close-out for its sub-agent. Find any sub-agent linked to this
      // toolUseId (via parentToolUseId) and finalize it. Also clear any
      // matching pendingAgentSpawn (sub-agent JSONL never appeared).
      let subAgents = state.subAgents
      let pendingAgentSpawns = state.pendingAgentSpawns
      if (event.toolUseId) {
        for (const [agentId, sa] of subAgents) {
          if (sa.parentToolUseId === event.toolUseId) {
            const next = new Map(subAgents)
            // Bump milestoneVersion — parent tool_result is a milestone transition.
            next.set(agentId, {
              ...sa,
              state: nextState,
              finishedAt: now,
              milestoneVersion: (sa.milestoneVersion ?? 0) + 1,
            })
            subAgents = next
            break
          }
        }
        if (pendingAgentSpawns.has(event.toolUseId)) {
          const next = new Map(pendingAgentSpawns)
          next.delete(event.toolUseId)
          pendingAgentSpawns = next
        }
      }
      return { ...state, items, subAgents, pendingAgentSpawns }
    }

    case 'sub_agent_started': {
      if (state.turnStartedAt === 0) return state
      // Already known? (Defensive — re-attach can re-emit.)
      if (state.subAgents.has(event.agentId)) return state
      // Try to correlate by prompt-text against pendingAgentSpawns. On
      // hit: move pending → subAgents, link the matching [Main]
      // ChecklistItem via spawnedAgentId, and consume the pending entry.
      // On miss: register as orphan; the parent's tool_use may arrive
      // later (reverse race) and adopt via the tool_use case.
      let parentToolUseId: string | null = null
      let description = '(uncorrelated)'
      let subagentType: string | undefined
      let pendingAgentSpawns = state.pendingAgentSpawns
      let items = state.items
      for (const [parentId, pending] of pendingAgentSpawns) {
        if (pending.promptText === event.firstPromptText) {
          parentToolUseId = parentId
          description = pending.description
          subagentType = pending.subagentType
          const nextPending = new Map(pendingAgentSpawns)
          nextPending.delete(parentId)
          pendingAgentSpawns = nextPending
          // Link the [Main] checklist item back so renderer can keep
          // its 🤖 state consistent.
          items = items.map((it) =>
            it.toolUseId === parentId
              ? { ...it, spawnedAgentId: event.agentId }
              : it,
          )
          break
        }
      }
      const sub: SubAgentState = {
        agentId: event.agentId,
        description,
        subagentType: subagentType ?? event.subagentType,
        parentToolUseId,
        state: 'running',
        startedAt: now,
        toolCount: 0,
        firstPromptText: event.firstPromptText,
        nestedSpawnCount: 0,
        milestoneVersion: 1,
        lastEventAt: now,
        recentCompletedTools: [],
      }
      const subAgents = new Map(state.subAgents)
      subAgents.set(event.agentId, sub)
      // Log correlation result. For orphans: include the promptText prefix
      // and the count of pending spawns so callers can diagnose WHY the
      // match failed (empty pendingAgentSpawns = no parent tool_use arrived
      // yet; promptText mismatch = race between spawn and text delivery).
      if (parentToolUseId != null) {
        process.stderr.write(`telegram gateway: progress-card: sub_agent_started agentId=${event.agentId} correlated=yes parentToolUseId=${parentToolUseId}\n`)
      } else {
        const promptSnip = (event.firstPromptText ?? '').slice(0, 80).replace(/\n/g, ' ')
        const pendingCount = state.pendingAgentSpawns.size
        process.stderr.write(`telegram gateway: progress-card: sub_agent_started agentId=${event.agentId} correlated=orphan pendingSpawns=${pendingCount} promptSnip="${promptSnip}" — NOTE: orphan sub-agents no longer gate parent turn_end defer (#31 fix)\n`)
      }
      // Gate parent narrative steps: if a narrative has a pendingAgentToolUseId
      // matching this new sub-agent's parentToolUseId, migrate it from
      // pendingAgentToolUseIds → awaitingSubAgentIds so the narrative knows
      // which agentId to watch for completion (fixes #324).
      const narratives = parentToolUseId != null
        ? state.narratives.map(n => {
            if (n.pendingAgentToolUseIds.includes(parentToolUseId)) {
              return {
                ...n,
                pendingAgentToolUseIds: n.pendingAgentToolUseIds.filter(id => id !== parentToolUseId),
                awaitingSubAgentIds: [...n.awaitingSubAgentIds, event.agentId],
              }
            }
            return n
          })
        : state.narratives
      return { ...state, subAgents, pendingAgentSpawns, items, narratives }
    }

    case 'sub_agent_text': {
      // Per-sub-agent analogue of the parent `text` case: stash the raw
      // text as a candidate preamble for THIS sub-agent's next
      // sub_agent_tool_use. toolLabel() applies the single-line + length
      // gate so we pass the full text through unfiltered. No-op if the
      // sub-agent isn't known yet (defensive: sub_agent_started should
      // always precede sub_agent_text in the same JSONL).
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      const next = new Map(state.subAgents)
      next.set(event.agentId, {
        ...sa,
        pendingPreamble: event.text,
        // Capture the first narrative line for the description-fallback
        // chain. Once set, never overwrite — we want the sub-agent's
        // initial framing, not its latest chatter.
        firstNarrativeText: sa.firstNarrativeText ?? event.text,
        lastEventAt: now,
      })
      return { ...state, subAgents: next }
    }

    case 'sub_agent_narrative': {
      // Issue #305 Option A: most-recent-wins narrative line pushed by the
      // sub-agent via the gateway's `progress_update` MCP tool. Replace-only
      // (last write wins); no milestoneVersion bump (per-tick update, not a
      // structural transition). No-op if the sub-agent isn't known yet.
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      const next = new Map(state.subAgents)
      next.set(event.agentId, {
        ...sa,
        currentNarrative: event.text,
        lastEventAt: now,
      })
      return { ...state, subAgents: next }
    }

    case 'sub_agent_tool_use': {
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      // Consume pendingPreamble exactly once — same one-shot semantic as
      // the parent path (3ad8436): the first sub_agent_tool_use after a
      // sub_agent_text pairs with it; sibling tool_uses in the same
      // assistant message fall back to filename/pattern.
      const preamble = sa.pendingPreamble ?? undefined
      const next = new Map(state.subAgents)
      next.set(event.agentId, {
        ...sa,
        // toolCount is incremented on sub_agent_tool_result (not here) so
        // the count reflects completed tools — matching the semantics the
        // renderer surfaces as "N tools total" (Gap 5 fix, #316).
        currentTool: event.toolUseId
          ? {
              tool: event.toolName,
              label: toolLabel(event.toolName, event.input, preamble),
              humanAuthored: isHumanDescription(event.toolName, event.input),
              toolUseId: event.toolUseId,
              startedAt: now,
            }
          : sa.currentTool,
        pendingPreamble: null,
        lastEventAt: now,
      })
      return { ...state, subAgents: next }
    }

    case 'sub_agent_tool_result': {
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      // Per design §3.3: per-tool errors don't fail the agent; only the
      // parent's tool_result does. We clear currentTool if it matches,
      // AND stash it as lastCompletedTool so the render fallback chain
      // can surface "just finished X" instead of a bare "(idle)" line
      // while the sub-agent thinks between tools (Gap 6 fix, #316).
      // toolCount increments here (on result, not on use) so the count
      // reflects completed tools — consistent with render semantics and
      // the spec in the issue (Gap 5 fix, #316).
      if (sa.currentTool && sa.currentTool.toolUseId === event.toolUseId) {
        const justFinished = {
          tool: sa.currentTool.tool,
          label: sa.currentTool.label,
          humanAuthored: sa.currentTool.humanAuthored,
          finishedAt: now,
        }
        // Maintain a ring buffer of the last 2 completed tools for the
        // expandable section (issue #352). Slide the window: drop the oldest
        // when we're already at capacity (2), then append the new entry.
        const prevRecent = sa.recentCompletedTools ?? []
        const nextRecent = [...prevRecent, justFinished].slice(-2)
        const next = new Map(state.subAgents)
        next.set(event.agentId, {
          ...sa,
          currentTool: undefined,
          lastCompletedTool: justFinished,
          recentCompletedTools: nextRecent,
          toolCount: sa.toolCount + 1,
          lastEventAt: now,
        })
        return { ...state, subAgents: next }
      }
      return state
    }

    case 'sub_agent_turn_end': {
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      // Tentative close: parent's tool_result is still authoritative.
      // If it later arrives with isError=true, the tool_result case
      // overrides this 'done' with 'failed'. Clear any lingering
      // pendingPreamble defensively — mirrors the parent turn_end path.
      // Bump milestoneVersion — this is a milestone transition.
      const next = new Map(state.subAgents)
      next.set(event.agentId, {
        ...sa,
        state: 'done',
        finishedAt: now,
        pendingPreamble: null,
        milestoneVersion: (sa.milestoneVersion ?? 0) + 1,
      })
      // Gate parent narrative steps (#324): remove this agentId from any
      // narrative step's awaitingSubAgentIds. If a step's awaiting list
      // becomes empty (all sub-agents done) and the step is in
      // `awaiting-subagent` state, flip it to `done`.
      const narratives = state.narratives.map(n => {
        if (!n.awaitingSubAgentIds.includes(event.agentId)) return n
        const remaining = n.awaitingSubAgentIds.filter(id => id !== event.agentId)
        // Keep pendingAgentToolUseIds in mind: those migrate to awaitingSubAgentIds
        // when their sub_agent_started fires. Only flip to done when BOTH
        // lists are empty.
        const allDone = remaining.length === 0 && n.pendingAgentToolUseIds.length === 0
        return {
          ...n,
          awaitingSubAgentIds: remaining,
          state: (n.state === 'awaiting-subagent' && allDone) ? ('done' as const) : n.state,
        }
      })
      return { ...state, subAgents: next, narratives }
    }

    case 'sub_agent_nested_spawn': {
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      const next = new Map(state.subAgents)
      next.set(event.agentId, { ...sa, nestedSpawnCount: sa.nestedSpawnCount + 1 })
      return { ...state, subAgents: next }
    }

    case 'turn_end': {
      if (state.turnStartedAt === 0) return state
      const items = state.items.map((it) =>
        it.state === 'running' ? { ...it, state: 'done' as const, finishedAt: now } : it,
      )
      // Running sub-agents may outlive parent turn_end (common for background
      // `Agent(run_in_background=true)` calls — parent returns immediately
      // but the sub-agent keeps working). Leave them in `state: 'running'`
      // so their card surface stays informative, and let them close via
      // their own `sub_agent_turn_end` event (or via the driver's
      // abandonment path on maxIdle / enqueue-force-close). For sub-agents
      // already done, clear pendingPreamble defensively.
      const subAgents = new Map<string, SubAgentState>()
      for (const [k, sa] of state.subAgents) {
        if (sa.state === 'running') {
          subAgents.set(k, sa)
        } else {
          subAgents.set(k, { ...sa, pendingPreamble: null })
        }
      }
      // At turn_end, pass the up-to-date subAgents map (built above) so
      // narrativeTransitionFromActive can see which sub-agents are still
      // running. Active narratives that dispatched background sub-agents
      // become `awaiting-subagent`; the rest become `done` (#324).
      const narratives = state.narratives.map(n =>
        n.state === 'active' ? narrativeTransitionFromActive(n, subAgents) : n,
      )
      return {
        ...state,
        items,
        narratives,
        subAgents,
        pendingAgentSpawns: new Map(),
        stage: 'done',
        thinking: false,
        pendingPreamble: null,
      }
    }

    case 'dequeue':
      // No-op — we key off enqueue + turn_end for the turn boundary.
      return state
  }
}

// ─── Renderer ───────────────────────────────────────────────────────────────

const STEP_DONE = '●'
const STEP_ACTIVE = '◉'
const STEP_FAILED = '✗'
const STEP_PENDING = '○'

const TOOL_SYMBOL: Record<ItemState, string> = {
  pending: STEP_PENDING,
  running: STEP_ACTIVE,
  done: STEP_DONE,
  failed: STEP_FAILED,
}

/**
 * Max checklist lines to render inline. Older completed items collapse
 * into a synthetic "(+N more earlier steps)" rollup line so the card
 * stays compact during long turns. Chosen to fit comfortably on a
 * mobile Telegram screen without scroll.
 */
const MAX_VISIBLE_ITEMS = 5

// Re-export the shared formatters so existing callers (and the test
// file `tests/progress-card.test.ts`) keep working. The implementation
// lives in `./card-format.js` — see issue #94.
export const formatDuration = sharedFormatDuration
const escapeHtml = sharedEscapeHtml
const truncate = sharedTruncate

/**
 * Strip the `<channel …>` XML wrapper (if present) from the enqueue raw
 * content, returning the plain user message text.
 */
function extractUserText(raw: string): string {
  // The enqueue raw content typically looks like:
  //   <channel source="switchroom-telegram" chat_id="…" …>USER TEXT</channel>
  const m = raw.match(/<channel[^>]*>([\s\S]*?)<\/channel>/)
  const body = m ? m[1] : raw
  return body.trim()
}

/**
 * Render a single checklist line body: tool name + a short label hint.
 *
 * Format: `<code>tool</code> <code>label</code>` — both tool name and
 * target argument use fixed-width formatting for scanability on mobile
 * narrow screens. The sub-agent `Agent` tool uses a colon separator
 * ("Agent: <description>") because the description is a phrase, not a
 * filename.
 *
 * `running` items bold the tool name so the eye jumps to the line that's
 * currently in flight.
 */
function renderItemCore(
  tool: string,
  label: string,
  bold = false,
  humanAuthored = false,
): string {
  // MCP tools: the label from toolLabel() already begins with a
  // prettified "Server: action" form (from mcpBaseLabel), so echoing
  // the raw `mcp__server__action` tool name as a prefix just duplicates
  // the friendly name. Render the label alone. If label is empty
  // (malformed mcp__ name, no input keys to preview), fall through so
  // the raw tool name still appears rather than rendering nothing.
  //
  // humanAuthored: Bash/BashOutput/Task/Agent tool_use items whose label
  // came from input.description (a human-written phrase) rather than a
  // raw command / fallback. Suppress the tool-name prefix for the same
  // reason as MCP tools — the description is already self-explanatory.
  if ((tool.startsWith('mcp__') || humanAuthored) && label) {
    return bold ? `<b>${escapeHtml(label)}</b>` : escapeHtml(label)
  }
  const toolHtml = bold ? `<b><code>${escapeHtml(tool)}</code></b>` : `<code>${escapeHtml(tool)}</code>`
  if (!label) return toolHtml
  const separator = tool === 'Agent' || tool === 'Task' ? ': ' : ' '
  return `${toolHtml}${separator}<code>${escapeHtml(label)}</code>`
}

/**
 * Cap the visible checklist at MAX_VISIBLE_ITEMS. When more items exist,
 * the OLDEST completed items collapse into a "(+N more earlier steps)"
 * synthetic line rendered by render(); any still-running item is always
 * kept visible, even if that means pushing the visible tail beyond the cap.
 *
 * Exported for tests.
 */
export function applyVisibleCap(
  items: ReadonlyArray<RolledItem>,
): { items: RolledItem[]; overflowCount: number } {
  if (items.length <= MAX_VISIBLE_ITEMS) {
    return { items: items.slice(), overflowCount: 0 }
  }
  // Take the last N; anything before that is collapsed. Running items
  // tend to be at the tail (new tool_use appends), so this naturally
  // keeps them visible.
  const tail = items.slice(items.length - MAX_VISIBLE_ITEMS)
  const dropped = items.length - tail.length
  // Count the dropped items by their underlying `count` when rolled up,
  // so a collapsed "Read ×6" contributes 6 to the overflow count rather
  // than 1. Gives the user a meaningful "+N" signal.
  let overflow = 0
  for (let i = 0; i < dropped; i++) {
    overflow += items[i].count ?? 1
  }
  return { items: tail, overflowCount: overflow }
}

/**
 * Render the current state to Telegram HTML. `now` is the wall-clock time
 * used for elapsed-time calculations so the render is deterministic in tests.
 *
 * Multi-agent: when `PROGRESS_CARD_MULTI_AGENT=1` AND there is any sub-agent
 * activity (subAgents non-empty OR pendingAgentSpawns non-empty), the card
 * splits into [Main] / [Sub-agents] sections. Otherwise the layout is
 * byte-identical to the legacy single-section card.
 */
/**
 * Optional task-counter hint passed to render() by the driver when multiple
 * concurrent tasks are active in the same chat (e.g. parallel forum topics).
 * When provided, the header shows "(N/M)" so users can see "task 1 of 2".
 */
export interface TaskNum {
  /** 1-based position of this task among the active tasks. */
  index: number
  /** Total number of currently active tasks in the chat. */
  total: number
}

/**
 * Extra render hints the driver computes per flush. `stuckMs` is the
 * gap between the caller's clock and the last real session event that
 * updated this card. When it crosses STUCK_THRESHOLD_MS (2 min) the
 * renderer inserts a ⚠️ stuck-warning line under the header. Zombie
 * closure (driver `maxIdleMs`) still fires at its configured ceiling —
 * the warning is the earlier, softer signal users see first.
 */
export interface RenderOptions {
  stuckMs?: number
  /**
   * Issue #132: when a turn ends without the agent ever calling
   * `reply` / `stream_reply`, the card should NOT render as "✅ Done"
   * (which the user reads as "agent acknowledged and replied") because
   * no user-visible text was produced. The driver tracks per-chat
   * "did a reply tool fire" and forwards the answer here so the
   * renderer can distinguish the silent-end case.
   *
   * When true and the turn is terminal, the header swaps to
   * "🙊 Ended without reply" with a hint line suggesting `/restart` or
   * a rephrase. Has no effect while the turn is still running.
   */
  silentEnd?: boolean
  /**
   * Issue #137: the agent DID call `reply` / `stream_reply` this turn
   * but no outbound message ever actually landed in the chat
   * (recordOutboundDelivered was never called for the card). Distinct
   * from silentEnd because the agent tried — the failure is in the
   * delivery layer (MCP bridge instability, dropped streams, etc.),
   * not the model going mute.
   *
   * Mutually exclusive with silentEnd at the driver layer (replyNot-
   * Delivered requires replyToolCalled=true; silentEnd requires it
   * false), but the renderer guards with `!silentEnd` to be safe.
   * When true and the turn is terminal, the header swaps to
   * "⚠️ Reply attempted but not delivered".
   */
  replyNotDelivered?: boolean
  /**
   * Gap 8 (decoupled render and unpin): when true, the parent turn has
   * ended (turn_end received) but sub-agents are still running. The
   * renderer shows "✅ Done" in the parent header immediately rather than
   * "⚙️ Working…", while sub-agent rows still show their running state.
   * Distinct from `silentEnd` / `replyNotDelivered` — those apply only
   * on true terminal state. This flag applies during the deferred-unpin
   * window.
   */
  parentDone?: boolean
  /**
   * Gap 8 (stalled forced close): when true, the deferred-completion
   * timeout fired (sub-agents never reported done). Render a "stalled"
   * header rather than "✅ Done" to signal forced closure.
   */
  stalledClose?: boolean
}

/**
 * Below this age the renderer treats the card as "fresh" and hides the
 * stuck-warning entirely. The 120s cutoff matches the spec in
 * `docs/pinned-progress-card-reliability.md` §5 F10.
 */
export const STUCK_THRESHOLD_MS = 2 * 60_000

/**
 * Cache entry for a sub-agent's `<blockquote expandable>` section. The
 * driver holds one of these per sub-agent and passes the whole map to
 * render() on each flush. When the sub-agent's `milestoneVersion` hasn't
 * changed, render() reuses the cached HTML instead of re-building it —
 * this prevents the edit from touching the expandable section, so the
 * user's expanded view survives per-tool throttle ticks.
 */
export interface ExpandableCacheEntry {
  milestoneVersion: number
  html: string
}

/** Keyed by agentId. */
export type ExpandableCache = Map<string, ExpandableCacheEntry>

export function render(
  state: ProgressCardState,
  now: number,
  taskNum?: TaskNum,
  opts?: RenderOptions,
  expandableCache?: ExpandableCache,
): string {
  if (state.turnStartedAt === 0) {
    return `${STEP_PENDING} Waiting…`
  }

  // Header line — rendered OUTSIDE the blockquote so it anchors the card
  // above the indented body. The header carries the status icon, elapsed
  // time, and task counter; everything after it is body content.
  const headerLines: string[] = []
  // Body lines — will be wrapped in <blockquote> below.
  const bodyLines: string[] = []

  const elapsed = formatDuration(now - state.turnStartedAt)
  // "Truly done" = parent turn_end fired AND no sub-agents of any kind
  // are still visibly running. `hasAnyRunningSubAgent` includes orphan
  // (background) sub-agents so the card stays in "Working…" while they
  // are active — even though orphan sub-agents no longer gate the defer
  // for pin-lifecycle purposes (#31/#43 fix).
  const trulyDone = state.stage === 'done' && !hasAnyRunningSubAgent(state)
  const silentEnd = trulyDone && opts?.silentEnd === true
  const replyNotDelivered = trulyDone && !silentEnd && opts?.replyNotDelivered === true
  // Gap 8: parentDone is set when parent turn_end fired but sub-agents are still
  // running (deferred-unpin window). Show ✅ Done header immediately without
  // waiting for sub-agents. stalledClose takes precedence — forced timeout close.
  // stalledClose is allowed even when trulyDone=true (the stalled-close flush
  // may run after sub-agents are explicitly marked done for cleanup purposes).
  const parentDone = !trulyDone && opts?.parentDone === true
  const stalledClose = opts?.stalledClose === true
  let headerIcon: string
  let headerLabel: string
  if (stalledClose) {
    // stalledClose takes priority over all other headers — it's an explicit
    // forced-close signal that overrides silentEnd/replyNotDelivered/trulyDone.
    // The driver marks sub-agents done before the final flush so trulyDone=true,
    // but we still want the stalled header to show.
    headerIcon = '⚠️'
    headerLabel = 'Stalled — forced close'
  } else if (silentEnd) {
    headerIcon = '🙊'
    headerLabel = 'Ended without reply'
  } else if (replyNotDelivered) {
    headerIcon = '⚠️'
    headerLabel = 'Reply attempted but not delivered'
  } else if (trulyDone) {
    headerIcon = '✅'
    headerLabel = 'Done'
  } else if (parentDone) {
    headerIcon = '✅'
    headerLabel = 'Done'
  } else {
    headerIcon = '⚙️'
    headerLabel = 'Working…'
  }
  const taskSuffix = taskNum && taskNum.total > 1 ? ` (${taskNum.index}/${taskNum.total})` : ''
  headerLines.push(`${headerIcon} <b>${headerLabel}${taskSuffix}</b> · ⏱ ${elapsed}`)

  // (#156) The user's request used to render here as an inline
  // <blockquote>. That was a styled element only — Telegram clients
  // don't deep-link inline HTML quotes. The progress card now sets
  // reply_parameters.message_id on the initial sendMessage so Telegram
  // shows its native, tappable reply banner above the card instead.

  if (silentEnd) {
    // Diagnostic hint shown only on silent-end turns. Distinct from the
    // "stuck" warning (which fires while the turn is still active) — this
    // tells the user what happened and what to try next.
    bodyLines.push(
      `<i>⚠️ Agent ran tools but didn't send a reply. Try /restart or rephrase your message.</i>`,
    )
  } else if (replyNotDelivered) {
    // Issue #137: the agent called the reply tool but the actual outbound
    // never landed — likely an MCP bridge stream tear-down between
    // tool-acceptance and final flush. Different remediation than
    // silent-end: a /restart is more likely to recover than a rephrase.
    bodyLines.push(
      `<i>⚠️ Reply tool was called but the message never delivered. Try /restart — likely a transient bridge issue.</i>`,
    )
  }

  // Stuck-warning: after 2 min of no session events the card is likely
  // orphaned or the sub-agent is in a long-running silent tool call.
  // Surface the gap early so users aren't left guessing until the 5-min
  // zombie ceiling force-closes. Suppressed when the parent is done
  // (trulyDone, parentDone, or stalledClose) — showing "stuck" after
  // the parent has already acknowledged completion is confusing.
  if (
    !trulyDone &&
    !parentDone &&
    !stalledClose &&
    opts?.stuckMs != null &&
    opts.stuckMs >= STUCK_THRESHOLD_MS
  ) {
    const gap = formatDuration(opts.stuckMs)
    bodyLines.push(`⚠️ <i>No events for ${gap} — likely stuck.</i>`)
  }

  const multiAgentActive =
    isMultiAgentEnabled() &&
    (state.subAgents.size > 0 || state.pendingAgentSpawns.size > 0)

  const hasNarratives = state.narratives.length > 0

  if (hasNarratives) {
    bodyLines.push('')
    renderNarrativeChecklist(state.narratives, now, bodyLines)
  } else if (state.items.length > 0) {
    bodyLines.push('')
    if (multiAgentActive) {
      bodyLines.push(`[<u>Main</u> · <u>${state.items.length} tools</u>]`)
    }
    const compacted = compactItems(state.items)
    const visible = applyVisibleCap(compacted)
    if (visible.overflowCount > 0) {
      bodyLines.push(`<i>(+${visible.overflowCount} earlier)</i>`)
    }
    for (const item of visible.items) {
      bodyLines.push(renderMainItem(item, now, multiAgentActive, state.subAgents))
    }
  }

  if (state.stage !== 'done') {
    if (state.thinking) {
      bodyLines.push('')
      bodyLines.push(`${STEP_ACTIVE} <i>Thinking…</i>`)
    } else if (!hasNarratives && state.latestText) {
      bodyLines.push('')
      bodyLines.push(`💭 <i>${escapeHtml(truncate(state.latestText.trim(), 160))}</i>`)
    }
  }

  // Build the main card: header + body (no blockquote wrapper).
  const bodyText = bodyLines.join('\n').trimStart()
  const mainCard = bodyText
    ? `${headerLines.join('\n')}\n${bodyText}`
    : headerLines.join('\n')

  // Sub-agent expandable sections — one <blockquote expandable> per agent,
  // appended after the main </blockquote>. Each section is independently
  // expandable by the user. To avoid re-collapsing the user's expanded view
  // on every throttle tick, we only re-render a section when the agent's
  // milestoneVersion has changed (start / finish / fail). Per-tool ticks
  // don't bump milestoneVersion, so the expandable HTML is reused as-is.
  //
  // Issue #352: prepend an always-visible summary header before the per-agent
  // expandable blocks so the user sees status counts at a glance.
  const expandableParts: string[] = []
  if (multiAgentActive && state.subAgents.size > 0) {
    const counts = countSubAgentStates(state.subAgents, now)
    expandableParts.push('')
    expandableParts.push(renderSubAgentSummaryHeader(counts))
    for (const sa of sortSubAgentsChrono(state.subAgents)) {
      const cached = expandableCache?.get(sa.agentId)
      let expandableHtml: string
      if (cached && cached.milestoneVersion === sa.milestoneVersion) {
        // Milestone unchanged — reuse cached HTML to preserve user's
        // expanded/collapsed state across throttle-tick edits.
        expandableHtml = cached.html
      } else {
        expandableHtml = renderSubAgentExpandable(sa, now, trulyDone)
        // Update the cache entry so the driver can persist it.
        if (expandableCache) {
          expandableCache.set(sa.agentId, {
            milestoneVersion: sa.milestoneVersion,
            html: expandableHtml,
          })
        }
      }
      expandableParts.push(expandableHtml)
    }
  }

  const parts = [mainCard, ...expandableParts]
  return parts.join('\n')
}

function renderNarrativeChecklist(
  narratives: ReadonlyArray<NarrativeStep>,
  now: number,
  lines: string[],
): void {
  if (narratives.length > MAX_VISIBLE_ITEMS) {
    const overflow = narratives.length - MAX_VISIBLE_ITEMS
    lines.push(`<i>(+${overflow} earlier)</i>`)
  }
  const visible = narratives.slice(-MAX_VISIBLE_ITEMS)
  for (const step of visible) {
    if (step.state === 'active' || step.state === 'awaiting-subagent') {
      const age = now - step.startedAt
      const dur = formatDuration(age)
      // When an active (or awaiting-subagent) narrative is older than the
      // stuck threshold, the "No events for X" banner will already be rendered
      // above. A confidently-bolded narrative with a ticking age next to it
      // sends mixed signals ("stuck" vs "actively working on X"). De-emphasise
      // the narrative to italic with a `stale` marker so the signals agree:
      // the last announced step, not necessarily what's running right now.
      if (age > STUCK_THRESHOLD_MS) {
        lines.push(`${STEP_ACTIVE} <i>${escapeHtml(step.text)} · stale (${dur})</i>`)
      } else {
        lines.push(`${STEP_ACTIVE} <b>${escapeHtml(step.text)}</b> <i>(${dur})</i>`)
      }
    } else {
      // #320: drop the <s>...</s> wrap on done items. Telegram desktop
      // renders strikethrough with a salmon/red strike-line in both
      // light and dark themes — users read it as "deleted/failed/error",
      // not "done". The leading STEP_DONE bullet (●) + the symbol
      // distinction (vs ◉ for active) + bold-vs-plain weight already
      // signal completion without the alarm. See #320 Option A.
      lines.push(`${STEP_DONE} ${escapeHtml(step.text)}`)
    }
  }
}

/**
 * Render one [Main]-section line. Encapsulates the existing per-state
 * branches (running/rollup/done) so the main render() loop reads cleanly.
 *
 * Multi-agent twist (Ken locked-in #4): an `Agent`/`Task` item with a
 * correlated, still-running sub-agent stays in the 🤖 emoji even if its
 * own state field already happens to be 'running' — and we DON'T flip it
 * to ✅ on a tentative `sub_agent_turn_end`. Only the parent's own
 * tool_result (which mutates `item.state` to 'done'/'failed') flips it.
 */
function renderMainItem(
  item: RolledItem,
  now: number,
  multiAgentActive: boolean,
  subAgents: ReadonlyMap<string, SubAgentState>,
): string {
  const isAgent = item.tool === 'Agent' || item.tool === 'Task'
  const indent = multiAgentActive ? '  ' : ''

  const humanAuthored = item.humanAuthored ?? false

  if (isAgent && item.state === 'running' && multiAgentActive) {
    // Hold the 🤖 emoji while the sub-agent (if correlated) is alive.
    // Show elapsed since the parent's tool_use fired.
    const dur = formatDuration(now - item.startedAt)
    return `${indent}🤖 ${renderItemCore(item.tool, item.label, /*bold*/ true, humanAuthored)} <i>(${dur})</i>`
  }

  const symbol = TOOL_SYMBOL[item.state]
  if (item.state === 'running') {
    const dur = formatDuration(now - item.startedAt)
    return `${indent}${symbol} ${renderItemCore(item.tool, item.label, /*bold*/ true, humanAuthored)} <i>(${dur})</i>`
  }
  if ((item.state === 'done' || item.state === 'failed') && item.finishedAt != null) {
    if (item.kind === 'rollup') {
      const labelHtml = item.label ? ` ${escapeHtml(item.label)}` : ''
      return `${indent}${symbol} ${escapeHtml(item.tool)}${labelHtml} <i>×${item.count}</i>`
    }
    const dur = formatDuration(item.finishedAt - item.startedAt)
    const needsDuration = item.finishedAt - item.startedAt >= 1000
    // #320: no <s> wrap on done items here either. The symbol
    // distinction (● vs ◉) + the bold-vs-plain treatment already
    // differentiate done from active; strikethrough renders red in
    // Telegram desktop and reads as "deleted/failed". See #320
    // Option A — this aligns the rolled-card path with the
    // narrative-checklist + sub-agent-expandable paths now that all
    // three drop strikethrough.
    return `${indent}${symbol} ${renderItemCore(item.tool, item.label, false, humanAuthored)}${needsDuration ? ` <i>(${dur})</i>` : ''}`
  }
  void subAgents
  return `${indent}${symbol} ${renderItemCore(item.tool, item.label, false, humanAuthored)}`
}

/**
 * Sort sub-agents by chronological start time — oldest first (Ken
 * locked-in #1). Stable across renders so rows don't shuffle as states
 * transition. We deliberately do NOT bucket by state (failed-first /
 * done-first) because state changes mid-turn would cause visible
 * reorder.
 */
function sortSubAgentsChrono(
  subAgents: ReadonlyMap<string, SubAgentState>,
): SubAgentState[] {
  return Array.from(subAgents.values()).sort((a, b) => a.startedAt - b.startedAt)
}

/** Stall threshold: sub-agent is ⚠️ stalled if running with no events for this long. */
const SUBAGENT_STALL_MS = 60_000

interface SubAgentCounts {
  running: number
  done: number
  failed: number
  stalled: number
}

function countSubAgentStates(
  subAgents: ReadonlyMap<string, SubAgentState>,
  now: number,
): SubAgentCounts {
  let running = 0
  let done = 0
  let failed = 0
  let stalled = 0
  for (const sa of subAgents.values()) {
    if (sa.state === 'running') {
      const isStalled = sa.lastEventAt != null && (now - sa.lastEventAt) >= SUBAGENT_STALL_MS
      if (isStalled) stalled++
      else running++
    } else if (sa.state === 'done') done++
    else if (sa.state === 'failed') failed++
  }
  return { running, done, failed, stalled }
}

/**
 * Issue #352: always-visible summary header above per-agent expandables.
 * Format: `🤖 Sub-agents · ✅ N · 🔄 N · ❌ N · ⚠️ N`
 * Omits any emoji whose count is 0.
 * When all running (no done/failed/stalled): `🤖 Sub-agents · 🔄 N`
 */
function renderSubAgentSummaryHeader(c: SubAgentCounts): string {
  const parts: string[] = []
  if (c.done > 0) parts.push(`✅ ${c.done}`)
  if (c.running > 0) parts.push(`🔄 ${c.running}`)
  if (c.failed > 0) parts.push(`❌ ${c.failed}`)
  if (c.stalled > 0) parts.push(`⚠️ ${c.stalled}`)
  const counters = parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
  return `<b><u>🤖 Sub-agents</u></b>${counters}`
}

/**
 * Render a sub-agent block. Two lines while running (header + current
 * activity), one line when done/failed (compact summary).
 *
 * Header line includes:
 *  - state emoji (🤖 running, ✅ done, ❌ failed)
 *  - description (or '(uncorrelated)' for orphans)
 *  - subagent_type after a ` · ` separator (Ken locked-in #2 — always show)
 *  - elapsed time
 *  - `(spawned N)` suffix when nestedSpawnCount > 0 (Ken locked-in #3)
 *
 * The `forceCollapse` arg is set on `turn_end` (Ken locked-in #5) so the
 * archived card never carries the running two-line shape.
 */
/**
 * Description fallback chain for a sub-agent, in priority order:
 *   1. correlated description (from parent Agent/Task tool_use input)
 *   2. subagentType (when correlation failed but the sub-agent type is known)
 *   3. first narrative text the sub-agent emitted
 *   4. generic 'sub-agent'
 * "(uncorrelated)" is a debug-log string and never appears in this chain —
 * surfacing that to the user was the original UX bug.
 */
function subAgentDisplayDescription(sa: SubAgentState): string {
  if (sa.description && sa.description.length > 0 && sa.description !== '(uncorrelated)') {
    return sa.description
  }
  if (sa.subagentType && sa.subagentType.length > 0) {
    return sa.subagentType
  }
  if (sa.firstNarrativeText && sa.firstNarrativeText.length > 0) {
    // Extract first line, cap length — same shape as toolLabel preambles.
    const line = sa.firstNarrativeText.split('\n')[0].trim()
    if (line.length > 0) return line
  }
  return 'sub-agent'
}

/**
 * Issue #352: Render a sub-agent as a `<blockquote expandable>` section.
 *
 * Collapsed header (always visible):
 *   🤖 <description> <status-emoji> <state-label> · <duration>
 *
 * Inside the expandable: last 2-3 recent actions.
 *   - Completed actions: `<s>action label</s>` (strikethrough)
 *   - Current in-flight action: `↳ action label` (no strikethrough)
 *
 * Status emoji: 🔄 working · ✅ done · ❌ failed · ⚠️ stalled
 *
 * The `forceCollapse` arg is set on `turn_end` so the archived card renders
 * the done/failed state. The `📂 #<agentId>` hash is intentionally dropped
 * per issue #352 (meaningless to humans; was the old UX bug).
 *
 * Only called on milestone transitions (start/finish/fail) via the
 * milestoneVersion gate in render(). Per-tool ticks reuse the cached HTML so
 * the user's expanded/collapsed state is not disturbed.
 */
function renderSubAgentExpandable(
  sa: SubAgentState,
  now: number,
  forceCollapse: boolean,
): string {
  const desc = subAgentDisplayDescription(sa)
  const truncDesc = truncate(desc, 60)

  // Status emoji + label for the collapsed header line.
  let statusEmoji: string
  let statusLabel: string
  const end = sa.finishedAt ?? now
  const elapsed = formatDuration(end - sa.startedAt)
  const isStalled = sa.state === 'running'
    && sa.lastEventAt != null
    && (now - sa.lastEventAt) >= SUBAGENT_STALL_MS

  if (sa.state === 'failed') {
    statusEmoji = '❌'
    statusLabel = 'failed'
  } else if (sa.state === 'done' || forceCollapse) {
    statusEmoji = '✅'
    statusLabel = 'done'
  } else if (isStalled) {
    statusEmoji = '⚠️'
    statusLabel = 'stalled'
  } else {
    statusEmoji = '🔄'
    statusLabel = 'working'
  }

  // Collapsed header: 🤖 <description> <status> · <duration>
  const headerLine = `🤖 <b>${escapeHtml(truncDesc)}</b>  ${statusEmoji} ${statusLabel} · ${elapsed}`

  // ── Inner body: last 2-3 recent actions ─────────────────────────────────
  const innerLines: string[] = []

  if (sa.state !== 'running' || forceCollapse) {
    // Terminal state: show last completed tool as a result summary line,
    // falling back to the tool count when no completed tool is tracked.
    if (sa.lastCompletedTool) {
      const last = sa.lastCompletedTool
      innerLines.push(`↳ ${renderItemCore(last.tool, last.label, false, last.humanAuthored)}`)
    } else {
      innerLines.push(`↳ ${sa.toolCount} tool${sa.toolCount !== 1 ? 's' : ''} completed`)
    }
  } else {
    // Running state: show recent completed actions + current (↳).
    //
    // `recentCompletedTools` holds up to 2 previously completed tools.
    // `currentTool` is the in-flight tool (shown with ↳).
    // Together they give up to 3 action lines per the spec.
    //
    // #320: no <s> wrap on completed actions here. The active line is
    // distinguished by its `↳` prefix; the recent-completed lines have
    // no prefix. Strikethrough adds a salmon/red line that reads as
    // "deleted/failed" rather than "done" — drop it for visual calm.
    const recent = sa.recentCompletedTools ?? []
    for (const t of recent) {
      // renderItemCore returns HTML (with <code> tags) — do NOT re-escape it.
      innerLines.push(renderItemCore(t.tool, t.label, false, t.humanAuthored))
    }

    if (sa.currentTool) {
      const cur = sa.currentTool
      innerLines.push(`↳ ${renderItemCore(cur.tool, cur.label, false, cur.humanAuthored)}`)
    } else if (sa.currentNarrative && sa.currentNarrative.length > 0) {
      // Issue #305 Option A: MCP-pushed narrative wins over pendingPreamble
      // when both are set — it's an explicit "tell the user this now" call.
      innerLines.push(`↳ <i>${escapeHtml(truncate(sa.currentNarrative, 200))}</i>`)
    } else if (sa.pendingPreamble && sa.pendingPreamble.length > 0) {
      const preambleLine = sa.pendingPreamble.split('\n')[0].trim()
      if (preambleLine.length > 0) {
        innerLines.push(`↳ <i>${escapeHtml(truncate(preambleLine, 80))}</i>`)
      }
    } else if (sa.lastCompletedTool) {
      // Between tools: show the last completed tool without strikethrough
      // (it's the most recent action and the agent is about to do something).
      const last = sa.lastCompletedTool
      innerLines.push(`↳ <i>just finished</i> ${renderItemCore(last.tool, last.label, false, last.humanAuthored)}`)
    } else {
      innerLines.push(`↳ <i>starting…</i>`)
    }
  }

  const innerBody = innerLines.join('\n')
  return `<blockquote expandable>${headerLine}\n${innerBody}</blockquote>`
}

/**
 * Collapse runs of consecutive identical tools (e.g. a slurry of Reads)
 * into a single rollup item "<tool> [label] ×N". Two thresholds apply:
 *
 * - ROLLUP_THRESHOLD (2): identical tool + identical label → collapses to
 *   "<tool> <label> ×N", preserving the shared label in the rollup so the
 *   user can still see "Read foo.ts ×3" instead of three identical lines.
 *
 * - MIXED_ROLLUP_THRESHOLD (3): identical tool, differing labels → collapses
 *   to "<tool> ×N" (no label) when there are 3+ items. The label is dropped
 *   because there is no single representative value, and showing one
 *   arbitrarily would be misleading. Users see "Read ×4" (heuristic summary).
 *
 * Partial runs (any item still running) are never collapsed — the running
 * item is always shown individually so the user can see live progress.
 *
 * Human-authored items are never collapsed into a bare "Tool ×N" rollup (#41).
 * When any item in the run has `humanAuthored=true`, each is rendered
 * individually so the agent's natural-language descriptions remain visible.
 */
interface RolledItem extends ChecklistItem {
  readonly kind?: 'single' | 'rollup'
  readonly count?: number
}

/** Minimum run length to collapse same-tool + same-label items. */
const ROLLUP_THRESHOLD = 2
/** Minimum run length to collapse same-tool, mixed-label items (C1 heuristic). */
const MIXED_ROLLUP_THRESHOLD = 3

// Exported for tests.
export function compactItems(items: ReadonlyArray<ChecklistItem>): RolledItem[] {
  const out: RolledItem[] = []
  let run: ChecklistItem[] = []

  const flush = (): void => {
    if (run.length === 0) return
    const first = run[0]
    const last = run[run.length - 1]
    const allDone = run.every((r) => r.state === 'done')
    const sameLabel = run.every((r) => r.label === first.label)
    // Never collapse a run that contains any human-authored item (#41 fix).
    // Descriptions written by the agent ("Check commit state", "Run tests")
    // are valuable context — collapsing them into "Bash ×N" discards that
    // signal. Each human-authored item must appear as its own line.
    const anyHumanAuthored = run.some((r) => r.humanAuthored)

    if (allDone && !anyHumanAuthored && sameLabel && run.length >= ROLLUP_THRESHOLD) {
      // B3 + B1: identical tool + identical label → rollup keeping the label
      out.push({
        id: first.id,
        toolUseId: null,
        tool: first.tool,
        label: first.label,
        humanAuthored: first.humanAuthored,
        state: 'done',
        startedAt: first.startedAt,
        finishedAt: last.finishedAt,
        kind: 'rollup',
        count: run.length,
      })
    } else if (allDone && !anyHumanAuthored && !sameLabel && run.length >= MIXED_ROLLUP_THRESHOLD) {
      // C1: same tool, mixed labels, no human-authored → rollup without label
      out.push({
        id: first.id,
        toolUseId: null,
        tool: first.tool,
        label: '',
        humanAuthored: false,
        state: 'done',
        startedAt: first.startedAt,
        finishedAt: last.finishedAt,
        kind: 'rollup',
        count: run.length,
      })
    } else {
      for (const r of run) out.push({ ...r, kind: 'single' })
    }
    run = []
  }

  for (const it of items) {
    if (run.length > 0 && run[run.length - 1].tool === it.tool) {
      run.push(it)
    } else {
      flush()
      run = [it]
    }
  }
  flush()
  return out
}
