/**
 * status-pin lifecycle — OUTCOME tests for the UNIFIED pin/unpin path (#3831).
 *
 * What this file is for
 * ---------------------
 * The status-pin subsystem kept regressing because its tests asserted the shape
 * of individual functions rather than what Telegram ends up holding pinned. This
 * suite drives the REAL modules the gateway composes —
 *
 *   runStatusPinReconcile  (the single decider + the ONLY retarget expansion)
 *     → reconcileAndPersistStatusPin  (persist-BEFORE-pin, durable rows)
 *       → executePinLeg               (the driver: one already-decided leg)
 *         → a fake Bot API at the boundary
 *
 * — plus the real boot cleanup, the real worker-pin reap decision, and the real
 * narrative lane, and asserts the OBSERVABLE pin/unpin API calls and the
 * resulting pinned set, across the whole lifecycle:
 *
 *   claim → retarget → worker pin → restart with a stale claim → SIGTERM →
 *   bridge flap → done.
 *
 * The only fakes are at the boundary (Bot API, filesystem, clock, registry
 * lookups). Nothing here re-implements a decision the gateway makes.
 */
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { createNarrativeLane } from '../gateway/narrative-lane.js'
import type { CurrentTurn, NarrativeLaneDeps } from '../gateway/gateway.js'
import { executePinLeg, type PinBotApi } from '../status-pin-driver.js'
import type { DesiredPin, PinState } from '../status-pin.js'
import {
  runStatusPinReconcile,
  type StatusPinClaim,
} from '../gateway/status-pin-retarget.js'
import {
  loadStatusPins,
  mutateStatusPinRow,
  runStatusPinBootCleanup,
  type StatusPinStoreFsSeam,
} from '../gateway/status-pin-store.js'
import {
  decideWorkerPinReaps,
  groupPinStatus,
  storeOnlyWorkerPinCandidates,
  type WorkerFeedLivenessProbe,
  type WorkerRegistryStatus,
} from '../gateway/worker-pin-reaper.js'

const PATH = '/state/agent/telegram/status-pins.json'
const CHAT = '-1001'
const HOUR = 60 * 60_000

// ── boundary fakes ────────────────────────────────────────────────────────

