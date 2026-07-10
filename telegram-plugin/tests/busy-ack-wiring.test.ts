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

  it('a mid-turn steer delivery gets the steer-worded variant', () => {
    expect(gatewaySrc).toMatch(
      /deliveryGate\.decision === 'deliver' && isSteering[\s\S]{0,200}maybePostBusyAck\('steer', chat_id, messageThreadId \?\? undefined\)/,
    )
  })

  it('the decision is fed from live tool-flight + step-age readings (pure module owns policy)', () => {
    const fn = gatewaySrc.split('function maybePostBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/shouldPostBusyAck\(\{/)
    expect(fn).toMatch(/midToolCall: toolFlightTracker\.isMidToolCall\(\)/)
    expect(fn).toMatch(/silencePoke\.longestInFlightTool\(/)
    expect(fn).toMatch(/stepAgeMs: step\?\.durationMs \?\? null/)
    // Turn age is receipt-anchored (activeTurnStartedAt), per the design.
    expect(fn).toMatch(/activeTurnStartedAt\.get\(inFlightKey\)/)
  })

  it('dedupe: alreadyAcked couples the live card map AND the per-turn key set', () => {
    const fn = gatewaySrc.split('function maybePostBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(
      /alreadyAcked: queuedStatusMsgIds\.has\(key\) \|\| busyAckPostedKeys\.has\(key\)/,
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

  it('the per-turn dedupe set is cleared at turn end (alongside the queued-status reap)', () => {
    const purge = gatewaySrc.split('function purgeReactionTracking')[1]?.split('\nfunction ')[0] ?? ''
    expect(purge).toMatch(/busyAckPostedKeys\.clear\(\)/)
  })

  it('kill switch defaults ON, independently disableable', () => {
    expect(gatewaySrc).toMatch(/SWITCHROOM_MIDFLIGHT_BUSY_ACK !== '0'/)
    const fn = gatewaySrc.split('function maybePostBusyAck')[1]?.split('\nfunction ')[0] ?? ''
    expect(fn).toMatch(/if \(!MIDFLIGHT_BUSY_ACK_ENABLED\) return/)
  })
})
