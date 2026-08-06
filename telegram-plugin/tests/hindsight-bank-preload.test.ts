import { describe, expect, it } from 'bun:test'

import {
  HINDSIGHT_BANK_GUARD_MARKER,
  hindsightBankGuardTrips,
  resetHindsightBankGuardTrips,
} from '../../tests/vitest-setup/hindsight-bank-guard-core.mjs'

/**
 * Runtime alarm for the BUN half of the Hindsight bank hermeticity guard.
 *
 * vitest loads `tests/vitest-setup/hindsight-bank-guard.mjs` via
 * `test.setupFiles`; `bun test` loads the same file via `[test] preload` in
 * bunfig.toml (repo root) and telegram-plugin/bunfig.toml (CI's bun-test-run
 * has `working-directory: telegram-plugin`, and bun reads the bunfig in its CWD
 * only). Without the bun half, every bun-run test file can still reach the
 * FLEET's Hindsight — which auto-creates a bank on miss, so one stray request
 * mints a bank in the live instance. That is how eleven throwaway banks
 * appeared there on 2026-07-30, one of them named `clerk`, colliding with a
 * live agent and erasing the annotation that documented where that agent's
 * memory actually lives.
 *
 * `npm run lint:hindsight-bank-hermeticity` pins the WIRING statically; this
 * pins the EFFECT, so a bunfig that is present but no longer loading the guard
 * (wrong relative path, bun config-discovery change) fails a test rather than
 * silently un-protecting the runner.
 *
 * Imports the CORE, never the setup file — importing the setup file would
 * INSTALL the guard and let this alarm heal itself. The replay target is
 * 192.0.2.1 (TEST-NET-1, RFC 5737): unroutable, so an unwired run fails on the
 * assertion rather than doing the thing the guard exists to prevent.
 */
describe('bun test runs with the fleet Hindsight blocked', () => {
  it('rejects a bank request to a fleet Hindsight origin', async () => {
    resetHindsightBankGuardTrips()
    let err: unknown
    try {
      await fetch('http://192.0.2.1:18888/v1/default/banks/clerk/config', {
        signal: AbortSignal.timeout(250),
      })
    } catch (e) {
      err = e
    }
    expect(
      String((err as Error | undefined)?.message ?? ''),
      'bunfig.toml `[test] preload` did not install the Hindsight bank guard',
    ).toContain(HINDSIGHT_BANK_GUARD_MARKER)
    expect(hindsightBankGuardTrips()).toBe(1)
  })
})
