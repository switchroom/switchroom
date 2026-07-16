/**
 * litellm-proxy-auth-misconfig.test.ts — outcome-asserting tests for Ken's
 * deterministic error-surfacing policy applied to the LiteLLM proxy-fallback
 * 401 incident (2026-07-16).
 *
 * Root cause: LiteLLM's internal fallback chain re-dispatched WITHOUT the
 * client's OAuth Authorization header onto a keyless `claude-sonnet-5`
 * deployment, so Anthropic returned 401 authentication_error "x-api-key header
 * is required". The gateway classifier mapped ANY authentication_error →
 * credentials-invalid → an always-rendered "🔑 re-authenticate" card that was
 * broadcast to EVERY allowlist chat — wrong audience (a non-operator user like
 * Lisa cannot re-auth) and wrong diagnosis (the login is fine).
 *
 * These assert OUTCOMES:
 *   1. the proxy 401 classifies as an operator-only infra fault, NEVER auth /
 *      credentials-invalid, and NEVER renders a re-auth card;
 *   2. a genuine credential expiry still classifies as credentials-expired and
 *      still reaches the operator;
 *   3. the audience router sends operator-actionable faults to the operator
 *      ONLY, and hands non-operator users a diagnosis-free plain-language
 *      notice — while the operator (allowlist head, incl. their own DM) always
 *      keeps the full card.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyClaudeError,
  renderOperatorEvent,
  decideOperatorEventAudience,
  isOperatorActionableKind,
  renderUserFacingFailureNotice,
  type OperatorEvent,
  type OperatorEventKind,
} from '../operator-events.js'
import { isLitellmProxyAuthMisconfig } from '../model-unavailable.js'
import { parseLlmError, renderLlmError } from '../llm-error-present.js'

// The verbatim shape Anthropic returns to the header-less proxy fallback.
const PROXY_401_MESSAGE =
  'litellm.AuthenticationError: AnthropicException - {"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"}} (fallback deployment claude-sonnet-5)'

function makeEvent(kind: OperatorEventKind, overrides?: Partial<OperatorEvent>): OperatorEvent {
  return {
    kind,
    agent: 'gymbro',
    detail: '',
    suggestedActions: [],
    firstSeenAt: new Date('2026-07-16T20:00:00Z'),
    ...overrides,
  }
}

describe('isLitellmProxyAuthMisconfig', () => {
  it('detects the definitive keyless-401 marker', () => {
    expect(isLitellmProxyAuthMisconfig(PROXY_401_MESSAGE)).toBe(true)
    expect(isLitellmProxyAuthMisconfig('x-api-key header is required')).toBe(true)
  })

  it('detects an authentication_error co-occurring with proxy/fallback provenance', () => {
    expect(
      isLitellmProxyAuthMisconfig(
        'litellm proxy fallback: authentication_error while routing to backup deployment',
      ),
    ).toBe(true)
  })

  it('does NOT down-classify a genuine Anthropic OAuth expiry', () => {
    expect(
      isLitellmProxyAuthMisconfig(
        'authentication_error: OAuth token has expired. Please run /login to refresh.',
      ),
    ).toBe(false)
    expect(isLitellmProxyAuthMisconfig('authentication_error: invalid bearer token')).toBe(false)
  })

  it('never throws on junk input', () => {
    expect(isLitellmProxyAuthMisconfig('')).toBe(false)
    // @ts-expect-error — deliberate wrong type
    expect(isLitellmProxyAuthMisconfig(null)).toBe(false)
  })
})

describe('classifyClaudeError — proxy 401 vs genuine credential faults', () => {
  it('classifies the proxy fallback 401 as proxy-misconfig, NOT credentials-invalid', () => {
    const kind = classifyClaudeError({
      type: 'authentication_error',
      status: 401,
      message: PROXY_401_MESSAGE,
    })
    expect(kind).toBe('proxy-misconfig')
    expect(kind).not.toBe('credentials-invalid')
    expect(kind).not.toBe('credentials-expired')
  })

  it('still classifies a genuine expired credential as credentials-expired', () => {
    const kind = classifyClaudeError({
      type: 'authentication_error',
      message: 'authentication_error: your OAuth token has expired, please refresh',
    })
    expect(kind).toBe('credentials-expired')
  })

  it('still classifies a bare invalid credential as credentials-invalid', () => {
    const kind = classifyClaudeError({
      type: 'authentication_error',
      message: 'authentication_error: credentials are not valid',
    })
    expect(kind).toBe('credentials-invalid')
  })
})

describe('renderOperatorEvent — proxy-misconfig card', () => {
  it('renders an operator infra card with NO re-auth button and NO login language', () => {
    const { text, keyboard } = renderOperatorEvent(makeEvent('proxy-misconfig', { detail: 'x-api-key header is required' }))
    // No re-auth instruction reaches the surface.
    expect(text.toLowerCase()).not.toContain('re-authenticate')
    expect(text.toLowerCase()).not.toContain('reauth')
    expect(text).toContain('misconfig')
    // Only a Dismiss button — never a Reauth callback.
    const callbacks = keyboard.inline_keyboard.flat().map((b) => b.callback_data ?? '')
    expect(callbacks.some((c) => c.startsWith('op:reauth:'))).toBe(false)
  })
})

describe('parseLlmError — proxy 401 never becomes the user-facing auth kind', () => {
  it('parses the proxy 401 as infra_misconfig (operator-only), source litellm-local', () => {
    const parsed = parseLlmError(PROXY_401_MESSAGE)
    expect(parsed.kind).toBe('infra_misconfig')
    expect(parsed.kind).not.toBe('auth')
    expect(parsed.source).toBe('litellm-local')
  })

  it('the rendered infra_misconfig line carries NO re-auth recommendation', () => {
    const parsed = parseLlmError(PROXY_401_MESSAGE)
    const { text } = renderLlmError(parsed, 'gymbro', 'UTC')
    expect(text.toLowerCase()).not.toContain('re-authenticate this account')
  })

  it('a genuine OAuth expiry still parses as the actionable auth kind', () => {
    const parsed = parseLlmError('authentication_error: OAuth token has expired, please refresh')
    expect(parsed.kind).toBe('auth')
  })
})

describe('decideOperatorEventAudience — Ken routing policy', () => {
  const allow = ['5000000001' /* operator */, '5000000002' /* Lisa */, '5000000003']

  it('routes the proxy misconfig to the operator ONLY; users get a plain notice', () => {
    const { operatorChats, userNoticeChats } = decideOperatorEventAudience(
      'proxy-misconfig',
      allow,
      allow[0],
    )
    expect(operatorChats).toEqual(['5000000001'])
    expect(userNoticeChats).toEqual(['5000000002', '5000000003'])
  })

  it('routes credentials-invalid / -expired / credit-exhausted to the operator ONLY', () => {
    for (const kind of ['credentials-invalid', 'credentials-expired', 'credit-exhausted'] as const) {
      const a = decideOperatorEventAudience(kind, allow, allow[0])
      expect(a.operatorChats).toEqual(['5000000001'])
      expect(a.userNoticeChats).toEqual(['5000000002', '5000000003'])
    }
  })

  it('preserves the operator DM: a lone-operator allowlist still gets the full card, no user notice', () => {
    const a = decideOperatorEventAudience('proxy-misconfig', ['5000000001'], '5000000001')
    expect(a.operatorChats).toEqual(['5000000001'])
    expect(a.userNoticeChats).toEqual([])
  })

  it('leaves non-operator-actionable kinds broadcasting to every allowlist chat', () => {
    for (const kind of ['rate-limited', 'unknown-5xx', 'agent-crashed', 'quota-exhausted'] as const) {
      const a = decideOperatorEventAudience(kind, allow, allow[0])
      expect(a.operatorChats).toEqual(allow)
      expect(a.userNoticeChats).toEqual([])
    }
  })

  it('isOperatorActionableKind gates exactly the credential/infra fault classes', () => {
    expect(isOperatorActionableKind('proxy-misconfig')).toBe(true)
    expect(isOperatorActionableKind('credentials-invalid')).toBe(true)
    expect(isOperatorActionableKind('credentials-expired')).toBe(true)
    expect(isOperatorActionableKind('credit-exhausted')).toBe(true)
    expect(isOperatorActionableKind('rate-limited')).toBe(false)
    expect(isOperatorActionableKind('quota-exhausted')).toBe(false)
  })
})

describe('renderUserFacingFailureNotice', () => {
  it('is a diagnosis-free, re-auth-free, byte-free plain-language notice', () => {
    const notice = renderUserFacingFailureNotice()
    const lower = notice.toLowerCase()
    expect(lower).not.toContain('re-auth')
    expect(lower).not.toContain('reauth')
    expect(lower).not.toContain('x-api-key')
    expect(lower).not.toContain('litellm')
    expect(lower).not.toContain('authentication_error')
    // Communicates "our side" honestly.
    expect(lower).toContain('our side')
  })
})
