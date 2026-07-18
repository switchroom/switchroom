/**
 * Behavior pins for card-tool-handlers.ts (#2996 P5-tail) — the agent-facing
 * card-STAGING execute* tool handlers, extracted verbatim from gateway.ts.
 *
 * Unlike the source-inspection pins in pending-card-durability-wiring.test.ts,
 * these INVOKE the extracted handlers through the DI factory with fake deps and
 * assert OUTCOMES (Amendment-10 extracted-module oracle): the returned tool
 * text, what lands in the durable card store, what NEVER lands (secret hygiene),
 * and the validation/deny throw paths. The factory is only unit-invocable
 * BECAUSE the handlers moved out of the un-importable gateway.ts.
 */

import { describe, it, expect } from 'vitest'
import { createCardToolHandlers, type CardToolHandlersDeps } from '../gateway/card-tool-handlers.js'

const VAULT_KEY_REGEX = /^[A-Za-z0-9_./-]{1,200}$/
const VAULT_KEY_REGEX_LABEL = '[A-Za-z0-9_./-]{1,200}'

/** A minimal SweepableCardStore-shaped fake backed by a Map. */
function fakeCardStore<T>() {
  const map = new Map<string, T>()
  return {
    map,
    get: (id: string) => map.get(id),
    set: (id: string, v: T) => void map.set(id, v),
    delete: (id: string) => map.delete(id),
    sweep: () => {},
    [Symbol.iterator]: () => map[Symbol.iterator](),
  } as unknown as CardToolHandlersDeps['pendingVaultRequestSaves'] & { map: Map<string, T> }
}

function makeDeps(overrides: Partial<CardToolHandlersDeps> = {}) {
  const added: unknown[] = []
  const removed: string[] = []
  const allowedChats: string[] = []
  const saves = fakeCardStore<Record<string, unknown>>()
  const accesses = fakeCardStore<Record<string, unknown>>()
  const secrets = fakeCardStore<Record<string, unknown>>()
  const sweeps: number[] = []
  const proposes = fakeCardStore<Record<string, unknown>>()
  const proposeTimes: number[] = []
  const deps: CardToolHandlersDeps = {
    lockedBot: {
      api: {
        sendRichMessage: async () => ({ message_id: 4242 }),
      },
    },
    robustApiCall: (<T>(fn: () => Promise<T>) => fn()) as CardToolHandlersDeps['robustApiCall'],
    assertAllowedChat: (chat_id) => {
      allowedChats.push(String(chat_id))
    },
    VAULT_KEY_REGEX,
    VAULT_KEY_REGEX_LABEL,
    pendingVaultRequestSaves: saves,
    pendingVaultRequestAccesses: accesses,
    pendingSecretRequests: secrets,
    pendingCardStore: {
      add: (e: unknown) => void added.push(e),
      remove: (id: string) => void removed.push(id),
    } as unknown as CardToolHandlersDeps['pendingCardStore'],
    sweepSecretRequests: (now = Date.now()) => void sweeps.push(now),
    // Default: broker sees no keys (no standing ACL) — normal card flow.
    listViaBroker: async () => [],
    VAULT_REQUEST_ACCESS_TTL_MS: 10 * 60_000,
    pendingMentalModelProposes: proposes,
    mentalModelProposeTimes: proposeTimes,
    // Default: under budget.
    checkMentalModelProposeRate: () => ({ ok: true }),
    // Default: no agents block — dup pre-check finds nothing declared.
    readLiveSwitchroomConfigText: () => 'agents: {}\n',
    MENTAL_MODEL_SOURCE_QUERY_MAX: 2000,
    MENTAL_MODEL_MAX_TOKENS_CAP: 8192,
    MENTAL_MODEL_PROPOSE_MAX_PER_WINDOW: 5,
    ...overrides,
  }
  return { deps, added, removed, allowedChats, saves, accesses, secrets, sweeps, proposes, proposeTimes }
}

