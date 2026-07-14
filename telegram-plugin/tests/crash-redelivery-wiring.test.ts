import { describe, it, expect } from 'vitest'
import { projectTrailingAnswerFromTranscript } from '../session-tail.js'
import { decideRedeliver, REDELIVERY_PREFIX } from '../gateway/redelivery-decision.js'

/**
 * Pins the crash-survival redelivery WIRING GLUE — the composition
 * `maybeRedeliverUndeliveredAnswer` performs in the boot send: project the
 * interrupted turn's trailing answer from its transcript, then feed
 * (`text`, `trailingIsText`) plus the durable oracle result into
 * `decideRedeliver`. The oracle (`hasOutboundWithText`) and the projector are
 * unit-tested in their own suites (history.test.ts / trailing-answer-projector
 * .test.ts); this asserts the two ends plumb together — the projected answer is
 * what gets framed, and a dangling mid-tool turn is refused before any send.
 *
 * The raw Telegram socket send and the post-`getMe()` connect sequencing are NOT
 * unit-testable here (they require a connected grammy client); the ordering
 * guarantee is documented on `maybeRedeliverUndeliveredAnswer` and enforced by
 * its single call site inside the `didOneTimeSetup` block, which is unreachable
 * until `bot.api.getMe()` resolves.
 */

const FINAL_ANSWER = 'The deploy finished — all three services are green and healthy.'

function compose(transcript: string, hasDeliveredText: boolean) {
  const projected = projectTrailingAnswerFromTranscript(transcript)
  return decideRedeliver({
    capturedText: projected.text,
    trailingIsText: projected.trailingIsText,
    hasDeliveredText,
    alreadyRedelivered: false,
    ageMs: 60_000,
    maxAgeMs: 10_800_000,
  })
}

function line(obj: unknown): string {
  return JSON.stringify(obj)
}
const completedTurn = [
  line({ type: 'user', message: { role: 'user', content: 'deploy status?' } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking.' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_x', input: {} }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: FINAL_ANSWER }] } }),
].join('\n')
const danglingToolTurn = [
  line({ type: 'user', message: { role: 'user', content: 'run the migration' } }),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_y', input: {} }] } }),
].join('\n')

describe('crash-redelivery wiring glue (project → decide)', () => {
  it('frames the PROJECTED trailing answer when the oracle says it was not delivered', () => {
    const d = compose(completedTurn, /* hasDeliveredText */ false)
    expect(d.redeliver).toBe(true)
    expect(d.framedText?.startsWith(REDELIVERY_PREFIX)).toBe(true)
    expect(d.framedText).toContain(FINAL_ANSWER)
  })

  it('skips when the oracle reports the projected answer was already delivered', () => {
    expect(compose(completedTurn, /* hasDeliveredText */ true).skipReason).toBe('already-delivered')
  })

  it('refuses a turn killed mid-tool before any send', () => {
    // The projector RESETS the buffer on the trailing tool_use, so the recovered
    // text is empty AND trailingIsText is false — either guard refuses. The
    // decision reports 'empty-text' (checked first); the load-bearing property is
    // simply that no send happens for a dangling mid-tool turn.
    const d = compose(danglingToolTurn, false)
    expect(d.redeliver).toBe(false)
    expect(d.skipReason).toBe('empty-text')
  })
})
