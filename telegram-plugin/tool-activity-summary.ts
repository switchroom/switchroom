/**
 * Tool-activity feed — a Claude-Code-style live list of what the agent
 * is doing this turn, rendered into ONE Telegram message that edits in
 * place and clears the moment the model's real reply lands.
 *
 * Each non-surface tool gets a human-friendly, present-tense line
 * ("Reading CLAUDE.md", "Searching memory", "Running a command"); the
 * feed renders them chronologically (oldest first, newest = the
 * in-progress step), consecutive duplicates collapsed, windowed to the
 * most recent STATUS_ROLLING_LINES with a "+N earlier…" overflow header.
 *
 * Two append entrypoints feed the same `lines: string[]` accumulator:
 *   - `appendActivityLabel` — for a pre-computed label from the
 *     real-time PreToolUse sidecar (`tool_label` event). This is the
 *     gateway's live driver: it fires at tool-call time regardless of
 *     when claude flushes the transcript, so it stays deterministic on
 *     fast/clustered-tool turns.
 *   - `appendActivityLine` — derives the label from a tool_use's name +
 *     input via `describeToolUse` (used where the raw tool_use is the
 *     only signal available).
 */

// ─── Friendly per-tool rendering ────────────────────────────────────────────
//
// Claude Code's own UI reads human-friendly because the model AUTHORS the
// descriptive text inside each tool_use.input — verified against a real
// session JSONL (1360 Bash calls etc.):
//   Bash         → input.description   ("Get CLAUDE.md size and recent history")
//   Read         → input.file_path     (basename → "Reading CLAUDE.md")
//   Edit/Write   → input.file_path     (basename)
//   Grep/Glob    → input.pattern
//   Task/Agent   → input.description   (the sub-agent's task)
//   WebFetch     → input.url           (hostname → "Reading example.com")
//   hindsight    → friendly label      ("Searching memory")
// There is never a raw `grep`/`jq`/`ls` to surface — only the model's own
// plain-English description or a domain label. This is the signal the
// draft-mirror renders (option A: uniform across code + non-code agents).

// (The per-tool wording helpers — basename/hostname/clip — live with the one
// composer in hooks/tool-label-pretool.mjs. See describeToolUse below.)
import { computeLabel } from './hooks/tool-label-pretool.mjs'

/**
 * Render a single tool_use into a human-friendly, present-tense activity
 * line for the live draft preview — or null when the tool should NOT be
 * surfaced (the Telegram-plugin surface tools, which ARE the conversation).
 *
 * SINGLE-COMPOSER RULE: the wording itself lives in ONE place —
 * `computeLabel` in hooks/tool-label-pretool.mjs, the same function the
 * real-time PreToolUse sidecar runs at tool-call time. This function is a
 * thin delegating wrapper, NOT a second vocabulary: before the delegation
 * the two tables had drifted (Grep "Searching . for X" vs "Searching for
 * X", WebFetch "Fetching host/path" vs "Reading host", retain "Saving
 * memory" vs "Saving to memory"), so the live feed and the flush-time /
 * nested-sub-agent / worker-card lines rendered the SAME action with
 * different copy — the wording drift the know-what-my-agent-is-doing spec
 * bars. `status-vocabulary-unification.test.ts` pins the delegation; do not
 * re-fork the table here.
 */
export function describeToolUse(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!toolName) return null;
  // Surface tools ARE the conversation — never mirror them. computeLabel
  // suppresses these too (its own key-agnostic regex); this guard stays as
  // the TS-side belt so a hook-side refactor can't leak a reply label into
  // the feed.
  if (isTelegramSurfaceTool(toolName)) return null;
  return computeLabel(toolName, input ?? {});
}

// ─── Accumulating activity feed (draft-mirror Phase 2) ──────────────────────
//
// Accumulates the turn's actions into a running feed — like Claude Code's
// own UI — rendered into one Telegram message that edits in place and is
// cleared on reply. Chronological (oldest first, newest last), consecutive
// exact-duplicates collapsed.
//
// Both this surface (agent) and the worker feed render through the single
// `renderStatusCard` primitive below: a rolling window of the last
// STATUS_ROLLING_LINES steps, each capped at STATUS_LINE_MAX chars, with a
// `+N earlier…` header when the feed overflows, bounded by the 4000-char
// wire-limit backstop (STATUS_CARD_CHAR_BUDGET).

import {
  STATUS_CARD_CHAR_BUDGET,
  STATUS_ROLLING_LINES,
  WORKER_HISTORY_MAX,
  STATUS_LINE_MAX,
  NESTED_PREFIX,
  WORKER_STEP_INDENT,
} from './status-no-truncate.js'
import { cleanWorkerResultParagraph, escapeMarkdown, truncate } from './card-format.js'
import { redact } from './secret-detect/redact.js'
import { isTelegramSurfaceTool } from './tool-names.js'
// The card layout core. Header composition (`metricsRun` /
// `renderActivityHeader`), the per-line escape pipeline (`escapeStepLine`), the
// bullet emitter (`emitSection`) and the char-budget backstop
// (`fitCardToBudget`) each live there exactly once; the renderers below are
// CONFIGURATIONS of it, never parallel implementations (#3844).
import {
  cardSpecLines,
  cleanStepLine,
  escapeStepLine,
  emitSection,
  fitCardToBudget,
  formatFeedElapsed,
  formatTokenCount,
  metricsRun,
  renderActivityHeader,
  renderCardSpec,
  renderCardTitleLine,
  renderStepFeed,
  tokenSegment,
  toolWord,
  type CardCandidate,
  type CardSection,
  type CardSpec,
  type CardState,
} from './card-layout.js'

