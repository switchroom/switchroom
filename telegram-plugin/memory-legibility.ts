/**
 * Sparse, chat-legible memory surface — hindsight Phase 4 (#2849).
 *
 * When the interactive `claude` session materially changes what it
 * remembers during a turn — stores a new standing directive, or
 * invalidates / demotes an existing memory — this module surfaces ONE
 * terse line in the ORIGINATING Telegram chat/topic:
 *
 *   📌 <i>remembered:</i> "Always prefer TypeScript for this user"
 *   ✂️ <i>forgot:</i> superseded deploy runbook
 *
 * Why so sparse: the `remember-across-sessions` job spec lists
 * "regurgitating old facts unprompted just to prove it remembered" as a
 * top anti-pattern. A per-turn line would *become* that anti-pattern, so
 * this surface fires ONLY on a genuine store/correct — never on ordinary
 * recall, and never on routine consolidation. Detection is a
 * deterministic tool-call observation (no model call, no polling): we
 * watch the main-agent turn stream for the specific hindsight memory
 * tools that represent a material change.
 *
 * Design notes / references:
 *   - RFC Phase 4: `reference/rfcs/hindsight-synthesis-layers.md`
 *   - Job spec: `reference/jobs/remember-across-sessions.md`
 *   - The `consolidation.completed` webhook the RFC names as the poll-free
 *     driver for the "updated what I know about Y" side does NOT exist in
 *     the pinned hindsight image (v0.8.2) — it is RFC-only. This v1 ships
 *     the tool-observation path; the webhook stays a follow-up.
 *
 * Reuse: `classifyMemoryToolCall` / `detectMemoryLegibilityEvent` are the
 * single, reusable "did a directive-create / invalidate happen in this
 * turn?" primitive. Phase 3 Stage B (#2848) imports these rather than
 * re-deriving the tool-name matching inline.
 */

import { stripMarkdown, truncate } from './card-format.js'

/** ON by default; an operator opts out with SWITCHROOM_MEMORY_LEGIBILITY=0.
 *  Mirrors the SWITCHROOM_WORKER_ACTIVITY_FEED convention (only the literal
 *  string '0' disables; unset / anything else → enabled). */
export function isMemoryLegibilityEnabled(envVal: string | undefined): boolean {
  return envVal !== '0'
}

/**
 * The material memory operations we surface. Deliberately narrow — an
 * ordinary `recall` / `reflect` / benign `update_memory` (a non-demote
 * edit) is NOT material and returns null from the classifier.
 */
export type MemoryToolClass = 'directive-create' | 'memory-invalidate'

/** The two hindsight tools that represent a material store / correct.
 *  Fully-qualified names as they appear in the turn stream (`ev.toolName`). */
export const CREATE_DIRECTIVE_TOOL = 'mcp__hindsight__create_directive'
export const INVALIDATE_MEMORY_TOOL = 'mcp__hindsight__invalidate_memory'
/** The demote path (`switchroom memory demote`) adds this client-side tag
 *  via the `update_memory` tool; that specific tagging is the "forgot"
 *  signal, whereas a plain `update_memory` edit is not material. */
export const UPDATE_MEMORY_TOOL = 'mcp__hindsight__update_memory'
export const DEMOTE_FROM_RECALL_MARKER = 'demote-from-recall'

export type MemoryLegibilityKind = 'remembered' | 'forgot'

export interface MemoryLegibilityEvent {
  kind: MemoryLegibilityKind
  /** Best-effort human detail (directive body / invalidate reason). May be
   *  empty when the tool carries no legible detail — the render then falls
   *  back to a bare "forgot a memory" line. Raw (unescaped, unstripped);
   *  `renderMemoryLegibilityLine` does the cleanup. */
  detail: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** True when an `update_memory` call's tags carry the demote-from-recall
 *  marker — the only shape of `update_memory` that is a material correction.
 *  Bracket- and case-tolerant (`[demote-from-recall]` / `demote-from-recall`). */
function hasDemoteTag(input: Record<string, unknown> | undefined): boolean {
  if (input == null) return false
  const pools: unknown[] = []
  for (const key of ['add_tags', 'tags']) {
    const val = input[key]
    if (Array.isArray(val)) pools.push(...val)
    else if (typeof val === 'string') pools.push(val)
  }
  return pools.some(
    (t) => typeof t === 'string' && t.toLowerCase().includes(DEMOTE_FROM_RECALL_MARKER),
  )
}

/**
 * Classify a single tool call as a material memory operation, or null if
 * it isn't one. This is the reusable detection primitive: it answers "did a
 * directive-create / invalidate happen in this turn?" with no rendering
 * concern. #2848 Stage B imports this.
 */
export function classifyMemoryToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
): MemoryToolClass | null {
  if (toolName === CREATE_DIRECTIVE_TOOL) return 'directive-create'
  if (toolName === INVALIDATE_MEMORY_TOOL) return 'memory-invalidate'
  // `update_memory` is material ONLY when it applies the demote-from-recall
  // tag; any other edit is routine and must not surface a line.
  if (toolName === UPDATE_MEMORY_TOOL && hasDemoteTag(input)) return 'memory-invalidate'
  return null
}

/**
 * Detect a surfaceable memory-legibility event from one tool call, or null.
 * Pure — no I/O. Extracts the best-available human detail from the tool
 * input so the caller can render + route it.
 */
export function detectMemoryLegibilityEvent(
  toolName: string,
  input: Record<string, unknown> | undefined,
): MemoryLegibilityEvent | null {
  const klass = classifyMemoryToolCall(toolName, input)
  if (klass == null) return null
  if (klass === 'directive-create') {
    // The live server requires `content` (directive body); the profile
    // guidance example writes `create_directive(text)`, so tolerate both,
    // then fall back to the directive `name`.
    const detail =
      asString(input?.content).trim() ||
      asString(input?.text).trim() ||
      asString(input?.name).trim()
    return { kind: 'remembered', detail }
  }
  // memory-invalidate: prefer a human `reason`; the opaque memory_id is not
  // user-legible, so omit it and let the render use the bare fallback.
  const detail = asString(input?.reason).trim()
  return { kind: 'forgot', detail }
}

/** HTML-escape for parse_mode:'HTML' (escape the 3 entity-significant chars). */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Max chars of directive/reason detail shown on the one-liner. */
const DETAIL_MAX = 160

/**
 * Render the terse one-line surface (Telegram HTML). Callers send this as a
 * real `sendMessage` (not a draft/reaction) so it's observable + durable.
 *
 *   📌 <i>remembered:</i> "<directive, cleaned + truncated>"
 *   ✂️ <i>forgot:</i> <reason>            (or "✂️ <i>forgot a memory.</i>")
 */
export function renderMemoryLegibilityLine(ev: MemoryLegibilityEvent): string {
  const clean = truncate(stripMarkdown(ev.detail).replace(/\s+/g, ' ').trim(), DETAIL_MAX)
  if (ev.kind === 'remembered') {
    if (clean.length === 0) return `📌 <i>remembered a new directive.</i>`
    return `📌 <i>remembered:</i> "${escapeHtml(clean)}"`
  }
  if (clean.length === 0) return `✂️ <i>forgot a memory.</i>`
  return `✂️ <i>forgot:</i> ${escapeHtml(clean)}`
}
