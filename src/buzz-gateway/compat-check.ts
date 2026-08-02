/**
 * Buzz relay-contract compatibility check (Phase 1 drift guard).
 *
 * The closed Buzz relay validates three things about the sidecar's wire
 * traffic BEFORE it will return events: the NIP-42 AUTH event kind, the
 * NIP-29 channel-message kind the REQ subscribes to, and the exact tag names
 * the AUTH event carries. Those are pinned as Phase-0 findings (F2, F5) and
 * live in code as `NIP42_AUTH_KIND`, `BUZZ_MESSAGE_KIND`, and the AUTH tag set
 * built in `buildAuthEvent`. If any of them drifts away from the value the
 * relay expects, AUTH (or the subsequent REQ) fails silently in production
 * with only an opaque relay `CLOSED`/`NOTICE`.
 *
 * This module reconciles the LIVE code constants against the PINNED fixture
 * (`fixtures/relay-contract.json`) and returns warnings — it NEVER throws and
 * NEVER fails a build. Interpretation note (deploy-wiring pass): the task's
 * "relay-digest/kind mismatch" hook is scoped, minimally, to the wire-contract
 * constants the code can introspect; the actual relay-side digests are captured
 * off-repo, so the fixture pins the contract SHAPE (kinds + tag names) plus a
 * self-consistent sha256 digest over it, not a byte capture of relay output.
 * The check is a warn-only tripwire, deliberately non-fatal, so it can run in
 * `build.mjs` / boot without ever wedging a dark-by-default sidecar.
 */

import { createHash } from "node:crypto";
import { NIP42_AUTH_KIND } from "./nostr-protocol.js";
import { BUZZ_MESSAGE_KIND } from "./inbound-map.js";

/** The tag names `buildAuthEvent` puts on every NIP-42 AUTH event. */
export const AUTH_EVENT_TAG_NAMES = ["challenge", "relay"] as const;

/** The wire-contract fields the relay validates (order-independent). */
export interface RelayContract {
  nip42_auth_kind: number;
  message_kind: number;
  /** Sorted, lowercased tag names on the AUTH event. */
  auth_tags: string[];
}

/** The contract as the LIVE sidecar code implements it right now. */
export function liveRelayContract(): RelayContract {
  return {
    nip42_auth_kind: NIP42_AUTH_KIND,
    message_kind: BUZZ_MESSAGE_KIND,
    auth_tags: [...AUTH_EVENT_TAG_NAMES].map((t) => t.toLowerCase()).sort(),
  };
}

/**
 * sha256 over the canonical (sorted-key, sorted-tags) JSON of a contract.
 * Stable across key order so the fixture digest only moves when a VALUE moves.
 */
export function computeContractDigest(c: RelayContract): string {
  const canonical = JSON.stringify({
    auth_tags: [...c.auth_tags].map((t) => t.toLowerCase()).sort(),
    message_kind: c.message_kind,
    nip42_auth_kind: c.nip42_auth_kind,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The pinned fixture shape (a superset of RelayContract + its digest). */
export interface PinnedRelayContract extends RelayContract {
  digest: string;
}

export interface CompatResult {
  ok: boolean;
  /** Human-readable drift lines; empty when the live code matches the pin. */
  warnings: string[];
}

/**
 * Reconcile the live code constants against the pinned fixture. Warn-only:
 * `ok:false` means "drift detected, look at it", NOT "abort". Callers that
 * want a hard gate can inspect `warnings` themselves.
 */
export function checkRelayCompat(pinned: PinnedRelayContract): CompatResult {
  const live = liveRelayContract();
  const warnings: string[] = [];

  if (live.nip42_auth_kind !== pinned.nip42_auth_kind) {
    warnings.push(
      `NIP-42 AUTH kind drift: code=${live.nip42_auth_kind} pinned=${pinned.nip42_auth_kind} ` +
        `(relay validates the AUTH event kind before membership — AUTH will fail if this is wrong)`,
    );
  }
  if (live.message_kind !== pinned.message_kind) {
    warnings.push(
      `NIP-29 message kind drift: code=${live.message_kind} pinned=${pinned.message_kind} ` +
        `(the REQ subscribes to this kind — a mismatch silently returns zero events)`,
    );
  }
  const liveTags = live.auth_tags.join(",");
  const pinnedTags = [...pinned.auth_tags].map((t) => t.toLowerCase()).sort().join(",");
  if (liveTags !== pinnedTags) {
    warnings.push(
      `AUTH tag-set drift: code=[${liveTags}] pinned=[${pinnedTags}] ` +
        `(the relay binds the challenge to these exact tags)`,
    );
  }

  // Digest is the belt-and-suspenders catch: even if a field-by-field compare
  // above missed something (e.g. a future field added to the fixture), the
  // digest of the live contract must equal the pinned digest.
  const liveDigest = computeContractDigest(live);
  if (liveDigest !== pinned.digest) {
    warnings.push(
      `relay-contract digest drift: code=${liveDigest} pinned=${pinned.digest} ` +
        `(regenerate the fixture with computeContractDigest() if this change is intentional)`,
    );
  }

  return { ok: warnings.length === 0, warnings };
}

/**
 * Convenience for build.mjs / boot: run the check against the vendored fixture
 * and emit warnings to the provided sink (defaults to console.warn). Returns
 * the result so a caller can decide what, if anything, to do with it. Never
 * throws — a missing/garbled fixture degrades to a single warning.
 */
export function warnOnRelayContractDrift(
  pinned: PinnedRelayContract,
  warn: (msg: string) => void = (m) => console.warn(m),
): CompatResult {
  const result = checkRelayCompat(pinned);
  for (const w of result.warnings) warn(`[buzz][compat] ${w}`);
  return result;
}