describe('executeVaultRequestSave', () => {
  it('stages the card and returns a stage_id + key in the tool text', async () => {
    const { deps, added, saves } = makeDeps()
    const { executeVaultRequestSave } = createCardToolHandlers(deps)
    const res = await executeVaultRequestSave({
      chat_id: '123',
      key: 'svc/token',
      value: 'sekret-value',
    })
    const text = res.content[0]!.text
    expect(text).toMatch(/vault_request_save: card sent/)
    expect(text).toMatch(/key=svc\/token/)
    // Exactly one entry staged in the in-memory store, holding the value.
    expect(saves.map.size).toBe(1)
    const staged = [...saves.map.values()][0] as Record<string, unknown>
    expect(staged.value).toBe('sekret-value')
    expect(staged.card_message_id).toBe(4242)
    // One durable record persisted for the family.
    expect(added).toHaveLength(1)
    const rec = added[0] as Record<string, unknown>
    expect(rec.family).toBe('vault_request_save')
    expect(rec.key).toBe('svc/token')
  })

  it('NEVER persists the raw secret value into the durable store (hygiene)', async () => {
    const { deps, added } = makeDeps()
    const { executeVaultRequestSave } = createCardToolHandlers(deps)
    await executeVaultRequestSave({ chat_id: '123', key: 'svc/token', value: 'top-secret' })
    const rec = added[0] as Record<string, unknown>
    expect(rec).not.toHaveProperty('value')
    expect(JSON.stringify(rec)).not.toContain('top-secret')
  })

  it('enforces the allow-list before staging (deny path throws, nothing staged)', async () => {
    const { deps, added, saves } = makeDeps({
      assertAllowedChat: () => {
        throw new Error('chat not allowed')
      },
    })
    const { executeVaultRequestSave } = createCardToolHandlers(deps)
    await expect(
      executeVaultRequestSave({ chat_id: '999', key: 'svc/token', value: 'v' }),
    ).rejects.toThrow(/chat not allowed/)
    expect(saves.map.size).toBe(0)
    expect(added).toHaveLength(0)
  })

  it('rejects a malformed vault key with the labelled charset error', async () => {
    const { deps } = makeDeps()
    const { executeVaultRequestSave } = createCardToolHandlers(deps)
    await expect(
      executeVaultRequestSave({ chat_id: '123', key: 'bad key!', value: 'v' }),
    ).rejects.toThrow(/key must match/)
  })

  it('rejects an empty value and an invalid kind', async () => {
    const { deps } = makeDeps()
    const { executeVaultRequestSave } = createCardToolHandlers(deps)
    await expect(
      executeVaultRequestSave({ chat_id: '123', key: 'svc/token', value: '' }),
    ).rejects.toThrow(/value is required/)
    await expect(
      executeVaultRequestSave({ chat_id: '123', key: 'svc/token', value: 'v', kind: 'nope' }),
    ).rejects.toThrow(/kind must be/)
  })
})

