/**
 * #3084 follow-up — THE OUTCOME TEST. The leash holds.
 *
 * On 2026-07-11 Telegram flood-banned the `overlord` bot token for 4.6 hours. A
 * Claude Code permission prompt fired during the ban. The gateway raised the
 * card, the send failed, the error was discarded — and the operator never saw
 * it. Sixty minutes later (PERMISSION_TTL_DEFAULT_MS = 60 * 60_000) the TTL
 * sweep would have AUTO-DENIED an approval no human had ever been shown, told
 * the agent the operator declined, and skipped the #2862 missed-approval
 * re-offer (which is anchored on `cards[0]` — empty, because nothing landed).
 *
 * We escaped it only because a human answered in tmux at ~50 minutes.
 *
 * An undeliverable approval must never become a verdict. Ken's call, explicit:
 * HOLD, and make the block visible. Never auto-approve. Never auto-deny — not
 * even on a deadline. `reference/invariants.md` § no-self-escalation, § on-leash.
 *
 * The scenario below is the incident: a 4h flood window, one permission
 * request, and a clock advanced past the TTL.
 *
 * gateway.ts is not unit-importable, so this drives `approval-hold-harness.ts`,
 * which composes the REAL retry policy, the REAL on-disk flood window, the REAL
 * hold decisions and the REAL TTL. Only the Telegram transport and the IPC
 * verdict dispatch are spies — and the verdict spy is the whole point: it is
 * what proves no `deny` was ever fabricated.
 *
 * No fake timers — bun-compatible (see #3097).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, statSync, readFileSync } from 'node:fs'
import { createHarness } from './approval-hold-harness.js'
import { PERMISSION_TTL_DEFAULT_MS } from '../gateway/permission-timeout.js'

const MINUTE = 60_000
const FOUR_HOURS = 4 * 60 * 60_000

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** `ttlFreeze: false` reproduces origin/main — no hold, the TTL still fires. */
function harness(opts: { ttlFreeze?: boolean } = {}) {
  const h = createHarness(opts)
  dirs.push(h.stateDir)
  return h
}

/** The incident: a 4h ban is open, and the agent asks to run a command. */
async function incident(opts: { ttlFreeze?: boolean } = {}) {
  const h = harness(opts)
  h.banFor(FOUR_HOURS)
  await h.raise('req-overlord-1', 'Bash', '{"command":"rm -rf ./build"}')
  await h.settle()
  return h
}

