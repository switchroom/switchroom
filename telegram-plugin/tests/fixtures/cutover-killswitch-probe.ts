/**
 * Subprocess probe for the SWITCHROOM_DELIVERY_MACHINE_CUTOVER kill switch.
 *
 * The cutover env var is read at MODULE LOAD in both
 * `inbound-delivery-machine-dispatch.ts` and
 * `inbound-delivery-machine-shadow.ts`, so an in-process test can't flip it
 * after import (and bun's `vi` shim has no resetModules/stubEnv). The
 * cutover-flip test spawns this script under `bun` with the env it wants
 * and asserts the JSON verdict printed on stdout.
 *
 * Output: one JSON line —
 *   {
 *     dispatchEnabled, cutoverEnabled, shadowEnabled,
 *     sendCalls, buffered, setTurnStartedCalls, deliverResults
 *   }
 * after driving a fresh-turn inbound effect set through dispatchEffects
 * against a recording fake ctx.
 */

import { dispatchEffects, isDispatchEnabled } from '../../gateway/inbound-delivery-machine-dispatch'
import {
  isDeliveryCutoverEnabled,
  __shadowEnabledForTests,
} from '../../gateway/inbound-delivery-machine-shadow'
import { createPendingInboundBuffer } from '../../gateway/pending-inbound-buffer'
import { createPendingPermissionBuffer } from '../../gateway/pending-permission-decisions'
import { initialState, transition, type ChatKey } from '../../gateway/inbound-delivery-machine'

const KEY = '111:_' as ChatKey
const msg = { type: 'inbound', chatId: '111', messageId: 42, text: 'hello' }

const alive = transition(initialState(), { kind: 'bridgeUp', at: 1000 }).state
const { effects } = transition(alive, {
  kind: 'inbound',
  key: KEY,
  msg: { msgId: 42, isSteering: false, payload: msg },
  at: 2000,
})

let sendCalls = 0
const buffer = createPendingInboundBuffer()
let setTurnStartedCalls = 0
const deliverResults: boolean[] = []

dispatchEffects(effects, {
  selfAgent: 'probe-agent',
  ipcServer: {
    sendToAgent: () => {
      sendCalls++
      return true
    },
  } as never,
  pendingInboundBuffer: buffer,
  inboundSpool: null,
  pendingPermissionBuffer: createPendingPermissionBuffer(),
  log: () => {},
  onSetTurnStarted: () => {
    setTurnStartedCalls++
  },
  onDeliverResult: (_k, ok) => {
    deliverResults.push(ok)
  },
})

process.stdout.write(
  JSON.stringify({
    dispatchEnabled: isDispatchEnabled(),
    cutoverEnabled: isDeliveryCutoverEnabled(),
    shadowEnabled: __shadowEnabledForTests(),
    sendCalls,
    buffered: buffer.drain('probe-agent').length,
    setTurnStartedCalls,
    deliverResults,
  }) + '\n',
)
