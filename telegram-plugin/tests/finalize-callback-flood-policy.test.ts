/**
 * Outcome tests for #3891 — `finalizeCallback` must transit the ONE retry /
 * flood policy, and a failed card repaint must not leave a live-looking
 * keyboard.
 *
 * These are deliberately NOT unit tests of a helper. Each one drives the real
 * `createRetryApiCall` + the real `makeFloodWaitRecorder` against a real temp
 * state dir and asserts the observable artefact an operator or `switchroom
 * doctor` would later read:
 *
 *   - `429-ledger.json` gains an episode for a 429 earned by a BUTTON TAP.
 *   - `flood-wait.json` gains the window.
 *   - after a repaint that fails post-retry, the card's keyboard is gone
 *     (or, if it cannot be removed, the operator is told in-channel).
 *
 * Pre-fix (both legs calling `ctx.*` raw) every one of these fails: the
 * ledger file is never created, and the keyboard survives untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrammyError } from 'grammy'
import {
  finalizeCallback,
  DEAD_CARD_NOTICE,
  type FinalizeCallbackContext,
  type FinalizeApiCall,
} from '../inline-keyboard-callbacks.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { makeFloodWaitRecorder, makeFloodWaitProbe } from '../flood-circuit-breaker.js'
import {
  readFlood429Ledger,
  flood429LedgerPathFromFloodState,
} from '../flood-429-ledger.js'

/** Synthetic chat id — never a real operator chat (see check-no-pii-secrets). */
const CHAT_ID = -1009900112233
const MSG_ID = 4242

let stateDir: string
let floodStatePath: string

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'sr-3891-'))
  floodStatePath = join(stateDir, 'flood-wait.json')
})
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

/** A Telegram 429 exactly as grammy surfaces it. */
function flood429(retryAfter: number, method: string): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: 429, description: 'Too Many Requests: retry after ' + retryAfter, parameters: { retry_after: retryAfter } },
    method,
    {},
  )
}

