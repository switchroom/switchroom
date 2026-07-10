/**
 * #2995 — mid-flight busy ack: gateway wiring guards.
 *
 * The gateway IIFE is too entangled to instantiate in-process, so these
 * are source-level assertions (the established pattern —
 * multitopic-routing-wiring.test.ts, buffer-gate-broadened.test.ts). They
 * pin the load-bearing wiring: the buffered-inbound and steer call sites,
 * the silent send, the shared queuedStatusMsgIds lifecycle (promote/reap
 * cleanup for free), the per-turn dedupe reset, and the kill switch. The
 * POLICY and the rendered text are behaviourally tested in
 * busy-ack.test.ts; the live end-to-end shape in
 * uat/scenarios/jtbd-midflight-busy-ack-dm.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('#2995 mid-flight busy ack — gateway wiring', () => {
  it('the buffer-until-idle branch calls maybePostBusyAck for the inbound own chat/topic', () => {
    expect(gatewaySrc).toMatch(
      /maybePostBusyAck\('buffer-until-idle', chat_id, messageThreadId \?\? undefined\)/,
    )
    // …AFTER the pendingInboundBuffer.push (the ack narrates a real queue).
    const branch = gatewaySrc.split("deliveryGate.decision === 'buffer-until-idle'")[1] ?? ''
    const pushIdx = branch.indexOf('pendingInboundBuffer.push(selfAgent, inboundMsg)')
    const ackIdx = branch.indexOf("maybePostBusyAck('buffer-until-idle'")
    expect(pushIdx).toBeGreaterThanOrEqual(0)
    expect(ackIdx).toBeGreaterThan(pushIdx)
  })

  it('cross-topic queued status and the busy ack are mutually exclusive (no double-card race)', () => {
    // Both helpers record into queuedStatusMsgIds only AFTER their
    // sendMessage awaits resolve, so calling both in the same handler pass
    // would race past each other's has(key) check and double-card the
    // topic. The buffer branch must pick exactly one.
    expect(gatewaySrc).toMatch(
      /if \(crossTopicQueuedCard\) \{\s*postQueuedStatus\(chat_id, messageThreadId, inFlightThread\)\s*\} else \{/,
    )
  })

  it('a mid-turn steer gets the steer-worded variant only AFTER successful bridge dispatch', () => {
    // A "Steer noted" card for a send that missed (bridge offline) would
    // be untrue — the ack lives inside the `if (delivered)` branch.
    expect(gatewaySrc).toMatch(
      /if \(delivered\) \{[\s\S]{0,700}if \(isSteering\) \{\s*maybePostBusyAck\('steer', chat_id, messageThreadId \?\? undefined\)/,
    )
  })

  it('an under-threshold miss arms ONE deferred re-check pinned to the running turn', () => {
    const fn = gatewaySrc.split('function maybePostBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    // Armed only for the young-step miss, for the remaining age gap.
    expect(fn).toMatch(/stepAgeMs < BUSY_ACK_STEP_AGE_THRESHOLD_MS &&\s*!busyAckRecheckTimers\.has\(key\)/)
    expect(fn).toMatch(/BUSY_ACK_STEP_AGE_THRESHOLD_MS - stepAgeMs \+ 250/)
    // The re-fire is guarded on the SAME turn still running.
    expect(fn).toMatch(/currentTurn\?\.turnId !== turnIdAtSchedule\) return/)
    // A posted card cancels the pending re-check.
    expect(fn).toMatch(/clearTimeout\(pendingRecheck\)/)
  })

  it('the decision is fed from live tool-flight + step-age readings (pure module owns policy)', () => {
    const fn = gatewaySrc.split('function maybePostBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/shouldPostBusyAck\(\{ gateDecision, midToolCall, stepAgeMs, alreadyAcked \}\)/)
    expect(fn).toMatch(/const midToolCall = toolFlightTracker\.isMidToolCall\(\)/)
    expect(fn).toMatch(/silencePoke\.longestInFlightTool\(/)
    expect(fn).toMatch(/const stepAgeMs = step\?\.durationMs \?\? null/)
  })

  it('dedupe: alreadyAcked couples the live card map AND the per-turn key set', () => {
    const fn = gatewaySrc.split('function maybePostBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(
      /const alreadyAcked = queuedStatusMsgIds\.has\(key\) \|\| busyAckPostedKeys\.has\(key\)/,
    )
    expect(fn).toMatch(/busyAckPostedKeys\.add\(key\)/)
  })

  it('the card is sent SILENT (disable_notification: true) through the swallowing wrapper', () => {
    const fn = gatewaySrc.split('function postBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/swallowingApiCall\(/)
    expect(fn).toMatch(/disable_notification: true/)
    // Thread-optional: a DM send must NOT pass message_thread_id.
    expect(fn).toMatch(/\.\.\.\(threadId != null \? \{ message_thread_id: threadId \} : \{\}\)/)
  })

  it('the card shares queuedStatusMsgIds — promote/reap lifecycle cleans it up', () => {
    const fn = gatewaySrc.split('function postBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    // Idempotent against the shared key (never stacks on the cross-topic card).
    expect(fn).toMatch(/if \(queuedStatusMsgIds\.has\(key\)\) return/)
    expect(fn).toMatch(/queuedStatusMsgIds\.set\(key, \{ chatId, threadId: threadId \?\? null, messageId \}\)/)
    // Post-race orphan cleanup, same pattern as postQueuedStatus.
    expect(fn).toMatch(/busy-ack\.post-race-cleanup/)
  })

  it('turn-end cleanup is PER-KEY: dedupe entry deleted and re-check timer cancelled for the ending turn only', () => {
    const purge = gatewaySrc.split('function purgeReactionTracking')[1]?.split('\nfunction ')[0] ?? ''
    // Per-key delete — a purge for topic A must not reset topic B's dedupe.
    expect(purge).toMatch(/busyAckPostedKeys\.delete\(key\)/)
    expect(purge).not.toMatch(/busyAckPostedKeys\.clear\(\)/)
    expect(purge).toMatch(/busyAckRecheckTimers\.delete\(key\)/)
    expect(purge).toMatch(/clearTimeout\(busyAckRecheck\)/)
  })

  it('DM cards are promoted too (promoteQueuedStatus no longer early-returns on a null thread)', () => {
    const fn = gatewaySrc.split('function promoteQueuedStatus')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).not.toMatch(/if \(thread == null\) return/)
  })

  it('kill switch defaults ON, independently disableable', () => {
    expect(gatewaySrc).toMatch(/SWITCHROOM_MIDFLIGHT_BUSY_ACK !== '0'/)
    const fn = gatewaySrc.split('function maybePostBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/if \(!MIDFLIGHT_BUSY_ACK_ENABLED\) return/)
  })
})
