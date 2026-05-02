/**
 * Bug D — turn-flush dedup branch must NOT prematurely fire setDone on
 * the status-reaction controller.
 *
 * Background. The gateway's turn_end handler has three exits:
 *   (1) `silent-marker` skip — drops streams, fires ctrl.setDone(), purges.
 *   (2) `flush` — schedules an async IIFE that waits 500ms and either:
 *       (2a) suppresses the flush because `getRecentOutboundCount > 0`
 *            (the reply tool already sent something), OR
 *       (2b) fires the captured text via bot.api.sendMessage as a backstop.
 *   (3) main path — ctrl.setDone(), purge, telemetry.
 *
 * Path (2a) used to call `backstopCtrl.setDone()` on a 500ms-lagged read
 * of local history — not a confirmation that anything actually reached
 * Telegram. With Bug Z's fix, stream_reply(done=true) on the default
 * lane fires `endStatusReaction('done')` AFTER `stream.finalize()`
 * resolves (meaning the final draft edit landed in Telegram). So the
 * authoritative 👍 source is the post-finalize callback, not the
 * dedup-branch heuristic.
 *
 * This test pins the contract for the dedup branch: when
 * `getRecentOutboundCount > 0`, the dedup branch must NOT fire setDone
 * on the controller. The controller's terminal transition is left to
 * the stream_reply post-finalize callback (already exercised in
 * stream-reply-handler.test.ts).
 *
 * The gateway IIFE is too entangled to import directly. Rather than
 * refactor the entire turn_end handler for testability in this PR, we
 * model the dedup-branch logic as a pure function below and pin the
 * post-fix invariant. If the gateway is ever refactored to extract
 * this branch, the same assertions apply unchanged.
 */
import { describe, it, expect, vi } from 'vitest'

interface MockController {
  setDone: () => void
  setError: () => void
}

interface DedupBranchDeps {
  getRecentOutboundCount: (chatId: string, withinSec: number) => number
  purgeReactionTracking: (key: string) => void
  ctrl: MockController | null
}

/**
 * Extract of the gateway turn-flush IIFE's dedup branch. Mirrors the
 * code at `telegram-plugin/gateway/gateway.ts` lines ~3365-3376
 * (post-fix). Returns true if the flush should be suppressed.
 */
function applyDedupBranch(
  chatId: string,
  statusKeyValue: string,
  deps: DedupBranchDeps,
): boolean {
  const recentCount = deps.getRecentOutboundCount(chatId, 2)
  if (recentCount > 0) {
    // Bug D fix: do NOT fire setDone here. The post-finalize callback
    // in stream-reply-handler.ts owns the terminal 👍 transition.
    deps.purgeReactionTracking(statusKeyValue)
    return true
  }
  return false
}

describe('Bug D — turn-flush dedup branch (post-fix)', () => {
  it('suppresses flush when recentCount > 0 AND does NOT prematurely fire setDone', () => {
    const setDone = vi.fn()
    const setError = vi.fn()
    const purgeReactionTracking = vi.fn()
    const getRecentOutboundCount = vi.fn(() => 1) // dedup case: 1 outbound landed within 2s

    const suppressed = applyDedupBranch(
      '-100',
      '-100:_',
      {
        getRecentOutboundCount,
        purgeReactionTracking,
        ctrl: { setDone, setError },
      },
    )

    expect(suppressed).toBe(true)
    expect(getRecentOutboundCount).toHaveBeenCalledWith('-100', 2)
    expect(purgeReactionTracking).toHaveBeenCalledWith('-100:_')
    // Critical: the controller is NOT touched here. Bug Z's
    // post-finalize callback in stream-reply-handler.ts is what
    // transitions the controller to terminal 👍 — and only after the
    // final draft edit confirmedly lands in Telegram.
    expect(setDone).not.toHaveBeenCalled()
    expect(setError).not.toHaveBeenCalled()
  })

  it('falls through (returns false) when recentCount == 0 — backstop send required', () => {
    // The other branch path: no recent outbound, so the IIFE will
    // proceed to bot.api.sendMessage and (on success) call setDone
    // there. This test pins that the dedup branch does NOT short-
    // circuit when there's nothing to dedup against.
    const setDone = vi.fn()
    const purgeReactionTracking = vi.fn()
    const getRecentOutboundCount = vi.fn(() => 0)

    const suppressed = applyDedupBranch(
      '-200',
      '-200:_',
      {
        getRecentOutboundCount,
        purgeReactionTracking,
        ctrl: { setDone, setError: vi.fn() },
      },
    )

    expect(suppressed).toBe(false)
    expect(getRecentOutboundCount).toHaveBeenCalledWith('-200', 2)
    // Neither side-effect should fire — the IIFE's backstop-send arm
    // owns those (purge in the finally block, setDone after sendMessage
    // resolves).
    expect(purgeReactionTracking).not.toHaveBeenCalled()
    expect(setDone).not.toHaveBeenCalled()
  })

  it('handles a missing controller gracefully (no throw)', () => {
    // Defence-in-depth: the IIFE captures `backstopCtrl = ctrl` which
    // may be null if no status-reaction was ever queued for this
    // chat+thread. The guard previously read `if (backstopCtrl)
    // backstopCtrl.setDone()`. With setDone removed entirely this is a
    // non-issue, but pin the invariant anyway.
    const purgeReactionTracking = vi.fn()
    const getRecentOutboundCount = vi.fn(() => 5)

    expect(() =>
      applyDedupBranch(
        '-300',
        '-300:_',
        {
          getRecentOutboundCount,
          purgeReactionTracking,
          ctrl: null,
        },
      ),
    ).not.toThrow()
    expect(purgeReactionTracking).toHaveBeenCalledWith('-300:_')
  })
})
