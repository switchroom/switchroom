/**
 * The catalogue of EVERY status/progress card variant the gateway can paint,
 * each rendered through the REAL renderer with realistic inputs.
 *
 * One catalogue, two consumers, so they can never disagree:
 *   - `telegram-plugin/tests/card-golden.test.ts` — the golden suite. Every
 *     variant's exact wire text is pinned in `card-variants.golden.txt`, so a
 *     change to the shared card layout that alters ANY card fails loudly.
 *   - `scripts/card-previews.ts` — the human-readable preview doc.
 *
 * Adding a card variant means adding it HERE (and regenerating the golden with
 * `UPDATE_CARD_GOLDEN=1 npx vitest run telegram-plugin/tests/card-golden.test.ts`),
 * which is what keeps the golden suite exhaustive rather than a sample.
 *
 * These are RENDERER-level fixtures. The lifecycle behaviour that decides WHICH
 * variant gets painted (dispatch → running → 2 workers → spill → done → failed
 * → superseded) is covered end-to-end from the feed manager in
 * `card-lifecycle-render.test.ts`; the two suites are complementary, not
 * duplicates.
 */
import {
  renderActivityFeed,
  renderActivityFeedWithNested,
  renderCombinedWorkerFeed,
  type CombinedWorkerRow,
  type SessionActivityHeader,
} from '../tool-activity-summary.js'
import {
  renderWorkerActivity,
  WORKER_CARD_SUPERSEDED_BODY,
  type WorkerActivityView,
} from '../worker-activity-feed.js'

/** Which renderer path a variant exercises, for the preview doc's inventory. */
export interface CardVariant {
  /** Stable identity — the golden file keys on this, so renaming rewrites it. */
  name: string
  /** The call path, for the preview doc. */
  fn: string
  /** When a user actually sees this card. */
  when: string
  /**
   * How the variant reaches the wire:
   *  - `shared`   — composed by the one card layout core (`card-layout.ts`).
   *  - `constant` — a static notice with no live state to render (see the
   *    superseded card); its title line still comes from the shared composer.
   */
  layout?: 'shared' | 'constant'
  /** The real render. `null` means the renderer declined to emit anything. */
  render: () => string | null
}

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

const workerView = (over: Partial<WorkerActivityView> = {}): WorkerActivityView => ({
  description: 'Audit every card render path and de-indent the worker card',
  state: 'running',
  elapsedMs: 143_000,
  toolCount: 31,
  lastTool: null,
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
})