describe('executeVaultRequestAccess', () => {
  it('stages the card and returns stage_id + key + scope; default scope=read, default ttl=30d', async () => {
    const { deps, added, accesses } = makeDeps()
    const { executeVaultRequestAccess } = createCardToolHandlers(deps)
    const res = await executeVaultRequestAccess({ chat_id: '123', key: 'svc/token' })
    const text = res.content[0]!.text
    expect(text).toMatch(/vault_request_access: card sent/)
    expect(text).toMatch(/key=svc\/token/)
    expect(text).toMatch(/scope=read/)
    expect(accesses.map.size).toBe(1)
    const staged = [...accesses.map.values()][0] as Record<string, unknown>
    expect(staged.scope).toBe('read')
    expect(staged.ttl_seconds).toBe(30 * 24 * 60 * 60)
    expect(added).toHaveLength(1)
    const rec = added[0] as Record<string, unknown>
    expect(rec.family).toBe('vault_request_access')
    expect(rec.scope).toBe('read')
  })

  it('parses "12h"/"45d" durations and REFUSES > 90d and malformed/"never" shapes (threat model)', async () => {
    const { deps, accesses } = makeDeps()
    const { executeVaultRequestAccess } = createCardToolHandlers(deps)
    await executeVaultRequestAccess({ chat_id: '1', key: 'a/b', duration: '12h' })
    expect(([...accesses.map.values()].pop() as Record<string, unknown>).ttl_seconds).toBe(12 * 3600)
    await executeVaultRequestAccess({ chat_id: '1', key: 'a/c', duration: '45d' })
    expect(([...accesses.map.values()].pop() as Record<string, unknown>).ttl_seconds).toBe(45 * 86400)
    await expect(
      executeVaultRequestAccess({ chat_id: '1', key: 'a/d', duration: '91d' }),
    ).rejects.toThrow(/<= 90d/)
    await expect(
      executeVaultRequestAccess({ chat_id: '1', key: 'a/e', duration: 'never' }),
    ).rejects.toThrow(/must look like/)
    await expect(
      executeVaultRequestAccess({ chat_id: '1', key: 'a/f', duration: '0d' }),
    ).rejects.toThrow(/> 0/)
  })

  it('rejects an invalid scope', async () => {
    const { deps } = makeDeps()
    const { executeVaultRequestAccess } = createCardToolHandlers(deps)
    await expect(
      executeVaultRequestAccess({ chat_id: '1', key: 'a/b', scope: 'admin' }),
    ).rejects.toThrow(/scope must be/)
  })

  it('standing-ACL short-circuit: read scope + broker lists the key → NO card, NO staging, NO durable record', async () => {
    const { deps, added, accesses } = makeDeps({
      listViaBroker: async () => ['svc/token', 'other/key'],
    })
    let sends = 0
    ;(deps.lockedBot as { api: { sendRichMessage: unknown } }).api.sendRichMessage = async () => {
      sends++
      return { message_id: 1 }
    }
    const { executeVaultRequestAccess } = createCardToolHandlers(deps)
    const res = await executeVaultRequestAccess({ chat_id: '123', key: 'svc/token' })
    expect(res.content[0]!.text).toMatch(/ALREADY covered/)
    expect(sends).toBe(0)
    expect(accesses.map.size).toBe(0)
    expect(added).toHaveLength(0)
  })

  it('write scope does NOT consult the standing-ACL probe (read-only coverage)', async () => {
    let probes = 0
    const { deps, accesses } = makeDeps({
      listViaBroker: async () => {
        probes++
        return ['svc/token']
      },
    })
    const { executeVaultRequestAccess } = createCardToolHandlers(deps)
    const res = await executeVaultRequestAccess({ chat_id: '123', key: 'svc/token', scope: 'write' })
    expect(probes).toBe(0)
    expect(res.content[0]!.text).toMatch(/card sent/)
    expect(accesses.map.size).toBe(1)
  })

  it('broker probe failure fails OPEN to the normal card flow', async () => {
    const { deps, accesses } = makeDeps({
      listViaBroker: async () => {
        throw new Error('broker unreachable')
      },
    })
    const { executeVaultRequestAccess } = createCardToolHandlers(deps)
    const res = await executeVaultRequestAccess({ chat_id: '123', key: 'svc/token' })
    expect(res.content[0]!.text).toMatch(/card sent/)
    expect(accesses.map.size).toBe(1)
  })

  it('accepts `why` as an alias for `reason` and derives the timeout copy from the injected TTL', async () => {
    const { deps, accesses } = makeDeps({ VAULT_REQUEST_ACCESS_TTL_MS: 25 * 60_000 })
    const { executeVaultRequestAccess } = createCardToolHandlers(deps)
    const res = await executeVaultRequestAccess({ chat_id: '1', key: 'a/b', why: 'need it' })
    const staged = [...accesses.map.values()][0] as Record<string, unknown>
    expect(staged.reason).toBe('need it')
    expect(res.content[0]!.text).toMatch(/times out \(25 min\)/)
  })
})

