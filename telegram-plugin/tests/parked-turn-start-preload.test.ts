import { afterEach, describe, expect, it } from 'bun:test'
import {
  handleSessionEvent,
  __parkedTurnStartCountForTest,
  __resetParkedTurnStartsForTest,
} from '../gateway/stream-render.js'
import { enqueue, makeHarness } from './turn-mint-harness.js'

/**
 * Runtime alarm for the parked-turn-start leak guard (#4611).
 *
 * `parkedTurnStarts` is module-scope by design (one CLI session, one queue) and
 * `bun test` runs all ~657 telegram-plugin files in ONE process, so a file that
 * exits mid-park changes global state for every file after it:
 * `gateway/obligation-wiring.ts` folds the parked count into `sessionBusy`, and
 * `tests/represent-guard.test.ts`'s idle case then asserts `toHaveLength(1)`
 * against `0`. Two PRs were ejected from the merge queue that way, with
 * byte-identical retries passing, because bun's file order is not stable.
 *
 * `npm run lint:parked-turn-start-hermeticity` pins the WIRING statically; this
 * pins the EFFECT, so a bunfig that is present but no longer loading the guard
 * (wrong relative path, bun config-discovery change) fails a test rather than
 * silently un-protecting the runner.
 */
// This suite deliberately parks, so it follows the discipline the guard
// enforces for every other suite: reset on EXIT, not just on entry.
afterEach(() => {
  __resetParkedTurnStartsForTest()
})

describe('bun test runs with the parked-turn-start leak guard installed', () => {
  it('the preload registered the global afterEach', () => {
    const installed = (globalThis as { __switchroomParkedTurnStartGuard?: { hook: () => void } })
      .__switchroomParkedTurnStartGuard
    expect(
      installed,
      'guard absent — bunfig.toml `[test] preload` did not load parked-turn-start-guard.mjs',
    ).toBeTruthy()
    expect(typeof installed!.hook).toBe('function')
  })

  it('the hook throws on a leaked entry AND resets the store (one failure, not a cascade)', () => {
    const { hook } = (globalThis as { __switchroomParkedTurnStartGuard: { hook: () => void } })
      .__switchroomParkedTurnStartGuard

    // Reproduce the #4611 leak shape: a mid-turn enqueue parks behind a live
    // turn and is never dequeued — exactly queued-card-surface.test.ts:318.
    const h = makeHarness()
    handleSessionEvent(h.deps, enqueue('501'))
    handleSessionEvent(h.deps, enqueue('502', 'real mid-turn message'))
    expect(__parkedTurnStartCountForTest()).toBe(1)

    expect(() => hook()).toThrow(/SWITCHROOM_PARKED_TURN_START_LEAK/)
    // Reset-before-throw is what turns the ~1800-deep victim cascade into one
    // attributable failure — and is why this test's own leak does not escape.
    expect(__parkedTurnStartCountForTest()).toBe(0)

    // A clean store is silent.
    expect(() => hook()).not.toThrow()
  })

  it('leaves the store clean for the next file', () => {
    expect(__parkedTurnStartCountForTest()).toBe(0)
  })
})
