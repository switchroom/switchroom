import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  decideOverPing,
  type OverPingDecision,
} from '../over-ping-safety-net.js'
import type {
  PingClaimInput,
  PingClaimCtx,
} from '../gateway/emission-authority.js'

/**
 * PR-4c flag-parity proof — the HEART of the PR, at the façade layer.
 *
 * The emission-authority façade's `claimOrDowngradePing` now RELOCATES the
 * over-ping ownership decision behind the `SWITCHROOM_EMISSION_AUTHORITY`
 * kill-switch. The defining correctness property: flag-OFF ≡ flag-ON ≡ the
 * direct `decideOverPing` oracle — not one device ping differs in either flag
 * state. This drives `claimOrDowngradePing(input, ctx, applyDecision, disabled)`
 * across the full cross-product:
 *
 *   incoming {ack, substantive, silent} × slot-held-by {none, ack-held,
 *   substantive-held}
 *
 * for BOTH flag states, against a fake turn + a stub `applyDecision` that
 * records `(suppress, claimSlot, upgrade)` and APPLIES the mutations (the atomic
 * `firstPingAt`/`firstPingWasSubstantive` pair-set), exactly like the gateway
 * call site. It asserts:
 *
 *   - flag-ON outcome set == flag-OFF outcome set == direct `decideOverPing`
 *     oracle set (the parity proof).
 *   - after a claim/upgrade the `firstPingAt`/`firstPingWasSubstantive` pair is
 *     consistently set (the #2562 atomicity invariant).
 *   - the at-most-once UPGRADE via the ack→upgrade→trailing-ack sequence.
 *
 * The flag is read ONCE at module top (the asserted read-once invariant — we do
 * NOT change that). We flip it per flag state by dynamically re-importing the
 * façade module under a unique query string (bun/vite re-evaluates the module,
 * so the read-once const is recomputed against the chosen env). This is a
 * TEST-ONLY seam — it leaves the production read-once path untouched. Mirrors
 * the `loadFacade` seam in emission-authority-open-gate.test.ts. NO sqlite
 * import, so this runs cleanly under both vitest and bun.
 */

const NOW = 1_700_000_000_000
const PRIOR_PING_AT = NOW - 5_000

afterEach(() => {
  delete process.env.SWITCHROOM_EMISSION_AUTHORITY
})

let reimportSeq = 0
async function loadFacade(
  enabled: boolean,
): Promise<typeof import('../gateway/emission-authority.js')> {
  if (enabled) process.env.SWITCHROOM_EMISSION_AUTHORITY = '1'
  else delete process.env.SWITCHROOM_EMISSION_AUTHORITY
  return import(`../gateway/emission-authority.js?pingcase=${reimportSeq++}`)
}

/** A minimal stand-in for the turn's ping-slot state. */
interface FakeTurn {
  firstPingAt: number | null
  firstPingWasSubstantive: boolean
}

type SlotHeld = 'none' | 'ack' | 'substantive'
type Incoming = 'ack' | 'substantive' | 'silent'

function turnFor(slot: SlotHeld): FakeTurn {
  switch (slot) {
    case 'none':
      return { firstPingAt: null, firstPingWasSubstantive: false }
    case 'ack':
      return { firstPingAt: PRIOR_PING_AT, firstPingWasSubstantive: false }
    case 'substantive':
      return { firstPingAt: PRIOR_PING_AT, firstPingWasSubstantive: true }
  }
}

function inputFor(incoming: Incoming): PingClaimInput {
  switch (incoming) {
    case 'silent':
      return { modelRequestedPing: false, substantive: false }
    case 'ack':
      return { modelRequestedPing: true, substantive: false }
    case 'substantive':
      return { modelRequestedPing: true, substantive: true }
  }
}

