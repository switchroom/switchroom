#!/usr/bin/env bun
/**
 * Card preview harness — renders EVERY status/progress card variant through the
 * REAL renderers (no mockups) and writes `card-previews.md`.
 *
 * Run: bun scripts/card-previews.ts > card-previews.md
 *
 * Not a test; not wired into CI. Kept in-repo so the previews can be regenerated
 * verbatim whenever a card renderer changes.
 */
import {
  renderActivityFeed,
  renderActivityFeedWithNested,
  renderCombinedWorkerFeed,
  type CombinedWorkerRow,
  type SessionActivityHeader,
} from '../telegram-plugin/tool-activity-summary.js'
import {
  renderWorkerActivity,
  WORKER_CARD_SUPERSEDED_BODY,
  type WorkerActivityView,
} from '../telegram-plugin/worker-activity-feed.js'

type Section = {
  name: string
  fn: string
  when: string
  out: string
  /** Does this variant reach the shared `renderStatusCard` primitive? */
  shared: 'shared' | 'mixed' | 'divergent'
}
const sections: Section[] = []
const add = (
  name: string,
  fn: string,
  when: string,
  out: string | null,
  shared: 'shared' | 'mixed' | 'divergent' = 'shared',
): void => {
  sections.push({ name, fn, when, out: out ?? '(null — renderer returned nothing)', shared })
}

// Visualise the invisible: U+2800 BRAILLE BLANK and U+00A0 would otherwise be
// silent in a fenced block. Rendered as themselves PLUS a legend note.
const agentHeader = (over: Partial<SessionActivityHeader> = {}): SessionActivityHeader => ({
  label: 'Agent',
  elapsedMs: 95_000,
  toolCount: 12,
  state: 'running',
  model: 'claude-opus-4-8',
  totalTokens: 41_200,
  ...over,
})

const AGENT_STEPS = [
  'Searching memory for card render paths',
  'Reading telegram-plugin/tool-activity-summary.ts',
  'Reading telegram-plugin/worker-activity-feed.ts',
  'Grepping for renderStatusCard callers',
  'Drafting the inventory table',
]

// ── 1. Agent card — running ────────────────────────────────────────────────
add(
  'Agent card — running',
  'renderActivityFeed → renderStatusCard',
  'Every turn that labels a tool. Pinned in the session chat, edited in place.',
  renderActivityFeed(AGENT_STEPS, false, '', undefined, agentHeader()),
)

// ── 2. Agent card — final ──────────────────────────────────────────────────
add(
  'Agent card — final (turn complete)',
  'renderActivityFeed → renderStatusCard',
  'The terminal edit when the turn ends: every step struck, `✓ N steps` footer.',
  renderActivityFeed(AGENT_STEPS, true, '', 17, agentHeader({ state: 'done', elapsedMs: 214_000 })),
)

// ── 3. Agent card — no header (steps only) ─────────────────────────────────
add(
  'Agent card — steps only (no header)',
  'renderActivityFeed → renderStatusCard (header omitted)',
  'Legacy/direct callers (`appendActivityLine`, `appendActivityLabel`) that pass no header.',
  renderActivityFeed(AGENT_STEPS.slice(0, 3)),
)

// ── 4. Agent card — nested foreground sub-agent ────────────────────────────
add(
  'Agent card — with nested foreground sub-agent',
  'renderActivityFeedWithNested → renderStatusCard (childSteps)',
  'A foreground Task/Agent runs inside the turn: parent lines all struck, the live `→` sits in the `↳` child block.',
  renderActivityFeedWithNested(
    AGENT_STEPS.slice(0, 3),
    ['Reading the repo conventions', 'Running the scoped test suite', 'Summarising findings'],
    false,
    ' · 24s',
    undefined,
    agentHeader(),
  ),
)

// ── 5. Agent card — liveness early-open ────────────────────────────────────
add(
  'Agent card — liveness early-open (no tools yet)',
  'narrative-lane.ts:572 → renderActivityFeedWithNested → renderStatusCard',
  'A silent turn passes the liveness threshold before any tool is labelled — the card opens on `Working…`.',
  renderActivityFeedWithNested(
    ['Working…'],
    [],
    false,
    ' · 32s',
    undefined,
    { label: 'Agent', elapsedMs: 32_000, toolCount: 0, state: 'running', model: 'claude-opus-4-8' },
  ),
)

