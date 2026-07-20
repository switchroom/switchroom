/**
 * Golden-transcript harness for the extracted send-orchestration façade
 * (#2996 P2, plan Amendments 9/10).
 *
 * ── Oracle standard (Amendment 10 — read this before "improving" it) ──────
 * The coordinator-accepted oracle for P2 is the EXTRACTED-MODULE golden
 * harness (the merged `outbound-send-chunks.test.ts` precedent, scaled to the
 * full façade): `sendReply` / `deliverCapturedProse` are driven against a
 * fake bot API recording `(method, chat_id, text, opts, reply_markup)` plus
 * the REAL `OutboundDedupCache`. Pinning the literal IN-PLACE `executeReply`
 * first was not possible: it is unexported and its `lockedBot` handle is
 * assigned only inside the `isGatewayMain`-gated boot, so the in-place body
 * cannot be invoked from any test runner even though gateway.ts now imports
 * cleanly (P0e). Behavior preservation therefore rests on (a) the VERBATIM
 * relocation (8 enumerated pin-vs-live spellings, see the module's section
 * comment), (b) the pre-existing structural wiring tests re-pointed at the
 * module, and (c) this behavioral harness.
 *
 * ── What is pinned here ───────────────────────────────────────────────────
 *   - multi-chunk send order + keyboard-on-last-chunk
 *   - oversize re-split (MESSAGE_TOO_LONG → hard-cap pieces, never dropped)
 *   - code fences survive the normalize pipeline to the wire
 *   - outbound secret redaction (REAL `redact()`) before the wire + dedup key
 *   - partial-failure contract ("reply failed after N of M chunk(s) sent")
 *   - voice: voice+text ordering; voice-only text suppression
 *   - photo route vs document route file sends
 *   - deliverCapturedProse silent-end recovery send + its dedup record
 *   - CROSS-SURFACE stream-then-reply dedup through the ONE shared
 *     OutboundDedupCache instance (Amendment 1) — with a negative control
 *     proving a second instance would reinstate the duplicate-reply class
 *   - structural: gateway constructs EXACTLY ONE OutboundDedupCache and the
 *     extracted module constructs NONE (the re-`new` hard-fail rule)
 */
import { describe, it, expect } from 'vitest'
import { GrammyError } from 'grammy'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sendReply,
  deliverCapturedProse,
  type SendReplyGatewayDeps,
  type DeliverCapturedProseDeps,
  type SendReplyRequest,
  type VoiceOutPlan,
} from '../gateway/outbound-send-path.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { FlushedTurnSupersedeRegistry } from '../flushed-turn-supersede.js'
import { redact } from '../secret-detect/redact.js'
import type { CurrentTurn, Access } from '../gateway/gateway.js'

// ── fake bot API ──────────────────────────────────────────────────────────

interface RecordedCall {
  method: string
  chat_id: string
  /** text for literal sends; the rich `{ markdown }` body's text for rich. */
  text: string | null
  opts: Record<string, unknown>
  reply_markup: unknown
  message_id?: number
}

function grammy400(description: string, method = 'sendRichMessage'): GrammyError {
  return new GrammyError(
    `Call to '${method}' failed! (400: ${description})`,
    { ok: false, error_code: 400, description },
    method,
    {},
  )
}

