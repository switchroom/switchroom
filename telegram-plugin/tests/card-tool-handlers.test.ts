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
    pendingCardStore: {
      add: (e: unknown) => void added.push(e),
      remove: (id: string) => void removed.push(id),
    } as unknown as CardToolHandlersDeps['pendingCardStore'],
    // Default: broker sees no keys (no standing ACL) — normal card flow.
    listViaBroker: async () => [],
    VAULT_REQUEST_ACCESS_TTL_MS: 10 * 60_000,
    ...overrides,
  }
  return { deps, added, removed, allowedChats, saves, accesses }
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
