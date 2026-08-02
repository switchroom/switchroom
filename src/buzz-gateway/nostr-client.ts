/**
 * Minimal WebSocket Nostr client for the Buzz sidecar (Phase 0 Branch B).
 *
 * WHY NOT nostr-tools' Relay class: the Buzz relay resolves its community from
 * the HTTP `Host` header on the WS upgrade (Phase 0 blocker #2). nostr-tools'
 * pooled Relay builds the WebSocket internally and gives no way to override
 * that header, so it would get a blind 404. We drive a raw socket and set the
 * Host header ourselves; nostr-tools is used ONLY for crypto (finalizeEvent /
 * verifyEvent via the protocol + auth-gate modules).
 *
 * The socket is injected (`SocketFactory`) so the NIP-42 handshake and the
 * subscribe/reconnect logic are unit-testable with a fake, and the production
 * factory (Bun's header-capable WebSocket) is the only runtime-specific bit.
 */

import type { NostrEventLike } from "./auth-gate.js";
import {
  buildAuthEvent,
  buildAuthFrame,
  buildReqFrame,
  parseRelayFrame,
  type NostrFilter,
} from "./nostr-protocol.js";

/** The thin socket surface the client needs. */
export interface WsLike {
  send(data: string): void;
  close(): void;
}

/** Callbacks the client registers on a freshly-created socket. */
export interface WsHandlers {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}

/**
 * Create a socket to `url` sending HTTP `Host: host` on the upgrade, wired to
 * `handlers`. Production uses Bun's WebSocket (which accepts a `headers`
 * option); tests supply a fake.
 */
export type SocketFactory = (
  url: string,
  opts: { host: string },
  handlers: WsHandlers,
) => WsLike;