function makeFakeBot(failNext?: Partial<Record<string, unknown[]>>) {
  const calls: RecordedCall[] = []
  let nextId = 1000
  const queues = failNext ?? {}
  const maybeFail = (method: string): void => {
    const q = queues[method]
    if (q && q.length > 0) {
      const e = q.shift()
      if (e != null) throw e
    }
  }
  const record = (
    method: string,
    chat_id: string,
    text: string | null,
    opts: Record<string, unknown>,
  ): { message_id: number; message_thread_id?: number } => {
    maybeFail(method)
    const id = ++nextId
    calls.push({ method, chat_id, text, opts, reply_markup: opts.reply_markup ?? null, message_id: id })
    const tid = opts.message_thread_id
    return { message_id: id, ...(tid != null ? { message_thread_id: Number(tid) } : {}) }
  }
  const api = {
    sendRichMessage: async (chat: string, body: { markdown: string }, opts: Record<string, unknown> = {}) =>
      record('sendRichMessage', chat, body.markdown, opts),
    sendMessage: async (chat: string, text: string, opts: Record<string, unknown> = {}) =>
      record('sendMessage', chat, text, opts),
    editMessageText: async (chat: string, mid: number, body: unknown, opts: Record<string, unknown> = {}) => {
      maybeFail('editMessageText')
      calls.push({
        method: 'editMessageText',
        chat_id: chat,
        text: typeof body === 'string' ? body : (body as { markdown: string }).markdown,
        opts,
        reply_markup: opts.reply_markup ?? null,
        message_id: mid,
      })
      return {}
    },
    deleteMessage: async (chat: string, mid: number) => {
      calls.push({ method: 'deleteMessage', chat_id: chat, text: null, opts: {}, reply_markup: null, message_id: mid })
      return true
    },
    sendVoice: async (chat: string, _file: unknown, opts: Record<string, unknown> = {}) =>
      record('sendVoice', chat, null, opts),
    sendPhoto: async (chat: string, _file: unknown, opts: Record<string, unknown> = {}) =>
      record('sendPhoto', chat, null, opts),
    sendDocument: async (chat: string, _file: unknown, opts: Record<string, unknown> = {}) =>
      record('sendDocument', chat, null, opts),
    sendMediaGroup: async (chat: string, media: unknown[], opts: Record<string, unknown> = {}) => {
      maybeFail('sendMediaGroup')
      const out: Array<{ message_id: number }> = []
      for (let i = 0; i < media.length; i++) {
        const id = ++nextId
        calls.push({ method: 'sendMediaGroup', chat_id: chat, text: null, opts, reply_markup: null, message_id: id })
        out.push({ message_id: id })
      }
      return out
    },
  }
  return { api, calls }
}

// ── harness deps ──────────────────────────────────────────────────────────

const CHAT = '1001'

function makeAccess(over: Partial<Record<string, unknown>> = {}): Access {
  return {
    allowFrom: [CHAT],
    groups: {},
    disableLinkPreview: true,
    ...over,
  } as unknown as Access
}

interface Harness {
  deps: SendReplyGatewayDeps
  calls: RecordedCall[]
  dedup: OutboundDedupCache
  effects: string[]
}

