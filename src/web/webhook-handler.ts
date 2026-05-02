/**
 * Webhook ingest route handler (#577). Sits in `src/web/server.ts`'s
 * fetch() before the bearer-token gate runs because webhooks bring
 * their own auth (HMAC for github, Bearer for generic).
 *
 * Path shape: `POST /webhook/:agent/:source`
 *   - `:agent` must match a known agent name in switchroom.yaml.
 *   - `:source` must be in that agent's `webhook_sources` allowlist.
 *
 * Response shape (always JSON):
 *   - 202 Accepted on verified + recorded.
 *   - 400 if the path / body / config is malformed.
 *   - 401 if the signature/token is invalid (no detail leaked).
 *   - 403 if the agent doesn't allow this source.
 *   - 404 if the agent name is unknown.
 *
 * MVP behavior (#577):
 *   - Verify signature.
 *   - Render to a structured Telegram-ready text via the renderers in
 *     `webhook-verify.ts`.
 *   - Append a JSON line to `~/.switchroom/agents/<agent>/telegram/webhook-events.jsonl`.
 *   - Log the receipt to stderr for operator visibility.
 *
 * Out of scope (deferred to a follow-up):
 *   - Posting the rendered text directly to the agent's Telegram
 *     topic via the bot. Needs bot-token resolution from vault and
 *     topic_id mapping from agent config; both adjacent surfaces
 *     better tackled in their own PR.
 *   - Triggering a fresh agent turn from the webhook. That requires
 *     gateway IPC integration and a "synthetic-user-message"
 *     envelope contract.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  verifyGithubSignature,
  verifyBearerToken,
  renderGithubEvent,
  renderGenericEvent,
  type WebhookSource,
} from './webhook-verify.js'

export interface WebhookConfig {
  /** Per-source secrets, declared in vault under
   *  `webhook/<agent>/<source>`. The verifier expects the secret as
   *  the operator typed it (no per-key encoding). */
  secrets: Partial<Record<WebhookSource, string>>
}

export interface WebhookHandlerDeps {
  /** Path resolver — overridable for tests. Production: agent dir
   *  under `~/.switchroom/agents/<agent>`. */
  resolveAgentDir?: (agent: string) => string
  /** Allow tests to inject a fixed clock for the recorded ts field. */
  now?: () => number
  /** Log sink — stderr in production. */
  log?: (line: string) => void
}

export interface WebhookHandlerArgs {
  agent: string
  source: string
  body: Uint8Array
  headers: Headers
  /** From switchroom.yaml: the agent's allowlist. Pass [] when no
   *  agent config exists; route returns 404 in that case. */
  allowedSources: readonly string[]
  /** Operator-configured secrets. */
  config: WebhookConfig
  /** True iff `agent` is a known agent in switchroom.yaml. */
  agentExists: boolean
}

export interface WebhookHandlerResult {
  status: number
  body: string
  contentType: string
}

const KNOWN_SOURCES: WebhookSource[] = ['github', 'generic']

function jsonReply(status: number, body: Record<string, unknown>): WebhookHandlerResult {
  return {
    status,
    body: JSON.stringify(body),
    contentType: 'application/json',
  }
}

/**
 * Pure-ish handler: takes everything it needs as args (no module
 * globals), writes a JSONL line on success, returns the HTTP shape.
 * Tested against a tmpdir-rooted resolveAgentDir.
 */
