import { describe, it, expect } from 'vitest'
import {
  decideProactiveCompact,
  initialCompactState,
  COMPACT_COOLDOWN_TURNS,
  COMPACT_REARM_FRACTION,
  type CompactState,
} from '../gateway/proactive-compact.js'

const CAP = 190_000

// Drive the state machine over a sequence of occupancy readings,
// returning the index of every evaluation that fired.
function run(occ: number[], start: CompactState = initialCompactState()) {
  let state = start
  const fires: number[] = []
  occ.forEach((o, i) => {
    const d = decideProactiveCompact(state, o, CAP)
    state = d.state
    if (d.fire) fires.push(i)
  })
  return { state, fires }
}

describe('decideProactiveCompact', () => {
  it('does not fire below the cap', () => {
    const { fires } = run([0, 50_000, 150_000, CAP - 1])
    expect(fires).toEqual([])
  })

  it('fires exactly once when occupancy reaches the cap, then disarms', () => {
    // Stays high after the fire (compaction has not landed yet).
    const { fires } = run([CAP, CAP, CAP])
    expect(fires).toEqual([0])
  })

  it('fires at occupancy strictly above the cap too', () => {
    const { fires } = run([CAP + 25_000])
    expect(fires).toEqual([0])
  })

  it('burns exactly COMPACT_COOLDOWN_TURNS idle evals after a fire before re-considering', () => {
    // Fire at 0, then occupancy stays pegged high. The cooldown must
    // swallow the next COMPACT_COOLDOWN_TURNS evals with no fire, and
    // because it is still above the re-arm band it never re-arms ->
    // never fires again. (Livelock guard.)
    const seq = new Array(1 + COMPACT_COOLDOWN_TURNS + 5).fill(CAP)
    const { fires } = run(seq)
    expect(fires).toEqual([0])
  })

  it('re-arms only after occupancy falls below REARM_FRACTION × cap, never on the arming pass', () => {
    const lowBand = CAP * COMPACT_REARM_FRACTION
    // fire(0) -> cooldown(1..3) -> still high(4) stays disarmed ->
    // drop just below band(5): arms but does NOT fire same pass ->
    // climb back to cap(6): fires again.
    const seq = [
      CAP, // 0 fire
      CAP, // 1 cooldown
      CAP, // 2 cooldown
      CAP, // 3 cooldown
      CAP, // 4 disarmed, above band -> hold
      lowBand - 1, // 5 re-arm, must NOT fire here
      CAP, // 6 armed + at cap -> fire
    ]
    const { fires } = run(seq)
    expect(fires).toEqual([0, 6])
  })

  it('does not re-arm if occupancy only drops to the band but not below it', () => {
    const lowBand = CAP * COMPACT_REARM_FRACTION
    // After cooldown, occupancy sits exactly at the band (not strictly
    // below) forever -> never re-arms -> only the first fire.
    const seq = [CAP, CAP, CAP, CAP, lowBand, lowBand, lowBand, CAP, CAP]
    const { fires } = run(seq)
    expect(fires).toEqual([0])
  })

  it('full healthy cycle: fire, compaction shrinks context, climbs again, fires again', () => {
    const seq = [
      120_000, // below cap
      CAP, // fire (idx 1)
      30_000, // cooldown 1 (post-compact, small)
      35_000, // cooldown 2
      40_000, // cooldown 3
      45_000, // disarmed, below band -> re-arm (no fire)
      90_000, // armed, below cap -> hold
      CAP + 5_000, // fire again (idx 7)
    ]
    const { fires } = run(seq)
    expect(fires).toEqual([1, 7])
  })

  it('never fires twice in immediate succession even with no cooldown left if still disarmed', () => {
    // Construct a state that is past cooldown but disarmed, occupancy
    // pegged at cap: must hold (not fire) until it drops below band.
    const stuck: CompactState = { armed: false, cooldownTurns: 0 }
    const { fires } = run([CAP, CAP, CAP, CAP], stuck)
    expect(fires).toEqual([])
  })
})
