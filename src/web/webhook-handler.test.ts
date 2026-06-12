/**
 * Tests for webhook ingest hardening (#714):
 *   - Replay/duplicate dedup by X-GitHub-Delivery
 *   - Per-source token-bucket rate limiting
 *
 * Uses vitest + tmpdir for file I/O isolation.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHmac } from 'crypto'
import {
  handleWebhookIngest,
  shouldWriteThrottleIssue,
  type WebhookHandlerArgs,
  type WebhookHandlerDeps,
  type DedupStore,
  type RateLimiter,
} from './webhook-handler.js'
import type {
  WebhookForwardRequest,
  WebhookForwardResponse,
} from './webhook-ingest-client.js'

// ─── Test helpers ─────────────────────────────────────────────────────────────

const SECRET = 'test-secret-key'

function makeGithubSig(body: Uint8Array, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

function makeBody(payload: Record<string, unknown> = { action: 'opened' }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload))
}

function makeGithubHeaders(
  body: Uint8Array,
  deliveryId: string = 'delivery-001',
  eventType: string = 'pull_request',
): Headers {
  const h = new Headers()
  h.set('x-hub-signature-256', makeGithubSig(body))
  h.set('x-github-delivery', deliveryId)
  h.set('x-github-event', eventType)
  return h
}

function makeTmpResolveAgentDir(): { resolveAgentDir: (a: string) => string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'webhook-test-'))
  return {
    root,
    resolveAgentDir: (agent: string) => join(root, agent),
  }
}

function baseArgs(body: Uint8Array, headers: Headers): WebhookHandlerArgs {
  return {
    agent: 'myagent',
    source: 'github',
    body,
    headers,
    allowedSources: ['github'],
    config: { secrets: { github: SECRET } },
    agentExists: true,
  }
}

function baseDeps(
  resolveAgentDir: (a: string) => string,
  nowMs: number,
  extras: Partial<WebhookHandlerDeps> = {},
): WebhookHandlerDeps {
  return {
    resolveAgentDir,
    now: () => nowMs,
    log: () => {},
    ...extras,
  }
}

/**
 * In-memory dedup store — no disk I/O, no shared module-global state.
 * Each test creates its own instance.
 */
function makeDedupStore(): DedupStore {
  const seen = new Map<string, number>() // key: `${agent}\0${deliveryId}` → ts
  return {
    check(agent: string, deliveryId: string, now: number): number | undefined {
      const key = `${agent}\0${deliveryId}`
      const existing = seen.get(key)
      if (existing !== undefined) return existing
      seen.set(key, now)
      return undefined
    },
  }
}

/**
 * In-memory token-bucket rate limiter — fully isolated per test.
 */
function makeRateLimiter(): RateLimiter {
  const buckets = new Map<string, { tokens: number; lastRefill: number }>()
  return {
    check(agent: string, source: string, rpm: number, now: number): number | null {
      const key = `${agent}\0${source}`
      const refillRate = rpm / 60
      const maxTokens = rpm

      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { tokens: maxTokens, lastRefill: now }
        buckets.set(key, bucket)
      }
      const elapsedSecs = (now - bucket.lastRefill) / 1000
      bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsedSecs * refillRate)
      bucket.lastRefill = now

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return null
      }
      const secsUntilToken = (1 - bucket.tokens) / refillRate
      return Math.ceil(secsUntilToken)
    },
  }
}

// ─── Dedup tests ───────────────────────────────────────────────────────────────

