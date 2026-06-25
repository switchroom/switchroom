/**
 * PR-4e — per-topic `currentTurn` map behind the emission-authority kill-switch.
 *
 * The single ambient/global `currentTurn` singleton (one foreground turn at a
 * time) is replaced by a per-topic `currentTurnByKey` map keyed on chat+thread,
 * behind `SWITCHROOM_EMISSION_AUTHORITY` (default OFF).
 *
 * KEY FRAMING: the `claude` CLI is genuinely SEQUENTIAL — never two turns
 * executing CPU-simultaneously. 4e is NOT about concurrent execution. It is
 * about the ISOLATION of per-topic emission STATE so a LATE async event for
 * topic A (a deferred drain, the orphaned-reply backstop, a ping decision, the
 * answer-stream suppressor) that fires AFTER the live turn flipped to topic B
 * resolves A's authority instead of contaminating B's card / ping / single-flight
 * state.
 *
 * DEFINING PROPERTY: flag-OFF ≡ flag-ON ≡ base — machine-proven by the parity
 * test below.
 *
 * This file has two halves:
 *  (a) a SOURCE-READ structural oracle over gateway.ts (the IIFE can't be
 *      instantiated in-process — same pattern as silence-liveness-wiring.test),
 *  (b) a BEHAVIOURAL in-process harness driving current-turn-map.ts via the
 *      re-import-per-flag seam (mirrors emission-authority-card-drain-gate.test's
 *      `loadFacade`).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8')

// ---------------------------------------------------------------------------
// (a) SOURCE-READ STRUCTURAL ORACLE
// ---------------------------------------------------------------------------

describe('PR-4e source-read oracle — the wiring the per-topic map depends on', () => {
  it('exactly ONE per-topic CurrentTurnMap is constructed in the gateway', () => {
    const decls = gatewaySrc.match(/new CurrentTurnMap<CurrentTurn>\(\)/g) ?? []
    expect(decls.length).toBe(1)
    // And it is imported from the dedicated module (not inlined).
    expect(gatewaySrc).toMatch(/import \{ CurrentTurnMap \} from '\.\/current-turn-map\.js'/)
  })

  it('all 4 write sites route through the keyed accessors — zero RAW `currentTurn = ` outside the accessor bodies', () => {
    // The ONLY permitted `currentTurn = ` assignments are: the initial `let`
    // null, and the three lines inside setCurrentTurn / endCurrentTurnForKey /
    // clearAllCurrentTurns that keep the module-scope mirror in lock-step with
    // the map. Every behavioural write site (turn ctor, endCurrentTurnAtomic,
    // silence-poke fallback, disconnect-flush) goes through an accessor.
    const rawAssigns = gatewaySrc.match(/^[^/\n]*\bcurrentTurn = (?!currentTurnMap\.get\(\)|null$)/gm) ?? []
    expect(rawAssigns, `unexpected raw currentTurn assignment(s): ${JSON.stringify(rawAssigns)}`).toEqual([])

    // The turn ctor SET routes through setCurrentTurn with the statusKey.
    expect(gatewaySrc).toMatch(/setCurrentTurn\(next, statusKey\(ev\.chatId, enqThreadIdNum\)\)/)
    // The disconnect-flush clears the WHOLE map (every entry is a ghost).
    expect(gatewaySrc).toMatch(/clearAllCurrentTurns\(\)/)
    // The silence-poke fallback does a keyed delete for the wedged turn's key.
    expect(gatewaySrc).toMatch(/endCurrentTurnForKey\(wedgedTurn, fbKey\)/)
  })

  it('endCurrentTurnAtomic closes the leak AT ORIGIN — keyed liveness guard + keyed delete', () => {
    const body = gatewaySrc
      .split('function endCurrentTurnAtomic(turn: CurrentTurn): void {')[1]
      ?.split('\n}')[0] ?? ''
    expect(body.length).toBeGreaterThan(50)
    // Guard is the keyed liveness check (NOT a bare singleton ===).
    expect(body).toMatch(/turnLiveForItsTopic\(turn\)/)
    // The clear is the keyed delete (leak-close-at-origin).
    expect(body).toMatch(/endCurrentTurnForKey\(turn, key\)/)
  })

  it('the keyed accessor flag-branches in EXACTLY one place each (in current-turn-map.ts, not the gateway)', () => {
    const mapSrc = readFileSync(
      resolve(__dirname, '..', 'gateway', 'current-turn-map.ts'),
      'utf-8',
    )
    // The map is the single home of the per-topic store + flag read-once.
    expect(mapSrc).toMatch(/process\.env\.SWITCHROOM_EMISSION_AUTHORITY === '1'/)
    expect(mapSrc).toMatch(/readonly byKey = new Map<string, T>\(\)/)
  })

  it('the 3 liveness-comparison reads are keyed under the flag (NOT a bare singleton === under flag-ON)', () => {
    // Each of the three behaviourally load-bearing comparison sites must, under
    // the flag, resolve THIS turn by ITS OWN topic key. We assert the keyed
    // form appears the expected number of times AND the literal flag-OFF form is
    // retained (the silence-liveness-wiring oracle requires `currentTurn === turn`).
    const keyedLiveness = gatewaySrc.match(
      /EMISSION_AUTHORITY_ENABLED \? turnLiveForItsTopic\(turn\) : currentTurn === turn/g,
    ) ?? []
    expect(keyedLiveness.length).toBe(3)
  })

  it('findTurnByOriginId resolves the LIVE turn by its OWN key under the flag (O(1) byKey.get)', () => {
    const body = gatewaySrc
      .split('function findTurnByOriginId(')[1]
      ?.split('\n}')[0] ?? ''
    expect(body).toMatch(/EMISSION_AUTHORITY_ENABLED/)
    expect(body).toMatch(/currentTurnMap\.get\(originTurnId\.slice\(0, hashIdx\)\)/)
    // recentTurnsById registry fallback UNCHANGED.
    expect(body).toMatch(/recentTurnsById\.get\(originTurnId\)/)
  })

  it('the self-heal backstop drops per-topic entries for the swept chat (purgeChatStale)', () => {
    expect(gatewaySrc).toMatch(/currentTurnMap\.purgeChatStale\(fbChatId,/)
  })
})

// ---------------------------------------------------------------------------
// (b) BEHAVIOURAL IN-PROCESS HARNESS (re-import-per-flag seam)
// ---------------------------------------------------------------------------

afterEach(() => {
  delete process.env.SWITCHROOM_EMISSION_AUTHORITY
})

let reimportSeq = 0
/**
 * Re-import current-turn-map.ts with the flag set as requested. The flag is read
 * ONCE at module top; bun re-evaluates a module imported under a fresh query
 * string, so the read-once const is recomputed against the env we set here — a
 * test-only seam that leaves the production read-once path untouched.
 */
