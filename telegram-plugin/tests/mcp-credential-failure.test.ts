/**
 * mcp-credential-failure.test.ts — outcome tests for "a paid MCP dependency's
 * key is blocked → Ken gets ONE hard warning".
 *
 * THE GAP. Perplexity (and Eraser, Brevo, Postiz, Meta/Google Ads, Cloudflare)
 * reach switchroom over the MCP TOOL surface, never through LiteLLM. So the
 * operator-event path that PR A fixed for an OpenRouter 402 never sees them: an
 * expired Perplexity key surfaced as an ordinary red step in the live feed and
 * died there. Nobody was told the fleet had lost a paid capability.
 *
 * These assert the OBSERVABLE RESULT at the gateway seam, composing the SAME
 * production functions in the SAME order `handleSessionEvent` →
 * `noteMcpDependencyFailure` → `emitGatewayOperatorEvent` calls them:
 * McpFailureWatcher.onToolUse/onToolResult → renderMcpFailureDetail →
 * renderOperatorEvent → decideOperatorEventAudience →
 * renderUserFacingFailureNotice.
 *
 * The three guarantees the brief names, each asserted end-to-end:
 *   1. a credential-class MCP failure produces EXACTLY ONE operator alert with
 *      the provider, the vault key NAME, the agents and the action;
 *   2. a second agent failing the same way inside the window produces NO
 *      second alert;
 *   3. an ordinary tool error (bad query, 404, timeout, transient 429)
 *      produces NONE.
 */

import { describe, it, expect } from 'vitest'
import {
  McpFailureWatcher,
  McpFailureLedger,
  classifyMcpFailure,
  parseMcpServerFromToolName,
  renderMcpFailureDetail,
  RENOTIFY_MS,
  type McpFailureAlert,
} from '../mcp-credential-failure.js'
import {
  renderOperatorEvent,
  decideOperatorEventAudience,
  isOperatorActionableKind,
  renderUserFacingFailureNotice,
  type OperatorEvent,
} from '../operator-events.js'

// ── Verbatim vendor failure bodies ──────────────────────────────────────────

/** Perplexity, key revoked / rejected. */
const PPLX_401 =
  '{"error":{"message":"Invalid API key provided.","type":"authentication_error","code":401}}'

/** Perplexity, balance spent — 401 status, but the remedy is "top up". */
const PPLX_NO_CREDIT =
  'api.perplexity.ai responded with status 401: {"detail":"insufficient credits — please add funds to your account"}'

/**
 * Perplexity, hard monthly wall. Note the status is 429 — the SAME status as a
 * transient throttle — so only the wording can tell the two apart, which is
 * exactly why 429 is not in the quota rule's status list.
 */
const PPLX_QUOTA =
  '{"error":{"message":"Monthly quota exceeded for your plan. Upgrade your plan to continue.","code":429}}'

// ── Ordinary failures that must stay SILENT ─────────────────────────────────

const ORDINARY_FAILURES: ReadonlyArray<[string, string]> = [
  ['a bad query', 'Error: search query must not be empty'],
  ['a 404', 'Request failed with status code 404: not found'],
  ['a timeout', 'Error: ETIMEDOUT — request to api.perplexity.ai timed out after 30000ms'],
  ['a transient throttle', '{"error":{"message":"Rate limit exceeded, retry after 2s","code":429}}'],
  ['a transport reset', 'Error: socket hang up (ECONNRESET)'],
  ['an upstream 5xx', 'Request failed with status code 503: service unavailable'],
  ['no results', 'The search returned no results for that query.'],
]

const ALLOW = ['7000000001' /* operator */, '7000000002' /* end user */]
const T0 = Date.UTC(2026, 6, 28, 10, 0, 0)

/**
 * One agent's gateway, driven exactly as `handleSessionEvent` drives it. The
 * `alerts` array is what `emitGatewayOperatorEvent` would have been called with.
 */
function makeAgent(agent: string, watcher: McpFailureWatcher) {
  const alerts: McpFailureAlert[] = []
  let seq = 0
  return {
    alerts,
    /** Drive one full MCP tool call that fails with `errorText`. */
    fail(toolName: string, errorText: string, now: number): void {
      const toolUseId = `toolu_${agent}_${seq++}`
      watcher.onToolUse(toolUseId, toolName)
      const alert = watcher.onToolResult({ toolUseId, isError: true, errorText, agent, now })
      if (alert != null) alerts.push(alert)
    },
    /** A successful call — must never alert. */
    succeed(toolName: string, now: number): void {
      const toolUseId = `toolu_${agent}_${seq++}`
      watcher.onToolUse(toolUseId, toolName)
      const alert = watcher.onToolResult({ toolUseId, isError: false, agent, now })
      if (alert != null) alerts.push(alert)
    },
  }
}