function makeHarness(opts?: {
  access?: Access
  dedup?: OutboundDedupCache
  turnProvider?: () => CurrentTurn | null
  failNext?: Partial<Record<string, unknown[]>>
  voicePlan?: VoiceOutPlan | null
  synth?: (plan: { ttsText: string }) => Promise<Uint8Array | null>
}): Harness {
  const { api, calls } = makeFakeBot(opts?.failNext)
  const dedup = opts?.dedup ?? new OutboundDedupCache()
  const effects: string[] = []
  const access = opts?.access ?? makeAccess()
  const getCurrentTurn = opts?.turnProvider ?? (() => null)
  const key = (c: string, t?: number | null) => `${c}:${t ?? 'main'}`
  const deps: SendReplyGatewayDeps = {
    outboundDedup: dedup,
    flushedTurnSupersede: new FlushedTurnSupersedeRegistry(),
    firstTextReplyLogged: new Set<string>(),
    suppressPtyPreview: new Set<string>(),
    activeDraftStreams: new Map(),
    lastPtyPreviewByChat: new Map(),
    voiceOnDemandCache: { put: () => {} } as unknown as SendReplyGatewayDeps['voiceOnDemandCache'],
    voicePreSynthQueue: { enqueue: () => {} } as unknown as SendReplyGatewayDeps['voicePreSynthQueue'],
    pendingProgress: {
      clearPending: (k, r) => effects.push(`pendingProgress.clearPending:${k}:${r}`),
      noteOutbound: (k) => effects.push(`pendingProgress.noteOutbound:${k}`),
    },
    signalTracker: {
      noteOutbound: (k) => effects.push(`signalTracker.noteOutbound:${k}`),
      noteSignal: (k) => effects.push(`signalTracker.noteSignal:${k}`),
    },
    silencePoke: { noteOutbound: (k) => effects.push(`silencePoke.noteOutbound:${k}`) },
    getCurrentTurn,
    getLastActiveTurnChatId: () => undefined,
    HISTORY_ENABLED: false,
    TURN_ORIGIN_ROUTING_ENABLED: true,
    AUTOCLASSIFY_MIDTURN_SHADOW: false,
    MAX_ATTACHMENT_BYTES: 50 * 1024 * 1024,
    MAX_CHUNK_LIMIT: 4096,
    PHOTO_EXTS: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']),
    lockedBot: { api } as unknown as SendReplyGatewayDeps['lockedBot'],
    robustApiCall: (fn) => fn(),
    swallowingApiCall: async (fn) => {
      try {
        return await fn()
      } catch {
        return undefined
      }
    },
    loadAccess: () => access,
    redactOutboundText: (text) => redact(text),
    assertAllowedChat: () => {},
    assertSendable: () => {},
    statusKey: key,
    streamKey: key,
    resolveReplyOwnerTurn: () => ({ turn: null, tier: 'none' as const }),
    findTurnByOriginId: () => null,
    findTurnByQuotedMessageId: () => null,
    resolveAnswerThreadWithLog: (_c, explicit) => explicit,
    resolveThreadId: (_c, explicit) => (explicit != null ? Number(explicit) : undefined),
    getLatestInboundMessageId: () => null,
    recordOutbound: () => effects.push('recordOutbound'),
    emissionAuthorityFor: () =>
      ({
        claimOrDowngradePing: (
          _input: unknown,
          _state: unknown,
          _apply: unknown,
          disabled: () => void,
        ) => disabled(),
        markSubstantiveFinalDelivered: (fn: () => void) => fn(),
        finalizeCard: (fn: () => void) => fn(),
      }) as unknown as ReturnType<SendReplyGatewayDeps['emissionAuthorityFor']>,
    clearActivitySummary: () => effects.push('clearActivitySummary'),
    startTypingLoop: (c, t) => effects.push(`startTypingLoop:${key(c, t)}`),
    stopTypingLoop: (c, t) => effects.push(`stopTypingLoop:${key(c, t)}`),
    logOutbound: () => {},
    closeObligationOnSubstantiveReply: () => effects.push('closeObligation'),
    finalizeStatusReaction: (c, t, o) => effects.push(`finalizeStatusReaction:${key(c, t)}:${o}`),
    releaseTurnBufferGate: (k) => effects.push(`releaseTurnBufferGate:${k}`),
    reapQueuedStatus: () => effects.push('reapQueuedStatus'),
    noteAgentOutputAt: () => {},
    rememberAgentButtonMeta: () => effects.push('rememberAgentButtonMeta'),
    resolveVoiceOutPlan: () => opts?.voicePlan ?? null,
    synthesizeVoiceOut: opts?.synth ?? (async () => null),
    publishToTelegraph: async () => null,
    clearSilentEndState: (k) => effects.push(`clearSilentEndState:${k}`),
    emitRuntimeMetric: () => {},
    shadowEmit: () => {},
    progressDriver: null,
  }
  return { deps, calls, dedup, effects }
}

function req(text: string, extra: Record<string, unknown> = {}, turn: CurrentTurn | null = null): SendReplyRequest {
  return { args: { chat_id: CHAT, text, ...extra }, turn }
}

// ── the cases ─────────────────────────────────────────────────────────────

