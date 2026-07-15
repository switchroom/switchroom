/**
 * Invocable send-loop harness (#2996 step 1).
 *
 * PR 3007 extracted the deterministic text/chunk CORE of the outbound path but
 * noted the side-effecting send ORCHESTRATION could not be moved (or tested)
 * without an "invocable-executeReply harness" — because gateway.ts is not
 * importable in any test runner: it runs boot logic (acquires the PID lock,
 * `process.exit(1)` when another gateway is live) and calls `Bun.listen` at
 * import time, so `executeReply` can never be driven from vitest/bun in-place.
 *
 * This harness closes that gap for the highest-bug-density mechanic of the send
 * path — the chunk-send loop with its THREAD_NOT_FOUND / oversize re-split /
 * parse-reject fallback ladder and partial-failure contract (exactly where the
 * recent oversize / wire-cap fixes landed). `sendReplyChunks` was relocated
 * VERBATIM from executeReply and is now driven here against a FAKE bot API,
 * asserting: multi-chunk send order, partial-failure contract (which chunks
 * report sent), oversize re-send, HTML parse-reject plaintext fallback,
 * THREAD_NOT_FOUND thread-drop + retry, keyboard-on-last-chunk passthrough,
 * preview edit-in-place, and voice-only text suppression.
 *
 * The gateway keeps the raw `bot.api.*` calls as thin injected adapters; the
 * module is bot-agnostic, so a fake is a plain record of function calls. The
 * cross-surface `outboundDedup` singleton contract is covered by the sibling
 * `outbound-send-path.test.ts` (a stream-path `record` suppresses a reply-path
 * `check` on the same instance) — dedup lives in executeReply, not in this
 * relocated loop, so it is intentionally out of scope here.
 */
import { describe, it, expect } from 'vitest'
import { GrammyError } from 'grammy'
import {
  sendReplyChunks,
  type ReplyChunkSendDeps,
  type ReplyChunkSendState,
} from '../gateway/outbound-send-path.js'

