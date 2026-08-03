/**
 * Buzz co-channel — Phase 2b hub-side mirror module.
 *
 * This is the gateway-side half of "the part that actually sends". It sits
 * strictly DOWNSTREAM of a successful Telegram delivery: `sendReply` calls
 * `mirrorReplyDelivered(...)` only AFTER the Telegram copy has landed, and
 * `executeEditMessage` calls `mirrorCorrection(...)` after a Telegram edit
 * lands. Every Buzz publish is fire-and-forget — a failure or absence of the
 * Buzz peer NEVER fails, delays, or retries the Telegram answer (the core
 * invariant). There is no agent-facing Buzz-only send path: the ONLY way a
 * Buzz event is ever emitted is as a mirror of an already-delivered Telegram
 * message.
 *
 * Content signing lives in the sidecar (`src/buzz-gateway/publisher.ts`, the
 * sole content-signer, S3). The hub only decides ROUTE + OWNER SAFETY and hands
 * already-Telegram-scrubbed text (layer-1 redaction, via `normalizeOutboundBody`
 * upstream) to the peer as an `outbound_to_buzz` request; the sidecar re-scrubs
 * through `detectSecrets` (layer-2) before it ever reaches `finalizeEvent`.
 *
 * Dark by default: `getBuzzMirror()` returns null until `initBuzzMirror(...)`
 * is called, which the gateway does ONLY when `channels.buzz.enabled === true`.
 * With Buzz disabled the hook sites are `getBuzzMirror()?.…` — a byte-identical
 * no-op on the hot path.
 */

import { randomUUID } from "crypto";
import type { OutboundToBuzzMessage } from "./ipc-protocol.js";
import {
  resolveRoute,
  isBuzzThreadedPublishSafe,
  parseConfiguredMirrorMode,
  type BuzzCoords,
  type Channel,
} from "./channel-route.js";

export type BuzzPeerSender = (msg: OutboundToBuzzMessage) => boolean;

export interface BuzzMirrorConfig {
  /** Configured mode, ALREADY narrowed to both|off (S2) by the caller. */
  mode: "both" | "off";
  /** This gateway's agent name — stamped on every outbound_to_buzz. */
  agentName: string;
  /**
   * The relay-minted group UUID a TELEGRAM-origin answer is mirrored to as a
   * fresh top-level post (`channels.buzz.default_channel_id`). Empty string ⇒
   * telegram-origin mirroring is disabled (no channel to post into); buzz-origin
   * threaded replies still work (they carry their own channelId).
   */
  defaultChannelId: string;
  /** Optional log sink (defaults to a no-op). */
  log?: (msg: string) => void;
}

export interface MirrorReplyInput {
  /** The answer text AFTER layer-1 Telegram scrub (normalizeOutboundBody). */
  scrubbedText: string;
  /** Resolved reply-owner turn's origin channel. */
  ownerOriginChannel: Channel;
  /** Owner turn's Buzz coordinates, when it originated on Buzz. */
  ownerBuzzCoords?: BuzzCoords;
  /** True IFF the reply positively echoed the owner turn's id (S1). */
  ownerEchoed: boolean;
  /** True IFF a live/recent turn of a DIFFERENT origin exists (S1). */
  hasRecentDifferentOriginTurn: boolean;
  /**
   * `${chatId}:${messageId}` keys of the Telegram messages this answer was
   * delivered as. Recorded so a later `edit_message` on any of them can find
   * the published Buzz event to correct.
   */
  telegramMessageKeys: string[];
}

export interface MirrorCorrectionInput {
  /** `${chatId}:${messageId}` of the edited Telegram message. */
  telegramMessageKey: string;
  /** The edit text AFTER layer-1 Telegram scrub. */
  scrubbedText: string;
}

/** F6 — coalesce a burst of edits into a single correction event. */
export const CORRECTION_DEBOUNCE_MS = 30_000;

/** Bound the in-memory correlation / message maps (FIFO eviction). */
const MAX_TRACKED = 4096;

interface PendingPublish {
  channelId: string;
  telegramMessageKeys: string[];
}

class BuzzMirror {
  private readonly cfg: BuzzMirrorConfig;
  private readonly log: (msg: string) => void;
  private sender: BuzzPeerSender | null = null;

  /** correlationId → in-flight publish awaiting its buzz_publish_result. */
  private readonly pending = new Map<string, PendingPublish>();
  private readonly pendingOrder: string[] = [];

