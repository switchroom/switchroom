/**
 * Linear AgentActivity emission (#2298).
 *
 * The `linear_agent_activity` MCP tool lets an agent that was woken by a
 * Linear agent session respond with structured activities (thought /
 * message / complete / error) that Linear renders as status chips + a
 * timeline on the issue. This module owns the pure logic — token
 * resolution + the `agentActivityCreate` GraphQL POST — behind injectable
 * deps so it is testable without a vault broker or the network. The
 * gateway wires it into `executeToolCall`.
 *
 * The agent's Linear app token is resolved from the vault under
 * `linear/<agent>/token` via the broker (never an inline literal, never an
 * env file). On a vault denial the tool returns actionable text telling the
 * agent to `vault_request_access` for that key rather than failing opaquely.
 */

import {
  getViaBrokerStructured,
  readVaultTokenFile,
} from '../../src/vault/broker/client.js'

export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql'

export type LinearTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'denied' | 'unreachable' | 'not_found' | 'unknown' }

export interface LinearActivityDeps {
  /** Resolve the Linear app token for `agent` from the vault. */
  resolveToken?: (agent: string) => Promise<LinearTokenResult>
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch
  /** Agent slug (defaults to SWITCHROOM_AGENT_NAME). */
  agent?: string
  /** Log sink — stderr in production. */
  log?: (line: string) => void
}

export type ToolTextResult = { content: Array<{ type: string; text: string }> }

/** Default token resolver: vault broker get on `linear/<agent>/token`. */
export async function defaultResolveLinearToken(agent: string): Promise<LinearTokenResult> {
  const key = `linear/${agent}/token`
  const token = readVaultTokenFile(agent) ?? undefined
  const result = await getViaBrokerStructured(key, token ? { token } : {})
  if (result.kind === 'ok' && result.entry.kind === 'string') {
    return { ok: true, token: result.entry.value }
  }
  if (result.kind === 'unreachable') return { ok: false, reason: 'unreachable' }
  if (result.kind === 'not_found') return { ok: false, reason: 'not_found' }
  if (result.kind === 'denied') return { ok: false, reason: 'denied' }
  return { ok: false, reason: 'unknown' }
}

/**
 * Emit a Linear AgentActivity. Validates args, resolves the token, POSTs
 * the `agentActivityCreate` mutation, and returns an MCP text result. Never
 * throws on a vault/network failure — returns actionable error text so the
 * agent can recover (e.g. via vault_request_access).
 */
export async function emitLinearAgentActivity(
  args: Record<string, unknown>,
  deps: LinearActivityDeps = {},
): Promise<ToolTextResult> {
  const log = deps.log ?? ((s) => process.stderr.write(s))

  const sessionId = args.agent_session_id as string | undefined
  if (!sessionId) throw new Error('linear_agent_activity: agent_session_id is required')
  const type = args.type as string | undefined
  if (!type || !['thought', 'message', 'complete', 'error'].includes(type)) {
    throw new Error('linear_agent_activity: type must be one of thought|message|complete|error')
  }
  const body = args.body as string | undefined
  if (type !== 'complete' && (body == null || body === '')) {
    throw new Error(`linear_agent_activity: body is required for type='${type}'`)
  }

  const agent = deps.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? '-'
  const resolveToken = deps.resolveToken ?? defaultResolveLinearToken
  const tokenResult = await resolveToken(agent)
  if (!tokenResult.ok) {
    if (tokenResult.reason === 'denied' || tokenResult.reason === 'not_found') {
      return {
        content: [
          {
            type: 'text',
            text:
              `linear_agent_activity failed: no Linear token (vault ${tokenResult.reason}). ` +
              `Call vault_request_access for key 'linear/${agent}/token' (scope read), then retry.`,
          },
        ],
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: `linear_agent_activity failed: vault broker ${tokenResult.reason} resolving 'linear/${agent}/token'.`,
        },
      ],
    }
  }

  // AgentActivity content discriminated by type. thought/message/error carry
  // a body; complete is terminal with an optional summary body.
  const content: Record<string, unknown> = { type }
  if (body != null && body !== '') content.body = body

  const mutation =
    'mutation AgentActivityCreate($input: AgentActivityCreateInput!) { ' +
    'agentActivityCreate(input: $input) { success agentActivity { id } } }'
  const variables = { input: { agentSessionId: sessionId, content } }

  const fetchImpl = deps.fetchImpl ?? fetch
  let resp: Response
  try {
    resp = await fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: tokenResult.token,
      },
      body: JSON.stringify({ query: mutation, variables }),
    })
  } catch (err) {
    return {
      content: [{ type: 'text', text: `linear_agent_activity failed: request error: ${(err as Error).message}` }],
    }
  }

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    return {
      content: [
        { type: 'text', text: `linear_agent_activity failed: Linear API ${resp.status}${txt ? ` — ${txt.slice(0, 200)}` : ''}` },
      ],
    }
  }

  let json: { data?: { agentActivityCreate?: { success?: boolean } }; errors?: Array<{ message?: string }> }
  try {
    json = (await resp.json()) as typeof json
  } catch {
    return { content: [{ type: 'text', text: 'linear_agent_activity failed: malformed Linear API response' }] }
  }
  if (json.errors && json.errors.length > 0) {
    return {
      content: [
        { type: 'text', text: `linear_agent_activity failed: ${json.errors.map((e) => e.message ?? 'error').join('; ').slice(0, 300)}` },
      ],
    }
  }
  if (json.data?.agentActivityCreate?.success === false) {
    return { content: [{ type: 'text', text: 'linear_agent_activity failed: Linear reported success=false' }] }
  }

  log(`telegram gateway: linear_agent_activity: emitted type=${type} session=${sessionId} agent=${agent}\n`)
  return { content: [{ type: 'text', text: `Linear ${type} emitted on session ${sessionId}` }] }
}
