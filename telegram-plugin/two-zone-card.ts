/**
 * P1 of #662 — `renderTwoZoneCard` pure renderer.
 *
 * Two-zone status card: PARENT bullets + FLEET rows. Replaces the v1
 * expandable-blockquote-per-sub-agent layout (still live behind the
 * default codepath; gated on `TWO_ZONE_CARD=1` for now).
 *
 * Pure: no IO, no globals, no clock except the caller-supplied `now`.
 * All sanitisation happens upstream in `fleet-state.ts`; this module
 * only formats already-sanitised values.
 *
 * Spec: `reference/status-card-design.md` (PR #661).
 */

import type { FleetMember, FleetStatus } from './fleet-state.js'
import { cap } from './fleet-state.js'
import type { ProgressCardState, RenderOptions, TaskNum } from './progress-card.js'
import { escapeHtml, formatDuration } from './card-format.js'

const PARENT_BULLET_CAP = 8
const FLEET_ROW_CAP = 5
const STUCK_IDLE_MS = 60_000

export interface TwoZoneCardInput {
  state: ProgressCardState
  fleet: ReadonlyMap<string, FleetMember>
  now: number
  taskNum?: TaskNum
  opts?: RenderOptions
}

export interface PhaseResolution {
  icon: string
  label: string
}

// ─── Public entry point ─────────────────────────────────────────────────────

export function renderTwoZoneCard(input: TwoZoneCardInput): string {
  const { state, fleet, now, opts } = input
  if (state.turnStartedAt === 0) {
    return '⏳ Waiting…'
  }
  const phase = phaseFor(state, fleet, now, opts as Record<string, unknown> | undefined)
  const elapsedMs = Math.max(0, now - state.turnStartedAt)
  const totalTools = countTotalTools(state, fleet)
  const subCount = fleet.size
  const lines: string[] = []
  lines.push(renderHeader(phase, elapsedMs, totalTools, subCount, input.taskNum))
  const parentZone = renderParentZone(state)
  if (parentZone) {
    lines.push('')
    lines.push(parentZone)
  }
  const fleetZone = renderFleetZone(fleet, now)
  if (fleetZone) {
    lines.push('')
    lines.push(fleetZone)
  }
  return lines.join('\n')
}

// ─── Phase resolver ─────────────────────────────────────────────────────────

/**
 * Maps (parent state, fleet, opts) to a single header phase. Truth
 * table from `reference/status-card-design.md` §Header. Precedence:
 * forced-close > silent-end (gated on parent terminal) > stalled >
 * background > done > working.
 *
 * SilentEnd is lifted ABOVE the background/done checks so that a fleet
 * still running can't suppress the silent-end label once the parent has
 * terminated without a reply. It IS gated on `parentDone || stage===done`
 * to prevent firing prematurely while the parent is still in flight.
 */
export function phaseFor(
  state: ProgressCardState,
  fleet: ReadonlyMap<string, FleetMember>,
  now: number,
  opts?: Record<string, unknown>,
): PhaseResolution {
  const stalledClose = opts?.stalledClose === true
  const silentEnd = opts?.silentEnd === true
  const parentDone = opts?.parentDone === true || state.stage === 'done'

  if (stalledClose) return { icon: '⚠', label: 'Forced close' }

  const fleetRunning = anyFleetActive(fleet)
  const fleetAllStuck = fleet.size > 0 && [...fleet.values()].filter((m) => m.status === 'running' || m.status === 'stuck').every((m) => isStuck(m, now))

  // SilentEnd: parent terminated without a reply. Lifted above the
  // background/done branches so a still-running fleet can't mask it,
  // but gated on parentDone so we don't fire while parent is in flight.
  if (silentEnd && parentDone) {
    return { icon: '🙊', label: 'Ended without reply' }
  }

  // Stalled: every running-or-stuck member is past the idle threshold.
  // Members already terminal (done/failed) are excluded from this check —
  // a fleet of [done, stuck] still surfaces as Stalled because the only
  // member that could still make progress is no longer doing so.
  if (fleet.size > 0 && fleetAllStuck && !parentDone) {
    return { icon: '⚠', label: 'Stalled' }
  }

  // Background: parentDone but at least one fleet member still running
  if (parentDone && fleetRunning) {
    return { icon: '⏸', label: 'Background' }
  }

  // Done: parent terminal + no fleet still running
  if (parentDone && !fleetRunning) {
    return { icon: '✅', label: 'Done' }
  }

  // Default: active work
  return { icon: '⚙️', label: 'Working…' }
}

