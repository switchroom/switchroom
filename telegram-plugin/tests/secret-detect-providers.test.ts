import { describe, it, expect } from 'vitest'
import { detectSecrets } from '../secret-detect/index.js'
import { PROVIDER_PATTERNS } from '../secret-detect/patterns.js'

/**
 * High-precision provider ruleset (#2 — "use a comprehensive, GitHub-style
 * curated set instead of 22 hand-rolled patterns"). Each fixture token is
 * built by concatenation so the source never holds a contiguous secret-shaped
 * literal (repo Push Protection / no-pii lint).
 */

// [rule_id, sample token] — token built to match the rule's regex exactly.
const HEX10 = 'a1b2c3d4e5'
const ALNUM10 = 'A1b2C3d4E5'
const CASES: Array<[string, string]> = [
  ['slack_webhook', 'https://hooks.slack.com/services/' + 'T00000000/B00000000/' + 'XXXXXXXXXXXXXXXXXXXXXXXX'],
  ['stripe_live_secret', 'sk_' + 'live_' + ALNUM10.repeat(2) + 'ABcd'],          // 24 alnum
  ['stripe_restricted', 'rk_' + 'live_' + ALNUM10.repeat(2) + 'ABcd'],
  ['sendgrid_api_key', 'SG' + '.' + (ALNUM10 + ALNUM10 + 'AB') + '.' + 'a'.repeat(43)], // 22 . 43
  ['gitlab_pat', 'glpat-' + ALNUM10.repeat(2)],                                  // 20
  ['huggingface_token', 'hf_' + 'a'.repeat(34)],
  ['twilio_api_key', 'SK' + HEX10.repeat(3) + 'ab'],                             // 32 hex
  ['mailgun_key', 'key-' + HEX10.repeat(3) + 'ab'],
  ['digitalocean_pat', 'dop_v1_' + HEX10.repeat(6) + 'abcd'],                    // 64 hex
  ['linear_api_key', 'lin_api_' + ALNUM10.repeat(4)],                           // 40
  ['shopify_access_token', 'shpat_' + HEX10.repeat(3) + 'ab'],
  ['square_access_token', 'sq0atp-' + ALNUM10.repeat(2) + 'AB'],                 // 22
  ['newrelic_key', 'NRAK-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0'],                     // 27 A-Z0-9
  ['notion_token', 'ntn_' + ALNUM10.repeat(4) + 'A1b2C3'],                       // 46
  ['atlassian_token', 'ATATT' + ALNUM10.repeat(2)],
  ['supabase_service_key', 'sbp_' + HEX10.repeat(4)],                            // 40 hex
  ['databricks_token', 'dapi' + HEX10.repeat(3) + 'ab'],
  ['aws_temp_access_key', 'ASIA' + 'ABCDEFGHIJKLMNOP'],                          // 16 A-Z0-9
  ['gcp_oauth_token', 'ya29' + '.' + 'a'.repeat(40)],
]

describe('high-precision provider patterns', () => {
  for (const [ruleId, tok] of CASES) {
    it(`detects ${ruleId} as a high-confidence hit`, () => {
      const hits = detectSecrets(`here's the credential: ${tok} — use it`)
      const hit = hits.find((d) => d.rule_id === ruleId)
      expect(hit, `expected a ${ruleId} hit for ${tok.slice(0, 8)}…`).toBeDefined()
      expect(hit!.matched_text).toBe(tok)
      expect(hit!.confidence).toBe('high')
      expect(hit!.suppressed).toBe(false)
    })
  }

  it('exposes the provider rules through ALL_PATTERNS (so detectSecrets uses them)', () => {
    expect(PROVIDER_PATTERNS.length).toBeGreaterThanOrEqual(25)
  })

  describe('false-positive guards — ordinary strings must NOT match any provider rule', () => {
    const providerIds = new Set(PROVIDER_PATTERNS.map((p) => p.rule_id))
    const BENIGN: Array<[string, string]> = [
      ['a UUID', '550e8400-e29b-41d4-a716-446655440000'],
      ['a git SHA', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
      ['plain prose', 'the quick brown fox jumps over the lazy dog 12 times'],
      ['a base64 data blob', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAA'],
      ['a hex color + number', 'background #ff00aa width 1024px margin 32'],
      ['a long file path', '/usr/local/lib/python3.11/site-packages/somepkg/module.py'],
    ]
    for (const [label, text] of BENIGN) {
      it(`${label} triggers no provider rule`, () => {
        const providerHits = detectSecrets(text).filter((d) => providerIds.has(d.rule_id))
        expect(providerHits, `unexpected provider hits: ${JSON.stringify(providerHits.map((h) => h.rule_id))}`).toHaveLength(0)
      })
    }
  })
})