// Build a GrammyError with a given 400 description (grammy 1.44 ctor shape).
function grammy400(description: string, method = 'sendRichMessage'): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed! (400: ${description})`,
    { ok: false, error_code: 400, description },
    method,
    {},
  )
}

interface RecordedCall {
  kind: 'sendRich' | 'sendLiteral' | 'sendLiteralRaw' | 'sendRichRaw' | 'editPreview'
  opts: Record<string, unknown>
  body: unknown
  threadId?: number | undefined
  messageId?: number
}

/**
 * Fake bot surface. `sendRich`/`sendLiteral` are the retry-wrapped adapters;
 * `*Raw` are the unwrapped last-resort adapters; `editPreview` is the
 * preview edit-in-place. Each records its call; per-kind `failers` inject
 * one-shot errors (keyed by chunk-body identity or call index) so we can
 * script the fallback ladder deterministically.
 */
function makeFake(opts?: {
  failNext?: Partial<Record<RecordedCall['kind'], Array<unknown>>>
  richMessage?: (s: string) => unknown
}): {
  deps: ReplyChunkSendDeps
  calls: RecordedCall[]
  stderr: string[]
  logs: Array<{ id: number; chars: number; extra?: string }>
  deleted: number[]
} {
  const calls: RecordedCall[] = []
  const stderr: string[] = []
  const logs: Array<{ id: number; chars: number; extra?: string }> = []
  const deleted: number[] = []
  let nextId = 1000
  const queues = opts?.failNext ?? {}

  const maybeFail = (kind: RecordedCall['kind']): void => {
    const q = queues[kind]
    if (q && q.length > 0) {
      const e = q.shift()
      if (e != null) throw e
    }
  }
  const send = (
    kind: RecordedCall['kind'],
    o: Record<string, unknown>,
    body: unknown,
    threadId?: number | undefined,
  ): Promise<{ message_id: number }> => {
    // Evaluate the failure queue synchronously so a thrown GrammyError
    // rejects the returned promise exactly as the real adapter would.
    return (async () => {
      maybeFail(kind)
      const id = ++nextId
      calls.push({ kind, opts: o, body, threadId, messageId: id })
      return { message_id: id }
    })()
  }

  const deps: ReplyChunkSendDeps = {
    sendRich: (o, body, tid) => send('sendRich', o, body, tid),
    sendLiteral: (o, txt, tid) => send('sendLiteral', o, txt, tid),
    sendLiteralRaw: (o, txt) => send('sendLiteralRaw', o, txt),
    sendRichRaw: (o, body) => send('sendRichRaw', o, body),
    editPreview: async (mid, body, o, tid) => {
      maybeFail('editPreview')
      calls.push({ kind: 'editPreview', opts: o, body, threadId: tid, messageId: mid })
      return {}
    },
    richMessage: opts?.richMessage ?? ((s: string) => ({ rich: s })),
    logOutbound: (_path, _chat, id, chars, extra) => { logs.push({ id, chars, extra }) },
    deleteStalePreview: async (id) => { deleted.push(id) },
    stderr: (s) => { stderr.push(s) },
  }
  return { deps, calls, stderr, logs, deleted }
}

function baseState(over: Partial<ReplyChunkSendState> & { chunks: string[] }): ReplyChunkSendState {
  return {
    chatId: '555',
    literalText: false,
    suppressText: false,
    threadId: undefined,
    previewMessageId: null,
    sentIds: [],
    buildSendOpts: (i, isLastChunk, tid) => ({
      ...(tid != null ? { message_thread_id: tid } : {}),
      ...(isLastChunk ? { _last: true } : {}),
      _chunkIndex: i,
    }),
    buildPreviewEditOpts: () => ({}),
    ...over,
  }
}

describe('sendReplyChunks — multi-chunk send order', () => {
  it('sends every chunk in order and appends ids to the shared sentIds array', async () => {
    const { deps, calls } = makeFake()
    const state = baseState({ chunks: ['a', 'b', 'c'] })
    const res = await sendReplyChunks(deps, state)
    expect(calls.map((c) => c.kind)).toEqual(['sendRich', 'sendRich', 'sendRich'])
    expect(calls.map((c) => c.body)).toEqual([{ rich: 'a' }, { rich: 'b' }, { rich: 'c' }])
    // ids appended in order, one per chunk
    expect(state.sentIds).toHaveLength(3)
    expect(state.sentIds).toEqual([...state.sentIds].sort((x, y) => x - y))
    expect(res.threadId).toBeUndefined()
  })

  it('literal (format:text) chunks route through sendLiteral, never rich', async () => {
    const { deps, calls } = makeFake()
    const state = baseState({ chunks: ['x', 'y'], literalText: true })
    await sendReplyChunks(deps, state)
    expect(calls.map((c) => c.kind)).toEqual(['sendLiteral', 'sendLiteral'])
    expect(calls.map((c) => c.body)).toEqual(['x', 'y'])
  })

  it('voice-only suppressText sends NOTHING (voice note IS the reply)', async () => {
    const { deps, calls } = makeFake()
    const state = baseState({ chunks: ['a', 'b'], suppressText: true })
    await sendReplyChunks(deps, state)
    expect(calls).toHaveLength(0)
    expect(state.sentIds).toHaveLength(0)
  })
})

describe('sendReplyChunks — keyboard/opts passthrough', () => {
  it('reply_markup rides ONLY on the last chunk (isLastChunk gate)', async () => {
    const { deps, calls } = makeFake()
    const state = baseState({
      chunks: ['one', 'two', 'three'],
      buildSendOpts: (i, isLastChunk, tid) => ({
        ...(tid != null ? { message_thread_id: tid } : {}),
        ...(isLastChunk ? { reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'x' }]] } } : {}),
      }),
    })
    await sendReplyChunks(deps, state)
    expect(calls[0].opts.reply_markup).toBeUndefined()
    expect(calls[1].opts.reply_markup).toBeUndefined()
    expect(calls[2].opts.reply_markup).toBeDefined()
  })

  it('rich path strips link_preview_options before sending (rich entity previews)', async () => {
    const { deps, calls } = makeFake()
    const state = baseState({
      chunks: ['only'],
      buildSendOpts: () => ({ link_preview_options: { is_disabled: true }, keepme: 1 }),
    })
    await sendReplyChunks(deps, state)
    expect(calls[0].opts.link_preview_options).toBeUndefined()
    expect(calls[0].opts.keepme).toBe(1)
  })
})

describe('sendReplyChunks — partial-failure contract', () => {
  it('an unrecoverable error midway propagates, and sentIds holds ONLY the chunks already sent', async () => {
    // chunk 0 ok, chunk 1 throws a non-400 (not length, not parse) → rethrow.
    const boom = new Error('network exploded')
    const { deps, calls } = makeFake({ failNext: { sendRich: [undefined, boom] } })
    const state = baseState({ chunks: ['first', 'second', 'third'] })
    await expect(sendReplyChunks(deps, state)).rejects.toThrow('network exploded')
    // first chunk reported sent; second/third never appended.
    expect(state.sentIds).toHaveLength(1)
    // exactly one send succeeded (chunk 1 threw before being recorded).
    expect(calls.filter((c) => c.kind === 'sendRich')).toHaveLength(1)
  })
})

describe('sendReplyChunks — oversize re-send', () => {
  it('a RICH_MESSAGE_TEXT_TOO_LONG on the wrapped send re-splits via the raw rich adapter', async () => {
    // A chunk far past the wire cap so resplitOversizeChunk yields >1 piece.
    const huge = 'x'.repeat(70_000)
    const { deps, calls } = makeFake({ failNext: { sendRich: [grammy400('RICH_MESSAGE_TEXT_TOO_LONG')] } })
    const state = baseState({ chunks: [huge] })
    await sendReplyChunks(deps, state)
    const raws = calls.filter((c) => c.kind === 'sendRichRaw')
    expect(raws.length).toBeGreaterThan(1)
    // every re-split piece landed a message id
    expect(state.sentIds.length).toBe(raws.length)
  })
})

describe('sendReplyChunks — parse-reject plaintext fallback', () => {
  it("a can't-parse-entities 400 resends the chunk as plain text via sendLiteralRaw", async () => {
    const { deps, calls } = makeFake({ failNext: { sendRich: [grammy400("can't parse entities: bad offset")] } })
    const state = baseState({ chunks: ['**bad markdown'] })
    await sendReplyChunks(deps, state)
    expect(calls.map((c) => c.kind)).toEqual(['sendLiteralRaw'])
    expect(calls[0].body).toBe('**bad markdown')
    expect(state.sentIds).toHaveLength(1)
  })

  it('an empty chunk parse-reject falls back to the placeholder glyph', async () => {
    const { deps, calls } = makeFake({ failNext: { sendRich: [grammy400("can't parse entities")] } })
    const state = baseState({ chunks: [''] })
    await sendReplyChunks(deps, state)
    expect(calls[0].kind).toBe('sendLiteralRaw')
    expect(String(calls[0].body)).toContain('could not be rendered')
  })
})

describe('sendReplyChunks — THREAD_NOT_FOUND fallback', () => {
  it('drops the thread and retries UNWRAPPED, and returns threadId undefined', async () => {
    // wrapped send throws THREAD_NOT_FOUND; retry (raw) succeeds.
    const tnf = new Error('THREAD_NOT_FOUND')
    const { deps, calls } = makeFake({ failNext: { sendRich: [tnf] } })
    const state = baseState({ chunks: ['hi'], threadId: 42 })
    const res = await sendReplyChunks(deps, state)
    // The first (wrapped) attempt threw before recording; the retry uses
    // sendChunk(_, false) → the UNWRAPPED raw adapter, deliberately not
    // re-entering the retry policy after a dropped thread.
    expect(calls[0].kind).toBe('sendRichRaw')
    // retry re-built opts WITHOUT the thread id.
    expect(res.threadId).toBeUndefined()
    expect(calls[0].opts.message_thread_id).toBeUndefined()
    expect(state.sentIds).toHaveLength(1)
  })

  it('THREAD_NOT_FOUND then a length error on retry re-splits', async () => {
    const tnf = new Error('THREAD_NOT_FOUND')
    const huge = 'y'.repeat(70_000)
    const { deps, calls } = makeFake({
      failNext: { sendRich: [tnf], sendRichRaw: [grammy400('MESSAGE_TOO_LONG')] },
    })
    const state = baseState({ chunks: [huge], threadId: 7 })
    await sendReplyChunks(deps, state)
    // retry (raw) threw length → resplit sent multiple raw pieces
    const raws = calls.filter((c) => c.kind === 'sendRichRaw')
    expect(raws.length).toBeGreaterThan(1)
  })
})

describe('sendReplyChunks — preview edit-in-place', () => {
  it('edits the stale preview on the first chunk, consumes it, then sends the rest fresh', async () => {
    const { deps, calls } = makeFake()
    const state = baseState({ chunks: ['a', 'b'], previewMessageId: 900 })
    const res = await sendReplyChunks(deps, state)
    expect(calls[0].kind).toBe('editPreview')
    expect(calls[0].messageId).toBe(900)
    // preview id consumed → subsequent chunk is a fresh send
    expect(calls[1].kind).toBe('sendRich')
    expect(res.previewMessageId).toBeNull()
    // first sentId is the reused preview id
    expect(state.sentIds[0]).toBe(900)
  })

  it('a failed preview edit deletes the stale preview and sends fresh', async () => {
    const { deps, calls, deleted } = makeFake({ failNext: { editPreview: [new Error('message to edit not found')] } })
    const state = baseState({ chunks: ['a'], previewMessageId: 901 })
    const res = await sendReplyChunks(deps, state)
    expect(deleted).toEqual([901])
    expect(calls.some((c) => c.kind === 'sendRich')).toBe(true)
    expect(res.previewMessageId).toBeNull()
  })

  it('a "not modified" preview edit is treated as success (id reused, no fresh send)', async () => {
    const { deps, calls, deleted } = makeFake({ failNext: { editPreview: [new Error('Bad Request: message is not modified')] } })
    const state = baseState({ chunks: ['a'], previewMessageId: 902 })
    await sendReplyChunks(deps, state)
    expect(deleted).toEqual([])
    expect(state.sentIds).toEqual([902])
    expect(calls.filter((c) => c.kind === 'sendRich')).toHaveLength(0)
  })
})

// Reply-flicker fix: the flushed-turn supersede edits the flushed message A in
// place instead of delete+resend, by re-pointing `previewMessageId` at A's id.
// These drive that exact execution lane through the fake bot to assert the
// user-visible OUTCOME (one message survives, no flicker) rather than the path.
describe('sendReplyChunks — flushed-turn supersede edit-in-place', () => {
  it('a single-message text reply superseding a flushed message EDITS A in place — no delete', async () => {
    // Gateway sets previewMessageId to the flushed message id when
    // decideSupersedeCorrection returns edit-in-place (single chunk, no files/preview).
    const { deps, calls, deleted } = makeFake()
    const flushedId = 700
    const state = baseState({ chunks: ['the real answer'], previewMessageId: flushedId })
    const res = await sendReplyChunks(deps, state)
    // A is edited in place with the canonical reply body — NOT deleted.
    expect(calls).toHaveLength(1)
    expect(calls[0].kind).toBe('editPreview')
    expect(calls[0].messageId).toBe(flushedId)
    expect(calls[0].body).toEqual({ rich: 'the real answer' })
    expect(deleted).toEqual([])
    expect(calls.some((c) => c.kind === 'sendRich')).toBe(false)
    // Exactly ONE message survives, and it is the (edited) flushed message.
    expect(state.sentIds).toEqual([flushedId])
    expect(res.previewMessageId).toBeNull()
  })

  it('anti-duplicate: an edit-in-place supersede never leaves BOTH the flush and a fresh reply visible', async () => {
    const { deps, calls, deleted } = makeFake()
    const state = baseState({ chunks: ['answer'], previewMessageId: 710 })
    await sendReplyChunks(deps, state)
    // No fresh send happened alongside the edit, and nothing was deleted — the
    // single surviving message is the flushed one, now carrying the reply.
    const fresh = calls.filter((c) => c.kind === 'sendRich' || c.kind === 'sendLiteral')
    expect(fresh).toHaveLength(0)
    expect(deleted).toEqual([])
    expect(state.sentIds).toEqual([710])
  })

  it('edit returns a 400 → falls back to delete+resend, exactly one clean message survives', async () => {
    // Message too old / uneditable / gone: editPreview throws, the lane deletes
    // A and sends the canonical reply fresh — never both, never neither.
    const { deps, calls, deleted } = makeFake({
      failNext: { editPreview: [grammy400("message can't be edited", 'editMessageText')] },
    })
    const flushedId = 720
    const state = baseState({ chunks: ['the real answer'], previewMessageId: flushedId })
    const res = await sendReplyChunks(deps, state)
    // Fallback: stale flush deleted, canonical reply sent fresh.
    expect(deleted).toEqual([flushedId])
    const fresh = calls.filter((c) => c.kind === 'sendRich')
    expect(fresh).toHaveLength(1)
    expect(fresh[0].body).toEqual({ rich: 'the real answer' })
    // Exactly one surviving message (the fresh send), and it is NOT the flushed id.
    expect(state.sentIds).toHaveLength(1)
    expect(state.sentIds[0]).not.toBe(flushedId)
    expect(res.previewMessageId).toBeNull()
  })
})