/** The recorded outcome of one drive — what the call site would observe. */
interface Outcome {
  suppress: boolean
  claimSlot: boolean
  upgrade: boolean
  /** Post-state of the (atomic) pair after applyDecision ran. */
  firstPingAt: number | null
  firstPingWasSubstantive: boolean
  /** Did the call-site closure write disableNotification=true? */
  disableNotification: boolean
}

/**
 * Drive `claimOrDowngradePing` once for the given flag state, mirroring the
 * gateway call site: the `applyDecision` thunk records the decision AND applies
 * the atomic pair-set + the disableNotification closure write; the `disabled`
 * thunk computes its own decision via the literal `decideOverPing` and routes it
 * through the SAME `applyDecision`.
 */
async function drive(
  enabled: boolean,
  incoming: Incoming,
  slot: SlotHeld,
): Promise<Outcome> {
  const { EmissionAuthority } = await loadFacade(enabled)
  const turn = turnFor(slot)
  const input = inputFor(incoming)
  const ctx: PingClaimCtx = {
    firstPingAt: turn.firstPingAt,
    firstPingWasSubstantive: turn.firstPingWasSubstantive,
    nowMs: NOW,
  }
  const replySubstantive = input.substantive
  let disableNotification = false
  let recorded: OverPingDecision | null = null

  const applyDecision = (decision: OverPingDecision): void => {
    recorded = decision
    if (decision.suppress) {
      disableNotification = true
    } else if (decision.claimSlot) {
      // The atomic two-adjacent-line pair-set (no await between).
      turn.firstPingAt = NOW
      turn.firstPingWasSubstantive = replySubstantive
    }
  }

  new EmissionAuthority('k').claimOrDowngradePing(
    input,
    ctx,
    applyDecision,
    () => {
      const decision = decideOverPing({
        modelRequestedPing: input.modelRequestedPing,
        firstPingAt: turn.firstPingAt,
        substantive: replySubstantive,
        firstPingWasSubstantive: turn.firstPingWasSubstantive,
        nowMs: NOW,
      })
      applyDecision(decision)
    },
  )

  const d = recorded as OverPingDecision | null
  if (d == null) throw new Error('applyDecision was never called')
  return {
    suppress: d.suppress,
    claimSlot: d.claimSlot,
    upgrade: d.upgrade,
    firstPingAt: turn.firstPingAt,
    firstPingWasSubstantive: turn.firstPingWasSubstantive,
    disableNotification,
  }
}

/** The direct oracle: `decideOverPing` over the same inputs, then the effects. */
function oracle(incoming: Incoming, slot: SlotHeld): Outcome {
  const turn = turnFor(slot)
  const input = inputFor(incoming)
  const decision = decideOverPing({
    modelRequestedPing: input.modelRequestedPing,
    firstPingAt: turn.firstPingAt,
    substantive: input.substantive,
    firstPingWasSubstantive: turn.firstPingWasSubstantive,
    nowMs: NOW,
  })
  let disableNotification = false
  if (decision.suppress) {
    disableNotification = true
  } else if (decision.claimSlot) {
    turn.firstPingAt = NOW
    turn.firstPingWasSubstantive = input.substantive
  }
  return {
    suppress: decision.suppress,
    claimSlot: decision.claimSlot,
    upgrade: decision.upgrade,
    firstPingAt: turn.firstPingAt,
    firstPingWasSubstantive: turn.firstPingWasSubstantive,
    disableNotification,
  }
}

const INCOMING: Incoming[] = ['ack', 'substantive', 'silent']
const SLOTS: SlotHeld[] = ['none', 'ack', 'substantive']

