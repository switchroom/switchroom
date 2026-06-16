import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runLinearAgentSetup } from '../gateway/linear-setup.js'

/**
 * Tests for the `linear_agent_setup` MCP tool (FIX 2 — in-container,
 * operator-approved Linear OAuth provisioning).
 *
 * Structural: assert the tool is declared in bridge.ts and allow-listed +
 * dispatched in gateway.ts (the gateway IIFE can't be imported).
 * Behavioural: the logic lives in gateway/linear-setup.ts with injected
 * fetch + broker-put deps, so the OAuth exchange + write paths run offline.
 */

type PutOutcome = { kind: 'ok' } | { kind: 'denied'; msg: string } | { kind: 'not_found'; msg: string } | { kind: 'unreachable'; msg: string }

function exchangeFetch(opts: { status?: number; body?: unknown } = {}): typeof fetch {
  return (async () => {
    const status = opts.status ?? 200
    const body = opts.body ?? { access_token: 'lin_acc', refresh_token: 'lin_ref', expires_in: 86400, scope: 'read write' }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response
  }) as unknown as typeof fetch
}

describe('linear_agent_setup — wiring', () => {
  const gw = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../bridge/bridge.ts', import.meta.url), 'utf8')

  it('declares the MCP tool with an action enum', () => {
    const idx = bridge.indexOf(`name: 'linear_agent_setup'`)
    expect(idx).toBeGreaterThan(0)
    const schema = bridge.slice(idx, idx + 1600)
    expect(schema).toMatch(/authorize_url/)
    expect(schema).toMatch(/complete/)
    expect(schema).toMatch(/client_id/)
  })

  it('is allow-listed and dispatched', () => {
    expect(gw).toMatch(/'linear_agent_setup',/)
    expect(gw).toMatch(/case 'linear_agent_setup':\s*\n\s*return executeLinearAgentSetup\(args\)/)
  })
})

describe('runLinearAgentSetup — authorize_url', () => {
  it('returns the actor=app authorize URL', async () => {
    const r = await runLinearAgentSetup(
      { action: 'authorize_url', client_id: 'cid', redirect_uri: 'http://localhost:3000/callback' },
      { agent: 'clerk', log: () => {} },
    )
    expect(r.content[0].text).toContain('https://linear.app/oauth/authorize?')
    expect(r.content[0].text).toContain('actor=app')
    expect(r.content[0].text).toContain('client_id=cid')
  })

  it('rejects a non-http redirect_uri', async () => {
    const r = await runLinearAgentSetup(
      { action: 'authorize_url', client_id: 'cid', redirect_uri: 'not-a-url' },
      { agent: 'clerk', log: () => {} },
    )
    expect(r.content[0].text).toMatch(/redirect_uri is required and must be an http/)
  })
})

describe('runLinearAgentSetup — complete', () => {
  const base = { action: 'complete', client_id: 'cid', client_secret: 'sec', redirect_uri: 'http://localhost:3000/callback', code: 'auth_code' }

  it('exchanges the code and writes bundle THEN token', async () => {
    const writes: Array<{ which: string; value: string }> = []
    const r = await runLinearAgentSetup(base, {
      agent: 'clerk',
      fetchImpl: exchangeFetch(),
      putBundle: async (_a, j) => { writes.push({ which: 'bundle', value: j }); return { kind: 'ok' } },
      putToken: async (_a, t) => { writes.push({ which: 'token', value: t }); return { kind: 'ok' } },
      log: () => {},
    })
    expect(writes.map((w) => w.which)).toEqual(['bundle', 'token']) // bundle first
    expect(writes[1].value).toBe('lin_acc')
    const storedBundle = JSON.parse(writes[0].value)
    expect(storedBundle).toMatchObject({ client_id: 'cid', client_secret: 'sec', refresh_token: 'lin_ref' })
    expect(r.content[0].text).toMatch(/stored for clerk/)
    expect(r.content[0].text).toMatch(/config_propose_edit/)
  })

  it('bad authorization code → re-authorize guidance, no writes', async () => {
    let wrote = false
    const r = await runLinearAgentSetup(base, {
      agent: 'clerk',
      fetchImpl: exchangeFetch({ status: 400, body: 'invalid_grant' }),
      putBundle: async () => { wrote = true; return { kind: 'ok' } },
      putToken: async () => { wrote = true; return { kind: 'ok' } },
      log: () => {},
    })
    expect(wrote).toBe(false)
    expect(r.content[0].text).toMatch(/Re-run action "authorize_url"/)
  })

  it('vault has no write-grant (UNKNOWN_KEY) → write-grant guidance', async () => {
    const r = await runLinearAgentSetup(base, {
      agent: 'clerk',
      fetchImpl: exchangeFetch(),
      putBundle: async () => ({ kind: 'not_found', msg: 'Key not found' }),
      putToken: async () => ({ kind: 'ok' }),
      log: () => {},
    })
    expect(r.content[0].text).toMatch(/vault_request_access/)
    expect(r.content[0].text).toContain('linear/clerk/oauth')
    expect(r.content[0].text).toContain('linear/clerk/token')
  })

  it('requires client_secret and code', async () => {
    const r1 = await runLinearAgentSetup({ ...base, client_secret: undefined }, { agent: 'clerk', log: () => {} })
    expect(r1.content[0].text).toMatch(/client_secret is required/)
    const r2 = await runLinearAgentSetup({ ...base, code: undefined }, { agent: 'clerk', log: () => {} })
    expect(r2.content[0].text).toMatch(/code .*is required/)
  })

  it('never lets a write failure strand a half-provisioned state (token write fails → guidance)', async () => {
    const r = await runLinearAgentSetup(base, {
      agent: 'clerk',
      fetchImpl: exchangeFetch(),
      putBundle: async () => ({ kind: 'ok' }),
      putToken: async () => ({ kind: 'denied', msg: 'scope-allow' }),
      log: () => {},
    })
    expect(r.content[0].text).toMatch(/vault_request_access/)
  })
})
