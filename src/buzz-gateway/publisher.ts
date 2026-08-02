/**
 * Buzz sidecar — Phase 2b PUBLISHER. The SOLE content-signer (S3).
 *
 * Every path that could put agent-authored, attacker-influenced text onto a
 * signed public Nostr event flows through here, and this module is the ONLY
 * place `finalizeEvent` is called on OUTBOUND content (the NIP-42 auth event in
 * `nostr-protocol.ts` signs an empty-content handshake, not message content).
 *
 * Layered scrub — stated honestly (S3):
 *   - Layer 1 (hub) — `normalizeOutboundBody(…, redactOutboundText, …)` already
 *     redacted the text before it left the gateway.
 *   - Layer 2 (here) — before ANY `finalizeEvent` call, the FULL content is
 *     re-scanned with `detectSecrets`; a single non-suppressed detection refuses
 *     the sign entirely. This is a BACKSTOP for a layer-1 PLUMBING failure (a
 *     mis-wired redactor that let a secret through), NOT an independent second
 *     detector: both layers share the one `detectSecrets` engine, so this
 *     catches "layer 1 was bypassed", not "layer 1's detector missed a pattern".
 *
 * The attachment note (S6) is appended into the message `text` upstream, so it
 * is part of the `content` string this layer scans — there is no separate
 * unscanned free-text field.
 *
 * Determinism: signing takes an injected `nowSec` and secret key; the relay
 * transport is injected. No global clock, no ambient socket — unit-testable.
 */

import { finalizeEvent, getPublicKey } from "nostr-tools";
import { detectSecrets } from "../../telegram-plugin/secret-detect/index.js";
import {
  buildMessageTemplate,
  partMarker,
  type Nip10Threading,
  type UnsignedEventTemplate,
} from "./transform.js";
import {
  splitByBytes,
  isFrameWithinBudget,
  BUZZ_CHUNK_BYTES,
  BUZZ_PUBLISH_TIMEOUT_MS,
} from "./limits.js";

export interface SignedNostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Layer-2 gate (S3). True IFF `content` carries at least one NON-suppressed
 * secret detection — the exact condition under which signing is refused. A
 * suppressed detection (an inert value / vault key NAME the engine deliberately
 * keeps) does not block: those are not credentials.
 */
export function contentHasUnsuppressedSecret(content: string): boolean {
  return detectSecrets(content).some((d) => !d.suppressed);
}

export type SignResult =
  | { ok: true; events: SignedNostrEvent[]; eventId: string }
  | { ok: false; reason: string };

/**
 * Scrub → split → sign a message into one or more signed kind:9 events.
 *
 * Order is load-bearing (S3/S5):
 *   1. Layer-2 secret scan on the FULL content FIRST — refuse before any sign.
 *   2. Chunk-split by BYTE budget (S5: split BEFORE per-frame validation).
 *   3. Sign each chunk; thread chunk N>0 on the LOCALLY-computed id of chunk
 *      N-1 (`finalizeEvent`'s `id`, which is `getEventHash` — never a relay id).
 *   4. Validate each signed frame against the wire budget (S5: per-frame, post
 *      split). An over-budget frame fails the whole publish (fail closed).
 *
 * `eventId` is the FIRST chunk's local id — the canonical id reported back to
 * the hub and the target a later correction supersedes.
 */
export function signChunkedMessage(opts: {
  content: string;
  channelId: string;
  threading?: Nip10Threading;
  secretKey: Uint8Array;
  nowSec?: number;
  chunkBytes?: number;
}): SignResult {
  // 1. Layer-2 scrub gate — NOTHING reaches finalizeEvent past this point
  //    without passing detectSecrets.
  if (contentHasUnsuppressedSecret(opts.content)) {
    return {
      ok: false,
      reason: "refused to sign: content failed the layer-2 secret scan (detectSecrets)",
    };
  }

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const pubkey = getPublicKey(opts.secretKey);
  const chunks = splitByBytes(opts.content, opts.chunkBytes ?? BUZZ_CHUNK_BYTES);

  const events: SignedNostrEvent[] = [];
  let firstId: string | undefined;
  let prevId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const threading: Nip10Threading | undefined =
      i === 0
        ? opts.threading
        : {
            // Root stays the original thread root (or the first chunk when this
            // is a fresh top-level answer); each subsequent chunk replies to the
            // PREVIOUS chunk's locally-computed id.
            threadRootId: opts.threading?.threadRootId ?? firstId,
            replyToEventId: prevId,
          };

    const template: UnsignedEventTemplate = buildMessageTemplate({
      channelId: opts.channelId,
      content: partMarker(chunks[i], i + 1, chunks.length),
      threading,
      nowSec,
    });
    // finalizeEvent stamps pubkey + computes id (= getEventHash) + signs. The id
    // is LOCAL — computed here, never taken from a relay OK (S5).
    const signed = finalizeEvent(template, opts.secretKey) as unknown as SignedNostrEvent;
    if (signed.pubkey !== pubkey) {
      return { ok: false, reason: "internal: signer pubkey mismatch" };
    }
    if (!isFrameWithinBudget(["EVENT", signed])) {
      return {
        ok: false,
        reason: `refused to publish: signed frame for chunk ${i + 1}/${chunks.length} exceeds the wire budget`,
      };
    }
    if (i === 0) firstId = signed.id;
    prevId = signed.id;
    events.push(signed);
  }

  if (firstId === undefined) return { ok: false, reason: "internal: produced no events" };
  return { ok: true, events, eventId: firstId };
}

/**
 * A relay publish transport: put one signed EVENT on the wire and resolve with
 * the relay's OK verdict. Injected so the publisher is testable without a
 * socket and so the retry/backoff policy stays in the transport, not here.
 */
export type PublishTransport = (
  event: SignedNostrEvent,
  timeoutMs: number,
) => Promise<{ ok: boolean; message?: string }>;

export interface OutboundPayload {
  channelId: string;
  replyToEventId?: string;
  threadRootId?: string;
  payload:
    | { kind: "message"; text: string }
    | { kind: "correction"; text: string; targetEventId: string };
}

export interface PublishResult {
  ok: boolean;
  eventId?: string;
  error?: string;
}

/**
 * Sign + publish a hub `outbound_to_buzz` request. Returns the result the
 * sidecar forwards back to the hub as `buzz_publish_result`. Under `both` mode
 * this is advisory (the Telegram copy already delivered), so a relay failure is
 * reported honestly, never retried into a duplicate here.
 */
export async function publishOutbound(
  req: OutboundPayload,
  secretKey: Uint8Array,
  transport: PublishTransport,
  nowSec?: number,
): Promise<PublishResult> {
  const threading: Nip10Threading =
    req.payload.kind === "correction"
      ? { threadRootId: req.payload.targetEventId, replyToEventId: req.payload.targetEventId }
      : { threadRootId: req.threadRootId, replyToEventId: req.replyToEventId };

  const signed = signChunkedMessage({
    content: req.payload.text,
    channelId: req.channelId,
    threading,
    secretKey,
    nowSec,
  });
  if (!signed.ok) return { ok: false, error: signed.reason };

  // Publish each chunk in order. First non-OK aborts the remainder (the answer
  // is already on Telegram; a partial Buzz thread is reported as a failure).
  for (const ev of signed.events) {
    const verdict = await transport(ev, BUZZ_PUBLISH_TIMEOUT_MS);
    if (!verdict.ok) {
      return { ok: false, eventId: signed.eventId, error: verdict.message ?? "relay rejected event" };
    }
  }
  return { ok: true, eventId: signed.eventId };
}
