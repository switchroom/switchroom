/**
 * provider-credit-402.test.ts — outcome tests for the OpenRouter/OpenAI/
 * Perplexity credit-error leak.
 *
 * THE BUG (audited 2026-07-28). OpenRouter answers an exhausted balance with
 * HTTP 402 `payment_required` / "insufficient credits". None of switchroom's
 * quota/credit wordings matched it — every one of them was an ANTHROPIC
 * wording — so `classifyClaudeError` fell through to `unknown-4xx`.
 * `unknown-4xx` is NOT in `OPERATOR_ACTIONABLE_KINDS`, so
 * `decideOperatorEventAudience` broadcast it to EVERY allowlist chat: an end
 * user got a card carrying the raw vendor error in a code span and a "🔐
 * Reauth" button they cannot act on. That violates Ken's standing rule that an
 * operator-actionable error must never reach an end user.
 *
 * These assert the OBSERVABLE RESULT, composing the SAME production functions
 * in the SAME order `emitGatewayOperatorEvent` (gateway.ts ~:8134-8290) calls
 * them — classify → resolveModelUnavailableFromOperatorEvent → render →
 * decideOperatorEventAudience → renderUserFacingFailureNotice — so a
 * regression anywhere along that chain fails here:
 *
 *   1. a real OpenRouter 402 body produces an OPERATOR card, and
 *   2. the text a non-operator user sees is the brief plain-language notice,
 *      carrying NO raw error text, NO vendor name, NO status code.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyClaudeError,
  renderOperatorEvent,
  decideOperatorEventAudience,
  isOperatorActionableKind,
  renderUserFacingFailureNotice,
  type OperatorEvent,
} from '../operator-events.js'
import { resolveModelUnavailableFromOperatorEvent } from '../model-unavailable.js'
import { parseLlmError, isActionableKind } from '../llm-error-present.js'
import { attributeProvider, detectProviderCreditExhaustion } from '../provider-credit.js'

// ── Verbatim vendor shapes (docs verified 2026-07-28) ───────────────────────

/**
 * OpenRouter through LiteLLM. Wording per
 * https://openrouter.ai/docs/api-reference/errors — 402, typed code
 * `payment_required`, "insufficient credits. Add more credits and retry".
 */
const OPENROUTER_402 =
  'litellm.APIError: OpenrouterException - {"error":{"code":402,"message":"Your account or API key has insufficient credits. Add more credits and retry the request.","metadata":{"provider_name":"openrouter"}}}'

/** The per-key variant: the ACCOUNT has money, the key's `limit_remaining` is spent. */
const OPENROUTER_402_PER_KEY =
  'openrouter.ai returned 402: This request requires more credits, or fewer max_tokens.'

/**
 * OpenAI's exhausted balance. NOTE the status is 429, not 402
 * (https://platform.openai.com/docs/guides/error-codes) — the case that makes
 * "just match 402" insufficient.
 */
const OPENAI_INSUFFICIENT_QUOTA =
  'litellm.RateLimitError: OpenAIException - {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}} (api.openai.com)'

/** A genuine ANTHROPIC credit wall — must keep its own kind and its own card. */
const ANTHROPIC_CREDIT =
  '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Claude API."}}'

/** An ordinary transient 429 — must NOT be dragged into the credit class. */
const PLAIN_RATE_LIMIT =
  '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}'

const ALLOW = ['5000000001' /* operator */, '5000000002' /* end user */, '5000000003']

function makeEvent(detail: string): OperatorEvent {
  const kind = classifyClaudeError({ message: detail, type: detail })
  return {
    kind,
    agent: 'klanker',
    detail,
    suggestedActions: [],
    firstSeenAt: new Date('2026-07-28T10:00:00Z'),
  }
}

/**
 * The gateway's observable outcome for one error string: what the OPERATOR
 * sees and what a NON-OPERATOR user sees. Composed from the same production
 * functions, in the gateway's order (gateway.ts ~:8134-8290).
 */
function route(detail: string): {
  kind: string
  firedFleetFailover: boolean
  operatorText: string | null
  operatorChats: string[]
  userText: string | null
  userChats: string[]
} {
  const ev = makeEvent(detail)
  // The gateway renders the "⚠️ Model unavailable" card AND fires
  // fireFleetAutoFallback iff this resolves to a quota_exhausted detection.
  const mu = resolveModelUnavailableFromOperatorEvent(ev)
  const firedFleetFailover = mu?.kind === 'quota_exhausted'
  const { operatorChats, userNoticeChats } = decideOperatorEventAudience(
    ev.kind,
    ALLOW,
    ALLOW[0],
  )
  return {
    kind: ev.kind,
    firedFleetFailover,
    operatorText: operatorChats.length > 0 ? renderOperatorEvent(ev).text : null,
    operatorChats,
    userText: userNoticeChats.length > 0 ? renderUserFacingFailureNotice() : null,
    userChats: userNoticeChats,
  }
}

