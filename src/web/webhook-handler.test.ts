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