describe('sendReply golden harness — text pipeline to the wire', () => {
  it('single-chunk happy path: one rich send, normalized text on the wire', async () => {
    const h = makeHarness()
    const res = await sendReply(h.deps, req('Hello there. This is the answer.'))
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.chat_id).toBe(CHAT)
    expect(sends[0]!.text).toContain('Hello there. This is the answer.')
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // typing loop started + stopped around the send
    expect(h.effects).toContain(`startTypingLoop:${CHAT}:main`)
    expect(h.effects).toContain(`stopTypingLoop:${CHAT}:main`)
  })

  it('multi-chunk: ordered sends; keyboard attaches to the LAST chunk only', async () => {
    const para = (n: number) => `Paragraph ${n} ${'x'.repeat(60)}.`
    const text = [para(1), para(2), para(3)].join('\n\n')
    const h = makeHarness({ access: makeAccess({ textChunkLimit: 80 }) })
    const keyboard = [[{ text: 'Open', url: 'https://example.com' }]]
    const res = await sendReply(h.deps, req(text, { inline_keyboard: keyboard }))
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends.length).toBeGreaterThanOrEqual(2)
    // order: chunk i is sent before chunk i+1 (message ids ascend with order)
    for (let i = 1; i < sends.length; i++) {
      expect(sends[i]!.message_id!).toBeGreaterThan(sends[i - 1]!.message_id!)
    }
    // keyboard only on the last chunk
    for (let i = 0; i < sends.length - 1; i++) expect(sends[i]!.reply_markup).toBeNull()
    expect(sends[sends.length - 1]!.reply_markup).toMatchObject({
      inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]],
    })
    expect(res.content[0]!.text).toMatch(new RegExp(`^sent ${sends.length} parts`))
  })

  it('code fences survive the normalize pipeline to the wire intact', async () => {
    const fence = '```ts\nconst x = a - b // em-dash-free zone\n```'
    const h = makeHarness()
    await sendReply(h.deps, req(`Here is the code:\n\n${fence}`))
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('```ts\nconst x = a - b')
  })

  it('secrets are redacted (REAL redact()) before the wire', async () => {
    // Runtime-concatenated so push-protection never sees a token-shaped literal.
    const token = 'sk-ant-' + 'api03-' + 'A'.repeat(93) + 'AA'
    const h = makeHarness()
    await sendReply(h.deps, req(`Your key is ${token} - keep it safe.`))
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).not.toContain(token)
    // Mask shape is `[REDACTED:<detector>]` (underscores may be markdown-escaped
    // downstream of the scrub — the token bytes are what must never survive).
    expect(sends[0]!.text).toMatch(/\[REDACTED/)
  })

  it('oversize chunk: MESSAGE_TOO_LONG re-splits to hard-cap pieces instead of dropping', async () => {
    const h = makeHarness({
      failNext: { sendRichMessage: [grammy400('MESSAGE_TOO_LONG: message is too long')] },
    })
    const res = await sendReply(h.deps, req('word '.repeat(40).trim()))
    // first rich attempt failed; the re-split path delivered >= 1 piece
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends.length).toBeGreaterThanOrEqual(1)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })

  it('partial failure: unrecoverable error surfaces the N-of-M contract', async () => {
    const para = (n: number) => `Paragraph ${n} ${'y'.repeat(60)}.`
    const text = [para(1), para(2), para(3)].join('\n\n')
    const h = makeHarness({
      access: makeAccess({ textChunkLimit: 80 }),
      failNext: { sendRichMessage: [null, new Error('boom: network down')] },
    })
    await expect(sendReply(h.deps, req(text))).rejects.toThrow(
      /reply failed after 1 of \d+ chunk\(s\) sent: boom: network down/,
    )
    // the typing loop is still stopped by the finally
    expect(h.effects.filter((e) => e.startsWith('stopTypingLoop'))).toHaveLength(1)
  })
})

describe('sendReply golden harness — voice', () => {
  const plan: VoiceOutPlan = {
    engine: 'kokoro',
    speed: 1.1,
    replyMode: 'voice+text',
    ttsChunks: ['Spoken answer.'],
  }

  it('voice+text: text chunks first, then the voice note', async () => {
    const h = makeHarness({
      voicePlan: plan,
      synth: async () => new Uint8Array([1, 2, 3]),
    })
    await sendReply(h.deps, req('The spoken answer, also as text.'))
    const methods = h.calls.map((c) => c.method)
    expect(methods).toContain('sendRichMessage')
    expect(methods).toContain('sendVoice')
    expect(methods.indexOf('sendVoice')).toBeGreaterThan(methods.indexOf('sendRichMessage'))
  })

  it('voice-only with full synthesis: text body suppressed, voice note IS the reply', async () => {
    const h = makeHarness({
      voicePlan: { ...plan, replyMode: 'voice-only' },
      synth: async () => new Uint8Array([1, 2, 3]),
    })
    const res = await sendReply(h.deps, req('Only spoken.'))
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'sendVoice')).toHaveLength(1)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })

  it('voice-only with FAILED synthesis: text path still delivers (never drop the answer)', async () => {
    const h = makeHarness({
      voicePlan: { ...plan, replyMode: 'voice-only' },
      synth: async () => null,
    })
    await sendReply(h.deps, req('Fell back to text.'))
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
    expect(h.calls.filter((c) => c.method === 'sendVoice')).toHaveLength(0)
  })
})

