/**
 * Buzz inbound authorization gate (Phase 1, B2 — fail-closed).
 *
 * Pure, side-effect-free. An inbound Nostr event becomes a turn ONLY when it
 * clears every check here:
 *
 *   1. Structural sanity — the object is an event with the fields verifyEvent
 *      needs (id, pubkey, sig, kind, created_at, content, tags).
 *   2. Signature — `verifyEvent(ev)` (schnorr sig valid AND id == the canonical
 *      serialization hash). Injected as a dependency so tests can prove the
 *      gate calls it and honours its verdict.
 *   3. Allowlist — `ev.pubkey` (hex, lowercased) ∈ the effective allowlist
 *      (`authorized_pubkeys` ∪ `{operator_pubkey}`).
 *   4. Not the agent's own pubkey — drop self-echoes so the agent can never
 *      wake itself.
 *
 * Rejections are returned with a machine reason (never the content) so the
 * caller can count/log them WITHOUT ever injecting.
 */

import { nip19 } from "nostr-tools";

/** A minimal Nostr event shape — the fields the gate + verifyEvent read. */
export interface NostrEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type AuthRejectReason =
  | "malformed"
  | "bad_signature"
  | "not_allowlisted"
  | "self_echo";

export type AuthGateResult =
  | { ok: true }
  | { ok: false; reason: AuthRejectReason };

/**
 * Normalize a pubkey given as either 64-char lowercase hex or a bech32 `npub`
 * to canonical 64-char lowercase hex. Returns null when the input is neither.
 */
export function normalizePubkey(input: string): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build the effective, hex-normalized allowlist from an operator pubkey plus
 * any extra authorized pubkeys. Un-parseable entries are dropped (fail-closed:
 * a garbage entry can never widen the set). The operator pubkey is always
 * present; if it fails to parse the set is empty (nothing is admitted) — an
 * intentionally hard failure, since a mis-typed operator key must not silently
 * fall back to admitting everyone.
 */
export function buildAuthorizedSet(
  operatorPubkey: string,
  authorizedPubkeys: readonly string[] = [],
): Set<string> {
  const set = new Set<string>();
  const op = normalizePubkey(operatorPubkey);
  if (op) set.add(op);
  for (const pk of authorizedPubkeys) {
    const norm = normalizePubkey(pk);
    if (norm) set.add(norm);
  }
  return set;
}

export interface AdmitDeps {
  /** Effective, hex-normalized allowlist (see buildAuthorizedSet). */
  authorized: ReadonlySet<string>;
  /** The agent's OWN pubkey (hex, lowercase) — self-echoes are dropped. */
  agentPubkey: string | null;
  /**
   * Signature verifier. Production passes nostr-tools' `verifyEvent`. MUST
   * return true only for a structurally valid, correctly-signed event whose id
   * matches its canonical serialization.
   */
  verify: (ev: NostrEventLike) => boolean;
}

function isStructurallyValid(ev: unknown): ev is NostrEventLike {
  if (ev == null || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    /^[0-9a-f]{64}$/.test(e.id) &&
    typeof e.pubkey === "string" &&
    /^[0-9a-f]{64}$/.test(e.pubkey) &&
    typeof e.sig === "string" &&
    typeof e.content === "string" &&
    typeof e.kind === "number" &&
    typeof e.created_at === "number" &&
    Array.isArray(e.tags)
  );
}

/**
 * Decide whether an event may become a turn. Order is deliberate: structural →
 * signature → allowlist → self-echo. Signature is checked BEFORE the allowlist
 * so a forged event claiming an allowlisted pubkey is caught by the crypto, not
 * merely by string membership.
 */
export function admitEvent(ev: unknown, deps: AdmitDeps): AuthGateResult {
  if (!isStructurallyValid(ev)) return { ok: false, reason: "malformed" };
  if (!deps.verify(ev)) return { ok: false, reason: "bad_signature" };
  const pubkey = ev.pubkey.toLowerCase();
  if (deps.agentPubkey && pubkey === deps.agentPubkey.toLowerCase()) {
    return { ok: false, reason: "self_echo" };
  }
  if (!deps.authorized.has(pubkey)) {
    return { ok: false, reason: "not_allowlisted" };
  }
  return { ok: true };
}