// ── 6. Agent card — liveness finalised ─────────────────────────────────────
add(
  'Agent card — liveness finalised',
  'narrative-lane.ts:882 → renderActivityFeedWithNested → renderStatusCard',
  'The liveness-only card at turn end: `→ Working…` becomes a done record instead of freezing live.',
  renderActivityFeedWithNested(
    ['Working…'],
    [],
    true,
    '',
    undefined,
    { label: 'Agent', elapsedMs: 88_000, toolCount: 0, state: 'done', model: 'claude-opus-4-8' },
  ),
)

// ── 7. Agent card — post-answer background sub-agent liveness ──────────────
add(
  'Agent card — post-answer background activity',
  'narrative-lane.ts:699 → renderActivityFeedWithNested → renderStatusCard',
  'The reply already went out and a background sub-agent is still running — the card surfaces below the reply.',
  renderActivityFeedWithNested(
    ['Working in background…'],
    [],
    false,
    ' · 1m10s',
    undefined,
    { label: 'Agent', elapsedMs: 130_000, toolCount: 3, state: 'running', model: 'claude-opus-4-8' },
  ),
)

// ── 8. Agent card — budget overflow ────────────────────────────────────────
const LONG = 'A'.repeat(700)
add(
  'Agent card — char-budget overflow backstop',
  'renderStatusCard → fitCardToBudget',
  'The rendered card exceeds STATUS_CARD_CHAR_BUDGET: oldest bullets are dropped and a `+N earlier…` marker re-inserted.',
  renderActivityFeed(
    [LONG, LONG, LONG, 'Finally a short newest step'],
    false,
    '',
    undefined,
    agentHeader(),
  ),
)

// ── Worker views ───────────────────────────────────────────────────────────
const workerView = (over: Partial<WorkerActivityView> = {}): WorkerActivityView => ({
  workerId: 'w1',
  description: 'Audit every card render path and de-indent the worker card',
  state: 'running',
  elapsedMs: 143_000,
  toolCount: 31,
  latestSummary: '',
  narrativeLines: [
    'Fetching origin and branching off main',
    'Reading telegram-plugin/status-no-truncate.ts',
    'Mapping renderStatusCard callers',
    'Writing the preview harness',
  ],
  model: 'claude-opus-4-8',
  totalTokens: 88_400,
  ...over,
}) as WorkerActivityView

// ── 9. Worker card — just dispatched ───────────────────────────────────────
add(
  'Worker card — just dispatched (no steps yet)',
  'renderWorkerActivity → renderStatusCard, then a hand-rolled starting… tail appended outside the primitive',
  'The first paint of a background worker, before it has produced a narrative line.',
  renderWorkerActivity(workerView({ narrativeLines: [], latestSummary: '', elapsedMs: 1_200, toolCount: 0 })),
  'mixed',
)

// ── 10. Worker card — running ──────────────────────────────────────────────
add(
  'Worker card — single worker running',
  'renderWorkerActivity → renderStatusCard',
  'Exactly one background worker live in the chat. Pinned; edited in place.',
  renderWorkerActivity(workerView(), ' · 18s'),
)

// ── 11. Worker card — done ─────────────────────────────────────────────────
add(
  'Worker card — done (with result recap)',
  'renderWorkerActivity → renderStatusCard (result block)',
  'The worker finished successfully: feed all-struck, rule, then the ✅ result paragraph.',
  renderWorkerActivity(
    workerView({
      state: 'done',
      elapsedMs: 902_000,
      latestSummary:
        'Inventoried 14 card variants, found renderCombinedWorkerFeed forks the header + budget logic, and de-indented the worker card. PR #0000.',
    }),
  ),
)

// ── 12. Worker card — failed ───────────────────────────────────────────────
add(
  'Worker card — failed',
  'renderWorkerActivity → renderStatusCard (result block, ⚠️)',
  'The worker errored: header line 2 reads `failed`, result block carries the error recap.',
  renderWorkerActivity(
    workerView({
      state: 'failed',
      elapsedMs: 61_000,
      latestSummary: 'Scoped test run failed: 3 assertions in card-type-distinguishability.test.ts.',
    }),
  ),
)