describe('claimOrDowngradePing flag-parity — flag-ON ≡ flag-OFF ≡ decideOverPing oracle', () => {
  for (const incoming of INCOMING) {
    for (const slot of SLOTS) {
      it(`incoming=${incoming} slot-held-by=${slot}: ON == OFF == oracle`, async () => {
        const off = await drive(false, incoming, slot)
        const on = await drive(true, incoming, slot)
        const want = oracle(incoming, slot)
        expect(off).toEqual(want)
        expect(on).toEqual(want)
        // Atomicity: after a claim/upgrade the pair is consistently set.
        if (on.claimSlot) {
          expect(on.firstPingAt).toBe(NOW)
          expect(on.firstPingWasSubstantive).toBe(incoming === 'substantive')
        }
      })
    }
  }

  it('full set equality — the ON outcome set equals the OFF set equals the oracle set', async () => {
    const onSet: Outcome[] = []
    const offSet: Outcome[] = []
    const oracleSet: Outcome[] = []
    for (const incoming of INCOMING) {
      for (const slot of SLOTS) {
        offSet.push(await drive(false, incoming, slot))
        onSet.push(await drive(true, incoming, slot))
        oracleSet.push(oracle(incoming, slot))
      }
    }
    expect(onSet).toEqual(oracleSet)
    expect(offSet).toEqual(oracleSet)
  })
})

describe('claimOrDowngradePing — the documented R8 ownership outcomes', () => {
  it('substantive over an ack-held slot UPGRADES (pings + claims, no suppress)', async () => {
    for (const enabled of [false, true]) {
      const o = await drive(enabled, 'substantive', 'ack')
      expect(o.suppress).toBe(false)
      expect(o.claimSlot).toBe(true)
      expect(o.upgrade).toBe(true)
      expect(o.disableNotification).toBe(false)
      // The slot is upgraded to substantive.
      expect(o.firstPingAt).toBe(NOW)
      expect(o.firstPingWasSubstantive).toBe(true)
    }
  })

  it('ack over a substantive-held slot SUPPRESSES (no spurious double-ping)', async () => {
    for (const enabled of [false, true]) {
      const o = await drive(enabled, 'ack', 'substantive')
      expect(o.suppress).toBe(true)
      expect(o.claimSlot).toBe(false)
      expect(o.disableNotification).toBe(true)
    }
  })

  it('substantive over a substantive-held slot SUPPRESSES (#1674 answer+wrap-up guard)', async () => {
    for (const enabled of [false, true]) {
      const o = await drive(enabled, 'substantive', 'substantive')
      expect(o.suppress).toBe(true)
      expect(o.claimSlot).toBe(false)
    }
  })

  it('first ping (no slot held) CLAIMS without upgrade', async () => {
    for (const enabled of [false, true]) {
      const o = await drive(enabled, 'ack', 'none')
      expect(o.suppress).toBe(false)
      expect(o.claimSlot).toBe(true)
      expect(o.upgrade).toBe(false)
      expect(o.firstPingAt).toBe(NOW)
    }
  })

  it('silent incoming is a no-op (the safety net never touches a model-silent reply)', async () => {
    for (const enabled of [false, true]) {
      for (const slot of SLOTS) {
        const o = await drive(enabled, 'silent', slot)
        expect(o.suppress).toBe(false)
        expect(o.claimSlot).toBe(false)
        expect(o.upgrade).toBe(false)
        expect(o.disableNotification).toBe(false)
      }
    }
  })
})

