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

import { escapeMarkdown } from '../format.js'
import {
  getViaBrokerStructured,
  putViaBroker,
  readVaultTokenFile,
} from '../../src/vault/broker/client.js'
import { performLinearRefresh, type RefreshIO } from '../../src/linear/oauth-refresh.js'

export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql'

/** The two operator-action reasons a Linear 401 can't self-heal. */
export type LinearAuthDeadReason = 'no_bundle' | 'revoked'

/** Minimal GFM-markdown escape (#2669). Kept local so the message builder is
 *  self-contained + unit-testable without reaching into a gateway-only
 *  escaper (the bug that shipped the first cut of this alert). */
/**
 * Build the operator-facing Telegram alert (GFM markdown) for an un-healable
 * Linear auth failure. Pure + self-escaping so it can be unit-tested directly.
 * The gateway's `notifyLinearAuthDead` only handles dedup + transport.
 */
export function buildLinearAuthDeadMessage(agent: string, reason: LinearAuthDeadReason): string {
  // Inside `code` spans the agent slug is literal (no escaping); in prose it
  // is markdown-escaped.
  const aEsc = escapeMarkdown(agent)
  const why =
    reason === 'no_bundle'
      ? `no refresh credentials are stored (\`linear/${agent}/oauth\` is missing), so its daily-expiring token can't renew`
      : `its Linear refresh token was revoked`
  return (
    `🔑 **Linear auth needs you**\n` +
    `**${aEsc}** can't reach Linear — ${why}. ` +
    `Its access token will keep failing until you re-authorize.\n\n` +
    `Re-auth (actor=app) then run \`switchroom linear-agent setup --agent ${agent} ` +
    `--token … --refresh-token … --client-id … --client-secret …\` on the host, ` +
    `or ask me to walk you through it.`
  )
}

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
  /** Build the RefreshIO used to auto-refresh on a 401 (tests inject a
   *  fake; production uses the broker-backed `brokerRefreshIO`). When
   *  omitted, on-401 refresh uses the broker. */
  refreshIO?: (agent: string) => RefreshIO
  /** Default Linear team id for captured issues (multi-team workspaces);
   *  defaults to SWITCHROOM_LINEAR_DEFAULT_TEAM_ID. Tests inject directly. */
  defaultTeamId?: string
  /** Log sink — stderr in production. */
  log?: (line: string) => void
  /** Invoked when a Linear 401 CANNOT self-heal because the situation needs
   *  an operator to act: `no_bundle` (no refresh credentials were ever
   *  stored — the silent-setup-failure case) or `revoked` (the refresh token
   *  itself is dead). The gateway wires this to a deduped operator-facing
   *  Telegram alert so a daily-expiring token stops failing invisibly. NOT
   *  called for transient reasons (network/http_error/bad_response) — those
   *  retry on their own. */
  onAuthUnrecoverable?: (info: { agent: string; reason: LinearAuthDeadReason; detail: string }) => void
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
 * Broker-backed RefreshIO: reads `linear/<agent>/oauth` and rotates both
 * `linear/<agent>/token` and the bundle via the broker `put` op (#950 — an
 * agent rotates keys it can already read, no operator passphrase, no host
 * round-trip). Requires `linear/<agent>/oauth` to be in the agent's ACL
 * (linear-agent setup adds it to `secrets[]`).
 */
