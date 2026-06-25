import { describe, it, expect, afterEach } from 'vitest'
import { mayDrainBufferedInbound } from '../gateway/serialize-drain-gate.js'
import type { EmissionTurnView, CardDrainGateCtx } from '../gateway/emission-authority.js'

/**
 * PR-4d flag-parity proof — the card-drain gate at the façade layer.
 *
 * The emission-authority façade's NEW `mayDrainCardNow` unifies the card-drain
 * single-flight read with the #2137 deliver-before-drain serialization gate,
 * behind the `SWITCHROOM_EMISSION_AUTHORITY` kill-switch. The defining
 * correctness property: flag-OFF ≡ flag-ON ≡ base — the verdict must equal the
 * base single-flight read (`mayDrain(turn)`) on the live foreground card path,
 * for BOTH flag states, across the full input cross-product.
 *
 * §5 modeling decision (the highest-risk call): the gateway threads
 * `endingTurnFinalAnswerDelivered: null` for the CARD path, so
 * `mayDrainBufferedInbound` degenerates to `!turnInFlight`. The card
 * single-flight is governed by `activityInFlight` (via `mayDrain`), NOT by an
 * ending turn's delivery state — so a synthetic represent turn
 * (finalAnswerDelivered=false) can never wedge the live foreground card path.
 *
 * The flag is read ONCE at module top (the asserted read-once invariant). We
 * flip it per flag state by dynamically re-importing the façade module under a
 * unique query string (bun re-evaluates the module, so the read-once const is
 * recomputed against the chosen env). This is a TEST-ONLY seam — it does not
 * touch the production read-once path. Mirrors emission-authority-open-gate.test.ts.
 */

afterEach(() => {
  delete process.env.SWITCHROOM_EMISSION_AUTHORITY
})

let reimportSeq = 0
/**
 * Re-import the façade with the flag set as requested. Bun re-evaluates a module
 * imported under a fresh query string, so the read-once
 * `EMISSION_AUTHORITY_ENABLED` const is recomputed against the env we set here —
 * a test-only seam that leaves the production read-once path untouched.
 */
async function loadFacade(enabled: boolean): Promise<typeof import('../gateway/emission-authority.js')> {
  if (enabled) process.env.SWITCHROOM_EMISSION_AUTHORITY = '1'
  else delete process.env.SWITCHROOM_EMISSION_AUTHORITY
  return import(`../gateway/emission-authority.js?carddraincase=${reimportSeq++}`)
}

// The full cross-product of card-drain-gate inputs.
type Case = {
  /** Single-flight: a drain Promise is in flight (non-null) ⇒ may NOT drain. */
  activityInFlight: boolean
  /** turnInFlightForGate() — claude busy. */
  turnInFlight: boolean
  /** The ending turn's finalAnswerDelivered, as the gate would receive it. */
  endingTurnFinalAnswerDelivered: boolean | null | undefined
  /** SERIALIZE_UNTIL_REPLIED_ENABLED. */
  enabled: boolean
}

function* cases(): Generator<Case> {
  for (const activityInFlight of [false, true]) {
    for (const turnInFlight of [false, true]) {
      for (const endingTurnFinalAnswerDelivered of [true, false, null, undefined] as (
        | boolean
        | null
        | undefined
      )[]) {
        for (const enabled of [false, true]) {
          yield { activityInFlight, turnInFlight, endingTurnFinalAnswerDelivered, enabled }
        }
      }
    }
  }
}

function turnFor(c: Case): EmissionTurnView {
  return { activityInFlight: c.activityInFlight ? Promise.resolve() : null }
}

/**
 * The CARD-path ctx the gateway threads. The §5 decision: the card path always
 * passes `endingTurnFinalAnswerDelivered: null` (NOT the case's raw value — the
 * raw value is swept only to prove the card path is insensitive to it). The
 * single-flight is governed by `activityInFlight`, not delivery state.
 */
function cardCtxFor(c: Case): CardDrainGateCtx {
  return {
    turnInFlight: c.turnInFlight,
    endingTurnFinalAnswerDelivered: null,
    enabled: c.enabled,
  }
}

/** The base oracle: the single-flight read every drain site already performs. */
function baseMayDrain(c: Case): boolean {
  return turnFor(c).activityInFlight == null
}

function keyOf(c: Case): string {
  return `inflight=${c.activityInFlight} turnInFlight=${c.turnInFlight} delivered=${String(
    c.endingTurnFinalAnswerDelivered,
  )} serialize=${c.enabled}`
}