async function loadMap(enabled: boolean): Promise<typeof import('../gateway/current-turn-map.js')> {
  if (enabled) process.env.SWITCHROOM_EMISSION_AUTHORITY = '1'
  else delete process.env.SWITCHROOM_EMISSION_AUTHORITY
  return import(`../gateway/current-turn-map.js?ptctcase=${reimportSeq++}`)
}

/** A minimal stand-in for the gateway's CurrentTurn — identity is all we need. */
interface FakeTurn {
  id: string
  sessionChatId: string
}

const KEY_A = 'chatA:_'
const KEY_B = 'chatA:42'

describe('per-topic current-turn — MULTI-TOPIC NON-CONTAMINATION (the most important property)', () => {
  it('two topics under the same chat hold distinct live turns SIMULTANEOUSLY', async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    const A: FakeTurn = { id: 'A', sessionChatId: 'chatA' }
    const B: FakeTurn = { id: 'B', sessionChatId: 'chatA' }

    map.set(A, KEY_A)
    map.set(B, KEY_B) // the live turn flips A → B

    // BOTH are live for their own topic AT THE SAME TIME — the isolation 4e buys.
    expect(map.get(KEY_A)).toBe(A)
    expect(map.get(KEY_B)).toBe(B)
    // The global "is anything live" mirror points at the most-recent (B).
    expect(map.get()).toBe(B)
  })

  it('a DEFERRED A-captured callback firing AFTER B flipped resolves A — not B', async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    const A: FakeTurn = { id: 'A', sessionChatId: 'chatA' }
    const B: FakeTurn = { id: 'B', sessionChatId: 'chatA' }

    map.set(A, KEY_A)
    map.set(B, KEY_B) // live turn flipped to B

    // Simulate the late A-captured callback (a deferred drain / ping / silence
    // reset) firing now, AFTER the flip. It carries A and A's key.
    const lateCallbackTurn = A
    const lateCallbackKey = KEY_A
    // The keyed liveness read resolves A's OWN topic — TRUE — even though the
    // ambient mirror has moved on to B.
    expect(map.isLiveForKey(lateCallbackTurn, lateCallbackKey)).toBe(true)
    // A bare singleton check would have read B and FALSIFIED A's liveness; the
    // keyed read does not contaminate.
    expect(map.isLiveForKey(B, KEY_A)).toBe(false)
  })

  it("ending A deletes ONLY A — B stays live through A's teardown", async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    const A: FakeTurn = { id: 'A', sessionChatId: 'chatA' }
    const B: FakeTurn = { id: 'B', sessionChatId: 'chatA' }

    map.set(A, KEY_A)
    map.set(B, KEY_B)

    // A B liveness check stays TRUE before, during, and after A's teardown.
    expect(map.isLiveForKey(B, KEY_B)).toBe(true)
    const ended = map.endTurnForKey(A, KEY_A)
    expect(ended).toBe(true)
    // A is gone; B is untouched.
    expect(map.get(KEY_A)).toBeNull()
    expect(map.get(KEY_B)).toBe(B)
    expect(map.isLiveForKey(B, KEY_B)).toBe(true)
    // The mirror was pointing at B (most-recent) the whole time — A's teardown
    // did NOT clear it (A was not the mirror target).
    expect(map.get()).toBe(B)
  })

  it('endTurnForKey is a no-op when the key has already flipped to a successor (idempotent / no cross-topic clobber)', async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    const A1: FakeTurn = { id: 'A1', sessionChatId: 'chatA' }
    const A2: FakeTurn = { id: 'A2', sessionChatId: 'chatA' }
    map.set(A1, KEY_A)
    map.set(A2, KEY_A) // same topic, new turn

    // A late teardown for the OLD A1 must NOT delete the live A2.
    expect(map.endTurnForKey(A1, KEY_A)).toBe(false)
    expect(map.get(KEY_A)).toBe(A2)
  })
})