describe('an undeliverable approval is HELD, never denied', () => {
  it('(a) no card is sent while the flood window is open', async () => {
    const h = await incident()

    expect(h.sends.length).toBe(0)
    expect(h.floodRemainingMs()).toBeGreaterThan(0)
    // The agent is still blocked — which is correct. It asked; nobody answered.
    expect(h.pending.has('req-overlord-1')).toBe(true)
    expect(h.verdicts).toEqual([])
  })

  it('(b) the blocked record is on disk immediately — not on a 60s sweep', async () => {
    const h = await incident()

    // Written synchronously in the failure handler. The operator is locked out
    // of Telegram; this record is the ONLY way they learn an agent is blocked,
    // so it must be live in under a second, not up to a minute.
    const rec = h.blockedStore.read()
    expect(rec).not.toBeNull()
    expect(rec!.agent).toBe('overlord')
    expect(rec!.requestId).toBe('req-overlord-1')
    expect(rec!.toolName).toBe('Bash')
    expect(rec!.reason).toBe('flood_wait')
    expect(rec!.action).toBeTruthy()
    expect(rec!.blockedSince).toBeGreaterThan(0)
    expect(rec!.undeliverableSince).toBeGreaterThan(0)
    // The window end, so the surface can say WHEN it comes back.
    expect(rec!.retryableAt - rec!.undeliverableSince).toBeGreaterThan(3 * 60 * 60_000)

    // Readable by a non-owner uid (switchroom-web runs as uid 1000 and cannot
    // read the agent's 0600 state files — a 0600 record = an empty dashboard).
    expect(statSync(h.blockedStore.path).mode & 0o004).toBe(0o004)

    // …and it carries no raw tool input. The file is world-readable; the tool
    // input here is `rm -rf ./build`, and in the general case it is an
    // arbitrary command that may contain a credential.
    const raw = readFileSync(h.blockedStore.path, 'utf-8')
    expect(raw).not.toContain('rm -rf')
    expect(raw).not.toContain('inputPreview')
    expect(raw).not.toContain('input_preview')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // (c) THE LEASH. This is the assertion the incident owes.
  // ─────────────────────────────────────────────────────────────────────────
  it('(c) at T+61min — PAST the 60-minute TTL — NO deny verdict is ever dispatched', async () => {
    const h = await incident()
    expect(PERMISSION_TTL_DEFAULT_MS).toBe(60 * 60_000) // the TTL we must outlive

    // Tick the reaper across the whole TTL and out the other side. On
    // origin/main the sweep fires at exactly this point and auto-denies.
    for (let elapsed = 0; elapsed <= 61 * MINUTE; elapsed += MINUTE) {
      await h.tickSettled()
      h.clock.advance(MINUTE)
    }

    // The agent asked. No human ever saw the ask. So no human ever answered —
    // and the gateway must NOT answer on their behalf.
    expect(h.verdicts).toEqual([])
    expect(h.verdicts.some(v => v.behavior === 'deny')).toBe(false)

    // The request is still pending: the agent stays blocked. An indefinite
    // block is BY DESIGN — /pending and tmux remain the escape hatches.
    expect(h.pending.has('req-overlord-1')).toBe(true)
    expect(h.pending.get('req-overlord-1')?.undeliverable?.reason).toBe('flood_wait')

    // And the operator can still see the block from outside Telegram.
    expect(h.blockedStore.read()?.requestId).toBe('req-overlord-1')
  })

  it('(c-counterfactual) WITHOUT the TTL freeze — origin/main — the same run auto-denies', async () => {
    // This is the bug, reproduced. It is what test (c) above asserts against,
    // and it is why the freeze is load-bearing rather than defensive. If this
    // test ever goes green, the freeze has been removed and (c) is a lie.
    const h = await incident({ ttlFreeze: false })

    for (let elapsed = 0; elapsed <= 61 * MINUTE; elapsed += MINUTE) {
      await h.tickSettled()
      h.clock.advance(MINUTE)
    }

    // A denial the operator never made, for a card they never saw.
    expect(h.verdicts.length).toBe(1)
    expect(h.verdicts[0]!.behavior).toBe('deny')
    expect(h.pending.has('req-overlord-1')).toBe(false)
    // …and it never landed a card, so it never sent one either.
    expect(h.sends.length).toBe(0)
  })

  it('(d) past the ban, the card lands EXACTLY once — no loss, no duplicate', async () => {
    const h = await incident()

    // Ride out the full 4h ban, ticking every minute as the reaper does.
    for (let elapsed = 0; elapsed < FOUR_HOURS; elapsed += MINUTE) {
      await h.tickSettled()
      h.clock.advance(MINUTE)
    }
    expect(h.sends.length).toBe(0) // nothing escaped during the ban

    // Window closes.
    h.clock.advance(2 * MINUTE)
    await h.tickSettled()

    expect(h.sends.length).toBe(1)
    expect(h.sends[0]!.requestId).toBe('req-overlord-1')

    // Keep ticking — the card must not be re-posted, and must not now expire
    // instantly against a TTL that ran while the operator could not answer.
    for (let i = 0; i < 10; i++) {
      h.clock.advance(MINUTE)
      await h.tickSettled()
    }
    expect(h.sends.length).toBe(1)
    expect(h.verdicts).toEqual([])
    expect(h.pending.has('req-overlord-1')).toBe(true)

    // We never issued a request into a window we already knew was open — the
    // #3094 amplifier guard held for the whole run.
    expect(h.sentIntoOpenWindow).toBe(false)
  })

  it('(d2) the TTL clock RESTARTS on delivery — the operator gets a full window', async () => {
    const h = await incident()

    h.clock.advance(FOUR_HOURS + MINUTE)
    await h.tickSettled() // re-delivers
    expect(h.sends.length).toBe(1)

    // Without the startedAt reset, the card lands already 4h old against a
    // 60-min TTL and the very next tick auto-denies it — we would have MOVED
    // the silent denial, not removed it.
    h.clock.advance(59 * MINUTE)
    await h.tickSettled()
    expect(h.verdicts).toEqual([])
    expect(h.pending.has('req-overlord-1')).toBe(true)
  })

  it('(e) a tap on the re-delivered card resolves the ORIGINAL requestId', async () => {
    const h = await incident()

    h.clock.advance(FOUR_HOURS + MINUTE)
    await h.tickSettled()
    expect(h.sends.length).toBe(1)

    // The operator finally sees the card and taps Allow.
    h.tap('req-overlord-1', 'allow')

    // The verdict carries the ORIGINAL request id — the id the suspended claude
    // turn is blocked on. A new id would dispatch into the void and the agent
    // would stay wedged forever.
    expect(h.verdicts).toEqual([{ requestId: 'req-overlord-1', behavior: 'allow' }])
    expect(h.pending.has('req-overlord-1')).toBe(false)
    // The block is over — the surface goes quiet.
    expect(h.blockedStore.read()).toBeNull()
  })

  // F6 — the leash hole review found. Only LONG flood-waits (>120s) raise
  // FLOOD_WAIT_ACTIVE. A short-but-persistent 429, a network partition, a Telegram
  // 5xx, or a full disk all produce a plain GIVE-UP — and every one of them was
  // still auto-denying a card the operator never saw. Same breach as the incident,
  // different first cause. The rule is about whether the operator got to answer,
  // not about which fault shut the channel.
  it('(c2) a NETWORK give-up is held too — the leash is not flood-specific', async () => {
    const h = harness()
    dirs.push(h.stateDir)
    h.breakTarget('-100200', 'econnreset')  // network partition, not a flood ban
    await h.raise('req-net', 'Bash', '{"command":"rm -rf ./build"}')
    await h.settle()

    expect(h.sends.length).toBe(0)
    expect(h.pending.get('req-net')?.undeliverable?.reason).toBe('transient')
    expect(h.blockedStore.read()?.requestId).toBe('req-net')

    // Past the 60-minute TTL — still no fabricated verdict.
    for (let elapsed = 0; elapsed <= 61 * MINUTE; elapsed += MINUTE) {
      await h.tickSettled()
      h.clock.advance(MINUTE)
    }
    expect(h.verdicts).toEqual([])
    expect(h.pending.has('req-net')).toBe(true)
  })

  it('the whole run dispatches exactly ONE verdict, and it is the operator’s', async () => {
    const h = await incident()

    for (let elapsed = 0; elapsed < FOUR_HOURS + 5 * MINUTE; elapsed += MINUTE) {
      await h.tickSettled()
      h.clock.advance(MINUTE)
    }
    h.tap('req-overlord-1', 'allow')

    expect(h.sends.length).toBe(1)
    expect(h.verdicts).toEqual([{ requestId: 'req-overlord-1', behavior: 'allow' }])
  })
})

/** Source-text pins for the three gateway changes (gateway.ts isn't importable). */
describe('gateway wiring — the leash', () => {
  const GATEWAY_SRC = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('the TTL sweep skips held entries entirely', () => {
    const sweepStart = GATEWAY_SRC.indexOf('for (const [k, v] of pendingPermissions) {')
    expect(sweepStart).toBeGreaterThan(-1)
    const sweep = GATEWAY_SRC.slice(sweepStart, sweepStart + 2500)
    // The freeze must come BEFORE the TTL comparison, or it does nothing.
    const freeze = sweep.indexOf('if (isHeldUndeliverable(v)) continue')
    const ttlCheck = sweep.indexOf('if (now - v.startedAt > ttl)')
    expect(freeze).toBeGreaterThan(-1)
    expect(ttlCheck).toBeGreaterThan(-1)
    expect(freeze).toBeLessThan(ttlCheck)
  })

  it('successful (re)delivery resets startedAt', () => {
    expect(GATEWAY_SRC).toContain('live.startedAt = Date.now()')
  })

  it('the missed-approvals re-offer no longer drops a card that never landed', () => {
    // The cards[0] hole: `origin === undefined` meant the auto-deny ALSO erased
    // the request from the only record that would have re-offered it.
    expect(GATEWAY_SRC).toContain('v.cards[0] ?? resolvePermissionCardTargets()[0]')
  })

  it('nothing in the permission path auto-approves', () => {
    // Never, under any circumstance. A held approval that "times out" into an
    // allow would be the worst possible reading of Ken's call.
    const sweepStart = GATEWAY_SRC.indexOf('for (const [k, v] of pendingPermissions) {')
    const sweep = GATEWAY_SRC.slice(sweepStart, sweepStart + 2500)
    expect(sweep).not.toContain("behavior: 'allow'")
  })
})