// Re-exported so every existing importer keeps its `tool-activity-summary.js`
// entrypoint while the implementations live in the one layout core.
export {
  escapeStepLine,
  formatFeedElapsed,
  formatTokenCount,
  renderActivityHeader,
  renderCardTitleLine,
  renderStepFeed,
}
export type { CardSection, CardSpec, CardState }

/**
 * Optional header for the main-session activity card, matching the worker
 * card's two-line header style so both cards render consistently.
 *
 * `label`    — first header line text (e.g. "Agent")
 * `elapsedMs`— wall-clock since the turn started (for the elapsed field)
 * `toolCount`— labeled (non-surface) tool calls so far
 * `state`    — 'running' | 'done' (controls finished vs. in-progress status wording)
 */
export interface SessionActivityHeader {
  label: string
  elapsedMs: number
  toolCount: number
  state: 'running' | 'done'
  /**
   * Live model in use, as a raw resolved model id (e.g. `claude-opus-4-8`,
   * `sr-glm-5`) sourced from the transcript. Rendered as a short friendly form
   * appended to the metrics line (`… · opus 4.8`). Omitted when unknown — the
   * card never guesses from config. Formatting + sentinel-filtering live in
   * `formatModelLabel` (model-label.ts).
   */
  model?: string
  /** Running total tokens for THIS turn (the parent agent's OWN per-message
   *  usage, summed + deduped upstream) — rendered as `· {N} tok` on the metrics
   *  line via `tokenSegment`. Omitted (0/undefined) → no token segment, same
   *  clean-omit behavior as the worker feed. */
  totalTokens?: number
  /**
   * RAW final-summary text for the terminal `✅ <summary>` footer — the agent
   * card's analogue of the worker card's `latestSummary` (the gateway passes
   * the turn's delivered answer, `turn.lastReplyText`). Rendered ONLY on a
   * final render, through the SHARED `deriveCardResult` the worker card uses,
   * so both surfaces clean/cap/emoji it identically. Absent or empty → no
   * footer block (the worker card's own fallback), never a fabricated line.
   */
  resultText?: string
}

/**
 * Append a tool_use's friendly line to the running feed (mutates `lines`)
 * and return the rendered feed (ready Telegram HTML) — or null when the
 * tool is a surface tool / produced no line (caller skips the update).
 *
 * Dedups only consecutive identical lines (e.g. a burst of parallel Reads of
 * the same file) so distinct actions are all preserved.
 */
export function appendActivityLine(
  lines: string[],
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  const line = describeToolUse(toolName, input);
  if (line == null) return null;
  if (lines.length === 0 || lines[lines.length - 1] !== line) {
    lines.push(line);
  }
  return renderActivityFeed(lines);
}

/**
 * Clip a raw narrative text block down to a single durable feed line:
 * first line only, trimmed, sliced to STATUS_LINE_MAX (200) chars.
 *
 * 200 chars matches the tool-label cap used by `escapeStepLine` / `renderStepFeed`
 * so a narrative line is legible at the same length as a tool step — "Analysing
 * the 12 changed files in /src/auth to understand the scope of…" rather than a
 * hard-truncated 120-char fragment that drops context mid-sentence.
 *
 * Shared by the main-agent gateway path and the sub-agent watcher so both render
 * narrative identically. Returns the raw (unescaped) clipped string — callers
 * escape via the renderStepFeed path, exactly like a tool label.
 */
export function clipNarrative(s: string): string {
  // `s` is a non-nullable string at every call site (showNarrativeStep passes
  // ev.text; the foreground-sub path passes `progressLine ?? latestSummary`,
  // both typed string), so no null guard is needed.
  return s.split('\n')[0].trim().slice(0, STATUS_LINE_MAX);
}

/**
 * Minimum time the CURRENT step must have been running before its own
 * `· <elapsed>` suffix appears on the `→` line. Under this, no suffix — a
 * fresh step reads cleaner without a timer, and the header total already
 * carries the turn/worker elapsed.
 */
export const STEP_TIMER_MIN_MS = 10_000

/**
 * Live-suffix for the in-progress step line: the STEP's OWN elapsed (time
 * since that step started — NOT the turn/worker total, which lives in the
 * header). Empty string until the step has run ≥ STEP_TIMER_MIN_MS, so the
 * suffix never duplicates the header total on a young step.
 */
export function formatStepSuffix(stepElapsedMs: number): string {
  if (stepElapsedMs < STEP_TIMER_MIN_MS) return ''
  return ` · ${formatFeedElapsed(stepElapsedMs)}`
}

// ─── Unified status-card primitive ──────────────────────────────────────────
//
// Both status surfaces (🤖 agent + 🛠 worker) render through `renderStatusCard`.
// It is the single place that runs the per-line truncation pipeline, windows
// the rolling feed, prepends `+N earlier…`, wraps bullets, indents child
// steps, and applies the total-budget backstop.

