/**
 * Runtime boot-smoke pin (finding M-1, full-stack adversarial review).
 *
 * The source-parse pin `gateway-boot-side-effect-gating.test.ts` proves the
 * module-load side effects are `isGatewayMain`-guarded, but it NEVER actually
 * boots the gateway — so it is structurally blind to a temporal-dead-zone
 * ReferenceError inside a guarded builder. That exact class shipped on main:
 * PR-C3 (#3392) made `gatewayLivenessWiringDeps()` eagerly read
 * `pendingInboundBuffer` (a `const` declared ~200 lines LATER than the
 * module-load `silencePoke.startTimer(...)` call that invokes the builder),
 * crash-looping every real gateway boot with
 *   `uncaughtException: ReferenceError: Cannot access 'pendingInboundBuffer'
 *    before initialization`
 * right after the boot lock — while CI stayed green because `isGatewayMain`
 * is false under vitest (argv[1] is the runner).
 *
 * This test closes that blind spot the only way a source parse can't: it
 * SPAWNS `bun telegram-plugin/gateway/gateway.ts` as the process entrypoint
 * (so `isGatewayMain` is TRUE and every guarded module-load side effect
 * actually runs), in a hermetic TELEGRAM_STATE_DIR with a fake bot token, and
 * asserts the gateway reaches a POST-module-eval stderr marker
 * (`ipc — listening`, emitted when `createIpcServer` binds its UDS at
 * gateway.ts ~10454, well past the TDZ site) with NO
 * `uncaughtException: ReferenceError` on the way. The 401-Unauthorized the
 * fake token later triggers happens INSIDE `startGateway()` — after module
 * eval — so it never precedes the marker and is not a boot-order failure.
 *
 * Parameterized over the two kill-switch postures so a future eager-read
 * introduced on either the router-v2 or turn-end-funnel-v2 path is also
 * caught:
 *   - both flags unset (production default — now BOTH v2 ON after the flip)
 *   - SWITCHROOM_INBOUND_ROUTER_V2=1 + SWITCHROOM_TURN_END_FUNNEL_V2=1
 *   - both flags =0 (the escape-hatch legacy v1 posture — kept so the legacy
 *     module-eval paths stay boot-smoked until the legacy delete)
 *
 * Bun is the prod + CI gateway runtime (`bun test` is a required check), so
 * spawning it here is CI-native, not CI-hostile.
 *
 * VERIFIED to red on pre-fix main: reverting the getter fix in the working
 * tree makes both parameterizations fail — the child dies on the ReferenceError
 * and never emits the marker (mutation evidence in the PR body).
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_PATH = resolve(__dirname, '..', 'gateway', 'gateway.ts')

// The marker is emitted synchronously by createIpcServer() at gateway.ts
// (~10454), which is AFTER the module-load silence-poke wiring (~9653) that
// held the TDZ read. Reaching it proves module eval cleared the crash site.
const POST_EVAL_MARKER = 'ipc — listening'
// A fake bot token: valid Bot API shape (<digits>:<35 chars>) so grammy's
// constructor accepts it; the 401 only lands later during startGateway().
const FAKE_BOT_TOKEN = '123456:' + 'A'.repeat(35)
const BOOT_TIMEOUT_MS = 45_000

interface BootResult {
  reachedMarker: boolean
  sawReferenceError: boolean
  stderr: string
}

function bootGateway(extraEnv: Record<string, string>): Promise<BootResult> {
  return new Promise<BootResult>((resolvePromise, rejectPromise) => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gw-boot-smoke-'))
    const child = spawn('bun', [GATEWAY_PATH], {
      env: {
        ...process.env,
        TELEGRAM_STATE_DIR: stateDir,
        SWITCHROOM_GATEWAY_PID_FILE: join(stateDir, 'gateway.pid.json'),
        TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
        SWITCHROOM_AGENT_NAME: 'boot-smoke',
        // Scrub the two kill switches to a known-OFF baseline so the
        // "unset" posture is genuinely unset even if the CI shell exports
        // them; the "enabled" posture re-sets them via extraEnv below.
        SWITCHROOM_INBOUND_ROUTER_V2: '',
        SWITCHROOM_TURN_END_FUNNEL_V2: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    let stderr = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      resolvePromise({
        reachedMarker: stderr.includes(POST_EVAL_MARKER),
        sawReferenceError: /uncaughtException:\s*ReferenceError/.test(stderr),
        stderr,
      })
    }

    const timer = setTimeout(finish, BOOT_TIMEOUT_MS)

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      // As soon as we see the marker OR a boot-order ReferenceError, we have
      // our verdict — no need to keep the child alive.
      if (stderr.includes(POST_EVAL_MARKER) || /uncaughtException:\s*ReferenceError/.test(stderr)) {
        finish()
      }
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { rmSync(stateDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      rejectPromise(err)
    })
    // If the process exits before the marker (e.g. the TDZ crash aborts the
    // process), resolve with whatever we captured so the assertion can fail
    // with the real stderr.
    child.on('exit', finish)
  })
}

const POSTURES: Array<{ name: string; env: Record<string, string> }> = [
  // Flags unset is now the DEFAULT-ON posture (both `!== '0'`) after the
  // v0.18.33 canary flip — the v2 router + v2 turn-end funnel are live.
  { name: 'both kill switches unset (prod default — now BOTH v2 ON)', env: {} },
  {
    name: 'router-v2 + turn-end-funnel-v2 explicitly enabled',
    env: { SWITCHROOM_INBOUND_ROUTER_V2: '1', SWITCHROOM_TURN_END_FUNNEL_V2: '1' },
  },
  {
    // Explicit legacy posture: with both flags defaulting ON, the only way to
    // boot-smoke the legacy (v1) module-eval paths is the `=0` escape hatch.
    name: 'both kill switches disabled (=0 escape hatch — legacy v1 paths)',
    env: { SWITCHROOM_INBOUND_ROUTER_V2: '0', SWITCHROOM_TURN_END_FUNNEL_V2: '0' },
  },
]

describe('gateway boot-smoke (M-1): real bun boot reaches post-module-eval marker with no TDZ ReferenceError', () => {
  it.each(POSTURES)('boots cleanly with %s', async ({ env }) => {
    const result = await bootGateway(env)
    // The load-bearing assertion: no temporal-dead-zone crash during module
    // eval. If this reds, the stderr tail names the offending binding.
    expect(
      result.sawReferenceError,
      `gateway boot emitted a ReferenceError before module eval finished:\n${result.stderr.slice(-2000)}`,
    ).toBe(false)
    // And it actually got past the TDZ site to the IPC-listening marker.
    expect(
      result.reachedMarker,
      `gateway boot never reached "${POST_EVAL_MARKER}"; stderr tail:\n${result.stderr.slice(-2000)}`,
    ).toBe(true)
  }, BOOT_TIMEOUT_MS + 15_000)
})