describe('claimOrDowngradePing — at-most-once upgrade (ack → upgrade → trailing-ack)', () => {
  /**
   * Drive a 3-reply turn against ONE persistent fake turn (the façade decides,
   * the applyDecision thunk mutates the shared turn): an interim ACK claims the
   * slot, the SUBSTANTIVE answer UPGRADES it (one bounded second ping), and a
   * trailing ACK is then SUPPRESSED — at most ONE upgrade per turn.
   */
  async function driveSequence(
    enabled: boolean,
  ): Promise<{ upgrades: number; pings: number; suppresses: number }> {
    const { EmissionAuthority } = await loadFacade(enabled)
    const turn: FakeTurn = { firstPingAt: null, firstPingWasSubstantive: false }
    const ea = new EmissionAuthority('k')
    let upgrades = 0
    let pings = 0
    let suppresses = 0
    let tick = 0

    const step = (incoming: Incoming): void => {
      const input = inputFor(incoming)
      const replySubstantive = input.substantive
      const now = NOW + tick++
      const ctx: PingClaimCtx = {
        firstPingAt: turn.firstPingAt,
        firstPingWasSubstantive: turn.firstPingWasSubstantive,
        nowMs: now,
      }
      const applyDecision = (decision: OverPingDecision): void => {
        if (decision.upgrade) upgrades++
        if (decision.suppress) suppresses++
        if (decision.claimSlot) {
          // A claim/upgrade lets the ping through.
          pings++
          turn.firstPingAt = now
          turn.firstPingWasSubstantive = replySubstantive
        }
      }
      ea.claimOrDowngradePing(input, ctx, applyDecision, () => {
        const decision = decideOverPing({
          modelRequestedPing: input.modelRequestedPing,
          firstPingAt: turn.firstPingAt,
          substantive: replySubstantive,
          firstPingWasSubstantive: turn.firstPingWasSubstantive,
          nowMs: now,
        })
        applyDecision(decision)
      })
    }

    step('ack') // interim ack — claims the slot (first ping)
    step('substantive') // answer — UPGRADES over the ack's slot (second ping)
    step('ack') // trailing ack — suppressed
    return { upgrades, pings, suppresses }
  }

  for (const enabled of [false, true]) {
    it(`flag ${enabled ? 'ON' : 'OFF'}: exactly one upgrade, two pings (ack-claim + answer-upgrade), one suppress`, async () => {
      const { upgrades, pings, suppresses } = await driveSequence(enabled)
      expect(upgrades).toBe(1)
      expect(pings).toBe(2)
      expect(suppresses).toBe(1)
    })
  }
})

describe('claimOrDowngradePing — no await in the synchronous decide→apply→pair-set chain (source-read)', () => {
  const facadeSrc = readFileSync(
    resolve(__dirname, '..', 'gateway', 'emission-authority.ts'),
    'utf-8',
  )
  // #2996 P2: the over-ping call site moved VERBATIM (with executeReply's
  // body) into outbound-send-path.ts `sendReply()`; the await-free window
  // assertion reads there. Contract unchanged.
  const gatewaySrc = readFileSync(
    resolve(__dirname, '..', 'gateway', 'outbound-send-path.ts'),
    'utf-8',
  )

  it('the façade method is synchronous and await-free', () => {
    expect(facadeSrc).not.toMatch(/async\s+claimOrDowngradePing/)
    const after = facadeSrc.split('claimOrDowngradePing(')[1] ?? ''
    const body = after.split(/\n  [A-Za-z]+[(<]/)[0] ?? after
    expect(body).not.toMatch(/\bawait\b/)
  })

  it('the call-site over-ping block is await-free (atomic pair-set preserved)', () => {
    // Bound the window to the over-ping block itself — from the
    // `applyOverPingDecision` thunk to the end of the `claimOrDowngradePing`
    // call, BEFORE the Telegraph block below (which legitimately awaits).
    const blockStart = gatewaySrc.indexOf('const applyOverPingDecision')
    const telegraphIdx = gatewaySrc.indexOf('// Telegraph publish (#579)', blockStart)
    expect(blockStart).toBeGreaterThan(-1)
    expect(telegraphIdx).toBeGreaterThan(blockStart)
    const block = gatewaySrc.slice(blockStart, telegraphIdx)
    // Strip comment lines so a prose "no await between" in a doc-comment does
    // not trip the executable-await check.
    const blockCode = block
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
      })
      .join('\n')
    // Sanity: the single claimOrDowngradePing call is inside this window.
    expect(blockCode).toMatch(/\.claimOrDowngradePing\(/)
    expect(blockCode).not.toMatch(/\bawait\b/)
    // The two-adjacent-line pair-set is intact.
    expect(block).toMatch(
      /turn\.firstPingAt = now\s*\n\s*turn\.firstPingWasSubstantive = replySubstantive/,
    )
  })
})