describe('sendReply golden harness — file sends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p2-golden-'))

  it('a photo-extension file routes via sendPhoto; a document via sendDocument', async () => {
    const png = join(dir, 'shot.png')
    const txt = join(dir, 'notes.txt')
    // Garbage PNG bytes: the photo PRE-check probe fails open (keeps the
    // photo route), which is exactly the #3033 contract we want pinned.
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    writeFileSync(txt, 'hello')
    const h = makeHarness()
    await sendReply(h.deps, req('files attached', { files: [png] }))
    expect(h.calls.filter((c) => c.method === 'sendPhoto')).toHaveLength(1)

    const h2 = makeHarness()
    await sendReply(h2.deps, req('doc attached', { files: [txt] }))
    expect(h2.calls.filter((c) => c.method === 'sendDocument')).toHaveLength(1)
  })

  it('2-10 photos batch into ONE sendMediaGroup album', async () => {
    const a = join(dir, 'a.png')
    const b = join(dir, 'b.png')
    writeFileSync(a, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(b, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const h = makeHarness()
    await sendReply(h.deps, req('album', { files: [a, b] }))
    expect(h.calls.filter((c) => c.method === 'sendMediaGroup')).toHaveLength(2) // one record per album item
    expect(h.calls.filter((c) => c.method === 'sendPhoto')).toHaveLength(0)
  })
})

describe('cross-surface dedup — the ONE OutboundDedupCache instance (Amendment 1/9)', () => {
  it('a stream-surface record suppresses the same-content reply (zero wire calls)', async () => {
    const dedup = new OutboundDedupCache()
    const text = 'The final answer, already streamed.'
    // Simulate the handleSessionEvent answer-stream record site (P4 surface):
    // it records into the SAME cache instance the reply path checks.
    dedup.record(CHAT, undefined, text, Date.now(), null)
    const h = makeHarness({ dedup })
    const res = await sendReply(h.deps, req(text))
    expect(res.content[0]!.text).toBe('sent (deduped — same content sent via earlier path)')
    expect(h.calls).toHaveLength(0)
  })

  it('NEGATIVE CONTROL: a second cache instance reinstates the duplicate send', async () => {
    const streamSideCache = new OutboundDedupCache()
    const text = 'The final answer, already streamed.'
    streamSideCache.record(CHAT, undefined, text, Date.now(), null)
    // The reply path holding a DIFFERENT instance (the forbidden re-new)
    // does NOT see the record — the duplicate ships. This is why the
    // injected singleton contract is load-bearing.
    const h = makeHarness({ dedup: new OutboundDedupCache() })
    await sendReply(h.deps, req(text))
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
  })

  it('a delivered reply records into the shared cache (later flush/stream is suppressed)', async () => {
    const dedup = new OutboundDedupCache()
    const h = makeHarness({ dedup })
    await sendReply(h.deps, req('Recorded for dedup across surfaces.'))
    const hit = dedup.check(CHAT, undefined, 'Recorded for dedup across surfaces.', Date.now(), null)
    expect(hit).not.toBeNull()
  })
})

describe('deliverCapturedProse — silent-end recovery (routed into the send module)', () => {
  function makeProseDeps(dedup: OutboundDedupCache) {
    const { api, calls } = makeFakeBot()
    const effects: string[] = []
    const deps: DeliverCapturedProseDeps = {
      outboundDedup: dedup,
      bot: { api } as unknown as DeliverCapturedProseDeps['bot'],
      robustApiCall: (fn) => fn(),
      redactOutboundText: (text) => redact(text),
      recordOutbound: () => effects.push('recordOutbound'),
      HISTORY_ENABLED: false,
      OBLIGATION_LEDGER_ENABLED: true,
      obligationLedger: { close: (id) => effects.push(`obligation.close:${id}`) },
      clearSilentEndState: (k) => effects.push(`clearSilentEndState:${k}`),
      recordUndeliveredTurnEnd: () => {
        effects.push('recordUndeliveredTurnEnd')
        return { exhausted: false }
      },
      hasOutboundDeliveredSince: () => false,
    }
    return { deps, calls, effects }
  }

  it('recovers the captured answer: rich send + dedup record + obligation close + state clear', async () => {
    const dedup = new OutboundDedupCache()
    const { deps, calls, effects } = makeProseDeps(dedup)
    await deliverCapturedProse(deps, {
      chatId: CHAT,
      threadId: undefined,
      statusKeyStr: `${CHAT}:main`,
      registryKey: null,
      originTurnId: 'turn-42',
      text: 'The recovered terminal answer.',
    })
    const sends = calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('The recovered terminal answer.')
    expect(effects).toContain('obligation.close:turn-42')
    expect(effects).toContain(`clearSilentEndState:${CHAT}:main`)
    // recorded into the SHARED cache
    expect(dedup.check(CHAT, undefined, 'The recovered terminal answer.', Date.now(), null)).not.toBeNull()
  })

  it('CROSS-PATH: a captured-prose delivery suppresses the model\'s late reply retry', async () => {
    const dedup = new OutboundDedupCache()
    const { deps } = makeProseDeps(dedup)
    const text = 'Answer delivered via silent-end recovery.'
    await deliverCapturedProse(deps, {
      chatId: CHAT,
      threadId: undefined,
      statusKeyStr: `${CHAT}:main`,
      registryKey: null,
      originTurnId: 'turn-43',
      text,
    })
    // The model's late `reply` with the same content hits the SAME instance.
    const h = makeHarness({ dedup })
    const res = await sendReply(h.deps, req(text))
    expect(res.content[0]!.text).toBe('sent (deduped — same content sent via earlier path)')
    expect(h.calls).toHaveLength(0)
  })

  it('already-deduped content settles bookkeeping WITHOUT a wire send', async () => {
    const dedup = new OutboundDedupCache()
    const text = 'Already went out earlier via the stream.'
    dedup.record(CHAT, undefined, text, Date.now(), null)
    const { deps, calls, effects } = makeProseDeps(dedup)
    await deliverCapturedProse(deps, {
      chatId: CHAT,
      threadId: undefined,
      statusKeyStr: `${CHAT}:main`,
      registryKey: null,
      originTurnId: 'turn-44',
      text,
    })
    expect(calls).toHaveLength(0)
    expect(effects).toContain('obligation.close:turn-44')
  })
})

