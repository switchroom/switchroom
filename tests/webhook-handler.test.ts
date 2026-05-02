/**
 * Integration tests for `handleWebhookIngest` (#577).
 *
 * Drives the full request → verify → write-jsonl pipeline against a
 * tmpdir-rooted fake `resolveAgentDir`. Covers every documented HTTP
 * status code and the recorded-event shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHmac } from 'crypto'
import {
  handleWebhookIngest,
  readWebhookLog,
  type WebhookHandlerArgs,
} from '../src/web/webhook-handler.js'

const SECRET = 'shared-secret-very-long-enough'

let agentsRoot: string

beforeEach(() => {
  agentsRoot = mkdtempSync(join(tmpdir(), 'webhook-handler-'))
})
afterEach(() => {
  rmSync(agentsRoot, { recursive: true, force: true })
})

function resolveAgentDir(agent: string): string {
  return join(agentsRoot, agent)
}

function makeArgs(overrides: Partial<WebhookHandlerArgs>): WebhookHandlerArgs {
  return {
    agent: 'klanker',
    source: 'github',
    body: new TextEncoder().encode('{"action":"opened","repository":{"full_name":"x/y"},"sender":{"login":"k"},"pull_request":{"number":1,"title":"t","html_url":"https://x"}}'),
    headers: new Headers(),
    allowedSources: ['github'],
    config: { secrets: { github: SECRET } },
    agentExists: true,
    ...overrides,
  }
}

function githubSig(body: Uint8Array, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

describe('handleWebhookIngest — happy path', () => {
  it('verifies + records a github pull_request event', async () => {
    const args = makeArgs({})
    args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
    args.headers.set('x-github-event', 'pull_request')

    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(202)
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, recorded: true })

    const events = readWebhookLog('klanker', resolveAgentDir)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ source: 'github', event_type: 'pull_request' })
    expect(events[0].rendered_text).toContain('PR #1 opened')
    expect(events[0].payload).toMatchObject({ action: 'opened' })
  })

  it('verifies + records a generic source event with Bearer auth', async () => {
    const args = makeArgs({
      source: 'generic',
      body: new TextEncoder().encode('{"title":"Error spike","details":"500s on /api"}'),
      allowedSources: ['generic'],
      config: { secrets: { generic: SECRET } },
    })
    args.headers.set('authorization', `Bearer ${SECRET}`)

    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(202)
    const events = readWebhookLog('klanker', resolveAgentDir)
    expect(events).toHaveLength(1)
    expect(events[0].rendered_text).toContain('Error spike')
  })

  it('appends multiple events to the same log', async () => {
    for (let i = 0; i < 3; i++) {
      const args = makeArgs({
        body: new TextEncoder().encode(`{"action":"opened","repository":{"full_name":"x/y"},"sender":{"login":"k"},"pull_request":{"number":${i},"title":"t","html_url":"https://x"}}`),
      })
      args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
      args.headers.set('x-github-event', 'pull_request')
      await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    }
    const events = readWebhookLog('klanker', resolveAgentDir)
    expect(events).toHaveLength(3)
  })
})

describe('handleWebhookIngest — error paths', () => {
  it('returns 404 for unknown agent', async () => {
    const args = makeArgs({ agentExists: false })
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(404)
  })

  it('returns 400 for unknown source', async () => {
    const args = makeArgs({ source: 'sentry', allowedSources: ['sentry'] })
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(400)
  })

  it('returns 403 when source not in agent allowlist', async () => {
    const args = makeArgs({ allowedSources: ['generic'] })
    args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(403)
  })

  it('returns 401 when no secret is configured for the source', async () => {
    const args = makeArgs({ config: { secrets: {} } })
    args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(401)
  })

  it('returns 401 on github signature mismatch', async () => {
    const args = makeArgs({})
    args.headers.set('x-hub-signature-256', githubSig(args.body, 'wrong-secret'))
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(401)
  })

  it('returns 401 on missing signature header', async () => {
    const args = makeArgs({})
    // no header at all
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(401)
  })

  it('returns 401 on invalid Bearer for generic', async () => {
    const args = makeArgs({
      source: 'generic',
      body: new TextEncoder().encode('{"x":1}'),
      allowedSources: ['generic'],
      config: { secrets: { generic: SECRET } },
    })
    args.headers.set('authorization', 'Bearer wrong-token-of-some-length__')
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(401)
  })

  it('returns 400 on malformed JSON body', async () => {
    const args = makeArgs({
      body: new TextEncoder().encode('not-valid-json'),
    })
    args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
    args.headers.set('x-github-event', 'pull_request')
    const r = await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(r.status).toBe(400)
  })
})

describe('handleWebhookIngest — file isolation', () => {
  it('writes to per-agent paths so two agents do not share logs', async () => {
    const a1 = makeArgs({ agent: 'finn' })
    a1.headers.set('x-hub-signature-256', githubSig(a1.body, SECRET))
    a1.headers.set('x-github-event', 'pull_request')
    await handleWebhookIngest(a1, { resolveAgentDir, log: () => {} })

    const a2 = makeArgs({ agent: 'klanker' })
    a2.headers.set('x-hub-signature-256', githubSig(a2.body, SECRET))
    a2.headers.set('x-github-event', 'pull_request')
    await handleWebhookIngest(a2, { resolveAgentDir, log: () => {} })

    expect(readWebhookLog('finn', resolveAgentDir)).toHaveLength(1)
    expect(readWebhookLog('klanker', resolveAgentDir)).toHaveLength(1)
    expect(existsSync(join(agentsRoot, 'finn', 'telegram', 'webhook-events.jsonl'))).toBe(true)
    expect(existsSync(join(agentsRoot, 'klanker', 'telegram', 'webhook-events.jsonl'))).toBe(true)
  })

  it('creates the telegram dir when it does not exist', async () => {
    const args = makeArgs({ agent: 'newagent' })
    args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
    args.headers.set('x-github-event', 'pull_request')
    await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    expect(existsSync(join(agentsRoot, 'newagent', 'telegram', 'webhook-events.jsonl'))).toBe(true)
  })
})

describe('handleWebhookIngest — log line shape', () => {
  it('logs receipt with agent, source, event_type, ts', async () => {
    const args = makeArgs({})
    args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
    args.headers.set('x-github-event', 'pull_request')

    const lines: string[] = []
    await handleWebhookIngest(args, {
      resolveAgentDir,
      log: (s) => lines.push(s),
      now: () => 1234567890,
    })
    const joined = lines.join('')
    expect(joined).toMatch(/agent='klanker'/)
    expect(joined).toMatch(/source='github'/)
    expect(joined).toMatch(/event='pull_request'/)
    expect(joined).toMatch(/ts=1234567890/)
  })

  it('logs rejection reason without leaking which check failed', async () => {
    // The HTTP body is a generic 'unauthorized' but the stderr log
    // should carry the specific reason for operator debugging.
    const args = makeArgs({})
    args.headers.set('x-hub-signature-256', 'sha256=' + 'a'.repeat(64))

    const lines: string[] = []
    const r = await handleWebhookIngest(args, {
      resolveAgentDir,
      log: (s) => lines.push(s),
    })
    expect(r.status).toBe(401)
    expect(JSON.parse(r.body)).toMatchObject({ ok: false, error: 'unauthorized' })
    // Operator log carries the specific reason.
    expect(lines.join('')).toMatch(/signature-mismatch/)
  })
})

describe('readWebhookLog', () => {
  it('returns [] when the log file does not exist', () => {
    expect(readWebhookLog('nope', resolveAgentDir)).toEqual([])
  })

  it('parses each line independently', async () => {
    const args = makeArgs({})
    args.headers.set('x-hub-signature-256', githubSig(args.body, SECRET))
    args.headers.set('x-github-event', 'pull_request')
    await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    await handleWebhookIngest(args, { resolveAgentDir, log: () => {} })
    const events = readWebhookLog('klanker', resolveAgentDir)
    expect(events).toHaveLength(2)
    expect(events.every((e) => typeof e.ts === 'number')).toBe(true)
  })
})

// Use existsSync for file-creation assertions.
import { existsSync as _existsSync } from 'fs'
void _existsSync