export function brokerRefreshIO(agent: string, fetchImpl?: typeof fetch): RefreshIO {
  const token = readVaultTokenFile(agent) ?? undefined
  const opt = token ? { token } : {}
  return {
    readBundle: async () => {
      const r = await getViaBrokerStructured(`linear/${agent}/oauth`, opt)
      return r.kind === 'ok' && r.entry.kind === 'string' ? r.entry.value : null
    },
    writeToken: async (t) => {
      const r = await putViaBroker(`linear/${agent}/token`, { kind: 'string', value: t }, opt)
      if (r.kind !== 'ok') throw new Error(`broker put linear/${agent}/token: ${r.kind}`)
    },
    writeBundle: async (j) => {
      const r = await putViaBroker(`linear/${agent}/oauth`, { kind: 'string', value: j }, opt)
      if (r.kind !== 'ok') throw new Error(`broker put linear/${agent}/oauth: ${r.kind}`)
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  }
}

/**
 * POST to Linear's GraphQL endpoint; on a 401 (expired/invalid app token)
 * auto-refresh the token once via the stored refresh bundle and retry with
 * the fresh token. This is the durable self-heal: a Linear app token that
 * expired (~24h–30d) is silently rotated in-container on its next use rather
 * than failing the agent's turn. A `revoked` refresh token (the one case
 * needing operator re-auth) is logged loudly and the original 401 surfaces.
 *
 * Returns the final Response and the token in force (callers read the body).
 */
async function linearPostWithRefresh(
  body: string,
  token: string,
  agent: string,
  fetchImpl: typeof fetch,
  log: (s: string) => void,
  refreshIO?: (agent: string) => RefreshIO,
  onAuthUnrecoverable?: (info: { agent: string; reason: LinearAuthDeadReason; detail: string }) => void,
): Promise<{ resp: Response; token: string }> {
  const post = (t: string) =>
    fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: t },
      body,
    })

  let resp = await post(token)
  if (resp.status !== 401) return { resp, token }

  const io = (refreshIO ?? ((a) => brokerRefreshIO(a, fetchImpl)))(agent)
  const refreshed = await performLinearRefresh({ ...io, fetchImpl })
  if (!refreshed.ok) {
    if (refreshed.reason === 'revoked') {
      log(
        `telegram gateway: linear token REVOKED agent=${agent} — refresh token is dead; ` +
          `operator must re-authorize (linear-agent setup --refresh-token …)\n`,
      )
      onAuthUnrecoverable?.({ agent, reason: 'revoked', detail: refreshed.detail })
    } else if (refreshed.reason === 'no_bundle') {
      // No refresh bundle was ever stored (the silent-setup-failure case):
      // the access token expires ~daily and there is nothing to renew from.
      // This is invisible in the gateway log alone — surface it to the
      // operator so they can re-provision instead of the agent failing
      // every day forever.
      log(
        `telegram gateway: linear token DEAD agent=${agent} — no refresh bundle stored ` +
          `(linear/${agent}/oauth absent); operator must re-authorize\n`,
      )
      onAuthUnrecoverable?.({ agent, reason: 'no_bundle', detail: refreshed.detail })
    } else {
      // Transient (network / http_error / bad_response): retries on its own,
      // no operator action — log only, don't page.
      log(`telegram gateway: linear token refresh failed agent=${agent} reason=${refreshed.reason}\n`)
    }
    return { resp, token } // surface the original 401
  }
  log(`telegram gateway: linear token auto-refreshed agent=${agent} (was 401)\n`)
  resp = await post(refreshed.accessToken)
  return { resp, token: refreshed.accessToken }
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
    // Auto-refresh on a 401 (expired app token) and retry once — see
    // linearPostWithRefresh.
    ;({ resp } = await linearPostWithRefresh(
      JSON.stringify({ query: mutation, variables }),
      tokenResult.token,
      agent,
      fetchImpl,
      log,
      deps.refreshIO,
      deps.onAuthUnrecoverable,
    ))
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

/** The exact HTML-comment carrying a capture's dedup key. Both the embed
 *  (captureDedupMarker) and the dedup lookup match on this precise string, so a
 *  re-capture is confirmed by exact-key equality, not fuzzy search relevance.
 *  The trailing ` -->` and leading `: ` anchor the key so `abc` never matches
 *  `abcd`. */
export function captureDedupComment(dedupKey: string): string {
  return `<!-- switchroom-capture: ${dedupKey} -->`
}

/** Hidden marker appended to a captured issue's description so a re-capture of
 *  the same Telegram message can be detected (dedup backstop; the gateway-side
 *  seen-set is the primary, race-free guard). */
export function captureDedupMarker(dedupKey: string): string {
  return `\n\n${captureDedupComment(dedupKey)}`
}

/**
 * Create a Linear issue (capture-on-reaction → Linear). Mirrors
 * emitLinearAgentActivity: validates, resolves the agent's Linear app token,
 * POSTs `issueCreate`, returns an MCP text result; never throws on vault/
 * network failure. The issue is filed AS the agent's app actor.
 *
 * Team: Linear requires a teamId. If `team_id` is omitted we auto-resolve —
 * the zero-config single-team case uses the workspace's only team; a
 * multi-team workspace returns actionable text asking for an explicit team_id.
 *
 * Dedup: when `dedup_key` is given we (a) best-effort search for a prior
 * capture carrying the same marker and short-circuit to "already filed", and
 * (b) embed the marker in the new issue's description as a durable backstop.
 */
