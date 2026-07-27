/**
 * Regression suite for switchroom#3848 — the terminal worker-card frame must
 * not be shed with the heartbeat repaints.
 *
 * #3847 made the edit-flood fuse class-aware and tagged EVERY worker-feed edit
 * `cosmetic`. That is right for a liveness repaint (dropping one costs
 * nothing — the next render carries full state) and wrong for the TERMINAL
 * frame: it is the last frame the operator ever reads for that card, and
 * nothing newer is coming to repaint it. Classed cosmetic, the single frame
 * carrying the finished state competed in the same starved budget as a
 * heartbeat, and under sustained cosmetic pressure it was the frame dropped —
 * leaving the card frozen mid-run forever.
 *
 * Every test here asserts an OUTCOME (did the call reach the API / what class
 * did it carry), under the exact pressure scenario that sheds it. Each one
 * goes RED if the terminal frame is classed `cosmetic` again — at the feed
 * (`{ terminal: … }` no longer passed), at the mapping
 * (`workerFeedEditPriorityClass`), or at the fuse.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createEditFloodFuse, EDIT_FLOOD_FUSE_DEFAULTS } from '../edit-flood-fuse.js'
import { withOutboundClass } from '../outbound-class.js'
import type { Clock, PriorityClass } from '../send-gate.js'
import {
  createWorkerActivityFeed,
  workerFeedEditPriorityClass,
  type BotApiForWorkerFeed,
  type WorkerActivityView,
  type WorkerFeedEditMeta,
} from '../worker-activity-feed.js'

const CHAT = '1001'

class FakeClock implements Clock {
  private cur = 0
  private seq = 0
  private timers: { at: number; id: number; resolve: () => void }[] = []

  now(): number { return this.cur }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.cur + ms, id: this.seq++, resolve })
    })
  }

  async advance(ms: number): Promise<void> {
    const target = this.cur + ms
    for (;;) {
      await flush()
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) break
      const t = due[0]!
      this.timers = this.timers.filter((x) => x !== t)
      this.cur = t.at
      t.resolve()
      await flush()
    }
    this.cur = target
    await flush()
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

async function drain(): Promise<void> {
  for (let i = 0; i < 12; i++) await flush()
}

function view(step: string, elapsedMs: number, state: 'running' | 'done' = 'running'): WorkerActivityView {
  return { description: 'ship the fix', lastTool: null, toolCount: 2, latestSummary: step, elapsedMs, state }
}

/**
 * The gateway's worker-feed edit adapter, reproduced EXACTLY as
 * `gateway.ts` wires it (see the `createWorkerActivityFeed({ bot: { … } })`
 * block): map the feed's out-of-band `meta` to a priority class with
 * `workerFeedEditPriorityClass`, publish it on the AsyncLocalStorage the fuse
 * reads, then hand the call to the transformer.
 *
 * `withOutboundClass` is what the real send gate does with `priorityClass`;
 * doing it here keeps this test on the production mapping rather than a
 * hand-written class literal.
 */
function gatewayEditAdapter(
  fuse: { apply: <R>(m: string, p: unknown, next: () => Promise<R>) => Promise<R> },
  onLand: (messageId: number, cls: PriorityClass) => void,
) {
  return (chatId: string, messageId: number, text: string, meta?: WorkerFeedEditMeta): Promise<unknown> => {
    const cls: PriorityClass = workerFeedEditPriorityClass(meta)
    return withOutboundClass(cls, () =>
      fuse.apply('editMessageText', { chat_id: chatId, message_id: messageId, text }, async () => {
        onLand(messageId, cls)
        return true
      }),
    )
  }
}

const D = EDIT_FLOOD_FUSE_DEFAULTS

/**
 * Offset at which the frame under test is offered, relative to the pressure
 * burst. Small and non-zero: the frame must arrive AFTER the chat's cosmetic
 * allowance is spent (so it has to wait) but early enough that its own
 * `maxDeferMs` deadline still falls inside the pressure window — which is
 * precisely the "sustained cosmetic pressure" #3848 describes. Offering it at
 * t=0 would race the burst's own late releases at the same instant.
 */
const OFFER_AT_MS = 1_000

/**
 * Saturate a chat's cosmetic allowance the way a busy agent does: N distinct
 * worker cards all repainting at once. Both the per-chat cosmetic ceiling
 * (`cosmeticPerChatMaxPerWindow`, 6/60s) and the bounded R1 late-release
 * budget (`lateReleaseMaxPerWindow`, 2/60s) get spent — the latter matters
 * because a LONE cosmetic frame is otherwise released late rather than
 * dropped. That late-release budget is the partial mitigation #3848 records,
 * and running it out is what turns the degradation into a guaranteed drop.
 *
 * Returns the still-pending burst; the caller advances the clock past
 * `maxDeferMs` once, resolving the burst and the frame under test together.
 */