/** What the operator and a non-operator user actually receive for one alert. */
function route(alert: McpFailureAlert): {
  operatorText: string | null
  operatorChats: string[]
  userText: string | null
  userChats: string[]
  buttons: string[]
} {
  const ev: OperatorEvent = {
    kind: 'mcp-dependency-blocked',
    agent: alert.agents[0] ?? 'agent',
    detail: renderMcpFailureDetail(alert),
    suggestedActions: [],
    firstSeenAt: new Date(T0),
  }
  const rendered = renderOperatorEvent(ev)
  const { operatorChats, userNoticeChats } = decideOperatorEventAudience(ev.kind, ALLOW, ALLOW[0])
  return {
    operatorText: operatorChats.length > 0 ? rendered.text : null,
    operatorChats,
    userText: userNoticeChats.length > 0 ? renderUserFacingFailureNotice() : null,
    userChats: userNoticeChats,
    buttons: rendered.keyboard.inline_keyboard.flat().map(b => b.text),
  }
}

describe('a blocked Perplexity key raises exactly one operator alert', () => {
  it('produces ONE alert naming provider, vault key NAME, agent and action', () => {
    const w = new McpFailureWatcher()
    const klanker = makeAgent('klanker', w)

    klanker.fail('mcp__perplexity__perplexity_search', PPLX_401, T0)

    expect(klanker.alerts).toHaveLength(1)
    const alert = klanker.alerts[0]
    expect(alert.server).toBe('perplexity')
    expect(alert.cls).toBe('credential')
    expect(alert.agents).toEqual(['klanker'])
    expect(alert.renotify).toBe(false)

    const r = route(alert)

    // Operator-only: the kind is actionable, so the user gets the brief notice.
    expect(isOperatorActionableKind('mcp-dependency-blocked')).toBe(true)
    expect(r.operatorChats).toEqual(['7000000001'])
    expect(r.userChats).toEqual(['7000000002'])

    // The card says what Ken can actually DO.
    expect(r.operatorText).toContain('Perplexity')
    expect(r.operatorText).toContain('perplexity/api-key') // vault key NAME
    expect(r.operatorText).toContain('https://www.perplexity.ai/settings/api')
    expect(r.operatorText).toContain('klanker')
    expect(r.operatorText).toContain('Re-issue the key')
    expect(r.buttons).toEqual(['❌ Dismiss'])

    // NEVER a secret value, and never the raw provider error.
    expect(r.operatorText).not.toContain('Invalid API key provided')
    expect(r.operatorText).not.toMatch(/pplx-[A-Za-z0-9]/)

    // The end user still sees only the diagnosis-free notice.
    expect(r.userText).toBe(renderUserFacingFailureNotice())
    for (const fragment of ['perplexity', '401', 'api key', 'authentication_error', 'vault']) {
      expect(r.userText!.toLowerCase()).not.toContain(fragment)
    }
  })

  it('routes a spent BALANCE to "top up", not to "re-issue the key"', () => {
    const w = new McpFailureWatcher()
    const a = makeAgent('klanker', w)
    a.fail('mcp__perplexity__perplexity_ask', PPLX_NO_CREDIT, T0)
    expect(a.alerts).toHaveLength(1)
    // 401 status, but the credit wording must win — the key is fine, the
    // account is empty, and re-issuing it would waste the operator's time.
    expect(a.alerts[0].cls).toBe('credit')
    expect(route(a.alerts[0]).operatorText).toContain('Top up the balance')
  })

  it('sees a hard wall wrapped in throttle language (429 + "rate limit")', () => {
    // Providers routinely dress a monthly wall up as a rate limit. The wall is
    // the real news; silencing it as a throttle would lose the capability
    // quietly, which is the exact failure this whole feature exists to stop.
    const w = new McpFailureWatcher()
    const a = makeAgent('klanker', w)
    a.fail(
      'mcp__perplexity__perplexity_search',
      'Rate limit exceeded — monthly quota exceeded for your plan (429)',
      T0,
    )
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0].cls).toBe('quota')
  })

  it('routes a hard usage wall to the quota remedy', () => {
    const w = new McpFailureWatcher()
    const a = makeAgent('klanker', w)
    a.fail('mcp__perplexity__perplexity_research', PPLX_QUOTA, T0)
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0].cls).toBe('quota')
    expect(route(a.alerts[0]).operatorText).toContain('Raise the plan limit')
  })
})

