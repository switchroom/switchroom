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

describe('gateway: drain never confirms a busy refusal and never drops the batch (#3039, #3042 blocker 1)', () => {
  it('drainPendingSessionCommand routes takeAll() through the unit-tested drainTakenCommands with the loss-safe IO', () => {
    const fnIdx = GATEWAY_SRC.indexOf('async function drainPendingSessionCommand(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 3000)
    // Iteration + loss-safety invariants live in pending-session-command.ts
    // (drainTakenCommands, functionally tested); the gateway only supplies IO.
    expect(win).toContain('pendingCmdDrainTaken(pendingSessionCommand.takeAll()')
    expect(win).toContain('turnInFlightForGate()')
    expect(win).toContain('isBusyRefusal: isBusyRefusalText')
    expect(win).toContain('reEnqueue: reEnqueueUnlessSuperseded')
    // The pending-restart branch persists rather than telling the user to re-issue.
    expect(win).toContain('pendingCmdResolveForRestart(cmd')
    expect(win).toContain('persistQueuedCommandForRestart(')
  })
})

describe('gateway: unconfirmed queued model tokens are gated before durable persist (#3042 blocker 2a)', () => {
  it('persistQueuedCommandForRestart refuses offline-unverifiable tokens', () => {
    const fnIdx = GATEWAY_SRC.indexOf('function persistQueuedCommandForRestart(')
    expect(fnIdx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(fnIdx, fnIdx + 2500)
    expect(win).toContain('isOfflineTrustedModelToken(action.arg)')
    expect(win).toContain('NOT saved')
  })
})

describe('gateway: /restart reverts the session-model override (rev 4, session-scoped)', () => {
  it('no restart verb stamps a relaunch-model intent (the subsystem is retired)', () => {
    expect(GATEWAY_SRC).not.toContain('writeRelaunchModelIntent')
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

describe('gateway: graceful shutdown no longer preserves a session model (rev 4)', () => {
  it('the shutdown handler stamps no keep-intent — a deploy reverts to config', () => {
    const idx = GATEWAY_SRC.indexOf('async function shutdown(signal: string)')
    expect(idx).toBeGreaterThan(0)
    const win = GATEWAY_SRC.slice(idx, idx + 6000)
    expect(win).not.toContain('writeRelaunchModelIntent')
    expect(win).not.toContain('GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX')
    // The queued-command persist at shutdown still writes a consume-once carrier.
    expect(win).toContain('persistQueuedCommandForRestart')
  })
})
