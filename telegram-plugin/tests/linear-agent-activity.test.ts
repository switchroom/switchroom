import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  emitLinearAgentActivity,
  buildLinearAuthDeadMessage,
  type LinearTokenResult,
} from '../gateway/linear-activity.js'

/**
 * Tests for the `linear_agent_activity` MCP tool (#2298).
 *
 * Structural part: assert the tool is declared in bridge/bridge.ts and
 * allow-listed + dispatched in gateway/gateway.ts (the gateway IIFE can't be
 * imported in a test, so wiring is verified by reading the source — same
 * constraint as gateway-request-secret.test.ts).
 *
 * Behavioural part: the activity-emit logic lives in gateway/linear-activity.ts
 * with injectable token-resolver + fetch, so the happy path and the
 * vault-denied path are exercised without a broker or the network.
 */

const okToken = (token: string) => async (): Promise<LinearTokenResult> => ({ ok: true, token })

function fakeFetch(status: number, jsonBody: unknown): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('linear_agent_activity — gateway wiring (#2298)', () => {
  const gw = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../bridge/bridge.ts', import.meta.url), 'utf8')

  it('declares the MCP tool with required {agent_session_id,type}', () => {
    const idx = bridge.indexOf(`name: 'linear_agent_activity'`)
    expect(idx).toBeGreaterThan(0)
    const schema = bridge.slice(idx, idx + 2000)
    expect(schema).toMatch(/required: \['agent_session_id', 'type'\]/)
    expect(schema).toMatch(/thought/)
    expect(schema).toMatch(/complete/)
  })

  it('is allow-listed and dispatched', () => {
    expect(gw).toMatch(/'linear_agent_activity',/)
    expect(gw).toMatch(/case 'linear_agent_activity':\s*\n\s*return executeLinearAgentActivity\(args\)/)
  })
})

describe('emitLinearAgentActivity — behaviour (#2298)', () => {
  it('POSTs an agentActivityCreate mutation on the happy path', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { data: { agentActivityCreate: { success: true } } })
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess_1', type: 'thought', body: 'On it.' },
      { agent: 'carrie', resolveToken: okToken('lin_tok'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/emitted on session sess_1/)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.linear.app/graphql')
    const sent = JSON.parse(calls[0].init!.body as string)
    expect(sent.query).toMatch(/agentActivityCreate/)
    expect(sent.variables.input.agentSessionId).toBe('sess_1')
    expect(sent.variables.input.content).toEqual({ type: 'thought', body: 'On it.' })
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe('lin_tok')
  })

  it('allows complete with no body', async () => {
    const { fetchImpl } = fakeFetch(200, { data: { agentActivityCreate: { success: true } } })
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess_2', type: 'complete' },
      { agent: 'carrie', resolveToken: okToken('lin_tok'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/complete emitted/)
  })

  it('requires body for thought/message/error', async () => {
    await expect(
      emitLinearAgentActivity(
        { agent_session_id: 'sess_3', type: 'message' },
        { resolveToken: okToken('t'), log: () => {} },
      ),
    ).rejects.toThrow(/body is required/)
  })

  it('rejects an unknown type', async () => {
    await expect(
      emitLinearAgentActivity(
        { agent_session_id: 'sess_4', type: 'banana', body: 'x' },
        { resolveToken: okToken('t'), log: () => {} },
      ),
    ).rejects.toThrow(/type must be one of/)
  })

  it('returns vault_request_access guidance when the token is denied', async () => {
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess_5', type: 'thought', body: 'hi' },
      {
        agent: 'carrie',
        resolveToken: async () => ({ ok: false, reason: 'denied' }),
        log: () => {},
      },
    )
    expect(r.content[0].text).toMatch(/vault_request_access/)
    expect(r.content[0].text).toMatch(/linear\/carrie\/token/)
  })

  it('surfaces a Linear API error status', async () => {
    const { fetchImpl } = fakeFetch(401, { error: 'bad token' })
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess_6', type: 'thought', body: 'hi' },
      { agent: 'carrie', resolveToken: okToken('lin_tok'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/Linear API 401/)
  })
})

