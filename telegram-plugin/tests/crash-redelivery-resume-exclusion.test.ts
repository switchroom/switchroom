import { describe, it, expect } from 'vitest'
import { decideRedeliverCapture } from '../gateway/redelivery-decision.js'
import {
  decideBootResumeKind,
  RESUME_SYNTHETIC_PROMPT_PREFIX,
} from '../gateway/resume-inbound-builder.js'
import type { Turn, TurnEndedVia } from '../registry/turns-schema.js'

/**
 * Pins the MUTUAL EXCLUSION between crash-survival redelivery and the resume
 * synthetic — the double-send guard. The gateway boot block composes exactly
 * these two pure predicates: `decideBootResumeKind` classifies the interrupted
 * turn, then `decideRedeliverCapture({ willBeResumed: kind === 'resume', ... })`
 * decides whether to ALSO stage a redelivery.
 *
 * The load-bearing outcome: an interrupted turn that WILL be resumed (the model
 * re-runs and emits a fresh answer) must NOT also redeliver its recovered draft
 * — otherwise the same answer reaches the user twice. Conversely, a turn that
 * will NOT be resumed (watchdog report, boot_resume:never suppression,
 * resume-of-a-resume loop-guard) MUST redeliver, because nothing else re-answers.
 *
 * This mirrors the gateway wiring exactly, so it asserts the real composed
 * outcome, not an isolated code path.
 */

const RESUME_MAX_AGE_MS = 10_800_000 // 3h, gateway default

function makeTurn(over: Partial<Turn> = {}): Turn {
  return {
    turn_key: '900001:_#7',
    chat_id: '900001',
    thread_id: null,
    started_at: Date.now() - 60_000, // 1 min ago — well within maxAge
    ended_at: null,
    ended_via: null,
    last_assistant_msg_id: null,
    last_assistant_done: null,
    last_user_msg_id: null,
    user_prompt_preview: 'deploy the staging stack',
    assistant_reply_preview: null,
    tool_call_count: 2,
    interrupt_reason: null,
    resumed_at: null,
    session_id: 'sess-abcd', // durably pinned → redelivery is eligible on the floor
    ...over,
  } as Turn
}

/** Compose the two predicates exactly as the gateway boot block does. */
function composeGate(turn: Turn, suppressed: boolean) {
  const bootResumeKind = decideBootResumeKind({
    pending: turn,
    suppressed,
    ageMs: Math.max(0, Date.now() - turn.started_at),
    maxAgeMs: RESUME_MAX_AGE_MS,
  })
  const capture = decideRedeliverCapture({
    willBeResumed: bootResumeKind === 'resume',
    hasSessionId: Boolean(turn.session_id),
  })
  return { bootResumeKind, capture }
}

describe('crash-redelivery ↔ resume mutual exclusion (no double-send)', () => {
  it('(a) an interrupted turn that WILL be resumed does NOT also redeliver', () => {
    // ended_via 'restart' → decideBootResumeKind returns 'resume': the model
    // re-runs and emits a fresh answer that supersedes any recovered draft.
    const turn = makeTurn({ ended_via: 'restart' as TurnEndedVia })
    const { bootResumeKind, capture } = composeGate(turn, /* suppressed */ false)
    expect(bootResumeKind).toBe('resume')
    expect(capture.capture).toBe(false)
    expect(capture.skipReason).toBe('will-be-resumed')
  })

  it('(a2) a still-open (ended_via=null) killed-mid-flight turn is resumed, not redelivered', () => {
    const turn = makeTurn({ ended_via: null })
    const { bootResumeKind, capture } = composeGate(turn, false)
    expect(bootResumeKind).toBe('resume')
    expect(capture.capture).toBe(false)
  })

  it('(b) a watchdog-timeout turn (report, no auto re-answer) DOES redeliver', () => {
    // ended_via 'timeout' → 'report': the synthetic only ASKS the user whether
    // to retry — it does not auto-re-answer. Redelivery is the correct recovery.
    const turn = makeTurn({ ended_via: 'timeout' as TurnEndedVia })
    const { bootResumeKind, capture } = composeGate(turn, false)
    expect(bootResumeKind).toBe('report')
    expect(capture.capture).toBe(true)
    expect(capture.skipReason).toBeUndefined()
  })

  it('(b2) a boot_resume:never-suppressed turn (defer-suppressed) DOES redeliver', () => {
    // suppressed=true → 'defer-suppressed': no synthetic re-run, so redelivery
    // is the ONLY recovery send.
    const turn = makeTurn({ ended_via: 'restart' as TurnEndedVia })
    const { bootResumeKind, capture } = composeGate(turn, /* suppressed */ true)
    expect(bootResumeKind).toBe('defer-suppressed')
    expect(capture.capture).toBe(true)
  })

  it('(b3) a resume-of-a-resume (loop-guard → defer-loop) turn DOES redeliver', () => {
    // A turn whose prompt is itself a resume synthetic → 'defer-loop': the chain
    // is capped, no re-run happens, so redelivery must still recover the answer.
    const turn = makeTurn({
      ended_via: 'restart' as TurnEndedVia,
      user_prompt_preview: `${RESUME_SYNTHETIC_PROMPT_PREFIX} Continue the interrupted deploy.`,
    })
    const { bootResumeKind, capture } = composeGate(turn, false)
    expect(bootResumeKind).toBe('defer-loop')
    expect(capture.capture).toBe(true)
  })

  it('(b4) a STALE resume downgraded to report DOES redeliver (not suppressed)', () => {
    // A 'restart' turn older than maxAge downgrades resume→report in
    // selectResumeBuilder. Because the final kind is 'report' (no re-run),
    // redelivery must fire — the gate keys on the FINAL kind, not the raw
    // ended_via.
    const turn = makeTurn({
      ended_via: 'restart' as TurnEndedVia,
      started_at: Date.now() - (RESUME_MAX_AGE_MS + 60_000),
    })
    const { bootResumeKind, capture } = composeGate(turn, false)
    expect(bootResumeKind).toBe('report')
    expect(capture.capture).toBe(true)
  })

  it('eligibility floor still applies: no session_id → no redelivery even when not resumed', () => {
    const turn = makeTurn({ ended_via: 'timeout' as TurnEndedVia, session_id: null })
    const { capture } = composeGate(turn, false)
    expect(capture.capture).toBe(false)
    expect(capture.skipReason).toBe('no-session-id')
  })
})
