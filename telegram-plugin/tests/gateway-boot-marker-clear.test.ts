/**
 * Structural pin for the boot-time turn-active marker cleanup
 * (regression coverage for the 2026-05-01 flap-loop incident).
 *
 * What broke: an interrupted turn left `<stateDir>/turn-active.json`
 * on disk. The next gateway boot saw the orphan; the watchdog read its
 * mtime, computed `age >= TURN_HANG_SECS` (300s default), and
 * restarted the agent — which killed the gateway mid-cleanup, leaving
 * the marker again. Result: 2-min flap loop, observed live on `clerk`.
 *
 * The fix: gateway calls `removeTurnActiveMarker(STATE_DIR)` once at
 * boot, inside the `!didOneTimeSetup` block (so it runs only on the
 * first poll-loop entry, not on every retry attempt). By definition
 * no turn can be in flight when the gateway just started — any
 * leftover marker is from a turn that didn't complete.
 *
 * The unit tests in `turn-active-marker.test.ts` already cover the
 * primitive's behaviour. This test pins the *call site* — fails
 * loudly if a future refactor moves or removes the boot-time clear.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf8',
)

describe('gateway boot — clear stale turn-active marker', () => {
  it('removeTurnActiveMarker is called exactly once inside the !didOneTimeSetup block', () => {
    // Locate the one-time setup block. It's gated on `!didOneTimeSetup`
    // and runs after the first successful `bot.api.getMe()` so the
    // clear only happens once per process lifetime.
    const setupBlockStart = GATEWAY_SRC.indexOf('if (!didOneTimeSetup)')
    expect(setupBlockStart).toBeGreaterThan(0)

    // The clear should land near the top of that block — before
    // pin-sweep, before any boot-card emission. Bound the search
    // window to ~5KB so we don't pick up the unrelated
    // `removeTurnActiveMarker` call in the onTurnComplete handler
    // way down at the bottom of the file.
    const setupWindow = GATEWAY_SRC.slice(setupBlockStart, setupBlockStart + 12000)
    const clearMatches = setupWindow.match(/removeTurnActiveMarker\s*\(\s*STATE_DIR\s*\)/g) ?? []
    expect(clearMatches.length).toBe(1)
  })

  it('clear is wrapped in try/catch so a disk error never blocks boot', () => {
    // The clear is best-effort — a transient EBUSY or permission glitch
    // must not prevent the gateway from coming up. Pin the try-wrapping
    // to make sure a future refactor doesn't drop it.
    const setupBlockStart = GATEWAY_SRC.indexOf('if (!didOneTimeSetup)')
    const setupWindow = GATEWAY_SRC.slice(setupBlockStart, setupBlockStart + 12000)
    expect(setupWindow).toMatch(/try\s*\{\s*removeTurnActiveMarker\(STATE_DIR\)\s*\}\s*catch/)
  })

  it('clear runs before the boot-time pin sweep (not after)', () => {
    // Ordering pin: pin sweep can be slow (many chats × API calls).
    // Clearing the marker first means the watchdog sees a clean slate
    // immediately, even if pin sweep takes 30s+ to finish.
    const setupBlockStart = GATEWAY_SRC.indexOf('if (!didOneTimeSetup)')
    const setupWindow = GATEWAY_SRC.slice(setupBlockStart, setupBlockStart + 12000)
    const clearIdx = setupWindow.indexOf('removeTurnActiveMarker(STATE_DIR)')
    const pinSweepIdx = setupWindow.indexOf('Boot-time pin sweep')
    expect(clearIdx).toBeGreaterThan(0)
    expect(pinSweepIdx).toBeGreaterThan(0)
    expect(clearIdx).toBeLessThan(pinSweepIdx)
  })
})