import { serializeBundle, type RefreshIO } from '../../src/linear/oauth-refresh.js'

/** fetch fake routing by URL: the GraphQL endpoint 401s on the first hit then
 *  200s; the OAuth token endpoint returns a fresh token. Records the
 *  Authorization header per call so we can prove the retry used the new token. */
function refreshAwareFetch(opts: { tokenStatus?: number; tokenBody?: unknown } = {}) {
  const calls: Array<{ url: string; auth?: string }> = []
  let graphqlHits = 0
  const fetchImpl = (async (url: string, init: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization
    calls.push({ url, auth })
    if (url.includes('/oauth/token')) {
      const status = opts.tokenStatus ?? 200
      const body = opts.tokenBody ?? { access_token: 'lin_fresh', refresh_token: 'rt_new', expires_in: 86400 }
      return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) } as unknown as Response
    }
    graphqlHits++
    if (graphqlHits === 1) {
      return { ok: false, status: 401, json: async () => ({}), text: async () => 'unauthorized' } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({ data: { agentActivityCreate: { success: true } } }), text: async () => '' } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function fakeRefreshIO(): { io: RefreshIO; writes: { token?: string; bundle?: string } } {
  const writes: { token?: string; bundle?: string } = {}
  const io: RefreshIO = {
    readBundle: async () => serializeBundle({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt_old', expiresAt: 0 }),
    writeToken: async (t) => { writes.token = t },
    writeBundle: async (j) => { writes.bundle = j },
  }
  return { io, writes }
}

describe('linear_agent_activity — auto-refresh on 401 (#2298 durability)', () => {
  it('refreshes the app token on a 401 and retries once with the fresh token', async () => {
    const { fetchImpl, calls } = refreshAwareFetch()
    const { io, writes } = fakeRefreshIO()
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess', type: 'thought', body: 'hi' },
      { agent: 'carrie', resolveToken: okToken('lin_expired'), fetchImpl, refreshIO: () => io, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/emitted/)
    // The refresh wrote the new access token; the GraphQL retry used it.
    expect(writes.token).toBe('lin_fresh')
    const graphqlAuths = calls.filter((c) => c.url.includes('/graphql')).map((c) => c.auth)
    expect(graphqlAuths).toEqual(['lin_expired', 'lin_fresh'])
  })

  it('a revoked refresh token surfaces the 401 (one retry, no loop) and logs REVOKED', async () => {
    const { fetchImpl } = refreshAwareFetch({ tokenStatus: 400, tokenBody: 'invalid_grant' })
    const { io } = fakeRefreshIO()
    const logs: string[] = []
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess', type: 'thought', body: 'hi' },
      { agent: 'carrie', resolveToken: okToken('lin_dead'), fetchImpl, refreshIO: () => io, log: (s) => logs.push(s) },
    )
    expect(r.content[0].text).toMatch(/Linear API 401/)
    expect(logs.join('')).toMatch(/REVOKED/)
  })

  it('no 401 → no refresh attempt (happy path unchanged)', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { data: { agentActivityCreate: { success: true } } })
    let refreshBuilt = false
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess', type: 'message', body: 'ok' },
      { agent: 'carrie', resolveToken: okToken('lin_good'), fetchImpl, refreshIO: () => { refreshBuilt = true; return fakeRefreshIO().io }, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/emitted/)
    expect(refreshBuilt).toBe(false)
    expect(calls.length).toBe(1)
  })
})

/** RefreshIO whose bundle is absent → performLinearRefresh returns no_bundle
 *  (the silent-setup-failure case clerk/carrie hit in prod). */
function noBundleRefreshIO(): RefreshIO {
  return { readBundle: async () => null, writeToken: async () => {}, writeBundle: async () => {} }
}