/** In-memory fs seam with atomic rename, mirroring the real store's usage. */
function memFs(): StatusPinStoreFsSeam {
  const files = new Map<string, string>()
  return {
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
}

/**
 * A fake Telegram that maintains the REAL observable: which messages are
 * currently pinned. Every call is also logged in order, so a test can assert
 * ordering (e.g. #3812's unpin-before-delete) and call counts (no pin storms).
 */
function fakeTelegram() {
  const pinned = new Set<string>() // `${chatId}:${messageId}`
  const calls: Array<{ verb: 'pin' | 'unpin' | 'delete'; chatId: string; messageId: number }> = []
  const api: PinBotApi = {
    pinChatMessage: async (chat_id, message_id) => {
      calls.push({ verb: 'pin', chatId: String(chat_id), messageId: message_id })
      pinned.add(`${chat_id}:${message_id}`)
    },
    unpinChatMessage: async (chat_id, message_id) => {
      calls.push({ verb: 'unpin', chatId: String(chat_id), messageId: message_id })
      pinned.delete(`${chat_id}:${message_id}`)
    },
  }
  return {
    api,
    calls,
    pinned,
    ids: (): number[] => [...pinned].map((s) => Number(s.split(':')[1])).sort((a, b) => a - b),
    verbs: (): string[] => calls.map((c) => `${c.verb}:${c.messageId}`),
    /** Delete a message out from under the pin (what a card teardown does). */
    deleted: (chatId: string, messageId: number) => {
      calls.push({ verb: 'delete', chatId, messageId })
      pinned.delete(`${chatId}:${messageId}`)
    },
  }
}

/**
 * The gateway's status-pin subsystem, wired the way gateway.ts wires it:
 * ONE claim registry, the unified reconcile, the durable store, the boot
 * cleanup, the SIGTERM sweep, and the mid-session `wk:` reaper.
 *
 * A "restart" is `makeSubsystem(fs, tg)` again over the SAME fs + Telegram:
 * fresh claims, same durable rows, same live pins.
 */
function makeSubsystem(fs: StatusPinStoreFsSeam, tg: ReturnType<typeof fakeTelegram>) {
  const claims = new Map<string, StatusPinClaim>()

  async function reconcileStatusPin(
    pinKey: string,
    chatId: string,
    desired: DesiredPin,
    now = Date.now(),
  ): Promise<void> {
    const claim = claims.get(pinKey)
    const prev: PinState | null = claim == null ? null : { messageId: claim.messageId }
    await runStatusPinReconcile({
      pinKey,
      chatId,
      prev,
      desired,
      persist: { path: PATH, fs },
      runPin: (action, from) =>
        executePinLeg({ api: tg.api, chatId, prevState: from, action }),
      claims,
      now: () => now,
    })
  }

  /** gateway.ts `unpinAllStatusPins` — the SIGTERM sweep. */
  async function sigtermSweep(): Promise<void> {
    for (const [key, claim] of [...claims.entries()]) {
      await reconcileStatusPin(key, claim.chatId, { pinned: false })
    }
  }

  /** gateway.ts boot cleanup over the durable rows. */
  async function bootCleanup() {
    return runStatusPinBootCleanup({
      path: PATH,
      fs,
      unpin: (chatId, messageId) => tg.api.unpinChatMessage(chatId, messageId),
      log: () => {},
    })
  }

  /**
   * gateway.ts's mid-session `wk:` reaper block, verbatim in structure: build
   * in-memory candidates off the single claim registry, fold in durable
   * store-orphans, decide, then execute each reap through the sanctioned path.
   */
  async function midSessionWorkerReap(opts: {
    now: number
    ttlMs: number
    statusOf?: (agentId: string) => WorkerRegistryStatus
    feed?: WorkerFeedLivenessProbe | null
  }): Promise<void> {
    const inMemoryCandidates = [...claims.entries()]
      .filter(([k]) => k.startsWith('wk:'))
      .map(([pinKey, c]) => ({ pinKey, chatId: c.chatId, pinnedAt: c.pinnedAt }))
    const inMemoryKeys = new Set(inMemoryCandidates.map((c) => c.pinKey))
    const storeOnly = storeOnlyWorkerPinCandidates({
      rows: loadStatusPins(PATH, fs),
      inMemoryPinKeys: inMemoryKeys,
      now: opts.now,
    })
    const storeOnlyKeys = new Set(storeOnly.map((c) => c.pinKey))
    const reaps = decideWorkerPinReaps({
      pins: [...inMemoryCandidates, ...storeOnly],
      statusOf: (agentId) => {
        if (agentId.startsWith('group:')) {
          return groupPinStatus(opts.feed, agentId.slice('group:'.length))
        }
        return opts.statusOf?.(agentId) ?? 'unknown'
      },
      ttlMs: opts.ttlMs,
      now: opts.now,
    })
    for (const reap of reaps) {
      if (storeOnlyKeys.has(reap.pinKey) && reap.messageId != null) {
        await tg.api.unpinChatMessage(reap.chatId, reap.messageId)
        await mutateStatusPinRow(PATH, fs, reap.pinKey, null)
      } else {
        await reconcileStatusPin(reap.pinKey, reap.chatId, { pinned: false })
      }
    }
  }

  return { claims, reconcileStatusPin, sigtermSweep, bootCleanup, midSessionWorkerReap }
}

function rowIds(fs: StatusPinStoreFsSeam): Array<[string, number]> {
  return loadStatusPins(PATH, fs).map((r) => [r.pinKey, r.messageId])
}

// ── 1. claim → retarget → done ────────────────────────────────────────────

describe('lifecycle — claim, retarget, release (the fg: activity card)', () => {
  it('a RETARGET leaves the NEW message pinned and the OLD one unpinned, with a durable row naming the new id', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)

    // Turn opens: the card is claimed.
    await gw.reconcileStatusPin('fg:c:1', CHAT, { pinned: true, messageId: 100 }, 1_000)
    expect(tg.ids()).toEqual([100])

    // Ack-first reopen mid-turn: a FRESH card, ONE reconcile, no re-drive.
    // Pre-#3196 this reported a bare `unpin` and stopped — the live card ran
    // unpinned for the rest of the turn and the durable row was deleted.
    // Pre-#3831 the DRIVER also carried its own copy of this expansion, whose
    // second leg bypassed reconcileAndPersistStatusPin entirely, so whichever
    // copy ran decided whether the durable row survived.
    await gw.reconcileStatusPin('fg:c:1', CHAT, { pinned: true, messageId: 101 }, 2_000)

    expect(tg.ids()).toEqual([101])
    expect(tg.verbs()).toEqual(['pin:100', 'unpin:100', 'pin:101'])
    expect(rowIds(fs)).toEqual([['fg:c:1', 101]])
    expect(gw.claims.get('fg:c:1')).toEqual({
      messageId: 101,
      chatId: CHAT,
      pinnedAt: 2_000,
    })
  })

  it('turn end releases the claim: nothing pinned, no durable row left behind', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('fg:c:1', CHAT, { pinned: true, messageId: 100 }, 1_000)
    await gw.reconcileStatusPin('fg:c:1', CHAT, { pinned: false }, 2_000)
    expect(tg.ids()).toEqual([])
    expect(rowIds(fs)).toEqual([])
    expect(gw.claims.size).toBe(0)
  })

  it('steady-state re-pin of the SAME id issues NO extra API call and does not re-age the claim', async () => {
    // The worker feed re-drives the reconcile on EVERY edit (20+/turn). A pin
    // storm here is a rate-limit incident, and re-stamping pinnedAt would make
    // the pin immortal against the reaper's TTL.
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('wk:group:c', CHAT, { pinned: true, messageId: 200 }, 1_000)
    for (let i = 1; i <= 10; i++) {
      await gw.reconcileStatusPin('wk:group:c', CHAT, { pinned: true, messageId: 200 }, 1_000 + i * 1_000)
    }
    expect(tg.verbs()).toEqual(['pin:200'])
    expect(gw.claims.get('wk:group:c')?.pinnedAt).toBe(1_000)
    // …and the durable row keeps the ORIGINAL age too (#3810), so a restart
    // inherits an honest claim age rather than a perpetually-fresh one.
    expect(loadStatusPins(PATH, fs)[0]?.pinnedAt).toBe(1_000)
  })
})

