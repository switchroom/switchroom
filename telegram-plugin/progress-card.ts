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
import { toolLabel } from './tool-labels.js'

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
   * The first user-message text from the sub-agent's JSONL — kept so the
   * reverse-race adoption path (orphan first, parent later) can match
   * against incoming pendingAgentSpawns entries.
   */
  readonly firstPromptText?: string
  readonly currentTool?: {
    readonly tool: string
    readonly label: string
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
   * The tool most recently completed by this sub-agent. Captured on
   * `sub_agent_tool_result` (before the toolUseId match clears
   * `currentTool`). Used by the render fallback chain when the sub-agent
   * is running-but-between-tools so we show the last thing it did rather
   * than the bare "(idle)" string.
   */
  readonly lastCompletedTool?: {
    readonly tool: string
    readonly label: string
    readonly finishedAt: number
  }
  /** Sub-sub-agents observed (rendered as `(spawned N)` only, not as rows). */
  readonly nestedSpawnCount: number
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
  readonly state: 'done' | 'active'
  readonly startedAt: number
  readonly toolCount: number
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
 * True when any sub-agent in the state is still running. Parent turn_end
 * no longer closes running sub-agents (they may outlive the parent turn
 * for background Agent calls), so the driver uses this gate to decide
 * whether to close the card now or defer until the last sub-agent lands
 * its own `sub_agent_turn_end`.
 */
export function hasInFlightSubAgents(state: ProgressCardState): boolean {
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
        n.state === 'active' ? { ...n, state: 'done' as const } : n,
      )
      const newNarrative: NarrativeStep = {
        id: prevNarratives.length,
        text: label,
        state: 'active',
        startedAt: now,
        toolCount: 0,
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
          narratives = [...narratives.slice(0, -1), { ...last, toolCount: last.toolCount + 1 }]
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
      const nextState: ItemState = event.isError === true ? 'failed' : 'done'
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
            next.set(agentId, { ...sa, state: nextState, finishedAt: now })
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
      }
      const subAgents = new Map(state.subAgents)
      subAgents.set(event.agentId, sub)
      process.stderr.write(`telegram gateway: progress-card: sub_agent_started agentId=${event.agentId} correlated=${parentToolUseId != null ? 'yes' : 'orphan'}${parentToolUseId != null ? ` parentToolUseId=${parentToolUseId}` : ''}\n`)
      return { ...state, subAgents, pendingAgentSpawns, items }
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
        toolCount: sa.toolCount + 1,
        currentTool: event.toolUseId
          ? {
              tool: event.toolName,
              label: toolLabel(event.toolName, event.input, preamble),
              toolUseId: event.toolUseId,
              startedAt: now,
            }
          : sa.currentTool,
        pendingPreamble: null,
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
      // while the sub-agent thinks between tools.
      if (sa.currentTool && sa.currentTool.toolUseId === event.toolUseId) {
        const justFinished = {
          tool: sa.currentTool.tool,
          label: sa.currentTool.label,
          finishedAt: now,
        }
        const next = new Map(state.subAgents)
        next.set(event.agentId, {
          ...sa,
          currentTool: undefined,
          lastCompletedTool: justFinished,
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
      const next = new Map(state.subAgents)
      next.set(event.agentId, { ...sa, state: 'done', finishedAt: now, pendingPreamble: null })
      return { ...state, subAgents: next }
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
      const narratives = state.narratives.map(n =>
        n.state === 'active' ? { ...n, state: 'done' as const } : n,
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `00:${s.toString().padStart(2, '0')}`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

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
 * Format: `<tool> <label>` (space-separated, no code-span wrapping) so the
 * line reads like a natural sentence — "Read MANIFEST.md", "Grep "foo" (in
 * src/)", "Bash git status". The sub-agent `Agent` tool uses a colon
 * separator ("Agent: <description>") because the description tends to be
 * a full phrase, not a filename.
 *
 * `running` items bold the tool name so the eye jumps to the line that's
 * currently in flight.
 */
function renderItemCore(tool: string, label: string, bold = false): string {
  // MCP tools: the label from toolLabel() already begins with a
  // prettified "Server: action" form (from mcpBaseLabel), so echoing
  // the raw `mcp__server__action` tool name as a prefix just duplicates
  // the friendly name. Render the label alone. If label is empty
  // (malformed mcp__ name, no input keys to preview), fall through so
  // the raw tool name still appears rather than rendering nothing.
  if (tool.startsWith('mcp__') && label) {
    return bold ? `<b>${escapeHtml(label)}</b>` : escapeHtml(label)
  }
  const toolHtml = bold ? `<b>${escapeHtml(tool)}</b>` : escapeHtml(tool)
  if (!label) return toolHtml
  const separator = tool === 'Agent' || tool === 'Task' ? ': ' : ' '
  return `${toolHtml}${separator}${escapeHtml(label)}`
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
}

/**
 * Below this age the renderer treats the card as "fresh" and hides the
 * stuck-warning entirely. The 120s cutoff matches the spec in
 * `docs/pinned-progress-card-reliability.md` §5 F10.
 */
export const STUCK_THRESHOLD_MS = 2 * 60_000

export function render(state: ProgressCardState, now: number, taskNum?: TaskNum, opts?: RenderOptions): string {
  if (state.turnStartedAt === 0) {
    return `${STEP_PENDING} Waiting…`
  }

  const lines: string[] = []

  const elapsed = formatDuration(now - state.turnStartedAt)
  // "Truly done" = parent turn_end fired AND no sub-agents still in
  // flight. While the driver's `pendingCompletion` state is active
  // (background Agent calls outliving parent turn_end), the reducer
  // has already flipped `state.stage` to 'done' but the work isn't
  // actually finished. Show "Working…" + ticking elapsed in that
  // window so users aren't looking at a frozen ✅ card.
  const trulyDone = state.stage === 'done' && !hasInFlightSubAgents(state)
  const headerIcon = trulyDone ? '✅' : '⚙️'
  const headerLabel = trulyDone ? 'Done' : 'Working…'
  const taskSuffix = taskNum && taskNum.total > 1 ? ` (${taskNum.index}/${taskNum.total})` : ''
  lines.push(`${headerIcon} <b>${headerLabel}${taskSuffix}</b> · ⏱ ${elapsed}`)

  if (state.userRequest) {
    lines.push(`<blockquote>${escapeHtml(truncate(state.userRequest, 120))}</blockquote>`)
  }

  // Stuck-warning: after 2 min of no session events the card is likely
  // orphaned or the sub-agent is in a long-running silent tool call.
  // Surface the gap early so users aren't left guessing until the 5-min
  // zombie ceiling force-closes. Suppressed only on TRUE done — during
  // the deferred-completion window (parent done, sub-agents still
  // running silently) the warning is still the correct signal.
  if (
    !trulyDone &&
    opts?.stuckMs != null &&
    opts.stuckMs >= STUCK_THRESHOLD_MS
  ) {
    const gap = formatDuration(opts.stuckMs)
    lines.push(`⚠️ <i>No events for ${gap} — likely stuck.</i>`)
  }

  const multiAgentActive =
    isMultiAgentEnabled() &&
    (state.subAgents.size > 0 || state.pendingAgentSpawns.size > 0)

  const hasNarratives = state.narratives.length > 0

  if (hasNarratives) {
    lines.push('')
    renderNarrativeChecklist(state.narratives, now, lines)
  } else if (state.items.length > 0) {
    lines.push('')
    if (multiAgentActive) {
      lines.push(`[Main · ${state.items.length} tools]`)
    }
    const compacted = compactItems(state.items)
    const visible = applyVisibleCap(compacted)
    if (visible.overflowCount > 0) {
      lines.push(`<i>(+${visible.overflowCount} earlier)</i>`)
    }
    for (const item of visible.items) {
      lines.push(renderMainItem(item, now, multiAgentActive, state.subAgents))
    }
  }

  if (multiAgentActive && state.subAgents.size > 0) {
    lines.push('')
    const counts = countSubAgentStates(state.subAgents)
    lines.push(`[Sub-agents · ${formatSubAgentCounts(counts)}]`)
    for (const sa of sortSubAgentsChrono(state.subAgents)) {
      // forceCollapse only when TRULY done — during deferred-completion
      // (parent ended but sub-agents still running), keep running
      // sub-agents in the two-line running block so their ticking
      // elapsed-time stays visible. When trulyDone is reached the
      // reducer has already marked every sub-agent as done/failed, so
      // this arg is effectively moot in that branch.
      for (const l of renderSubAgent(sa, now, trulyDone)) {
        lines.push(l)
      }
    }
  }

  if (state.stage !== 'done') {
    if (state.thinking) {
      lines.push('')
      lines.push(`${STEP_ACTIVE} <i>Thinking…</i>`)
    } else if (!hasNarratives && state.latestText) {
      lines.push('')
      lines.push(`💭 <i>${escapeHtml(truncate(state.latestText.trim(), 160))}</i>`)
    }
  }

  return lines.join('\n')
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
    if (step.state === 'active') {
      const age = now - step.startedAt
      const dur = formatDuration(age)
      // When an active narrative is older than the stuck threshold, the
      // "No events for X" banner will already be rendered above. A
      // confidently-bolded narrative with a ticking age next to it sends
      // mixed signals ("stuck" vs "actively working on X"). De-emphasise
      // the narrative to italic with a `stale` marker so the signals
      // agree: the last announced step, not necessarily what's running
      // right now.
      if (age > STUCK_THRESHOLD_MS) {
        lines.push(`${STEP_ACTIVE} <i>${escapeHtml(step.text)} · stale (${dur})</i>`)
      } else {
        lines.push(`${STEP_ACTIVE} <b>${escapeHtml(step.text)}</b> <i>(${dur})</i>`)
      }
    } else {
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

  if (isAgent && item.state === 'running' && multiAgentActive) {
    // Hold the 🤖 emoji while the sub-agent (if correlated) is alive.
    // Show elapsed since the parent's tool_use fired.
    const dur = formatDuration(now - item.startedAt)
    return `${indent}🤖 ${renderItemCore(item.tool, item.label, /*bold*/ true)} <i>(${dur})</i>`
  }

  const symbol = TOOL_SYMBOL[item.state]
  if (item.state === 'running') {
    const dur = formatDuration(now - item.startedAt)
    return `${indent}${symbol} ${renderItemCore(item.tool, item.label, /*bold*/ true)} <i>(${dur})</i>`
  }
  if ((item.state === 'done' || item.state === 'failed') && item.finishedAt != null) {
    if (item.kind === 'rollup') {
      const labelHtml = item.label ? ` ${escapeHtml(item.label)}` : ''
      return `${indent}${symbol} ${escapeHtml(item.tool)}${labelHtml} <i>×${item.count}</i>`
    }
    const dur = formatDuration(item.finishedAt - item.startedAt)
    const needsDuration = item.finishedAt - item.startedAt >= 1000
    return `${indent}${symbol} ${renderItemCore(item.tool, item.label)}${needsDuration ? ` <i>(${dur})</i>` : ''}`
  }
  void subAgents
  return `${indent}${symbol} ${renderItemCore(item.tool, item.label)}`
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

interface SubAgentCounts {
  running: number
  done: number
  failed: number
}

function countSubAgentStates(
  subAgents: ReadonlyMap<string, SubAgentState>,
): SubAgentCounts {
  let running = 0
  let done = 0
  let failed = 0
  for (const sa of subAgents.values()) {
    if (sa.state === 'running') running++
    else if (sa.state === 'done') done++
    else if (sa.state === 'failed') failed++
  }
  return { running, done, failed }
}

function formatSubAgentCounts(c: SubAgentCounts): string {
  const parts: string[] = []
  if (c.running > 0) parts.push(`${c.running} running`)
  if (c.done > 0) parts.push(`${c.done} done`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  return parts.length === 0 ? '0' : parts.join(', ')
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

function renderSubAgent(
  sa: SubAgentState,
  now: number,
  forceCollapse: boolean,
): string[] {
  const desc = subAgentDisplayDescription(sa)
  // Show subagent type as a suffix only if it's NOT already the display
  // description (i.e. only when we have a real description + a type).
  const typeSuffix = sa.subagentType && sa.subagentType !== desc
    ? ` · ${escapeHtml(sa.subagentType)}`
    : ''
  const spawnedSuffix = sa.nestedSpawnCount > 0
    ? ` <i>(spawned ${sa.nestedSpawnCount})</i>`
    : ''

  if (sa.state !== 'running' || forceCollapse) {
    const symbol = sa.state === 'failed' ? STEP_FAILED : STEP_DONE
    const end = sa.finishedAt ?? now
    const dur = formatDuration(end - sa.startedAt)
    return [
      `  ${symbol} ${escapeHtml(truncate(desc, 50))}${typeSuffix} · ${dur} · ${sa.toolCount} tools${spawnedSuffix}`,
    ]
  }

  // Running: two-line block.
  const elapsed = formatDuration(now - sa.startedAt)
  const headerLine = `  🤖 <b>${escapeHtml(truncate(desc, 50))}</b>${typeSuffix} · ⏱ ${elapsed}${spawnedSuffix}`

  // Activity-line fallback chain — never render the literal "(idle)" string.
  // Priority: currently-executing tool > pending narrative text > last
  // completed tool > generic "thinking..." filler.
  if (sa.currentTool) {
    const cur = sa.currentTool
    const curDur = formatDuration(now - cur.startedAt)
    return [
      headerLine,
      `     └ ${STEP_ACTIVE} ${renderItemCore(cur.tool, cur.label)} <i>(${curDur})</i> · ${sa.toolCount} tools`,
    ]
  }
  if (sa.pendingPreamble && sa.pendingPreamble.length > 0) {
    const preambleLine = sa.pendingPreamble.split('\n')[0].trim()
    if (preambleLine.length > 0) {
      return [
        headerLine,
        `     └ 🤔 <i>${escapeHtml(truncate(preambleLine, 60))}</i> · ${sa.toolCount} tools`,
      ]
    }
  }
  if (sa.lastCompletedTool) {
    const last = sa.lastCompletedTool
    return [
      headerLine,
      `     └ ✓ <i>just finished</i> ${renderItemCore(last.tool, last.label)} · ${sa.toolCount} tools`,
    ]
  }
  return [headerLine, `     └ 💭 <i>thinking…</i> · ${sa.toolCount} tools`]
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

    if (allDone && sameLabel && run.length >= ROLLUP_THRESHOLD) {
      // B3 + B1: identical tool + identical label → rollup keeping the label
      out.push({
        id: first.id,
        toolUseId: null,
        tool: first.tool,
        label: first.label,
        state: 'done',
        startedAt: first.startedAt,
        finishedAt: last.finishedAt,
        kind: 'rollup',
        count: run.length,
      })
    } else if (allDone && !sameLabel && run.length >= MIXED_ROLLUP_THRESHOLD) {
      // C1: same tool, mixed labels → rollup without label (heuristic summary)
      out.push({
        id: first.id,
        toolUseId: null,
        tool: first.tool,
        label: '',
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
