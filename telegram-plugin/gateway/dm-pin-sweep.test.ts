import { describe, expect, it, vi } from 'vitest'
import {
  isDmChatId,
  collectDmChatIdsFromStores,
  createDmPinSweeper,
  type DmPinSweeperDeps,
} from './dm-pin-sweep'

// Synthetic chat IDs only (check-no-pii-secrets): positive = DM, negative =
// group/supergroup.
const DM_A = '5000001'
const DM_B = '5000002'
const GROUP = '-1002000000001'

describe('isDmChatId', () => {
  it('true for positive integer DM ids', () => {
    expect(isDmChatId(DM_A)).toBe(true)
    expect(isDmChatId('1')).toBe(true)
  })
  it('false for group/supergroup (negative), zero, non-integer, non-numeric', () => {
    expect(isDmChatId(GROUP)).toBe(false)
    expect(isDmChatId('-1')).toBe(false)
    expect(isDmChatId('0')).toBe(false)
    expect(isDmChatId('1.5')).toBe(false)
    expect(isDmChatId('abc')).toBe(false)
    expect(isDmChatId('')).toBe(false)
    expect(isDmChatId('Infinity')).toBe(false)
  })
})

describe('collectDmChatIdsFromStores', () => {
  it('collects distinct DM chat ids across all three stores and drops non-DMs', () => {
    const ids = collectDmChatIdsFromStores({
      statusPins: [{ chatId: DM_A }, { chatId: GROUP }, { chatId: DM_A }],
      activityCards: [{ chatId: DM_B }, { chatId: '0' }],
      queuedCards: [{ chatId: DM_A }, { chatId: '-77' }],
    })
    expect(new Set(ids)).toEqual(new Set([DM_A, DM_B]))
    expect(ids).toHaveLength(2)
  })
  it('handles missing store arrays', () => {
    expect(collectDmChatIdsFromStores({})).toEqual([])
    expect(collectDmChatIdsFromStores({ statusPins: [{ chatId: GROUP }] })).toEqual([])
  })
})

function makeDeps(overrides: Partial<DmPinSweeperDeps> = {}): {
  deps: DmPinSweeperDeps
  unpinAll: ReturnType<typeof vi.fn>
  pinSilent: ReturnType<typeof vi.fn>
} {
  const unpinAll = vi.fn(async () => undefined)
  const pinSilent = vi.fn(async () => undefined)
  const deps: DmPinSweeperDeps = {
    unpinAll,
    pinSilent,
    liveTrackedMessageIds: () => [],
    eligible: () => true,
    log: () => {},
    ...overrides,
  }
  return { deps, unpinAll, pinSilent }
}

describe('createDmPinSweeper', () => {
  it('DM with tracked pins: unpin-all exactly once, then re-pin exactly the live ids', async () => {
    const { deps, unpinAll, pinSilent } = makeDeps({
      liveTrackedMessageIds: (chatId) => (chatId === DM_A ? [111, 222] : []),
    })
    const sweeper = createDmPinSweeper(deps)
    await sweeper.sweep(DM_A)

    expect(unpinAll).toHaveBeenCalledTimes(1)
    expect(unpinAll).toHaveBeenCalledWith(DM_A)
    expect(pinSilent.mock.calls).toEqual([
      [DM_A, 111],
      [DM_A, 222],
    ])
    expect(sweeper.hasSwept(DM_A)).toBe(true)
  })

  it('DM with no tracked pins: unpin-all once, no re-pin', async () => {
    const { deps, unpinAll, pinSilent } = makeDeps()
    const sweeper = createDmPinSweeper(deps)
    await sweeper.sweep(DM_A)
    expect(unpinAll).toHaveBeenCalledTimes(1)
    expect(pinSilent).not.toHaveBeenCalled()
  })

  it('group/supergroup id: never unpin-all (keeps human pins)', async () => {
    const { deps, unpinAll, pinSilent } = makeDeps()
    const sweeper = createDmPinSweeper(deps)
    await sweeper.sweep(GROUP)
    await sweeper.sweep('-1')
    expect(unpinAll).not.toHaveBeenCalled()
    expect(pinSilent).not.toHaveBeenCalled()
  })

  it('not eligible (lost startup mutex): does nothing', async () => {
    const { deps, unpinAll } = makeDeps({ eligible: () => false })
    const sweeper = createDmPinSweeper(deps)
    await sweeper.sweep(DM_A)
    expect(unpinAll).not.toHaveBeenCalled()
    expect(sweeper.hasSwept(DM_A)).toBe(false)
  })

  it('second sweep of same chat does not re-sweep', async () => {
    const { deps, unpinAll } = makeDeps()
    const sweeper = createDmPinSweeper(deps)
    await sweeper.sweep(DM_A)
    await sweeper.sweep(DM_A)
    expect(unpinAll).toHaveBeenCalledTimes(1)
  })

  it('concurrent triggers on the same chat fire unpin-all only once', async () => {
    let resolveUnpin: () => void = () => {}
    const unpinAll = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveUnpin = res
        }),
    )
    const { deps } = makeDeps({ unpinAll })
    const sweeper = createDmPinSweeper(deps)
    const p1 = sweeper.sweep(DM_A)
    const p2 = sweeper.sweep(DM_A)
    resolveUnpin()
    await Promise.all([p1, p2])
    expect(unpinAll).toHaveBeenCalledTimes(1)
  })

  it('429 / unpin-all rejects: degrades without throwing, still re-pins live ids', async () => {
    const unpinAll = vi.fn(async () => {
      throw new Error('429: Too Many Requests: retry after 30')
    })
    const { deps, pinSilent } = makeDeps({
      unpinAll,
      liveTrackedMessageIds: () => [333],
    })
    const sweeper = createDmPinSweeper(deps)
    // Must not reject.
    await expect(sweeper.sweep(DM_A)).resolves.toBeUndefined()
    expect(unpinAll).toHaveBeenCalledTimes(1)
    expect(pinSilent).toHaveBeenCalledWith(DM_A, 333)
  })

  it('re-pin failure is absorbed and does not reject', async () => {
    const pinSilent = vi.fn(async () => {
      throw new Error('pin failed')
    })
    const { deps } = makeDeps({
      pinSilent,
      liveTrackedMessageIds: () => [444],
    })
    const sweeper = createDmPinSweeper(deps)
    await expect(sweeper.sweep(DM_A)).resolves.toBeUndefined()
  })

  it('no unhandled rejection escapes a failing sweep (fire-and-forget safe)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (r: unknown): void => {
      unhandled.push(r)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { deps } = makeDeps({
        unpinAll: async () => {
          throw new Error('boom')
        },
        liveTrackedMessageIds: () => [555],
      })
      const sweeper = createDmPinSweeper(deps)
      // Fire-and-forget, as the gateway does.
      void sweeper.sweep(DM_A)
      await new Promise((r) => setTimeout(r, 10))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})