// ── 13. Worker card — incomplete ───────────────────────────────────────────
add(
  'Worker card — incomplete (killed / timed out)',
  'renderWorkerActivity → renderStatusCard (result suppressed by invariant)',
  'The worker was terminated before producing a result — the renderer refuses to fabricate a result block.',
  renderWorkerActivity(
    workerView({ state: 'incomplete', elapsedMs: 1_805_000, latestSummary: 'stray text that must not render' }),
  ),
)

// ── Combined feed ──────────────────────────────────────────────────────────
const row = (n: number, desc: string, hist: string[], over: Partial<CombinedWorkerRow> = {}): CombinedWorkerRow => ({
  ordinal: n,
  description: desc,
  elapsedMs: 60_000 * n + 15_000,
  toolCount: 7 * n,
  totalTokens: 20_000 * n,
  currentStep: hist[hist.length - 1] ?? 'starting…',
  historyLines: hist,
  model: 'claude-opus-4-8',
  ...over,
})

const H = (k: number, tag: string): string[] =>
  Array.from({ length: k }, (_, i) => `${tag} step ${i + 1}`)

// ── 14. Combined — 2 workers ───────────────────────────────────────────────
add(
  'WORKERS card — 2 workers',
  'renderCombinedWorkerFeed',
  '2+ background workers live in the same chat/thread coalesce into ONE message. Depth = 5 each.',
  renderCombinedWorkerFeed(
    [
      row(1, 'Audit every card render path', H(5, 'audit')),
      row(2, 'Fix the hindsight recall floor', H(5, 'recall')),
    ],
    { maxRows: 6 },
  ),
  'divergent',
)

// ── 15. Combined — 4 workers ───────────────────────────────────────────────
add(
  'WORKERS card — 4 workers',
  'renderCombinedWorkerFeed',
  'Depth degrades to the floor of Ken\'s 6/5/4/3 curve.',
  renderCombinedWorkerFeed(
    [
      row(1, 'Audit every card render path', H(4, 'audit')),
      row(2, 'Fix the hindsight recall floor', H(4, 'recall')),
      row(3, 'Release v0.19.24', H(4, 'release')),
      row(4, 'Investigate the flaky UAT scenario', H(4, 'uat')),
    ],
    { maxRows: 6 },
  ),
  'divergent',
)

// ── 16. Combined — spill ───────────────────────────────────────────────────
add(
  'WORKERS card — 8 workers (spill)',
  'renderCombinedWorkerFeed (row-count backstop)',
  'Beyond the design fan-out the NEWEST rows collapse into a single `+M more working…` line.',
  renderCombinedWorkerFeed(
    Array.from({ length: 8 }, (_, i) => row(i + 1, `Background task number ${i + 1}`, H(3, `t${i + 1}`))),
    { maxRows: 6 },
  ),
  'divergent',
)

// ── 17. Combined — survivors keep ordinals ─────────────────────────────────
add(
  'WORKERS card — survivors keep their ordinals',
  'renderCombinedWorkerFeed',
  'Worker 1 finished; 2 and 3 keep their numbers, so the card shows `2.`/`3.` with no `1.`',
  renderCombinedWorkerFeed(
    [
      row(2, 'Fix the hindsight recall floor', H(4, 'recall')),
      row(3, 'Release v0.19.24', H(4, 'release')),
    ],
    { maxRows: 6 },
  ),
  'divergent',
)

// ── 18. Combined — no history yet ──────────────────────────────────────────
add(
  'WORKERS card — a worker with no history yet',
  'renderCombinedWorkerFeed (→ starting… fallback)',
  'A freshly dispatched worker joins a group that already has a live card.',
  renderCombinedWorkerFeed(
    [
      row(1, 'Audit every card render path', H(5, 'audit')),
      row(2, 'Freshly dispatched worker', [], { currentStep: '', historyLines: undefined }),
    ],
    { maxRows: 6 },
  ),
  'divergent',
)

