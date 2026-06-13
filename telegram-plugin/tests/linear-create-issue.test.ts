import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createLinearIssue,
  captureDedupMarker,
  type LinearTokenResult,
} from '../gateway/linear-activity.js'

/**
 * Tests for the `linear_create_issue` MCP tool (#2312 — capture-on-reaction
 * → Linear).
 *
 * Structural part: assert the tool is declared in bridge/bridge.ts and
 * allow-listed + dispatched in gateway/gateway.ts (the gateway IIFE can't be
 * imported in a test, so wiring is verified by reading the source — same
 * constraint as linear-agent-activity.test.ts).
 *
 * Behavioural part: the create logic lives in gateway/linear-activity.ts with
 * an injectable token-resolver + fetch, so team auto-resolve, dedup, priority,
 * and the vault-denied path are exercised without a broker or the network.
 */

const okToken = (token: string) => async (): Promise<LinearTokenResult> => ({ ok: true, token })

/** A fake fetch that routes by GraphQL operation so a single test can answer
 *  the teams query, the searchIssues query, and the issueCreate mutation
 *  independently. Each handler returns the `data` payload. */
function routingFetch(handlers: {
  teams?: () => unknown
  searchIssues?: () => unknown
  issueCreate?: () => unknown
  status?: number
}): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; query: string; variables: Record<string, unknown>; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; query: string; variables: Record<string, unknown>; headers: Record<string, string> }> = []
  const status = handlers.status ?? 200
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const parsed = JSON.parse((init?.body as string) ?? '{}') as { query: string; variables: Record<string, unknown> }
    calls.push({
      url,
      query: parsed.query,
      variables: parsed.variables,
      headers: (init?.headers as Record<string, string>) ?? {},
    })
    let data: unknown = {}
    if (parsed.query.includes('teams')) data = handlers.teams?.() ?? {}
    else if (parsed.query.includes('searchIssues')) data = handlers.searchIssues?.() ?? {}
    else if (parsed.query.includes('issueCreate')) data = handlers.issueCreate?.() ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data }),
      text: async () => JSON.stringify({ data }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const oneTeam = () => ({ teams: { nodes: [{ id: 'team_1', key: 'ENG', name: 'Engineering' }] } })
const issueOk = () => ({ issueCreate: { success: true, issue: { id: 'i1', identifier: 'ENG-42', url: 'https://linear.app/acme/issue/ENG-42' } } })

describe('linear_create_issue — gateway wiring (#2312)', () => {
  const gw = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../bridge/bridge.ts', import.meta.url), 'utf8')

  it('declares the MCP tool with required {title,body}', () => {
    const idx = bridge.indexOf(`name: 'linear_create_issue'`)
    expect(idx).toBeGreaterThan(0)
    const schema = bridge.slice(idx, idx + 2500)
    expect(schema).toMatch(/required: \['title', 'body'\]/)
    expect(schema).toMatch(/dedup_key/)
    expect(schema).toMatch(/team_id/)
  })

  it('is allow-listed and dispatched', () => {
    expect(gw).toMatch(/'linear_create_issue',\n\]\)/)
    expect(gw).toMatch(/case 'linear_create_issue':\s*\n\s*return executeLinearCreateIssue\(args\)/)
  })
})

