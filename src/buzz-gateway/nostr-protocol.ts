/**
 * Pure Nostr wire helpers for the Buzz sidecar — NIP-01 frames + the NIP-42
 * AUTH answer. No socket, no clock beyond an injected `now`, so the handshake
 * logic is unit-testable without a relay.
 *
 * Phase 0 F2: the relay is closed (NIP-42 + NIP-43 membership). On connect it
 * sends `["AUTH", <challenge>]`; the client must reply with `["AUTH", <signed
 * kind:22242 event>]` carrying `["relay", <url>]` and `["challenge", <chal>]`
 * tags. Only after a successful `["OK", <authEventId>, true]` may `REQ` return
 * events.
 */

import { finalizeEvent } from "nostr-tools";
import type { NostrEventLike } from "./auth-gate.js";

/** NIP-42 client authentication event kind. */
export const NIP42_AUTH_KIND = 22242;

export interface NostrFilter {
  kinds?: number[];
  since?: number;
  limit?: number;
  // NIP-29 group scoping tag filter, e.g. "#h": [groupId].
  [tagFilter: `#${string}`]: string[] | undefined;
}

/** Build a subscription REQ frame (as the array that gets JSON-stringified). */
export function buildReqFrame(subId: string, filters: NostrFilter[]): unknown[] {
  return ["REQ", subId, ...filters];
}

/** Build a CLOSE frame for a subscription. */
export function buildCloseFrame(subId: string): unknown[] {
  return ["CLOSE", subId];
}

/**
 * Build + sign the NIP-42 auth event. `secretKey` is a 32-byte Uint8Array
 * (nostr-tools v2). `relayUrl` MUST be the URL the relay expects (it echoes it
 * into the challenge binding). `nowSec` is injectable for deterministic tests.
 */
export function buildAuthEvent(
  challenge: string,
  relayUrl: string,
  secretKey: Uint8Array,
  nowSec: number = Math.floor(Date.now() / 1000),
): NostrEventLike {
  const template = {
    kind: NIP42_AUTH_KIND,
    created_at: nowSec,
    tags: [
      ["relay", relayUrl],
      ["challenge", challenge],
    ],
    content: "",
  };
  return finalizeEvent(template, secretKey) as NostrEventLike;
}

/** Build the `["AUTH", <signed event>]` client frame. */
export function buildAuthFrame(authEvent: NostrEventLike): unknown[] {
  return ["AUTH", authEvent];
}

export type RelayFrame =
  | { type: "EVENT"; subId: string; event: NostrEventLike }
  | { type: "EOSE"; subId: string }
  | { type: "AUTH"; challenge: string }
  | { type: "OK"; eventId: string; accepted: boolean; message: string }
  | { type: "CLOSED"; subId: string; message: string }
  | { type: "NOTICE"; message: string }
  | { type: "UNKNOWN"; raw: unknown };

/**
 * Parse a raw relay→client message (a JSON string OR an already-parsed array)
 * into a discriminated frame. Never throws — malformed input maps to UNKNOWN
 * so the socket loop can log and continue rather than die.
 */
export function parseRelayFrame(raw: string | unknown[]): RelayFrame {
  let arr: unknown[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { type: "UNKNOWN", raw: parsed };
      arr = parsed;
    } catch {
      return { type: "UNKNOWN", raw };
    }
  } else {
    arr = raw;
  }

  const tag = arr[0];
  switch (tag) {
    case "EVENT":
      if (typeof arr[1] === "string" && arr[2] && typeof arr[2] === "object") {
        return { type: "EVENT", subId: arr[1], event: arr[2] as NostrEventLike };
      }
      return { type: "UNKNOWN", raw: arr };
    case "EOSE":
      if (typeof arr[1] === "string") return { type: "EOSE", subId: arr[1] };
      return { type: "UNKNOWN", raw: arr };
    case "AUTH":
      if (typeof arr[1] === "string") return { type: "AUTH", challenge: arr[1] };
      return { type: "UNKNOWN", raw: arr };
    case "OK":
      if (typeof arr[1] === "string" && typeof arr[2] === "boolean") {
        return {
          type: "OK",
          eventId: arr[1],
          accepted: arr[2],
          message: typeof arr[3] === "string" ? arr[3] : "",
        };
      }
      return { type: "UNKNOWN", raw: arr };
    case "CLOSED":
      if (typeof arr[1] === "string") {
        return {
          type: "CLOSED",
          subId: arr[1],
          message: typeof arr[2] === "string" ? arr[2] : "",
        };
      }
      return { type: "UNKNOWN", raw: arr };
    case "NOTICE":
      return { type: "NOTICE", message: typeof arr[1] === "string" ? arr[1] : "" };
    default:
      return { type: "UNKNOWN", raw: arr };
  }
}