// ── 2. worker pins + the mid-session reaper ───────────────────────────────

describe('lifecycle — worker pin reaped mid-session', () => {
  it('a TERMINAL worker (missed onFinish) is unpinned at any age and its row dropped', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('wk:agent-a', CHAT, { pinned: true, messageId: 300 }, 1_000)
    expect(tg.ids()).toEqual([300])

    await gw.midSessionWorkerReap({
      now: 2_000, // seconds old — the TTL is nowhere near
      ttlMs: 6 * HOUR,
      statusOf: () => 'terminal',
    })

    expect(tg.ids()).toEqual([])
    expect(rowIds(fs)).toEqual([])
    expect(gw.claims.size).toBe(0)
  })

  it('a registry-confirmed RUNNING worker keeps its pin past the TTL (no mid-run churn)', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('wk:agent-a', CHAT, { pinned: true, messageId: 300 }, 0)
    await gw.midSessionWorkerReap({ now: 7 * HOUR, ttlMs: 6 * HOUR, statusOf: () => 'running' })
    expect(tg.ids()).toEqual([300])
  })

  it('leaves fg:/banner: pins alone — the worker reaper only ever touches wk: keys', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('fg:c:1', CHAT, { pinned: true, messageId: 100 }, 0)
    await gw.reconcileStatusPin('banner:owner', CHAT, { pinned: true, messageId: 101 }, 0)
    await gw.midSessionWorkerReap({ now: 99 * HOUR, ttlMs: 1, statusOf: () => 'terminal' })
    expect(tg.ids()).toEqual([100, 101])
  })
})

// ── 3. #3810 — the store orphan ages honestly across a restart ────────────

