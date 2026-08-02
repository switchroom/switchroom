import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import {
  buildAuthEvent,
  NIP42_AUTH_KIND,
  parseRelayFrame,
} from "./nostr-protocol.js";
import { createNostrClient, type SocketFactory, type WsHandlers, type WsLike } from "./nostr-client.js";
import type { NostrEventLike } from "./auth-gate.js";

describe("nostr-protocol", () => {
  it("buildAuthEvent produces a verifyEvent-valid kind:22242 with relay + challenge tags", () => {
    const sk = generateSecretKey();
    const ev = buildAuthEvent("chal-123", "ws://relay.example", sk, 1_700_000_000);
    expect(ev.kind).toBe(NIP42_AUTH_KIND);
    expect(ev.tags).toContainEqual(["relay", "ws://relay.example"]);
    expect(ev.tags).toContainEqual(["challenge", "chal-123"]);
    expect(verifyEvent(ev as unknown as Parameters<typeof verifyEvent>[0])).toBe(true);
  });

  it("parseRelayFrame classifies each frame type and never throws on garbage", () => {
    expect(parseRelayFrame('["AUTH","c1"]')).toEqual({ type: "AUTH", challenge: "c1" });
    expect(parseRelayFrame('["EOSE","s1"]')).toEqual({ type: "EOSE", subId: "s1" });
    expect(parseRelayFrame('["OK","id1",true,"ok"]')).toEqual({ type: "OK", eventId: "id1", accepted: true, message: "ok" });
    expect(parseRelayFrame('["CLOSED","s1","auth-required"]')).toEqual({ type: "CLOSED", subId: "s1", message: "auth-required" });
    expect(parseRelayFrame("not json")).toEqual({ type: "UNKNOWN", raw: "not json" });
    const evFrame = parseRelayFrame('["EVENT","s1",{"id":"x"}]');
    expect(evFrame.type).toBe("EVENT");
  });
});

/** A drivable fake socket: captures sent frames, lets the test push messages. */
function fakeSocket() {
  const sent: string[] = [];
  let handlers: WsHandlers | null = null;
  const factory: SocketFactory = (_url, _o, h) => {
    handlers = h;
    const ws: WsLike = { send: (d) => { sent.push(d); }, close: () => {} };
    return ws;
  };
  return {
    factory,
    sent,
    open: () => handlers!.onOpen(),
    message: (raw: string) => handlers!.onMessage(raw),
  };
}