/** Header block for a status card. Emoji 🤖 (agent) / 🛠 (worker). */
export interface StatusCardHeader {
  emoji: string
  label: string
  description?: string
  elapsedMs: number
  toolCount: number
  state: 'running' | 'done' | 'failed' | 'incomplete'
  /** Live model id (raw, e.g. `claude-opus-4-8`) — rendered as a short friendly
   *  tag on the metrics line via `formatModelLabel`. Omitted when unknown. */
  model?: string
  /** Running total tokens for the worker/turn — rendered as `· {N} tok` on the
   *  metrics line. Omitted (0/undefined) → no token segment. */
  totalTokens?: number
}

/** Inputs to the unified status-card renderer. */
export interface StatusCardOpts {
  /** Optional two-line header. When omitted, the card is steps-only. */
  header?: StatusCardHeader
  /** RAW parent step strings (unstripped, unescaped). */
  steps: string[]
  /** RAW nested child step strings (foreground sub-agent), unstripped/unescaped. */
  childSteps?: string[]
  /** Terminal record render — newest line renders done (✓) and `liveSuffix` is ignored. */
  final?: boolean
  /** Heartbeat suffix appended INSIDE the newest in-progress line (live only). */
  liveSuffix?: string
  /** When `final` and > 0, appends a `✓ N steps` footer. */
  stepCount?: number
  /** Optional terminal result block (worker recap), already-cleaned text + emoji. */
  result?: { emoji: string; text: string }
  /**
   * How many trailing step/child lines the rolling window shows. Defaults to
   * STATUS_ROLLING_LINES (the 🤖 agent card). The 🛠 single-worker card passes
   * a deeper window (`workerHistoryDepth(1)` = 6) so a lone worker can show its
   * full recent trail — see WORKER_HISTORY_MAX.
   */
  historyWindow?: number
  /**
   * Body line rendered when the card has NO steps and NO children at all — the
   * 🛠 worker card's `starting…` placeholder for a just-dispatched worker.
   *
   * This used to be string-concatenated onto the renderer's return value by
   * `renderWorkerActivity` (#3846), which put one user-visible card line
   * outside the primitive that owns line assembly, hard-break stacking and the
   * char budget. It is a normal body line now, emitted by `emitSection` like
   * every other one.
   */
  emptyPlaceholder?: string
}

/**
 * Render the unified status card as ready Telegram HTML, or null when there is
 * no content to show (no header content, no steps, no children, no result).
 *
 * Pipeline: header → escape+clip every raw step/child → rolling-window each
 * group with `+N earlier…` → wrap (parent done-styled when children present;
 * newest-in-progress `→` bold else `✓` italic; NESTED_PREFIX for children) →
 * optional `✓ N steps` footer → optional result block → fitCardToBudget.
 *
 * Every card this primitive emits is FLUSH at the left margin (#3842). The
 * whole-card `└─ ` + one-level indent that #3820/#3821 put on the worker card
 * is gone: it cost horizontal space on a phone and claimed a parent/child
 * relationship that does not always hold. Intra-card nesting (the `↳` child
 * block here, `WORKER_STEP_INDENT` on the combined card) is unaffected.
 */
