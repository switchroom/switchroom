import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { createInboundPump } from "./pump.js";
import { buildAuthorizedSet } from "./auth-gate.js";
import type { NostrEventLike } from "./auth-gate.js";
import type { BuzzRuntimeConfig } from "./config.js";
import type { DedupStore } from "./dedup.js";
import type { InboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";

/** Simple in-memory dedup store (exercises the pump's has/record contract
 *  without the fs journal — the journal is covered in dedup.test.ts). */
function memDedup(): DedupStore {
  const s = new Set<string>();
  return {
    has: (id) => s.has(id),
    record: (id) => { s.add(id); },
    size: () => s.size,
    close: () => {},
  };
}

function sign(sk: Uint8Array, over: Partial<NostrEventLike> = {}): NostrEventLike {
  return finalizeEvent(
    {
      kind: over.kind ?? 9,
      created_at: over.created_at ?? Math.floor(Date.now() / 1000),
      tags: over.tags ?? [["h", "group-uuid"]],
      content: over.content ?? "hello",
    },
    sk,
  ) as NostrEventLike;
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

/** Build a pump + a recording inject sink. */
function harness(cfg: BuzzRuntimeConfig, opts: { agentPubkey?: string | null; injectOk?: boolean; dedup?: DedupStore } = {}) {
  const frames: InboundMessage[] = [];
  const pump = createInboundPump({
    config: cfg,
    dedup: opts.dedup ?? memDedup(),
    inject: (inbound) => { if (opts.injectOk === false) return false; frames.push(inbound); return true; },
    verify: verifyEvent,
    agentPubkey: opts.agentPubkey ?? null,
  });
  return { pump, frames };
}

describe("inbound pump outcomes", () => {
  it("a valid allowlisted event injects EXACTLY ONE turn", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const { pump, frames } = harness(cfg);
    expect(pump.handleEvent(sign(sk))).toBe("injected");
    expect(frames.length).toBe(1);
    expect(frames[0].meta.source).toBe("buzz");
    expect(pump.stats.injected).toBe(1);
  });

  it("a non-allowlisted signer is REJECTED and never injected", () => {
    const strangerSk = generateSecretKey();
    const cfg = makeConfig({ authorized: buildAuthorizedSet(getPublicKey(generateSecretKey())) });
    const { pump, frames } = harness(cfg);
    expect(pump.handleEvent(sign(strangerSk))).toBe("rejected:not_allowlisted");
    expect(frames.length).toBe(0);
  });

  it("a bad-signature event is REJECTED and never injected", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const { pump, frames } = harness(cfg);
    const ev = sign(sk);
    // JSON round-trip mirrors the wire (parseRelayFrame → JSON.parse), dropping
    // nostr-tools' cached verified-symbol so the real verifier catches the tamper.
    const tampered = JSON.parse(JSON.stringify({ ...ev, content: ev.content + " EVIL" }));
    expect(pump.handleEvent(tampered)).toBe("rejected:bad_signature");
    expect(frames.length).toBe(0);
  });

  it("a redelivered event id is SUPPRESSED (dedup) — one frame across two deliveries", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const { pump, frames } = harness(cfg);
    const ev = sign(sk);
    expect(pump.handleEvent(ev)).toBe("injected");
    expect(pump.handleEvent(ev)).toBe("duplicate");
    expect(frames.length).toBe(1);
  });

  it("dedup persists across a shared store (simulated sidecar restart) — no re-inject", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const shared = memDedup();
    const ev = sign(sk);

    const h1 = harness(cfg, { dedup: shared });
    expect(h1.pump.handleEvent(ev)).toBe("injected");
    expect(h1.frames.length).toBe(1);

    // "restart": new pump, SAME durable dedup store.
    const h2 = harness(cfg, { dedup: shared });
    expect(h2.pump.handleEvent(ev)).toBe("duplicate");
    expect(h2.frames.length).toBe(0);
  });

  it("a disabled / off channel no-ops (channel_off), never injects", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const off = makeConfig({ authorized: buildAuthorizedSet(pk), mirror: "off" });
    const { pump, frames } = harness(off);
    expect(pump.handleEvent(sign(sk))).toBe("channel_off");
    const disabled = makeConfig({ authorized: buildAuthorizedSet(pk), enabled: false });
    const h2 = harness(disabled);
    expect(h2.pump.handleEvent(sign(sk))).toBe("channel_off");
    expect(frames.length).toBe(0);
    expect(h2.frames.length).toBe(0);
  });

  it("a failed inject is NOT recorded, so a redelivery can still inject", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const shared = memDedup();
    const ev = sign(sk);

    // First delivery: inject fails.
    const failing = harness(cfg, { injectOk: false, dedup: shared });
    expect(failing.pump.handleEvent(ev)).toBe("inject_failed");
    expect(shared.has(ev.id)).toBe(false); // not recorded

    // Redelivery once the socket recovers: injects.
    const ok = harness(cfg, { dedup: shared });
    expect(ok.pump.handleEvent(ev)).toBe("injected");
    expect(ok.frames.length).toBe(1);
  });

  it("the agent's own echo is dropped (self_echo)", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const { pump, frames } = harness(cfg, { agentPubkey: pk });
    expect(pump.handleEvent(sign(sk))).toBe("rejected:self_echo");
    expect(frames.length).toBe(0);
  });
});