describe('per-topic current-turn — PARITY (flag-OFF ≡ flag-ON ≡ base)', () => {
  /**
   * The single-topic sequence set A → set B → end B → end A produces an
   * IDENTICAL observable liveness trace under both flag states (and that trace
   * IS the base singleton behaviour). This is the machine proof of the defining
   * property for the single-topic case the old singleton governed.
   */
  async function liveTrace(enabled: boolean): Promise<string[]> {
    const { CurrentTurnMap } = await loadMap(enabled)
    const map = new CurrentTurnMap<FakeTurn>()
    const A: FakeTurn = { id: 'A', sessionChatId: 'c' }
    const B: FakeTurn = { id: 'B', sessionChatId: 'c' }
    const KA = 'c:_'
    const KB = 'c:_' // SAME topic — the single-topic case the singleton modeled
    const trace: string[] = []
    const snap = (label: string) =>
      trace.push(
        `${label}: global=${map.get()?.id ?? 'null'} Alive=${map.isLiveForKey(A, KA)} Blive=${map.isLiveForKey(B, KB)}`,
      )

    snap('init')
    map.set(A, KA)
    snap('setA')
    map.set(B, KB) // same topic: B supersedes A
    snap('setB')
    map.endTurnForKey(B, KB)
    snap('endB')
    map.endTurnForKey(A, KA) // already superseded — no-op
    snap('endA')
    return trace
  }

  it('the single-topic liveness trace is identical under flag OFF and flag ON', async () => {
    const off = await liveTrace(false)
    const on = await liveTrace(true)
    expect(on).toEqual(off)
    // And it matches the base singleton semantics: B supersedes A in the same
    // topic, so after setB only B is live; ending B clears it; ending the
    // already-superseded A is a no-op.
    expect(off).toEqual([
      'init: global=null Alive=false Blive=false',
      'setA: global=A Alive=true Blive=false',
      'setB: global=B Alive=false Blive=true',
      'endB: global=null Alive=false Blive=false',
      'endA: global=null Alive=false Blive=false',
    ])
  })

  it('flag OFF never writes the per-topic map (zero alloc, stays empty)', async () => {
    const { CurrentTurnMap } = await loadMap(false)
    const map = new CurrentTurnMap<FakeTurn>()
    map.set({ id: 'A', sessionChatId: 'c' }, 'c:_')
    map.set({ id: 'B', sessionChatId: 'c' }, 'c:42')
    // The byKey map is never touched under the flag OFF — the singleton is all.
    expect(map.byKey.size).toBe(0)
  })

  it('flag OFF keyed reads degenerate to the singleton (key is ignored)', async () => {
    const { CurrentTurnMap } = await loadMap(false)
    const map = new CurrentTurnMap<FakeTurn>()
    const A: FakeTurn = { id: 'A', sessionChatId: 'c' }
    map.set(A, 'c:_')
    // Under OFF, get(anyKey) === get() === the singleton.
    expect(map.get('c:_')).toBe(A)
    expect(map.get('c:999')).toBe(A) // key ignored — singleton semantics
    expect(map.get()).toBe(A)
    expect(map.isLiveForKey(A, 'whatever')).toBe(true)
  })
})

