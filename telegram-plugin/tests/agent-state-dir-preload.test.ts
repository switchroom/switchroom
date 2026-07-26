import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * Runtime alarm for the BUN half of the state-dir hermeticity guard.
 *
 * vitest loads `tests/vitest-setup/agent-state-dir-guard.mjs` via
 * `test.setupFiles`; `bun test` loads the same file via `[test] preload` in
 * bunfig.toml (repo root) and telegram-plugin/bunfig.toml (CI's bun-test-run
 * has `working-directory: telegram-plugin`, and bun reads the bunfig in its CWD
 * only). Without the bun half, ~75 bun-run test files still default every agent
 * state writer to `/state/agent` — inside an agent container that is a LIVE
 * agent's bind-mounted state dir, which is exactly how 356 synthetic turn rows
 * ended up in production `turns.jsonl` files and were scored as real drift by
 * the fleet-health sensor.
 *
 * `npm run lint:agent-state-dir-hermeticity` pins the WIRING statically; this
 * pins the EFFECT, so a bunfig that is present but no longer loading the guard
 * (wrong relative path, bun config-discovery change) fails a test rather than
 * silently un-protecting the runner.
 */
describe('bun test runs with the agent state dir redirected', () => {
  for (const k of ['SWITCHROOM_AGENT_STATE_DIR', 'SWITCHROOM_RUNTIME_STATE_DIR']) {
    it(`${k} points at a tmp dir, not a live agent state dir`, () => {
      const v = process.env[k]
      expect(v, `${k} unset — bunfig.toml \`[test] preload\` did not run`).toBeTruthy()
      expect(v).not.toBe('/state/agent')
      expect(v!.startsWith(tmpdir())).toBe(true)
      expect(existsSync(v!)).toBe(true)
    })
  }
})