describe("createNostrClient NIP-42 handshake", () => {
  it("on AUTH challenge signs a valid auth event, then subscribes on OK", () => {
    const sk = generateSecretKey();
    const fs = fakeSocket();
    const received: NostrEventLike[] = [];
    const client = createNostrClient({
      relayUrl: "ws://relay",
      relayTagUrl: "ws://relay",
      relayHost: "127.0.0.1:3000",
      groupId: "group-uuid",
      secretKey: sk,
      onEvent: (ev) => { received.push(ev); },
      socketFactory: fs.factory,
      nowSec: () => 1_700_000_000,
      random: () => 0.5,
    });
    client.start();
    fs.open();

    // On open, the client sends the initial REQ (prompts the closed relay's AUTH).
    const firstReq = JSON.parse(fs.sent[0]);
    expect(firstReq[0]).toBe("REQ");

    // Relay demands auth.
    fs.message(JSON.stringify(["AUTH", "challenge-xyz"]));
    const authFrame = JSON.parse(fs.sent[1]);
    expect(authFrame[0]).toBe("AUTH");
    const authEvent = authFrame[1] as NostrEventLike;
    expect(authEvent.kind).toBe(NIP42_AUTH_KIND);
    expect(verifyEvent(authEvent as unknown as Parameters<typeof verifyEvent>[0])).toBe(true);
    expect(authEvent.tags).toContainEqual(["challenge", "challenge-xyz"]);

    // Relay accepts the auth event → client re-subscribes.
    fs.message(JSON.stringify(["OK", authEvent.id, true, ""]));
    const resub = JSON.parse(fs.sent[2]);
    expect(resub[0]).toBe("REQ");
    // The subscribe filter scopes to the group via #h.
    const filter = resub[2];
    expect(filter["#h"]).toEqual(["group-uuid"]);
    expect(filter.kinds).toEqual([9]);

    client.stop();
  });

  it("delivers subscription EVENTs to onEvent and advances the watermark", () => {
    const sk = generateSecretKey();
    const senderSk = generateSecretKey();
    const fs = fakeSocket();
    const received: NostrEventLike[] = [];
    const client = createNostrClient({
      relayUrl: "ws://relay",
      relayTagUrl: "ws://relay",
      relayHost: "",
      groupId: "group-uuid",
      secretKey: sk,
      onEvent: (ev) => { received.push(ev); },
      socketFactory: fs.factory,
    });
    client.start();
    fs.open();

    const ev = finalizeEvent(
      { kind: 9, created_at: 1_800_000_000, tags: [["h", "group-uuid"]], content: "hi" },
      senderSk,
    ) as NostrEventLike;
    fs.message(JSON.stringify(["EVENT", "buzz-in", ev]));
    expect(received.length).toBe(1);
    expect(received[0].id).toBe(ev.id);

    // An EVENT on a different sub id is ignored.
    fs.message(JSON.stringify(["EVENT", "other-sub", ev]));
    expect(received.length).toBe(1);

    client.stop();
  });

  it("does NOT advance the resubscribe watermark when onEvent returns false (MAJOR-1 backstop)", () => {
    const sk = generateSecretKey();
    const senderSk = generateSecretKey();

    // Helper: run one client, deliver one EVENT with the given onEvent return,
    // force a resubscribe, and read the `since` the client would re-request.
    function sinceAfterEvent(durable: boolean | void): number {
      const fs = fakeSocket();
      const client = createNostrClient({
        relayUrl: "ws://relay",
        relayTagUrl: "ws://relay",
        relayHost: "",
        groupId: "group-uuid",
        secretKey: sk,
        onEvent: () => durable,
        socketFactory: fs.factory,
        nowSec: () => 1_700_000_000,
      });
      client.start();
      fs.open();
      const ev = finalizeEvent(
        { kind: 9, created_at: 1_800_000_000, tags: [["h", "group-uuid"]], content: "hi" },
        senderSk,
      ) as NostrEventLike;
      fs.message(JSON.stringify(["EVENT", "buzz-in", ev]));
      // Force a resubscribe via the AUTH→OK path and read the new REQ's since.
      fs.message(JSON.stringify(["AUTH", "chal"]));
      const authFrame = JSON.parse(fs.sent[fs.sent.length - 1]);
      const authId = (authFrame[1] as NostrEventLike).id;
      fs.message(JSON.stringify(["OK", authId, true, ""]));
      const resub = JSON.parse(fs.sent[fs.sent.length - 1]);
      expect(resub[0]).toBe("REQ");
      client.stop();
      return resub[2].since as number;
    }

    // Durable (void/true): watermark jumps to the event's created_at, so the
    // resubscribe `since` is anchored near it (created_at - lookback).
    expect(sinceAfterEvent(undefined)).toBe(1_800_000_000 - 300);
    // Not durable (false, e.g. a queued inject_failed): watermark is held at its
    // initial (now - lookback), so `since` stays low and re-covers the event.
    expect(sinceAfterEvent(false)).toBe(1_700_000_000 - 300 - 300);
  });

  it("passes the Host header authority to the socket factory", () => {
    const sk = generateSecretKey();
    let seenHost = "";
    const factory: SocketFactory = (_url, o) => {
      seenHost = o.host;
      return { send: () => {}, close: () => {} };
    };
    const client = createNostrClient({
      relayUrl: "ws://10.0.10.5:8080",
      relayTagUrl: "ws://127.0.0.1:3000",
      relayHost: "127.0.0.1:3000",
      groupId: "g",
      secretKey: sk,
      onEvent: () => {},
      socketFactory: factory,
    });
    client.start();
    expect(seenHost).toBe("127.0.0.1:3000");
    client.stop();
  });

  it("tags the NIP-42 AUTH with the CANONICAL relay URL, not the dial address (live-probe fix)", () => {
    // Dial a docker-network address, but the relay's canonical identity — the
    // string it exact-matches the `relay` tag against — is 127.0.0.1:3000.
    const sk = generateSecretKey();
    const fs = fakeSocket();
    const client = createNostrClient({
      relayUrl: "ws://10.0.10.5:3000", // dialed (docker IP)
      relayTagUrl: "ws://127.0.0.1:3000", // canonical (auth tag)
      relayHost: "127.0.0.1:3000",
      groupId: "group-uuid",
      secretKey: sk,
      onEvent: () => {},
      socketFactory: fs.factory,
      nowSec: () => 1_700_000_000,
    });
    client.start();
    fs.open();
    fs.message(JSON.stringify(["AUTH", "chal-abc"]));

    const authFrame = JSON.parse(fs.sent[fs.sent.length - 1]);
    expect(authFrame[0]).toBe("AUTH");
    const authEvent = authFrame[1] as NostrEventLike;
    // The tag carries the CANONICAL url, independent of the dialed docker IP.
    expect(authEvent.tags).toContainEqual(["relay", "ws://127.0.0.1:3000"]);
    expect(authEvent.tags).not.toContainEqual(["relay", "ws://10.0.10.5:3000"]);
    expect(verifyEvent(authEvent as unknown as Parameters<typeof verifyEvent>[0])).toBe(true);
    client.stop();
  });
});
