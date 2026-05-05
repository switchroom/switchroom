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
 *   - 200 OK with {ok:true, deduped:true} when delivery already seen (github only).
 *   - 400 if the path / body / config is malformed.
 *   - 401 if the signature/token is invalid (no detail leaked).
 *   - 403 if the agent doesn't allow this source.
 *   - 404 if the agent name is unknown.
 *   - 429 Too Many Requests when per-source rate limit exceeded.
 *
 * MVP behavior (#577):
 *   - Verify signature.
 *   - Render to a structured Telegram-ready text via the renderers in
 *     `webhook-verify.ts`.
 *   - Append a JSON line to `~/.switchroom/agents/<agent>/telegram/webhook-events.jsonl`.
 *   - Log the receipt to stderr for operator visibility.
 *
 * Hardening (#714):
 *   - Dedup by X-GitHub-Delivery (github source only): LRU per agent,
 *     1000 entries, 24h retention, persisted to webhook-dedup.json.
 *   - Per-(agent, source) token-bucket rate limit: default 60 rpm,
 *     configurable via channels.telegram.webhook_rate_limit.rpm.
 *     First throttle in a 60s window writes to issues.jsonl.
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  verifyGithubSignature,
  verifyBearerToken,
  renderGithubEvent,
  renderGenericEvent,
  type WebhookSource,
} from './webhook-verify.js'
import {
  evaluateDispatch,
  type WebhookDispatchConfig,
  type EvaluateDispatchDeps,
} from './webhook-dispatch.js'

export interface WebhookConfig {
  /** Per-source secrets, declared in vault under
   *  `webhook/<agent>/<source>`. The verifier expects the secret as
   *  the operator typed it (no per-key encoding). */
  secrets: Partial<Record<WebhookSource, string>>
  /** Rate limit config from channels.telegram.webhook_rate_limit. */
  rateLimit?: { rpm: number }
}

export interface WebhookHandlerDeps {
  /** Path resolver — overridable for tests. Production: agent dir
   *  under `~/.switchroom/agents/<agent>`. */
  resolveAgentDir?: (agent: string) => string
  /** Allow tests to inject a fixed clock for the recorded ts field. */
  now?: () => number
  /** Log sink — stderr in production. */
  log?: (line: string) => void
  /** Injectable dedup store (for testing). Falls back to file-backed. */
  dedupStore?: DedupStore
  /** Injectable rate limiter (for testing). Falls back to module-global. */
  rateLimiter?: RateLimiter
  /** Injectable dispatch deps (for testing). When absent, production
   *  defaults are used inside evaluateDispatch. */
  dispatchDeps?: EvaluateDispatchDeps
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
  /** Optional dispatch config from switchroom.yaml
   *  channels.telegram.webhook_dispatch. When absent, no dispatch runs. */
  dispatchConfig?: WebhookDispatchConfig
}

export interface WebhookHandlerResult {
  status: number
  body: string
  contentType: string
  headers?: Record<string, string>
}

const KNOWN_SOURCES: WebhookSource[] = ['github', 'generic']

function jsonReply(
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): WebhookHandlerResult {
  return {
    status,
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: extraHeaders,
  }
}

// ─── Dedup store ──────────────────────────────────────────────────────────────

const DEDUP_MAX = 1000
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

interface DedupFileShape {
  deliveries: Record<string, number>
}

export interface DedupStore {
  /** Returns the original ts if already seen, undefined otherwise.
   *  Stores the delivery on miss. */
  check(agent: string, deliveryId: string, now: number): number | undefined
}

function loadDedupFile(path: string): Record<string, number> {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as DedupFileShape
    return typeof raw.deliveries === 'object' && raw.deliveries !== null
      ? raw.deliveries
      : {}
  } catch {
    return {}
  }
}

function saveDedupFile(path: string, deliveries: Record<string, number>, now: number): void {
  // Prune entries older than 24h
  const pruned: Record<string, number> = {}
  for (const [id, ts] of Object.entries(deliveries)) {
    if (now - ts < DEDUP_TTL_MS) pruned[id] = ts
  }
  // Enforce cap: keep most-recent 1000
  const sorted = Object.entries(pruned).sort((a, b) => b[1] - a[1]).slice(0, DEDUP_MAX)
  const final: Record<string, number> = Object.fromEntries(sorted)
  writeFileSync(path, JSON.stringify({ deliveries: final } satisfies DedupFileShape), {
    mode: 0o600,
  })
}

/** In-memory cache of per-agent deliveries, backed by disk. */
const agentDedupCache = new Map<string, Record<string, number>>()