describe('OpenRouter 402 — the end-user leak is closed', () => {
  it('produces an OPERATOR card and gives the user only the brief notice', () => {
    const r = route(OPENROUTER_402)

    // 1. Classified as the operator-only provider-credit kind.
    expect(r.kind).toBe('provider-credit-exhausted')
    expect(isOperatorActionableKind('provider-credit-exhausted')).toBe(true)

    // 2. The full card goes to the OPERATOR ONLY.
    expect(r.operatorChats).toEqual(['5000000001'])
    expect(r.userChats).toEqual(['5000000002', '5000000003'])

    // 3. The operator card is actionable and provider-correct.
    expect(r.operatorText).toContain('OpenRouter')
    expect(r.operatorText).toContain('openrouter/api-key') // vault key NAME
    expect(r.operatorText).toContain('https://openrouter.ai/credits')

    // 4. THE LEAK ASSERTION: nothing an end user receives carries the raw
    //    vendor error, the vendor name, or the status code.
    expect(r.userText).toBe(renderUserFacingFailureNotice())
    for (const fragment of [
      'insufficient credits',
      'OpenRouter',
      'openrouter',
      '402',
      'payment_required',
      'litellm',
      'api key',
    ]) {
      expect(r.userText!.toLowerCase()).not.toContain(fragment.toLowerCase())
    }
  })

  it('never advertises an Anthropic remedy — /auth cannot buy OpenRouter credit', () => {
    const { operatorText } = route(OPENROUTER_402)
    // The `credit-exhausted` (Anthropic) card's recommendation sentence must
    // not appear — the card may only NAME `/auth use` to rule it OUT.
    expect(operatorText).not.toContain('Use `/auth use <label>`')
    expect(operatorText).not.toContain('/auth add')
    expect(operatorText).toContain('`/auth use` will NOT fix this')
    // and no re-auth button: the key is valid, it is out of money
    const rendered = renderOperatorEvent(makeEvent(OPENROUTER_402))
    const buttons = rendered.keyboard.inline_keyboard.flat().map(b => b.text)
    expect(buttons).toEqual(['❌ Dismiss'])
    expect(JSON.stringify(rendered.keyboard)).not.toContain('reauth')
  })

  it('does NOT fire an Anthropic fleet failover (nothing about Anthropic is exhausted)', () => {
    expect(route(OPENROUTER_402).firedFleetFailover).toBe(false)
    expect(route(OPENROUTER_402_PER_KEY).firedFleetFailover).toBe(false)
  })

  it('covers the per-key credit-limit variant, not just a zero account balance', () => {
    const r = route(OPENROUTER_402_PER_KEY)
    expect(r.kind).toBe('provider-credit-exhausted')
    expect(r.userChats.length).toBe(2)
    expect(r.userText).toBe(renderUserFacingFailureNotice())
  })
})

describe('OpenAI + Perplexity have the same gap and are covered', () => {
  it('OpenAI insufficient_quota (HTTP 429!) is a credit wall, not a transient throttle', () => {
    const r = route(OPENAI_INSUFFICIENT_QUOTA)
    expect(r.kind).toBe('provider-credit-exhausted')
    expect(r.operatorText).toContain('OpenAI')
    expect(r.operatorText).toContain('openai/api-key')
    // The bug this guards: 429 wording routing to "Rate limited … will retry
    // automatically", which is false — nothing retries a spent balance.
    expect(r.operatorText).not.toContain('Will retry automatically')
    expect(r.userChats.length).toBe(2)
  })

  it('attributes a Perplexity balance error to the Perplexity console + key name', () => {
    const entry = attributeProvider('api.perplexity.ai responded 401: insufficient credits')
    expect(entry?.id).toBe('perplexity')
    expect(entry?.vaultKey).toBe('perplexity/api-key')
    expect(detectProviderCreditExhaustion('api.perplexity.ai: insufficient credits')).not.toBeNull()
  })
})

describe('no collateral damage to the Anthropic paths', () => {
  it('an Anthropic credit-balance wall keeps its own kind and its slot-switch remedy', () => {
    const r = route(ANTHROPIC_CREDIT)
    expect(r.kind).toBe('credit-exhausted')
    expect(r.operatorText).toContain('/auth use')
  })

  it('an ordinary rate limit is untouched — still broadcast, still transient', () => {
    const r = route(PLAIN_RATE_LIMIT)
    expect(r.kind).toBe('rate-limited')
    expect(r.operatorChats).toEqual(ALLOW)
    expect(r.userChats).toEqual([])
  })

  it('a bare "402" substring in unrelated text is NOT a credit wall', () => {
    // model ids, token counts and request ids routinely contain "402".
    expect(detectProviderCreditExhaustion('model=gpt-402-turbo request_id=req_402x')).toBeNull()
    expect(classifyClaudeError({ message: 'timeout after 402 ms', type: '' })).not.toBe(
      'provider-credit-exhausted',
    )
  })

  it('a structured HTTP 402 status is honoured even with no recognisable wording', () => {
    expect(classifyClaudeError({ message: 'upstream refused', status: 402 })).toBe(
      'provider-credit-exhausted',
    )
  })
})

describe('the user-facing LLM error surface', () => {
  it('renders a diagnosis-free one-liner, never the raw 402 body', () => {
    const parsed = parseLlmError(OPENROUTER_402)
    expect(parsed.kind).toBe('provider_credit')
    expect(parsed.providerId).toBe('openrouter')
    expect(parsed.coreText).toBe(
      'An upstream model provider is out of credit — the operator has been notified.',
    )
    expect(parsed.coreText).not.toContain('402')
    expect(parsed.coreText).not.toContain('insufficient credits')
    // Never claim a retry will fix it — a spent balance does not self-heal.
    expect(parsed.coreText).not.toContain('retrying automatically')
    expect(parsed.terminal).toBe(true)
    expect(parsed.autoRetrying).toBe(false)
  })

  it('is always-actionable, so a dedup window can never silence it', () => {
    expect(isActionableKind('provider_credit')).toBe(true)
  })
})