describe('dedup by X-GitHub-Delivery', () => {
  it('first delivery → 202 recorded, one JSONL line', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'delivery-abc')
    const result = await handleWebhookIngest(baseArgs(body, headers), {
      ...baseDeps(resolveAgentDir, 1000, { dedupStore: makeDedupStore(), rateLimiter: makeRateLimiter() }),
    })
    expect(result.status).toBe(202)
    expect(JSON.parse(result.body)).toMatchObject({ ok: true, recorded: true })
  })

  it('same delivery ID sent twice → first 202, second 200 deduped, only one JSONL line', async () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'delivery-dup')
    const dedupStore = makeDedupStore()
    const rateLimiter = makeRateLimiter()

    const first = await handleWebhookIngest(baseArgs(body, headers), {
      ...baseDeps(resolveAgentDir, 2000, { dedupStore, rateLimiter }),
    })
    expect(first.status).toBe(202)

    const second = await handleWebhookIngest(baseArgs(body, headers), {
      ...baseDeps(resolveAgentDir, 2000, { dedupStore, rateLimiter }),
    })
    expect(second.status).toBe(200)
    expect(JSON.parse(second.body)).toMatchObject({ ok: true, deduped: true, ts: 2000 })

    // Only one JSONL record appended
    const logPath = join(root, 'myagent', 'telegram', 'webhook-events.jsonl')
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it('dedup state survives across handler invocations (fresh dedupStore reads from disk)', async () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const body = makeBody()

    // First call — store dedup entry on disk via the real file-backed store.
    // We use a pre-populated dedup file to simulate this.
    const telegramDir = join(root, 'myagent', 'telegram')
    mkdirSync(telegramDir, { recursive: true })
    const dedupPath = join(telegramDir, 'webhook-dedup.json')

    // Simulate a previous process having stored delivery 'delivery-persist' at ts=3000
    writeFileSync(
      dedupPath,
      JSON.stringify({ deliveries: { 'delivery-persist': 3000 } }),
      { mode: 0o600 },
    )

    // Fresh dedupStore that reads from disk — simulates a new process
    const diskDedupStore: DedupStore = {
      check(_agent, deliveryId, _now) {
        const data = JSON.parse(readFileSync(dedupPath, 'utf-8')) as { deliveries: Record<string, number> }
        return data.deliveries[deliveryId]
      },
    }

    const result = await handleWebhookIngest(
      { ...baseArgs(body, makeGithubHeaders(body, 'delivery-persist')) },
      baseDeps(resolveAgentDir, 5000, { dedupStore: diskDedupStore, rateLimiter: makeRateLimiter() }),
    )
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ deduped: true, ts: 3000 })
  })

  it('entries older than 24h are pruned on next write', async () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()

    const now = Date.now()
    const old = now - 25 * 60 * 60 * 1000 // 25h ago

    // Manually pre-populate dedup file with one old entry
    const telegramDir = join(root, 'myagent', 'telegram')
    mkdirSync(telegramDir, { recursive: true })
    const dedupPath = join(telegramDir, 'webhook-dedup.json')
    writeFileSync(
      dedupPath,
      JSON.stringify({ deliveries: { 'old-delivery': old } }),
      { mode: 0o600 },
    )

    // The real file-backed store reads the old entry and then writes back.
    // We use a fresh module-agent key to avoid the in-process cache.
    // Use a unique agent name so agentDedupCache has no entry for it.
    const agentName = `prune-test-agent-${now}`

    // Manually set up the dir
    const agentTgDir = join(root, agentName, 'telegram')
    mkdirSync(agentTgDir, { recursive: true })
    writeFileSync(
      join(agentTgDir, 'webhook-dedup.json'),
      JSON.stringify({ deliveries: { 'old-delivery': old } }),
      { mode: 0o600 },
    )

    const body = makeBody()
    const headers = makeGithubHeaders(body, 'new-delivery')
    // Use the real file-backed dedup (default, no override) to test pruning
    await handleWebhookIngest(
      { ...baseArgs(body, headers), agent: agentName },
      {
        resolveAgentDir,
        now: () => now,
        log: () => {},
        rateLimiter: makeRateLimiter(),
        // No dedupStore override — uses real file-backed store
      },
    )

    // Old entry should be pruned from the file
    const stored = JSON.parse(
      readFileSync(join(agentTgDir, 'webhook-dedup.json'), 'utf-8'),
    ) as { deliveries: Record<string, number> }
    expect(stored.deliveries['old-delivery']).toBeUndefined()
    expect(stored.deliveries['new-delivery']).toBe(now)
  })

  it('corrupt webhook-dedup.json on disk — handler degrades to empty state, does not crash', async () => {
    const { root, resolveAgentDir } = makeTmpResolveAgentDir()
    const agentName = `corrupt-dedup-${Date.now()}`
    const agentTgDir = join(root, agentName, 'telegram')
    mkdirSync(agentTgDir, { recursive: true })
    // Write garbage that JSON.parse will reject.
    writeFileSync(join(agentTgDir, 'webhook-dedup.json'), 'not-json-{{{', { mode: 0o600 })

    const body = makeBody()
    const headers = makeGithubHeaders(body, 'first-after-corrupt')
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), agent: agentName },
      {
        resolveAgentDir,
        now: () => 7000,
        log: () => {},
        rateLimiter: makeRateLimiter(),
      },
    )
    expect(result.status).toBe(202)
    // File rewritten cleanly.
    const stored = JSON.parse(
      readFileSync(join(agentTgDir, 'webhook-dedup.json'), 'utf-8'),
    ) as { deliveries: Record<string, number> }
    expect(stored.deliveries['first-after-corrupt']).toBe(7000)
  })

  it('generic source skips dedup entirely — no error on missing delivery header', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody({ text: 'hello' })
    const headers = new Headers()
    headers.set('authorization', `Bearer ${SECRET}`)

    const result = await handleWebhookIngest(
      {
        agent: 'myagent',
        source: 'generic',
        body,
        headers,
        allowedSources: ['generic'],
        config: { secrets: { generic: SECRET } },
        agentExists: true,
      },
      baseDeps(resolveAgentDir, 6000, { dedupStore: makeDedupStore(), rateLimiter: makeRateLimiter() }),
    )
    expect(result.status).toBe(202)
  })
})