export function renderStatusCard(opts: StatusCardOpts): string | null {
  const { header, final = false, liveSuffix = '', stepCount, result } = opts
  const window = Math.max(1, opts.historyWindow ?? STATUS_ROLLING_LINES)
  const rawSteps = opts.steps.filter((s) => s != null)
  const rawChildren = (opts.childSteps ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  const hasChildren = rawChildren.length > 0

  // Escape every line through the per-line pipeline (escape last).
  const steps = rawSteps.map(escapeStepLine)
  const children = rawChildren.map(escapeStepLine)

  const chrome = header != null
    ? renderActivityHeader(
        header.emoji,
        header.label,
        header.description ?? '',
        header.elapsedMs,
        header.toolCount,
        // Thread the terminal state straight through so a failed worker reads
        // `failed · …` on line 2 — never byte-identical to a done worker even
        // when the result block is empty. The agent surface never passes
        // 'failed', so only the worker card is affected.
        header.state,
        header.model,
        header.totalTokens,
      )
    : []

  // Fixed footer/result lines — kept at every shrink level.
  const footer: string[] = []
  if (final && stepCount != null && stepCount > 0) footer.push(`_✓ ${stepCount} steps_`)
  if (result != null && result.text.length > 0) {
    footer.push(WORKER_RESULT_RULE)
    footer.push(`${result.emoji} _${escapeMarkdown(truncate(result.text, WORKER_RESULT_MAX))}_`)
  }

  // The active "body" group the shrink levels erode: children when present
  // (the parent trail collapses to a single `+N` marker), else parent steps.
  const rawBody = hasChildren ? rawChildren : rawSteps
  const escapedBody = hasChildren ? children : steps
  const bodyIndent = hasChildren ? NESTED_PREFIX : ''
  // The `↳` glyph already marks the nested block, so its bullets carry no ✓.
  const bodyDoneMark = hasChildren ? '' : '✓ '

  /** Level 0 — the full card, everything at its natural window. */
  const fullSpec = (): CardSpec => ({
    chrome,
    sections: hasChildren
      ? [
          // Parent lines all render done — the live `→` lives in the nested block.
          { steps, window, allDone: true },
          {
            steps: children,
            window,
            allDone: final,
            liveSuffix,
            indent: NESTED_PREFIX,
            doneMark: '',
          },
        ]
      : [{ steps, window, allDone: final, liveSuffix, placeholder: opts.emptyPlaceholder }],
    footer,
  })

  const lines = cardSpecLines(fullSpec())
  // `lines` always carries the two header lines, so it is never empty — but
  // guard against a degenerate header-less future caller.
  if (lines.length === 0) return null

  // Parent-collapsed marker line used once the shrink levels start dropping
  // children (the parent trail is spent bytes on an over-budget card).
  const parentMarker =
    hasChildren && rawSteps.length > 0 ? `_✓ +${rawSteps.length} earlier…_` : null

  /**
   * Shrink levels for the status card:
   *   0                    — the full card.
   *   1 … len(body)-1      — drop that many OLDEST body bullets, re-inserting a
   *                          `+N earlier…` marker; done bullets lose their
   *                          strike/✓ chrome (`doneStyle: 'plain'`).
   *   len(body) (deepest)  — a single newest bullet that is ITSELF oversized:
   *                          truncate the RAW text, THEN escape, THEN wrap, so
   *                          an already-escaped markdown escape is never sliced.
   */
  const deepest = Math.max(1, escapedBody.length)
  return fitCardToBudget((level) => {
    if (level === 0) return { spec: fullSpec() }
    const markerSection: CardSection = {
      steps: [],
      window: 1,
      placeholder: parentMarker ?? undefined,
    }
    if (level < escapedBody.length) {
      return {
        spec: {
          chrome,
          sections: [
            markerSection,
            {
              steps: escapedBody,
              // Showing all but the `level` oldest — `emitSection` derives the
              // `+level earlier…` marker from the hidden remainder.
              window: escapedBody.length - level,
              allDone: final,
              liveSuffix,
              indent: bodyIndent,
              doneMark: bodyDoneMark,
              doneStyle: 'plain',
            },
          ],
          footer,
        },
      }
    }
    return {
      spec: {
        chrome,
        sections: [markerSection, { steps: [], window: 1, placeholder: truncatedNewestLine() }],
        footer,
      },
    }
  }, deepest)

  /**
   * The deepest shrink level's single bullet. Charges the fixed header/footer
   * (and the parent marker) against `STATUS_CARD_CHAR_BUDGET`, then clips the
   * RAW newest text to what is left, re-checking after escaping because
   * escaping can expand the string (`&` → `&amp;`).
   */
  function truncatedNewestLine(): string {
    const fixedCost = [...chrome, ...footer].join('\n').length
    const rawNewest = rawBody.length > 0 ? cleanStepLine(rawBody[rawBody.length - 1]) : ''
    const wrapperOverhead = final
      ? (bodyIndent + '_✓ _').length
      : (bodyIndent + '**→ **').length + liveSuffix.length
    const headerFooterCost =
      fixedCost +
      (fixedCost > 0 ? 1 : 0) +
      (parentMarker != null ? parentMarker.length + 1 : 0)
    const budget = STATUS_CARD_CHAR_BUDGET - headerFooterCost - wrapperOverhead
    let raw = rawNewest.slice(0, Math.max(0, budget))
    let newest = escapeMarkdown(raw)
    while (
      raw.length > 0 &&
      wrapperOverhead + headerFooterCost + newest.length > STATUS_CARD_CHAR_BUDGET
    ) {
      const excess = wrapperOverhead + headerFooterCost + newest.length - STATUS_CARD_CHAR_BUDGET
      raw = raw.slice(0, Math.max(0, raw.length - excess - 1))
      newest = escapeMarkdown(raw)
    }
    return final
      ? `${bodyIndent}_✓ ${newest}_`
      : `${bodyIndent}**→ ${newest}${liveSuffix}**`
  }
}

/** Subtle horizontal rule between the running feed and the finished result. */
const WORKER_RESULT_RULE = '─────'
/** Hard cap on the terminal result paragraph. */
const WORKER_RESULT_MAX = 320

/**
 * The ONE derivation of a card's terminal `✅/⚠️ <summary>` footer block, shared
 * by the 🤖 agent card and the 🛠 worker card (#3844 unified the card BODY; the
 * footer stayed forked until this landed — the agent card silently had no
 * result block at all, so it ended on `✓ N steps` while the worker card ended
 * on the green tick + summary sentence).
 *
 * Contract (the worker card's long-standing behaviour, now the spec for both):
 *   - `running`     → no block. The card is not finished.
 *   - `incomplete`  → NEVER a block, whatever `summary` carries. Truthful-no-
 *                     result invariant: a reaped/abandoned unit produced no
 *                     result, so it must not render a `⚠️`-prefixed paragraph
 *                     out of stray summary text. Enforced HERE (deterministic
 *                     mechanism) rather than left to caller discipline.
 *   - `done`        → `✅` + the cleaned paragraph.
 *   - `failed`      → `⚠️` + the cleaned paragraph.
 *   - empty/absent summary, or one that cleans to nothing → no block. Omitting
 *     is the fallback; the card never fabricates a sentence.
 *
 * `summary` is RAW model-authored text (markdown, multi-line). It is scrubbed
 * with `redact()` and cleaned with `cleanWorkerResultParagraph`;
 * `renderStatusCard` does the final truncate + escape when it emits the block.
 *
 * The `redact()` is load-bearing, not belt-and-braces: status cards are sent
 * via `sendRichMessage` and BYPASS the outbound redact chokepoint
 * (`normalizeOutboundBody` → `redact`, outbound-send-path.ts:192) that scrubs
 * every ordinary reply — the same gap `emitGatewayOperatorEvent` closes in
 * gateway.ts. The agent card's summary is the turn's delivered answer text
 * taken PRE-redaction, so scrubbing here is what keeps a token smuggled into a
 * summary from reaching Telegram verbatim. It runs BEFORE markdown stripping /
 * escaping, which is the order the outbound pipeline requires (redacting
 * already-escaped text lets url-query-param secrets slip past url-redact).
 */
export function deriveCardResult(
  state: CardState,
  summary: string | undefined,
): { emoji: string; text: string } | undefined {
  if (state !== 'done' && state !== 'failed') return undefined
  const text = cleanWorkerResultParagraph(redact(summary ?? ''))
  if (text.length === 0) return undefined
  return { emoji: state === 'done' ? '✅' : '⚠️', text }
}

/** Leading emoji for the main-session (🤖 Agent) card. */
const AGENT_CARD_EMOJI = '🤖'

/**
 * The single 🤖-agent-card configuration of `renderStatusCard`. Both public
 * agent-card entrypoints (`renderActivityFeed`, `renderActivityFeedWithNested`)
 * funnel through this so the header mapping, the empty-guard, and the terminal
 * result footer cannot drift between the flat and nested renders — they used
 * to be two byte-copies of the same object literal.
 */
function renderAgentCard(
  lines: string[],
  children: string[],
  final: boolean,
  liveSuffix: string,
  stepCount: number | undefined,
  header: SessionActivityHeader | undefined,
): string | null {
  if (lines.length === 0 && children.length === 0 && header == null) return null
  return renderStatusCard({
    header: header != null
      ? {
          emoji: AGENT_CARD_EMOJI,
          label: header.label,
          elapsedMs: header.elapsedMs,
          toolCount: header.toolCount,
          state: header.state,
          model: header.model,
          totalTokens: header.totalTokens,
        }
      : undefined,
    steps: lines,
    ...(children.length > 0 ? { childSteps: children } : {}),
    final,
    liveSuffix,
    stepCount,
    // Same footer derivation the 🛠 worker card uses — one code path, so the
    // two surfaces cannot drift apart again. Only a FINAL render can carry a
    // result; a live render passes 'running' through and gets undefined.
    result: final && header != null
      ? deriveCardResult(header.state, header.resultText)
      : undefined,
  })
}

/**
 * Render the accumulated feed as ready Telegram HTML — one action per line,
 * newest last. The current (newest) step is bold with a `→`; finished steps
 * are italic with a `✓`. Capped to the last STATUS_ROLLING_LINES with a dim
 * `✓ +N earlier…` header when the turn ran longer. Returns null when empty.
 * Callers send the result verbatim — do NOT re-escape or re-wrap it.
 *
 * Thin adapter over `renderStatusCard` (emoji 🤖, label 'Agent') via the shared
 * `renderAgentCard` configuration.
 *
 * `stepCount` (optional): when `final=true` and `stepCount > 0`, appends a
 * `✓ N steps` footer line.
 *
 * `header` (optional): when provided, the two-line activity header carries
 * elapsed + tool count — and, on a final render, `header.resultText` supplies
 * the terminal `✅ <summary>` footer (identical derivation to the worker card).
 */
export function renderActivityFeed(
  lines: string[],
  final = false,
  liveSuffix = "",
  stepCount?: number,
  header?: SessionActivityHeader,
): string | null {
  return renderAgentCard(lines, [], final, liveSuffix, stepCount, header)
}

// ─── Foreground sub-agent nesting (Model A) ─────────────────────────────────
//
// A foreground sub-agent (Task/Agent with no `run_in_background`) runs INSIDE
// the parent's turn — the parent is blocked at the Task tool until it returns.
// Rather than a separate message, its live steps nest under the parent's own
// activity feed: the gold-standard main-turn visibility applied one level
// down. The parent's lines render as done (the parent handed off; it isn't
// the active worker), and the sub-agent's recent narrative lines render as an
// indented `↳` block with the newest as the in-progress `→` step.

/** Trailing nested child lines kept visible (Telegram length + readability). */
export const NESTED_MAX_LINES = 4;

/**
 * Render the parent activity feed with an active foreground sub-agent's steps
 * nested beneath it. When `childLines` is empty this is identical to
 * `renderActivityFeed(lines)`. Otherwise the parent's own lines are all
 * done-styled (`✓` italic) — the live `→` step lives in the nested block —
 * and the child block is indented, newest = bold `→`, earlier = italic, with
 * a `↳ +N earlier…` header when it overflows. Returns ready Telegram HTML
 * (callers must NOT re-escape) or null when there is nothing to show.
 *
 * Thin adapter over `renderStatusCard` (emoji 🤖, label 'Agent', childSteps) via
 * the shared `renderAgentCard` configuration.
 */
export function renderActivityFeedWithNested(
  lines: string[],
  childLines: string[],
  final = false,
  liveSuffix = "",
  stepCount?: number,
  header?: SessionActivityHeader,
): string | null {
  const children = childLines.map((s) => s.trim()).filter((s) => s.length > 0);
  return renderAgentCard(lines, children, final, liveSuffix, stepCount, header)
}

// ─── Combined multi-worker feed (coalesced one-message-per-chat) ────────────
//
// When 2+ background workers are live in the SAME chat/thread, they render into
// ONE shared message rather than one message each — so their edits form a
// single per-message edit stream under the send gate's 1/sec per-chat ceiling
// instead of N streams that contend and shed (#3084 per-chat bucket). Each
// worker is a compact two-line row (header + live → step); the body is capped
// at `maxRows` with a `+M more working…` spill so it stays compact/legible and
// under the rich-message wire ceiling (STATUS_CARD_CHAR_BUDGET). A single-worker
// chat still renders through
// `renderStatusCard` (the 🛠 Worker card) — this primitive owns the N≥2 case.

/** Dispatch-time task description cap for a combined-feed worker row. */
const COMBINED_ROW_DESC_MAX = 72

/** One live worker's render-relevant snapshot for the combined feed. */
export interface CombinedWorkerRow {
  /** Dispatch-time task description (raw, unescaped). */
  description: string
  /** Wall-clock since dispatch, ms — climbs on every heartbeat re-render. */
  elapsedMs: number
  /** Tool calls observed so far. */
  toolCount: number
  /** The worker's latest step line (raw prose or friendly tool label). */
  currentStep: string
  /**
   * The worker's accumulated narrative history (oldest→newest, raw/unescaped),
   * already deduped + rolling-window capped upstream (STATUS_ROLLING_LINES).
   * When present + non-empty, the combined feed paints the worker's last-K
   * lines as a `✓`/`→` step trail (prior steps struck, newest in-progress) —
   * the same idiom as the single-worker card — with K set by the adaptive
   * per-worker line budget. Absent/empty → falls back to the single
   * `currentStep` line (back-compat for direct callers).
   */
  historyLines?: string[]
  /** Live model id (raw, e.g. `claude-opus-4-8`); omitted when unknown. */
  model?: string
  /** Running total tokens for this worker — rendered as `· {N} tok` on the row
   *  header. Omitted (0/undefined) → no token segment. */
  totalTokens?: number
  /**
   * Stable per-card ordinal (1-based), assigned when the worker joins its feed
   * group and KEPT for the card's lifetime — survivors keep their numbers when
   * an earlier worker finishes (the card may show `2.`/`3.` with no `1.`; the
   * `N running` chrome carries the count). Rendered as a `{ordinal}. ` prefix
   * inside the bold header when the card has 2+ rows. Omitted → unnumbered
   * (back-compat for direct callers).
   */
  ordinal?: number
}

export interface CombinedWorkerFeedOpts {
  /** Max worker rows rendered before the `+M more working…` spill line.
   *  Rows are kept head-first (`rows.slice(0, visibleCount)`): the earliest
   *  supplied (oldest dispatch-order) workers stay visible and the
   *  newest/trailing rows spill. */
  maxRows: number
}

/** Each visible worker costs one header line before any history. */
const PER_WORKER_HEADER_COST = 1

/**
 * Floor of the per-worker depth curve — every SHOWN worker renders at least
 * this many recent steps, no matter how large the fan-out (Ken's "4+ → 3 each").
 */
const MIN_WORKER_DEPTH = 3

/**
 * Design fan-out: the largest concurrent-worker count whose full Ken curve is
 * allowed to render before the total-line backstop starts collapsing the
 * NEWEST (trailing) rows into `+M more working…`. Chosen at 6 — beyond six live workers a
 * per-worker trail is no longer a glanceable card, so extra rows spill rather
 * than every shown worker losing depth. Every worker that IS shown keeps its
 * full curve depth; the ceiling trims row COUNT, never per-worker depth.
 */
const DESIGN_FANOUT = 6

/**
 * Total per-worker BODY line budget for the combined feed — the sum, across all
 * visible workers, of (one header line + that worker's history lines). The top
 * `🛠 Workers · N running` line and the `+M more working…` spill are OUTSIDE
 * this budget (fixed chrome).
 *
 * Re-derived (#3349) to fit Ken's per-worker curve `max(3, 7 − w)` rather than
 * to DRIVE the depth: at the flat tail (w ≥ 4, depth = MIN_WORKER_DEPTH) each
 * worker costs `PER_WORKER_HEADER_COST + MIN_WORKER_DEPTH` = 4 lines, so a
 * DESIGN_FANOUT of 6 fully-rendered workers needs 6 × 4 = 24 lines. That fully
 * fits every fan-out through 6 workers (w1=7, w2=12, w3=15, w4=16, w5=20,
 * w6=24); a 7th/8th concurrent worker overflows and the backstop drops the
 * newest (trailing) visible rows to the spill — bounding the card at 24 body lines so a
 * big swarm never explodes it. The per-worker curve wins on DEPTH; this ceiling
 * wins on ROW COUNT.
 */
const MAX_COMBINED_BODY_LINES = DESIGN_FANOUT * (PER_WORKER_HEADER_COST + MIN_WORKER_DEPTH)

/**
 * Deterministic per-worker history depth for `w` visible workers:
 *   clamp( max(MIN_WORKER_DEPTH, 7 − w), 1, WORKER_HISTORY_MAX )
 * So 1 worker → 6, 2 → 5, 3 → 4, 4 → 3, ≥4 → 3 (Ken's 6/5/4/3 curve, #3349).
 * Pure function of the visible worker count — no model input, consistent with
 * deterministic controls. Replaces the former budget-driven divide (which
 * yielded 5/5/3/2/… and could never reach 6 for a lone worker).
 */
export function combinedHistoryDepth(w: number): number {
  if (w <= 0) return 1
  return Math.min(WORKER_HISTORY_MAX, Math.max(MIN_WORKER_DEPTH, 7 - w))
}

/** Alias for readability at the single-worker call site — same curve. */
export const workerHistoryDepth = combinedHistoryDepth

/**
 * The combined card's first line: a SELF-CONTAINED glance at the whole swarm
 * (#3666) — `🛠 Workers · 3 running · oldest 38m16s · 196 tools · 1.2M tok`.
 *
 * Two jobs, both load-bearing:
 *
 *   1. In the feed it answers "what is my fleet doing" without reading the
 *      rows — the aggregate the per-row lines never showed.
 *   2. In Telegram's pinned bar, where the card collapses to ONE line, it is
 *      the part most likely to survive truncation, so the preview leads with
 *      real information instead of a four-word chrome stub that ran into
 *      row 1's ordinal (`… 3 running1. Fix issue …`).
 *
 * It always ends in a UNIT WORD (`running` / `oldest <elapsed>` / `tools` /
 * `tok`), never a bare number, so the first collapse seam reads as
 * `… · 196 tools 1. Fix issue …` — a list starting after a unit — rather than
 * two numbers colliding. Aggregates cover ALL rows (including any spilled to
 * `+M more working…`), matching the `N running` count beside them.
 */
function glanceLine(rows: CombinedWorkerRow[]): string {
  const oldestMs = rows.reduce((m, r) => Math.max(m, r.elapsedMs), 0)
  const tools = rows.reduce((n, r) => n + r.toolCount, 0)
  const tok = rows.reduce((n, r) => n + (r.totalTokens ?? 0), 0)
  // Aggregate glance, so it is NOT a `metricsRun` (no per-entity state/model,
  // and it leads with the swarm count rather than elapsed). It still reads the
  // same elapsed / tool-word / token primitives, so the vocabulary that DOES
  // repeat across cards cannot drift.
  return (
    `🛠 **WORKERS** · _${rows.length} running · oldest ${formatFeedElapsed(oldestMs)}` +
    ` · ${tools} ${toolWord(tools)}${tokenSegment(tok)}_`
  )
}

/**
 * Render N≥1 live workers into ONE combined feed body (ready Telegram
 * markdown; callers send verbatim — do NOT re-escape). Layout:
 *
 *   🛠 **WORKERS** · _N running · oldest {elapsed} · {n} tools · {t} tok_
 *   **1. {desc1}** _· {elapsed} · {n} tools_
 *      ~~_✓ {earlier step}_~~
 *      **→ {newest step}**
 *   **2. {desc2}** _· {elapsed} · {n} tools_
 *      **→ {newest step}**
 *   _+M more working…_
 *
 * FLUSH (#3842): the card sits at the left margin like every other card. The
 * whole-card `└─ ` + one-level indent from #3820/#3821 is gone — it burned a
 * level of horizontal phone width to assert a parent/child relationship with
 * the 🤖 agent card that does not always hold (this card is not always below
 * it).
 *
 * INDENT: exactly ONE level of indentation survives, and it is the level that
 * earns its keep — every step line carries a leading `WORKER_STEP_INDENT` (a
 * U+2800 run — neither ASCII spaces nor U+00A0; Telegram left-trims BOTH, see
 * the constant's doc comment) so one worker's steps are visibly separated from
 * the next worker's. The glance line, the numbered row headers and the spill
 * line stay flush.
 *
 * NUMBERING (#3298): when the card tracks 2+ rows AND a row carries `ordinal`,
 * its header gets a stable `{ordinal}. ` prefix. Ordinals are assigned by the
 * caller at dispatch and kept for the card's life — after an earlier worker
 * finishes the survivors keep their numbers (`2.`, `3.` with no `1.`). A lone
 * row, or rows without ordinals, render unnumbered.
 *
 * ADAPTIVE DENSITY: each visible worker renders its last-K narrative lines as a
 * `✓`/`→` trail (prior steps struck, newest bold in-progress) — the single-
 * worker card's idiom — where K = `combinedHistoryDepth(visibleCount)` splits a
 * fixed body-line budget across the running workers. So 2 workers each show
 * their full recent history and a 6-way fan-out degrades to one line each, the
 * card staying bounded regardless of fan-out. When a worker has no history yet
 * it falls back to a single `→ starting…`/currentStep line.
 *
 * PINNED-BAR READABILITY (#3666): line 1 is a self-contained glance
 * (`glanceLine`) and the stack is joined with `collapseSafe`, because this card
 * is pinned and Telegram's pinned bar renders it collapsed onto ONE line with
 * the newlines dropped and NOTHING substituted. Both halves are needed: the
 * glance so the preview leads with information, the per-line separator so every
 * later seam (`opus 5` → `✓ …` → `→ …`) degrades to a word gap instead of a
 * mashed glyph. There is no Bot API for a separate pin-bar preview — the client
 * derives it from the message text — so the text is the only lever.
 *
 * Pure. Rows are rendered in the order supplied (the manager passes them
 * dispatch-order, oldest first). `maxRows` caps the visible rows; the hidden
 * remainder collapses to a single `+M more working…` line. A total-budget
 * backstop drops the NEWEST (trailing) visible rows one at a time (growing the spill)
 * until the body fits STATUS_CARD_CHAR_BUDGET, so a burst of long descriptions
 * can never overflow the wire limit. Returns null only when `rows` is empty.
 */
export function renderCombinedWorkerFeed(
  rows: CombinedWorkerRow[],
  opts: CombinedWorkerFeedOpts,
): string | null {
  if (rows.length === 0) return null
  const maxRows = Math.max(1, Math.floor(opts.maxRows))

  // Number the workers only when the CARD tracks 2+ (a lone worker stays
  // unnumbered). Uses the total row count, not the visible count, so ordinals
  // don't appear/vanish as the overflow backstop shrinks the visible set.
  const numbered = rows.length >= 2

  const rowHeader = (r: CombinedWorkerRow): string => {
    const desc = escapeMarkdown(
      truncate(cleanStepLine(r.description) || 'background task', COMBINED_ROW_DESC_MAX),
    )
    // Stable ordinal prefix INSIDE the bold span, before the already-escaped
    // description — no new escaping surface, and the gateway md→HTML conversion
    // has no ordered-list auto-formatting on bolded text.
    const num = numbered && r.ordinal != null ? `${r.ordinal}. ` : ''
    // The metrics run is composed by the SAME function as the 🤖 agent header
    // and the 🛠 single-worker header (`metricsRun`, card-layout.ts). A combined
    // row is always live, so it reports 'running'; before #3844 this line spelled
    // the run out by hand and agreed with the other two only by inspection.
    return `**${num}${desc}** _· ${metricsRun(r.elapsedMs, r.toolCount, 'running', r.totalTokens, r.model)}_`
  }

  // Raw (unescaped) history for a worker, oldest→newest, empty lines stripped.
  // Falls back to the single currentStep when no history was supplied.
  const rowHistory = (r: CombinedWorkerRow): string[] => {
    const src = r.historyLines != null && r.historyLines.length > 0 ? r.historyLines : [r.currentStep]
    return src.filter((s) => s != null && cleanStepLine(s).length > 0)
  }

  const compose = (visibleCount: number): CardCandidate => {
    const shown = rows.slice(0, visibleCount)
    const hidden = rows.length - shown.length
    // Per-worker depth follows Ken's deterministic curve max(3, 7−w) (#3349):
    // the curve drives DEPTH; the total-line budget below drives ROW COUNT.
    const depth = combinedHistoryDepth(shown.length)
    // Each worker is ONE SECTION of the shared card spec: its row header, then
    // its last-K history lines painted with the SAME `✓`/`→` idiom as every
    // other card (emitSection). The window equals the depth, so a per-worker
    // `+N earlier…` marker never appears inside the combined feed.
    //
    // WORKER_STEP_INDENT nests every step line one level under its worker
    // header, so the boundary between two workers is visible at a glance on a
    // phone (the header lines stay at the left margin, their steps sit in).
    // It is a U+2800 run. NOT ASCII spaces and NOT U+00A0: Telegram's
    // server-side parser left-trims a leading Unicode-whitespace run, so both
    // render flat (#3662 shipped U+00A0 and was inert). U+2800 is category So,
    // not Zs. See the constant's doc comment for the live evidence.
    const sections: CardSection[] = shown.map((r) => ({
      header: [rowHeader(r)],
      steps: rowHistory(r).slice(-depth).map(escapeStepLine),
      window: depth,
      indent: WORKER_STEP_INDENT,
      placeholder: '→ _starting…_',
    }))
    const footer = hidden > 0 ? [`_+${hidden} more working…_`] : []
    // No whole-card nesting (#3842): the glance / row-header / spill lines land
    // flush and only the step lines carry their WORKER_STEP_INDENT — one level
    // of hierarchy, not two.
    const spec: CardSpec = { chrome: [glanceLine(rows)], sections, footer }
    // The per-worker BODY lines (row headers + their steps) — the glance line and
    // the spill line are fixed chrome and sit outside this ceiling.
    const bodyLines = cardSpecLines(spec).length - 1 - footer.length
    return { spec, overflow: bodyLines > MAX_COMBINED_BODY_LINES }
  }

  // Cap to maxRows first, then let the ONE shared budget enforcer shrink the
  // visible set while EITHER the total body-line budget (#3349: bounds a big
  // swarm without stealing depth from the shown workers) OR the wire char budget
  // is exceeded. Newest (trailing) rows collapse into the `+M more working…`
  // spill (`rows.slice(0, visibleCount)` keeps the head of the list).
  const visible = Math.min(rows.length, maxRows)
  return fitCardToBudget((level) => compose(Math.max(1, visible - level)), visible - 1)
}

/**
 * Like appendActivityLine, but for a pre-computed label (from the
 * real-time PreToolUse sidecar / `tool_label` event) — the hook already
 * rendered the friendly text, so we skip describeToolUse. Returns the
 * rendered feed, or null when the label is empty.
 */
export function appendActivityLabel(
  lines: string[],
  label: string | undefined,
): string | null {
  const l = (label ?? "").trim();
  if (l.length === 0) return null;
  if (lines.length === 0 || lines[lines.length - 1] !== l) {
    lines.push(l);
  }
  return renderActivityFeed(lines);
}