describe('mayDrainCardNow flag-parity — flag OFF ≡ flag ON ≡ base on the foreground card path', () => {
  it('flag OFF: verdict == base single-flight read (mayDrain) for EVERY input', async () => {
    const { EmissionAuthority } = await loadFacade(false)
    for (const c of cases()) {
      const ea = new EmissionAuthority('k')
      const verdict = ea.mayDrainCardNow(turnFor(c), cardCtxFor(c))
      expect(verdict, keyOf(c)).toBe(baseMayDrain(c))
      // OFF is byte-equivalent to plain mayDrain (no deliver-before-drain term).
      expect(verdict, keyOf(c)).toBe(ea.mayDrain(turnFor(c)))
    }
  })

  it('flag ON: verdict == base on the foreground card path for EVERY input (endingTurnFinalAnswerDelivered:null degenerates the gate to !turnInFlight, subsumed by activityInFlight)', async () => {
    const { EmissionAuthority } = await loadFacade(true)
    for (const c of cases()) {
      const ea = new EmissionAuthority('k')
      const verdict = ea.mayDrainCardNow(turnFor(c), cardCtxFor(c))

      // The card path threads endingTurnFinalAnswerDelivered:null, so under the
      // flag the verdict is mayDrain(turn) && mayDrainBufferedInbound({
      // turnInFlight, endingTurnFinalAnswerDelivered:null, enabled }). With
      // delivered=null the predicate degenerates to !turnInFlight.
      const expectedOnVerdict =
        baseMayDrain(c) &&
        mayDrainBufferedInbound({
          turnInFlight: c.turnInFlight,
          endingTurnFinalAnswerDelivered: null,
          enabled: c.enabled,
        })
      expect(verdict, keyOf(c)).toBe(expectedOnVerdict)

      // The DEFINING parity property: when claude is NOT mid-turn (the live
      // foreground card path — the only path a card drain actually fires on,
      // since a drain runs WITHIN the foreground turn), the flag-ON verdict
      // equals base. turnInFlight just short-circuits to false, which the
      // single-flight already covers when activityInFlight is set.
      if (!c.turnInFlight) {
        expect(verdict, keyOf(c)).toBe(baseMayDrain(c))
      }
    }
  })

  it('the synthetic-represent-turn row cannot wedge the card path (finalAnswerDelivered=false + activityInFlight=null ⇒ verdict matches base)', async () => {
    const { EmissionAuthority } = await loadFacade(true)
    // A synthetic represent turn starts finalAnswerDelivered=false. On the
    // buffer-drain path that would BLOCK the gate forever. On the CARD path the
    // gateway threads endingTurnFinalAnswerDelivered:null, so the false-delivery
    // state is NEVER consulted — the card drains exactly as base would.
    const represent: Case = {
      activityInFlight: false, // free single-flight slot
      turnInFlight: false, // the live foreground card path
      endingTurnFinalAnswerDelivered: false, // the represent turn's raw state
      enabled: true, // serialize-until-replied ON
    }
    const ea = new EmissionAuthority('k')
    const verdict = ea.mayDrainCardNow(turnFor(represent), cardCtxFor(represent))
    // base = mayDrain = true (slot free). The represent turn does NOT wedge it.
    expect(verdict).toBe(true)
    expect(verdict).toBe(baseMayDrain(represent))
  })

  it('flag-OFF set == flag-ON set on the foreground card path (cross-product set equality)', async () => {
    const off = await loadFacade(false)
    const on = await loadFacade(true)
    const offVerdicts: string[] = []
    const onVerdicts: string[] = []
    for (const c of cases()) {
      if (c.turnInFlight) continue // not the live foreground card path
      const eaOff = new off.EmissionAuthority('k')
      const eaOn = new on.EmissionAuthority('k')
      offVerdicts.push(`${keyOf(c)} => ${eaOff.mayDrainCardNow(turnFor(c), cardCtxFor(c))}`)
      onVerdicts.push(`${keyOf(c)} => ${eaOn.mayDrainCardNow(turnFor(c), cardCtxFor(c))}`)
    }
    expect(onVerdicts).toEqual(offVerdicts)
    expect(offVerdicts.length).toBeGreaterThan(0)
  })
})

describe('mayDrainCardNow — no-deadlock interleaving (the gateway-acquired lock serializes FIFO; mayDrain stays lock-free)', () => {
  /**
   * The gateway acquires chatLock AROUND the gate; mayDrainCardNow itself is a
   * pure read. This proves two concurrent gate decisions on the same chatKey
   * serialize FIFO under a simple promise-chain lock (the chat-lock contract)
   * and that neither blocks on the pure mayDrain read.
   */
  function makeChainLock() {
    const chains = new Map<string, Promise<unknown>>()
    function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prior = chains.get(key) ?? Promise.resolve()
      const next = prior.then(fn, fn)
      const tracked = next.finally(() => {
        if (chains.get(key) === tracked) chains.delete(key)
      })
      chains.set(key, tracked)
      return next
    }
    return { run }
  }

  it('two concurrent gate calls on the same chatKey serialize FIFO; neither blocks on the pure mayDrain', async () => {
    const { EmissionAuthority } = await loadFacade(true)
    const ea = new EmissionAuthority('k')
    const turn: EmissionTurnView = { activityInFlight: null }
    const ctx: CardDrainGateCtx = {
      turnInFlight: false,
      endingTurnFinalAnswerDelivered: null,
      enabled: true,
    }
    const lock = makeChainLock()
    const order: string[] = []

    // The pure read never touches the lock — callable freely, returns instantly.
    expect(ea.mayDrainCardNow(turn, ctx)).toBe(true)

    const gate = (id: string) =>
      lock.run('k', async () => {
        order.push(`enter-${id}`)
        // The gate decision (pure) runs inside the lock.
        const verdict = ea.mayDrainCardNow(turn, ctx)
        // Yield a microtask to expose any interleaving.
        await Promise.resolve()
        order.push(`exit-${id}`)
        return verdict
      })

    const [v1, v2] = await Promise.all([gate('A'), gate('B')])
    // FIFO: A fully completes before B enters (no interleave).
    expect(order).toEqual(['enter-A', 'exit-A', 'enter-B', 'exit-B'])
    expect(v1).toBe(true)
    expect(v2).toBe(true)
    // The pure read still works AFTER the serialized section — lock-free.
    expect(ea.mayDrainCardNow(turn, ctx)).toBe(true)
  })
})
