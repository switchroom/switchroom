import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { createRetryQueue } from "./retry-queue.js";
import { createInboundPump } from "./pump.js";
import { buildAuthorizedSet } from "./auth-gate.js";
import type { NostrEventLike } from "./auth-gate.js";
import type { BuzzRuntimeConfig } from "./config.js";
import type { DedupStore } from "./dedup.js";
import type { InboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";

/** A hand-driven timer: `createRetryQueue` schedules a single pending tick; the
 *  test fires it explicitly so drain timing is deterministic. */
function manualTimer() {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn: () => void, _ms: number) => {
      pending = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => { pending = null; },
    /** Fire the scheduled tick, if any. */
    tick: () => { const f = pending; pending = null; f?.(); },
    hasPending: () => pending !== null,
  };
}

function memDedup(): DedupStore {
  const s = new Set<string>();
  return {
    has: (id) => s.has(id),
    record: (id) => { s.add(id); },
    size: () => s.size,
    close: () => {},
  };
}

function inbound(id: string): InboundMessage {
  return {
    chatId: "555",
    text: "hello",
    user: "op",
    ts: 1,
    messageId: 0,
    meta: { source: "buzz", buzz_event_id: id },
  } as unknown as InboundMessage;
}

function makeConfig(over: Partial<BuzzRuntimeConfig> = {}): BuzzRuntimeConfig {
  return {
    enabled: true,
    agentName: "klanker",
    chatId: "555",
    relayUrl: "ws://relay",
    relayTagUrl: "ws://relay",
    relayHost: "",
    groupId: "group-uuid",
    authorized: over.authorized ?? new Set<string>(),
    nsecVaultKey: "buzz/klanker-nsec",
    pubkeyNames: {},
    mirror: "both",
    ...over,
  };
}

function sign(sk: Uint8Array): NostrEventLike {
  return finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), tags: [["h", "group-uuid"]], content: "hello" },
    sk,
  ) as NostrEventLike;
}

describe("retry queue redelivery (MAJOR-1)", () => {
  it("an inject that fails while the gateway is down is redelivered EXACTLY ONCE when it recovers", () => {
    const timer = manualTimer();
    const dedup = memDedup();
    const frames: InboundMessage[] = [];
    // Gateway starts "down": inject rejects until we flip it up.
    let up = false;
    const inject = (m: InboundMessage): boolean => {
      if (!up) return false;
      frames.push(m);
      return true;
    };
    const retry = createRetryQueue({
      inject,
      onInjected: (id) => dedup.record(id),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    // First inject fails → enqueue. Nothing delivered yet.
    retry.enqueue("ev1", inbound("ev1"));
    expect(frames.length).toBe(0);
    expect(retry.size()).toBe(1);
    expect(retry.has("ev1")).toBe(true);
    expect(dedup.has("ev1")).toBe(false);
    expect(timer.hasPending()).toBe(true); // a drain is scheduled

    // Tick while still down → still queued, re-armed.
    timer.tick();
    expect(frames.length).toBe(0);
    expect(retry.size()).toBe(1);
    expect(timer.hasPending()).toBe(true);

    // Gateway comes back; next drain delivers exactly one turn and records dedup.
    up = true;
    timer.tick();
    expect(frames.length).toBe(1);
    expect(frames[0].meta.buzz_event_id).toBe("ev1");
    expect(retry.size()).toBe(0);
    expect(retry.has("ev1")).toBe(false);
    expect(dedup.has("ev1")).toBe(true); // durably recorded so redelivery dedups

    // Guard against a second fire: another drain does nothing.
    timer.tick();
    expect(frames.length).toBe(1);

    retry.stop();
  });

  it("a failed inject that is NEVER retried is never delivered — proving the tick is load-bearing", () => {
    const timer = manualTimer();
    const dedup = memDedup();
    const frames: InboundMessage[] = [];
    const retry = createRetryQueue({
      inject: (m) => { frames.push(m); return true; }, // would succeed IF drained
      onInjected: (id) => dedup.record(id),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    retry.enqueue("ev1", inbound("ev1"));
    // Without firing the scheduled tick, redelivery never happens.
    expect(frames.length).toBe(0);
    expect(dedup.has("ev1")).toBe(false);
    // Firing it delivers — so the previous assertion genuinely proves redelivery
    // is driven by the drain, not something incidental.
    timer.tick();
    expect(frames.length).toBe(1);
    retry.stop();
  });

  it("end-to-end through the pump: inject fails, event queues, and a relay redelivery does NOT double-fire", () => {
    const timer = manualTimer();
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const dedup = memDedup();
    const frames: InboundMessage[] = [];
    let up = false;
    const inject = (m: InboundMessage): boolean => {
      if (!up) return false;
      frames.push(m);
      return true;
    };
    const retry = createRetryQueue({
      inject,
      onInjected: (id) => dedup.record(id),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    const pump = createInboundPump({
      config: cfg,
      dedup,
      inject,
      retryQueue: retry,
      verify: verifyEvent,
      agentPubkey: null,
    });

    const ev = sign(sk);

    // Gateway down: pump maps but inject fails → queued.
    expect(pump.handleEvent(ev)).toBe("queued");
    expect(frames.length).toBe(0);
    expect(retry.has(ev.id)).toBe(true);

    // Relay redelivers the SAME event while it's queued → treated as duplicate,
    // NOT injected again (no double-fire).
    expect(pump.handleEvent(ev)).toBe("duplicate");
    expect(frames.length).toBe(0);

    // Gateway recovers; drain injects exactly one turn.
    up = true;
    timer.tick();
    expect(frames.length).toBe(1);
    expect(dedup.has(ev.id)).toBe(true);

    // A post-recovery relay redelivery dedups against the journal — still one.
    expect(pump.handleEvent(ev)).toBe("duplicate");
    expect(frames.length).toBe(1);

    retry.stop();
  });

  it("drains FIFO and stops at the first still-failing inject, preserving order", () => {
    const timer = manualTimer();
    const dedup = memDedup();
    const frames: string[] = [];
    let acceptFrom = 0; // number of injects allowed this drain
    const inject = (m: InboundMessage): boolean => {
      if (frames.length >= acceptFrom) return false;
      frames.push(m.meta.buzz_event_id as string);
      return true;
    };
    const retry = createRetryQueue({
      inject,
      onInjected: (id) => dedup.record(id),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });
    retry.enqueue("a", inbound("a"));
    retry.enqueue("b", inbound("b"));
    retry.enqueue("c", inbound("c"));

    // Only one inject succeeds this pass → 'a' delivered, 'b'/'c' held in order.
    acceptFrom = 1;
    timer.tick();
    expect(frames).toEqual(["a"]);
    expect(retry.size()).toBe(2);

    // All remaining succeed.
    acceptFrom = 3;
    timer.tick();
    expect(frames).toEqual(["a", "b", "c"]);
    expect(retry.size()).toBe(0);
    retry.stop();
  });
});
