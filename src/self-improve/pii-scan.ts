/**
 * Agent self-improvement — the DETERMINISTIC PII / secret scan on
 * eval-case content (RFC amendment §"corrections as eval cases",
 * invariant I4: "a deterministic PII/secret scan runs, fail-closed, on
 * every eval-case write — at propose time AND at approved-apply time").
 *
 * An eval case is a verbatim transcript excerpt of a real correction, so
 * it is exactly where an operator's name / email / phone / an API key
 * could leak into a skill bundle that later ships in a reviewed PR. This
 * module is the gate that stops that, in CODE, before the bytes ever land.
 *
 * Design:
 *   - The SECRET half reuses the existing `detectSecrets` engine
 *     (telegram-plugin/secret-detect) verbatim — the same anchored
 *     provider prefixes + structured KEY=VALUE + Shannon-entropy stack the
 *     inbound gate and outbound scrub run. We do NOT duplicate those
 *     patterns (that would drift, and would trip check-secret-pattern-
 *     parity). A single source of truth for "what is a secret".
 *   - The PII half adds the handful of patterns the secret engine does not
 *     cover — email, phone, credit-card (Luhn-checked), US SSN — because
 *     those are person-data, not credentials, and don't belong in the
 *     secret-pattern table.
 *
 * FAIL-CLOSED contract: the CALLER treats any non-empty finding list as a
 * hard reject, and treats an internal scan error as a finding too (uncertain
 * ⇒ block). `scanForPII` never throws — an internal exception is reported as
 * a synthetic `scan-error` finding so the caller blocks rather than a silent
 * pass. This is deliberate: a false-positive is an annoyance (tracked as the
 * L2 override follow-up); a false-negative ships PII into a skill bundle.
 *
 * Excerpts in a finding are ALWAYS masked — this module never emits the raw
 * matched bytes, so findings are safe to log or render on an approval card.
 */

import { detectSecrets } from "../../telegram-plugin/secret-detect/index.js";

export type PIIKind = "secret" | "email" | "phone" | "card" | "ssn" | "scan-error";

export interface PIIFinding {
  kind: PIIKind;
  /** For a secret finding, the detector's rule_id (e.g. "anthropic_api_key"). */
  rule?: string;
  /** A MASKED excerpt — never the raw matched bytes. Safe to log/render. */
  excerpt: string;
}

export interface PIIScanResult {
  /** true ⇒ clean (no findings). */
  ok: boolean;
  findings: PIIFinding[];
}

// ── Masking helpers (never emit raw PII) ─────────────────────────────

function maskEmail(s: string): string {
  const at = s.indexOf("@");
  if (at <= 0) return "[email]";
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local.slice(0, 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";
  return `${head}***@***${tld}`;
}

function maskDigits(s: string): string {
  const digits = s.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

// ── PII patterns (NOT credentials — kept out of the secret table) ────

// Email: conservative RFC-ish local@domain.tld.
const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;

// Phone: E.164 (+ country code, 10–15 digits) OR a US-style
// XXX-XXX-XXXX / (XXX) XXX-XXXX with real separators. Deliberately NOT a
// bare 10-digit run (that false-positives on IDs / version numbers).
const PHONE_E164_RE = /\+[1-9]\d{9,14}(?!\d)/g;
const PHONE_SEP_RE = /(?<!\d)(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)/g;

// US SSN: XXX-XX-XXXX with dashes (a bare 9-digit run is too noisy).
const SSN_RE = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g;

// Candidate card number: 13–19 digits, optional single space/dash groups.
const CARD_CANDIDATE_RE = /(?<![\d-])(?:\d[ -]?){13,19}(?![\d-])/g;

/** Luhn checksum — the deterministic filter that stops card false positives. */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Scan `text` for PII and secrets. Never throws; an internal error becomes
 * a `scan-error` finding so the fail-closed caller blocks.
 */
export function scanForPII(text: string): PIIScanResult {
  const findings: PIIFinding[] = [];
  if (typeof text !== "string" || text.length === 0) {
    return { ok: true, findings };
  }

  // ── Secrets: reuse the single-source detectSecrets engine ──
  try {
    for (const d of detectSecrets(text)) {
      // A detection suppressed by a nearby test/mock/example marker is
      // demoted by the engine; we still surface it, because an eval case
      // that literally contains "sk-…" next to the word "example" is
      // exactly the leak we're guarding. The L2 follow-up tracks an
      // operator override for a legitimate secret-handling eval case.
      findings.push({
        kind: "secret",
        rule: d.rule_id,
        excerpt: `[secret:${d.rule_id}]`,
      });
    }
  } catch (err) {
    // Fail-closed: an engine error must not wave content through.
    findings.push({
      kind: "scan-error",
      excerpt: `secret scan failed: ${(err as Error).message}`.slice(0, 120),
    });
  }

  // ── PII: person-data the secret engine does not cover ──
  try {
    for (const m of text.matchAll(EMAIL_RE)) {
      findings.push({ kind: "email", excerpt: maskEmail(m[0]) });
    }
    for (const m of text.matchAll(PHONE_E164_RE)) {
      findings.push({ kind: "phone", excerpt: maskDigits(m[0]) });
    }
    for (const m of text.matchAll(PHONE_SEP_RE)) {
      findings.push({ kind: "phone", excerpt: maskDigits(m[0]) });
    }
    for (const m of text.matchAll(SSN_RE)) {
      findings.push({ kind: "ssn", excerpt: maskDigits(m[0]) });
    }
    for (const m of text.matchAll(CARD_CANDIDATE_RE)) {
      const digits = m[0].replace(/\D/g, "");
      if (luhnValid(digits)) {
        findings.push({ kind: "card", excerpt: maskDigits(m[0]) });
      }
    }
  } catch (err) {
    findings.push({
      kind: "scan-error",
      excerpt: `pii scan failed: ${(err as Error).message}`.slice(0, 120),
    });
  }

  return { ok: findings.length === 0, findings };
}

/** One-line human summary of findings, for a rejection message / card. */
export function summarizeFindings(findings: PIIFinding[]): string {
  if (findings.length === 0) return "clean";
  const counts = new Map<PIIKind, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${n}×${k}`).join(", ");
}
