/**
 * Outcome pins for the ask_user option-callback family (`aq:<idx>:<askId>`,
 * #574) extracted from the gateway's callback_query dispatcher
 * (switchroom#2996 P6). Uses the REAL encode/decode from ask-user.ts and
 * asserts: non-ask data falls through (returns false), the allowFrom gate,
 * stale-tap and out-of-bounds acks, and the full resolve path (timer cleared,
 * store entry deleted, promise resolved with the choice, message edited with
 * the checkmark, toast acked).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  handleAskCallback,
  type AskCallbackDeps,
  type PendingAskUserEntry,
} from '../gateway/ask-callback-handler.js'
import { encodeAskCallback } from '../ask-user.js'

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    from: { id: 42 },
    callbackQuery: { message: { text: 'Pick one <a&b>' } },
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    ...over,
  } as any
}

function makeDeps(entries: Record<string, PendingAskUserEntry> = {}) {
  const store = new Map(Object.entries(entries))
  const deps: AskCallbackDeps = {
    loadAccess: () => ({ allowFrom: ['42'] }),
    pendingAskUser: store,
  }
  return { deps, store }
}

function entryWith(options: string[]) {
  let resolved: unknown = null
  const entry: PendingAskUserEntry = {
    options,
    resolve: (o: unknown) => {
      resolved = o
    },
    timer: setTimeout(() => {}, 60_000),
  }
  return { entry, getResolved: () => resolved }
}

describe('handleAskCallback — routing', () => {
  it('returns false for non-ask callback data (dispatcher falls through)', async () => {
    const { deps } = makeDeps()
    const ctx = makeCtx()
    expect(await handleAskCallback(ctx, 'apv:whatever', deps)).toBe(false)
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalled()
  })

  it('gates non-allowlisted senders with a Not authorized toast', async () => {
    const { entry } = entryWith(['a'])
    const { deps } = makeDeps({ aaaa1111: entry })
    const ctx = makeCtx({ from: { id: 666 } })
    expect(await handleAskCallback(ctx, encodeAskCallback('aaaa1111', 0), deps)).toBe(true)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    clearTimeout(entry.timer)
  })

  it('acks a stale tap (entry gone) with the expired toast', async () => {
    const { deps } = makeDeps()
    const ctx = makeCtx()
    expect(await handleAskCallback(ctx, encodeAskCallback('deadbeef', 0), deps)).toBe(true)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'This question expired.' })
  })

  it('rejects an out-of-bounds index (hostile callback) without resolving', async () => {
    const { entry, getResolved } = entryWith(['only'])
    const { deps, store } = makeDeps({ aaaa1111: entry })
    const ctx = makeCtx()
    await handleAskCallback(ctx, encodeAskCallback('aaaa1111', 3), deps)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Invalid option.' })
    expect(getResolved()).toBeNull()
    expect(store.has('aaaa1111')).toBe(true)
    clearTimeout(entry.timer)
  })
})

describe('handleAskCallback — resolve path', () => {
  it('resolves the deferred, deletes the entry, edits the message, acks the toast', async () => {
    const { entry, getResolved } = entryWith(['yes', 'no'])
    const { deps, store } = makeDeps({ aaaa1111: entry })
    const ctx = makeCtx()
    expect(await handleAskCallback(ctx, encodeAskCallback('aaaa1111', 1), deps)).toBe(true)
    expect(getResolved()).toEqual({ kind: 'answered', choice: 'no', idx: 1 })
    expect(store.has('aaaa1111')).toBe(false)
    // Edited body: escaped source text + checkmarked choice.
    const edited = JSON.stringify(ctx.editMessageText.mock.calls[0][0])
    expect(edited).toContain('✅')
    expect(edited).toContain('no')
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ no' })
  })

  it('still resolves + acks when the source message has no text (no edit attempted)', async () => {
    const { entry, getResolved } = entryWith(['ok'])
    const { deps } = makeDeps({ aaaa1111: entry })
    const ctx = makeCtx({ callbackQuery: { message: {} } })
    await handleAskCallback(ctx, encodeAskCallback('aaaa1111', 0), deps)
    expect(getResolved()).toEqual({ kind: 'answered', choice: 'ok', idx: 0 })
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ ok' })
  })

  it('a failing editMessageText is swallowed — the ack toast still fires', async () => {
    const { entry } = entryWith(['ok'])
    const { deps } = makeDeps({ aaaa1111: entry })
    const ctx = makeCtx({ editMessageText: vi.fn(async () => { throw new Error('too old') }) })
    await handleAskCallback(ctx, encodeAskCallback('aaaa1111', 0), deps)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ ok' })
  })
})