/** baseArgs variant with rate limiting enabled at 60 rpm. */
function baseArgsRL(body: Uint8Array, headers: Headers): WebhookHandlerArgs {
  return {
    ...baseArgs(body, headers),
    config: { secrets: { github: SECRET }, rateLimit: { rpm: 60 } },
  }
}

// ─── Rate limit tests ─────────────────────────────────────────────────────────

describe('per-source rate limiting', () => {
  it('60 requests within burst cap all return 202', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const rateLimiter = makeRateLimiter()
    const dedupStore = makeDedupStore()
    const nowMs = 10_000_000

    for (let i = 0; i < 60; i++) {
      const body = makeBody()
      const headers = makeGithubHeaders(body, `delivery-${i}`)
      const result = await handleWebhookIngest(baseArgsRL(body, headers), {
        ...baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore }),
      })
      expect(result.status).toBe(202)
    }
  })

  it('61st request in same window returns 429 with Retry-After', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const rateLimiter = makeRateLimiter()
    const dedupStore = makeDedupStore()
    const nowMs = 20_000_000

    for (let i = 0; i < 60; i++) {
      const body = makeBody()
      const headers = makeGithubHeaders(body, `d-${i}`)
      await handleWebhookIngest(baseArgsRL(body, headers), {
        ...baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore }),
      })
    }

    const body = makeBody()
    const headers = makeGithubHeaders(body, 'd-61')
    const result = await handleWebhookIngest(baseArgsRL(body, headers), {
      ...baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore }),
    })
    expect(result.status).toBe(429)
    expect(JSON.parse(result.body)).toMatchObject({ ok: false, error: 'rate limited' })
    expect(result.headers?.['Retry-After']).toBeDefined()
    expect(Number(result.headers?.['Retry-After'])).toBeGreaterThan(0)
  })

  it('after 1s wait, next request is 202 again', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const rateLimiter = makeRateLimiter()
    const dedupStore = makeDedupStore()
    const t0 = 30_000_000

    // Exhaust the bucket
    for (let i = 0; i < 60; i++) {
      const body = makeBody()
      const headers = makeGithubHeaders(body, `d-${i}`)
      await handleWebhookIngest(baseArgsRL(body, headers), {
        ...baseDeps(resolveAgentDir, t0, { rateLimiter, dedupStore }),
      })
    }

    // Confirm throttled (fresh delivery ID not in dedup)
    const body = makeBody()
    const throttled = await handleWebhookIngest(
      { ...baseArgsRL(body, makeGithubHeaders(body, 'd-extra')) },
      baseDeps(resolveAgentDir, t0, { rateLimiter, dedupStore }),
    )
    expect(throttled.status).toBe(429)

    // 1 second later — refill should allow ≥1 token (rpm=60 → 1/sec)
    const body2 = makeBody()
    const recovered = await handleWebhookIngest(
      { ...baseArgsRL(body2, makeGithubHeaders(body2, 'd-recovered')) },
      baseDeps(resolveAgentDir, t0 + 1000, { rateLimiter, dedupStore }),
    )
    expect(recovered.status).toBe(202)
  })

  it('first throttle writes to issues.jsonl; second throttle in same 60s window does not', async () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const rateLimiter = makeRateLimiter()
    const dedupStore = makeDedupStore()
    const nowMs = 40_000_000

    // Exhaust bucket
    for (let i = 0; i < 60; i++) {
      const body = makeBody()
      const headers = makeGithubHeaders(body, `d-${i}`)
      await handleWebhookIngest(baseArgsRL(body, headers), {
        ...baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore }),
      })
    }

    // First throttle
    const body1 = makeBody()
    const h1 = makeGithubHeaders(body1, 'throttle-1')
    const r1 = await handleWebhookIngest(baseArgsRL(body1, h1), {
      ...baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore }),
    })
    expect(r1.status).toBe(429)

    const issuesPath = join(root, 'myagent', 'telegram', 'issues.jsonl')
    const lines1 = existsSync(issuesPath)
      ? readFileSync(issuesPath, 'utf-8').trim().split('\n').filter(Boolean)
      : []
    expect(lines1).toHaveLength(1)
    const issue = JSON.parse(lines1[0]) as Record<string, unknown>
    expect(issue.code).toBe('webhook_rate_limit')
    expect(issue.source).toBe('webhook:github')

    // shouldWriteThrottleIssue with isolated windowMap
    const windowMap = new Map<string, number>()
    expect(shouldWriteThrottleIssue('myagent', 'github', nowMs, windowMap)).toBe(true)
    expect(shouldWriteThrottleIssue('myagent', 'github', nowMs + 1000, windowMap)).toBe(false)
    // After window expires, it should fire again
    expect(shouldWriteThrottleIssue('myagent', 'github', nowMs + 61_000, windowMap)).toBe(true)
  })

  it('cross-agent isolation — agent A hitting rate limit does not affect agent B', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const rateLimiter = makeRateLimiter()
    const dedupStoreA = makeDedupStore()
    const dedupStoreB = makeDedupStore()
    const nowMs = 50_000_000

    // Exhaust agent A's bucket
    for (let i = 0; i < 60; i++) {
      const body = makeBody()
      const headers = makeGithubHeaders(body, `a-${i}`)
      await handleWebhookIngest(
        { ...baseArgsRL(body, headers), agent: 'agent-a' },
        baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore: dedupStoreA }),
      )
    }

    // Agent A is now throttled
    const bodyA = makeBody()
    const resultA = await handleWebhookIngest(
      { ...baseArgsRL(bodyA, makeGithubHeaders(bodyA, 'a-extra')), agent: 'agent-a' },
      baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore: dedupStoreA }),
    )
    expect(resultA.status).toBe(429)

    // Agent B should still have a full bucket
    const bodyB = makeBody()
    const resultB = await handleWebhookIngest(
      { ...baseArgsRL(bodyB, makeGithubHeaders(bodyB, 'b-001')), agent: 'agent-b' },
      baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore: dedupStoreB }),
    )
    expect(resultB.status).toBe(202)
  })

  it('respects configurable rpm from config.rateLimit', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const rateLimiter = makeRateLimiter()
    const dedupStore = makeDedupStore()
    const nowMs = 60_000_000

    const extraArgs = {
      config: { secrets: { github: SECRET }, rateLimit: { rpm: 5 } },
    }

    for (let i = 0; i < 5; i++) {
      const body = makeBody()
      const headers = makeGithubHeaders(body, `r-${i}`)
      const result = await handleWebhookIngest(
        { ...baseArgs(body, headers), ...extraArgs },
        baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore }),
      )
      expect(result.status).toBe(202)
    }

    const body = makeBody()
    const headers = makeGithubHeaders(body, 'r-6')
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), ...extraArgs },
      baseDeps(resolveAgentDir, nowMs, { rateLimiter, dedupStore }),
    )
    expect(result.status).toBe(429)
  })
})