describe('createLinearIssue — behaviour (#2312)', () => {
  it('auto-resolves the single team and POSTs issueCreate (zero-config)', async () => {
    const { fetchImpl, calls } = routingFetch({ teams: oneTeam, issueCreate: issueOk })
    const r = await createLinearIssue(
      { title: 'Fix Brevo retries', body: 'They double-fire on sync.' },
      { agent: 'clerk', resolveToken: okToken('lin_tok'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toBe('Filed: Fix Brevo retries → https://linear.app/acme/issue/ENG-42')
    // teams query first, then issueCreate.
    expect(calls).toHaveLength(2)
    expect(calls[0].query).toMatch(/teams/)
    expect(calls[1].query).toMatch(/issueCreate/)
    expect(calls[1].variables.input).toMatchObject({ teamId: 'team_1', title: 'Fix Brevo retries' })
    // raw token, no Bearer prefix (Linear convention).
    expect(calls[1].headers.Authorization).toBe('lin_tok')
  })

  it('skips team resolution when team_id is passed', async () => {
    const { fetchImpl, calls } = routingFetch({ issueCreate: issueOk })
    const r = await createLinearIssue(
      { title: 'X', body: 'Y', team_id: 'team_explicit' },
      { agent: 'clerk', resolveToken: okToken('t'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/Filed:/)
    expect(calls).toHaveLength(1)
    expect(calls[0].query).toMatch(/issueCreate/)
    expect(calls[0].variables.input).toMatchObject({ teamId: 'team_explicit' })
  })

  it('passes priority through when provided', async () => {
    const { fetchImpl, calls } = routingFetch({ issueCreate: issueOk })
    await createLinearIssue(
      { title: 'X', body: 'Y', team_id: 't', priority: 1 },
      { resolveToken: okToken('t'), fetchImpl, log: () => {} },
    )
    expect((calls[0].variables.input as Record<string, unknown>).priority).toBe(1)
  })

  it('errors actionably when the workspace has multiple teams and none is given', async () => {
    const { fetchImpl } = routingFetch({
      teams: () => ({ teams: { nodes: [{ id: 'a', key: 'ENG', name: 'Engineering' }, { id: 'b', key: 'OPS', name: 'Operations' }] } }),
    })
    const r = await createLinearIssue(
      { title: 'X', body: 'Y' },
      { resolveToken: okToken('t'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/multiple teams/)
    expect(r.content[0].text).toMatch(/ENG \(Engineering\)/)
    expect(r.content[0].text).toMatch(/default_team_id/)
  })

  it('short-circuits to "Already filed" on a dedup hit', async () => {
    const { fetchImpl, calls } = routingFetch({
      searchIssues: () => ({ searchIssues: { nodes: [{ id: 'old', url: 'https://linear.app/acme/issue/ENG-7', title: 'prior' }] } }),
      teams: oneTeam,
      issueCreate: issueOk,
    })
    const r = await createLinearIssue(
      { title: 'X', body: 'Y', dedup_key: 'chat:99' },
      { resolveToken: okToken('t'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toBe('Already filed: https://linear.app/acme/issue/ENG-7')
    // only the search ran — no team resolve, no create.
    expect(calls).toHaveLength(1)
    expect(calls[0].query).toMatch(/searchIssues/)
  })

  it('falls through to create when the dedup search misses, and embeds the marker', async () => {
    const { fetchImpl, calls } = routingFetch({
      searchIssues: () => ({ searchIssues: { nodes: [] } }),
      teams: oneTeam,
      issueCreate: issueOk,
    })
    const r = await createLinearIssue(
      { title: 'X', body: 'Y', dedup_key: 'chat:99' },
      { resolveToken: okToken('t'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/Filed:/)
    const create = calls.find((c) => c.query.includes('issueCreate'))!
    expect((create.variables.input as Record<string, unknown>).description).toContain(captureDedupMarker('chat:99'))
  })

  it('returns vault_request_access guidance when the token is denied', async () => {
    const r = await createLinearIssue(
      { title: 'X', body: 'Y' },
      { agent: 'clerk', resolveToken: async () => ({ ok: false, reason: 'denied' }), log: () => {} },
    )
    expect(r.content[0].text).toMatch(/Couldn't file to Linear: no token/)
    expect(r.content[0].text).toMatch(/vault_request_access/)
    expect(r.content[0].text).toMatch(/linear\/clerk\/token/)
  })

  it('requires a title', async () => {
    await expect(
      createLinearIssue({ body: 'Y' }, { resolveToken: okToken('t'), log: () => {} }),
    ).rejects.toThrow(/title is required/)
  })

  it('surfaces a Linear API error status', async () => {
    const { fetchImpl } = routingFetch({ teams: oneTeam, issueCreate: issueOk, status: 401 })
    const r = await createLinearIssue(
      { title: 'X', body: 'Y' },
      { resolveToken: okToken('t'), fetchImpl, log: () => {} },
    )
    expect(r.content[0].text).toMatch(/Linear API 401/)
  })
})
