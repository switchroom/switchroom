/**
 * Map an admitted Buzz (Nostr) event to a gateway `InboundMessage`.
 *
 * The produced `text` is a self-describing `<channel source="buzz" …>`
 * envelope (mirrors the reaction-dispatch builder), so the agent reads a Buzz
 * message the same way it reads a reaction or a button tap. `meta.source =
 * "buzz"` is load-bearing — the gateway's inject path and the bridge's
 * envelope rendering key on it.
 *
 * Phase 1 handles only channel messages (NIP-29 kind:9, Phase 0 F5). Anything
 * else (reactions kind:7, metadata, own echoes already dropped by the gate)
 * maps to `null` and is not injected.
 *
 * Pure: no IO, no clock. `created_at` (seconds) becomes `ts` (ms).
 */

import type { InboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";
import type { NostrEventLike } from "./auth-gate.js";

/** NIP-29 channel message kind (Phase 0 finding F5). */
export const BUZZ_MESSAGE_KIND = 9;

export interface MapContext {
  /** Telegram chat id the injected turn routes to. */
  chatId: string;
  /** The subscribed group UUID (NIP-29 `h` tag) — used as the channel id. */
  groupId: string;
  /** Petnames: hex pubkey → display name. */
  pubkeyNames: Record<string, string>;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeBody(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Short, human-readable sender label: petname if known, else npub-short. */
function senderLabel(pubkey: string, names: Record<string, string>): string {
  const petname = names[pubkey.toLowerCase()];
  if (petname) return petname;
  // npub-short fallback: first 8 + last 4 hex of the pubkey.
  return `buzz:${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/**
 * NIP-10 thread root resolution. Prefer an `["e", <id>, <relay?>, "root"]`
 * marked tag; else the first `e` tag (legacy positional root); else the
 * event's own id (a top-level message roots its own thread).
 */
function resolveThreadRoot(ev: NostrEventLike): string {
  const eTags = ev.tags.filter((t) => t[0] === "e" && typeof t[1] === "string");
  const marked = eTags.find((t) => t[3] === "root");
  if (marked) return marked[1];
  if (eTags.length > 0) return eTags[0][1];
  return ev.id;
}

/**
 * NIP-10 reply-parent resolution — the DIRECT antecedent of this event, as
 * distinct from the thread root. Marker semantics take precedence:
 *
 *   - An explicit `["e", <id>, <relay?>, "reply"]` marked tag is the reply
 *     parent.
 *   - When e-tags carry NIP-10 markers but no `reply` marker (a root-only
 *     reply, per NIP-10), the reply parent IS the `root` marker — a direct
 *     reply to the thread's opening post. Falls back to the `root` marker id.
 *   - When NO markers are present, legacy positional convention applies: the
 *     LAST positional `e` tag is the reply parent (the FIRST is the root); a
 *     lone positional e-tag is both root and reply.
 *   - No `e` tags ⇒ this event replies to nothing; returns `undefined` and the
 *     `buzz_reply_to` attribute is omitted entirely.
 *
 * A marker set carrying only `mention` (no `root`/`reply`) also yields
 * `undefined`: a mention is not a thread antecedent.
 */
function resolveReplyParent(ev: NostrEventLike): string | undefined {
  const eTags = ev.tags.filter((t) => t[0] === "e" && typeof t[1] === "string");
  if (eTags.length === 0) return undefined;

  const hasMarkers = eTags.some(
    (t) => t[3] === "root" || t[3] === "reply" || t[3] === "mention",
  );
  if (hasMarkers) {
    const reply = eTags.find((t) => t[3] === "reply");
    if (reply) return reply[1];
    const root = eTags.find((t) => t[3] === "root");
    if (root) return root[1];
    // Marked, but neither root nor reply (mention-only) — no antecedent.
    return undefined;
  }

  // Legacy positional (no markers): last e-tag is the reply parent.
  return eTags[eTags.length - 1][1];
}

/**
 * Resolve the group id an event belongs to: its own `h` tag (NIP-29 scoping)
 * if present, else the subscribed groupId from context.
 */
function resolveChannelId(ev: NostrEventLike, fallback: string): string {
  const h = ev.tags.find((t) => t[0] === "h" && typeof t[1] === "string");
  return h ? h[1] : fallback;
}

/**
 * Build the InboundMessage for an admitted event, or null if this event kind
 * is not injectable in Phase 1.
 */
export function mapBuzzEvent(
  ev: NostrEventLike,
  ctx: MapContext,
): InboundMessage | null {
  if (ev.kind !== BUZZ_MESSAGE_KIND) return null;

  const channelId = resolveChannelId(ev, ctx.groupId);
  const threadRoot = resolveThreadRoot(ev);
  const replyTo = resolveReplyParent(ev);
  const user = senderLabel(ev.pubkey, ctx.pubkeyNames);

  const text =
    `<channel source="buzz" ` +
    `buzz_channel_id="${escapeAttr(channelId)}" ` +
    `buzz_event_id="${escapeAttr(ev.id)}" ` +
    `buzz_pubkey="${escapeAttr(ev.pubkey)}" ` +
    `buzz_thread_root="${escapeAttr(threadRoot)}" ` +
    (replyTo !== undefined
      ? `buzz_reply_to="${escapeAttr(replyTo)}" `
      : "") +
    `user="${escapeAttr(user)}">` +
    escapeBody(ev.content) +
    `</channel>`;

  const meta: Record<string, string> = {
    source: "buzz",
    buzz_channel_id: channelId,
    buzz_event_id: ev.id,
    buzz_pubkey: ev.pubkey,
    buzz_thread_root: threadRoot,
    ...(replyTo !== undefined ? { buzz_reply_to: replyTo } : {}),
    user,
  };

  return {
    type: "inbound",
    chatId: ctx.chatId,
    messageId: 0,
    user,
    userId: 0,
    ts: ev.created_at * 1000,
    text,
    meta,
  };
}
