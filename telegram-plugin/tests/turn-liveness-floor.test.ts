/**
 * Unit coverage for the mid-turn liveness floor decision (#2527).
 *
 * The floor is the missing TEXT signal during a busy-but-silent turn. These
 * tests pin the pure policy: WHEN it fires (user role, undelivered, busy,
 * past threshold, below the 300s fallback window, not already fired) and
 * WHY it skips otherwise — plus the role derivation that keys the whole
 * primitive (and is the antidote to per-surface / per-turn-type enumeration).
 *
 * The gateway wiring (send via the shared path, "Status?" short-circuit,
 * role-aware terminal reaction) is covered separately; here we lock the
 * decision so a regression in eligibility is caught without booting the
 * 22k-line gateway.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  deriveTurnRole,
  decideMidTurnFloor,
  decideTerminalReason,
  midTurnFloorEnabled,
  parsePostAnswerLivenessMs,
  POST_ANSWER_LIVENESS_DEFAULT_MS,
  DEFAULT_FLOOR_THRESHOLD_MS,
  type MidTurnFloorInput,
} from '../turn-liveness-floor.js'

const FALLBACK_MS = 300_000

/** A baseline that FIRES — each test perturbs exactly one field. */
function fireBase(over: Partial<MidTurnFloorInput> = {}): MidTurnFloorInput {
  return {
    enabled: true,
    role: 'user',
    finalAnswerDelivered: false,
    silenceMs: 60_000,
    floorThresholdMs: DEFAULT_FLOOR_THRESHOLD_MS,
    fallbackThresholdMs: FALLBACK_MS,
    legitimatelyWorking: true,
    alreadyFired: false,
    ...over,
  }
}

describe('deriveTurnRole — the single provenance discriminator', () => {
  it('a plain human DM (no envelope) is a user turn', () => {
    expect(deriveTurnRole(undefined)).toBe('user')
    expect(deriveTurnRole(null)).toBe('user')
    expect(deriveTurnRole('hello there')).toBe('user')
  })

  it('a cron/scheduled envelope is a system turn', () => {
    expect(deriveTurnRole('<channel chat_id="123" source="cron">do the thing</channel>')).toBe('system')
    expect(deriveTurnRole('<channel source="wake" chat_id="1">')).toBe('system')
    expect(deriveTurnRole('<channel source="scheduler">')).toBe('system')
  })

  it('an unknown source defaults to user (gets the never-silent guarantee, not silently exempt)', () => {
    // A novel/unknown source must NOT opt out of the floor by accident.
    expect(deriveTurnRole('<channel source="handback" chat_id="1">')).toBe('user')
    expect(deriveTurnRole('<channel source="some-new-thing">')).toBe('user')
  })

  it('never returns sub-agent — the gateway makes no turn atom for sub-agents', () => {
    // Type-level guarantee, asserted at runtime for the documented cases.
    const r = deriveTurnRole('<channel source="cron">')
    expect(r === 'user' || r === 'system').toBe(true)
  })
})

describe('decideMidTurnFloor — fires on busy-but-silent user turns', () => {
  it('fires for a user turn working silently past the threshold', () => {
    expect(decideMidTurnFloor(fireBase())).toEqual({ kind: 'fire' })
  })

  it('skips when disabled (kill switch)', () => {
    expect(decideMidTurnFloor(fireBase({ enabled: false }))).toEqual({ kind: 'skip', reason: 'disabled' })
  })

  it('skips when already fired (fire-once per turn)', () => {
    expect(decideMidTurnFloor(fireBase({ alreadyFired: true }))).toEqual({ kind: 'skip', reason: 'already-fired' })
  })

  it('skips a system/cron turn — its silence is legitimate', () => {
    expect(decideMidTurnFloor(fireBase({ role: 'system' }))).toEqual({ kind: 'skip', reason: 'non-user-role' })
  })

  it('skips a sub-agent turn — liveness is carried by the parent', () => {
    expect(decideMidTurnFloor(fireBase({ role: 'sub-agent' }))).toEqual({ kind: 'skip', reason: 'non-user-role' })
  })

  it('skips once a substantive answer was delivered', () => {
    expect(decideMidTurnFloor(fireBase({ finalAnswerDelivered: true }))).toEqual({ kind: 'skip', reason: 'answer-delivered' })
  })

  it('skips below the floor threshold (a normal short turn stays quiet)', () => {
    expect(decideMidTurnFloor(fireBase({ silenceMs: 10_000 }))).toEqual({ kind: 'skip', reason: 'below-threshold' })
  })

  it('skips inside the 300s fallback window — the loud fallback owns that beat', () => {
    expect(decideMidTurnFloor(fireBase({ silenceMs: FALLBACK_MS }))).toEqual({ kind: 'skip', reason: 'fallback-window' })
    expect(decideMidTurnFloor(fireBase({ silenceMs: FALLBACK_MS + 1 }))).toEqual({ kind: 'skip', reason: 'fallback-window' })
  })

  it('skips when not legitimately working — a genuine wedge is the fallback\'s job', () => {
    expect(decideMidTurnFloor(fireBase({ legitimatelyWorking: false }))).toEqual({ kind: 'skip', reason: 'not-working' })
  })

  it('fires exactly at the threshold boundary', () => {
    expect(decideMidTurnFloor(fireBase({ silenceMs: DEFAULT_FLOOR_THRESHOLD_MS }))).toEqual({ kind: 'fire' })
  })
})