describe('per-topic current-turn — LEAK FENCE', () => {
  it('after BOTH topics end, the per-topic map is empty (size 0)', async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    const A: FakeTurn = { id: 'A', sessionChatId: 'chatA' }
    const B: FakeTurn = { id: 'B', sessionChatId: 'chatA' }
    map.set(A, KEY_A)
    map.set(B, KEY_B)
    map.endTurnForKey(A, KEY_A)
    map.endTurnForKey(B, KEY_B)
    expect(map.byKey.size).toBe(0)
    expect(map.get()).toBeNull()
  })

  it('the disconnect-flush sim clears the WHOLE map + mirror (every entry is a ghost)', async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    map.set({ id: 'A', sessionChatId: 'chatA' }, KEY_A)
    map.set({ id: 'B', sessionChatId: 'chatA' }, KEY_B)
    map.set({ id: 'C', sessionChatId: 'chatC' }, 'chatC:_')
    expect(map.byKey.size).toBe(3)
    map.clearAll() // bridge died — every entry is a ghost
    expect(map.byKey.size).toBe(0)
    expect(map.get()).toBeNull()
  })

  it('purgeChatStale self-heal drops only the firing chat\'s STALE entries — live siblings survive', async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    const a = { id: 'a', sessionChatId: 'chatA' }
    const aSibling = { id: 'aSib', sessionChatId: 'chatA' }
    const other = { id: 'o', sessionChatId: 'chatB' }
    map.set(a, 'chatA:_')
    map.set(aSibling, 'chatA:42')
    map.set(other, 'chatB:_')

    // Sweep chatA but mark the sibling topic chatA:42 as LIVE (not stale) — it
    // must survive (the one-agent-owns-supergroup safety).
    const swept = map.purgeChatStale('chatA', (k) => k !== 'chatA:42')
    expect(swept).toEqual(['chatA:_'])
    expect(map.get('chatA:_')).toBeNull()
    expect(map.get('chatA:42')).toBe(aSibling) // live sibling spared
    expect(map.get('chatB:_')).toBe(other) // other chat untouched
  })

  it('purgeChatStale defaults to always-stale (DM / single-topic) and clears the mirror iff it pointed at a victim', async () => {
    const { CurrentTurnMap } = await loadMap(true)
    const map = new CurrentTurnMap<FakeTurn>()
    const a = { id: 'a', sessionChatId: 'chatA' }
    map.set(a, 'chatA:_') // a is also the mirror (most-recent)
    const swept = map.purgeChatStale('chatA')
    expect(swept).toEqual(['chatA:_'])
    expect(map.byKey.size).toBe(0)
    expect(map.get()).toBeNull() // mirror cleared (it pointed at the victim)
  })
})
