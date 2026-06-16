/**
 * `linear_agent_setup` MCP tool — in-container, operator-approved Linear
 * `actor=app` OAuth provisioning (FIX 2).
 *
 * Background: `switchroom linear-agent setup` is host-only (it writes the
 * vault file directly with the operator passphrase). Run from inside an agent
 * container it silently no-ops — there is no mounted vault and no passphrase —
 * which is exactly how clerk/carrie ended up with an access token but no
 * refresh bundle (a daily 401 with no self-heal). This tool gives the agent a
 * sanctioned in-container path that uses ONLY operator-approved primitives:
 *
 *   1. `action: "authorize_url"` — pure. Returns the browser authorize URL the
 *      operator opens to consent. No side effects, no approval.
 *   2. `action: "complete"` — exchanges the `code` from the redirect for an
 *      access token + refresh token, then writes BOTH
 *      `linear/<agent>/token` (access) and `linear/<agent>/oauth` (the durable
 *      refresh bundle) via the broker. Creating these NEW keys requires a
 *      write-grant — `vault_request_access(scope: "write")` for each, which the
 *      operator approves. On a vault denial the tool returns the exact
 *      next-step text (mirrors `linear_agent_activity`'s vault_request_access
 *      guidance) rather than failing opaquely.
 *
 * The durable `secrets[]` ACL + the `linear_agent` config block are added by
 * the agent via `config_propose_edit` (also operator-approved) — see the
 * returned guidance and the self-service playbook. The secret VALUES never
 * pass through config (no leak); only the access token + bundle go to the
 * broker, and the OAuth client_secret/code are used in-process for the
 * exchange and never stored or logged.
 */

import { putViaBroker, readVaultTokenFile } from '../../src/vault/broker/client.js'
import {
  buildLinearAuthorizeUrl,
  exchangeLinearAuthCode,
  serializeBundle,
} from '../../src/linear/oauth-refresh.js'

export type ToolTextResult = { content: Array<{ type: string; text: string }> }

/** Result of a single broker put (new-key create). */
type PutOutcome = { kind: 'ok' } | { kind: 'denied'; msg: string } | { kind: 'not_found'; msg: string } | { kind: 'unreachable'; msg: string }

export interface LinearSetupDeps {
  /** Agent slug (defaults to SWITCHROOM_AGENT_NAME). */
  agent?: string
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch
  /** Write `linear/<agent>/token`. Defaults to a broker put. */
  putToken?: (agent: string, accessToken: string) => Promise<PutOutcome>
  /** Write `linear/<agent>/oauth` (the JSON bundle). Defaults to a broker put. */
  putBundle?: (agent: string, bundleJson: string) => Promise<PutOutcome>
  /** Log sink — stderr in production. NEVER receives secret values. */
  log?: (line: string) => void
}

const tokenKey = (agent: string) => `linear/${agent}/token`
const bundleKey = (agent: string) => `linear/${agent}/oauth`

/** Default broker put: path-as-identity + the agent's standing write-grant
 *  token (so a new key authorized by `vault_request_access(write)` can be
 *  created). Mirrors `brokerRefreshIO` in linear-activity.ts. */
function defaultPut(agent: string, key: string, value: string): Promise<PutOutcome> {
  const token = readVaultTokenFile(agent) ?? undefined
  const opt = token ? { token } : {}
  return putViaBroker(key, { kind: 'string', value }, opt).then((r) => {
    if (r.kind === 'ok') return { kind: 'ok' as const }
    if (r.kind === 'unreachable') return { kind: 'unreachable' as const, msg: r.msg }
    if (r.kind === 'not_found') return { kind: 'not_found' as const, msg: r.msg }
    return { kind: 'denied' as const, msg: r.msg }
  })
}

function text(s: string): ToolTextResult {
  return { content: [{ type: 'text', text: s }] }
}

/**
 * Guidance the agent shows the operator + itself after a write is blocked
 * because the key doesn't exist yet (no write-grant). This is the expected
 * first-run path: the operator approves the grant, then the agent retries.
 */
function writeGrantGuidance(agent: string): string {
  return (
    `I need write access to store the Linear credentials. Call:\n` +
    `• vault_request_access(key: "${tokenKey(agent)}", scope: "write", reason: "store Linear app access token")\n` +
    `• vault_request_access(key: "${bundleKey(agent)}", scope: "write", reason: "store Linear OAuth refresh bundle")\n` +
    `Once the operator approves both, re-run linear_agent_setup with action "complete" (same code is single-use — if it expired, re-open the authorize URL first).`
  )
}

/** Guidance for the durable config (ACL + linear_agent block) the agent emits
 *  after the values are stored, via the operator-approved config_propose_edit. */
function durableConfigGuidance(agent: string): string {
  return (
    `Stored. To make this durable (survive restarts + enable auto-refresh), propose a config edit ` +
    `(config_propose_edit) that, under agents.${agent}:\n` +
    `  • adds channels.telegram.linear_agent: { enabled: true, token: "vault:${tokenKey(agent)}" }\n` +
    `  • adds "${tokenKey(agent)}" and "${bundleKey(agent)}" to secrets[]\n` +
    `Then the operator approves it and you restart to pick up the linear_agent block.`
  )
}

