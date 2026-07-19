import { describe, it, expect } from 'vitest'
import {
  createWorkerActivityFeed,
  type WorkerActivityView,
  type BotApiForWorkerFeed,
} from '../worker-activity-feed.js'
import { reconcilePin, type PinBotApi } from '../status-pin-driver.js'
import { decidePinAction, type PinState, type DesiredPin } from '../status-pin.js'
import {
  reconcileAndPersistStatusPin,
  loadStatusPins,
  type StatusPinStoreFsSeam,
} from '../gateway/status-pin-store.js'

/**
 * Outcome tests for the invisible-worker-cards fix (2026-07-15).
 *
 * Root cause: the worker feed reuses ONE shared group message per chat for the
 * whole time workers overlap, but `syncPin` was called only at lifecycle edges
 * (first-paint / terminal / GC) — NEVER on the steady-state edit path. So once
 * the pin was lost out-of-band (its in-memory claim dropped), the reused message
 * kept being edited live but was never re-pinned → scroll-buried / invisible.
 *
 * These tests wire the feed's `reconcilePin` hook into the REAL status-pin
 * driver + a claim map exactly as the gateway does (`wk:group:<feedKey>` key,
 * `void reconcileStatusPin`), and assert the PIN-CALL OUTCOMES:
 *   1. a steady-state edit re-pins when the claim was lost — and does NOT re-pin
 *      (no storm) when the claim is already correct.
 *   2. routing an unpin through the reconciler CLEARS the claim, so a later edit
 *      re-pins.
 *   3. the group-message lifetime cap ROTATES to a fresh message id and re-
 *      establishes the pin on the new message.
 */

function view(partial: Partial<WorkerActivityView> = {}): WorkerActivityView {
  return {
    description: 'background task',
    lastTool: { name: 'Bash', sanitisedArg: 'grep -r x' },
    toolCount: 1,
    latestSummary: 'working',
    elapsedMs: 10_000,
    state: 'running',
    ...partial,
  }
}

interface FakeBot extends BotApiForWorkerFeed {
  sent: Array<{ chatId: string; messageId: number; text: string }>
  edits: Array<{ messageId: number; text: string }>
}

function makeFakeBot(): FakeBot {
  let nextId = 1000
  const fb: FakeBot = {
    sent: [],
    edits: [],
    sendMessage: async (chatId, text) => {
      const message_id = nextId++
      fb.sent.push({ chatId, messageId: message_id, text })
      return { message_id }
    },
    editMessageText: async (_chatId, messageId, text) => {
      fb.edits.push({ messageId, text })
      return {}
    },
  }
  return fb
}

/**
 * Mirror the gateway's status-pin reconcile: a `Map<key,PinState>` claim store
 * driven through the real `reconcilePin` driver against a fake pin API that
 * records every pin/unpin call. This is the seam that turns a `reconcilePin`
 * hook call into an observable Telegram pin/unpin — proving OUTCOMES, not paths.
 */
function makePinHarness() {
  const state = new Map<string, PinState>()
  const pinCalls: number[] = []
  const unpinCalls: number[] = []
  let lastKey: string | null = null
  const api: PinBotApi = {
    pinChatMessage: async (_chat, message_id) => {
      pinCalls.push(message_id)
    },
    unpinChatMessage: async (_chat, message_id) => {
      unpinCalls.push(message_id)
    },
  }
  async function reconcile(key: string, chatId: string, desired: DesiredPin): Promise<void> {
    const prev = state.get(key) ?? null
    const next = await reconcilePin({ api, chatId, prevState: prev, desired })
    if (next == null) state.delete(key)
    else state.set(key, next)
  }
  const reconcilePinFn = (args: {
    feedKey: string
    chatId: string
    threadId?: number
    messageId: number | null
  }): void => {
    const key = `wk:group:${args.feedKey}`
    lastKey = key
    if (args.messageId != null) void reconcile(key, args.chatId, { pinned: true, messageId: args.messageId })
    else void reconcile(key, args.chatId, { pinned: false })
  }
  return {
    state,
    pinCalls,
    unpinCalls,
    reconcilePinFn,
    key: (): string => {
      if (lastKey == null) throw new Error('no reconcile happened yet')
      return lastKey
    },
    /** Directly drop the claim to simulate a pin lost out-of-band. */
    dropClaim(): void {
      state.clear()
    },
  }
}