/** A non-429, non-benign edit failure — the shape seen in the clerk incident. */
function hardEditFailure(method = 'editMessageText'): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed!`,
    { ok: false, error_code: 400, description: "Bad Request: can't parse entities" },
    method,
    {},
  )
}

/**
 * The production wiring, verbatim in shape: `createRetryApiCall` with BOTH
 * breaker hooks, writing to a temp state dir. No sleeping (fake sleep) so the
 * flood-wait retry path runs at test speed.
 */
function realPolicy(): FinalizeApiCall {
  const record = makeFloodWaitRecorder(floodStatePath)
  const probe = makeFloodWaitProbe(floodStatePath)
  return createRetryApiCall({
    log: () => {},
    sleep: async () => {},
    onFloodWait: (retryAfterSec) => record(retryAfterSec),
    floodWaitRemainingMs: probe,
  })
}

interface Capture {
  acks: number
  edits: number
  markupEdits: Array<Record<string, unknown>>
  replies: string[]
}

function mkCtx(cap: Capture, behaviour: {
  ack?: () => void
  edit?: () => void
  markup?: () => void
  reply?: () => void
} = {}): FinalizeCallbackContext {
  return {
    answerCallbackQuery: async () => { cap.acks++; behaviour.ack?.(); return true },
    editMessageText: async () => { cap.edits++; behaviour.edit?.(); return { message_id: MSG_ID } },
    editMessageReplyMarkup: async (opts) => {
      cap.markupEdits.push(opts ?? {})
      behaviour.markup?.()
      return true
    },
    reply: async (text) => { cap.replies.push(text); behaviour.reply?.(); return { message_id: MSG_ID + 1 } },
    callbackQuery: { message: { message_id: MSG_ID, chat: { id: CHAT_ID } } },
  }
}

const mkCap = (): Capture => ({ acks: 0, edits: 0, markupEdits: [], replies: [] })

describe('#3891 — tap-path 429s reach the flood ledger', () => {
  it('records a 429 earned by answerCallbackQuery to the 429 ledger AND the window file', async () => {
    const cap = mkCap()
    let ackAttempts = 0
    const ctx = mkCtx(cap, {
      ack: () => { ackAttempts++; if (ackAttempts === 1) throw flood429(7, 'answerCallbackQuery') },
    })

    await finalizeCallback(ctx, {
      ackText: 'Approved',
      newText: 'resolved',
      apiCall: realPolicy(),
      log: () => {},
    })
    // The ack leg is fire-and-forget; let its retry chain settle.
    await new Promise((r) => setTimeout(r, 0))

    const ledgerPath = flood429LedgerPathFromFloodState(floodStatePath)
    expect(existsSync(ledgerPath)).toBe(true)
    const episodes = readFlood429Ledger(ledgerPath)
    expect(episodes).toHaveLength(1)
    expect(episodes[0]?.peakRetryAfterSec).toBe(7)
    expect(episodes[0]?.count).toBe(1)
    // The window file the send gate / doctor / watchdog all read.
    expect(existsSync(floodStatePath)).toBe(true)
    // And the tap still succeeded on retry — the policy is not a silencer.
    expect(ackAttempts).toBe(2)
  })

  it('records a 429 earned by the card repaint, and the repaint still lands on retry', async () => {
    const cap = mkCap()
    let editAttempts = 0
    const ctx = mkCtx(cap, {
      edit: () => { editAttempts++; if (editAttempts === 1) throw flood429(11, 'editMessageText') },
    })

    await finalizeCallback(ctx, {
      ackText: 'Approved',
      newText: 'resolved',
      apiCall: realPolicy(),
      log: () => {},
    })

    const episodes = readFlood429Ledger(flood429LedgerPathFromFloodState(floodStatePath))
    expect(episodes).toHaveLength(1)
    expect(episodes[0]?.peakRetryAfterSec).toBe(11)
    expect(editAttempts).toBe(2)
    // Repaint landed on the retry, so no ladder rung was needed.
    expect(cap.markupEdits).toHaveLength(0)
    expect(cap.replies).toHaveLength(0)
  })

  it('scopes the flood window to the tapped chat, not `global`', async () => {
    const seen: Array<{ chat_id?: string; verb?: string; priorityClass?: string }> = []
    const apiCall: FinalizeApiCall = async (fn, opts) => {
      seen.push({ chat_id: opts?.chat_id, verb: opts?.verb, priorityClass: opts?.priorityClass })
      return fn()
    }
    const cap = mkCap()
    await finalizeCallback(mkCtx(cap), { ackText: 'ok', newText: 'x', apiCall, log: () => {} })
    await new Promise((r) => setTimeout(r, 0))

    expect(seen).toHaveLength(2)
    for (const s of seen) {
      expect(s.chat_id).toBe(String(CHAT_ID))
      // `critical` is the one class the send gate never sheds. A finalize
      // repaint is the operator's ONLY confirmation their tap resolved a
      // human-in-the-loop decision; shedding it is the incident itself.
      expect(s.priorityClass).toBe('critical')
    }
    expect(seen.map((s) => s.verb)).toEqual(['answerCallbackQuery', 'editMessageText'])
  })

  it('survives a callbackQuery with no chat (degrades to an unscoped window, never throws)', async () => {
    const seen: Array<string | undefined> = []
    const apiCall: FinalizeApiCall = async (fn, opts) => { seen.push(opts?.chat_id); return fn() }
    const cap = mkCap()
    const ctx = { ...mkCtx(cap), callbackQuery: undefined }
    await expect(
      finalizeCallback(ctx, { ackText: 'ok', newText: 'x', apiCall, log: () => {} }),
    ).resolves.toBeUndefined()
    expect(seen.every((s) => s === undefined)).toBe(true)
  })
})

describe('#3891 — a failed repaint never leaves a live-looking card', () => {
  it('strips the keyboard when the body repaint fails post-retry', async () => {
    const cap = mkCap()
    const logs: string[] = []
    const ctx = mkCtx(cap, { edit: () => { throw hardEditFailure() } })

    await finalizeCallback(ctx, {
      ackText: 'Approved',
      newText: '**bad _markdown',
      apiCall: realPolicy(),
      log: (l) => logs.push(l),
    })

    // THE outcome: the card is no longer tappable.
    expect(cap.markupEdits).toHaveLength(1)
    expect(cap.markupEdits[0]?.reply_markup).toEqual({ inline_keyboard: [] })
    // Not silent, either.
    expect(logs.some((l) => l.includes('editMessageText failed'))).toBe(true)
    expect(logs.some((l) => l.includes('no longer tappable'))).toBe(true)
    // No need to shout in-channel — rung 2 fixed it.
    expect(cap.replies).toHaveLength(0)
  })

  it('tells the operator in-channel when the keyboard cannot be stripped either', async () => {
    const cap = mkCap()
    const logs: string[] = []
    const ctx = mkCtx(cap, {
      edit: () => { throw hardEditFailure() },
      markup: () => { throw hardEditFailure('editMessageReplyMarkup') },
    })

    await finalizeCallback(ctx, {
      ackText: 'Approved',
      newText: 'resolved',
      apiCall: realPolicy(),
      log: (l) => logs.push(l),
    })

    expect(cap.replies).toEqual([DEAD_CARD_NOTICE])
    // The notice must name the buttons as stale — that is the whole point.
    expect(DEAD_CARD_NOTICE).toContain('STALE')
  })

  it('a repaint failure does NOT block the model wake-up (invariant 3 holds)', async () => {
    const cap = mkCap()
    let synthFired = false
    const ctx = mkCtx(cap, {
      edit: () => { throw hardEditFailure() },
      markup: () => { throw hardEditFailure('editMessageReplyMarkup') },
      reply: () => { throw hardEditFailure('sendMessage') },
    })

    await finalizeCallback(ctx, {
      ackText: 'Approved',
      newText: 'resolved',
      apiCall: realPolicy(),
      synthInbound: () => { synthFired = true },
      log: () => {},
    })

    expect(synthFired).toBe(true)
  })

  it('does NOT run the ladder when the repaint succeeds', async () => {
    const cap = mkCap()
    await finalizeCallback(mkCtx(cap), {
      ackText: 'Approved',
      newText: 'resolved',
      apiCall: realPolicy(),
      log: () => {},
    })
    expect(cap.edits).toBe(1)
    expect(cap.markupEdits).toHaveLength(0)
    expect(cap.replies).toHaveLength(0)
  })

  it('treats the two BENIGN edit failures as done — the retry policy swallows them, no ladder', async () => {
    // MESSAGE_TO_EDIT_NOT_FOUND: the operator deleted the card. There is no
    // keyboard left to disarm, so shouting about a stale card would be noise.
    const cap = mkCap()
    const ctx = mkCtx(cap, {
      edit: () => {
        throw new GrammyError(
          "Call to 'editMessageText' failed!",
          { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' },
          'editMessageText',
          {},
        )
      },
    })
    await finalizeCallback(ctx, {
      ackText: 'Approved', newText: 'resolved', apiCall: realPolicy(), log: () => {},
    })
    expect(cap.markupEdits).toHaveLength(0)
    expect(cap.replies).toHaveLength(0)
  })
})