describe('deduplication — a storm of failures is one alert, not a storm of alerts', () => {
  it('a second agent failing the same way in the window produces NO second alert', () => {
    // One shared watcher stands in for one gateway process seeing several
    // agents/sub-agents; the cross-CONTAINER limit is documented in the module.
    const w = new McpFailureWatcher()
    const klanker = makeAgent('klanker', w)
    const scribe = makeAgent('scribe', w)

    klanker.fail('mcp__perplexity__perplexity_search', PPLX_401, T0)
    scribe.fail('mcp__perplexity__perplexity_ask', PPLX_401, T0 + 1_000)
    klanker.fail('mcp__perplexity__perplexity_search', PPLX_401, T0 + 30_000)

    expect(klanker.alerts).toHaveLength(1)
    expect(scribe.alerts).toHaveLength(0)
  })

  it('re-notifies after the 6h house cadence, and NAMES everyone seen since', () => {
    const w = new McpFailureWatcher()
    const klanker = makeAgent('klanker', w)
    const scribe = makeAgent('scribe', w)

    klanker.fail('mcp__perplexity__perplexity_search', PPLX_401, T0)
    expect(klanker.alerts).toHaveLength(1)

    // Silent for the whole window, however many failures land.
    scribe.fail('mcp__perplexity__perplexity_ask', PPLX_401, T0 + RENOTIFY_MS - 1)
    expect(scribe.alerts).toHaveLength(0)

    // At the boundary it fires again, accumulating everyone seen meanwhile.
    scribe.fail('mcp__perplexity__perplexity_ask', PPLX_401, T0 + RENOTIFY_MS)
    expect(scribe.alerts).toHaveLength(1)
    const repeat = scribe.alerts[0]
    expect(repeat.renotify).toBe(true)
    expect(repeat.agents).toEqual(['scribe'])
    expect(repeat.occurrences).toBe(2)
    expect(route(repeat).operatorText).toContain('still failing')
  })

  it('matches the house re-notify cadence used by the hindsight watcher', () => {
    expect(RENOTIFY_MS).toBe(6 * 60 * 60 * 1000)
  })

  it('tracks credit and credential walls on the same server independently', () => {
    const led = new McpFailureLedger()
    expect(led.note({ server: 'perplexity', agent: 'a', cls: 'credential', now: T0 })).not.toBeNull()
    // A different failure CLASS is a different problem with a different remedy,
    // so it must not be silenced by the first one's window.
    expect(led.note({ server: 'perplexity', agent: 'a', cls: 'credit', now: T0 })).not.toBeNull()
  })
})

describe('ordinary tool failures never page the operator', () => {
  for (const [label, body] of ORDINARY_FAILURES) {
    it(`stays silent for ${label}`, () => {
      const w = new McpFailureWatcher()
      const a = makeAgent('klanker', w)
      a.fail('mcp__perplexity__perplexity_search', body, T0)
      expect(a.alerts).toEqual([])
      expect(classifyMcpFailure(body)).toBe('ordinary')
    })
  }

  it('stays silent for a SUCCESSFUL MCP call', () => {
    const w = new McpFailureWatcher()
    const a = makeAgent('klanker', w)
    a.succeed('mcp__perplexity__perplexity_search', T0)
    expect(a.alerts).toEqual([])
  })

  it('stays silent for a non-MCP tool that fails with auth-shaped text', () => {
    // A Bash step printing "401 unauthorized" from some unrelated curl is NOT
    // a fleet capability loss and must not page anyone.
    const w = new McpFailureWatcher()
    const a = makeAgent('klanker', w)
    a.fail('Bash', 'curl: server returned status 401 unauthorized', T0)
    expect(a.alerts).toEqual([])
  })
})

describe('the rule is data, and it generalises past Perplexity', () => {
  it('derives the server from any mcp__<server>__<tool> name', () => {
    expect(parseMcpServerFromToolName('mcp__perplexity__perplexity_search')).toBe('perplexity')
    expect(parseMcpServerFromToolName('mcp__meta-ads__list_campaigns')).toBe('meta-ads')
    expect(parseMcpServerFromToolName('Read')).toBeNull()
    expect(parseMcpServerFromToolName(undefined)).toBeNull()
  })

  it('covers other paid dependencies with no new code — Eraser, Brevo', () => {
    const w = new McpFailureWatcher()
    const a = makeAgent('klanker', w)
    a.fail('mcp__eraser__create_diagram', '403 Forbidden: api key has been revoked', T0)
    a.fail('mcp__brevo__send_email', '{"code":"unauthorized","message":"Key not found"}', T0)
    expect(a.alerts.map(x => x.server)).toEqual(['eraser', 'brevo'])
    expect(route(a.alerts[0]).operatorText).toContain('eraser/api-key')
    expect(route(a.alerts[1]).operatorText).toContain('brevo/api-key')
  })

  it('an unregistered MCP server still alerts, with a conventional key name', () => {
    const w = new McpFailureWatcher()
    const a = makeAgent('klanker', w)
    a.fail('mcp__somenewthing__do_it', '401 unauthorized: invalid api key', T0)
    expect(a.alerts).toHaveLength(1)
    expect(a.alerts[0].vaultKey).toBe('somenewthing/api-key')
  })
})
