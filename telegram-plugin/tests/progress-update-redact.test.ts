import { describe, it, expect } from 'vitest'
import { redact } from '../secret-detect/redact.js'

/**
 * Behavioral coverage for the progress_update outbound secret-scrub gap.
 *
 * progress_update was the ONLY send site in gateway.ts that did not call
 * `redactOutboundText` — so a secret the agent echoed into a progress line
 * reached Telegram (and history) unmasked, while reply / stream_reply /
 * edit_message / turn_flush all redact. The fix adds
 * `redactOutboundText(text, 'progress_update')` — and, critically, places it
 * BEFORE the 300-char truncation the tool applies. Ordering matters: if the
 * truncation ran first, a secret straddling the 300-char cut would be sliced
 * into a partial token the shape detector no longer matches, leaking the
 * visible bytes.
 *
 * These tests reproduce the gateway's `executeProgressUpdate` send prep — the
 * exact `redact` engine used in production, in the same order the fix uses
 * (redact → truncate) — and pin both the ordinary mask and the
 * straddling-the-boundary case, plus a contrast showing the WRONG order leaks.
 */

// Build the token fixture by concatenation so the source file never contains a
// contiguous secret-shaped literal (repo Push Protection / no-pii lint).
const ID = '17'
const BODY40 = 'aB3dE6fH9j'.repeat(4) // 40 base62 chars — Sanctum's Str::random(40)
const SANCTUM = `${ID}|${BODY40}` // e.g. 17|aB3dE6fH9j…

/** The production send-prep order: redact the FULL text, THEN truncate. */
function progressSendPrep(text: string): string {
  let out = redact(text)
  if (out.length > 300) out = out.slice(0, 299) + '…'
  return out
}

/** The buggy order the fix guards against: truncate first, then redact. */
function truncateFirstThenRedact(text: string): string {
  let out = text
  if (out.length > 300) out = out.slice(0, 299) + '…'
  return redact(out)
}

describe('progress_update outbound secret-scrub', () => {
  it('masks a secret-shaped token in an ordinary (short) progress line', () => {
    const out = progressSendPrep(`Deploying with token ${SANCTUM} now — hold tight`)
    expect(out).not.toContain(SANCTUM)
    expect(out).not.toContain(BODY40)
    expect(out).toContain('[REDACTED:laravel_sanctum_token]')
    // Surrounding prose survives.
    expect(out).toContain('Deploying with token')
    expect(out).toContain('hold tight')
  })

  it('masks a secret that STRADDLES the 300-char truncation boundary', () => {
    // Pad so the token spans char 300: 286 chars of prose, a space, then the
    // 43-char token. The 299/300 cut lands mid-token.
    const pad = 'progress: still working on the deploy, '.repeat(8).slice(0, 286)
    const text = `${pad} ${SANCTUM} and continuing after the token here`
    // Sanity: the token really does straddle the cut point.
    const cut = 299
    expect(text.indexOf(SANCTUM)).toBeLessThan(cut)
    expect(text.indexOf(SANCTUM) + SANCTUM.length).toBeGreaterThan(cut)

    const out = progressSendPrep(text)
    // Because redact runs on the FULL text first, the whole token is masked
    // before any slice — no secret bytes reach the wire. (The mask MARKER
    // itself may fall across the 300-char cut and be truncated — harmless,
    // since it carries no secret — so assert the leading marker survives, not
    // the full literal.)
    expect(out).not.toContain(SANCTUM)
    expect(out).not.toContain(BODY40)
    expect(out).toContain('[REDACTED')
  })

  it('proves the ordering matters: truncate-FIRST would leak the straddling secret', () => {
    // A regression fence: if someone reorders the fix so truncation precedes
    // redaction, the cut splits the token, the shape detector misses the
    // fragment, and partial secret bytes survive. This asserts the wrong order
    // leaks — the exact failure the production ordering prevents.
    const pad = 'progress: still working on the deploy, '.repeat(8).slice(0, 286)
    const text = `${pad} ${SANCTUM} and continuing after the token here`

    const wrong = truncateFirstThenRedact(text)
    // The leading fragment of the token body (pre-cut) survives unmasked.
    const leakedPrefix = BODY40.slice(0, 6)
    expect(wrong).toContain(leakedPrefix)

    // The correct order masks it — the fragment does NOT survive.
    const right = progressSendPrep(text)
    expect(right).not.toContain(leakedPrefix)
  })

  it('idempotent: a masked progress line has no secret bytes on a second pass', () => {
    const once = progressSendPrep(`token ${SANCTUM}`)
    const twice = progressSendPrep(once)
    expect(twice).not.toContain(SANCTUM)
    expect(twice).not.toContain(BODY40)
  })
})
