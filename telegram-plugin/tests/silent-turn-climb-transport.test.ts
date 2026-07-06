/**
 * Transport-boundary regression test for the deterministic silent-turn card climb.
 *
 * Phase 4(b) of `reference/rfcs/deterministic-turn-liveness.md`; serves
 * `reference/jobs/know-what-my-agent-is-doing.md` (a busy-but-silent turn must
 * visibly escalate, never freeze).
 *
 * This is OUTCOME-based, not structural: it drives the exact 0-label branch of
 * `feedHeartbeatTick` against a SPY TRANSPORT that records every `sendMessage`
 * (an OPEN — the only mutation Telegram push-notifies) and every
 * `editMessageText` (a card EDIT — silent), each with a timestamp. It then
 * asserts on what actually reached the transport:
 *
 *   1. A ~40s silent tool call produces >=4 card EDITS with a CLIMBING elapsed —
 *      the card never freezes. (Acceptance criterion of the RFC.)
 *   2. No mid-turn mutation after the initial open is a NEW send — every climb is
 *      an edit, so the device never buzzes mid-turn.
 *   3. The climb YIELDS to model narration: the instant a tool label surfaces
 *      (`mirrorLineCount > 0`), the 0-label climb stops emitting (`null`) and the
 *      labelled-feed heartbeat takes over — the climb only fills the gaps the
 *      model leaves.
 *
 * ## Why this FAILS on pre-fix code (its acceptance criterion)
 *
 * Before Phase 1, the 0-label branch delegated solely to `openLivenessFeedIfDue`,
 * whose WHEN-gate `shouldEarlyOpenLiveness` returns false the moment a card is
 * open — so an already-open 0-label card received ZERO edits during a silent
 * tool. Model that pre-fix behaviour by making `silentTurnClimbRender` return
 * `null` for an open card (a one-line "stash" of the fix) and this test drops to
 * 0 edits, failing assertion 1. That is the exact decision-vs-delivery gap the
 * prior stubbed floor test hid.
 */
import { describe, it, expect } from 'vitest'
import {
  renderActivityFeedWithNested,
  formatStepSuffix,
  type SessionActivityHeader,
} from '../tool-activity-summary.js'
import { silentTurnClimbRender, SILENT_TURN_PLACEHOLDER } from '../feed-heartbeat-climb.js'

// The gateway constants that drive the tick cadence (gateway.ts).
const FEED_HEARTBEAT_TICK_MS = 6_000
const FEED_LIVENESS_OPEN_MS = 1_200

/** A recorded transport call with the simulated wall-clock time it happened at. */
interface TransportCall {
  kind: 'send' | 'edit'
  at: number
  text: string
}

/** Parse the climbing elapsed (in seconds) out of a rendered card header line
 *  (`_6s · 0 tools_`, `_1m05s · 0 tools_`). Returns null if not present. */
function parseHeaderElapsedSeconds(text: string): number | null {
  const m = text.match(/_((?:(\d+)m)?(\d+)s) · \d+ tools?_/)
  if (m == null) return null
  const minutes = m[2] ? Number(m[2]) : 0
  const seconds = Number(m[3])
  return minutes * 60 + seconds
}

/**
 * Spy transport standing in for `bot.api.sendMessage` / `bot.api.editMessageText`.
 * The card is a single in-place message: the first mutation SENDS (assigns an id),
 * every later mutation EDITS that id.
 */
class SpyCardTransport {
  calls: TransportCall[] = []
  messageId: number | null = null
  private nextId = 100

  /** Mirror of the drain: OPEN (send) when no id yet, otherwise EDIT in place. */
  render(text: string, at: number): void {
    if (this.messageId == null) {
      this.messageId = this.nextId++
      this.calls.push({ kind: 'send', at, text })
    } else {
      this.calls.push({ kind: 'edit', at, text })
    }
  }

  get sends(): TransportCall[] {
    return this.calls.filter((c) => c.kind === 'send')
  }
  get edits(): TransportCall[] {
    return this.calls.filter((c) => c.kind === 'edit')
  }
}

/**
 * Faithful model of `feedHeartbeatTick`'s 0-label branch at a single tick:
 *   - no card open yet + past the early-open threshold -> OPEN the "Working…"
 *     placeholder (the `openLivenessFeedIfDue` render);
 *   - card already open -> `silentTurnClimbRender` -> EDIT with climbing elapsed
 *     (the Phase-1 fix; pre-fix this branch emitted nothing).
 * Non-zero mirror lines are handled by the labelled-feed heartbeat, out of scope
 * here — the climb returns null and yields.
 */