// ── 19. Rotated / superseded card ──────────────────────────────────────────
add(
  'Worker card — superseded (group message rotated)',
  'worker-activity-feed.ts WORKER_CARD_SUPERSEDED_BODY (static literal, no renderer)',
  'The shared worker message hit its lifetime cap and a fresh card was opened; the retired message is finalised to this static note so it does not read as a stuck worker.',
  WORKER_CARD_SUPERSEDED_BODY,
  'divergent',
)

// ── 20. Agent card — rolling overflow ──────────────────────────────────────
add(
  'Agent card — rolling-window overflow',
  'renderActivityFeed → renderStatusCard → renderStepFeed',
  'More steps than the rolling window: the oldest collapse to a `✓ +N earlier…` header.',
  renderActivityFeed(
    Array.from({ length: 14 }, (_, i) => `Doing thing number ${i + 1}`),
    false,
    '',
    undefined,
    agentHeader(),
  ),
)

// ── 21. Agent card — nested child overflow ─────────────────────────────────
add(
  'Agent card — nested sub-agent with child overflow',
  'renderActivityFeedWithNested → renderStatusCard',
  'The foreground sub-agent has produced more steps than the window: a `↳ +N earlier…` header appears in the child block.',
  renderActivityFeedWithNested(
    AGENT_STEPS.slice(0, 2),
    Array.from({ length: 11 }, (_, i) => `Child step ${i + 1}`),
    false,
    '',
    undefined,
    agentHeader(),
  ),
)

// ── emit ───────────────────────────────────────────────────────────────────
const vis = (s: string): string =>
  s.replace(/\u2800/g, '\u2800').replace(/\u00A0/g, '\u00A0')

const now = new Date().toISOString()
let md = `# Switchroom status/progress card previews

Generated **verbatim** from the real renderers by \`scripts/card-previews.ts\`
(\`bun scripts/card-previews.ts\`). Nothing here is a mockup.

Generated: \`${now}\`
Branch: \`${process.env.PREVIEW_BRANCH ?? 'fix/3839-deindent-worker-card'}\`

## Reading these

Card bodies are **Telegram markdown**, sent verbatim by the gateway. Two
characters are invisible in the fenced blocks below:

- \`U+2800\` BRAILLE PATTERN BLANK — the indent glyph. It renders blank-width on
  a phone but is category **So**, not whitespace, so Telegram's parser cannot
  left-trim it. Three of them = one indent level.
- \`U+00A0\` NO-BREAK SPACE — the \`collapseSafe\` separator appended to every line
  so the card stays legible when Telegram's pinned bar collapses it to one line.

Lines are joined with a GFM hard break (\`  \\n\`).

## Verdict on centralisation

**Mostly, not entirely.** Every 🤖 agent-card variant and every SINGLE-worker
🛠 card goes through the one shared primitive, \`renderStatusCard\`
(\`telegram-plugin/tool-activity-summary.ts\`). Three surfaces do not:

1. \`renderCombinedWorkerFeed\` — the 2+ worker WORKERS card. It shares the
   per-line pipeline (\`escapeStepLine\`, \`renderStepFeed\`, \`stackCardLines\`)
   but composes its own header (\`glanceLine\` + \`rowHeader\`, not
   \`renderActivityHeader\`) and carries its own char-budget backstop
   (a row-shrinking loop, not \`fitCardToBudget\`).
2. The just-dispatched \`starting…\` tail — appended by string concatenation
   AFTER \`renderStatusCard\` returns, in \`renderWorkerActivity\`.
3. \`WORKER_CARD_SUPERSEDED_BODY\` — a static literal with no renderer at all.

---

`

md += '## Inventory\n\n'
md += '| # | Variant | Renderer | Shared primitive? |\n|---|---|---|---|\n'
sections.forEach((s, i) => {
  md += `| ${i + 1} | ${s.name} | \`${s.fn}\` | ${s.shared === 'shared' ? 'shared (`renderStatusCard`)' : s.shared === 'mixed' ? 'shared **+ hand-rolled tail**' : '**divergent**'} |\n`
})
md += '\n---\n\n'

for (const s of sections) {
  md += `## ${s.name}\n\n`
  md += `**Renderer:** \`${s.fn}\`\n\n`
  md += `**When:** ${s.when}\n\n`
  md += '```\n' + vis(s.out) + '\n```\n\n---\n\n'
}

process.stdout.write(md)
