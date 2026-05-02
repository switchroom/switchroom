/**
 * Unit tests for the webhook signature verifiers (#577).
 *
 * Coverage targets:
 *   - verifyGithubSignature: valid, missing header, wrong format,
 *     malformed hex, signature mismatch, no secret configured.
 *   - verifyBearerToken: valid, missing header, wrong scheme, length
 *     mismatch, token mismatch.
 *   - renderGithubEvent: covers the four known event types + the
 *     fallback shape; HTML-escapes user-controlled fields.
 *   - renderGenericEvent: title/message/text precedence + JSON
 *     fallback; source-name escape.
 */

import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import {
  verifyGithubSignature,
  verifyBearerToken,
  renderGithubEvent,
  renderGenericEvent,
} from '../src/web/webhook-verify.js'

const SECRET = 'this-is-a-shared-secret'

function githubSig(body: Uint8Array, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

describe('verifyGithubSignature', () => {
  const body = new TextEncoder().encode('{"ping":"pong"}')

  it('accepts a valid signature', () => {
    const r = verifyGithubSignature(body, githubSig(body, SECRET), SECRET)
    expect(r.ok).toBe(true)
  })

  it('rejects missing signature header', () => {
    const r = verifyGithubSignature(body, undefined, SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'no-signature-header' })
  })

  it('rejects wrong format (no sha256= prefix)', () => {
    const r = verifyGithubSignature(body, 'not-a-real-prefix', SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'wrong-signature-format' })
  })

  it('rejects malformed hex', () => {
    const r = verifyGithubSignature(body, 'sha256=NOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNOTH', SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'malformed-hex' })
  })

  it('rejects a signature signed with a different secret', () => {
    const r = verifyGithubSignature(body, githubSig(body, 'wrong-secret'), SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'signature-mismatch' })
  })

  it('rejects a tampered body (signature was for original)', () => {
    const tampered = new TextEncoder().encode('{"ping":"different"}')
    const r = verifyGithubSignature(tampered, githubSig(body, SECRET), SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'signature-mismatch' })
  })

  it('rejects when no secret is configured (defense in depth)', () => {
    const r = verifyGithubSignature(body, githubSig(body, SECRET), '')
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'no-secret-configured' })
  })
})

describe('verifyBearerToken', () => {
  it('accepts a valid Bearer token', () => {
    const r = verifyBearerToken('Bearer ' + SECRET, SECRET)
    expect(r.ok).toBe(true)
  })

  it('rejects missing header', () => {
    const r = verifyBearerToken(null, SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'no-auth-header' })
  })

  it('rejects wrong auth scheme', () => {
    const r = verifyBearerToken('Basic ' + Buffer.from('user:pass').toString('base64'), SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'wrong-auth-scheme' })
  })

  it('rejects token of wrong length (constant-time guard)', () => {
    const r = verifyBearerToken('Bearer too-short', SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'length-mismatch' })
  })

  it('rejects token of correct length but wrong content', () => {
    const wrong = SECRET.split('').reverse().join('')
    const r = verifyBearerToken('Bearer ' + wrong, SECRET)
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'token-mismatch' })
  })

  it('rejects when no secret is configured', () => {
    const r = verifyBearerToken('Bearer ' + SECRET, '')
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ ok: false, reason: 'no-secret-configured' })
  })
})

describe('renderGithubEvent', () => {
  const baseRepo = { repository: { full_name: 'switchroom/switchroom' }, sender: { login: 'mekenthompson' } }

  it('renders pull_request opened', () => {
    const r = renderGithubEvent('pull_request', {
      ...baseRepo,
      action: 'opened',
      pull_request: { number: 42, title: 'fix: thing', html_url: 'https://github.com/x/y/pull/42' },
    })
    expect(r.text).toContain('switchroom/switchroom')
    expect(r.text).toContain('PR #42 opened')
    expect(r.text).toContain('mekenthompson')
    expect(r.text).toContain('fix: thing')
    expect(r.disableLinkPreview).toBe(true)
  })

  it('renders issues event with action and number', () => {
    const r = renderGithubEvent('issues', {
      ...baseRepo,
      action: 'opened',
      issue: { number: 7, title: 'bug', html_url: 'https://x/y/issues/7' },
    })
    expect(r.text).toContain('issue #7 opened')
  })

  it('renders push with branch + commit count', () => {
    const r = renderGithubEvent('push', {
      ...baseRepo,
      ref: 'refs/heads/main',
      commits: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      compare: 'https://x/y/compare/abc...def',
    })
    expect(r.text).toContain('push to <code>main</code>')
    expect(r.text).toContain('3 commit(s)')
  })

  it('renders ping event', () => {
    const r = renderGithubEvent('ping', baseRepo)
    expect(r.text).toContain('webhook ping')
  })

  it('falls back for unknown event types', () => {
    const r = renderGithubEvent('star', baseRepo)
    expect(r.text).toContain('star by @mekenthompson')
  })

  it('HTML-escapes user-controlled fields', () => {
    const r = renderGithubEvent('issues', {
      repository: { full_name: 'org/<script>alert(1)</script>' },
      sender: { login: 'evil&user' },
      action: 'opened',
      issue: { number: 1, title: '<img src=x onerror=alert(1)>', html_url: 'https://example/' },
    })
    expect(r.text).not.toContain('<script>')
    expect(r.text).toContain('&lt;script&gt;')
    expect(r.text).toContain('evil&amp;user')
    expect(r.text).toContain('&lt;img')
  })
})

describe('renderGenericEvent', () => {
  it('uses payload.title when present', () => {
    const r = renderGenericEvent('sentry', { title: 'Error spike' })
    expect(r.text).toContain('Error spike')
    expect(r.text).toContain('sentry')
  })

  it('falls back to message when title absent', () => {
    const r = renderGenericEvent('alert', { message: 'oh no' })
    expect(r.text).toContain('oh no')
  })

  it('falls back to text when title and message absent', () => {
    const r = renderGenericEvent('alert', { text: 'urgent' })
    expect(r.text).toContain('urgent')
  })

  it('falls back to JSON snippet when nothing usable', () => {
    const r = renderGenericEvent('alert', { unknown_field: 42, other: ['a', 'b'] })
    expect(r.text).toContain('unknown_field')
  })

  it('truncates JSON fallback to 200 chars', () => {
    const big = { msg: 'x'.repeat(500) }
    const r = renderGenericEvent('alert', big)
    // The whole rendered message, including the source label and emoji,
    // should remain bounded.
    expect(r.text.length).toBeLessThan(300)
  })

  it('HTML-escapes source name and content', () => {
    const r = renderGenericEvent('<bad>', { title: '<bold>' })
    expect(r.text).not.toContain('<bad>')
    expect(r.text).toContain('&lt;bad&gt;')
    expect(r.text).toContain('&lt;bold&gt;')
  })
})