function driveTick(
  transport: SpyCardTransport,
  opts: { mirrorLineCount: number; ageMs: number; now: number },
): void {
  if (opts.mirrorLineCount === 0) {
    if (transport.messageId == null) {
      if (opts.ageMs < FEED_LIVENESS_OPEN_MS) return
      const header: SessionActivityHeader = {
        label: 'Agent', elapsedMs: opts.ageMs, toolCount: 0, state: 'running',
      }
      const rendered = renderActivityFeedWithNested(
        [SILENT_TURN_PLACEHOLDER], [], false, formatStepSuffix(opts.ageMs), undefined, header,
      )
      if (rendered != null) transport.render(rendered, opts.now)
      return
    }
    const rendered = silentTurnClimbRender({
      mirrorLineCount: opts.mirrorLineCount,
      activityMessageId: transport.messageId,
      labeledToolCount: 0,
      ageMs: opts.ageMs,
    })
    if (rendered != null) transport.render(rendered, opts.now)
  }
}

describe('deterministic silent-turn card climb — transport boundary', () => {
  it('a ~40s silent tool call yields >=4 card edits with climbing elapsed (never freezes)', () => {
    const transport = new SpyCardTransport()
    const turnStart = 1_000_000 // arbitrary simulated epoch
    const SILENT_TOOL_MS = 40_000

    // Simulate the heartbeat ticking every FEED_HEARTBEAT_TICK_MS across a 40s
    // silent tool that surfaces NO label (mirrorLineCount stays 0).
    for (let now = turnStart; now <= turnStart + SILENT_TOOL_MS; now += FEED_HEARTBEAT_TICK_MS) {
      driveTick(transport, { mirrorLineCount: 0, ageMs: now - turnStart, now })
    }

    // Exactly one OPEN (the card the chat owns), then the climb rides it.
    expect(transport.sends.length).toBe(1)

    // The acceptance criterion: the card is EDITED at least 4 times across the gap.
    expect(
      transport.edits.length,
      `expected >=4 climbing card edits across a 40s silent tool, got ${transport.edits.length} ` +
        `(pre-fix code freezes the 0-label card and produces 0 edits)`,
    ).toBeGreaterThanOrEqual(4)

    // The elapsed on each successive edit strictly climbs — no frozen counter.
    const elapsedSeries = transport.edits
      .map((c) => parseHeaderElapsedSeconds(c.text))
      .filter((n): n is number => n != null)
    expect(elapsedSeries.length).toBe(transport.edits.length)
    for (let i = 1; i < elapsedSeries.length; i++) {
      expect(
        elapsedSeries[i],
        `card elapsed must climb: edit[${i}]=${elapsedSeries[i]}s not > edit[${i - 1}]=${elapsedSeries[i - 1]}s`,
      ).toBeGreaterThan(elapsedSeries[i - 1])
    }

    // Worst-case visible-update gap stays within ~two tick windows (RFC bound).
    const editTimes = [transport.sends[0].at, ...transport.edits.map((c) => c.at)]
    for (let i = 1; i < editTimes.length; i++) {
      expect(editTimes[i] - editTimes[i - 1]).toBeLessThanOrEqual(2 * FEED_HEARTBEAT_TICK_MS)
    }
  })

  it('no mid-turn mutation after the open is a new send (edits do not push-notify)', () => {
    const transport = new SpyCardTransport()
    const turnStart = 2_000_000
    for (let now = turnStart; now <= turnStart + 40_000; now += FEED_HEARTBEAT_TICK_MS) {
      driveTick(transport, { mirrorLineCount: 0, ageMs: now - turnStart, now })
    }
    // Only the first mutation is a send; everything after is an edit — so the
    // user's device is only pinged by the initial (silent-in-practice) open, and
    // never by a mid-turn "still working" ping.
    expect(transport.calls[0].kind).toBe('send')
    for (const call of transport.calls.slice(1)) {
      expect(call.kind).toBe('edit')
    }
  })

  it('the climb yields to model narration (a surfaced tool label stops the 0-label climb)', () => {
    // Once the model narrates / a tool label surfaces, mirrorLineCount > 0 and the
    // labelled-feed heartbeat owns the climb; the 0-label climb must emit nothing
    // so it never overwrites narration.
    expect(
      silentTurnClimbRender({ mirrorLineCount: 3, activityMessageId: 55, labeledToolCount: 2, ageMs: 30_000 }),
    ).toBeNull()
  })

  it('the climb does not OPEN a card — an open belongs to the OPEN path only', () => {
    // With no card open yet, the climb returns null: opening is `openLivenessFeedIfDue`'s
    // job (reply-is-last gated), so the climb can never open a card below a reply.
    expect(
      silentTurnClimbRender({ mirrorLineCount: 0, activityMessageId: null, labeledToolCount: 0, ageMs: 30_000 }),
    ).toBeNull()
  })
})