describe('executeRequestSecret', () => {
  it('stages the card and returns stage_id + key + the END-YOUR-TURN copy', async () => {
    const { deps, added, secrets } = makeDeps()
    const { executeRequestSecret } = createCardToolHandlers(deps)
    const res = await executeRequestSecret({ chat_id: '123', key: 'svc/token', reason: 'need it' })
    const text = res.content[0]!.text
    expect(text).toMatch(/request_secret: card sent/)
    expect(text).toMatch(/key=svc\/token/)
    // The secure-capture contract: the agent must END ITS TURN and wait.
    expect(text).toMatch(/END YOUR TURN/)
    expect(secrets.map.size).toBe(1)
    const staged = [...secrets.map.values()][0] as Record<string, unknown>
    expect(staged.key).toBe('svc/token')
    expect(staged.reason).toBe('need it')
    expect(staged.card_message_id).toBe(4242)
    expect(added).toHaveLength(1)
    const rec = added[0] as Record<string, unknown>
    expect(rec.family).toBe('request_secret')
    expect(rec.key).toBe('svc/token')
  })

  it('NEVER stages or persists a secret VALUE — request_secret carries none at staging time', async () => {
    // The whole point of request_secret (vs vault_request_save): the value
    // arrives LATER via secure capture, so no value must exist on the pending
    // record or in the durable store at staging time.
    const { deps, added, secrets } = makeDeps()
    const { executeRequestSecret } = createCardToolHandlers(deps)
    await executeRequestSecret({ chat_id: '123', key: 'svc/token', value: 'should-be-ignored' })
    const staged = [...secrets.map.values()][0] as Record<string, unknown>
    expect(staged).not.toHaveProperty('value')
    expect(JSON.stringify(staged)).not.toContain('should-be-ignored')
    const rec = added[0] as Record<string, unknown>
    expect(rec).not.toHaveProperty('value')
    expect(JSON.stringify(rec)).not.toContain('should-be-ignored')
  })

  it('dedupes to one open request per (chat,key): a prior stage is dropped from BOTH stores', async () => {
    const { deps, removed, secrets } = makeDeps()
    const { executeRequestSecret } = createCardToolHandlers(deps)
    await executeRequestSecret({ chat_id: '123', key: 'svc/token' })
    const firstId = [...secrets.map.keys()][0]!
    // Second request for the SAME (chat,key) drops the first stage.
    await executeRequestSecret({ chat_id: '123', key: 'svc/token' })
    expect(secrets.map.size).toBe(1)
    expect(secrets.map.has(firstId)).toBe(false)
    // The dropped stage's durable record is removed too (no stacked cards).
    expect(removed).toContain(firstId)
  })

  it('does NOT dedupe across a different key or a different chat', async () => {
    const { deps, secrets } = makeDeps()
    const { executeRequestSecret } = createCardToolHandlers(deps)
    await executeRequestSecret({ chat_id: '123', key: 'svc/token' })
    await executeRequestSecret({ chat_id: '123', key: 'other/key' })
    await executeRequestSecret({ chat_id: '456', key: 'svc/token' })
    expect(secrets.map.size).toBe(3)
  })

  it('enforces the allow-list before staging (deny path throws, nothing staged)', async () => {
    const { deps, added, secrets } = makeDeps({
      assertAllowedChat: () => {
        throw new Error('chat not allowed')
      },
    })
    const { executeRequestSecret } = createCardToolHandlers(deps)
    await expect(
      executeRequestSecret({ chat_id: '999', key: 'svc/token' }),
    ).rejects.toThrow(/chat not allowed/)
    expect(secrets.map.size).toBe(0)
    expect(added).toHaveLength(0)
  })

  it('rejects a malformed vault key with the labelled charset error', async () => {
    const { deps, secrets } = makeDeps()
    const { executeRequestSecret } = createCardToolHandlers(deps)
    await expect(
      executeRequestSecret({ chat_id: '123', key: 'bad key!' }),
    ).rejects.toThrow(/key must match/)
    expect(secrets.map.size).toBe(0)
  })

  it('rejects a missing chat_id and a missing key', async () => {
    const { deps } = makeDeps()
    const { executeRequestSecret } = createCardToolHandlers(deps)
    await expect(executeRequestSecret({ key: 'svc/token' })).rejects.toThrow(/chat_id is required/)
    await expect(executeRequestSecret({ chat_id: '123' })).rejects.toThrow(/key is required/)
  })

  it('runs the injected sweepSecretRequests reaper on the way through', async () => {
    const { deps, sweeps } = makeDeps()
    const { executeRequestSecret } = createCardToolHandlers(deps)
    await executeRequestSecret({ chat_id: '123', key: 'svc/token' })
    expect(sweeps.length).toBeGreaterThan(0)
  })
})

