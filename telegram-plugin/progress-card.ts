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

export function initialState(): ProgressCardState {
  return {
    turnStartedAt: 0,
    items: [],
    stage: 'plan',
    thinking: false,
    subAgents: new Map(),
    pendingAgentSpawns: new Map(),
  }
}

/**
 * Single feature flag for the whole multi-agent path. Read once and
 * latched at driver/renderer construction time so toggling mid-process
 * has no half-state risk. Flag OFF = byte-identical legacy behavior; the
 * new state fields stay empty and the renderer ignores them.
 */
export function isMultiAgentEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROGRESS_CARD_MULTI_AGENT === '1'
}

// ─── Reducer ────────────────────────────────────────────────────────────────

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
      // Retain only the most recent text chunk for the thought line.
      return { ...state, latestText: event.text, thinking: false }
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
      const nextItem: ChecklistItem = {
        id: state.items.length,
        toolUseId: event.toolUseId ?? null,
        tool: event.toolName,
        label: toolLabel(event.toolName, event.input),
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
        // null) for a prompt-text match and adopt the FIRST matching one.
        // FIFO disambiguates duplicate-prompt bursts (rare).
        let adopted = false
        for (const [agentId, sa] of subAgents) {
          if (sa.parentToolUseId == null && sa.firstPromptText === promptText) {
            const next = new Map(subAgents)
            next.set(agentId, {
              ...sa,
              parentToolUseId: event.toolUseId,
              description,
              subagentType,
            })
            subAgents = next
            adopted = true
            break
          }
        }
        if (!adopted) {
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
      return {
        ...state,
        items: [...state.items, nextItem],
        stage: 'run',
        thinking: false,
        pendingAgentSpawns,
        subAgents,
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
      return { ...state, subAgents, pendingAgentSpawns, items }
    }

    case 'sub_agent_tool_use': {
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      const next = new Map(state.subAgents)
      next.set(event.agentId, {
        ...sa,
        toolCount: sa.toolCount + 1,
        currentTool: event.toolUseId
          ? {
              tool: event.toolName,
              label: toolLabel(event.toolName, event.input),
              toolUseId: event.toolUseId,
              startedAt: now,
            }
          : sa.currentTool,
      })
      return { ...state, subAgents: next }
    }

    case 'sub_agent_tool_result': {
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      // Per design §3.3: per-tool errors don't fail the agent; only the
      // parent's tool_result does. We just clear currentTool if it
      // matches.
      if (sa.currentTool && sa.currentTool.toolUseId === event.toolUseId) {
        const next = new Map(state.subAgents)
        next.set(event.agentId, { ...sa, currentTool: undefined })
        return { ...state, subAgents: next }
      }
      return state
    }

    case 'sub_agent_turn_end': {
      const sa = state.subAgents.get(event.agentId)
      if (!sa) return state
      // Tentative close: parent's tool_result is still authoritative.
      // If it later arrives with isError=true, the tool_result case
      // overrides this 'done' with 'failed'.
      const next = new Map(state.subAgents)
      next.set(event.agentId, { ...sa, state: 'done', finishedAt: now })
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
      // Close any stragglers + mark the turn done. Stage jumps to 'done'.
      const items = state.items.map((it) =>
        it.state === 'running' ? { ...it, state: 'done' as const, finishedAt: now } : it,
      )
      // Close any still-running sub-agents + clear pending spawns that
      // never correlated.
      const subAgents = new Map<string, SubAgentState>()
      for (const [k, sa] of state.subAgents) {
        subAgents.set(k, sa.state === 'running' ? { ...sa, state: 'done', finishedAt: now } : sa)
      }
      return {
        ...state,
        items,
        subAgents,
        pendingAgentSpawns: new Map(),
        stage: 'done',
        thinking: false,
      }
    }

    case 'dequeue':
      // No-op — we key off enqueue + turn_end for the turn boundary.
      return state
  }
}

// ─── Renderer ───────────────────────────────────────────────────────────────

const STATE_EMOJI: Record<ItemState, string> = {
  pending: '⏸',
  running: '🔧',
  done: '✅',
  failed: '❌',
}

/**
 * Max checklist lines to render inline. Older completed items collapse
 * into a synthetic "(+N more earlier steps)" rollup line so the card
 * stays compact during long turns. Chosen to fit comfortably on a
 * mobile Telegram screen without scroll.
 */