describe('lifecycle — restart with a stale claim (#3810)', () => {
  it('a wk: row orphaned by a crash is TTL-reaped mid-session, using its REAL age', async () => {
    const fs = memFs()
    const tg = fakeTelegram()

    // Session 1 pins a worker message, then the process dies (no SIGTERM
    // sweep): the claim is gone, the Telegram pin and the durable row survive.
    const gw1 = makeSubsystem(fs, tg)
    await gw1.reconcileStatusPin('wk:agent-a', CHAT, { pinned: true, messageId: 300 }, 0)

    // Session 2: no in-memory claim. The worker's turnsDb row has been pruned,
    // so the registry can only ever answer 'unknown' — pre-#3810 the store
    // orphan was stamped `pinnedAt = now` on EVERY pass, so the TTL never
    // elapsed for it and the pin survived until the next boot.
    const gw2 = makeSubsystem(fs, tg)
    expect(gw2.claims.size).toBe(0)

    // Not yet past the TTL: untouched.
    await gw2.midSessionWorkerReap({ now: 5 * HOUR, ttlMs: 6 * HOUR, statusOf: () => 'unknown' })
    expect(tg.ids()).toEqual([300])

    // Past the TTL, measured from the ORIGINAL claim time: reaped.
    await gw2.midSessionWorkerReap({ now: 7 * HOUR, ttlMs: 6 * HOUR, statusOf: () => 'unknown' })
    expect(tg.ids()).toEqual([])
    expect(rowIds(fs)).toEqual([])
  })

  it('a pre-v3 row (no recorded age) is NOT TTL-reaped — it stays conservative until the next write', async () => {
    // The compatibility half of the same fix: an upgraded gateway must not
    // guess an age for a row written by an older build. Such a row is only
    // reaped on a TERMINAL verdict, and self-heals on the next write.
    const fs = memFs()
    const tg = fakeTelegram()
    fs.writeFileSync(
      PATH,
      JSON.stringify({
        v: 2,
        pins: [{ pinKey: 'wk:agent-a', chatId: CHAT, messageId: 300 }],
      }),
    )
    tg.pinned.add(`${CHAT}:300`)
    const gw = makeSubsystem(fs, tg)

    await gw.midSessionWorkerReap({ now: 99 * HOUR, ttlMs: 6 * HOUR, statusOf: () => 'unknown' })
    expect(tg.ids()).toEqual([300]) // TTL cannot fire without an honest age

    await gw.midSessionWorkerReap({ now: 99 * HOUR, ttlMs: 6 * HOUR, statusOf: () => 'terminal' })
    expect(tg.ids()).toEqual([]) // a positive verdict still reaps it
  })

  it('a crash-orphaned pin is cleared by the NEXT BOOT sweep even if nothing reaps it first', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw1 = makeSubsystem(fs, tg)
    await gw1.reconcileStatusPin('fg:c:1', CHAT, { pinned: true, messageId: 100 }, 0)
    // crash — no sweep
    expect(tg.ids()).toEqual([100])

    const gw2 = makeSubsystem(fs, tg)
    const res = await gw2.bootCleanup()
    expect(res.cleared).toBe(1)
    expect(tg.ids()).toEqual([])
    expect(rowIds(fs)).toEqual([])
  })
})

// ── 4. SIGTERM ────────────────────────────────────────────────────────────

describe('lifecycle — SIGTERM sweep', () => {
  it('releases every claimed pin and empties the durable store', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('fg:c:1', CHAT, { pinned: true, messageId: 100 }, 0)
    await gw.reconcileStatusPin('wk:agent-a', CHAT, { pinned: true, messageId: 300 }, 0)
    await gw.reconcileStatusPin('wk:group:c', CHAT, { pinned: true, messageId: 400 }, 0)
    expect(tg.ids()).toEqual([100, 300, 400])

    await gw.sigtermSweep()

    expect(tg.ids()).toEqual([])
    expect(rowIds(fs)).toEqual([])
    expect(gw.claims.size).toBe(0)

    // And the next boot has nothing left to do — no phantom unpins.
    const gw2 = makeSubsystem(fs, tg)
    const res = await gw2.bootCleanup()
    expect(res.total).toBe(0)
  })
})

// ── 5. #3811 — the bridge flap must not reap a LIVE group pin ─────────────

