/**
 * SSRF / exfil egress guard for Tier-0 http-diff polls —
 * docs/rfcs/cheap-cron-sessions.md §6.1 (resolves the review BLOCK).
 *
 * A poll = URL + headers + vault secrets executed by the scheduler. Left
 * unfenced that is a textbook SSRF + secret-exfil primitive (point a poll
 * at 127.0.0.1 / the broker socket, or ship a vaulted secret to
 * attacker.com). This module fences it:
 *
 *   1. URL must be https to a host on the operator EGRESS ALLOWLIST
 *      (not agent-writable). loopback / private / link-local / IP-literal
 *      hosts are rejected even if somehow allowlisted.
 *   2. A secret may only be sent to the host it is BOUND to in operator
 *      config — so an approved poll can never carry a secret elsewhere.
 *   3. The resolved IP is re-checked at fetch time (DNS-rebind pin) via
 *      isBlockedAddress on the lookup result.
 *
 * Pure + dependency-light so the whole guard is exhaustively unit-tested
 * (poll-egress.test.ts) without network. The runtime fetch wrapper
 * (poll-engine.ts) supplies the DNS lookup + redirect/timeout/size caps.
 */

import { isIP } from "node:net";

export interface EgressAllowlist {
  /** Operator-approved hosts a poll may reach (exact, case-insensitive). */
  hosts: string[];
  /** secretName → the single host it may be sent to. */
  secretBindings: Record<string, string>;
}

export type EgressCheck = { ok: true } | { ok: false; reason: string };

const ok: EgressCheck = { ok: true };
const deny = (reason: string): EgressCheck => ({ ok: false, reason });

/** Normalise a host for comparison: lowercase, strip a trailing dot, drop brackets. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

/**
 * True for an IP address that must never be reachable from a poll:
 * loopback, RFC-1918 private, link-local, ULA, unspecified, broadcast,
 * carrier-grade NAT. Applied to IP-literal hosts AND to the resolved IP
 * (DNS-rebind defence). Anything it can't parse as an IP returns false
 * (a hostname is judged by the allowlist, not here).
 */
export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return isBlockedV4(addr);
  if (v === 6) return isBlockedV6(addr);
  return false;
}

function isBlockedV4(addr: string): boolean {
  const o = addr.split(".").map((n) => Number(n));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 (unspecified)
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // multicast + reserved + 255.255.255.255
  return false;
}

function isBlockedV6(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "::" || a === "::1") return true; // unspecified / loopback
  if (a.startsWith("fe80")) return true; // link-local
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // ULA fc00::/7
  if (a.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded v4.
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]!);
  return false;
}

/**
 * Validate a poll URL: https scheme, allowlisted host, not an IP literal
 * that resolves to a blocked range. Pure — the runtime DNS-rebind pin
 * (isBlockedAddress on the looked-up IP) is applied separately at fetch.
 */
export function checkEgressUrl(rawUrl: string, allow: EgressAllowlist): EgressCheck {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return deny(`unparseable url`);
  }
  if (u.protocol !== "https:") return deny(`scheme ${u.protocol} not allowed (https only)`);
  if (u.username || u.password) return deny(`userinfo in url not allowed`);
  const host = normalizeHost(u.hostname);
  if (!host) return deny(`empty host`);
  // An IP-literal host is rejected if it's in a blocked range; a public IP
  // literal is still rejected unless explicitly allowlisted below.
  if (isIP(host) && isBlockedAddress(host)) return deny(`blocked ip literal ${host}`);
  const allowed = allow.hosts.map(normalizeHost);
  if (!allowed.includes(host)) return deny(`host ${host} not on egress allowlist`);
  return ok;
}

/** A secret may only be sent to the host it is bound to in operator config. */
export function checkSecretBinding(
  secretName: string,
  host: string,
  allow: EgressAllowlist,
): EgressCheck {
  const bound = allow.secretBindings[secretName];
  if (!bound) return deny(`secret ${secretName} has no host binding`);
  if (normalizeHost(bound) !== normalizeHost(host)) {
    return deny(`secret ${secretName} bound to ${bound}, not ${host}`);
  }
  return ok;
}

/** Full pre-fetch gate for an http-diff poll: URL + every secret it carries. */
export function checkHttpDiffEgress(
  rawUrl: string,
  secrets: string[],
  allow: EgressAllowlist,
): EgressCheck {
  const urlCheck = checkEgressUrl(rawUrl, allow);
  if (!urlCheck.ok) return urlCheck;
  const host = normalizeHost(new URL(rawUrl).hostname);
  for (const s of secrets) {
    const sc = checkSecretBinding(s, host, allow);
    if (!sc.ok) return sc;
  }
  return ok;
}