// ─── viaGateway forward path (Docker runtime) ──────────────────────────────────
// When channels.telegram.webhook_via_gateway is true, the receiver verifies +
// renders the event but does NOT write the agent dir; it forwards to the
// in-container gateway over webhook.sock and maps the gateway's response to an
// HTTP status. See docs/rfcs/webhook-via-gateway-socket.md.
describe('handleWebhookIngest — viaGateway forward', () => {
  /** A forwardFn spy matching `typeof forwardToGateway`. */
  function makeForward(
    resp: WebhookForwardResponse | null,
  ): {
    fn: WebhookHandlerDeps['forwardFn']
    calls: Array<{ socketPath: string; req: WebhookForwardRequest }>
  } {
    const calls: Array<{ socketPath: string; req: WebhookForwardRequest }> = []
    const fn = async (socketPath: string, req: WebhookForwardRequest) => {
      calls.push({ socketPath, req })
      return resp
    }
    return { fn, calls }
  }

  it('forwards the verified event and returns 202 on gateway ok', async () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const { fn, calls } = makeForward({ status: 'ok', ts: 123, dispatched: 1 })
    const body = makeBody({ action: 'opened', number: 9 })
    const headers = makeGithubHeaders(body, 'fwd-1')

    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), viaGateway: true },
      baseDeps(resolveAgentDir, 123, { forwardFn: fn }),
    )

    expect(result.status).toBe(202)
    expect(JSON.parse(result.body)).toMatchObject({ ok: true, recorded: true })
    // The receiver must NOT write the agent dir in viaGateway mode.
    expect(existsSync(join(root, 'myagent', 'telegram', 'webhook-events.jsonl'))).toBe(false)
    // Forward targets the per-agent webhook.sock and carries the delivery id.
    expect(calls).toHaveLength(1)
    expect(calls[0].socketPath).toBe(join(root, 'myagent', 'telegram', 'webhook.sock'))
    expect(calls[0].req.delivery_id).toBe('fwd-1')
    expect(calls[0].req.event_type).toBe('pull_request')
  })

  it('returns 200 deduped when the gateway reports a duplicate', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const { fn } = makeForward({ status: 'deduped', ts: 100 })
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'fwd-2')

    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), viaGateway: true },
      baseDeps(resolveAgentDir, 200, { forwardFn: fn }),
    )

    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toMatchObject({ ok: true, deduped: true, ts: 100 })
  })

  it('returns 500 when the gateway reports a record error', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const { fn } = makeForward({ status: 'error', error: 'write failed' })
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'fwd-3')

    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), viaGateway: true },
      baseDeps(resolveAgentDir, 300, { forwardFn: fn }),
    )

    expect(result.status).toBe(500)
    expect(JSON.parse(result.body).ok).toBe(false)
  })

  it('returns 503 when the gateway is unreachable (forward null)', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const { fn } = makeForward(null)
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'fwd-4')

    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), viaGateway: true },
      baseDeps(resolveAgentDir, 400, { forwardFn: fn }),
    )

    expect(result.status).toBe(503)
    expect(JSON.parse(result.body).ok).toBe(false)
  })

  it('returns 503 when the forward transport throws', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const throwingFn: WebhookHandlerDeps['forwardFn'] = async () => {
      throw new Error('boom')
    }
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'fwd-5')

    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), viaGateway: true },
      baseDeps(resolveAgentDir, 500, { forwardFn: throwingFn }),
    )

    expect(result.status).toBe(503)
  })
})

