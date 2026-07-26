/**
 * #3278 — read-back confirmation probe primitive (outbound-send-path.ts).
 *
 * `classifyReadBackError` maps a raw grammy `editMessageText` FAILURE into the
 * confirmation tri-state, and `createBackstopReadBackProbe` combines a chunk's
 * per-id probes into the chunk verdict `runBackstopDelivery` consumes. These
 * assert OUTCOMES: which error shape means present vs absent vs ambiguous, and
 * that a length-resplit chunk (>1 id) is confirmed only if EVERY id is present.
 */
import { describe, test, expect, vi } from 'vitest'
import { GrammyError } from 'grammy'
import {
  classifyReadBackError,
  createBackstopReadBackProbe,
  createBackstopReadBack,
} from '../gateway/outbound-send-path.js'
import type { ReadBackResult } from '../gateway/backstop-delivery.js'

// GrammyError's constructor takes (message, payload, method, parameters).
function grammy(code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to 'editMessageText' failed! (${code}: ${description})`,
    { ok: false, error_code: code, description },
    'editMessageText',
    {},
  )
}

describe('#3278 classifyReadBackError — raw edit-failure → confirmation tri-state', () => {
  test('400 "message to edit not found" ⇒ absent (positive drop → safe re-send)', () => {
    expect(classifyReadBackError(grammy(400, 'Bad Request: message to edit not found'))).toBe('absent')
  })

  test('400 "message is not modified" ⇒ exists (a no-op edit → message present)', () => {
    expect(classifyReadBackError(grammy(400, 'Bad Request: message is not modified'))).toBe('exists')
  })

  test('429 flood ⇒ ambiguous (never re-send)', () => {
    expect(classifyReadBackError(grammy(429, 'Too Many Requests: retry after 30'))).toBe('ambiguous')
  })

  test('5xx / non-grammy network error ⇒ ambiguous', () => {
    expect(classifyReadBackError(grammy(500, 'Internal Server Error'))).toBe('ambiguous')
    expect(classifyReadBackError(new Error('fetch failed: ECONNRESET'))).toBe('ambiguous')
  })

  test('an unrelated 400 (e.g. thread not found) is ambiguous, NOT absent', () => {
    // A wrong-classification here would demote-and-re-send a message that may
    // well exist — the never-demote-on-ambiguous rule guards against duplicates.
    expect(classifyReadBackError(grammy(400, 'Bad Request: message thread not found'))).toBe('ambiguous')
  })
})

describe('#3278 createBackstopReadBackProbe — per-chunk id combine', () => {
  test('single id present ⇒ exists; probes the id with the SAME rich body', async () => {
    const probeId = vi.fn(async (): Promise<ReadBackResult> => 'exists')
    const richMessage = vi.fn((s: string) => ({ rich: s }))
    const readBack = createBackstopReadBackProbe({ probeId, richMessage })
    const verdict = await readBack(0, [111], 'answer')
    expect(verdict).toBe('exists')
    expect(richMessage).toHaveBeenCalledWith('answer')
    expect(probeId).toHaveBeenCalledTimes(1)
    expect(probeId).toHaveBeenCalledWith(111, { rich: 'answer' })
  })

  test('resplit chunk (2 ids): one absent ⇒ absent (whole chunk re-sent)', async () => {
    const probeId = vi.fn(async (id: number): Promise<ReadBackResult> => (id === 12 ? 'absent' : 'exists'))
    const readBack = createBackstopReadBackProbe({ probeId, richMessage: (s) => s })
    expect(await readBack(1, [11, 12], 'B')).toBe('absent')
    expect(probeId).toHaveBeenCalledTimes(2) // every id of the chunk is probed
  })

  test('resplit chunk (2 ids): all present ⇒ exists', async () => {
    const probeId = vi.fn(async (): Promise<ReadBackResult> => 'exists')
    const readBack = createBackstopReadBackProbe({ probeId, richMessage: (s) => s })
    expect(await readBack(0, [1, 2], 'A')).toBe('exists')
  })

  test('empty id set ⇒ ambiguous and NEVER probes (no confirm, no demote)', async () => {
    const probeId = vi.fn(async (): Promise<ReadBackResult> => 'exists')
    const readBack = createBackstopReadBackProbe({ probeId, richMessage: (s) => s })
    expect(await readBack(0, [], 'A')).toBe('ambiguous')
    expect(probeId).not.toHaveBeenCalled()
  })
})

const SHED = Symbol.for('switchroom.send-gate.shed')

describe('#3278 createBackstopReadBack — full gate+edit+classify wiring', () => {
  function wiring(overrides: Partial<Parameters<typeof createBackstopReadBack>[0]> = {}) {
    return {
      editMessageText: vi.fn(async () => true), // edit applied → exists
      gate: vi.fn(async (fn: () => Promise<unknown>) => fn()), // passthrough gate
      isShed: (r: unknown) => r === SHED,
      richMessage: (s: string) => ({ rich: s }),
      chatId: '1001',
      threadId: undefined as number | undefined,
      ...overrides,
    }
  }

  test('edit RESOLVES ⇒ exists; edits to the identical rich body (no visible mutation)', async () => {
    const w = wiring()
    const readBack = createBackstopReadBack(w)
    expect(await readBack(0, [55], 'answer')).toBe('exists')
    // Probed the landed id with the SAME rich body the chunk was sent with.
    expect(w.editMessageText).toHaveBeenCalledWith(55, { rich: 'answer' }, expect.anything())
    // Routed through the send gate (pacing) rather than a raw call.
    expect(w.gate).toHaveBeenCalledTimes(1)
  })

  test('400 message-not-found ⇒ absent (safe re-send)', async () => {
    const editMessageText = vi.fn(async () => {
      throw new GrammyError('boom', { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, 'editMessageText', {})
    })
    const readBack = createBackstopReadBack(wiring({ editMessageText }))
    expect(await readBack(0, [55], 'answer')).toBe('absent')
  })

  test('400 not-modified ⇒ exists (a no-op edit on a present message)', async () => {
    const editMessageText = vi.fn(async () => {
      throw new GrammyError('boom', { ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, 'editMessageText', {})
    })
    const readBack = createBackstopReadBack(wiring({ editMessageText }))
    expect(await readBack(0, [55], 'answer')).toBe('exists')
  })

  test('429 flood ⇒ ambiguous (never re-send)', async () => {
    const editMessageText = vi.fn(async () => {
      throw new GrammyError('boom', { ok: false, error_code: 429, description: 'Too Many Requests' }, 'editMessageText', {})
    })
    const readBack = createBackstopReadBack(wiring({ editMessageText }))
    expect(await readBack(0, [55], 'answer')).toBe('ambiguous')
  })

  test('gate SHED (SEND_GATE_SHED sentinel) ⇒ ambiguous, NOT a false exists', async () => {
    // Under a flood window the cosmetic probe sheds — the gate resolves the
    // sentinel, not the edit. Must be ambiguous so the chunk is never demoted.
    const gate = vi.fn(async () => SHED)
    const editMessageText = vi.fn(async () => true)
    const readBack = createBackstopReadBack(wiring({ gate, editMessageText }))
    expect(await readBack(0, [55], 'answer')).toBe('ambiguous')
  })

  test('gate NO-OP drop (resolves undefined) ⇒ ambiguous, NOT a false exists', async () => {
    // The gate's edit path drops a repeat of the last payload it actually sent
    // (`counters.dropped`) and drops an expired queue entry, resolving
    // `undefined` in both cases. Nothing reached Telegram, so nothing was
    // proven — classifying it `exists` would fabricate a confirmation from a
    // call that never happened.
    const gate = vi.fn(async () => undefined)
    const editMessageText = vi.fn(async () => true)
    const readBack = createBackstopReadBack(wiring({ gate, editMessageText }))
    expect(await readBack(0, [55], 'answer')).toBe('ambiguous')
  })
})