export interface NostrClientOptions {
  /** ws:// / wss:// address the socket DIALS (may be a docker-network IP). */
  relayUrl: string;
  /** Canonical relay URL placed VERBATIM in the NIP-42 `["relay", …]` auth
   *  tag. Decoupled from `relayUrl` on purpose: the relay validates this tag as
   *  an EXACT string match against its own canonical URL BEFORE the membership
   *  check, so it must be the relay's advertised identity, not the (possibly
   *  docker-IP) address we dial. */
  relayTagUrl: string;
  /** HTTP Host header authority to send on the upgrade. Empty ⇒ none set. */
  relayHost: string;
  /** NIP-29 group UUID to subscribe to (the `#h` filter). */
  groupId: string;
  /** Kinds to subscribe to. Default [9] (channel messages). */
  kinds?: number[];
  /** 32-byte Nostr secret key for the NIP-42 AUTH answer. */
  secretKey: Uint8Array;
  /** Delivered for each admitted-by-the-relay EVENT on our subscription.
   *  Returns `false` to signal the event was NOT durably handled (its inject
   *  failed and it is only in the volatile retry queue) — the resubscribe
   *  watermark then does NOT advance past it, so a resubscribe re-covers it
   *  (MAJOR-1 backstop for a sidecar crash before the retry lands). Any other
   *  return (a truthy value or void) advances the watermark as before. */
  onEvent: (event: NostrEventLike) => boolean | void;
  socketFactory: SocketFactory;
  log?: (msg: string) => void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Seconds of look-back applied to `since` on (re)subscribe — clock-drift
   *  and missed-while-disconnected buffer. Default 300. */
  sinceLookbackSec?: number;
  /** Injected clock (seconds) for deterministic tests. */
  nowSec?: () => number;
  /** Injected jitter in [0,1) for deterministic tests. */
  random?: () => number;
  /** Injected timer for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface NostrClient {
  start(): void;
  stop(): void;
  isSubscribed(): boolean;
}

const SUB_ID = "buzz-in";

export function createNostrClient(opts: NostrClientOptions): NostrClient {
  const log = opts.log ?? (() => {});
  const kinds = opts.kinds ?? [9];
  const lookback = opts.sinceLookbackSec ?? 300;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const random = opts.random ?? Math.random;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  const minMs = opts.reconnectMinMs ?? 1_000;
  const maxMs = opts.reconnectMaxMs ?? 60_000;

  let socket: WsLike | null = null;
  let stopped = false;
  let subscribed = false;
  let authEventId: string | null = null;
  let delay = minMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Highest created_at we have delivered — the resubscribe watermark. Start one
  // lookback window in the past so the first subscribe catches recent history.
  let watermark = nowSec() - lookback;

  function subscribe(): void {
    if (!socket) return;
    const since = Math.max(0, watermark - lookback);
    const filter: NostrFilter = { kinds, since, [`#h`]: [opts.groupId] };
    socket.send(JSON.stringify(buildReqFrame(SUB_ID, [filter])));
    log(`buzz nostr: REQ sent (since=${since}, group=${opts.groupId})`);
  }

  function handleMessage(data: string): void {
    const frame = parseRelayFrame(data);
    switch (frame.type) {
      case "AUTH": {
        // Tag with the CANONICAL relay URL, NOT the dial address: the relay
        // exact-string-matches this tag against its own URL before the
        // membership check (live-probe finding). Feeding opts.relayUrl (which
        // may be a docker IP) here yields `auth-required: verification failed`.
        const authEvent = buildAuthEvent(frame.challenge, opts.relayTagUrl, opts.secretKey, nowSec());
        authEventId = authEvent.id;
        socket?.send(JSON.stringify(buildAuthFrame(authEvent)));
        log("buzz nostr: NIP-42 AUTH answered");
        break;
      }
      case "OK": {
        if (authEventId && frame.eventId === authEventId) {
          if (frame.accepted) {
            log("buzz nostr: AUTH accepted; (re)subscribing");
            subscribe();
          } else {
            log(`buzz nostr: AUTH rejected: ${frame.message}`);
          }
        }
        break;
      }
      case "EOSE":
        subscribed = true;
        log("buzz nostr: EOSE (live)");
        break;
      case "EVENT": {
        if (frame.subId !== SUB_ID) break;
        const ev = frame.event;
        // Advance the watermark AFTER handling, and only when the event was
        // durably handled (onEvent did not return false). An inject that failed
        // and is merely queued in memory must NOT move the watermark past this
        // event, so a resubscribe re-covers it if the sidecar dies first.
        const durable = opts.onEvent(ev) !== false;
        if (durable && typeof ev?.created_at === "number" && ev.created_at > watermark) {
          watermark = ev.created_at;
        }
        break;
      }
      case "CLOSED":
        log(`buzz nostr: subscription CLOSED: ${frame.message}`);
        subscribed = false;
        break;
      case "NOTICE":
        log(`buzz nostr: NOTICE: ${frame.message}`);
        break;
      default:
        log("buzz nostr: unrecognized relay frame");
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const jitter = 1 + (random() * 0.4 - 0.2); // ±20%
    const wait = Math.min(maxMs, Math.round(delay * jitter));
    log(`buzz nostr: reconnecting in ${wait}ms`);
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (!stopped) connect();
    }, wait);
    delay = Math.min(delay * 2, maxMs);
  }

  function connect(): void {
    if (stopped) return;
    authEventId = null;
    subscribed = false;
    let s: WsLike;
    try {
      s = opts.socketFactory(
        opts.relayUrl,
        { host: opts.relayHost },
        {
          onOpen: () => {
            delay = minMs; // reset backoff on a good connect
            log("buzz nostr: connected");
            // A closed relay AUTHs first; sending REQ now prompts the AUTH
            // challenge (or, on an open relay, subscribes immediately).
            subscribe();
          },
          onMessage: handleMessage,
          onClose: () => {
            socket = null;
            subscribed = false;
            if (!stopped) scheduleReconnect();
          },
          onError: (err) => {
            log(`buzz nostr: socket error: ${err.message}`);
            // 'close' follows 'error'; reconnect handled there.
          },
        },
      );
    } catch (err) {
      log(`buzz nostr: connect threw: ${(err as Error).message}`);
      scheduleReconnect();
      return;
    }
    socket = s;
  }

  return {
    start(): void {
      stopped = false;
      connect();
    },
    stop(): void {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try { socket.close(); } catch { /* nothing to do */ }
        socket = null;
      }
    },
    isSubscribed(): boolean {
      return subscribed;
    },
  };
}
