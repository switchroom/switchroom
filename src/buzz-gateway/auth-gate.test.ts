import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { admitEvent, buildAuthorizedSet, normalizePubkey, type NostrEventLike } from "./auth-gate.js";

function signed(sk: Uint8Array, over: Partial<NostrEventLike> = {}): NostrEventLike {
  return finalizeEvent(
    {
      kind: over.kind ?? 9,
      created_at: over.created_at ?? Math.floor(Date.now() / 1000),
      tags: over.tags ?? [["h", "group-uuid"]],
      content: over.content ?? "hello from buzz",
    },
    sk,
  ) as NostrEventLike;
}

describe("normalizePubkey", () => {
  it("passes through 64-char hex, lowercased", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    expect(normalizePubkey(pk.toUpperCase())).toBe(pk.toLowerCase());
  });

  it("decodes an npub to hex", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const npub = nip19.npubEncode(pk);
    expect(normalizePubkey(npub)).toBe(pk.toLowerCase());
  });

  it("returns null for garbage / wrong length", () => {
    expect(normalizePubkey("not-a-key")).toBeNull();
    expect(normalizePubkey("deadbeef")).toBeNull();
    expect(normalizePubkey("npub1garbage")).toBeNull();
  });
});

describe("buildAuthorizedSet", () => {
  it("always includes the operator pubkey and drops garbage entries", () => {
    const op = getPublicKey(generateSecretKey());
    const good = getPublicKey(generateSecretKey());
    const set = buildAuthorizedSet(op, [good, "garbage", ""]);
    expect(set.has(op.toLowerCase())).toBe(true);
    expect(set.has(good.toLowerCase())).toBe(true);
    expect(set.size).toBe(2);
  });

  it("is empty (admits nobody) when the operator key itself is un-parseable", () => {
    const set = buildAuthorizedSet("totally-invalid", []);
    expect(set.size).toBe(0);
  });
});

describe("admitEvent", () => {
  it("admits a valid, allowlisted, correctly-signed event", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ev = signed(sk);
    const res = admitEvent(ev, {
      authorized: new Set([pk.toLowerCase()]),
      agentPubkey: getPublicKey(generateSecretKey()),
      verify: verifyEvent,
    });
    expect(res).toEqual({ ok: true });
  });

  it("rejects a valid signature from a NON-allowlisted pubkey (fail-closed)", () => {
    const strangerSk = generateSecretKey();
    const ev = signed(strangerSk); // real signature, but pubkey not allowlisted
    const res = admitEvent(ev, {
      authorized: new Set([getPublicKey(generateSecretKey())]),
      agentPubkey: null,
      verify: verifyEvent,
    });
    expect(res).toEqual({ ok: false, reason: "not_allowlisted" });
  });

  it("rejects a tampered (bad-signature) event even if its claimed pubkey is allowlisted", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ev = signed(sk);
    // JSON round-trip mirrors the real wire path (parseRelayFrame → JSON.parse):
    // it drops nostr-tools' cached verified-symbol so the REAL verifier runs.
    const tampered = JSON.parse(
      JSON.stringify({ ...ev, content: ev.content + " EVIL" }),
    ) as NostrEventLike; // id/sig no longer match the content
    const res = admitEvent(tampered, {
      authorized: new Set([pk.toLowerCase()]),
      agentPubkey: null,
      verify: verifyEvent, // the REAL verifier catches the tamper
    });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects the agent's own echo", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ev = signed(sk);
    const res = admitEvent(ev, {
      authorized: new Set([pk.toLowerCase()]),
      agentPubkey: pk,
      verify: verifyEvent,
    });
    expect(res).toEqual({ ok: false, reason: "self_echo" });
  });

  it("rejects a structurally malformed object without calling verify", () => {
    let called = false;
    const res = admitEvent(
      { id: "short", pubkey: "x" },
      { authorized: new Set(), agentPubkey: null, verify: () => { called = true; return true; } },
    );
    expect(res).toEqual({ ok: false, reason: "malformed" });
    expect(called).toBe(false);
  });

  it("would ADMIT a stranger if the allowlist check were removed (guards the gate itself)", () => {
    // Meta-test: prove the not_allowlisted verdict is what stops a stranger —
    // if the allowlist contained the stranger, the same event is admitted.
    const strangerSk = generateSecretKey();
    const strangerPk = getPublicKey(strangerSk);
    const ev = signed(strangerSk);
    const admitted = admitEvent(ev, {
      authorized: new Set([strangerPk.toLowerCase()]),
      agentPubkey: null,
      verify: verifyEvent,
    });
    expect(admitted).toEqual({ ok: true });
  });
});