describe('lifecycle — bridge flap (#3811)', () => {
  const liveFeed = (keys: string[]): WorkerFeedLivenessProbe => ({
    hasRunningInFeed: (k) => keys.includes(k),
  })

  it('does NOT unpin a live group pin while the feed is being rebuilt (no feed to ask)', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('wk:group:c', CHAT, { pinned: true, messageId: 400 }, 0)

    // The bridge dropped: workerActivityFeed is null for this tick. Pre-fix
    // this read as `'terminal'` — which reaps at ANY age, bypassing the TTL —
    // and yanked the pin out from under still-running workers.
    await gw.midSessionWorkerReap({ now: 60_000, ttlMs: 6 * HOUR, feed: null })

    expect(tg.ids()).toEqual([400])
    expect(rowIds(fs)).toEqual([['wk:group:c', 400]])
  })

  it('still reaps a group pin the LIVE feed says is finished (the missed-unpin backstop survives)', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('wk:group:c', CHAT, { pinned: true, messageId: 400 }, 0)
    await gw.midSessionWorkerReap({ now: 60_000, ttlMs: 6 * HOUR, feed: liveFeed([]) })
    expect(tg.ids()).toEqual([])
  })

  it('never reaps a group the live feed still reports as running', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('wk:group:c', CHAT, { pinned: true, messageId: 400 }, 0)
    await gw.midSessionWorkerReap({ now: 99 * HOUR, ttlMs: 6 * HOUR, feed: liveFeed(['c']) })
    expect(tg.ids()).toEqual([400])
  })

  it('a feed-null tick still bounds a genuinely STALE group pin by the TTL', async () => {
    // "Unknown" is not "immortal": the flap window protects live pins without
    // giving up the stale-pin ceiling.
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    await gw.reconcileStatusPin('wk:group:c', CHAT, { pinned: true, messageId: 400 }, 0)
    await gw.midSessionWorkerReap({ now: 7 * HOUR, ttlMs: 6 * HOUR, feed: null })
    expect(tg.ids()).toEqual([])
  })
})

// ── 6. #3809 — one claim record, so a chat can never go missing ───────────

describe('lifecycle — the claim carries its own chat (#3809)', () => {
  it('a wk: claim stays reapable across a retarget (the chat survives the intermediate cleared state)', async () => {
    // The old three-map registry (`state` / `chatIds` / `pinnedAt`) was written
    // and cleared in several places; a `wk:` key that kept its state entry but
    // lost its chatId entry was skipped by the in-memory reaper on EVERY pass
    // (it cannot unpin without a chat) AND excluded from the store-orphan net
    // (which skips keys that DO have an in-memory claim) — permanently
    // unreapable, silently, until the next boot. One record makes that state
    // unrepresentable; this asserts the observable consequence end to end.
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)

    await gw.reconcileStatusPin('wk:agent-a', CHAT, { pinned: true, messageId: 300 }, 0)
    await gw.reconcileStatusPin('wk:agent-a', CHAT, { pinned: true, messageId: 301 }, 1_000)
    expect(tg.ids()).toEqual([301])

    for (const c of gw.claims.values()) expect(c.chatId).not.toBe('')

    await gw.midSessionWorkerReap({ now: 2_000, ttlMs: 6 * HOUR, statusOf: () => 'terminal' })
    expect(tg.ids()).toEqual([])
    expect(rowIds(fs)).toEqual([])
  })
})

// ── 7. #3812 — the fg: claim is released BEFORE the card is deleted ───────

/** The lane's fake bot: records sends/edits/deletes AND drives the pin subsystem
 *  through the same fake Telegram, so ordering across both is observable. */
function laneBot(tg: ReturnType<typeof fakeTelegram>, chat: string) {
  let nextId = 3000
  return {
    sendRichMessage: async (_c: string, _b: { markdown: string }) => ({ message_id: ++nextId }),
    sendMessage: async (_c: string, _t: string) => ({ message_id: ++nextId }),
    editMessageText: async () => ({}),
    deleteMessage: async (_c: string, m: number) => {
      tg.deleted(chat, m)
      return true
    },
  }
}

function laneTurn(lane: ReturnType<typeof createNarrativeLane>, chat: string): CurrentTurn {
  const turn = {
    turnId: 'turn-pin-1',
    sessionChatId: chat,
    sessionThreadId: undefined,
    sourceMessageId: null,
    registryKey: null,
    startedAt: Date.now() - 3000,
    currentModel: null,
    totalTokens: 0,
    labeledToolCount: 1,
    mirrorLines: [] as string[],
    foregroundSubAgents: new Map<string, string[]>(),
    activityPendingRender: null as string | null,
    activityLastSentRender: null as string | null,
    activityMessageId: null as number | null,
    activityInFlight: null as Promise<void> | null,
    activityEverOpened: false,
    activityDrainFailures: 0,
    finalAnswerEverDelivered: false,
    finalAnswerDelivered: false,
    replyCalled: false,
    capturedText: [] as string[],
    lastReplyText: '',
    answerStream: null,
    liveness: { recentlyStreaming: () => false, onStreamEvent: () => {}, note: () => {} },
  } as unknown as CurrentTurn
  ;(turn as { narrativeGate?: unknown }).narrativeGate = lane.makeNarrativeGate(turn)
  return turn
}