export async function createLinearIssue(
  args: Record<string, unknown>,
  deps: LinearActivityDeps = {},
): Promise<ToolTextResult> {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const fetchImpl = deps.fetchImpl ?? fetch

  const title = args.title as string | undefined
  if (!title || title.trim() === '') throw new Error('linear_create_issue: title is required')
  const body = (args.body as string | undefined) ?? ''
  // Explicit team_id wins; otherwise the operator's configured default team
  // (scaffold injects SWITCHROOM_LINEAR_DEFAULT_TEAM_ID for multi-team
  // workspaces); otherwise we auto-resolve below (zero-config single team).
  const teamIdArg =
    (args.team_id as string | undefined) ??
    (deps.defaultTeamId ?? process.env.SWITCHROOM_LINEAR_DEFAULT_TEAM_ID) ??
    undefined
  const dedupKey = (args.dedup_key as string | undefined) ?? undefined
  const priority = typeof args.priority === 'number' ? (args.priority as number) : undefined

  const agent = deps.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? '-'
  const resolveToken = deps.resolveToken ?? defaultResolveLinearToken
  const tokenResult = await resolveToken(agent)
  if (!tokenResult.ok) {
    const hint =
      tokenResult.reason === 'denied' || tokenResult.reason === 'not_found'
        ? ` Call vault_request_access for key 'linear/${agent}/token' (scope read), then retry.`
        : ''
    return {
      content: [
        { type: 'text', text: `Couldn't file to Linear: no token (vault ${tokenResult.reason}).${hint}` },
      ],
    }
  }
  // Mutable so a 401-triggered refresh on one gql call carries the fresh
  // token to subsequent calls in this issue-create flow.
  let activeToken = tokenResult.token

  const gql = async (query: string, variables: Record<string, unknown>): Promise<{ ok: true; data: any } | { ok: false; text: string }> => {
    let resp: Response
    try {
      const out = await linearPostWithRefresh(
        JSON.stringify({ query, variables }),
        activeToken,
        agent,
        fetchImpl,
        log,
        deps.refreshIO,
        deps.onAuthUnrecoverable,
      )
      resp = out.resp
      activeToken = out.token
    } catch (err) {
      return { ok: false, text: `request error: ${(err as Error).message}` }
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      return { ok: false, text: `Linear API ${resp.status}${txt ? ` — ${txt.slice(0, 200)}` : ''}` }
    }
    let json: { data?: any; errors?: Array<{ message?: string }> }
    try {
      json = (await resp.json()) as typeof json
    } catch {
      return { ok: false, text: 'malformed Linear API response' }
    }
    if (json.errors && json.errors.length > 0) {
      return { ok: false, text: json.errors.map((e) => e.message ?? 'error').join('; ').slice(0, 300) }
    }
    return { ok: true, data: json.data }
  }

  // Dedup backstop: search for a prior capture of the same Telegram message.
  // `searchIssues` is a relevance-ranked full-text search, so its top hit for a
  // key can be an unrelated issue that merely shares tokens. We therefore only
  // treat a result as a dedup match when its description carries the EXACT
  // capture marker for this key, never the raw top hit.
  if (dedupKey) {
    const marker = captureDedupComment(dedupKey)
    const search = await gql(
      'query($term: String!) { searchIssues(term: $term, first: 25) { nodes { id url title description } } }',
      { term: dedupKey },
    )
    if (search.ok) {
      const nodes = (search.data?.searchIssues?.nodes ?? []) as Array<{ url?: string; description?: string }>
      const hit = nodes.find((n) => typeof n.description === 'string' && n.description.includes(marker))
      if (hit?.url) {
        log(`telegram gateway: linear_create_issue: dedup hit key=${dedupKey} agent=${agent}\n`)
        return { content: [{ type: 'text', text: `Already filed: ${hit.url}` }] }
      }
    }
    // a failed search or no exact-marker match is non-fatal — fall through to
    // create (gateway seen-set is the primary, race-free guard).
  }

  // Resolve the team.
  let teamId = teamIdArg
  if (!teamId) {
    const teams = await gql('query { teams(first: 50) { nodes { id key name } } }', {})
    if (!teams.ok) {
      return { content: [{ type: 'text', text: `Couldn't file to Linear: ${teams.text}` }] }
    }
    const nodes = (teams.data?.teams?.nodes ?? []) as Array<{ id: string; key: string; name: string }>
    if (nodes.length === 0) {
      return { content: [{ type: 'text', text: 'Couldn\'t file to Linear: the workspace has no teams.' }] }
    }
    if (nodes.length > 1) {
      const list = nodes.map((t) => `${t.key} (${t.name})`).join(', ')
      return {
        content: [
          { type: 'text', text: `Couldn't file to Linear: multiple teams (${list}) — set a default team (linear_agent.default_team_id) or pass team_id.` },
        ],
      }
    }
    teamId = nodes[0].id
  }

  const description = dedupKey ? `${body}${captureDedupMarker(dedupKey)}` : body
  const input: Record<string, unknown> = { teamId, title, description }
  if (priority !== undefined) input.priority = priority

  const create = await gql(
    'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
    { input },
  )
  if (!create.ok) {
    return { content: [{ type: 'text', text: `Couldn't file to Linear: ${create.text}` }] }
  }
  const issue = create.data?.issueCreate?.issue as { identifier?: string; url?: string } | undefined
  if (create.data?.issueCreate?.success === false || !issue?.url) {
    return { content: [{ type: 'text', text: 'Couldn\'t file to Linear: issue not created (success=false).' }] }
  }

  log(`telegram gateway: linear_create_issue: filed ${issue.identifier} agent=${agent}${dedupKey ? ` dedup=${dedupKey}` : ''}\n`)
  return { content: [{ type: 'text', text: `Filed: ${title} → ${issue.url}` }] }
}
