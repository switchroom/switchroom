/**
 * InboundDeliveryStateMachine — DISPATCH (Phase 2b PR 3a, bridgeUp cutover).
 *
 * Per RFC `reference/rfcs/inbound-delivery-state-machine.md`, the state
 * machine is pure: `transition(state, event) → { state', effects[] }`.
 * The gateway's job is to (a) emit events at the right moments and
 * (b) execute the returned effects against real I/O. This module owns
 * step (b) for the cutover.
 *
 * Effects wired to real executors (all effect kinds now handled):
 *   - drainBuffer                       → redeliverBufferedInbound
 *   - redeliverPersistedPermVerdicts    → pendingPermissionBuffer.drain → send
 *   - deliverToBridge                   → client.send / ipcServer.sendToAgent
 *   - bufferInbound                     → pendingInboundBuffer.push
 *   - persistInbound                    → inboundSpool.put
 *   - deliverPermVerdict                → client.send / ipcServer.sendToAgent
 *   - persistPermVerdict                → pendingPermissionBuffer.push
 *   - setTurnStarted / clearTurnStarted → onSetTurnStarted / onClearTurnStarted
 *   - noteOutbound                      → onNoteOutbound
 *   - firePoke                          → onFirePoke
 *   - logTrace                          → executed
 *
 * Live call sites (post PR3c flip, #2794):
 *   - bridgeUp (gateway onClientRegistered): drainBuffer /
 *     redeliverPersistedPermVerdicts / logTrace.
 *   - handleInbound DEFERRED_INBOUND_EMIT: the inbound-routing effects
 *     (deliverToBridge / bufferInbound / persistInbound / setTurnStarted)
 *     are AUTHORITATIVE when the cutover is on — the imperative twin in
 *     gateway.ts runs only under the kill switch or the documented
 *     carve-outs (interrupt-while-in-turn, bridge_dead). The twin is
 *     deleted in PR4 after the 48h bake (see the "Hard removal plan"
 *     checklist in the RFC: PR3b step 2 / PR4 remain open).
 *   - turnEnd lifecycle effects remain shadow-only: the imperative
 *     turn-end sites (purgeReactionTracking / releaseTurnBufferGate)
 *     already execute the effect-equivalents with gates the machine does
 *     not model yet (serialize-until-replied drain); PR3b step 2 tracks
 *     that flip.
 *
 * The gateway-internal turn/poke effects (setTurnStarted,
 * clearTurnStarted, noteOutbound, firePoke) map to gateway-scope state
 * (the silence-poke ladder, turn markers) that this decoupled module
 * cannot reach directly, so they are dispatched through OPTIONAL
 * callbacks on the ctx. When a callback is absent the effect logs an
 * `unwired` trace rather than silently no-opping — the trace is the gate.
 *
 * The `SWITCHROOM_DELIVERY_MACHINE_CUTOVER` kill switch was removed in
 * #2996 P1 after the cutover baked — the dispatcher always executes.
 */

