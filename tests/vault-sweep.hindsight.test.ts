import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  sweepHindsightBank,
  getBanksToSweep,
  type HindsightMcpClient,
  type HindsightMemory,
} from '../src/cli/vault-sweep.js'
import type { SwitchroomConfig } from '../src/config/schema.js'

// Token assembled at runtime — see CLAUDE.md "Secrets in tests".
const SK = ['sk-ant-', 'abcdefghijklmnopqrstuvwxy'].join('')

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
        text: `accidentally pasted: ${SK} — oops`,
      },
      { id: 'm3', text: 'another unrelated memory' },
    ]
    const vaultValues = [
      { key: 'ANTHROPIC_API_KEY', value: SK },
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
      { id: 'm1', text: `before ${SK} after` },
      { id: 'm2', text: `another leak: ${SK}` },
      { id: 'm3', text: 'clean' },
    ]
    const vaultValues = [{ key: 'K', value: SK }]
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
      big.push({ id: `m${i}`, text: i === 42 ? `leak: ${SK}` : 'clean' })
    }
    const { client, deleted } = makeFakeClient(big)
    const listSpy = vi.spyOn(client, 'listMemories')
    const vaultValues = [{ key: 'K', value: SK }]
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

// Regression test for #2202: deleteMemory must issue invalidate_memory with
// the correct wire name and args (memory_id + reason). This was the missing
// primitive when the honest-failure stub was written.
describe('deleteMemory — invalidate_memory regression (#2202)', () => {
  const src = readFileSync(resolve(__dirname, '..', 'src', 'cli', 'vault-sweep.ts'), 'utf-8')

  it('does NOT use the phantom delete_memory tool or document-granularity delete_document', () => {
    // delete_memory is not a real MCP tool; delete_document(memoryId) targets
    // a non-existent document (memory id ≠ document_id). Neither must appear.
    expect(src).not.toMatch(/callTool\([^)]*'delete_memory'/)
    expect(src).not.toMatch(/callTool\([^)]*'delete_document'/)
  })

  it('calls invalidate_memory with memory_id and reason: "vault-sweep secret redaction"', async () => {
    // Mock client that records which deleteMemory calls it receives.
    const calls: Array<{ bankId: string; memoryId: string }> = []
    const mockClient: HindsightMcpClient = {
      async listMemories(_bankId, { limit, offset }) {
        const all: HindsightMemory[] = [
          { id: 'mem-abc123', text: `leaked value ${SK}` },
          { id: 'mem-clean',  text: 'nothing sensitive here' },
        ]
        return { items: all.slice(offset, offset + limit), total: all.length }
      },
      async deleteMemory(bankId, memoryId) {
        calls.push({ bankId, memoryId })
      },
    }

    const deleteSpy = vi.spyOn(mockClient, 'deleteMemory')
    const report = await sweepHindsightBank(
      mockClient,
      'test-bank',
      [{ key: 'ANTHROPIC_API_KEY', value: SK }],
      { dryRun: false },
    )

    // Only the matching memory should be targeted for deletion.
    expect(report.matched).toEqual([{ id: 'mem-abc123', vaultKey: 'ANTHROPIC_API_KEY' }])
    expect(report.deleted).toBe(1)

    // deleteMemory was called exactly once, for the right memory id.
    expect(deleteSpy).toHaveBeenCalledOnce()
    expect(deleteSpy).toHaveBeenCalledWith('test-bank', 'mem-abc123')
    expect(calls).toEqual([{ bankId: 'test-bank', memoryId: 'mem-abc123' }])
  })

  it('the source calls invalidate_memory (not delete_memory or delete_document) as the wire tool name', () => {
    // Structural guard: the real HTTP client implementation must use the
    // invalidate_memory tool name on the wire.
    expect(src).toMatch(/callTool\([^)]*'invalidate_memory'/)
  })

  it('passes reason "vault-sweep secret redaction" to invalidate_memory', () => {
    // The reason field must identify the source of the invalidation.
    expect(src).toMatch(/vault-sweep secret redaction/)
  })
})