function anyFleetActive(fleet: ReadonlyMap<string, FleetMember>): boolean {
  for (const m of fleet.values()) {
    if (m.status === 'running' || m.status === 'background' || m.status === 'stuck') return true
  }
  return false
}

function isStuck(m: FleetMember, now: number): boolean {
  if (m.status === 'stuck') return true
  return m.status === 'running' && now - m.lastActivityAt > STUCK_IDLE_MS
}

// ─── Header ─────────────────────────────────────────────────────────────────

function renderHeader(
  phase: PhaseResolution,
  elapsedMs: number,
  totalTools: number,
  subCount: number,
  taskNum?: TaskNum,
): string {
  const tools = totalTools >= 100 ? '99+' : String(totalTools)
  const elapsed = formatDuration(elapsedMs)
  const parts = [`${phase.icon} <b>${escapeHtml(phase.label)}</b>`, `⏱ ${elapsed}`, `🔧 ${tools}`]
  if (subCount > 0) parts.push(`🤖 ${subCount}`)
  if (taskNum && taskNum.total > 1) parts.push(`#${taskNum.index}/${taskNum.total}`)
  return parts.join(' · ')
}

// ─── Parent zone ────────────────────────────────────────────────────────────

function renderParentZone(state: ProgressCardState): string {
  const items = state.items
  if (items.length === 0) return ''
  const lines: string[] = ['<b>PARENT</b>']
  const visible = items.slice(-PARENT_BULLET_CAP)
  const earlier = items.length - visible.length
  if (earlier > 0) lines.push(`(+${earlier} earlier)`)
  const inFlight = state.stage !== 'done'
  const lastIdx = visible.length - 1
  for (let i = 0; i < visible.length; i++) {
    const it = visible[i]
    const tool = escapeHtml(it.tool || '')
    const label = it.label ? ` <code>${escapeHtml(truncate(it.label, 80))}</code>` : ''
    if (inFlight && i === lastIdx) {
      lines.push(`◉ <b>${tool}</b>${label}`)
    } else {
      lines.push(`● ${tool}${label}`)
    }
  }
  return lines.join('\n')
}

// ─── Fleet zone ─────────────────────────────────────────────────────────────

export function renderFleetZone(fleet: ReadonlyMap<string, FleetMember>, now: number): string {
  if (fleet.size === 0) return ''
  const all = [...fleet.values()]
  const { visible, hidden } = cap(all, FLEET_ROW_CAP)
  const lines: string[] = [`<b>FLEET (${fleet.size})</b>`]
  for (const m of visible) lines.push(renderFleetRow(m, now))
  if (hidden > 0) lines.push(`+ ${hidden} more`)
  return lines.join('\n')
}

export function renderFleetRow(m: FleetMember, now: number): string {
  const glyph = glyphForFleetStatus(m.status)
  const role = escapeHtml(truncate(m.role || 'agent', 30))
  const id6 = escapeHtml(m.agentId.slice(0, 6))
  const tools = `${m.toolCount}t`
  const activity = formatLastActivity(m, now)
  return `${glyph} ${role} <code>${id6}</code> · ${tools} · ${activity}`
}

export function formatLastActivity(m: FleetMember, now: number): string {
  // Terminal states show "<status> <relative-time>"
  if (m.terminalAt != null) {
    const age = formatRelativeTime(Math.max(0, now - m.terminalAt))
    return `${escapeHtml(m.status)} ${age}`
  }
  // Stuck — show idle duration
  if (m.status === 'stuck') {
    const idle = formatRelativeTime(Math.max(0, now - m.lastActivityAt))
    return `idle ${idle}`
  }
  // Running — show last tool + age
  if (m.lastTool == null) {
    const age = formatRelativeTime(Math.max(0, now - m.lastActivityAt))
    return `started ${age}`
  }
  const age = formatRelativeTime(Math.max(0, now - m.lastActivityAt))
  const arg = m.lastTool.sanitisedArg
    ? ` <code>${escapeHtml(truncate(m.lastTool.sanitisedArg, 60))}</code>`
    : ''
  return `${escapeHtml(m.lastTool.name)}${arg} (${age})`
}

export function glyphForFleetStatus(status: FleetStatus): string {
  switch (status) {
    case 'running': return '↻'
    case 'background': return '⏸'
    case 'done': return '✓'
    case 'failed': return '✗'
    case 'stuck': return '⚠'
    case 'killed': return '✗'
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function formatRelativeTime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (r === 0) return `${m}m ago`
  return `${m}m${r}s ago`
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function countTotalTools(state: ProgressCardState, fleet: ReadonlyMap<string, FleetMember>): number {
  let n = state.items.length
  for (const m of fleet.values()) n += m.toolCount
  return n
}
