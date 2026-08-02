/**
 * Inbound inject retry queue for the Buzz sidecar (Phase 1, MAJOR-1 fix).
 *
 * The failure this closes: the gateway (hub) can be momentarily down — e.g. it
 * is restarting — while the relay WebSocket stays up. In that window an admitted
 * Buzz event maps cleanly but `inject_inbound` fails because the local
 * `gateway.sock` is not accepting writes. The relay only resends on resubscribe,
 * and the sidecar resubscribes only on WS reconnect/AUTH — neither of which an
 * inject failure triggers — so without this queue the event is silently lost.
 *
 * The mechanism is deterministic, not best-effort: on inject failure the pump
 * enqueues the already-mapped inbound here (keyed by Nostr event id). A periodic
 * drain re-attempts the inject against the IPC client's own reconnect; on the
 * first success it records the id in the durable dedup journal (via
 * `onInjected`) and removes it. This guarantees an event that failed to inject
 * because the gateway was momentarily down is eventually delivered as a turn
 * once the gateway is back.
 *
 * No double-fire: while an id sits in this queue the pump treats a relay
 * redelivery of the same id as already-accounted-for (see pump.ts `has()`), and
 * once the drain injects it the id lands in the dedup journal, so every later
 * redelivery deduplicates. An id is injected from exactly one place at a time.
 *
 * Residual (in-memory only): entries are lost if the SIDECAR PROCESS itself
 * crashes before a drain succeeds. That case is backstopped by the resubscribe
 * watermark, which the nostr client now advances only on a durably-handled
 * event (never on a still-queued inject_failed) so a resubscribe re-covers it.
 * A durable retry journal is deferred to a later phase.
 */

import type { InboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";

export interface RetryQueueDeps {
  /** Deliver the inbound onto the gateway socket. Returns true iff accepted. */
  inject: (inbound: InboundMessage) => boolean;
  /** Called with the event id after a retry inject succeeds — records dedup. */
  onInjected: (id: string) => void;
  /** Max entries held before the oldest is dropped (logged). Default 1_000. */
  capacity?: number;
  /** Drain cadence in ms while the queue is non-empty. Default 2_000. */
  intervalMs?: number;
  /** Injected timer for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
  log?: (msg: string) => void;
}

export interface RetryQueue {
  /** True iff `id` is currently pending redelivery. */
  has(id: string): boolean;
  /** Enqueue a mapped inbound whose first inject failed. Idempotent per id. */
  enqueue(id: string, inbound: InboundMessage): void;
  /** Re-attempt inject for every pending entry, oldest first, until one fails
   *  (the socket is still down) or the queue is empty. Returns injects done. */
  drain(): number;
  /** Number of entries currently pending. */
  size(): number;
  /** Stop the periodic drain timer. */
  stop(): void;
}

export function createRetryQueue(deps: RetryQueueDeps): RetryQueue {
  const capacity = deps.capacity ?? 1_000;
  const intervalMs = deps.intervalMs ?? 2_000;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const log = deps.log ?? (() => {});

  // Insertion-ordered map → FIFO redelivery, and an O(1) membership check the
  // pump uses to treat a relay redelivery of a queued id as already-accounted.
  const pending = new Map<string, InboundMessage>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleTick(): void {
    if (stopped || timer !== null || pending.size === 0) return;
    timer = setTimer(() => {
      timer = null;
      drain();
    }, intervalMs);
  }

  function drain(): number {
    let injected = 0;
    for (const [id, inbound] of pending) {
      if (!deps.inject(inbound)) break; // socket still down — keep order, retry later
      pending.delete(id);
      deps.onInjected(id); // record in the durable dedup journal
      injected++;
    }
    if (injected > 0) log(`buzz retry: redelivered ${injected} event(s); ${pending.size} still pending`);
    scheduleTick(); // re-arm while anything remains
    return injected;
  }

  return {
    has(id: string): boolean {
      return pending.has(id);
    },
    enqueue(id: string, inbound: InboundMessage): void {
      if (pending.has(id)) return;
      if (pending.size >= capacity) {
        // Bounded memory beats OOM. Dropping the oldest is a documented residual;
        // with the operator-only allowlist and brief gateway restarts this is
        // not expected to trigger in practice.
        const oldest = pending.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          pending.delete(oldest);
          log(`buzz retry: queue full (${capacity}); dropped oldest id=${oldest.slice(0, 12)}`);
        }
      }
      pending.set(id, inbound);
      scheduleTick();
    },
    drain,
    size(): number {
      return pending.size;
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}
