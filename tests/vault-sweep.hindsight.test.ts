import { describe, it, expect, vi } from 'vitest'
import {
  sweepHindsightBank,
  getBanksToSweep,
  type HindsightMcpClient,
  type HindsightMemory,
} from '../src/cli/vault-sweep.js'
import type { SwitchroomConfig } from '../src/config/schema.js'

/** Build a fake client backed by an in-memory memory list. */
function makeFakeClient(initial: HindsightMemory[]): {
  client: HindsightMcpClient
  deleted: string[]
} {
  const memories = [...initial]
  const deleted: string[] = []
  const client: HindsightMcpClient = {
    async listMemories(_bankId, { limit, offset }) {
      const slice = memories.slice(offset, offset + limit)
      return { items: slice, total: memories.length }
    },
    async deleteMemory(_bankId, memoryId) {
      deleted.push(memoryId)
    },
  }
  return { client, deleted }
}

describe('sweepHindsightBank', () => {
  it('deletes only memories whose text contains a vault value', async () => {
    const memories: HindsightMemory[] = [
      { id: 'm1', text: 'Innocent note, no secrets here.' },
      {
        id: 'm2',
        text: 'accidentally pasted: sk-ant-abcdefghijklmnopqrstuvwxy — oops',
      },
      { id: 'm3', text: 'another unrelated memory' },
    ]
    const vaultValues = [
      { key: 'ANTHROPIC_API_KEY', value: 'sk-ant-abcdefghijklmnopqrstuvwxy' },
      { key: 'UNUSED', value: 'not-in-any-memory' },
    ]
    const { client, deleted } = makeFakeClient(memories)
    const report = await sweepHindsightBank(client, 'bank-a', vaultValues, {
      dryRun: false,
    })
    expect(report.matched).toEqual([{ id: 'm2', vaultKey: 'ANTHROPIC_API_KEY' }])
    expect(report.deleted).toBe(1)
    expect(deleted).toEqual(['m2'])
  })

  it('matches on the context field as well as text', async () => {
    // Token assembled at runtime — see CLAUDE.md "Secrets in tests".
    const GH_FIXTURE = 'ghp' + '_' + '16C7e42F292c6912E7710c838347Ae178B4a'
    const memories: HindsightMemory[] = [
      {
        id: 'm1',
        text: 'fine',
        context: 'ran with ' + GH_FIXTURE,
      },
    ]
    const vaultValues = [
      { key: 'GH_TOKEN', value: GH_FIXTURE },
    ]
    const { client, deleted } = makeFakeClient(memories)
    const report = await sweepHindsightBank(client, 'bank-a', vaultValues, {
      dryRun: false,
    })
    expect(report.matched).toHaveLength(1)
    expect(deleted).toEqual(['m1'])
  })

  it('does not delete on dry-run, but still reports matches', async () => {
    const memories: HindsightMemory[] = [
      { id: 'm1', text: 'before sk-ant-abcdefghijklmnopqrstuvwxy after' },
      { id: 'm2', text: 'another leak: sk-ant-abcdefghijklmnopqrstuvwxy' },
      { id: 'm3', text: 'clean' },
    ]
    const vaultValues = [{ key: 'K', value: 'sk-ant-abcdefghijklmnopqrstuvwxy' }]
    const { client, deleted } = makeFakeClient(memories)
    const deleteSpy = vi.spyOn(client, 'deleteMemory')
    const report = await sweepHindsightBank(client, 'bank-a', vaultValues, {
      dryRun: true,
    })
    expect(report.matched.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(report.deleted).toBe(0)
    expect(deleted).toEqual([])
    expect(deleteSpy).not.toHaveBeenCalled()
  })

  it('skips vault values shorter than 8 bytes (too-common-substring safety)', async () => {
    const memories: HindsightMemory[] = [
      { id: 'm1', text: 'the quick brown fox jumps over the lazy dog' },
    ]
    // 6-char value should NOT match even though "the" and "dog" are substrings.
    const vaultValues = [{ key: 'SHORT', value: 'quick' }]
    const { client } = makeFakeClient(memories)
    const report = await sweepHindsightBank(client, 'bank-a', vaultValues, {
      dryRun: false,
    })
    expect(report.matched).toEqual([])
  })

  it('paginates through multiple pages', async () => {
    const big: HindsightMemory[] = []
    for (let i = 0; i < 250; i++) {
      big.push({ id: `m${i}`, text: i === 42 ? 'leak: sk-ant-abcdefghijklmnopqrstuvwxy' : 'clean' })
    }
    const { client, deleted } = makeFakeClient(big)
    const listSpy = vi.spyOn(client, 'listMemories')
    const vaultValues = [{ key: 'K', value: 'sk-ant-abcdefghijklmnopqrstuvwxy' }]
    const report = await sweepHindsightBank(client, 'bank-a', vaultValues, {
      dryRun: false,
      pageSize: 100,
    })
    // 3 pages: 0-99, 100-199, 200-249.
    expect(listSpy).toHaveBeenCalledTimes(3)
    expect(report.matched).toHaveLength(1)
    expect(report.matched[0]!.id).toBe('m42')
    expect(deleted).toEqual(['m42'])
  })

  it('does nothing when the bank is empty', async () => {
    const { client, deleted } = makeFakeClient([])
    const report = await sweepHindsightBank(client, 'bank-a', [
      { key: 'K', value: 'anything-at-least-eight' },
    ], { dryRun: false })
    expect(report.matched).toEqual([])
    expect(deleted).toEqual([])
  })
})

describe('getBanksToSweep', () => {
  it('lists the default per-agent bank (agent name) for each agent', () => {
    const cfg = {
      switchroom: { version: 1 },
      agents: {
        alpha: {},
        beta: {},
      },
    } as unknown as SwitchroomConfig
    expect(getBanksToSweep(cfg).sort()).toEqual(['alpha', 'beta'])
  })

  it('honors memory.collection overrides and dedupes', () => {
    const cfg = {
      switchroom: { version: 1 },
      agents: {
        alpha: { memory: { collection: 'shared' } },
        beta: { memory: { collection: 'shared' } },
        gamma: {},
      },
    } as unknown as SwitchroomConfig
    expect(getBanksToSweep(cfg).sort()).toEqual(['gamma', 'shared'])
  })

  it('returns [] when config is undefined or has no agents', () => {
    expect(getBanksToSweep(undefined)).toEqual([])
    expect(getBanksToSweep({ switchroom: { version: 1 }, agents: {} } as unknown as SwitchroomConfig)).toEqual([])
  })
})