  /** `${chatId}:${messageId}` → the published Buzz event it maps to. */
  private readonly msgToBuzz = new Map<string, { eventId: string; channelId: string }>();
  private readonly msgOrder: string[] = [];

  /** `${chatId}:${messageId}` → live correction debounce timer. */
  private readonly correctionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(cfg: BuzzMirrorConfig) {
    this.cfg = cfg;
    this.log = cfg.log ?? (() => {});
  }

  /** Register the transport to the duplex Buzz peer (ipcServer.sendToBuzzPeer). */
  attachSender(sender: BuzzPeerSender): void {
    this.sender = sender;
  }

  private evict<T>(map: Map<string, T>, order: string[]): void {
    while (order.length > MAX_TRACKED) {
      const k = order.shift();
      if (k !== undefined) map.delete(k);
    }
  }

  /**
   * Mirror a just-delivered Telegram answer to Buzz, if the route calls for it
   * and the owner binding is safe (S1). No-op when Buzz is not in the route.
   * Never throws — a mirror failure must never disturb the Telegram answer.
   */
  mirrorReplyDelivered(input: MirrorReplyInput): void {
    try {
      // buzzEnabled is implied — this instance only exists when enabled.
      const route = resolveRoute(input.ownerOriginChannel, this.cfg.mode, true);
      const buzzInRoute =
        route.primary === "buzz" || route.mirrors.includes("buzz");
      if (!buzzInRoute) return;

      let channelId: string;
      let replyToEventId: string | undefined;
      let threadRootId: string | undefined;

      if (input.ownerOriginChannel === "buzz" && input.ownerBuzzCoords) {
        // THREADED reply into an existing Buzz conversation — the ONLY path the
        // S1 owner guard gates. Fail safe to Telegram-only on an ambiguous bind.
        if (
          !isBuzzThreadedPublishSafe({
            ownerEchoed: input.ownerEchoed,
            hasRecentDifferentOriginTurn: input.hasRecentDifferentOriginTurn,
          })
        ) {
          this.log(
            "buzz-mirror: S1 guard blocked a threaded publish on an ambiguous " +
              "owner binding (un-echoed reply + a recent different-origin turn) " +
              "— delivered Telegram-only",
          );
          return;
        }
        channelId = input.ownerBuzzCoords.channelId;
        replyToEventId = input.ownerBuzzCoords.eventId;
        threadRootId = input.ownerBuzzCoords.threadRoot;
      } else {
        // TELEGRAM-origin → fresh top-level post to the configured channel. Not
        // an owner-bound thread, so the S1 guard does not apply (design §3.3).
        if (!this.cfg.defaultChannelId) return; // no channel to post into
        channelId = this.cfg.defaultChannelId;
      }

      this.publish(
        {
          channelId,
          replyToEventId,
          threadRootId,
          payload: { kind: "message", text: input.scrubbedText },
        },
        input.telegramMessageKeys,
      );
    } catch (err) {
      this.log(`buzz-mirror: mirrorReplyDelivered threw (ignored): ${String(err)}`);
    }
  }

