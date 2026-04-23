import { describe, it, expect } from 'vitest'
import {
  detectViaSecretlint,
  detectSecretsAsync,
} from '../secret-detect/index.js'

describe('secretlint-source.detectViaSecretlint', () => {
  it('catches a realistic-looking Slack bot token', async () => {
    const text = 'Slack: xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'
    const hits = await detectViaSecretlint(text)
    expect(hits.length).toBeGreaterThan(0)
    const slack = hits.find((h) => h.rule_id.includes('slack'))
    expect(slack).toBeDefined()
    expect(slack!.confidence).toBe('high')
    expect(slack!.suppressed).toBe(false)
    // rule_id normalized from @secretlint/secretlint-rule-slack → secretlint_slack
    expect(slack!.rule_id).toMatch(/^secretlint_/)
    expect(slack!.rule_id).toContain('slack')
    // Matched text should be the actual token bytes.
    expect(slack!.matched_text.startsWith('xoxb-')).toBe(true)
    // Slug derived from rule_id + date (rule_id fallback path).
    expect(slack!.suggested_slug).toMatch(/^secretlint_slack_\d{8}/)
  })

  it('catches a GitHub personal access token', async () => {
    const text = 'token=ghp_16C7e42F292c6912E7710c838347Ae178B4a rest of message'
    const hits = await detectViaSecretlint(text)
    const gh = hits.find((h) => h.rule_id.includes('github'))
    expect(gh).toBeDefined()
    expect(gh!.confidence).toBe('high')
    expect(gh!.matched_text.startsWith('ghp_')).toBe(true)
    expect(gh!.rule_id).toContain('github')
  })

  it('catches an NPM access token', async () => {
    const text = 'NPM_TOKEN=npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    const hits = await detectViaSecretlint(text)
    const npm = hits.find((h) => h.rule_id.includes('npm'))
    expect(npm).toBeDefined()
    expect(npm!.confidence).toBe('high')
    expect(npm!.matched_text.startsWith('npm_')).toBe(true)
  })

  it('returns empty for empty input', async () => {
    expect(await detectViaSecretlint('')).toEqual([])
  })

  it('returns empty for text with no secrets', async () => {
    expect(await detectViaSecretlint('hello how are you today')).toEqual([])
  })

  it('marks nearby test/mock markers as suppressed', async () => {
    const text = 'test example: xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'
    const hits = await detectViaSecretlint(text)
    const slack = hits.find((h) => h.rule_id.includes('slack'))
    expect(slack).toBeDefined()
    expect(slack!.suppressed).toBe(true)
  })
})

describe('detectSecretsAsync merge', () => {
  it('merges Secretlint hits with vendored pattern hits, deduped by range', async () => {
    // Slack token that matches both the vendored anchored pattern AND Secretlint.
    const text = 'a xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx end'
    const hits = await detectSecretsAsync(text)
    // One entry for the Slack token — not two. Vendored wins on ties.
    const slackHits = hits.filter(
      (h) => h.matched_text.startsWith('xoxb-'),
    )
    expect(slackHits).toHaveLength(1)
    // Vendored rule id wins on exact-range ties (listed first in merge).
    expect(slackHits[0]!.rule_id).toBe('slack_token')
  })

  it('adds Secretlint-only hits for providers the vendored list misses', async () => {
    // Shopify is covered by Secretlint preset-recommend but not by our
    // vendored ANCHORED_PATTERNS.
    const text = 'SHOPIFY=shpss_1234567890abcdef1234567890abcdef and go'
    const hits = await detectSecretsAsync(text)
    const shopify = hits.find((h) => h.matched_text.startsWith('shpss_'))
    expect(shopify).toBeDefined()
    expect(shopify!.rule_id).toMatch(/secretlint_shopify/)
  })

  it('produces unique slugs across the merged detection list', async () => {
    const text =
      'tok1=ghp_16C7e42F292c6912E7710c838347Ae178B4a' +
      ' and tok2=xoxb-1234567890-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'
    const hits = await detectSecretsAsync(text)
    const slugs = hits.map((h) => h.suggested_slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})
