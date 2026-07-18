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
    pendingCardStore: {
      add: (e: unknown) => void added.push(e),
      remove: (id: string) => void removed.push(id),
    } as unknown as CardToolHandlersDeps['pendingCardStore'],
    ...overrides,
  }
  return { deps, added, removed, allowedChats, saves }
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
