/**
 * Regression: the 0-label activity-card FREEZE during a single silent long tool.
 *
 * ## The bug (deterministic, model-independent)
 *
 * `feedHeartbeatTick` (gateway.ts) has two liveness sub-paths for a turn that
 * has emitted NO tool label yet (`turn.mirrorLines.length === 0` — a single long
 * tool that runs silently: no `tool_label`, and the model emits no `text`
 * narration, so `mirrorLines` never grows):
 *
 *   - OPEN — at `FEED_LIVENESS_OPEN_MS` (~1.2 s) the early-open timer /
 *     heartbeat calls `openLivenessFeedIfDue`, which opens the "Working…" card
 *     and captures `turn.activityMessageId`.
 *   - CLIMB — every 6 s heartbeat afterwards should EDIT that card with a
 *     climbing ` · Ns` elapsed so it doesn't read as frozen.
 *
 * Pre-fix, the 0-label branch was ONLY:
 *     if (turn.mirrorLines.length === 0) { openLivenessFeedIfDue(turn); return }
 * and `openLivenessFeedIfDue` gates on `shouldEarlyOpenLiveness`
 * (feed-open-gate.ts), which returns FALSE once `activityMessageId != null`.
 * So after the ~1.2 s open, every subsequent heartbeat short-circuited and the
 * card was FROZEN from ~1.2 s until the silent tool returned — unbounded dead
 * air. The climbing-elapsed EDIT path only existed in the labelled (>0) branch.
 *
 * The fix keeps the first-tick OPEN flowing through `openLivenessFeedIfDue`
 * unchanged, and — when a card is already open (`activityMessageId != null`) —
 * takes the SAME climbing-elapsed EDIT idiom the >0 branch uses
 * (`renderActivityFeedWithNested(['Working…'], …, formatStepSuffix(age))` →
 * `drainActivitySummary(turn, 'liveness')`), gated so two edits are never closer
 * than `FEED_HEARTBEAT_MIN_STALE_MS`.
 *
 * ## Why this file is split into a STRUCTURAL guard + a BEHAVIORAL proof
 *
 * The regression lives inside `feedHeartbeatTick`, a private function of the
 * gateway module. That module CANNOT be instantiated in-process: it constructs
 * `const bot = new Bot(TOKEN)` at import time and ends in a self-invoking poll
 * loop that `process.exit(1)`s on failure. That is exactly why the repo's other
 * heartbeat tests (`feed-heartbeat-liveness-open.test.ts`,
 * `silence-liveness-wiring.test.ts`) are source-read structural tests. So:
 *
 *   - Part A (STRUCTURAL) is the fail-pre-fix / pass-post-fix guarantee. It reads
 *     the real gateway.ts and asserts the 0-label branch, once a card is open,
 *     takes the climbing EDIT path gated on `FEED_HEARTBEAT_MIN_STALE_MS` rather
 *     than only `openLivenessFeedIfDue(turn); return`. On origin/main this block
 *     fails (the branch has no EDIT path); on the fix it passes.
 *
 *   - Part B (BEHAVIORAL) drives the climb through the REAL transport boundary:
 *     the REAL renderer (`renderActivityFeedWithNested` + `formatStepSuffix`)
 *     and a REAL fake Bot API (`createFakeBotApi`, whose `editMessageText` is the
 *     same `vi.fn` transport spy `robustApiCall` ultimately calls) driven by
 *     `vi.useFakeTimers`. It reconstructs the post-fix heartbeat loop's
 *     send-once-then-edit drain over a 0-label silent-tool turn, advances ~40 s,
 *     and asserts `editMessageText` fires ≥5 times after the open, each with a
 *     monotonically climbing ` · Ns` suffix and no two edits closer than
 *     `FEED_HEARTBEAT_MIN_STALE_MS`. This is the executable spec of the invariant
 *     the fix delivers at the transport layer.
 *
 * ## Why `tests/turn-liveness-invariant.test.ts` structurally CANNOT catch this
 *
 * That invariant test drives the 45 s / 300 s silence-FLOOR primitive via
 * `__tickForTests` — an ENTIRELY DIFFERENT subsystem (turn-liveness-floor.ts).
 * In its world there is no `activityMessageId`, no `bot.api`, and no activity
 * CARD at all — it proves the silence-poke floor, not the in-chat activity feed.
 * The freeze here is a property of the activity CARD's heartbeat EDIT path
 * (`feedHeartbeatTick` + `drainActivitySummary` + `editMessageText`), which the
 * floor invariant never exercises. A green floor invariant and a frozen card can
 * (and did) coexist — hence this dedicated regression.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  renderActivityFeedWithNested,
  formatStepSuffix,
  type SessionActivityHeader,
} from '../tool-activity-summary.js'
import { createFakeBotApi } from './fake-bot-api.js'

// Mirror of the gateway module constants under test (not exported by the
// non-instantiable gateway module — kept in sync via the structural assertions
// in Part A, which pin the branch to the same names/values).
const FEED_LIVENESS_OPEN_MS = 1_200
const FEED_HEARTBEAT_TICK_MS = 6_000
const FEED_HEARTBEAT_MIN_STALE_MS = 6_000

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

/** Source of `feedHeartbeatTick` up to the next top-level function. */
function feedHeartbeatTickSrc(): string {
  const after = gatewaySrc.split('function feedHeartbeatTick(): void {')[1] ?? ''
  return after.split('\nfunction ')[0] ?? after
}