function startCosmeticPressure(
  fuse: { apply: <R>(m: string, p: unknown, next: () => Promise<R>) => Promise<R> },
  landed: number[],
): Promise<unknown>[] {
  const total = D.cosmeticPerChatMaxPerWindow + D.lateReleaseMaxPerWindow
  const pending: Promise<unknown>[] = []
  for (let i = 0; i < total; i++) {
    pending.push(
      withOutboundClass('cosmetic', () =>
        fuse.apply('editMessageText', { chat_id: CHAT, message_id: 9000 + i, text: `card ${i}` }, async () => {
          landed.push(9000 + i)
          return true
        }),
      ),
    )
  }
  return pending
}

/**
 * Offer ONE lone edit to a fresh message id under an already-exhausted
 * cosmetic budget, as `cls`, and report whether it reached the API.
 */
async function offerLoneEditUnderPressure(cls: PriorityClass): Promise<boolean> {
  const clock = new FakeClock()
  const fuse = createEditFloodFuse({ clock })
  const landed: number[] = []
  const pressure = startCosmeticPressure(fuse, landed)
  await clock.advance(OFFER_AT_MS)

  let reachedApi = false
  const call = withOutboundClass(cls, () =>
    fuse.apply(
      'editMessageText',
      { chat_id: CHAT, message_id: 4242, text: '✅ done · 12 tools' },
      async () => { reachedApi = true; return true },
    ),
  )
  await clock.advance(D.maxDeferMs + 1_000)
  await Promise.all([...pressure, call])
  // Sanity: the pressure really did consume the whole cosmetic allowance.
  expect(landed).toHaveLength(D.cosmeticPerChatMaxPerWindow + D.lateReleaseMaxPerWindow)
  return reachedApi
}

describe('#3848 — a terminal worker-card frame survives an exhausted cosmetic budget', () => {
  it('drops the terminal frame when it is classed cosmetic, and lands it when classed useful', async () => {
    // Both halves run the SAME fuse config under the SAME pressure, so the
    // ONLY difference is the class the terminal frame carries. The classes
    // come from the production mapping, so reverting the promotion turns the
    // second assertion into the first.
    const asCosmetic = await offerLoneEditUnderPressure(workerFeedEditPriorityClass({ terminal: false }))
    const asUseful = await offerLoneEditUnderPressure(workerFeedEditPriorityClass({ terminal: true }))

    // The defect (#3848): with the cosmetic budget spent, the frame carrying
    // the finished state never reaches Telegram — the card freezes mid-run.
    expect(asCosmetic).toBe(false)
    // The fix: the same frame, promoted because it is terminal, gets through.
    expect(asUseful).toBe(true)
  })

  it('still holds INTERMEDIATE repaints to the cosmetic ceiling after the fix', async () => {
    // Guards the other direction: promoting the terminal frame must not
    // promote the heartbeat stream, or #3847's whole flood defence is undone.
    expect(workerFeedEditPriorityClass({ terminal: false })).toBe('cosmetic')
    expect(await offerLoneEditUnderPressure('cosmetic')).toBe(false)
  })
})

