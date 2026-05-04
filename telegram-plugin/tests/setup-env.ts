/**
 * Shared vitest setup. Runs once per worker before any test file loads.
 *
 * P4a of #662 — the production default for `TWO_ZONE_CARD` flipped to ON
 * (i.e. "any value other than '0' selects the two-zone renderer"). The
 * legacy `renderSubAgentExpandable` path is still wired in `render()` and
 * is exercised by a large body of pre-existing tests that assert on the
 * legacy HTML shape. Until P4b deletes the legacy code, those tests must
 * keep running against the legacy path — so this setup pins the env to
 * `0` (opt-out) by default. Tests that want to exercise the new default
 * path can override per-test with `process.env.TWO_ZONE_CARD = '1'`
 * (see e.g. `two-zone-card-lifecycle.test.ts`).
 */
process.env.TWO_ZONE_CARD = process.env.TWO_ZONE_CARD ?? '0'