import type {
  Effect,
  ChatKey,
  InboundMessage as MachineInboundMessage,
} from './inbound-delivery-machine.js'
import type { IpcServer, IpcClient } from './ipc-server.js'
import type { InboundMessage, PermissionEvent } from './ipc-protocol.js'
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
  /**
   * Optional: enrol a drained+redelivered inbound in the deliver-until-acked
   * queue. The bridgeUp drain's socket-write "success" is NOT proof claude
   * consumed the message — right after a restart (esp. with a slow MCP boot)
   * the inject can hit a not-ready session and be dropped. Wiring this makes
   * the existing 5s sweep re-deliver until claude's `enqueue` ack lands.
   * (clerk lost-message incident, 2026-06-03.)
   */
  readonly onUserInboundDelivered?: (merged: InboundMessage) => void
  // ── Gateway-internal turn/poke effect callbacks ──────────────────
  // These effects map to gateway-scope state (the silence-poke ladder,
  // turn markers) that this decoupled module cannot reach. The
  // gateway supplies them at the live inbound call site. Absent → the
  // effect logs an `unwired` trace.
  readonly onSetTurnStarted?: (key: ChatKey, at: number) => void
  /**
   * Optional: observe the outcome of a `deliverToBridge` effect. The
   * imperative twin branches on `sendToAgent`'s boolean (delivered →
   * steer-ack + busy-mark + delivery-confirm tracking; miss → release
   * reservation + durable-buffer + restart notice). The machine cannot
   * model a send that fails while the bridge is nominally alive, so the
   * PR3c live call site needs the result to run the same post-send
   * branches the twin runs. Called once per deliverToBridge effect,
   * after the send attempt, before `onUserInboundDelivered` enrolment.
   */
  readonly onDeliverResult?: (key: ChatKey, ok: boolean, msg: InboundMessage) => void
  readonly onClearTurnStarted?: (key: ChatKey) => void
  readonly onNoteOutbound?: (key: ChatKey, at: number) => void
  readonly onFirePoke?: (key: ChatKey, level: 'soft' | 'firm' | 'fallback') => void
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
        ctx.onUserInboundDelivered
          ? (merged) => ctx.onUserInboundDelivered!(merged)
          : undefined,
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

    case 'deliverToBridge': {
      // Route a single inbound to the live bridge. The machine's
      // InboundMessage.payload carries the real ipc-protocol
      // InboundMessage; the machine treats it as opaque.
      const msg = effect.msg.payload as InboundMessage
      let ok = false
      try {
        if (ctx.client) {
          ctx.client.send(msg)
          ok = true
        } else {
          ok = ctx.ipcServer.sendToAgent(ctx.selfAgent, msg)
        }
      } catch (err) {
        log(
          `telegram gateway: dispatch deliverToBridge send threw agent=${ctx.selfAgent} ` +
            `key=${effect.key}: ${(err as Error).message}\n`,
        )
        ok = false
      }
      if (ctx.onDeliverResult) {
        try {
          ctx.onDeliverResult(effect.key, ok, msg)
        } catch {
          /* observer is best-effort; never breaks delivery */
        }
      }
      if (ok && ctx.onUserInboundDelivered) {
        // Enrol in the deliver-until-acked sweep — a socket write is not
        // proof claude consumed it (see onUserInboundDelivered doc).
        // Pass UNCONDITIONALLY, mirroring the drainBuffer path above:
        // the callback self-gates via shouldTrackDelivery (inbound-
        // delivery-confirm.ts), which REJECTS sourced messages and
        // tracks real user inbounds (meta.source undefined) — exactly
        // the messages the sweep protects. Do NOT pre-filter on
        // meta.source here; an inverted guard would skip user inbounds
        // and enrol only messages the inner gate discards.
        try {
          ctx.onUserInboundDelivered(msg)
        } catch {
          /* enrolment is best-effort; never breaks delivery */
        }
      }
      log(`gw-trace dispatch deliverToBridge key=${effect.key} ok=${ok}\n`)
      return
    }

    case 'bufferInbound': {
      const msg = effect.msg.payload as InboundMessage
      const buffered = ctx.pendingInboundBuffer.push(ctx.selfAgent, msg)
      log(`gw-trace dispatch bufferInbound key=${effect.key} buffered=${buffered}\n`)
      return
    }

    case 'persistInbound': {
      // Durable spool. `pendingInboundBuffer.push` already spools when a
      // spool is attached to the buffer, so a persistInbound paired with
      // a bufferInbound is idempotent (put() is idempotent by spoolId).
      const msg = effect.msg.payload as InboundMessage
      const put = ctx.inboundSpool ? ctx.inboundSpool.put(ctx.selfAgent, msg) : false
      log(`gw-trace dispatch persistInbound key=${effect.key} put=${put}\n`)
      return
    }

    case 'deliverPermVerdict': {
      // Branch order differs from the imperative twin
      // (gateway.ts dispatchPermissionVerdict), which always goes via
      // `ipcServer.sendToAgent` — it runs outside any bridgeUp context,
      // so it has no just-registered client handle. Here `ctx.client`
      // is preferred WHEN PRESENT for the same reason as drainBuffer /
      // redeliverPersistedPermVerdicts above: on the bridgeUp path the
      // registry lookup may not yet observe the just-registered client,
      // and a direct send to the connecting socket is the reliable
      // route. PR3c's live call site for machine-driven permVerdict
      // events (non-bridgeUp) must construct the ctx WITHOUT `client`,
      // which makes this branch behave exactly like the twin
      // (sendToAgent). Note the twin additionally buffers on a failed
      // send; the machine models that as a separate persistPermVerdict
      // effect (bridge_dead state), so no fallback push here.
      const ev = effect.verdict.payload as PermissionEvent
      let ok = false
      try {
        if (ctx.client) {
          ctx.client.send(ev as never)
          ok = true
        } else {
          ok = ctx.ipcServer.sendToAgent(ctx.selfAgent, ev as never)
        }
      } catch (err) {
        log(
          `telegram gateway: dispatch deliverPermVerdict send threw agent=${ctx.selfAgent} ` +
            `request=${effect.verdict.requestId}: ${(err as Error).message}\n`,
        )
        ok = false
      }
      log(`gw-trace dispatch deliverPermVerdict request=${effect.verdict.requestId} ok=${ok}\n`)
      return
    }

    case 'persistPermVerdict': {
      const ev = effect.verdict.payload as PermissionEvent
      const pushed = ctx.pendingPermissionBuffer.push(ctx.selfAgent, ev)
      log(`gw-trace dispatch persistPermVerdict request=${effect.verdict.requestId} pushed=${pushed}\n`)
      return
    }

    case 'setTurnStarted': {
      if (ctx.onSetTurnStarted) ctx.onSetTurnStarted(effect.key, effect.at)
      else log(`gw-trace dispatch unwired effect=setTurnStarted key=${effect.key}\n`)
      return
    }

    case 'clearTurnStarted': {
      if (ctx.onClearTurnStarted) ctx.onClearTurnStarted(effect.key)
      else log(`gw-trace dispatch unwired effect=clearTurnStarted key=${effect.key}\n`)
      return
    }

    case 'noteOutbound': {
      if (ctx.onNoteOutbound) ctx.onNoteOutbound(effect.key, effect.at)
      else log(`gw-trace dispatch unwired effect=noteOutbound key=${effect.key}\n`)
      return
    }

    case 'firePoke': {
      if (ctx.onFirePoke) ctx.onFirePoke(effect.key, effect.level)
      else log(`gw-trace dispatch unwired effect=firePoke key=${effect.key} level=${effect.level}\n`)
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