  /**
   * Debounced correction: an `edit_message` on a Telegram message that was
   * mirrored to Buzz publishes a superseding `correction` event 30s after the
   * last edit (F6 CORRECTION_DEBOUNCE_MS). No-op when the edited message was
   * never mirrored (no Buzz event to correct). Never throws.
   */
  mirrorCorrection(input: MirrorCorrectionInput): void {
    try {
      const target = this.msgToBuzz.get(input.telegramMessageKey);
      if (!target) return; // this Telegram message was never mirrored to Buzz

      const existing = this.correctionTimers.get(input.telegramMessageKey);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.correctionTimers.delete(input.telegramMessageKey);
        // Re-read: the mapping may have advanced (a later publish), but the
        // targetEventId to supersede is the one current at fire time.
        const t = this.msgToBuzz.get(input.telegramMessageKey);
        if (!t) return;
        this.publish(
          {
            channelId: t.channelId,
            replyToEventId: t.eventId,
            threadRootId: t.eventId,
            payload: {
              kind: "correction",
              text: input.scrubbedText,
              targetEventId: t.eventId,
            },
          },
          [], // a correction is not itself re-correctable via a Telegram edit
        );
      }, CORRECTION_DEBOUNCE_MS);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
      this.correctionTimers.set(input.telegramMessageKey, timer);
    } catch (err) {
      this.log(`buzz-mirror: mirrorCorrection threw (ignored): ${String(err)}`);
    }
  }

  /** Handle the sidecar's advisory publish outcome (buzz_publish_result). */
  onPublishResult(msg: {
    correlationId: string;
    ok: boolean;
    eventId?: string;
    error?: string;
  }): void {
    const p = this.pending.get(msg.correlationId);
    this.pending.delete(msg.correlationId);
    if (!p) return;
    if (!msg.ok || !msg.eventId) {
      this.log(
        `buzz-mirror: publish failed (correlationId=${msg.correlationId.slice(0, 8)}` +
          `${msg.error ? ` error=${msg.error}` : ""}) — Telegram copy already delivered`,
      );
      return;
    }
    // Record the published event against each Telegram message it mirrored, so
    // a later edit_message on any of them can target it for a correction.
    for (const key of p.telegramMessageKeys) {
      this.msgToBuzz.set(key, { eventId: msg.eventId, channelId: p.channelId });
      this.msgOrder.push(key);
    }
    this.evict(this.msgToBuzz, this.msgOrder);
  }

  private publish(
    fields: Omit<OutboundToBuzzMessage, "type" | "correlationId" | "agentName">,
    telegramMessageKeys: string[],
  ): void {
    if (!this.sender) {
      this.log("buzz-mirror: no Buzz peer connected — mirror dropped (Telegram copy delivered)");
      return;
    }
    const correlationId = randomUUID();
    const msg: OutboundToBuzzMessage = {
      type: "outbound_to_buzz",
      correlationId,
      agentName: this.cfg.agentName,
      ...fields,
    };
    const sent = this.sender(msg);
    if (!sent) {
      this.log("buzz-mirror: Buzz peer send returned false — mirror dropped (Telegram copy delivered)");
      return;
    }
    this.pending.set(correlationId, {
      channelId: fields.channelId,
      telegramMessageKeys,
    });
    this.pendingOrder.push(correlationId);
    this.evict(this.pending, this.pendingOrder);
  }
}

let singleton: BuzzMirror | null = null;

/**
 * Initialize the hub mirror. Called by the gateway ONLY when
 * `channels.buzz.enabled === true`. Idempotent-ish: a second call replaces the
 * instance (used by tests). When never called, `getBuzzMirror()` stays null and
 * every hook site is a no-op.
 */
export function initBuzzMirror(cfg: BuzzMirrorConfig): BuzzMirror {
  singleton = new BuzzMirror(cfg);
  return singleton;
}

export function getBuzzMirror(): BuzzMirror | null {
  return singleton;
}

/**
 * Boot the hub mirror from env at gateway startup — the single wiring seam the
 * gateway calls. DARK BY DEFAULT and by construction: returns null (leaving
 * `getBuzzMirror()` null, every hook site a no-op) unless BOTH hold —
 *   (1) `BUZZ_ENABLED` is truthy, AND
 *   (2) the S2-narrowed mode (`parseConfiguredMirrorMode`) is `both`;
 *       a configured `origin`/`off` degrades to dark, never a half-live mirror.
 * The Buzz env vars are projected at compose time from `channels.buzz`
 * (src/agents/compose.ts), with BUZZ_ENABLED=1 gated on `enabled === true`;
 * an enabled:false/absent block leaves them unset, so for those agents this
 * is inert by construction. `sender` is the transport to the duplex peer
 * (`ipcServer.sendToBuzzPeer`). Returns the booted instance for tests.
 */
export function maybeBootBuzzMirror(
  sender: BuzzPeerSender,
  env: Record<string, string | undefined> = process.env,
): BuzzMirror | null {
  if (env.BUZZ_ENABLED !== "1" && env.BUZZ_ENABLED !== "true") return null;
  const mode = parseConfiguredMirrorMode(env.BUZZ_MIRROR);
  if (mode !== "both") return null;
  const bm = initBuzzMirror({
    mode,
    agentName: env.SWITCHROOM_AGENT_NAME?.trim() ?? "",
    defaultChannelId: env.BUZZ_CHANNEL_IDS?.trim() ?? "",
    log: (m) => process.stderr.write(`telegram gateway: buzz-mirror — ${m}\n`),
  });
  bm.attachSender(sender);
  return bm;
}

/** Test-only: tear down the singleton so cases don't leak state into each other. */
export function __resetBuzzMirrorForTests(): void {
  singleton = null;
}

export type { BuzzMirror };