/**
 * Run the `linear_agent_setup` tool. Validates args, performs the requested
 * step, and returns actionable MCP text. Never throws on a network/vault
 * failure — returns guidance the agent can act on.
 */
export async function runLinearAgentSetup(
  args: Record<string, unknown>,
  deps: LinearSetupDeps = {},
): Promise<ToolTextResult> {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const agent = deps.agent ?? process.env.SWITCHROOM_AGENT_NAME ?? '-'
  if (agent === '-' || !/^[a-z][a-z0-9_-]{0,63}$/.test(agent)) {
    return text(`linear_agent_setup failed: could not resolve a valid agent name (got '${agent}').`)
  }

  const action = args.action as string | undefined
  if (action !== 'authorize_url' && action !== 'complete') {
    return text(`linear_agent_setup failed: action must be "authorize_url" or "complete".`)
  }

  const clientId = (args.client_id as string | undefined)?.trim()
  const redirectUri = (args.redirect_uri as string | undefined)?.trim()
  if (!clientId) return text('linear_agent_setup failed: client_id is required.')
  if (!redirectUri || !/^https?:\/\//.test(redirectUri)) {
    return text('linear_agent_setup failed: redirect_uri is required and must be an http(s) URL registered on the Linear OAuth app.')
  }

  if (action === 'authorize_url') {
    const url = buildLinearAuthorizeUrl({ clientId, redirectUri })
    return text(
      `Open this URL in a browser to authorize <b>${agent}</b> as a Linear app actor (actor=app):\n\n${url}\n\n` +
        `After you approve, Linear redirects to ${redirectUri}?code=… (it may show a blank/error page — that's fine). ` +
        `Copy the code value from the URL bar, then run linear_agent_setup with action "complete", the same client_id + redirect_uri, ` +
        `your client_secret, and that code.`,
    )
  }

  // action === 'complete'
  const clientSecret = (args.client_secret as string | undefined)?.trim()
  const code = (args.code as string | undefined)?.trim()
  if (!clientSecret) return text('linear_agent_setup failed: client_secret is required for action "complete".')
  if (!code) return text('linear_agent_setup failed: code (from the redirect URL) is required for action "complete".')

  const exchanged = await exchangeLinearAuthCode(
    { clientId, clientSecret, code, redirectUri },
    deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
  )
  if (!exchanged.ok) {
    log(`telegram gateway: linear_agent_setup exchange failed agent=${agent} reason=${exchanged.reason}\n`)
    if (exchanged.reason === 'bad_code') {
      return text(
        `linear_agent_setup failed: Linear rejected the authorization code (expired, already used, or wrong redirect_uri). ` +
          `Re-run action "authorize_url", open the fresh URL, and copy a new code.`,
      )
    }
    return text(`linear_agent_setup failed: token exchange ${exchanged.reason} — ${exchanged.detail}. Retry shortly.`)
  }

  const bundle = serializeBundle({
    clientId,
    clientSecret,
    refreshToken: exchanged.refreshToken,
    expiresAt: exchanged.expiresAt,
  })

  const putBundle = deps.putBundle ?? ((a, j) => defaultPut(a, bundleKey(a), j))
  const putToken = deps.putToken ?? ((a, t) => defaultPut(a, tokenKey(a), t))

  // Write the bundle FIRST (same ordering rationale as performLinearRefresh:
  // never leave a fresh access token whose refresh bundle didn't persist).
  const b = await putBundle(agent, bundle)
  if (b.kind !== 'ok') {
    if (b.kind === 'not_found' || b.kind === 'denied') {
      return text(writeGrantGuidance(agent))
    }
    log(`telegram gateway: linear_agent_setup bundle write ${b.kind} agent=${agent}\n`)
    return text(`linear_agent_setup failed: couldn't store the refresh bundle (broker ${b.kind}: ${b.msg}).`)
  }
  const t = await putToken(agent, exchanged.accessToken)
  if (t.kind !== 'ok') {
    if (t.kind === 'not_found' || t.kind === 'denied') {
      return text(writeGrantGuidance(agent))
    }
    log(`telegram gateway: linear_agent_setup token write ${t.kind} agent=${agent}\n`)
    return text(`linear_agent_setup failed: couldn't store the access token (broker ${t.kind}: ${t.msg}).`)
  }

  const hours = Math.max(1, Math.round((exchanged.expiresAt - Date.now() / 1000) / 3600))
  log(`telegram gateway: linear_agent_setup stored token+bundle agent=${agent} (expires ~${hours}h)\n`)
  return text(
    `✅ Linear app token + refresh bundle stored for ${agent} (access token expires in ~${hours}h; it now auto-renews).\n\n` +
      durableConfigGuidance(agent),
  )
}