describe('#3848 — the REAL feed tags its terminal frame, through the REAL gateway mapping', () => {
  /**
   * End-to-end over the production pieces: `createWorkerActivityFeed` drives
   * the gateway's own edit adapter into a real `createEditFloodFuse`. Nothing
   * here hand-writes a class — the class comes from whatever the feed passes
   * as `meta`. If the feed stops passing `{ terminal: … }`, or the adapter
   * stops consulting it, the terminal recap is shed and this goes RED.
   */
  it('lands the finish recap at the API while the chat cosmetic budget is exhausted', async () => {
    const clock = new FakeClock()
    const fuse = createEditFloodFuse({ clock })
    const preLanded: number[] = []
    const pressure = startCosmeticPressure(fuse, preLanded)
    await clock.advance(OFFER_AT_MS)

    const CARD = 777
    const landedEdits: { messageId: number; cls: PriorityClass }[] = []
    const edit = gatewayEditAdapter(fuse, (messageId, cls) => landedEdits.push({ messageId, cls }))

    const bot: BotApiForWorkerFeed = {
      sendMessage: async () => ({ message_id: CARD }),
      editMessageText: (chatId, messageId, text, _opts, meta) => edit(chatId, messageId, text, meta),
    }
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock.now(),
      minEditIntervalMs: 0,
      elapsedRefreshMs: 0,
      firstPaintMinMs: 0,
      setInterval: () => 0,
      clearInterval: () => {},
    })

    // First paint (a send — never dropped), then the worker finishes.
    await feed.update('w1', CHAT, view('reading gateway.ts', 30_000))
    await drain()

    const finish = feed.finish('w1', view('opened the PR', 60_000, 'done'))
    await clock.advance(D.maxDeferMs + 1_000)
    await finish
    await Promise.all(pressure)
    await drain()

    // The pressure really did spend the whole cosmetic allowance…
    expect(preLanded).toHaveLength(D.cosmeticPerChatMaxPerWindow + D.lateReleaseMaxPerWindow)
    // …and the terminal recap still reached Telegram, as `useful`.
    expect(landedEdits.map((e) => e.messageId)).toContain(CARD)
    expect(landedEdits.filter((e) => e.messageId === CARD).every((e) => e.cls === 'useful')).toBe(true)
  })

  it('classes the running repaints cosmetic and only the finish frame useful', async () => {
    const clock = new FakeClock()
    const CARD = 888
    const seen: { text: string; meta?: WorkerFeedEditMeta }[] = []
    const bot: BotApiForWorkerFeed = {
      sendMessage: async () => ({ message_id: CARD }),
      editMessageText: async (_c, _m, text, _opts, meta) => { seen.push({ text, meta }); return true },
    }
    const feed = createWorkerActivityFeed({
      bot,
      now: () => clock.now(),
      minEditIntervalMs: 0,
      elapsedRefreshMs: 0,
      firstPaintMinMs: 0,
      setInterval: () => 0,
      clearInterval: () => {},
    })

    await feed.update('w1', CHAT, view('first step', 10_000))
    await drain()
    await feed.update('w1', CHAT, view('second step', 20_000))
    await drain()
    await feed.update('w1', CHAT, view('third step', 30_000))
    await drain()
    const beforeFinish = seen.length
    await feed.finish('w1', view('all done', 40_000, 'done'))
    await drain()

    // At least one intermediate repaint and exactly the finish frame after it.
    expect(beforeFinish).toBeGreaterThan(0)
    expect(seen.length).toBeGreaterThan(beforeFinish)
    for (const e of seen.slice(0, beforeFinish)) {
      expect(e.meta?.terminal).toBe(false)
      expect(workerFeedEditPriorityClass(e.meta)).toBe('cosmetic')
    }
    for (const e of seen.slice(beforeFinish)) {
      expect(e.meta?.terminal).toBe(true)
      expect(workerFeedEditPriorityClass(e.meta)).toBe('useful')
    }
  })
})

describe('#3848 — gateway.ts actually wires the mapping', () => {
  /**
   * `gateway.ts` is not unit-importable (a single 24k-line module with a live
   * bot at construction), so `gatewayEditAdapter` above can only MIRROR its
   * adapter. That mirror would keep passing if someone hard-coded
   * `priorityClass: 'cosmetic'` back into the real adapter, which is exactly
   * the regression #3848 fixes. This asserts the real wiring at the source,
   * deterministically, instead of trusting the mirror.
   */
  const GATEWAY = new URL('../gateway/gateway.ts', import.meta.url)

  it('passes the feed edit meta through workerFeedEditPriorityClass', () => {
    const src = readFileSync(GATEWAY, 'utf8')
    // The adapter must actually RECEIVE the meta argument from the feed.
    const ANCHOR = 'editMessageText: (cid, mid, text, editOpts, editMeta) =>'
    const at = src.indexOf(ANCHOR)
    expect(at, `gateway.ts no longer declares the worker-feed edit adapter as \`${ANCHOR}\``).toBeGreaterThan(-1)

    // Bound the slice to this one adapter: it ends at the `verb: 'worker-feed'`
    // options object it passes to robustApiCall.
    const verbAt = src.indexOf("verb: 'worker-feed'", at)
    expect(verbAt).toBeGreaterThan(at)
    const feedAdapter = src.slice(at, verbAt + 500)

    expect(feedAdapter).toContain('priorityClass: workerFeedEditPriorityClass(editMeta)')
    // The hard-coded class #3848 removed must not come back.
    expect(feedAdapter).not.toContain("priorityClass: 'cosmetic'")
    // And the symbol must be imported, or the above is dead source text.
    expect(src).toContain('workerFeedEditPriorityClass')
  })
})

describe('#3848 — the class mapping itself', () => {
  it('maps terminal → useful and everything else → cosmetic', () => {
    expect(workerFeedEditPriorityClass({ terminal: true })).toBe('useful')
    expect(workerFeedEditPriorityClass({ terminal: false })).toBe('cosmetic')
    // An adapter that forgets to forward `meta` must degrade to the SAFE
    // class, not silently promote every repaint.
    expect(workerFeedEditPriorityClass(undefined)).toBe('cosmetic')
  })

  it('returns a value assignable to the send gate PriorityClass union', () => {
    // Compile-time half: this line fails `tsc` if the mapping ever returns a
    // class the gate does not know (#3847's OutboundClass/PriorityClass lock).
    const cls: PriorityClass = workerFeedEditPriorityClass({ terminal: true })
    expect(['critical', 'useful', 'cosmetic']).toContain(cls)
  })
})
