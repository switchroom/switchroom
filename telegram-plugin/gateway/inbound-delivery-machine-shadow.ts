/**
 * InboundDeliveryStateMachine — live machine state + event driver.
 *
 * Historically the "shadow mode" wiring (RFC
 * `reference/rfcs/inbound-delivery-state-machine.md` Phase 2b PR 2): the
 * machine ran ALONGSIDE the imperative gateway code, predicting effects
 * to a structured trace. The #3012 cutover made this state AUTHORITATIVE
 * for the turn-in-flight gate and the deliver-vs-buffer inbound routing,
 * and #2996 P1 removed the kill switches (`SWITCHROOM_DELIVERY_MACHINE_SHADOW`,
 * `SWITCHROOM_DELIVERY_MACHINE_CUTOVER`) — the machine is now the sole
 * delivery authority. (The `shadowEmit` name is kept for its ~15 gateway
 * call sites; the `gw-trace shadow` trace prefix is kept for log-parser
 * continuity.) This module's job:
 *
 *   1. Own the module-scope machine state.
 *   2. Expose `shadowEmit(event)` that runs `transition()`, advances the
 *      state, logs via `gw-trace shadow ...` stderr lines, and RETURNS
 *      the effects for the gateway to execute (`dispatchEffects`).
 *   3. Expose `isMachineInTurn()` — the authoritative gate read.
 *   4. Provide test hooks for resetting + inspecting state.
 *
 * Telemetry: each `shadowEmit` writes a single stderr line with the
 * event kind + emitted effect kinds. Operators can then:
 *
 *   docker exec switchroom-<agent> sh -lc 'grep "gw-trace shadow" \
 *     /var/log/switchroom/gateway-supervisor.log | tail -50'
 *
 * Trace verbosity (#3025): the TTL `tick` event fires every ~30s and on a
 * healthy idle agent emits a zero-signal `event=tick effects=[]
 * global=bridge_alive_idle` line. Those no-op ticks are SUPPRESSED by
 * default (they filled gateway-supervisor.log to 555MB on clerk). Set
 * `SWITCHROOM_GW_TRACE=1` to restore the full firehose — every tick, poll,
 * and event line — when debugging the delivery/poll path. The gate lives
 * in `../shared/gw-trace-gate.ts` and also governs the `tg-post` poll
 * heartbeats. Real events, turn-expiring ticks, and in-turn ticks always
 * log regardless of the flag.
 */

import {
  type Effect,
  type Event,
  type State,
  initialState,
  transition,
} from './inbound-delivery-machine.js'
import { shouldEmitShadowTrace } from '../shared/gw-trace-gate.js'

let state: State = initialState()

/**
 * Authoritative "is a turn currently in flight?" read for the gate.
 * The machine tracks ONE `activeTurn` (single bridge) plus TTL `tick`
 * expiry, so — unlike the deleted per-delivery `claudeBusyKeys` set —
 * it cannot accumulate orphan keys and wedge the gate "in-flight
 * forever" (the gymbro/clerk 5-min dangle of 2026-05-28). `bridge_dead`
 * and `bridge_alive_idle` are both "not in flight".
 */
export function isMachineInTurn(): boolean {
  return state.global.kind === 'bridge_alive_in_turn'
}

/**
 * Run an event through the state machine: the machine state advances,
 * the effects are logged and RETURNED for the caller to execute
 * (`dispatchEffects` at the live inbound/bridgeUp call sites; the
 * lifecycle emits — turnStart/turnEnd/modelOutbound/tick — advance state
 * only and ignore the return, their real-world work still being
 * imperative per the RFC's open PR3b checklist).
 */
export function shadowEmit(event: Event): readonly Effect[] {
  // The machine driver MUST NEVER break the gateway. The state machine
  // is pure (no I/O, no async) and property-tested over 5000 schedules,
  // so transition() won't throw on well-formed input. But event
  // construction at the call site could mis-shape inputs; the
  // try/catch is belt-and-braces so a driver bug never wedges a real
  // turn. The catch logs and bails — the gateway code below the emit
  // point still runs (falling back to the buffer-everything semantics
  // of an un-advanced machine).
  try {
    const result = transition(state, event)
    state = result.state

    // Single structured stderr line per event — grep-friendly and
    // low volume (one line per gateway event, not per effect). The
    // format matches gateway.ts's existing `tg-post method=...` shape
    // so log aggregation can pick it up without a new parser.
    // #3025: the TTL `tick` event fires every ~30s. On a healthy idle
    // agent it produces no effects and leaves the machine idle — a
    // zero-signal heartbeat that (unrotated) grew this log to 555MB on
    // clerk. Suppress those no-op ticks unless the operator opted into
    // the full firehose (SWITCHROOM_GW_TRACE=1). Real events, ticks that
    // expire a turn (non-empty effects), and in-turn ticks still log.
    if (
      shouldEmitShadowTrace(event.kind, result.effects.length, state.global.kind)
    ) {
      const effectKinds = result.effects.map((e) => e.kind).join(',')
      const eventDetail = formatEventDetail(event)
      process.stderr.write(
        `gw-trace shadow event=${event.kind}${eventDetail} effects=[${effectKinds}] global=${state.global.kind} perKeySize=${state.perKey.size}\n`,
      )
    }
    return result.effects
  } catch (err) {
    process.stderr.write(
      `gw-trace shadow ERROR event=${event.kind} err=${err instanceof Error ? err.message : String(err)}\n`,
    )
    return []
  }
}

/** Compact event detail for the trace line — keeps the line one-line. */
function formatEventDetail(event: Event): string {
  switch (event.kind) {
    case 'inbound':
      return ` key=${event.key} msg=${event.msg.msgId} steer=${event.msg.isSteering}`
    case 'turnStart':
    case 'turnEnd':
      return ` key=${event.key}${event.kind === 'turnEnd' ? ` outbound=${event.outboundEmitted}` : ''}`
    case 'permVerdict':
      return ` req=${event.verdict.requestId} behavior=${event.verdict.behavior}`
    case 'modelOutbound':
      return ` key=${event.key}`
    case 'bridgeUp':
    case 'bridgeDown':
    case 'tick':
      return ''
  }
}

/** Test hook: reset state to the initial empty machine. */
export function __shadowResetForTests(): void {
  state = initialState()
}

/** Test hook: read the current shadow state. */
export function __shadowGetStateForTests(): State {
  return state
}
