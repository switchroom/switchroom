import { describe, it, expect } from 'vitest'
import { detectSecrets } from '../secret-detect/index.js'
import { redact } from '../secret-detect/redact.js'

/**
 * Regression for the 2026-06-01 incident: a live Laravel Sanctum / Coolify
 * personal-access token (`<id>|<40-char base62>`, e.g. `17|aB3d…`) pasted by
 * a USER into chat slipped every existing pattern and persisted in plaintext.
 *
 * Diagnosis: the inbound gate (gateway handleInbound) already runs
 * `detectSecrets` at ingest, fail-closed, BEFORE recordInbound + IPC dispatch
 * — so the leak was NOT an inbound bypass and NOT render-time masking. It was
 * pure PATTERN COVERAGE: no rule matched the `<id>|<token>` shape. These tests
 * pin the new `laravel_sanctum_token` rule and the redactor that backs both
 * the history-store persistence (both directions) and the issues pipeline.
 */

// Build token fixtures by concatenation so the source file never contains a
// contiguous secret-shaped literal (repo Push Protection / no-pii lint).
const ID = '17'
const BODY40 = 'aB3dE6fH9j'.repeat(4) // 40 base62 chars — Sanctum's Str::random(40)
const SANCTUM = `${ID}|${BODY40}` // e.g. 17|aB3dE6fH9j…

describe('laravel/coolify sanctum token detection', () => {
  it('detects <id>|<40-char> as a high-confidence laravel_sanctum_token', () => {
    const hits = detectSecrets(`here is the token: ${SANCTUM}`)
    const hit = hits.find((d) => d.rule_id === 'laravel_sanctum_token')
    expect(hit).toBeDefined()
    expect(hit!.matched_text).toBe(SANCTUM)
    expect(hit!.confidence).toBe('high')
    expect(hit!.suppressed).toBe(false)
  })

  it('satisfies the exact inbound-gate predicate (high + not suppressed)', () => {
    // This is verbatim the condition gateway handleInbound uses to decide to
    // delete + defer-to-vault: if it is truthy, the pasted token is
    // intercepted before recordInbound() and the IPC broadcast to the agent.
    const detections = detectSecrets(SANCTUM)
    const gateHit = detections.find((d) => d.confidence === 'high' && !d.suppressed)
    expect(gateHit).toBeDefined()
  })

  it('redact() masks the token in place, preserving surrounding prose', () => {
    const out = redact(`new token: ${SANCTUM}\nuse it for the deploy API`)
    expect(out).not.toContain(SANCTUM)
    expect(out).not.toContain(BODY40)
    expect(out).toContain('[REDACTED:laravel_sanctum_token]')
    // Surrounding prose is untouched.
    expect(out).toContain('new token:')
    expect(out).toContain('use it for the deploy API')
  })

  it('covers longer-than-40 token bodies', () => {
    const longTok = `42|${'Xy7Zk2Qp9w'.repeat(6)}` // 60 base62 chars
    const hits = detectSecrets(longTok)
    expect(hits.find((d) => d.rule_id === 'laravel_sanctum_token')?.matched_text).toBe(longTok)
  })

  it('catches a token mid-sentence and masks only the token', () => {
    const out = redact(`use ${SANCTUM} when deploying, ok?`)
    expect(out).not.toContain(SANCTUM)
    expect(out).toContain('use ')
    expect(out).toContain(' when deploying, ok?')
  })

  it('catches multiple tokens in one message (redact right-to-left loop)', () => {
    const second = `88|${'mK2pR7vT4x'.repeat(4)}` // distinct <id>|<40 base62>
    const detected = detectSecrets(`old ${SANCTUM} new ${second}`)
      .filter((d) => d.rule_id === 'laravel_sanctum_token')
    expect(detected).toHaveLength(2)
    const out = redact(`old ${SANCTUM} new ${second}`)
    expect(out).not.toContain(SANCTUM)
    expect(out).not.toContain(second)
    expect(out).not.toContain(BODY40)
  })

  describe('false-positive guards', () => {
    it('does NOT match a pipe-joined value under the 40-char floor', () => {
      const short = `1|${'abcDEF123'}` // 9 chars after the pipe
      expect(detectSecrets(short).some((d) => d.rule_id === 'laravel_sanctum_token')).toBe(false)
    })

    it('does NOT match exactly 39 base62 chars (one under the floor)', () => {
      const justUnder = `17|${BODY40.slice(0, 39)}`
      expect(
        detectSecrets(justUnder).some((d) => d.rule_id === 'laravel_sanctum_token'),
      ).toBe(false)
    })

    it('does NOT match a number with no pipe-delimited token', () => {
      expect(
        detectSecrets('order 17 shipped 40 items').some(
          (d) => d.rule_id === 'laravel_sanctum_token',
        ),
      ).toBe(false)
    })

    it('does NOT match a spaced markdown table cell', () => {
      // Table cells are `| value |` with spaces around the pipe; the Sanctum
      // shape has the token immediately adjacent to the pipe.
      const table = `| 17 | ${BODY40} |`
      expect(
        detectSecrets(table).some((d) => d.rule_id === 'laravel_sanctum_token'),
      ).toBe(false)
    })
  })

  it('suppresses a token sitting next to an example/fixture marker', () => {
    // A documented example must not trigger a destructive delete+vault.
    const hits = detectSecrets(`example token: ${SANCTUM}`)
    const hit = hits.find((d) => d.rule_id === 'laravel_sanctum_token')
    expect(hit).toBeDefined()
    expect(hit!.suppressed).toBe(true)
  })
})
