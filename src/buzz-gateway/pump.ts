/**
 * The Buzz inbound pump — the one place an incoming Nostr event becomes (or is
 * refused) a turn. Wires the auth gate, dedup store, and event map together
 * behind a single `handleEvent`, so the whole admit→dedup→map→inject decision
 * is unit-testable without a relay, a socket, or a running gateway.
 *
 * Ordering is load-bearing and asserted by tests:
 *   1. auth gate (signature + allowlist + self-echo)  — fail-closed
 *   2. dedup — never double-fire. An id is "already accounted for" if it is in
 *      the durable dedup journal OR pending in the in-memory retry queue.
 *   3. map (kind:9 → InboundMessage, else drop)
 *   4. inject onto the gateway socket
 *   5. on success: record in the dedup journal. On failure: hand the mapped
 *      inbound to the retry queue, which re-attempts inject against the IPC
 *      client's reconnect and records dedup only once the inject lands. Nothing
 *      is dropped just because the gateway was momentarily down (MAJOR-1).
 */

import type { InboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";
import { admitEvent, type AuthRejectReason, type NostrEventLike } from "./auth-gate.js";
import type { BuzzRuntimeConfig } from "./config.js";
import { isChannelLive } from "./config.js";
import type { DedupStore } from "./dedup.js";
import { mapBuzzEvent } from "./inbound-map.js";
import type { RetryQueue } from "./retry-queue.js";

export type PumpOutcome =
  | "injected"
  | "duplicate"
  | "queued"
  | "unmapped"
  | "inject_failed"
  | "channel_off"
  | `rejected:${AuthRejectReason}`;

export interface PumpDeps {
  config: BuzzRuntimeConfig;
  dedup: DedupStore;
  /** Deliver the inbound onto the gateway socket. Returns true iff the bytes
   *  were accepted (the strongest signal a fire-and-forget client gets). */
  inject: (inbound: InboundMessage) => boolean;
  /** Redelivery queue for injects that fail because the gateway is momentarily
   *  down (MAJOR-1). When present, a failed inject is enqueued here rather than
   *  dropped, and a queued id counts as already-accounted-for by dedup. When
   *  absent, a failed inject is dropped and relies on relay resubscribe. */
  retryQueue?: Pick<RetryQueue, "has" | "enqueue">;
  /** Signature verifier (nostr-tools `verifyEvent` in production). */
  verify: (ev: NostrEventLike) => boolean;
  /** This agent's own pubkey (hex, lowercase), to drop self-echoes. */
  agentPubkey: string | null;
  log?: (msg: string) => void;
}

export interface InboundPump {
  handleEvent(ev: unknown): PumpOutcome;
  /** Rejection counters, by reason — for observability. Never carries content. */
  readonly stats: Readonly<Record<string, number>>;
}

export function createInboundPump(deps: PumpDeps): InboundPump {
  const log = deps.log ?? (() => {});
  const stats: Record<string, number> = Object.create(null);
  const bump = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };

  return {
    stats,
    handleEvent(ev: unknown): PumpOutcome {
      // Defensive: the sidecar should never subscribe when the channel is off,
      // but if an event slips through, drop it.
      if (!isChannelLive(deps.config)) {
        bump("channel_off");
        return "channel_off";
      }

      const admit = admitEvent(ev, {
        authorized: deps.config.authorized,
        agentPubkey: deps.agentPubkey,
        verify: deps.verify,
      });
      if (!admit.ok) {
        bump(`rejected:${admit.reason}`);
        // Log id/pubkey/reason only when we have a structurally valid event —
        // never the content.
        const e = ev as Partial<NostrEventLike>;
        const idPart = typeof e?.id === "string" ? e.id.slice(0, 12) : "?";
        const pkPart = typeof e?.pubkey === "string" ? e.pubkey.slice(0, 12) : "?";
        log(`buzz pump: rejected id=${idPart} pubkey=${pkPart} reason=${admit.reason}`);
        return `rejected:${admit.reason}`;
      }

      // Admitted ⇒ structurally valid, so this cast is safe.
      const event = ev as NostrEventLike;

      // Already accounted for if it is in the durable journal OR pending a
      // retry inject (in which case injecting again here would double-fire).
      if (deps.dedup.has(event.id) || deps.retryQueue?.has(event.id)) {
        bump("duplicate");
        return "duplicate";
      }

      const inbound = mapBuzzEvent(event, {
        chatId: deps.config.chatId,
        groupId: deps.config.groupId,
        pubkeyNames: deps.config.pubkeyNames,
      });
      if (inbound === null) {
        bump("unmapped");
        return "unmapped";
      }

      const sent = deps.inject(inbound);
      if (!sent) {
        // Do NOT record in dedup — the inject has not landed. Hand the mapped
        // inbound to the retry queue, which re-attempts against the IPC client's
        // reconnect and records dedup only once the inject succeeds (MAJOR-1).
        // While it sits there, a relay redelivery of this id dedups above.
        if (deps.retryQueue) {
          deps.retryQueue.enqueue(event.id, inbound);
          bump("queued");
          log(`buzz pump: inject failed id=${event.id.slice(0, 12)} (queued for redelivery)`);
          return "queued";
        }
        bump("inject_failed");
        log(`buzz pump: inject failed id=${event.id.slice(0, 12)} (no retry queue; relying on relay resubscribe)`);
        return "inject_failed";
      }

      deps.dedup.record(event.id);
      bump("injected");
      return "injected";
    },
  };
}
