/**
 * Structural pins for the #3018 fixes to the mid-turn ack-queue-apply-confirm
 * wiring in gateway.ts (/model + /effort, #3017).
 *
 * The behaviour lives in un-exported inline closures (the pendingStateReaper
 * interval, enqueueSessionCommand, drainPendingSessionCommand, and the
 * shutdown() handler), so — mirroring gateway-session-model-relaunch.test.ts —
 * we assert on the source structure. The pure contract (per-kind slots,
 * drainCapDecision, shutdownResolutionActions) is unit-tested in
 * pending-session-command.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf8')

describe('gateway: reaper drain-cap defers while a turn is in flight (#3018 finding 1)', () => {
  it('feeds turnInFlightForGate() into drainCapDecision and only forces on the force branch', () => {
    const idx = GATEWAY_SRC.indexOf('pendingCmdDrainCapDecision(')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 1200)
    // The decision reads the live turn gate…
    expect(win).toContain('turnInFlightForGate()')
    // …has an explicit defer branch that does NOT drain…
    const deferIdx = win.indexOf("'defer-turn-in-flight'")
    expect(deferIdx).toBeGreaterThan(0)
    const forceIdx = win.indexOf("cmdDecision === 'force'")
    expect(forceIdx).toBeGreaterThan(deferIdx)
    // …and the ONLY drain call in the reaper block sits after the force check.
    const drainIdx = win.indexOf('void drainPendingSessionCommand()')
    expect(drainIdx).toBeGreaterThan(forceIdx)
    expect(win.slice(0, forceIdx)).not.toContain('drainPendingSessionCommand()')
  })
})

describe('gateway: post-enqueue idle kick (#3018 finding 5)', () => {
  it('enqueueSessionCommand drains immediately when the session went idle between the busy check and the enqueue', () => {
    const fnIdx = GATEWAY_SRC.indexOf('function enqueueSessionCommand(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 1500)
    expect(win).toContain('if (!turnInFlightForGate()) void drainPendingSessionCommand()')
  })
})

describe('gateway: shutdown resolves queued ack cards (#3018 finding 3)', () => {
  it('shutdown() empties the slots via shutdownResolutionActions, PERSISTS each typed choice, and edits each card, before the force-exit timer', () => {
    const fnIdx = GATEWAY_SRC.indexOf('async function shutdown(signal: string)')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, GATEWAY_SRC.indexOf('forceExitTimer', fnIdx))
    const resolveIdx = win.indexOf('pendingCmdShutdownResolutionActions(pendingSessionCommand')
    expect(resolveIdx).toBeGreaterThan(0)
    // #3039: the queued choice is carried across the bounce via the durable
    // carriers, not dropped with a "re-issue" note.
    expect(win.indexOf('persistQueuedCommandForRestart(', resolveIdx)).toBeGreaterThan(resolveIdx)
    expect(win.indexOf('editPendingCommandCard(', resolveIdx)).toBeGreaterThan(resolveIdx)
    // Bounded: raced against a timeout so a wedged Telegram API can't block shutdown.
    expect(win.slice(resolveIdx)).toContain('Promise.race')
  })
})

describe('gateway: drain never confirms a busy refusal (#3039)', () => {
  it('drainPendingSessionCommand re-checks turn-in-flight per command and re-enqueues on a busy-refusal reply', () => {
    const fnIdx = GATEWAY_SRC.indexOf('async function drainPendingSessionCommand(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 4000)
    expect(win).toContain('if (turnInFlightForGate())')
    expect(win).toContain('isBusyRefusalText(body)')
    expect(win).toContain('reEnqueueUnlessSuperseded(cmd)')
    // The pending-restart branch persists rather than telling the user to re-issue.
    expect(win).toContain('pendingCmdResolveForRestart(cmd')
    expect(win).toContain('persistQueuedCommandForRestart(action)')
  })
})

describe('gateway: /restart keeps the session-model override (#3039)', () => {
  it('the /restart chat command stamps keep, never revert', () => {
    expect(GATEWAY_SRC).toContain("writeRelaunchModelIntent(smDir, 'keep', 'user: /restart from chat')")
    expect(GATEWAY_SRC).not.toContain("writeRelaunchModelIntent(smDir, 'revert'")
  })
})

describe('gateway: /effort persistence choke point (#3039)', () => {
  it('buildEffortDeps persists a confirmed apply to .session-effort and wires clearSessionEffort', () => {
    const fnIdx = GATEWAY_SRC.indexOf('function buildEffortDeps(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 2500)
    expect(win).toContain('writeSessionEffortFile(')
    expect(win).toContain('clearSessionEffortFile(')
    expect(win).toContain('readSessionEffortFile(')
  })
})

describe('gateway: keep-intent stamp narrowing (#3018 finding 4)', () => {
  it('the shutdown keep-intent stamp carries the gateway-shutdown reason prefix', () => {
    expect(GATEWAY_SRC).toContain(
      "writeRelaunchModelIntent(smDir, 'keep', `${GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX} graceful ${signal} shutdown",
    )
  })

  it('boot clears a stale gateway-shutdown-stamped intent (gateway-only bounce never runs start.sh)', () => {
    const idx = GATEWAY_SRC.indexOf('clearStaleGatewayShutdownIntent(bootSmDir)')
    expect(idx).toBeGreaterThan(0)
    // The cleanup runs at module top-level (gateway boot), BEFORE the shutdown
    // handler could stamp a fresh one for THIS process's own exit.
    expect(idx).toBeLessThan(GATEWAY_SRC.indexOf('async function shutdown(signal: string)'))
  })
})