/** Flush the microtask queue so fire-and-forget `void reconcile(...)` settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}

/** In-memory fs seam with atomic rename, mirroring status-pin-store.test.ts. */
function memFs(): { fs: StatusPinStoreFsSeam; files: Map<string, string> } {
  const files = new Map<string, string>()
  const fs: StatusPinStoreFsSeam = {
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`)
      return files.get(p)!
    },
    writeFileSync: (p, d) => {
      files.set(p, d)
    },
    renameSync: (a, b) => {
      if (!files.has(a)) throw new Error(`ENOENT ${a}`)
      files.set(b, files.get(a)!)
      files.delete(a)
    },
    existsSync: (p) => files.has(p),
  }
  return { fs, files }
}

/**
 * A pin harness that routes the feed's `reconcilePin` hook through the REAL
 * persistence path (`reconcileAndPersistStatusPin`) against a memFs-backed
 * status-pins.json — exactly as the gateway wires it: read prev claim → decide
 * → map to a persist op → reconcileAndPersistStatusPin(applyPin=reconcilePin).
 * This lets a test INSPECT THE FILE across steady-state edits (F1).
 */
function makePersistingPinHarness(path: string) {
  const { fs } = memFs()
  const claims = new Map<string, PinState>()
  const pinCalls: number[] = []
  const unpinCalls: number[] = []
  const api: PinBotApi = {
    pinChatMessage: async (_c, id) => {
      pinCalls.push(id)
    },
    unpinChatMessage: async (_c, id) => {
      unpinCalls.push(id)
    },
  }
  async function reconcile(key: string, chatId: string, desired: DesiredPin): Promise<void> {
    const prev = claims.get(key) ?? null
    const action = decidePinAction(prev, desired)
    const op = action.kind === 'pin'
      ? ({ kind: 'pin', messageId: action.messageId } as const)
      : ({ kind: 'clear' } as const)
    const next = await reconcileAndPersistStatusPin({
      path,
      fs,
      pinKey: key,
      chatId,
      op,
      applyPin: () => reconcilePin({ api, chatId, prevState: prev, desired }),
      log: () => {},
    })
    if (next == null) claims.delete(key)
    else claims.set(key, next)
  }
  const reconcilePinFn = (args: {
    feedKey: string
    chatId: string
    threadId?: number
    messageId: number | null
  }): void => {
    const key = `wk:group:${args.feedKey}`
    if (args.messageId != null) void reconcile(key, args.chatId, { pinned: true, messageId: args.messageId })
    else void reconcile(key, args.chatId, { pinned: false })
  }
  return {
    reconcilePinFn,
    fs,
    pinCalls,
    unpinCalls,
    rows: () => loadStatusPins(path, fs),
  }
}

describe('worker-feed pin persistence — durable status-pins.json survives steady-state edits (F1)', () => {
  const PATH = '/state/agent/telegram/status-pins.json'

  it('preserves the wk:group row across many steady-state edits (noop-clear must NOT delete it)', async () => {
    const bot = makeFakeBot()
    const pin = makePersistingPinHarness(PATH)
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      reconcilePin: pin.reconcilePinFn,
    })

    // First paint → message posted, pinned once, durable row written.
    clock = 1000
    await feed.update('w1', 'chat', view({ elapsedMs: 1000, toolCount: 1 }))
    await flush()
    const msgId = bot.sent[0].messageId
    expect(pin.pinCalls).toEqual([msgId])
    expect(pin.rows()).toHaveLength(1)
    const pinKey = pin.rows()[0].pinKey
    expect(pinKey).toMatch(/^wk:group:/)
    expect(pin.rows()).toEqual([
      { pinKey, chatId: 'chat', messageId: msgId },
    ])

    // Many steady-state edits — the feed calls syncPin on EVERY edit, each a
    // re-pin of the SAME id → noop → a `clear` op with a LIVE claim. Pre-fix the
    // clear branch deleted the durable row here; the fix preserves it.
    for (let i = 2; i <= 8; i++) {
      clock = i * 1000
      await feed.update('w1', 'chat', view({ elapsedMs: i * 1000, toolCount: i }))
      await flush()
    }

    // The durable row is STILL on disk (inspect the file), and no extra pin/
    // unpin API call was issued across all those steady-state edits.
    expect(pin.rows()).toEqual([
      { pinKey, chatId: 'chat', messageId: msgId },
    ])
    expect(pin.pinCalls).toEqual([msgId]) // exactly one pin, ever
    expect(pin.unpinCalls).toEqual([]) // never unpinned
  })
})

describe('worker-feed pin persistence — steady-state re-pin (invisible-worker-cards)', () => {
  it('re-pins on a steady-state edit when the claim was lost, and does NOT re-pin when already correct (no storm)', async () => {
    const bot = makeFakeBot()
    const pin = makePinHarness()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      reconcilePin: pin.reconcilePinFn,
    })

    // First paint → message posted AND pinned once.
    clock = 1000
    await feed.update('w1', 'chat', view({ elapsedMs: 1000, toolCount: 1 }))
    await flush()
    expect(bot.sent).toHaveLength(1)
    const msgId = bot.sent[0].messageId
    expect(pin.pinCalls).toEqual([msgId])
    expect(pin.state.get(pin.key())?.messageId).toBe(msgId)

    // Steady-state edit while the pin is already correct → NO new pin (no storm).
    clock = 2000
    await feed.update('w1', 'chat', view({ elapsedMs: 2000, toolCount: 5 }))
    await flush()
    expect(bot.edits.length).toBeGreaterThanOrEqual(1)
    expect(pin.pinCalls).toEqual([msgId]) // still exactly one pin — decidePinAction no-op'd

    // Pin lost out-of-band (claim dropped) → next steady edit must re-pin.
    pin.dropClaim()
    clock = 3000
    await feed.update('w1', 'chat', view({ elapsedMs: 3000, toolCount: 9 }))
    await flush()
    expect(pin.pinCalls).toEqual([msgId, msgId]) // re-pinned the SAME live message
    expect(pin.state.get(pin.key())?.messageId).toBe(msgId)
  })
})

describe('worker-feed pin persistence — unpin clears the claim', () => {
  it('an unpin routed through the reconciler clears the claim so a later edit re-pins', async () => {
    const bot = makeFakeBot()
    const pin = makePinHarness()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      reconcilePin: pin.reconcilePinFn,
    })

    clock = 1000
    await feed.update('w1', 'chat', view({ elapsedMs: 1000, toolCount: 1 }))
    await flush()
    const msgId = bot.sent[0].messageId
    const key = pin.key()
    expect(pin.state.get(key)?.messageId).toBe(msgId)

    // Route an unpin of the worker message through the reconciler (the sanctioned
    // path): the claim is dropped AND the Telegram unpin is issued.
    await (async () => {
      const prev = pin.state.get(key) ?? null
      const next = await reconcilePin({
        api: {
          pinChatMessage: async () => {},
          unpinChatMessage: async (_c, id) => {
            pin.unpinCalls.push(id)
          },
        },
        chatId: 'chat',
        prevState: prev,
        desired: { pinned: false },
      })
      if (next == null) pin.state.delete(key)
      else pin.state.set(key, next)
    })()
    expect(pin.state.has(key)).toBe(false) // claim cleared
    expect(pin.unpinCalls).toContain(msgId)

    // A later steady edit now re-pins (the claim being clear is what lets
    // decidePinAction issue a fresh pin instead of a stale-id no-op).
    clock = 2000
    await feed.update('w1', 'chat', view({ elapsedMs: 2000, toolCount: 7 }))
    await flush()
    expect(pin.pinCalls).toContain(msgId)
    expect(pin.state.get(key)?.messageId).toBe(msgId)
  })
})

describe('worker-feed pin persistence — group-message lifetime cap rotation', () => {
  it('rotates to a fresh message past the cap and re-establishes the pin on the new id', async () => {
    const bot = makeFakeBot()
    const pin = makePinHarness()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      heartbeatTickMs: 6000,
      groupMessageLifetimeCapMs: 30_000,
      reconcilePin: pin.reconcilePinFn,
    })

    // First paint → message A posted + pinned.
    clock = 1000
    await feed.update('w1', 'chat', view({ elapsedMs: 1000, toolCount: 1 }))
    await flush()
    const msgA = bot.sent[0].messageId
    expect(pin.pinCalls).toEqual([msgA])

    // Worker keeps running; advance well past the 30s message cap, then tick.
    clock = 40_000
    await feed.update('w1', 'chat', view({ elapsedMs: 40_000, toolCount: 4 }))
    await flush()
    feed.heartbeatTick()
    await flush()

    // A SECOND message was posted (rotation) and it is a DIFFERENT id.
    expect(bot.sent).toHaveLength(2)
    const msgB = bot.sent[1].messageId
    expect(msgB).not.toBe(msgA)
    expect(feed.messageIdOf('w1')).toBe(msgB)

    // The stale message was unpinned and the fresh one pinned → pin surface
    // re-established on the new id (deterministic, no burst: one unpin + one pin).
    expect(pin.unpinCalls).toContain(msgA)
    expect(pin.pinCalls).toContain(msgB)
    expect(pin.state.get(pin.key())?.messageId).toBe(msgB)

    // FIX 1: the retired message was collapsed to the honest "moved" note with
    // exactly ONE edit (not left frozen showing live rows, not re-edited per tick).
    const supersedeEdits = bot.edits.filter(
      (e) => e.messageId === msgA && e.text.includes('Live progress moved to a fresh card'),
    )
    expect(supersedeEdits).toHaveLength(1)
  })

  it('rotation preserves ALL live overlapping worker rows on the fresh message (none dropped/double-counted)', async () => {
    const bot = makeFakeBot()
    const pin = makePinHarness()
    let clock = 0
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock,
      firstPaintMinMs: 0,
      minEditIntervalMs: 0,
      heartbeatTickMs: 6000,
      groupMessageLifetimeCapMs: 30_000,
      reconcilePin: pin.reconcilePinFn,
    })

    // Two workers overlap in the SAME chat → one combined group message.
    clock = 1000
    await feed.update('w1', 'chat', view({ description: 'alpha task', elapsedMs: 1000 }))
    await flush()
    clock = 1100
    await feed.update('w2', 'chat', view({ description: 'beta task', elapsedMs: 1100 }))
    await flush()
    const msgA = bot.sent[0].messageId
    // Both workers share the one message.
    expect(feed.messageIdOf('w1')).toBe(msgA)
    expect(feed.messageIdOf('w2')).toBe(msgA)

    // Advance past the cap with BOTH still live, then tick to rotate.
    clock = 40_000
    await feed.update('w1', 'chat', view({ description: 'alpha task', elapsedMs: 40_000, toolCount: 3 }))
    await flush()
    feed.heartbeatTick()
    await flush()

    // A fresh message was posted and BOTH live workers moved to it — no row
    // dropped, no worker orphaned on the retired card.
    expect(bot.sent).toHaveLength(2)
    const fresh = bot.sent[1]
    expect(fresh.messageId).not.toBe(msgA)
    expect(feed.messageIdOf('w1')).toBe(fresh.messageId)
    expect(feed.messageIdOf('w2')).toBe(fresh.messageId)
    // The fresh combined body renders BOTH workers' rows.
    expect(fresh.text).toContain('alpha task')
    expect(fresh.text).toContain('beta task')
    expect(feed.size).toBe(2)
  })
})