describe('structural wiring — the singleton + the gateway entry point (#2996 P2)', () => {
  const gatewaySrc = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
  const moduleSrc = readFileSync(new URL('../gateway/outbound-send-path.ts', import.meta.url), 'utf8')

  it('gateway constructs EXACTLY ONE OutboundDedupCache; the module constructs NONE', () => {
    // Amendment 1/9 hard-fail rule: a re-`new` in an extracted module
    // reinstates the duplicate-reply class. The one instance lives in
    // gateway.ts and is INJECTED everywhere else.
    expect(gatewaySrc.match(/new OutboundDedupCache\(/g) ?? []).toHaveLength(1)
    expect(moduleSrc.match(/new OutboundDedupCache\(/g) ?? []).toHaveLength(0)
  })

  it('executeReply is a thin wrapper: pins the turn and delegates to sendReply', () => {
    const after = gatewaySrc.split('async function executeReply(')[1] ?? ''
    const body = after.split('\nasync function ')[0] ?? after
    expect(body).toContain('return sendReply(gatewaySendReplyDeps(), { args, turn: currentTurn })')
  })

  it('the injected deps carry the singleton + BOTH turn accessors (Amendment 9)', () => {
    const after = gatewaySrc.split('function gatewaySendReplyDeps(')[1] ?? ''
    const body = after.split('\nasync function ')[0]?.split('\nfunction ')[0] ?? after
    expect(body).toMatch(/\n\s{4}outboundDedup,/) // the ONE instance, shorthand
    expect(body).toContain('getCurrentTurn: () => currentTurn')
    expect(body).toContain('getLastActiveTurnChatId: () => lastActiveTurnChatId')
    // The dead deps stay dead (Amendment 9): no ledger / send gate injected.
    expect(body).not.toMatch(/backstopDeliveryLedger/)
    expect(body).not.toMatch(/\bsendGate\b/)
  })

  it('deliverCapturedProse is a thin wrapper delegating to the module with the singleton', () => {
    const after = gatewaySrc.split('async function deliverCapturedProse(')[1] ?? ''
    const body = after.split('\nasync function ')[0]?.split('\n/** Live gateway deps')[0] ?? after
    expect(body).toContain('return deliverCapturedProseCore(gatewayCapturedProseDeps(), args)')
    const depsAfter = gatewaySrc.split('function gatewayCapturedProseDeps(')[1] ?? ''
    const depsBody = depsAfter.split('\nasync function ')[0]?.split('\nfunction ')[0] ?? depsAfter
    expect(depsBody).toMatch(/\n\s{4}outboundDedup,/)
  })

  it('the module keeps the pin-vs-live contract: entry pin from req, live reads via getCurrentTurn()', () => {
    const win = moduleSrc.split('export async function sendReply(')[1]?.split('\nexport ')[0] ?? ''
    expect(win).toContain('const turn = req.turn')
    // The load-bearing live re-reads survived the move (#1664 class):
    expect(win).toContain('const finalizeTurn = getCurrentTurn()')
    expect(win.match(/getCurrentTurn\(\)/g)!.length).toBeGreaterThanOrEqual(5)
  })
})

/**
 * #3429 — GATEWAY-LEVEL regression: an async handback landing after a
 * flush-delivered turn ENDED must produce a FRESH, notifying message — never a
 * silent edit-in-place of the prior turn's flushed message.
 *
 * This drives the REAL `sendReply` body (the exact gateway send path: the
 * supersede consumption at outbound-send-path.ts ~874-905 and the deferred
 * `decideSupersedeCorrection` edit-in-place lane at ~1462-1477) against the
 * fake bot API, with a REAL `FlushedTurnSupersedeRegistry` seeded exactly the
 * way the turn-flush backstop seeds it (record + 'flush'-armed ended owner
 * turn). The incident (msgs 10482/10486, 2026-07-20): the handback resolved
 * the flush-delivered ENDED turn as owner via the latest-ended tier (inside
 * the 60 s TTL), consumed the supersede record, and EDITED the flushed message
 * in place — Telegram edits never push-notify, so genuinely new content failed
 * to surface client-side. Red on pre-fix code: these first asserts see an
 * `editMessageText` call and no fresh send.
 *
 * The turn-end-funnel flag (SWITCHROOM_TURN_END_FUNNEL_V2, default ON) does
 * not fork this path — the flush branch records into the SAME registry and the
 * reply path consumes it identically under both settings — so this covers the
 * v2 funnel default.
 */
describe('#3429 — post-turn-end handback vs flush-delivered supersede (real send path)', () => {
  const OWNER_TURN_ID = `${CHAT}:_#ended-40`
  const FLUSH_MSG_ID = 4242
  const FLUSHED_TEXT =
    'Checking the fleet status now.\n\n' +
    'All twelve agents are healthy: the gateway, the vault broker, and the approval kernel ' +
    'all report green health checks, and no container has restarted in the last twenty-four hours. ' +
    'Nothing needs attention right now.'
  const CANONICAL_REPLY =
    'All twelve agents are healthy: the gateway, the vault broker, and the approval kernel ' +
    'all report green health checks, and no container has restarted in the last twenty-four hours. ' +
    'Nothing needs attention right now.'
  const HANDBACK =
    'Worker handback: the researcher sub-agent finished the migration audit. It found three ' +
    'schema drifts in the staging database, wrote the full report to the shared drive, and ' +
    'opened PR #3430 with the corrective migration. Tests are green and it is ready for review.'

  /** An ENDED, flush-delivered owner turn — exactly the atom state the
   *  turn-flush fire site leaves in `recentTurnsById` (latch 'flush', flushed
   *  text stamped, endedAt within the supersede TTL). */
  function makeFlushDeliveredEndedTurn(): CurrentTurn {
    return {
      turnId: OWNER_TURN_ID,
      sessionChatId: CHAT,
      answerDelivered: 'flush',
      flushedAnswerText: FLUSHED_TEXT,
      endedAt: Date.now() - 30_000,
      replyCalled: false,
      finalAnswerDelivered: true,
      finalAnswerSubstantive: true,
    } as unknown as CurrentTurn
  }

  function seedFlushRecord(h: ReturnType<typeof makeHarness>, owner: CurrentTurn): void {
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: owner.turnId, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now(),
    )
    // The late reply resolves the ENDED flush-delivered turn as its owner
    // (latest-ended tier — no live turn, no origin echo, no quote in a DM). This
    // is the AMBIGUOUS fallback tier: the content gate applies here, so a
    // genuinely-new handback sends fresh while the turn's own contained answer
    // still supersedes.
    h.deps.resolveReplyOwnerTurn = () => ({ turn: owner, tier: 'latest-ended' })
  }

  it('CORE REGRESSION (red pre-fix): a handback with genuinely NEW content sends a ' +
    'FRESH message — no silent edit-in-place of the flushed message', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedFlushRecord(h, owner)

    // The handback lands LATE: req.turn = null (no live gateway turn — a
    // sub-agent completion is not a new inbound).
    const res = await sendReply(h.deps, req(HANDBACK))

    // A NEW client-visible message shipped (fresh send ⇒ Telegram push
    // notifies)…
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('migration audit')
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    // …and the flushed message was NEITHER edited nor deleted (edits never
    // re-notify — the pre-fix silent path).
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)

    // The supersede record was NOT consumed: the turn's own canonical replay
    // could still correct the flushed message afterwards.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  it('PRESERVED: the turn\'s OWN canonical late replay (same answer, contained in ' +
    'the flushed blob) still supersedes via edit-in-place — no duplicate bubble', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedFlushRecord(h, owner)

    const res = await sendReply(h.deps, req(CANONICAL_REPLY))

    // The single flushed message was edited into the canonical reply…
    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(edits[0]!.text).toContain('All twelve agents are healthy')
    // …and NO second bubble shipped (the #3236/#2996 duplicate class stays closed).
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
    // Record consumed — a retry cannot re-target the now-corrected message.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        now: Date.now(),
      }).reason,
    ).toBe('no-record')
  })

  it('PRE-RECORD RACE, new content: flush fired (latch armed + text stamped) but ' +
    'record not yet written — the handback still delivers FRESH, not suppressed', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    // NO registry record (the post-fire pre-record window); owner resolution
    // still recovers the ended flush-armed turn via the latest-ended tier.
    h.deps.resolveReplyOwnerTurn = () => ({ turn: owner, tier: 'latest-ended' })

    const res = await sendReply(h.deps, req(HANDBACK))

    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('migration audit')
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })

  it('PRE-RECORD RACE, same answer: the flushed answer landing again in the race ' +
    'window is still suppressed (the #2996 Part 2 backstop holds)', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    h.deps.resolveReplyOwnerTurn = () => ({ turn: owner, tier: 'latest-ended' })

    const res = await sendReply(h.deps, req(FLUSHED_TEXT))

    expect(h.calls).toHaveLength(0) // nothing sent, nothing edited
    expect(res.content[0]!.text).toContain('deduped')
  })

  // The tier discriminator (fix/backstop-duplicate-reply). A model that narrates
  // its answer as prose (flushed as message A) then fires the `reply` tool with a
  // genuinely RE-WORDED version of the same answer is the dominant real-world
  // duplicate (agent:marko 39/54 flushes on 2026-07-20; turns #1177/#1182/#1201
  // double-sent). The reworded reply is NOT contained in the flushed blob, so
  // the #3429 content gate alone declines the supersede → fresh second bubble =
  // the visible duplicate. The fix: when the owner turn was resolved by POSITIVE
  // attribution (live / origin echo / quoted message id — NOT the ambiguous
  // latest-ended fallback), the reply IS this turn's own answer and supersedes
  // its flushed provisional draft REGARDLESS of the rewording. A genuine handback
  // (latest-ended tier) with the same divergent content must still send fresh.
  const REWORDED_SAME_TURN_ANSWER =
    'Good news on the fleet: every one of the twelve agents is running fine right now. ' +
    'The gateway, the vault broker and the approval kernel are all green, and nothing has ' +
    'restarted in the past day — so there is nothing you need to do.'

  it('CASE A (dup regression): a RE-WORDED reply resolved by a POSITIVE tier (quoted) ' +
    'supersedes the flushed draft — collapses to ONE message despite the rewording', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: owner.turnId, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now(),
    )
    // Positive attribution: the model's own reply quotes the user's inbound, so
    // owner resolution wins at the `quoted` tier — this reply IS turn's answer.
    h.deps.resolveReplyOwnerTurn = () => ({ turn: owner, tier: 'quoted' })

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // The single flushed message was edited into the reworded reply (edit-in-
    // place correction) — exactly ONE client-visible message, no fresh bubble.
    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(edits[0]!.text).toContain('every one of the twelve agents')
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
    // Record consumed — no second correction can re-fire.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        now: Date.now(),
      }).reason,
    ).toBe('no-record')
  })

  it('CASE B (no #3429 regression): the SAME divergent content resolved by the ' +
    'ambiguous latest-ended tier is treated as a handback — sends FRESH (TWO messages), ' +
    'flushed message preserved', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: owner.turnId, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now(),
    )
    // Ambiguous fallback: no live turn, no echo, no quote → latest-ended tier.
    h.deps.resolveReplyOwnerTurn = () => ({ turn: owner, tier: 'latest-ended' })

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // A fresh, notifying bubble ships and the flushed message is NEITHER edited
    // nor deleted — the flush (A) plus the fresh send (B) = two surfaced
    // messages, the correct behaviour for a genuine async handback (#3429).
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // Record NOT consumed (the turn's own canonical replay could still correct).
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })
})
