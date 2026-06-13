import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  emitLinearAgentActivity,
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
    expect(gw).toMatch(/'linear_agent_activity',\n\]\)/)
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