describe('executeMentalModelPropose', () => {
  // The dup-name pre-check keys on agents.<slug>.memory.mental_models[] where
  // slug = SWITCHROOM_AGENT_NAME || 'agent' (read live by the handler).
  const agentSlug = process.env.SWITCHROOM_AGENT_NAME || 'agent'
  const declaredYaml =
    `agents:\n  ${agentSlug}:\n    memory:\n      mental_models:\n        - name: existing-model\n          source_query: standing query\n`

  it('stages the card and returns stage_id + name + the END-YOUR-TURN copy; budget consumed AFTER post', async () => {
    const { deps, added, proposes, proposeTimes } = makeDeps()
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    const res = await executeMentalModelPropose({
      chat_id: '123',
      name: 'training-plan-state',
      source_query: 'what is the current training plan state',
      reason: 'recurring question',
      max_tokens: 512,
      refresh_after_consolidation: true,
    })
    const text = res.content[0]!.text
    expect(text).toMatch(/mental_model_propose: card sent/)
    expect(text).toMatch(/name=training-plan-state/)
    expect(text).toMatch(/END YOUR TURN/)
    expect(proposes.map.size).toBe(1)
    const staged = [...proposes.map.values()][0] as { spec: Record<string, unknown>; reason?: string; card_message_id?: number }
    expect(staged.spec.name).toBe('training-plan-state')
    expect(staged.spec.max_tokens).toBe(512)
    expect(staged.spec.refresh_after_consolidation).toBe(true)
    expect(staged.reason).toBe('recurring question')
    expect(staged.card_message_id).toBe(4242)
    expect(added).toHaveLength(1)
    const rec = added[0] as Record<string, unknown>
    expect(rec.family).toBe('mental_model_propose')
    // Rate budget consumed exactly once, only because the card posted.
    expect(proposeTimes).toHaveLength(1)
  })

  it('RATE-LIMITED path: no card send, no staging, no durable record, no budget consumed', async () => {
    const retryAtMs = Date.now() + 30 * 60_000
    const { deps, added, proposes, proposeTimes } = makeDeps({
      checkMentalModelProposeRate: () => ({ ok: false, retryAtMs }),
    })
    let sends = 0
    ;(deps.lockedBot as { api: { sendRichMessage: unknown } }).api.sendRichMessage = async () => {
      sends++
      return { message_id: 1 }
    }
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    const res = await executeMentalModelPropose({ chat_id: '123', name: 'm', source_query: 'q' })
    const text = res.content[0]!.text
    expect(text).toMatch(/RATE-LIMITED \(max 5 proposals\/hour\)/)
    expect(text).toContain(new Date(retryAtMs).toISOString())
    expect(sends).toBe(0)
    expect(proposes.map.size).toBe(0)
    expect(added).toHaveLength(0)
    expect(proposeTimes).toHaveLength(0)
  })

  it('duplicate-name short-circuit: declared model → NO card, NO staging, NO budget', async () => {
    const { deps, added, proposes, proposeTimes } = makeDeps({
      readLiveSwitchroomConfigText: () => declaredYaml,
    })
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    const res = await executeMentalModelPropose({ chat_id: '123', name: 'existing-model', source_query: 'q' })
    expect(res.content[0]!.text).toMatch(/ALREADY a declared mental model/)
    expect(proposes.map.size).toBe(0)
    expect(added).toHaveLength(0)
    expect(proposeTimes).toHaveLength(0)
  })

  it('a DIFFERENT name passes the dup guard against the same declared config', async () => {
    const { deps, proposes } = makeDeps({
      readLiveSwitchroomConfigText: () => declaredYaml,
    })
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    const res = await executeMentalModelPropose({ chat_id: '123', name: 'new-model', source_query: 'q' })
    expect(res.content[0]!.text).toMatch(/card sent/)
    expect(proposes.map.size).toBe(1)
  })

  it('config-read failure fails OPEN to the card flow (approve path re-checks)', async () => {
    const { deps, proposes } = makeDeps({
      readLiveSwitchroomConfigText: () => {
        throw new Error('yaml unreadable')
      },
    })
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    const res = await executeMentalModelPropose({ chat_id: '123', name: 'm', source_query: 'q' })
    expect(res.content[0]!.text).toMatch(/card sent/)
    expect(proposes.map.size).toBe(1)
  })

  it('rejects an over-cap source_query with the schema-cap error; NO budget consumed', async () => {
    const { deps, proposeTimes } = makeDeps({ MENTAL_MODEL_SOURCE_QUERY_MAX: 20 })
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    await expect(
      executeMentalModelPropose({ chat_id: '1', name: 'm', source_query: 'x'.repeat(21) }),
    ).rejects.toThrow(/schema caps it at 20/)
    expect(proposeTimes).toHaveLength(0)
  })

  it('rejects over-cap and non-positive-integer max_tokens', async () => {
    const { deps } = makeDeps({ MENTAL_MODEL_MAX_TOKENS_CAP: 100 })
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    await expect(
      executeMentalModelPropose({ chat_id: '1', name: 'm', source_query: 'q', max_tokens: 101 }),
    ).rejects.toThrow(/exceeds the schema cap of 100/)
    await expect(
      executeMentalModelPropose({ chat_id: '1', name: 'm', source_query: 'q', max_tokens: 1.5 }),
    ).rejects.toThrow(/positive integer/)
    await expect(
      executeMentalModelPropose({ chat_id: '1', name: 'm', source_query: 'q', max_tokens: 0 }),
    ).rejects.toThrow(/positive integer/)
  })

  it('rejects a non-slug name and missing required args', async () => {
    const { deps } = makeDeps()
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    await expect(
      executeMentalModelPropose({ chat_id: '1', name: 'bad name!', source_query: 'q' }),
    ).rejects.toThrow(/name must be a slug/)
    await expect(
      executeMentalModelPropose({ chat_id: '1', source_query: 'q' }),
    ).rejects.toThrow(/name is required/)
    await expect(
      executeMentalModelPropose({ chat_id: '1', name: 'm' }),
    ).rejects.toThrow(/source_query is required/)
    await expect(
      executeMentalModelPropose({ name: 'm', source_query: 'q' }),
    ).rejects.toThrow(/chat_id is required/)
  })

  it('accepts `why` as an alias for `reason` and a boolean-only refresh_after_consolidation', async () => {
    const { deps, proposes } = makeDeps()
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    await executeMentalModelPropose({ chat_id: '1', name: 'm', source_query: 'q', why: 'because' })
    const staged = [...proposes.map.values()][0] as { reason?: string }
    expect(staged.reason).toBe('because')
    await expect(
      executeMentalModelPropose({ chat_id: '1', name: 'm2', source_query: 'q', refresh_after_consolidation: 'yes' }),
    ).rejects.toThrow(/must be a boolean/)
  })

  it('enforces the allow-list before staging (deny throws, nothing staged, no budget)', async () => {
    const { deps, added, proposes, proposeTimes } = makeDeps({
      assertAllowedChat: () => {
        throw new Error('chat not allowed')
      },
    })
    const { executeMentalModelPropose } = createCardToolHandlers(deps)
    await expect(
      executeMentalModelPropose({ chat_id: '999', name: 'm', source_query: 'q' }),
    ).rejects.toThrow(/chat not allowed/)
    expect(proposes.map.size).toBe(0)
    expect(added).toHaveLength(0)
    expect(proposeTimes).toHaveLength(0)
  })
})
