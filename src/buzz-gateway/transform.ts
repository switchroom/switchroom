/**
 * Buzz sidecar — Phase 2b outbound event shaping (pure, unsigned).
 *
 * Turns a hub `outbound_to_buzz` request into one or more UNSIGNED Nostr event
 * templates. NO signing, NO clock beyond an injected `nowSec`, NO secret key —
 * so shaping is unit-testable without a relay and stays cleanly separated from
 * the sole content-signer (`publisher.ts`, S3).
 *
 * Wire decisions, grounded in Phase-0 findings:
 *   - NIP-29 scoping: every event carries `["h", <channelId>]` (F1). The relay
 *     rejects a kind:9 without it.
 *   - Content kind: kind:9 channel message. F4 — the Buzz desktop renders ONLY
 *     a fixed content-kind allowlist, so BOTH a normal answer AND a correction
 *     ship as kind:9 (a custom "correction" kind would silently not render).
 *   - Threading: NIP-10 marked e-tags (`root` / `reply`). A correction threads
 *     as a `reply` to the event it supersedes, so a reader sees it inline under
 *     the original — the correction semantics are carried by the thread link,
 *     not a non-rendering kind.
 *   - Chunk part markers: a multi-part answer prefixes `(k/n) ` so a reader is
 *     not confused by a truncated-looking message; the INTER-CHUNK threading
 *     (each chunk replying to the prior chunk's locally-computed id) is stitched
 *     in `publisher.ts`, which owns the pubkey needed for `getEventHash` (S5).
 */

/** NIP-29 channel message kind. */
export const NIP29_CHANNEL_MESSAGE_KIND = 9;

export interface UnsignedEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface Nip10Threading {
  /** The event being replied to (its id becomes the `reply` marker). */
  replyToEventId?: string;
  /** The thread root (its id becomes the `root` marker). */
  threadRootId?: string;
}

/**
 * Build NIP-10 marked e-tags from a threading spec. Emits a `root` marker for
 * the thread root and a `reply` marker for the direct parent. When only one of
 * the two is present it is emitted with the most specific applicable marker.
 * Returns `[]` for a top-level post (no threading).
 */
export function buildThreadTags(t: Nip10Threading): string[][] {
  const tags: string[][] = [];
  const root = t.threadRootId;
  const parent = t.replyToEventId;
  if (root && root === parent) {
    // Root IS the direct parent — a single reply-to-root marker.
    tags.push(["e", root, "", "root"]);
    return tags;
  }
  if (root) tags.push(["e", root, "", "root"]);
  if (parent) tags.push(["e", parent, "", "reply"]);
  return tags;
}

/** Prefix a chunk with a `(k/n) ` part marker when an answer was split. */
export function partMarker(text: string, part: number, total: number): string {
  return total > 1 ? `(${part}/${total}) ${text}` : text;
}

export interface MessageTemplateOpts {
  channelId: string;
  content: string;
  threading?: Nip10Threading;
  nowSec: number;
}

/** Build ONE unsigned kind:9 channel-message template (h-tag + NIP-10 tags). */
export function buildMessageTemplate(opts: MessageTemplateOpts): UnsignedEventTemplate {
  const tags: string[][] = [["h", opts.channelId]];
  if (opts.threading) tags.push(...buildThreadTags(opts.threading));
  return {
    kind: NIP29_CHANNEL_MESSAGE_KIND,
    created_at: opts.nowSec,
    tags,
    content: opts.content,
  };
}

export interface CorrectionTemplateOpts {
  channelId: string;
  content: string;
  /** The previously-published event this correction supersedes. */
  targetEventId: string;
  nowSec: number;
}

/**
 * Build an unsigned correction template — a kind:9 message threaded as a NIP-10
 * `reply` to the superseded event (so it renders inline under the original, F4).
 */
export function buildCorrectionTemplate(opts: CorrectionTemplateOpts): UnsignedEventTemplate {
  return buildMessageTemplate({
    channelId: opts.channelId,
    content: opts.content,
    threading: { threadRootId: opts.targetEventId, replyToEventId: opts.targetEventId },
    nowSec: opts.nowSec,
  });
}