/** The 0-label branch scope: from the `mirrorLines.length === 0` guard to the
 *  start of the labelled (>0) "Labelled-feed heartbeat" section. */
function zeroLabelBranchSrc(): string {
  const body = feedHeartbeatTickSrc()
  const start = body.indexOf('if (turn.mirrorLines.length === 0)')
  const branch = start === -1 ? '' : body.slice(start)
  const end = branch.indexOf('// Labelled-feed heartbeat')
  return end === -1 ? branch : branch.slice(0, end)
}

// ─── Part A: STRUCTURAL — fails on pre-fix, passes on the fix ────────────────

describe('feed-heartbeat zero-label freeze — branch structure (fail-pre/pass-post)', () => {
  it('the 0-label branch still OPENs via the single shared helper when no card exists', () => {
    const scoped = zeroLabelBranchSrc()
    expect(scoped).toMatch(/if \(turn\.activityMessageId == null\)/)
    expect(scoped).toMatch(/openLivenessFeedIfDue\(turn\)/)
  })

  it('the 0-label branch takes the climbing-elapsed EDIT path once a card is open', () => {
    // THIS is the assertion that flips red on origin/main: pre-fix the branch is
    // only `openLivenessFeedIfDue(turn); return` and contains none of the below.
    const scoped = zeroLabelBranchSrc()
    // Renders the liveness placeholder with the same idiom as the >0 branch.
    expect(scoped).toMatch(/renderActivityFeedWithNested\(\['Working…'\]/)
    // Climbs via the step's own elapsed since turn start.
    expect(scoped).toMatch(/formatStepSuffix\(age\)/)
    // Drains through the single-flight liveness drain (an EDIT once open).
    expect(scoped).toMatch(/drainActivitySummary\(turn, 'liveness'\)/)
  })

  it('the climb is gated so two edits are never closer than FEED_HEARTBEAT_MIN_STALE_MS', () => {
    const scoped = zeroLabelBranchSrc()
    expect(scoped).toMatch(/FEED_HEARTBEAT_MIN_STALE_MS/)
    // The gate reads a per-turn last-edit timestamp so jitter can't produce a
    // sub-stale double edit.
    expect(scoped).toMatch(/livenessHeartbeatAt/)
  })
})

// ─── Part B: BEHAVIORAL — real renderer + real fake-bot transport + fake timers ─

/**
 * Faithful reconstruction of the post-fix `feedHeartbeatTick` 0-label loop over
 * a single silent long tool. Uses the REAL renderer and a REAL fake Bot API; the
 * only thing modelled is the tick scheduling + the single-flight send-then-edit
 * drain (`drainActivitySummary`'s documented transport: first render sends and
 * captures the message id, later renders edit it in place).
 */
describe('feed-heartbeat zero-label freeze — climbing edits at the transport boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('OPENs once at ~1.2s then EDITs ≥5 times with a climbing · Ns, spaced ≥ MIN_STALE', async () => {
    const fake = createFakeBotApi()
    const chatId = '12345'

    // Minimal turn model — only the fields the 0-label loop reads.
    const turn = {
      startedAt: 0,
      activityMessageId: null as number | null,
      labeledToolCount: 0,
      livenessHeartbeatAt: undefined as number | undefined,
    }

    // The single-flight drain: first render sends (captures the id), later
    // renders edit it in place — exactly `drainActivitySummary`'s transport.
    async function drainLiveness(html: string): Promise<void> {
      if (turn.activityMessageId == null) {
        const sent = await fake.api.sendMessage(chatId, html, { parse_mode: 'HTML' })
        turn.activityMessageId = sent.message_id
      } else {
        await fake.api.editMessageText(chatId, turn.activityMessageId, html, { parse_mode: 'HTML' })
      }
    }

    function renderLiveness(age: number): string {
      const header: SessionActivityHeader = {
        label: 'Agent', elapsedMs: age, toolCount: turn.labeledToolCount, state: 'running',
      }
      const html = renderActivityFeedWithNested(['Working…'], [], false, formatStepSuffix(age), undefined, header)
      if (html == null) throw new Error('renderer returned null')
      return html
    }

    // t≈1.2s — the early-open OPENs the card (a SEND, not an edit).
    vi.setSystemTime(FEED_LIVENESS_OPEN_MS)
    await drainLiveness(renderLiveness(Date.now() - turn.startedAt))
    expect(turn.activityMessageId).not.toBeNull()

    // The 6 s heartbeat: for a 0-label silent tool this is the ONLY path that
    // can advance the card. Post-fix it EDITs every tick; pre-fix it did nothing.
    const editTimestamps: number[] = []
    const editTexts: string[] = []
    const editAges: number[] = []
    for (let t = FEED_HEARTBEAT_TICK_MS; t <= 40_000; t += FEED_HEARTBEAT_TICK_MS) {
      vi.setSystemTime(t)
      const age = Date.now() - turn.startedAt
      const sinceLastBeat = turn.livenessHeartbeatAt == null ? age : Date.now() - turn.livenessHeartbeatAt
      if (sinceLastBeat < FEED_HEARTBEAT_MIN_STALE_MS) continue
      turn.livenessHeartbeatAt = Date.now()
      const before = fake.api.editMessageText.mock.calls.length
      await drainLiveness(renderLiveness(age))
      const after = fake.api.editMessageText.mock.calls.length
      if (after > before) {
        editTimestamps.push(t)
        editAges.push(age)
        editTexts.push(fake.api.editMessageText.mock.calls[after - 1][2] as string)
      }
    }

    // At least 5 EDITs after the open (pre-fix: 0 — the card froze at open).
    expect(
      fake.api.editMessageText.mock.calls.length,
      'a 0-label silent tool must keep the card advancing via ≥5 heartbeat EDITs, not freeze at open',
    ).toBeGreaterThanOrEqual(5)

    // No two edits closer than the min-stale window (jitter-proof spacing).
    for (let i = 1; i < editTimestamps.length; i++) {
      expect(editTimestamps[i] - editTimestamps[i - 1]).toBeGreaterThanOrEqual(FEED_HEARTBEAT_MIN_STALE_MS)
    }

    // The card visibly CHANGES on every edit (the anti-freeze property): each
    // rendered payload is distinct from the previous one.
    for (let i = 1; i < editTexts.length; i++) {
      expect(editTexts[i], 'consecutive card edits must differ — a frozen card repeats').not.toBe(editTexts[i - 1])
    }

    // Direct, unambiguous check on the REAL step-suffix function: for every edit
    // whose step has run ≥ STEP_TIMER_MIN_MS (10 s) the ` · Ns` suffix climbs
    // monotonically, and the payload actually carries that suffix.
    const timedAges = editAges.filter((a) => a >= 10_000)
    expect(timedAges.length, 'at least 5 edits should show a climbing · Ns step timer over 40 s').toBeGreaterThanOrEqual(5)
    for (let i = 1; i < timedAges.length; i++) {
      const prev = formatStepSuffix(timedAges[i - 1])
      const cur = formatStepSuffix(timedAges[i])
      expect(cur).not.toBe('')
      expect(cur).not.toBe(prev)
      const editIdx = editAges.indexOf(timedAges[i])
      expect(editTexts[editIdx]).toContain(cur.trim())
    }

    // Exactly one SEND (the open) — everything after is an in-place edit.
    expect(fake.api.sendMessage.mock.calls.length).toBe(1)
  })
})
