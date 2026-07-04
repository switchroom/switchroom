/**
 * Truthful `status-query` telemetry — issue #109 (truthful-telemetry PR).
 *
 * Regression guard for a lying diagnostic: the mid-turn "status?" telemetry
 * used to peek the pinned progress card via `progressDriver.peek(...)`. That
 * card was retired (#1122/#1126) and `progressDriver` is now permanently null,
 * so the peek ALWAYS reported idle/zero regardless of live background work.
 * These tests assert the replacement reads the LIVE surfaces:
 *
 *   - a running background worker (or an active turn, feed entry, or pending
 *     async dispatch) ⇒ NON-idle ⇒ NO false `ux-failure`;
 *   - nothing running AND no active turn ⇒ idle ⇒ `ux-failure` emitted.
 *
 * The peek path previously had NO coverage — this closes that.
 */
import { describe, it, expect } from 'bun:test'
import {
  deriveStatusQueryTelemetry,
  formatStatusQueryLine,
  formatStatusQueryUxFailureLine,
  type StatusQuerySurfaces,
} from '../status-query-telemetry.js'

const IDLE: StatusQuerySurfaces = {
  turnActive: false,
  turnAgeS: -1,
  runningWorkers: 0,
  workerFeedSize: 0,
  pendingAsync: 0,
}

describe('status-query telemetry — reads the live surfaces', () => {
  it('a running background worker ⇒ non-idle (no false ux-failure)', () => {
    const t = deriveStatusQueryTelemetry({ ...IDLE, runningWorkers: 1 })
    expect(t.idle).toBe(false)
    expect(t.stage).toBe('background-work')
  })

  it('a tracked 🛠 Worker feed entry ⇒ non-idle', () => {
    const t = deriveStatusQueryTelemetry({ ...IDLE, workerFeedSize: 2 })
    expect(t.idle).toBe(false)
    expect(t.stage).toBe('background-work')
  })

  it('a cross-turn pending-async dispatch ⇒ non-idle', () => {
    const t = deriveStatusQueryTelemetry({ ...IDLE, pendingAsync: 1 })
    expect(t.idle).toBe(false)
    expect(t.stage).toBe('background-work')
  })

  it('an active turn ⇒ non-idle, stage turn-active', () => {
    const t = deriveStatusQueryTelemetry({ ...IDLE, turnActive: true, turnAgeS: 12 })
    expect(t.idle).toBe(false)
    expect(t.stage).toBe('turn-active')
  })

  it('an active turn with a background worker still reports turn-active', () => {
    const t = deriveStatusQueryTelemetry({
      ...IDLE,
      turnActive: true,
      turnAgeS: 3,
      runningWorkers: 1,
    })
    expect(t.idle).toBe(false)
    expect(t.stage).toBe('turn-active')
  })

  it('nothing running AND no active turn ⇒ idle ⇒ ux-failure', () => {
    const t = deriveStatusQueryTelemetry(IDLE)
    expect(t.idle).toBe(true)
    expect(t.stage).toBe('idle')
  })

  it('treats negative/garbage counts as empty (defensive) ⇒ idle', () => {
    const t = deriveStatusQueryTelemetry({
      ...IDLE,
      runningWorkers: -1,
      workerFeedSize: -3,
      pendingAsync: -1,
    })
    expect(t.idle).toBe(true)
  })
})

describe('status-query telemetry — log line formatting', () => {
  it('primary line carries the "status-query" anchor and live fields', () => {
    const s: StatusQuerySurfaces = {
      turnActive: false,
      turnAgeS: -1,
      runningWorkers: 3,
      workerFeedSize: 1,
      pendingAsync: 0,
    }
    const line = formatStatusQueryLine('klanker', '123', 'none', s, deriveStatusQueryTelemetry(s))
    expect(line).toContain('status-query')
    expect(line).not.toContain('ux-failure')
    expect(line).toContain('stage=background-work')
    expect(line).toContain('running_workers=3')
    expect(line).toContain('worker_feed=1')
    expect(line).toContain('turn_age_s=-1')
    expect(line).toContain('agent=klanker')
    // The retired card fields must be gone — parsers keyed on them would
    // otherwise silently read zeros forever.
    expect(line).not.toContain('card_stage')
    expect(line).not.toContain('card_subagents')
    expect(line).not.toContain('card_items')
  })

  it('ux-failure line carries the "ux-failure: status-query" anchor', () => {
    const line = formatStatusQueryUxFailureLine('klanker', '123', 'none')
    expect(line).toContain('ux-failure: status-query')
    expect(line).toContain('stage=idle')
    expect(line).toContain('running_workers=0')
  })
})