const MAX_VISIBLE_ITEMS = 12

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
  //   <channel source="clerk-telegram" chat_id="…" …>USER TEXT</channel>
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
export function render(state: ProgressCardState, now: number): string {
  if (state.turnStartedAt === 0) {
    // Idle — emit a minimal placeholder so the stream has a body.
    return '🤔 Waiting…'
  }

  const lines: string[] = []

  // Header: distinctive status banner so the card never looks like a normal
  // reply. While in-flight, lead with ⚙️ <b>Working…</b>; on completion swap
  // to ✅ <b>Done</b>. The elapsed clock lives on the same line so users can
  // see "is it still moving?" at a glance.
  const elapsed = formatDuration(now - state.turnStartedAt)
  const headerIcon = state.stage === 'done' ? '✅' : '⚙️'
  const headerLabel = state.stage === 'done' ? 'Done' : 'Working…'
  lines.push(`${headerIcon} <b>${headerLabel}</b> · ⏱ ${elapsed}`)
  if (state.userRequest) {
    lines.push(`💬 ${escapeHtml(truncate(state.userRequest, 120))}`)
  }
  // Thin visual separator so the bullets below don't blur into the header.
  lines.push('─ ─ ─')

  const multiAgentActive =
    isMultiAgentEnabled() &&
    (state.subAgents.size > 0 || state.pendingAgentSpawns.size > 0)

  // [Main] header only when multi-agent rendering is active. Keeps the
  // single-agent case visually unchanged (no header, just the checklist).
  if (multiAgentActive) {
    lines.push(`[Main · ${state.items.length} tools]`)
  }

  // Checklist — preserve insertion order; running items show elapsed time.
  // The old static "🤔 Plan → 🔧 Run → ✅ Done" phase line is gone: users
  // asked for a live per-tool-call checklist instead. The header banner
  // (⚙️ Working… / ✅ Done) carries the overall phase.
  const compacted = compactItems(state.items)
  const visible = applyVisibleCap(compacted)
  if (visible.overflowCount > 0) {
    lines.push(`  … (+${visible.overflowCount} more earlier steps)`)
  }
  for (const item of visible.items) {
    lines.push(renderMainItem(item, now, multiAgentActive, state.subAgents))
  }

  // [Sub-agents] section
  if (multiAgentActive && state.subAgents.size > 0) {
    lines.push('') // blank separator
    const counts = countSubAgentStates(state.subAgents)
    lines.push(`[Sub-agents · ${formatSubAgentCounts(counts)}]`)
    for (const sa of sortSubAgentsChrono(state.subAgents)) {
      for (const l of renderSubAgent(sa, now, state.stage === 'done')) {
        lines.push(l)
      }
    }
  }

  // Thought line (only if we have latest text and haven't finished)
  if (state.stage !== 'done' && state.latestText) {
    lines.push('')
    lines.push(`💭 <i>${escapeHtml(truncate(state.latestText.trim(), 160))}</i>`)
  }

  return lines.join('\n')
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
  const indent = multiAgentActive ? '  ' : '  '

  if (isAgent && item.state === 'running' && multiAgentActive) {
    // Hold the 🤖 emoji while the sub-agent (if correlated) is alive.
    // Show elapsed since the parent's tool_use fired.
    const dur = formatDuration(now - item.startedAt)
    return `${indent}🤖 ${renderItemCore(item.tool, item.label, /*bold*/ true)} <i>(${dur})</i>`
  }

  const emoji = STATE_EMOJI[item.state]
  if (item.state === 'running') {
    const dur = formatDuration(now - item.startedAt)
    return `${indent}${emoji} ${renderItemCore(item.tool, item.label, /*bold*/ true)} <i>(${dur})</i>`
  }
  if ((item.state === 'done' || item.state === 'failed') && item.finishedAt != null) {
    if (item.kind === 'rollup') {
      return `${indent}${emoji} ${escapeHtml(item.tool)} <i>×${item.count}</i>`
    }
    const dur = formatDuration(item.finishedAt - item.startedAt)
    const needsDuration = item.finishedAt - item.startedAt >= 1000
    // For Agent/Task in multi-agent mode, prefix emoji is the regular
    // ✅/❌ — design §1.4 shows "✅ Agent: …" on the final card. The
    // sub-agent's own state lives in the [Sub-agents] section.
    return `${indent}${emoji} ${renderItemCore(item.tool, item.label)}${needsDuration ? ` <i>(${dur})</i>` : ''}`
  }
  // pending fallback
  void subAgents
  return `${indent}${emoji} ${renderItemCore(item.tool, item.label)}`
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
function renderSubAgent(
  sa: SubAgentState,
  now: number,
  forceCollapse: boolean,
): string[] {
  const desc = sa.description || '(uncorrelated)'
  const typeSuffix = sa.subagentType ? ` · ${escapeHtml(sa.subagentType)}` : ''
  const spawnedSuffix = sa.nestedSpawnCount > 0
    ? ` <i>(spawned ${sa.nestedSpawnCount})</i>`
    : ''

  if (sa.state !== 'running' || forceCollapse) {
    const emoji = sa.state === 'failed' ? '❌' : '✅'
    const end = sa.finishedAt ?? now
    const dur = formatDuration(end - sa.startedAt)
    return [
      `  ${emoji} ${escapeHtml(truncate(desc, 50))}${typeSuffix} · ${dur} · ${sa.toolCount} tools${spawnedSuffix}`,
    ]
  }

  // Running: two-line block.
  const elapsed = formatDuration(now - sa.startedAt)
  const headerLine = `  🤖 <b>${escapeHtml(truncate(desc, 50))}</b>${typeSuffix} · ⏱ ${elapsed}${spawnedSuffix}`
  if (sa.currentTool) {
    const cur = sa.currentTool
    const curDur = formatDuration(now - cur.startedAt)
    return [
      headerLine,
      `     └ 🔧 ${renderItemCore(cur.tool, cur.label)} <i>(${curDur})</i> · ${sa.toolCount} tools`,
    ]
  }
  return [headerLine, `     └ <i>(idle)</i> · ${sa.toolCount} tools`]
}

/**
 * Collapse runs of 5+ consecutive identical tools (e.g. a slurry of Reads)
 * into a single rollup item "<tool> ×N". Partial runs remain expanded so
 * the user still sees progress. This is structural (affects the checklist
 * shape) but deterministic — given the same items list you get the same
 * output.
 */
interface RolledItem extends ChecklistItem {
  readonly kind?: 'single' | 'rollup'
  readonly count?: number
}

const ROLLUP_THRESHOLD = 5

// Exported for tests.
export function compactItems(items: ReadonlyArray<ChecklistItem>): RolledItem[] {
  const out: RolledItem[] = []
  let run: ChecklistItem[] = []

  const flush = (): void => {
    if (run.length === 0) return
    if (run.length >= ROLLUP_THRESHOLD && run.every((r) => r.state === 'done')) {
      const first = run[0]
      const last = run[run.length - 1]
      out.push({
        id: first.id,
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