function createFileDedupStore(resolveAgentDir: (agent: string) => string): DedupStore {
  return {
    check(agent: string, deliveryId: string, now: number): number | undefined {
      const telegramDir = join(resolveAgentDir(agent), 'telegram')
      const filePath = join(telegramDir, 'webhook-dedup.json')

      // Load from disk if not in memory cache
      if (!agentDedupCache.has(agent)) {
        agentDedupCache.set(agent, loadDedupFile(filePath))
      }

      const deliveries = agentDedupCache.get(agent)!

      if (deliveries[deliveryId] !== undefined) {
        return deliveries[deliveryId]
      }

      // New delivery — store it
      deliveries[deliveryId] = now

      // Persist to disk
      try {
        mkdirSync(telegramDir, { recursive: true })
        saveDedupFile(filePath, deliveries, now)
      } catch {
        // Non-fatal: if we can't persist, we still accept the event
      }

      return undefined
    },
  }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

interface TokenBucket {
  tokens: number
  lastRefill: number
}

export interface RateLimiter {
  /** Returns null if allowed, or seconds-until-next-token if throttled. */
  check(agent: string, source: string, rpm: number, now: number): number | null
}

/** Per-(agent, source) token buckets. Module-global for production. */
const tokenBuckets = new Map<string, TokenBucket>()

export const defaultRateLimiter: RateLimiter = {
  check(agent: string, source: string, rpm: number, now: number): number | null {
    const key = `${agent}\0${source}`
    const refillRate = rpm / 60 // tokens per second
    const maxTokens = rpm

    let bucket = tokenBuckets.get(key)
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now }
      tokenBuckets.set(key, bucket)
    }

    // Refill based on elapsed time
    const elapsedSecs = (now - bucket.lastRefill) / 1000
    bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsedSecs * refillRate)
    bucket.lastRefill = now

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return null
    }

    // Calculate seconds until next token
    const secsUntilToken = (1 - bucket.tokens) / refillRate
    return Math.ceil(secsUntilToken)
  },
}

// ─── Throttle issue suppression ───────────────────────────────────────────────

/** Track first throttle event per (agent, source) per 60s window. */
const throttleIssueWindow = new Map<string, number>()
const THROTTLE_WINDOW_MS = 60_000

export function shouldWriteThrottleIssue(
  agent: string,
  source: string,
  now: number,
  windowMap?: Map<string, number>,
): boolean {
  const map = windowMap ?? throttleIssueWindow
  const key = `${agent}\0${source}`
  const lastWritten = map.get(key)
  if (lastWritten !== undefined && now - lastWritten < THROTTLE_WINDOW_MS) {
    return false
  }
  map.set(key, now)
  return true
}

// ─── issues.jsonl writer ──────────────────────────────────────────────────────

function writeThrottleIssue(
  agent: string,
  source: string,
  now: number,
  telegramDir: string,
  log: (line: string) => void,
): void {
  const issuesPath = join(telegramDir, 'issues.jsonl')
  try {
    mkdirSync(telegramDir, { recursive: true })
    // Format mirrors src/issues/types.ts IssueEvent
    const record = {
      ts: now,
      agent,
      severity: 'warn',
      source: `webhook:${source}`,
      code: 'webhook_rate_limit',
      summary: `Webhook rate limit hit for source '${source}'`,
      fingerprint: `webhook:${source}:webhook_rate_limit`,
      occurrences: 1,
      first_seen: now,
      last_seen: now,
    }
    appendFileSync(issuesPath, JSON.stringify(record) + '\n', { mode: 0o600 })
  } catch (err) {
    log(`webhook-ingest: agent='${agent}' source='${source}' issues.jsonl write failed: ${(err as Error).message}\n`)
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

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
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter
  const dedupStore = deps.dedupStore ?? createFileDedupStore(resolveAgentDir)

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

  // ── Dedup check (github only — generic has no delivery ID) ────────────────
  if (source === 'github') {
    const deliveryId = args.headers.get('x-github-delivery')
    if (deliveryId) {
      const originalTs = dedupStore.check(args.agent, deliveryId, now)
      if (originalTs !== undefined) {
        log(`webhook-ingest: agent='${args.agent}' source='${source}' deduped delivery='${deliveryId}'\n`)
        return jsonReply(200, { ok: true, deduped: true, ts: originalTs })
      }
    }
  }

  // ── Rate limit check ──────────────────────────────────────────────────────
  // Rate limiting only activates when `config.rateLimit` is explicitly
  // configured (channels.telegram.webhook_rate_limit in switchroom.yaml).
  // When absent, no rate limit is applied — the operator opts in by
  // setting an explicit `rpm` value.
  const rpm = args.config.rateLimit?.rpm
  const retryAfter = rpm !== undefined ? rateLimiter.check(args.agent, source, rpm, now) : null
  if (retryAfter !== null) {
    const agentDir = resolveAgentDir(args.agent)
    const telegramDir = join(agentDir, 'telegram')
    if (shouldWriteThrottleIssue(args.agent, source, now)) {
      writeThrottleIssue(args.agent, source, now, telegramDir, log)
    }
    log(`webhook-ingest: agent='${args.agent}' source='${source}' rate limited retry-after=${retryAfter}s\n`)
    return jsonReply(
      429,
      { ok: false, error: 'rate limited' },
      { 'Retry-After': String(retryAfter) },
    )
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

  // ── Webhook dispatch (#715) ───────────────────────────────────────────────
  // After recording, evaluate dispatch rules. Fires are async (detached
  // processes) — we don't await them and don't let failures affect the 202.
  if (args.dispatchConfig) {
    try {
      const fired = evaluateDispatch(
        {
          agent: args.agent,
          source,
          eventType,
          payload,
          dispatchConfig: args.dispatchConfig,
        },
        {
          ...(deps.dispatchDeps ?? {}),
          resolveAgentDir,
          log,
        },
      )
      if (fired > 0) {
        log(`webhook-dispatch: agent='${args.agent}' source='${source}' event='${eventType}' fired=${fired}\n`)
      }
    } catch (err) {
      // Non-fatal: a dispatch failure must not downgrade the 202.
      log(`webhook-dispatch: agent='${args.agent}' source='${source}' event='${eventType}' dispatch error: ${(err as Error).message}\n`)
    }
  }

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