describe('handleWebhookIngest — Cloudflare edge lock (requireEdge)', () => {
  const EDGE = 'edge-shared-secret'

  function withEdge(h: Headers, value?: string): Headers {
    if (value !== undefined) h.set('x-switchroom-edge', value)
    return h
  }

  it('matching edge header → proceeds to record (202)', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = withEdge(makeGithubHeaders(body, 'edge-ok'), EDGE)
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), requireEdge: true, edgeSecret: EDGE },
      baseDeps(resolveAgentDir, 1000, { dedupStore: makeDedupStore(), rateLimiter: makeRateLimiter() }),
    )
    expect(result.status).toBe(202)
  })

  it('missing edge header → 403 before any HMAC work', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'edge-missing') // no x-switchroom-edge
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), requireEdge: true, edgeSecret: EDGE },
      baseDeps(resolveAgentDir, 1000),
    )
    expect(result.status).toBe(403)
    expect(JSON.parse(result.body)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('wrong edge header → 403', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = withEdge(makeGithubHeaders(body, 'edge-wrong'), 'not-the-secret')
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), requireEdge: true, edgeSecret: EDGE },
      baseDeps(resolveAgentDir, 1000),
    )
    expect(result.status).toBe(403)
  })

  it('fail-closed: requireEdge but edgeSecret null → 403 even with a header present', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = withEdge(makeGithubHeaders(body, 'edge-noconf'), EDGE)
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), requireEdge: true, edgeSecret: null },
      baseDeps(resolveAgentDir, 1000),
    )
    expect(result.status).toBe(403)
  })

  it('flag off: edge header ignored entirely, normal flow (202) even with no edge secret', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = makeGithubHeaders(body, 'edge-off')
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), requireEdge: false, edgeSecret: null },
      baseDeps(resolveAgentDir, 1000, { dedupStore: makeDedupStore(), rateLimiter: makeRateLimiter() }),
    )
    expect(result.status).toBe(202)
  })

  it('edge gate runs before signature check: valid edge + bad HMAC → 401 (not 403)', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody()
    const headers = new Headers()
    headers.set('x-hub-signature-256', 'sha256=' + 'deadbeef'.repeat(8))
    headers.set('x-github-delivery', 'edge-order')
    headers.set('x-github-event', 'pull_request')
    withEdge(headers, EDGE)
    const result = await handleWebhookIngest(
      { ...baseArgs(body, headers), requireEdge: true, edgeSecret: EDGE },
      baseDeps(resolveAgentDir, 1000),
    )
    expect(result.status).toBe(401)
  })
})