const row = (
  n: number,
  desc: string,
  hist: string[],
  over: Partial<CombinedWorkerRow> = {},
): CombinedWorkerRow => ({
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

/** A 700-char step — long enough to blow the per-line clip and force the backstop. */
const LONG = 'A'.repeat(700)

export const CARD_VARIANTS: CardVariant[] = [
  {
    name: 'Agent card — running',
    fn: 'renderActivityFeed → renderStatusCard',
    when: 'Every turn that labels a tool. Pinned in the session chat, edited in place.',
    render: () => renderActivityFeed(AGENT_STEPS, false, '', undefined, agentHeader()),
  },
  {
    name: 'Agent card — final (turn complete)',
    fn: 'renderActivityFeed → renderStatusCard',
    when: 'The terminal edit when the turn ends: every step struck, `✓ N steps` footer.',
    render: () =>
      renderActivityFeed(AGENT_STEPS, true, '', 17, agentHeader({ state: 'done', elapsedMs: 214_000 })),
  },
  {
    name: 'Agent card — steps only (no header)',
    fn: 'renderActivityFeed → renderStatusCard (header omitted)',
    when: 'Legacy/direct callers (`appendActivityLine`, `appendActivityLabel`) that pass no header.',
    render: () => renderActivityFeed(AGENT_STEPS.slice(0, 3)),
  },
  {
    name: 'Agent card — with nested foreground sub-agent',
    fn: 'renderActivityFeedWithNested → renderStatusCard (childSteps)',
    when: 'A foreground Task/Agent runs inside the turn: parent lines all struck, the live `→` sits in the `↳` child block.',
    render: () =>
      renderActivityFeedWithNested(
        AGENT_STEPS.slice(0, 3),
        ['Reading the repo conventions', 'Running the scoped test suite', 'Summarising findings'],
        false,
        ' · 24s',
        undefined,
        agentHeader(),
      ),
  },
  {
    name: 'Agent card — liveness early-open (no tools yet)',
    fn: 'narrative-lane.ts → renderActivityFeedWithNested → renderStatusCard',
    when: 'A silent turn passes the liveness threshold before any tool is labelled — the card opens on `Working…`.',
    render: () =>
      renderActivityFeedWithNested(['Working…'], [], false, ' · 32s', undefined, {
        label: 'Agent',
        elapsedMs: 32_000,
        toolCount: 0,
        state: 'running',
        model: 'claude-opus-4-8',
      }),
  },
  {
    name: 'Agent card — liveness finalised',
    fn: 'narrative-lane.ts → renderActivityFeedWithNested → renderStatusCard',
    when: 'The liveness-only card at turn end: `→ Working…` becomes a done record instead of freezing live.',
    render: () =>
      renderActivityFeedWithNested(['Working…'], [], true, '', undefined, {
        label: 'Agent',
        elapsedMs: 88_000,
        toolCount: 0,
        state: 'done',
        model: 'claude-opus-4-8',
      }),
  },
  {
    name: 'Agent card — post-answer background activity',
    fn: 'narrative-lane.ts → renderActivityFeedWithNested → renderStatusCard',
    when: 'The reply already went out and a background sub-agent is still running — the card surfaces below the reply.',
    render: () =>
      renderActivityFeedWithNested(['Working in background…'], [], false, ' · 1m10s', undefined, {
        label: 'Agent',
        elapsedMs: 130_000,
        toolCount: 3,
        state: 'running',
        model: 'claude-opus-4-8',
      }),
  },
  {
    name: 'Agent card — over-long steps (per-line clip)',
    fn: 'renderStatusCard → cleanStepLine (STATUS_LINE_MAX)',
    when: 'A step line far exceeds STATUS_LINE_MAX: each is clipped to 200 chars + `…` before escaping. (This is also why the card-wide `fitCardToBudget` backstop is unreachable on the agent card — 5 clipped lines cannot approach 32768. The shrink levels are genuinely exercised by the WORKERS spill variant.)',
    render: () =>
      renderActivityFeed(
        [LONG, LONG, LONG, 'Finally a short newest step'],
        false,
        '',
        undefined,
        agentHeader(),
      ),
  },
  {
    name: 'Worker card — just dispatched (no steps yet)',
    fn: 'renderWorkerActivity → renderStatusCard (emptyPlaceholder)',
    when: 'The first paint of a background worker, before it has produced a narrative line.',
    render: () =>
      renderWorkerActivity(
        workerView({ narrativeLines: [], latestSummary: '', elapsedMs: 1_200, toolCount: 0 }),
      ),
  },
  {
    name: 'Worker card — single worker running',
    fn: 'renderWorkerActivity → renderStatusCard',
    when: 'Exactly one background worker live in the chat. Pinned; edited in place.',
    render: () => renderWorkerActivity(workerView(), ' · 18s'),
  },
  {
    name: 'Worker card — done (with result recap)',
    fn: 'renderWorkerActivity → renderStatusCard (result block)',
    when: 'The worker finished successfully: feed all-struck, rule, then the ✅ result paragraph.',
    render: () =>
      renderWorkerActivity(
        workerView({
          state: 'done',
          elapsedMs: 902_000,
          latestSummary:
            'Inventoried 14 card variants, found renderCombinedWorkerFeed forks the header + budget logic, and de-indented the worker card. PR #0000.',
        }),
      ),
  },
  {
    name: 'Worker card — failed',
    fn: 'renderWorkerActivity → renderStatusCard (result block, ⚠️)',
    when: 'The worker errored: header line 2 reads `failed`, result block carries the error recap.',
    render: () =>
      renderWorkerActivity(
        workerView({
          state: 'failed',
          elapsedMs: 61_000,
          latestSummary: 'Scoped test run failed: 3 assertions in card-type-distinguishability.test.ts.',
        }),
      ),
  },
  {
    name: 'Worker card — incomplete (killed / timed out)',
    fn: 'renderWorkerActivity → renderStatusCard (result suppressed by invariant)',
    when: 'The worker was terminated before producing a result — the renderer refuses to fabricate a result block.',
    render: () =>
      renderWorkerActivity(
        workerView({
          state: 'incomplete',
          elapsedMs: 1_805_000,
          latestSummary: 'stray text that must not render',
        }),
      ),
  },
  {
    name: 'WORKERS card — 2 workers',
    fn: 'renderCombinedWorkerFeed → the shared card spec',
    when: '2+ background workers live in the same chat/thread coalesce into ONE message. Depth = 5 each.',
    render: () =>
      renderCombinedWorkerFeed(
        [
          row(1, 'Audit every card render path', H(5, 'audit')),
          row(2, 'Fix the hindsight recall floor', H(5, 'recall')),
        ],
        { maxRows: 6 },
      ),
  },
  {
    name: 'WORKERS card — 4 workers',
    fn: 'renderCombinedWorkerFeed → the shared card spec',
    when: "Depth degrades to the floor of Ken's 6/5/4/3 curve.",
    render: () =>
      renderCombinedWorkerFeed(
        [
          row(1, 'Audit every card render path', H(4, 'audit')),
          row(2, 'Fix the hindsight recall floor', H(4, 'recall')),
          row(3, 'Release v0.19.24', H(4, 'release')),
          row(4, 'Investigate the flaky UAT scenario', H(4, 'uat')),
        ],
        { maxRows: 6 },
      ),
  },
  {
    name: 'WORKERS card — 8 workers (spill)',
    fn: 'renderCombinedWorkerFeed → fitCardToBudget (row-count shrink levels)',
    when: 'Beyond the design fan-out the NEWEST rows collapse into a single `+M more working…` line.',
    render: () =>
      renderCombinedWorkerFeed(
        Array.from({ length: 8 }, (_, i) => row(i + 1, `Background task number ${i + 1}`, H(3, `t${i + 1}`))),
        { maxRows: 6 },
      ),
  },
  {
    name: 'WORKERS card — survivors keep their ordinals',
    fn: 'renderCombinedWorkerFeed → the shared card spec',
    when: 'Worker 1 finished; 2 and 3 keep their numbers, so the card shows `2.`/`3.` with no `1.`',
    render: () =>
      renderCombinedWorkerFeed(
        [
          row(2, 'Fix the hindsight recall floor', H(4, 'recall')),
          row(3, 'Release v0.19.24', H(4, 'release')),
        ],
        { maxRows: 6 },
      ),
  },
  {
    name: 'WORKERS card — a worker with no history yet',
    fn: 'renderCombinedWorkerFeed → section placeholder',
    when: 'A freshly dispatched worker joins a group that already has a live card.',
    render: () =>
      renderCombinedWorkerFeed(
        [
          row(1, 'Audit every card render path', H(5, 'audit')),
          row(2, 'Freshly dispatched worker', [], { currentStep: '', historyLines: undefined }),
        ],
        { maxRows: 6 },
      ),
  },
  {
    name: 'Worker card — superseded (group message rotated)',
    layout: 'constant',
    fn: 'WORKER_CARD_SUPERSEDED_BODY (static notice; title line via renderCardTitleLine)',
    when: 'The shared worker message hit its lifetime cap and a fresh card was opened; the retired message is finalised to this static note so it does not read as a stuck worker.',
    render: () => WORKER_CARD_SUPERSEDED_BODY,
  },
  {
    name: 'Agent card — rolling-window overflow',
    fn: 'renderActivityFeed → renderStatusCard → emitSection',
    when: 'More steps than the rolling window: the oldest collapse to a `✓ +N earlier…` header.',
    render: () =>
      renderActivityFeed(
        Array.from({ length: 14 }, (_, i) => `Doing thing number ${i + 1}`),
        false,
        '',
        undefined,
        agentHeader(),
      ),
  },
  {
    name: 'Agent card — nested sub-agent with child overflow',
    fn: 'renderActivityFeedWithNested → renderStatusCard',
    when: 'The foreground sub-agent has produced more steps than the window: a `↳ +N earlier…` header appears in the child block.',
    render: () =>
      renderActivityFeedWithNested(
        AGENT_STEPS.slice(0, 2),
        Array.from({ length: 11 }, (_, i) => `Child step ${i + 1}`),
        false,
        '',
        undefined,
        agentHeader(),
      ),
  },
]

/** Section delimiter in the golden file. Chosen so no card body can contain it. */
export const GOLDEN_DELIMITER = '\n===== CARD ====='

/**
 * The whole catalogue as ONE deterministic string — what the golden file holds.
 * Every variant contributes its name and its exact rendered bytes.
 */
export function renderGoldenDocument(): string {
  return (
    CARD_VARIANTS.map(
      (v) => `${GOLDEN_DELIMITER} ${v.name}\n${v.render() ?? '(null — renderer returned nothing)'}`,
    ).join('\n') + '\n'
  )
}
