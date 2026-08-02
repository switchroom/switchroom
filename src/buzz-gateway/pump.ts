/**
 * The Buzz inbound pump — the one place an incoming Nostr event becomes (or is
 * refused) a turn. Wires the auth gate, dedup store, and event map together
 * behind a single `handleEvent`, so the whole admit→dedup→map→inject decision
 * is unit-testable without a relay, a socket, or a running gateway.
 *
 * Ordering is load-bearing and asserted by tests:
 *   1. auth gate (signature + allowlist + self-echo)  — fail-closed
 *   2. dedup                                           — never double-fire
 *   3. map (kind:9 → InboundMessage, else drop)
 *   4. inject onto the gateway socket
 *   5. record in the dedup journal — ONLY after a successful inject, so a
 *      failed inject can be re-attempted on the next redelivery.
 */

import type { InboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";
import { admitEvent, type AuthRejectReason, type NostrEventLike } from "./auth-gate.js";
import type { BuzzRuntimeConfig } from "./config.js";
import { isChannelLive } from "./config.js";
import type { DedupStore } from "./dedup.js";
import { mapBuzzEvent } from "./inbound-map.js";

export type PumpOutcome =
  | "injected"
  | "duplicate"
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

      if (deps.dedup.has(event.id)) {
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
        // Do NOT record — a redelivery must be able to inject once the socket
        // recovers. The relay resends on resubscribe/reconnect.
        bump("inject_failed");
        log(`buzz pump: inject failed id=${event.id.slice(0, 12)} (not recording; will retry on redelivery)`);
        return "inject_failed";
      }

      deps.dedup.record(event.id);
      bump("injected");
      return "injected";
    },
  };
}
