/**
 * IPC inject seam for the Buzz sidecar.
 *
 * Reuses the scheduler's `createInjectIpcClient` verbatim (the same anonymous,
 * register-free NDJSON client that cron uses) — the Phase 0 keystone is that an
 * UNregistered client can `inject_inbound` and survives past the 30s heartbeat
 * eviction window (watchdog skips `agentName === null`). The Buzz sidecar MUST
 * NOT send a `register` frame — doing so would evict the agent's Claude MCP
 * bridge. `createInjectIpcClient` never registers, which is exactly what we
 * want; this wrapper just turns an `InboundMessage` into the `inject_inbound`
 * envelope for the pump.
 */

import type { InjectIpcClient } from "../agent-scheduler/ipc-client.js";
import type { InboundMessage, InjectInboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";

/**
 * Build the pump's `inject` closure. Wraps the inbound in an `inject_inbound`
 * envelope addressed to `agentName` and hands it to the anonymous IPC client.
 * Returns true iff the bytes were accepted by the local gateway socket.
 */
export function makeInject(
  client: Pick<InjectIpcClient, "sendInjectInbound">,
  agentName: string,
): (inbound: InboundMessage) => boolean {
  return (inbound: InboundMessage): boolean => {
    const msg: InjectInboundMessage = {
      type: "inject_inbound",
      agentName,
      inbound,
    };
    return client.sendInjectInbound(msg);
  };
}