describe('decideMidTurnFloor — forced "Status?" short-circuit', () => {
  it('fires immediately on force, bypassing threshold and the working check', () => {
    expect(decideMidTurnFloor(fireBase({ force: true, silenceMs: 1_000, legitimatelyWorking: false })))
      .toEqual({ kind: 'fire' })
  })

  it('force still honours role / delivery / fire-once / enabled', () => {
    expect(decideMidTurnFloor(fireBase({ force: true, role: 'system' }))).toEqual({ kind: 'skip', reason: 'non-user-role' })
    expect(decideMidTurnFloor(fireBase({ force: true, finalAnswerDelivered: true }))).toEqual({ kind: 'skip', reason: 'answer-delivered' })
    expect(decideMidTurnFloor(fireBase({ force: true, alreadyFired: true }))).toEqual({ kind: 'skip', reason: 'already-fired' })
    expect(decideMidTurnFloor(fireBase({ force: true, enabled: false }))).toEqual({ kind: 'skip', reason: 'disabled' })
  })
})

describe('decideTerminalReason — the "thumbs-up false done" gate', () => {
  it('an undelivered user turn finalizes undelivered (😐), not done (👍)', () => {
    expect(decideTerminalReason({ enabled: true, role: 'user', finalAnswerDelivered: false })).toBe('undelivered')
  })

  it('a delivered user turn finalizes done', () => {
    expect(decideTerminalReason({ enabled: true, role: 'user', finalAnswerDelivered: true })).toBe('done')
  })

  it('a system/cron turn keeps done even when undelivered — its silence is legitimate', () => {
    expect(decideTerminalReason({ enabled: true, role: 'system', finalAnswerDelivered: false })).toBe('done')
  })

  it('a sub-agent turn keeps done', () => {
    expect(decideTerminalReason({ enabled: true, role: 'sub-agent', finalAnswerDelivered: false })).toBe('done')
  })

  it('the kill switch reverts to always-done', () => {
    expect(decideTerminalReason({ enabled: false, role: 'user', finalAnswerDelivered: false })).toBe('done')
  })
})

describe('midTurnFloorEnabled — default-on kill switch', () => {
  const KEY = 'SWITCHROOM_TG_LIVENESS_FLOOR'
  afterEach(() => { delete process.env[KEY] })

  it('defaults on when unset', () => {
    delete process.env[KEY]
    expect(midTurnFloorEnabled()).toBe(true)
  })

  it('disables on 0/false/off/no (case-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
      process.env[KEY] = v
      expect(midTurnFloorEnabled()).toBe(false)
    }
  })

  it('stays on for any other value', () => {
    for (const v of ['1', 'true', 'on', 'yes']) {
      process.env[KEY] = v
      expect(midTurnFloorEnabled()).toBe(true)
    }
  })
})

describe('parsePostAnswerLivenessMs — post-answer liveness threshold (default ON, 6000ms)', () => {
  // The restored contract: UNSET ⇒ POST_ANSWER_LIVENESS_DEFAULT_MS (6 000 ms)
  // so the post-answer branch in feedHeartbeatTick runs out of the box and
  // genuine background sub-agent activity surfaces as a card below the reply
  // (restores #2547 visibility under #2564 determinism gate). Operators who
  // prefer silent post-answer behaviour set =0.
  it('UNSET (undefined) ⇒ default 6 000 ms — post-answer activity card enabled by default', () => {
    expect(parsePostAnswerLivenessMs(undefined)).toBe(POST_ANSWER_LIVENESS_DEFAULT_MS)
  })

  it('empty ⇒ default 6 000 ms (same as unset)', () => {
    expect(parsePostAnswerLivenessMs('')).toBe(POST_ANSWER_LIVENESS_DEFAULT_MS)
  })

  it('non-numeric ⇒ 0 (invalid value treated as opt-out)', () => {
    expect(parsePostAnswerLivenessMs('   ')).toBe(0)
    expect(parsePostAnswerLivenessMs('nope')).toBe(0)
  })

  it('0 and negative ⇒ 0 (explicit operator opt-out — silent post-answer)', () => {
    expect(parsePostAnswerLivenessMs('0')).toBe(0)
    expect(parsePostAnswerLivenessMs('-5000')).toBe(0)
  })

  it('a positive integer ⇒ that threshold in ms (operator override)', () => {
    expect(parsePostAnswerLivenessMs('8000')).toBe(8000)
    expect(parsePostAnswerLivenessMs('45000')).toBe(45000)
  })
})
