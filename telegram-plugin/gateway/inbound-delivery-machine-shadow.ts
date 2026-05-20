/**
 * InboundDeliveryStateMachine — SHADOW MODE wiring (Phase 2b PR 2).
 *
 * Per RFC `docs/rfcs/inbound-delivery-state-machine.md` Phase 2b PR 2:
 * the state machine runs ALONGSIDE the existing imperative gateway
 * code, recording predicted effects to a structured trace. Behavior
 * is unchanged — every existing code path still executes the actual
 * I/O. This module's job:
 *
 *   1. Own the module-scope machine state.
 *   2. Expose `shadowEmit(event)` that runs `transition()` + logs the
 *      predicted effects via `gw-trace shadow ...` stderr lines.
 *   3. Provide test hooks for resetting + inspecting state.
 *
 * After PR 2 bakes on the fleet for 24+ hours, PR 3 will wire the
 * effects to drive ACTUAL behavior (the cutover), at which point the
 * imperative paths get deleted in PR 4.
 *
 * Telemetry approach: each `shadowEmit` writes a single stderr line
 * with the event kind + emitted effect kinds. Operators can then:
 *
 *   docker exec switchroom-<agent> sh -lc 'grep "gw-trace shadow" \
 *     /var/log/switchroom/gateway-supervisor.log | tail -50'
 *
 * to see what the state machine PREDICTS the gateway should do for
 * each event. Comparing against the actual log lines (`pending-inbound-
 * buffer: agent=X buffered ...` etc.) is the validation that the
 * machine is bit-identical with reality.
 *
 * Toggle off via `SWITCHROOM_DELIVERY_MACHINE_SHADOW=0` — a kill
 * switch for the case where the shadow emits prove problematic
 * (e.g., trace volume too high). The default is ON.
 */

import {
  type Effect,
  type Event,
  type State,
  initialState,
  transition,
} from './inbound-delivery-machine.js'

let state: State = initialState()
const enabled = process.env.SWITCHROOM_DELIVERY_MACHINE_SHADOW !== '0'

/**
 * Run an event through the state machine in shadow mode. The machine
 * state advances, the predicted effects are LOGGED, but no I/O fires.
 *
 * Returns the effects for callers that want to inspect them inline
 * (e.g., the eventual PR 3 cutover will replace the return-and-ignore
 * pattern here with return-and-execute).
 */
export function shadowEmit(event: Event): readonly Effect[] {
  if (!enabled) return []
  // Shadow mode MUST NEVER break the gateway. The state machine is
  // pure (no I/O, no async) and property-tested over 5000 schedules,
  // so transition() won't throw on well-formed input. But event
  // construction at the call site could mis-shape inputs; the
  // try/catch is belt-and-braces so a shadow bug never wedges a real
  // turn. The catch logs and bails — the imperative gateway code
  // below the emit point still runs.
  try {
    const result = transition(state, event)
    state = result.state

    // Single structured stderr line per event — grep-friendly and
    // low volume (one line per gateway event, not per effect). The
    // format matches gateway.ts's existing `tg-post method=...` shape
    // so log aggregation can pick it up without a new parser.
    const effectKinds = result.effects.map((e) => e.kind).join(',')
    const eventDetail = formatEventDetail(event)
    process.stderr.write(
      `gw-trace shadow event=${event.kind}${eventDetail} effects=[${effectKinds}] global=${state.global.kind} perKeySize=${state.perKey.size}\n`,
    )
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

/** Test hook: check if shadow mode is enabled (mirrors the env-var). */
export function __shadowEnabledForTests(): boolean {
  return enabled
}