// ─── Linear source ingest (#2272) ─────────────────────────────────────────────

function makeLinearSig(body: Uint8Array, secret: string = SECRET): string {
  // Bare hex digest — no sha256= prefix.
  return createHmac('sha256', secret).update(body).digest('hex')
}

function linearArgs(body: Uint8Array, headers: Headers): WebhookHandlerArgs {
  return {
    agent: 'myagent',
    source: 'linear',
    body,
    headers,
    allowedSources: ['linear'],
    config: { secrets: { linear: SECRET } },
    agentExists: true,
  }
}

describe('linear source ingest', () => {
  const payload = { action: 'update', type: 'Issue', url: 'https://linear.app/x/ENG-1', data: { identifier: 'ENG-1', title: 'hi' } }

  it('accepts a valid Linear-Signature and records the event', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody(payload)
    const headers = new Headers()
    headers.set('linear-signature', makeLinearSig(body))
    const result = await handleWebhookIngest(
      linearArgs(body, headers),
      baseDeps(resolveAgentDir, 1000),
    )
    expect(result.status).toBe(202)
    const logged = JSON.parse(
      readFileSync(join(resolveAgentDir('myagent'), 'telegram', 'webhook-events.jsonl'), 'utf-8').trim(),
    ) as Record<string, unknown>
    expect(logged.source).toBe('linear')
    // event_type is the lower-cased linear `type`
    expect(logged.event_type).toBe('issue')
    expect(String(logged.rendered_text)).toContain('ENG-1')
  })

  it('rejects an invalid Linear-Signature with 401', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody(payload)
    const headers = new Headers()
    headers.set('linear-signature', makeLinearSig(body, 'wrong-secret'))
    const result = await handleWebhookIngest(
      linearArgs(body, headers),
      baseDeps(resolveAgentDir, 1000),
    )
    expect(result.status).toBe(401)
  })

  it('rejects a missing Linear-Signature with 401', async () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const body = makeBody(payload)
    const result = await handleWebhookIngest(
      linearArgs(body, new Headers()),
      baseDeps(resolveAgentDir, 1000),
    )
    expect(result.status).toBe(401)
  })
})
