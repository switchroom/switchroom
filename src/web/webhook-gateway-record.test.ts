/**
 * Tests for the gateway-side webhook record handler
 * (`recordWebhookEvent`, RFC reference/rfcs/webhook-via-gateway-socket.md).
 *
 * This is the in-container (agent UID) handler the forwarded record lands
 * in. It owns dedup, the `webhook-events.jsonl` append, and `webhook_dispatch`
 * firing. All file I/O is pinned to an isolated tmpdir — NEVER `~/.switchroom`
 * (vault/shared-state test discipline).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordWebhookEvent,
  type WebhookGatewayRecord,
  type RecordDeps,
} from './webhook-gateway-record.js'
import type { DedupStore } from './webhook-handler.js'
import type { InboundMessageWire } from '../scheduler/dispatch.js'

const NOW = 1_700_000_000_000

function makeTmpResolveAgentDir(): {
  resolveAgentDir: (a: string) => string
  root: string
} {
  const root = mkdtempSync(join(tmpdir(), 'webhook-gw-rec-'))
  return { root, resolveAgentDir: (agent: string) => join(root, agent) }
}

/** In-memory dedup store — no disk, no module-global cache. */
function makeDedupStore(): DedupStore {
  const seen = new Map<string, number>()
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

function baseRecord(over: Partial<WebhookGatewayRecord> = {}): WebhookGatewayRecord {
  return {
    agent: 'reggie',
    source: 'github',
    event_type: 'pull_request',
    ts: NOW,
    rendered_text: 'PR opened: foo/bar #1',
    payload: {
      action: 'opened',
      number: 1,
      repository: { full_name: 'foo/bar' },
      pull_request: {
        number: 1,
        title: 'Add thing',
        html_url: 'https://github.com/foo/bar/pull/1',
        user: { login: 'octocat' },
        labels: [{ name: 'needs-review' }],
      },
    },
    delivery_id: 'delivery-001',
    ...over,
  }
}

/** Config with one matching dispatch rule for reggie. */
function configWithDispatch(): RecordDeps['loadConfig'] {
  return () =>
    ({
      telegram: { forum_chat_id: '-100123' },
      agents: {
        reggie: {
          topic_id: 42,
          channels: {
            telegram: {
              webhook_dispatch: {
                github: [
                  {
                    match: { event: 'pull_request', labels_any: ['needs-review'] },
                    prompt: 'Review {{repo}} #{{number}}',
                  },
                ],
              },
            },
          },
        },
      },
    }) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>
}

describe('recordWebhookEvent', () => {
  it('appends the event to webhook-events.jsonl and returns ok', () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: () => ({}) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>,
    }

    const result = recordWebhookEvent(baseRecord(), deps)

    expect(result.status).toBe('ok')
    expect(result.ts).toBe(NOW)

    const logPath = join(root, 'reggie', 'telegram', 'webhook-events.jsonl')
    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const written = JSON.parse(lines[0])
    expect(written.event_type).toBe('pull_request')
    expect(written.rendered_text).toBe('PR opened: foo/bar #1')
    expect(written.payload.action).toBe('opened')
  })

  it('dedups a repeated github delivery id without re-appending', () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const dedupStore = makeDedupStore()
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore,
      log: () => {},
      loadConfig: () => ({}) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>,
    }

    const first = recordWebhookEvent(baseRecord(), deps)
    expect(first.status).toBe('ok')

    const second = recordWebhookEvent(baseRecord({ ts: NOW + 5000 }), deps)
    expect(second.status).toBe('deduped')
    expect(second.ts).toBe(NOW) // original ts, not the retry's

    const logPath = join(root, 'reggie', 'telegram', 'webhook-events.jsonl')
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1) // not re-appended
  })

  it('fires a matching dispatch rule through the in-process inject callback', () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const injected: Array<{ agent: string; inbound: InboundMessageWire }> = []
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: configWithDispatch(),
      inject: (agent, inbound) => {
        injected.push({ agent, inbound })
        return true
      },
    }

    const result = recordWebhookEvent(baseRecord(), deps)

    expect(result.status).toBe('ok')
    expect(result.dispatched).toBe(1)
    expect(injected).toHaveLength(1)
    expect(injected[0].agent).toBe('reggie')
    expect(injected[0].inbound.meta?.source).toBe('webhook')
    expect(injected[0].inbound.chatId).toBe('-100123')
    expect(injected[0].inbound.threadId).toBe(42)
    expect(injected[0].inbound.text).toBe('Review foo/bar #1')
  })

  it('fires a linear-source dispatch rule (#2272)', () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const injected: Array<{ agent: string; inbound: InboundMessageWire }> = []
    const linearConfig: RecordDeps['loadConfig'] = () =>
      ({
        telegram: { forum_chat_id: '-100123' },
        agents: {
          reggie: {
            topic_id: 42,
            channels: {
              telegram: {
                webhook_dispatch: {
                  linear: [
                    {
                      match: { event: 'issue', assignee_any: ['clerk'] },
                      prompt: 'Linear {{number}} for you',
                    },
                  ],
                },
              },
            },
          },
        },
      }) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>

    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: linearConfig,
      inject: (agent, inbound) => {
        injected.push({ agent, inbound })
        return true
      },
    }

    const rec = baseRecord({
      source: 'linear',
      event_type: 'issue',
      rendered_text: 'Linear ENG-9 updated',
      delivery_id: undefined,
      payload: {
        action: 'update',
        type: 'Issue',
        url: 'https://linear.app/x/ENG-9',
        data: { identifier: 'ENG-9', title: 'Do the thing', assignee: { displayName: 'clerk' } },
      },
    })

    const result = recordWebhookEvent(rec, deps)
    expect(result.status).toBe('ok')
    expect(result.dispatched).toBe(1)
    expect(injected).toHaveLength(1)
    expect(injected[0].inbound.text).toBe('Linear ENG-9 for you')
  })

  it('injects a verified Linear AgentSessionEvent with meta.source=linear + session id (#2298)', () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const injected: Array<{ agent: string; inbound: InboundMessageWire }> = []
    const linearAgentConfig: RecordDeps['loadConfig'] = () =>
      ({
        telegram: { forum_chat_id: '-100123' },
        agents: {
          reggie: {
            topic_id: 42,
            channels: {
              telegram: {
                linear_agent: { enabled: true, token: 'vault:linear/reggie/token' },
              },
            },
          },
        },
      }) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>

    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: linearAgentConfig,
      inject: (agent, inbound) => {
        injected.push({ agent, inbound })
        return true
      },
    }

    const rec = baseRecord({
      source: 'linear',
      event_type: 'agentsessionevent',
      rendered_text: 'Linear agent session',
      delivery_id: undefined,
      payload: {
        type: 'AgentSessionEvent',
        action: 'created',
        promptContext: 'Please draft the article on issue ENG-42.',
        agentSession: {
          id: 'sess_abc123',
          issue: { identifier: 'ENG-42', title: 'Draft article' },
          comment: { body: '@reggie draft this' },
        },
      },
    })

    const result = recordWebhookEvent(rec, deps)
    expect(result.status).toBe('ok')
    expect(result.dispatched).toBe(1)
    expect(injected).toHaveLength(1)
    expect(injected[0].inbound.meta?.source).toBe('linear')
    expect(injected[0].inbound.meta?.agent_session_id).toBe('sess_abc123')
    expect(injected[0].inbound.meta?.linear_trigger).toBe('mention')
    expect(injected[0].inbound.meta?.linear_event).toBe('agent_session.created')
    expect(injected[0].inbound.text).toBe('Please draft the article on issue ENG-42.')
    expect(injected[0].inbound.chatId).toBe('-100123')
    expect(injected[0].inbound.threadId).toBe(42)
  })

  it('does not inject a Linear AgentSessionEvent when linear_agent is not enabled (#2298)', () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const injected: unknown[] = []
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: () =>
        ({
          telegram: { forum_chat_id: '-100123' },
          agents: { reggie: { topic_id: 42, channels: { telegram: {} } } },
        }) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>,
      inject: () => {
        injected.push(true)
        return true
      },
    }

    const rec = baseRecord({
      source: 'linear',
      event_type: 'agentsessionevent',
      delivery_id: undefined,
      payload: {
        type: 'AgentSessionEvent',
        action: 'created',
        agentSession: { id: 'sess_xyz', issue: { identifier: 'ENG-1' } },
      },
    })

    const result = recordWebhookEvent(rec, deps)
    expect(result.status).toBe('ok')
    expect(injected).toHaveLength(0)
  })

  it('does not dispatch when there is no chat target configured', () => {
    const { resolveAgentDir } = makeTmpResolveAgentDir()
    const injected: unknown[] = []
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      // dispatch rule present but no forum_chat_id / chat_id → no target
      loadConfig: () =>
        ({
          agents: {
            reggie: {
              channels: {
                telegram: {
                  webhook_dispatch: {
                    github: [
                      {
                        match: { event: 'pull_request' },
                        prompt: 'x',
                      },
                    ],
                  },
                },
              },
            },
          },
        }) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>,
      inject: () => {
        injected.push(true)
        return true
      },
    }

    const result = recordWebhookEvent(baseRecord(), deps)

    expect(result.status).toBe('ok')
    expect(result.dispatched).toBe(0)
    expect(injected).toHaveLength(0)
  })

  it('records the event even when dispatch evaluation throws', () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: () => {
        throw new Error('config load boom')
      },
      inject: () => true,
    }

    const result = recordWebhookEvent(baseRecord(), deps)

    // The append already succeeded; a dispatch failure must not fail ingest.
    expect(result.status).toBe('ok')
    const logPath = join(root, 'reggie', 'telegram', 'webhook-events.jsonl')
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it('returns error when the jsonl write fails', () => {
    // resolveAgentDir points at a path whose parent is a FILE, so mkdirSync
    // throws ENOTDIR — exercising the write-failure branch.
    const { root } = makeTmpResolveAgentDir()
    const blocker = join(root, 'blocker')
    require('fs').writeFileSync(blocker, 'x')
    const deps: RecordDeps = {
      resolveAgentDir: () => join(blocker, 'nested'),
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: () => ({}) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>,
    }

    const result = recordWebhookEvent(baseRecord(), deps)
    expect(result.status).toBe('error')
  })

  // ── Consolidation-legibility (hindsight Phase 4) ────────────────────────
  const consolidationConfig: RecordDeps['loadConfig'] = () =>
    ({
      telegram: { forum_chat_id: '-100123' },
      agents: { reggie: { topic_id: 42, channels: { telegram: {} } } },
    }) as unknown as ReturnType<NonNullable<RecordDeps['loadConfig']>>

  function consolidationRec(
    payload: Record<string, unknown> = { stored: 1, subject: 'x' },
  ): WebhookGatewayRecord {
    return baseRecord({
      source: 'hindsight',
      event_type: 'consolidation.completed',
      rendered_text: 'consolidation done',
      delivery_id: undefined,
      payload,
    })
  }

  it('delegates a consolidation.completed event to onConsolidation with the resolved target', () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const seen: Array<{ rec: WebhookGatewayRecord; target: { chatId: string; threadId?: number } }> =
      []
    const injected: unknown[] = []
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: consolidationConfig,
      inject: () => {
        injected.push(true)
        return true
      },
      onConsolidation: (rec, target) => seen.push({ rec, target }),
    }

    const result = recordWebhookEvent(consolidationRec(), deps)

    expect(result.status).toBe('ok')
    // Never injected as a model turn — it is a discrete status line.
    expect(injected).toHaveLength(0)
    expect(result.dispatched).toBeUndefined()
    expect(seen).toHaveLength(1)
    expect(seen[0].target).toEqual({ chatId: '-100123', threadId: 42 })
    expect(seen[0].rec.payload).toEqual({ stored: 1, subject: 'x' })

    // Still recorded to the audit log regardless of surfacing.
    const logPath = join(root, 'reggie', 'telegram', 'webhook-events.jsonl')
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).event_type).toBe('consolidation.completed')
  })

  it('skips onConsolidation (but still records) when there is no chat target', () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const seen: unknown[] = []
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: () =>
        ({ agents: { reggie: { channels: { telegram: {} } } } }) as unknown as ReturnType<
          NonNullable<RecordDeps['loadConfig']>
        >,
      onConsolidation: () => seen.push(true),
    }

    const result = recordWebhookEvent(consolidationRec(), deps)
    expect(result.status).toBe('ok')
    expect(seen).toHaveLength(0)
    const logPath = join(root, 'reggie', 'telegram', 'webhook-events.jsonl')
    expect(readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('records the consolidation event even when onConsolidation throws', () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: consolidationConfig,
      onConsolidation: () => {
        throw new Error('surface boom')
      },
    }

    const result = recordWebhookEvent(consolidationRec(), deps)
    expect(result.status).toBe('ok')
    const logPath = join(root, 'reggie', 'telegram', 'webhook-events.jsonl')
    expect(readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('is a no-op sink when onConsolidation is not provided (event still recorded)', () => {
    const { resolveAgentDir, root } = makeTmpResolveAgentDir()
    const deps: RecordDeps = {
      resolveAgentDir,
      dedupStore: makeDedupStore(),
      log: () => {},
      loadConfig: consolidationConfig,
    }

    const result = recordWebhookEvent(consolidationRec(), deps)
    expect(result.status).toBe('ok')
    const logPath = join(root, 'reggie', 'telegram', 'webhook-events.jsonl')
    expect(readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)).toHaveLength(1)
  })
})