export async function handleWebhookIngest(
  args: WebhookHandlerArgs,
  deps: WebhookHandlerDeps = {},
): Promise<WebhookHandlerResult> {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const now = (deps.now ?? Date.now)()
  const resolveAgentDir =
    deps.resolveAgentDir ?? ((a) => join(homedir(), '.switchroom', 'agents', a))

  if (!args.agentExists) {
    log(`webhook-ingest: agent='${args.agent}' source='${args.source}' rejected: unknown agent\n`)
    return jsonReply(404, { ok: false, error: 'unknown agent' })
  }

  const sourceUntyped = args.source.toLowerCase()
  if (!KNOWN_SOURCES.includes(sourceUntyped as WebhookSource)) {
    log(`webhook-ingest: agent='${args.agent}' source='${args.source}' rejected: unknown source\n`)
    return jsonReply(400, { ok: false, error: 'unknown source' })
  }
  const source = sourceUntyped as WebhookSource

  if (!args.allowedSources.includes(source)) {
    log(`webhook-ingest: agent='${args.agent}' source='${source}' rejected: source not in agent's webhook_sources allowlist\n`)
    return jsonReply(403, { ok: false, error: 'source not allowed for this agent' })
  }

  const secret = args.config.secrets[source]
  if (!secret) {
    log(`webhook-ingest: agent='${args.agent}' source='${source}' rejected: no secret in vault under webhook/${args.agent}/${source}\n`)
    return jsonReply(401, { ok: false, error: 'unauthorized' })
  }

  // Verify per source.
  let verifyResult
  if (source === 'github') {
    const sigHeader = args.headers.get('x-hub-signature-256')
    verifyResult = verifyGithubSignature(args.body, sigHeader, secret)
  } else {
    const authHeader = args.headers.get('authorization')
    verifyResult = verifyBearerToken(authHeader, secret)
  }
  if (!verifyResult.ok) {
    log(`webhook-ingest: agent='${args.agent}' source='${source}' rejected: ${verifyResult.reason}\n`)
    return jsonReply(401, { ok: false, error: 'unauthorized' })
  }

  // Parse JSON body. We require JSON across both sources today; if a
  // future source needs raw form bodies we'll branch here.
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(new TextDecoder().decode(args.body)) as Record<string, unknown>
  } catch {
    log(`webhook-ingest: agent='${args.agent}' source='${source}' rejected: malformed JSON\n`)
    return jsonReply(400, { ok: false, error: 'malformed json' })
  }

  // Render to a Telegram-ready string. Stored on the event record so
  // the follow-up "post to Telegram" PR doesn't have to re-render.
  const eventType = source === 'github'
    ? (args.headers.get('x-github-event') ?? 'unknown')
    : args.source
  const rendered = source === 'github'
    ? renderGithubEvent(eventType, payload)
    : renderGenericEvent(args.source, payload)

  // Write the verified event to the agent's webhook log.
  const agentDir = resolveAgentDir(args.agent)
  const telegramDir = join(agentDir, 'telegram')
  const logPath = join(telegramDir, 'webhook-events.jsonl')
  try {
    mkdirSync(telegramDir, { recursive: true })
    const record = {
      ts: now,
      source,
      event_type: eventType,
      rendered_text: rendered.text,
      payload, // full verified payload — useful when the agent wants details
    }
    appendFileSync(logPath, JSON.stringify(record) + '\n', { mode: 0o600 })
  } catch (err) {
    log(`webhook-ingest: agent='${args.agent}' source='${source}' write failed: ${(err as Error).message}\n`)
    return jsonReply(500, { ok: false, error: 'write failed' })
  }

  log(`webhook-ingest: agent='${args.agent}' source='${source}' event='${eventType}' recorded ts=${now}\n`)
  return jsonReply(202, { ok: true, recorded: true, ts: now })
}

/**
 * Read the agent's webhook event log. Used by tests; agents can also
 * call this via Bash (`cat <path>`) as documented in CLAUDE.md.
 */
export function readWebhookLog(
  agent: string,
  resolveAgentDir?: (agent: string) => string,
): Array<Record<string, unknown>> {
  const dir = (resolveAgentDir ?? ((a) => join(homedir(), '.switchroom', 'agents', a)))(agent)
  const logPath = join(dir, 'telegram', 'webhook-events.jsonl')
  if (!existsSync(logPath)) return []
  const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>)
}
