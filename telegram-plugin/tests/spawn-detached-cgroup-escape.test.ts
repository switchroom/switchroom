/**
 * Regression test for #177: detached spawns from the gateway must escape
 * the gateway's cgroup so a gateway restart (kicked off by the same
 * detached child as part of /new or auto-failover) doesn't cgroup-kill
 * the child mid-flight before it can reach the second systemctl call.
 *
 * The fix wraps every spawn through `systemd-run --user --scope --collect`
 * when systemd-run is available, falling back to direct spawn on hosts
 * without it (dev containers, CI without systemd-user).
 *
 * This is a structural source-grep test rather than a runtime exercise
 * because spawnSwitchroomDetached isn't exported and exercising the
 * actual cgroup behaviour requires a real systemd session.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = resolve(fileURLToPath(import.meta.url), '..')
const REPO_ROOT = resolve(TEST_DIR, '..', '..')

describe('spawnSwitchroomDetached cgroup-escape (#177)', () => {
  const src = readFileSync(
    join(REPO_ROOT, 'telegram-plugin/gateway/gateway.ts'),
    'utf-8',
  )

  it('declares a resolveSystemdRunPath helper', () => {
    expect(src).toContain('function resolveSystemdRunPath(')
  })

  it('uses --scope --collect via systemd-run when available', () => {
    expect(src).toContain("'--user', '--scope', '--collect'")
  })

  it('uses --quiet so the wrapper does not log a banner per spawn', () => {
    expect(src).toMatch(/'--user',\s*'--scope',\s*'--collect',\s*'--quiet'/)
  })

  it('falls back to direct spawn when systemd-run is unavailable', () => {
    // The fallback path should still pass SWITCHROOM_CLI as the spawn
    // binary; the systemd-run path adds it as an arg via `--`.
    expect(src).toMatch(/spawnBin\s*=\s*systemdRun\s*\?\?\s*SWITCHROOM_CLI/)
  })

  it('caches the resolution per process (no command -v on every spawn)', () => {
    expect(src).toContain('let _systemdRunPath')
    expect(src).toMatch(/if\s*\(_systemdRunPath\s*!==\s*undefined\)\s*return/)
  })
})
