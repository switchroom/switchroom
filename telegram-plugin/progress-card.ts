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

// ─── Types ──────────────────────────────────────────────────────────────────

export type ItemState = 'pending' | 'running' | 'done' | 'failed'

export interface ChecklistItem {
  /** Index within the current turn — sequential, stable. */
  readonly id: number
  /** Claude Code tool name, e.g. "Read", "Bash", "Grep". */
  readonly tool: string
  /** Current state. */
  readonly state: ItemState
  /** Unix ms when tool_use fired. */
  readonly startedAt: number
  /** Unix ms when tool_result arrived. Only set on done/failed. */
  readonly finishedAt?: number
}

export type Stage = 'plan' | 'run' | 'done'

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
}

export function initialState(): ProgressCardState {
  return {
    turnStartedAt: 0,
    items: [],
    stage: 'plan',
    thinking: false,
  }
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
      // Close out any still-running item (a tool_use fires only after
      // the prior tool_result — so this shouldn't happen, but be
      // defensive). Then append the new item as running.
      const closed = state.items.map((it) =>
        it.state === 'running' ? { ...it, state: 'done' as const, finishedAt: now } : it,
      )
      const nextItem: ChecklistItem = {
        id: state.items.length,
        tool: event.toolName,
        state: 'running',
        startedAt: now,
      }
      return {
        ...state,
        items: [...closed, nextItem],
        stage: 'run',
        thinking: false,
      }
    }

    case 'tool_result': {
      if (state.turnStartedAt === 0) return state
      // Flip the most-recent running item to done. Paired by order —
      // Claude Code runs tools sequentially, so the oldest running item
      // is the one this result corresponds to.
      const idx = state.items.findIndex((it) => it.state === 'running')
      if (idx === -1) return state
      const items = state.items.slice()
      items[idx] = { ...items[idx], state: 'done', finishedAt: now }
      return { ...state, items }
    }

    case 'turn_end': {
      if (state.turnStartedAt === 0) return state
      // Close any stragglers + mark the turn done. Stage jumps to 'done'.
      const items = state.items.map((it) =>
        it.state === 'running' ? { ...it, state: 'done' as const, finishedAt: now } : it,
      )
      return { ...state, items, stage: 'done', thinking: false }
    }

    case 'dequeue':
      // No-op — we key off enqueue + turn_end for the turn boundary.
      return state
  }
}

// ─── Renderer ───────────────────────────────────────────────────────────────

const STATE_EMOJI: Record<ItemState, string> = {
  pending: '⏸',
  running: '⚡',
  done: '✅',
  failed: '❌',
}

const STAGE_ARROW = '→'

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
 * Render the current state to Telegram HTML. `now` is the wall-clock time
 * used for elapsed-time calculations so the render is deterministic in tests.
 */
export function render(state: ProgressCardState, now: number): string {
  if (state.turnStartedAt === 0) {
    // Idle — emit a minimal placeholder so the stream has a body.
    return '🤔 Waiting…'
  }

  const lines: string[] = []

  // Header: user request + elapsed
  const elapsed = formatDuration(now - state.turnStartedAt)
  if (state.userRequest) {
    lines.push(`💬 ${escapeHtml(truncate(state.userRequest, 120))}`)
  }
  lines.push(`⏱ ${elapsed}`)
  lines.push('')

  // Stage indicator
  const stageParts: string[] = [
    state.stage === 'plan' ? '<b>🤔 Plan</b>' : '🤔 Plan',
    state.stage === 'run' ? '<b>🔧 Run</b>' : '🔧 Run',
    state.stage === 'done' ? '<b>✅ Done</b>' : '✅ Done',
  ]
  lines.push(stageParts.join(` ${STAGE_ARROW} `))
  lines.push('')

  // Checklist — preserve insertion order; running items show elapsed time
  const compacted = compactItems(state.items)
  for (const item of compacted) {
    const emoji = STATE_EMOJI[item.state]
    const tool = escapeHtml(item.tool)
    if (item.state === 'running') {
      const dur = formatDuration(now - item.startedAt)
      lines.push(`  ${emoji} ${tool} <i>(${dur})</i>`)
    } else if (item.state === 'done' && item.finishedAt != null) {
      const dur = formatDuration(item.finishedAt - item.startedAt)
      if (item.kind === 'rollup') {
        lines.push(`  ${emoji} ${tool} <i>×${item.count}</i>`)
      } else {
        // Short tools don't need duration — they're ~always sub-second.
        const needsDuration = item.finishedAt - item.startedAt >= 1000
        lines.push(`  ${emoji} ${tool}${needsDuration ? ` <i>(${dur})</i>` : ''}`)
      }
    } else {
      lines.push(`  ${emoji} ${tool}`)
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

function compactItems(items: ReadonlyArray<ChecklistItem>): RolledItem[] {
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
