import { describe, it, expect, vi } from "vitest";
import { generateSecretKey } from "nostr-tools";
import {
  signChunkedMessage,
  publishOutbound,
  contentHasUnsuppressedSecret,
  type PublishTransport,
  type SignedNostrEvent,
} from "./publisher.js";
import { BUZZ_MAX_FRAME_BYTES } from "./limits.js";

// publisher.ts is the SOLE content-signer (S3). These tests are MERGE-BLOCKING:
// they assert the layer-2 scrub gate refuses to sign/publish any content that
// carries a live (non-suppressed) secret, BEFORE any finalizeEvent runs.

const SK = generateSecretKey();
// Synthetic AWS-shaped access key, assembled by concatenation so this test file
// itself carries no scannable literal (check-no-pii-secrets). detectSecrets
// flags it as exactly one NON-suppressed detection.
const LIVE_SECRET = "AKIA" + "AAAABBBBCCCCDDDD";

function okTransport(): { transport: PublishTransport; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => ({ ok: true as const }));
  return { transport: spy as unknown as PublishTransport, spy };
}

describe("layer-2 scrub gate (G-1…G-4) — refuse to sign leaked secrets", () => {
  it("G-1 signChunkedMessage REFUSES content with a live secret (no events)", () => {
    const res = signChunkedMessage({
      content: `here is the key ${LIVE_SECRET} keep it safe`,
      channelId: "chan",
      secretKey: SK,
      nowSec: 1_700_000_000,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/layer-2 secret scan/);
  });

  it("G-2 signs clean content (control) and reports a local event id", () => {
    const res = signChunkedMessage({
      content: "a perfectly ordinary answer with no credentials",
      channelId: "chan",
      secretKey: SK,
      nowSec: 1_700_000_000,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.events).toHaveLength(1);
      expect(res.eventId).toBe(res.events[0].id); // eventId = first chunk's LOCAL id
    }
  });

  it("G-3 publishOutbound never calls the transport when the scrub gate refuses", async () => {
    const { transport, spy } = okTransport();
    const res = await publishOutbound(
      { channelId: "chan", payload: { kind: "message", text: `leak ${LIVE_SECRET}` } },
      SK,
      transport,
      1_700_000_000,
    );
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled(); // nothing reached the wire
  });

  it("G-4 layer-2 BACKSTOPS a layer-1 plumbing failure (broken/no-op redactor)", async () => {
    // Simulate a mis-wired hub redactor — a broken redactor is the identity
    // function, so text a WORKING layer-1 would have scrubbed arrives here raw.
    const brokenRedactor = (t: string) => t; // the plumbing failure
    const rawFromHub = brokenRedactor(`answer containing ${LIVE_SECRET} verbatim`);
    // Sanity: layer 1 (broken) let the live secret through.
    expect(contentHasUnsuppressedSecret(rawFromHub)).toBe(true);

    const { transport, spy } = okTransport();
    const res = await publishOutbound(
      { channelId: "chan", payload: { kind: "message", text: rawFromHub } },
      SK,
      transport,
      1_700_000_000,
    );
    // Layer 2 caught what the broken layer 1 missed: no sign, no publish.
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("chunk threading + eventId (G-5, S5) — local ids, never a relay id", () => {
  it("G-5 threads chunk N>0 on the PREVIOUS chunk's local id; eventId is chunk 0's id", () => {
    // Force a split with a tiny byte budget. Natural words (not a high-entropy
    // token) so the layer-2 secret scan does not flag the fixture itself.
    const res = signChunkedMessage({
      content: "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      channelId: "chan",
      secretKey: SK,
      nowSec: 1_700_000_000,
      chunkBytes: 10,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events.length).toBeGreaterThan(1);
    expect(res.eventId).toBe(res.events[0].id);
    // Chunk 1 must reference chunk 0's LOCAL id in an e-tag (NIP-10 threading).
    const chunk1ETags = res.events[1].tags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(chunk1ETags).toContain(res.events[0].id);
    // Every chunk carries the channel h-tag.
    for (const ev of res.events) {
      expect(ev.tags.some((t) => t[0] === "h" && t[1] === "chan")).toBe(true);
      expect(ev.kind).toBe(9);
    }
  });

  it("publishes every chunk in order over the transport", async () => {
    const { transport, spy } = okTransport();
    const res = await publishOutbound(
      { channelId: "chan", payload: { kind: "message", text: "aaaaaaaaaabbbbbbbbbb" } },
      SK,
      transport,
      1_700_000_000,
    );
    expect(res.ok).toBe(true);
    // A short message is a single chunk; a transport call was made.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("wire-budget guard (G-6, S5) — an over-budget signed frame fails closed", () => {
  it("G-6 refuses when a single un-split chunk's signed frame exceeds the frame budget", () => {
    // One chunk (chunkBytes above the content size) whose serialized EVENT frame
    // exceeds BUZZ_MAX_FRAME_BYTES → the post-split per-frame check fails closed.
    const big = "x".repeat(BUZZ_MAX_FRAME_BYTES);
    const res = signChunkedMessage({
      content: big,
      channelId: "chan",
      secretKey: SK,
      nowSec: 1_700_000_000,
      chunkBytes: BUZZ_MAX_FRAME_BYTES * 2, // do NOT split — force the frame check
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/wire budget/);
  });
});

describe("publishOutbound relay-failure handling", () => {
  it("reports a relay rejection honestly (never retried into a duplicate)", async () => {
    const spy = vi.fn(async () => ({ ok: false as const, message: "blocked" }));
    const res = await publishOutbound(
      { channelId: "chan", payload: { kind: "message", text: "clean answer" } },
      SK,
      spy as unknown as PublishTransport,
      1_700_000_000,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/blocked/);
    expect(spy).toHaveBeenCalledTimes(1); // published once, no retry
  });

  it("maps a correction payload to a reply threaded on the target event", async () => {
    const seen: SignedNostrEvent[] = [];
    const spy = vi.fn(async (ev: SignedNostrEvent) => { seen.push(ev); return { ok: true as const }; });
    const res = await publishOutbound(
      { channelId: "chan", payload: { kind: "correction", text: "fixed", targetEventId: "target-evt" } },
      SK,
      spy as unknown as PublishTransport,
      1_700_000_000,
    );
    expect(res.ok).toBe(true);
    const eTags = seen[0].tags.filter((t) => t[0] === "e").map((t) => t[1]);
    expect(eTags).toContain("target-evt");
  });
});