describe('lifecycle — clearActivitySummary releases the pin before deleting the card (#3812)', () => {
  it('unpins the fg: claim and clears its durable row BEFORE the delete, so turn-end has nothing left to fail on', async () => {
    const fs = memFs()
    const tg = fakeTelegram()
    const gw = makeSubsystem(fs, tg)
    const noop = () => {}
    const fakeEA = {
      mayDrain: () => true,
      openOrEditCard: (_p: string, fn: () => void) => fn(),
      finalizeCard: (fn: () => void) => fn(),
      markSubstantiveFinalDelivered: (fn: () => void) => fn(),
    }
    const deps = {
      ACTIVITY_CARD_STORE_PATH: `${tmpdir()}/pin-lifecycle-activity-cards.json`,
      // The path that DELETES the card at turn end — the one where a claim on a
      // dead message id produced a guaranteed 4xx unpin every single turn.
      CLEAR_STATUS_ON_COMPLETION: true,
      FEED_HEARTBEAT_ENABLED: false,
      FEED_HEARTBEAT_MIN_STALE_MS: 6000,
      FEED_LIVENESS_OPEN_ENABLED: false,
      FEED_LIVENESS_OPEN_MS: 5000,
      PIN_STATUS_WHILE_WORKING: true,
      POST_ANSWER_LIVENESS_STALE_MS: 90000,
      STATIC: false,
      activeDraftStreams: new Map(),
      activityCardPersistEnabled: false,
      activityCardStoreFs: {
        readFileSync: () => '',
        writeFileSync: noop,
        mkdirSync: noop,
        renameSync: noop,
        unlinkSync: noop,
      },
      bot: { api: laneBot(tg, CHAT) },
      cardDrainGate: (_t: unknown, _ea: unknown, run: () => void) => run(),
      currentTurnMap: { get: () => null, byKey: new Map() },
      earlyLivenessOpenTimers: new Map(),
      emissionAuthorityFor: () => fakeEA,
      feedOpenGateDeps: () => ({
        hasOutboundDeliveredSince: () => false,
        historyEnabled: false,
        finalAnswerMinChars: 200,
      }),
      getCurrentTurn: () => null,
      // THE seam under test: the lane's pin hook wired to the real subsystem.
      reconcileStatusPin: (key: string, chat: string, desired: DesiredPin) =>
        gw.reconcileStatusPin(key, chat, desired),
      robustApiCall: (fn: () => Promise<unknown>) => fn(),
      statusKey: (c: string, t?: number | null) => `${c}:${t ?? 'main'}`,
    } as unknown as NarrativeLaneDeps

    const lane = createNarrativeLane(deps)
    const turn = laneTurn(lane, CHAT)

    lane.showNarrativeStep(turn, 'Doing the work now')
    await turn.activityInFlight
    await new Promise((r) => setTimeout(r, 20))
    const cardId = turn.activityMessageId
    expect(cardId).not.toBeNull()
    expect(tg.ids()).toEqual([cardId])
    expect(rowIds(fs)).toEqual([[`fg:${CHAT}:main`, cardId!]])

    lane.clearActivitySummary(turn)
    await new Promise((r) => setTimeout(r, 40))

    // OUTCOME: the unpin landed, and it landed BEFORE the delete — so the
    // claim never named a deleted message.
    expect(tg.verbs()).toEqual([`pin:${cardId}`, `unpin:${cardId}`, `delete:${cardId}`])
    const order = tg.calls.map((c) => c.verb)
    expect(order).toEqual(['pin', 'unpin', 'delete'])
    expect(rowIds(fs)).toEqual([])

    // …and the turn-end backstop is now a genuine no-op: no second API call.
    await gw.reconcileStatusPin(`fg:${CHAT}:main`, CHAT, { pinned: false })
    expect(tg.calls.filter((c) => c.verb === 'unpin')).toHaveLength(1)
  })
})