describe('emitLinearAgentActivity — operator alert when auth is unrecoverable (FIX 1)', () => {
  it('no refresh bundle → onAuthUnrecoverable(no_bundle) fires', async () => {
    const { fetchImpl } = refreshAwareFetch()
    const alerts: Array<{ agent: string; reason: string }> = []
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess', type: 'thought', body: 'hi' },
      {
        agent: 'clerk',
        resolveToken: okToken('lin_expired'),
        fetchImpl,
        refreshIO: () => noBundleRefreshIO(),
        log: () => {},
        onAuthUnrecoverable: (i) => alerts.push(i),
      },
    )
    expect(r.content[0].text).toMatch(/Linear API 401/)
    expect(alerts).toEqual([{ agent: 'clerk', reason: 'no_bundle', detail: expect.any(String) }])
  })

  it('revoked refresh token → onAuthUnrecoverable(revoked) fires', async () => {
    const { fetchImpl } = refreshAwareFetch({ tokenStatus: 400, tokenBody: 'invalid_grant' })
    const alerts: Array<{ agent: string; reason: string }> = []
    await emitLinearAgentActivity(
      { agent_session_id: 'sess', type: 'thought', body: 'hi' },
      { agent: 'carrie', resolveToken: okToken('lin_dead'), fetchImpl, refreshIO: () => fakeRefreshIO().io, log: () => {}, onAuthUnrecoverable: (i) => alerts.push(i) },
    )
    expect(alerts.map((a) => a.reason)).toEqual(['revoked'])
  })

  it('transient refresh failure (HTTP 500) does NOT page the operator', async () => {
    const { fetchImpl } = refreshAwareFetch({ tokenStatus: 500, tokenBody: 'upstream boom' })
    const alerts: unknown[] = []
    await emitLinearAgentActivity(
      { agent_session_id: 'sess', type: 'thought', body: 'hi' },
      { agent: 'carrie', resolveToken: okToken('lin_x'), fetchImpl, refreshIO: () => fakeRefreshIO().io, log: () => {}, onAuthUnrecoverable: (i) => alerts.push(i) },
    )
    expect(alerts).toEqual([])
  })

  it('buildLinearAuthDeadMessage: no_bundle names the missing oauth key + re-auth command', () => {
    const msg = buildLinearAuthDeadMessage('clerk', 'no_bundle')
    expect(msg).toMatch(/Linear auth needs you/)
    expect(msg).toContain('`linear/clerk/oauth`')
    expect(msg).toContain('switchroom linear-agent setup --agent clerk')
  })

  it('buildLinearAuthDeadMessage: revoked says the refresh token was revoked', () => {
    const msg = buildLinearAuthDeadMessage('carrie', 'revoked')
    expect(msg).toMatch(/refresh token was revoked/)
    expect(msg).not.toContain('/oauth</code> is missing')
  })

  it('buildLinearAuthDeadMessage: markdown-escapes a hostile agent slug in prose (#2669)', () => {
    // < > & are literal in rich markdown; an emphasis special is escaped so it
    // can't break out of the **…** bold run.
    const msg = buildLinearAuthDeadMessage('a_b*c', 'no_bundle')
    expect(msg).toContain('**a\\_b\\*c**')
    // Inside the `code span`, the slug is literal (no escaping).
    expect(msg).toContain('`linear/a_b*c/oauth`')
  })

  it('successful auto-refresh does NOT page the operator', async () => {
    const { fetchImpl } = refreshAwareFetch()
    const alerts: unknown[] = []
    const r = await emitLinearAgentActivity(
      { agent_session_id: 'sess', type: 'thought', body: 'hi' },
      { agent: 'carrie', resolveToken: okToken('lin_expired'), fetchImpl, refreshIO: () => fakeRefreshIO().io, log: () => {}, onAuthUnrecoverable: (i) => alerts.push(i) },
    )
    expect(r.content[0].text).toMatch(/emitted/)
    expect(alerts).toEqual([])
  })
})
