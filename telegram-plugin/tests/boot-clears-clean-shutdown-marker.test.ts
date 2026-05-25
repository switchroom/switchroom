/**
 * Regression guard for the marker-stale crash banner class.
 *
 * Pre-2026-05-25 the boot path read the clean-shutdown marker but
 * never cleared it. A marker from a graceful shutdown 11 hours ago
 * sat on disk untouched; subsequent boots after an unhandledRejection
 * crash (which explicitly SKIPS writing a new marker, per
 * gateway.ts:15107) read the stale marker, classified the age as
 * >5min, and fired `boot.clean_shutdown_marker_stale age=39976s` →
 * `reason=crash` → `agent-crashed` operator-event banner posted to
 * the user's chat.
 *
 * That misclassified the user-visible state ("clerk seems to be
 * crashing") because the banner detail included the stale-marker
 * artifact rather than just naming the actual crash.
 *
 * Fix: clear the marker after every successful boot reads it. The
 * marker now describes the IMMEDIATELY PRECEDING shutdown only;
 * a subsequent crash with no marker write leaves an empty marker
 * file, and boot-reason.ts:84 correctly classifies via the
 * sessionMarker fallback.
 *
 * The gateway IIFE is too entangled to instantiate in-process; this
 * is a source-level pin matching the pattern used by
 * `reply-terminal-reaction.test.ts` and `buffer-gate-broadened.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('boot path clears the clean-shutdown marker after reading it', () => {
  it('imports clearCleanShutdownMarker (no longer the "intentionally not imported" comment)', () => {
    // Pre-fix the import block had a `clearCleanShutdownMarker is
    // intentionally NOT imported here` block-comment, with a rationale
    // that was wrong for the unhandledRejection edge case. If a future
    // commit re-removes the import (and re-adds the wrong comment),
    // this test trips.
    expect(gatewaySrc).toMatch(/^\s*clearCleanShutdownMarker,$/m)
    // The old "intentionally NOT imported" comment must be gone.
    expect(gatewaySrc).not.toMatch(/clearCleanShutdownMarker is intentionally NOT imported/)
  })

  it('calls clearCleanShutdownMarker inside the marker-read block at boot', () => {
    // Slice the marker-read block (between the boot.clean_shutdown_*
    // diagnostic logs and the next `if (marker)` line). The clear call
    // MUST appear inside this block, not later in the boot flow —
    // future readers should see the read and clear together.
    const anchor = gatewaySrc.indexOf('boot.clean_shutdown_detected')
    expect(anchor).toBeGreaterThan(-1)
    const slice = gatewaySrc.slice(anchor, anchor + 4000)
    expect(slice).toMatch(/clearCleanShutdownMarker\(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH\)/)
  })

  it('clear comment explains the unhandledRejection edge case', () => {
    // Future maintainers MUST understand why the clear is here.
    // The comment block above the call references the
    // unhandledRejection / "crash path" semantics so the next
    // engineer doesn't remove it as cleanup.
    const callIdx = gatewaySrc.indexOf(
      'clearCleanShutdownMarker(GATEWAY_CLEAN_SHUTDOWN_MARKER_PATH)',
    )
    expect(callIdx).toBeGreaterThan(-1)
    // The 1500 chars immediately before the call should mention the
    // failure mode this fixes (the comment block sits right above
    // the call and is ~1100 chars at current writing).
    const lead = gatewaySrc.slice(Math.max(0, callIdx - 1500), callIdx)
    expect(lead).toMatch(/unhandledRejection|crash path/)
  })
})
