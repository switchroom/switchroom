/**
 * InboundDeliveryStateMachine — DISPATCH (Phase 2b PR 3a, bridgeUp cutover).
 *
 * Per RFC `docs/rfcs/inbound-delivery-state-machine.md`, the state
 * machine is pure: `transition(state, event) → { state', effects[] }`.
 * The gateway's job is to (a) emit events at the right moments and
 * (b) execute the returned effects against real I/O. This module owns
 * step (b) for the cutover.
 *
 * Scope of THIS PR — bridgeUp only:
 *   - drainBuffer                       → executed
 *   - redeliverPersistedPermVerdicts    → executed
 *   - logTrace                          → executed
 *
 * Other effects (deliverToBridge, bufferInbound, persistInbound,
 * setTurnStarted, clearTurnStarted, noteOutbound, firePoke,
 * deliverPermVerdict, persistPermVerdict) still flow through their
 * existing imperative paths in `gateway.ts`. The dispatcher logs them
 * as `not-yet-cutover` so a future PR can wire them without grep-and-
 * pray. NEVER silently no-op: the trace is the gate.
 *
 * Kill switch: `SWITCHROOM_DELIVERY_MACHINE_CUTOVER=0` disables
 * dispatcher execution and the gateway falls back to imperative-only.
 * Default is ON — this PR is the cutover.
 */

import type {
  Effect,
  InboundMessage as MachineInboundMessage,
} from './inbound-delivery-machine.js'
import type { IpcServer, IpcClient } from './ipc-server.js'
import type { InboundMessage } from './ipc-protocol.js'
import type { PendingInboundBuffer } from './pending-inbound-buffer.js'
import { redeliverBufferedInbound } from './pending-inbound-buffer.js'
import type { InboundSpool } from './inbound-spool.js'
import type { PendingPermissionBuffer } from './pending-permission-decisions.js'

export interface DispatchCtx {
  readonly selfAgent: string
  readonly ipcServer: IpcServer
  readonly pendingInboundBuffer: PendingInboundBuffer
  readonly inboundSpool: InboundSpool | null
  readonly pendingPermissionBuffer: PendingPermissionBuffer
  /** Optional: when set, prefer sending direct to this client (bridgeUp path). */
  readonly client?: IpcClient
  /** Optional log sink — default stderr. Test hook. */
  readonly log?: (line: string) => void
}

const enabled = process.env.SWITCHROOM_DELIVERY_MACHINE_CUTOVER !== '0'

export function isDispatchEnabled(): boolean {
  return enabled
}

/**
 * Execute the effects returned by `transition()`. Pure imperative
 * driver: side-effects only, no machine state held here.
 *
 * Effects are dispatched in the order returned by the machine. The
 * machine guarantees a sensible order (e.g., `setTurnStarted` before
 * `deliverToBridge` so a downstream observer sees the turn marker
 * already up).
 */
export function dispatchEffects(effects: readonly Effect[], ctx: DispatchCtx): void {
  if (!enabled) return
  for (const effect of effects) {
    dispatchOne(effect, ctx)
  }
}

function dispatchOne(effect: Effect, ctx: DispatchCtx): void {
  const log = ctx.log ?? ((line: string) => process.stderr.write(line))
  switch (effect.kind) {
    case 'drainBuffer': {
      // The bridgeUp drain: flush any synthetic inbounds queued for
      // this agent while the bridge was offline. Mirrors what
      // onClientRegistered did inline pre-cutover (gateway.ts:3219-3236).
      // Lossless: redeliverBufferedInbound re-buffers any per-message
      // miss and tombstones the durable spool entry on confirmed
      // delivery.
      const send = (msg: InboundMessage): boolean => {
        // Prefer the just-registered client when present (bridgeUp
        // path) — that's a direct send. Fall back to ipcServer
        // lookup for non-client-bound drains (turn-complete flush
        // from a future PR).
        if (ctx.client) {
          try {
            ctx.client.send(msg)
            return true
          } catch (err) {
            log(
              `telegram gateway: dispatch drainBuffer client.send threw agent=${ctx.selfAgent} ` +
                `source=${msg.meta?.source ?? '-'}: ${(err as Error).message}\n`,
            )
            return false
          }
        }
        return ctx.ipcServer.sendToAgent(ctx.selfAgent, msg)
      }
      const result = redeliverBufferedInbound(
        ctx.pendingInboundBuffer,
        ctx.selfAgent,
        send,
        ctx.inboundSpool ?? undefined,
      )
      if (result.drained > 0) {
        log(
          `telegram gateway: dispatch drainBuffer agent=${ctx.selfAgent} ` +
            `drained=${result.drained} redelivered=${result.redelivered} ` +
            `rebuffered=${result.rebuffered}\n`,
        )
      }
      return
    }

    case 'redeliverPersistedPermVerdicts': {
      // Drain permission verdicts missed while the bridge was offline.
      // A claude turn suspended inside the MCP permission call is
      // unblocked the moment the reconnecting bridge relays the
      // verdict. Mirrors the pre-cutover loop at gateway.ts:3242-3252.
      const pending = ctx.pendingPermissionBuffer.drain(ctx.selfAgent)
      let delivered = 0
      let failed = 0
      for (const ev of pending) {
        try {
          if (ctx.client) {
            ctx.client.send(ev)
          } else {
            ctx.ipcServer.sendToAgent(ctx.selfAgent, ev)
          }
          delivered++
        } catch (err) {
          failed++
          log(
            `telegram gateway: dispatch redeliverPerm send threw agent=${ctx.selfAgent} ` +
              `request=${ev.requestId} behavior=${ev.behavior}: ${(err as Error).message}\n`,
          )
        }
      }
      if (pending.length > 0) {
        log(
          `telegram gateway: dispatch redeliverPerm agent=${ctx.selfAgent} ` +
            `delivered=${delivered} failed=${failed}\n`,
        )
      }
      return
    }

    case 'logTrace': {
      const keyPart = effect.key ? ` key=${effect.key}` : ''
      const metaPart = effect.metadata
        ? ' ' + Object.entries(effect.metadata).map(([k, v]) => `${k}=${String(v)}`).join(' ')
        : ''
      log(`gw-trace dispatch stage=${effect.stage}${keyPart}${metaPart}\n`)
      return
    }

    // The cases below are KNOWN effect kinds that this PR does NOT
    // cut over. The imperative paths still run for them; the
    // dispatcher logs the event so future cutover PRs can grep for
    // exactly the call sites to migrate.
    case 'deliverToBridge':
    case 'bufferInbound':
    case 'persistInbound':
    case 'setTurnStarted':
    case 'clearTurnStarted':
    case 'noteOutbound':
    case 'firePoke':
    case 'deliverPermVerdict':
    case 'persistPermVerdict': {
      log(`gw-trace dispatch not-yet-cutover effect=${effect.kind}\n`)
      return
    }
  }
}

/**
 * Test hook: invoke the per-effect dispatcher directly so unit tests
 * can drive individual effects against mocks without constructing a
 * full effects array.
 */
export function __dispatchOneForTests(effect: Effect, ctx: DispatchCtx): void {
  dispatchOne(effect, ctx)
}

/** Type re-export — convenience for test fixtures. */
export type { MachineInboundMessage }
