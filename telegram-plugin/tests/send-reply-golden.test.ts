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
import { describe, it, expect, afterEach, vi } from 'vitest'
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
import {
  FlushedTurnSupersedeRegistry,
  SUPERSEDE_OPEN_WINDOW_CAP_MS,
  SUPERSEDE_COMPLETED_GRACE_MS,
  flushedAnswerMatchesReply,
} from '../flushed-turn-supersede.js'
import type { ReplyOwnerTier, ReplyOwnerCandidates } from '../reply-owner-resolve.js'
import { resolveReplyOwnerTier, resolveReplyOwnerTurnId } from '../reply-owner-resolve.js'
import { SubagentHandbackMarker, stampsHandbackMarker } from '../gateway/subagent-handback-marker.js'
import { createPendingInboundBuffer } from '../gateway/pending-inbound-buffer.js'
import { SubagentReplyAuthority } from '../gateway/subagent-reply-authority.js'
import { redact } from '../secret-detect/redact.js'
import type { CurrentTurn, Access } from '../gateway/gateway.js'
import {
  SPEECH_CAPTURE_FILE_NAME,
  __resetSpeechCaptureLogStateForTests,
} from '../gateway/speech-capture.js'

/**
 * Build the owner-resolution result the gateway's `resolveReplyOwnerTurn`
 * returns, INCLUDING the candidate set the content-gate bypass corroborates
 * against (`decideContentGateBypass`).
 *
 * Default candidates model the CORROBORATED shape: the resolved turn is also the
 * framework-derived `latestEndedTurnId`, fresh within the supersede TTL — what
 * the real resolver produces for a late reply to the chat's most recent turn,
 * whether or not the model also echoed `origin_turn_id` / `reply_to`. Pass
 * `over` to model a model-STEERED attribution (an `origin`/`quoted` id pointing
 * at a turn the framework would NOT have resolved) or a stale latest-ended.
 */
function ownerRes(
  turn: CurrentTurn | null,
  tier: ReplyOwnerTier,
  over: Partial<ReplyOwnerCandidates> = {},
): { turn: CurrentTurn | null; tier: ReplyOwnerTier; candidates: ReplyOwnerCandidates } {
  const id = turn?.turnId ?? null
  return {
    turn,
    tier,
    candidates: {
      liveTurnId: tier === 'live' ? id : null,
      originTurnId: tier === 'origin' ? id : null,
      quotedTurnId: tier === 'quoted' ? id : null,
      latestEndedTurnId: id,
      latestEndedAgeMs: 30_000,
      latestEndedTtlMs: SUPERSEDE_OPEN_WINDOW_CAP_MS,
      ...over,
    },
  }
}


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
  /** `SWITCHROOM_TURN_ORIGIN_ROUTING !== '0'` — the gateway's turn-origin
   *  routing kill switch. Default true (the shipped default); pass false to
   *  drive the legacy `resolveThreadId` branch. */
  turnOriginRouting?: boolean
  /** Backing store for the `resolveThreadId` stub's last-seen fallback — the
   *  real resolver (`gateway.ts`, `resolveThreadId`) is
   *  `if (explicit != null) return Number(explicit); return chatThreadMap.get(chat_id)`,
   *  so a case that cares about what a DROPPED anchor falls through TO must
   *  populate this. Omitted → empty map → the fallback misses, which is the
   *  behaviour every pre-existing case here assumes. */
  chatThreadMap?: Map<string, number>
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
    TURN_ORIGIN_ROUTING_ENABLED: opts?.turnOriginRouting ?? true,
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
    resolveReplyOwnerTurn: () => ownerRes(null, 'none'),
    getLastSubagentHandbackAt: () => null,
    // #4176 — default: no sub-agent live (the non-delegating case). Tests that
    // exercise the gate override `h.deps.subagentReplyAuthority`.
    subagentReplyAuthority: { subagentCouldOwnReply: () => false },
    findTurnByOriginId: () => null,
    findTurnByQuotedMessageId: () => null,
    resolveAnswerThreadWithLog: (_c, explicit) => explicit,
    // Mirrors the real `resolveThreadId` (`gateway.ts`): explicit wins, else
    // the chat's LAST-SEEN topic from `chatThreadMap`. The map is per-harness
    // and chat-scoped, so a dropped cross-chat anchor falls through to the
    // TARGET chat's own last-seen topic — never to the anchor chat's.
    resolveThreadId: (c, explicit) =>
      explicit != null ? Number(explicit) : (opts?.chatThreadMap?.get(c) ?? undefined),
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

describe('speech capture (PR-0) — driven through the REAL sendReply wiring, not a synthetic call', () => {
  const priorCapture = process.env.SWITCHROOM_SPEECH_CAPTURE
  const priorStateDir = process.env.TELEGRAM_STATE_DIR

  afterEach(() => {
    if (priorCapture === undefined) delete process.env.SWITCHROOM_SPEECH_CAPTURE
    else process.env.SWITCHROOM_SPEECH_CAPTURE = priorCapture
    if (priorStateDir === undefined) delete process.env.TELEGRAM_STATE_DIR
    else process.env.TELEGRAM_STATE_DIR = priorStateDir
    __resetSpeechCaptureLogStateForTests()
  })

  it('M3: a capture write failure (flag ON, unwritable state dir) never breaks the reply', async () => {
    // The destination is a FILE, not a directory, so appendFileSync fails
    // ENOTDIR every call — the exact swallow path the flag-on window depends
    // on for 7 days unattended. This only pins the CURRENT synchronous,
    // in-place-caught shape: it proves a swallowed-write-failure reply still
    // ships, but it would NOT go red if a refactor made the capture call
    // async and fire-and-forget (unawaited) — that rejection becomes an
    // unhandled rejection, which this codebase's policy treats as fatal
    // (see analytics-posthog.ts, chat-lock.ts), strictly worse than the one
    // lost capture line this test guards against, and this test alone
    // cannot detect it. The synchronous-return contract that WOULD catch
    // that mutation is pinned directly on `captureSpeechText` in
    // `speech-capture.test.ts` ("G1: captureSpeechText returns undefined").
    const dir = mkdtempSync(join(tmpdir(), 'speech-capture-golden-'))
    const notADir = join(dir, 'state-dir-is-actually-a-file')
    writeFileSync(notADir, 'not a directory')
    process.env.SWITCHROOM_SPEECH_CAPTURE = '1'
    process.env.TELEGRAM_STATE_DIR = notADir

    const h = makeHarness()
    const res = await sendReply(h.deps, req('The reply must still ship. ✅ done.'))
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('The reply must still ship.')
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })

  it('M3: the captured string IS the exact argument passed to resolveVoiceOutPlan — not merely textually adjacent', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'speech-capture-golden-'))
    process.env.SWITCHROOM_SPEECH_CAPTURE = '1'
    process.env.TELEGRAM_STATE_DIR = stateDir

    const h = makeHarness()
    let observedByVoicePlan: string | null = null
    h.deps.resolveVoiceOutPlan = (_voiceOut, replyText) => {
      observedByVoicePlan = replyText
      return null
    }

    // Deliberately includes a spaced em-dash: `normalizeOutboundBody`'s
    // punctuation/bold pass (`normalizePunctuation`, format.ts:695, step 4
    // of the pipeline — outbound-send-path.ts's own docstring: "normalize →
    // redact → punctuation/bold → voice-scrub") rewrites a bare/mid-prose
    // em-dash into `, `. A golden fixture with nothing for the pipeline to
    // transform can't tell "capture reads the normalised `text`" apart from
    // "capture reads the raw `rawText`" — both would produce byte-identical
    // output. This fixture makes that distinction observable (G2).
    const raw = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1 | 2\n```\n\nStatus update — done. ✅ `code` 😀.'
    await sendReply(h.deps, req(raw))

    expect(observedByVoicePlan).not.toBeNull()
    const captured = readFileSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { ts: number; text: string })
    expect(captured).toHaveLength(1)
    // The load-bearing assertion: the capture is not "close to" or "derived
    // from" resolveVoiceOutPlan's input — it is the SAME string, by identity
    // of value, not by coincidence of two independent pipelines agreeing.
    expect(captured[0]!.text).toBe(observedByVoicePlan)
    // G2: the captured text is the NORMALISED form, downstream of
    // `normalizePunctuation`'s em-dash rewrite — not the raw fixture. A
    // regression that swapped in the pre-pipeline `rawText` would still
    // satisfy the identity assertion above (both call sites would agree on
    // SOME string), so this must check the captured content against the
    // known transform independently, not just against `observedByVoicePlan`.
    expect(captured[0]!.text).not.toBe(raw)
    expect(captured[0]!.text).not.toContain('Status update — done')
    expect(captured[0]!.text).toContain('Status update, done')
  })

  it('flag OFF: sendReply never creates the capture file, even with a writable state dir', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'speech-capture-golden-'))
    delete process.env.SWITCHROOM_SPEECH_CAPTURE
    process.env.TELEGRAM_STATE_DIR = stateDir

    const h = makeHarness()
    await sendReply(h.deps, req('Never captured.'))
    expect(() => readFileSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME), 'utf8')).toThrow()
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

  it('PERSIST PARITY: the exhausted-boundary plain-text fallback records the recovered answer to history', async () => {
    // #3228 exhausted-boundary: the rich send fails on the attempt where the
    // re-prompt budget is already spent, so deliverCapturedProse delivers the
    // real answer as PLAIN text. Pre-fix that plain-text delivery recorded only
    // to the in-memory dedup and NEVER called recordOutbound — so the recovered
    // answer reached the user but was silently absent from history.db. This
    // asserts recordOutbound now fires once with the delivered message_id + the
    // recovered text.
    const dedup = new OutboundDedupCache()
    // Rich send parse-rejects (one chunk → one queued failure); the plain
    // sendMessage fallback succeeds.
    const { api, calls } = makeFakeBot({ sendRichMessage: [grammy400("can't parse entities")] })
    const recorded: Array<{ chat_id: string; thread_id: number | null; message_ids: number[]; texts: string[] }> = []
    const text = 'The exhausted-boundary recovered answer.'
    const deps: DeliverCapturedProseDeps = {
      outboundDedup: dedup,
      bot: { api } as unknown as DeliverCapturedProseDeps['bot'],
      robustApiCall: (fn) => fn(),
      redactOutboundText: (t) => redact(t),
      recordOutbound: (rec) => recorded.push({ chat_id: rec.chat_id, thread_id: rec.thread_id, message_ids: rec.message_ids, texts: rec.texts }),
      HISTORY_ENABLED: true,
      OBLIGATION_LEDGER_ENABLED: true,
      obligationLedger: { close: () => {} },
      clearSilentEndState: () => {},
      // Budget already spent → the fallback path fires.
      recordUndeliveredTurnEnd: () => ({ exhausted: true }),
      hasOutboundDeliveredSince: () => false,
    }
    await deliverCapturedProse(deps, {
      chatId: CHAT,
      threadId: undefined,
      statusKeyStr: `${CHAT}:main`,
      registryKey: null,
      originTurnId: 'turn-45',
      text,
    })
    // The plain-text fallback actually delivered.
    const plainSends = calls.filter((c) => c.method === 'sendMessage')
    expect(plainSends).toHaveLength(1)
    expect(plainSends[0]!.text).toBe(text)
    // …and it was persisted to history exactly once with the delivered id + text.
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.chat_id).toBe(CHAT)
    expect(recorded[0]!.message_ids).toEqual([plainSends[0]!.message_id])
    expect(recorded[0]!.texts).toEqual([text])
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

  it('executeReply is a thin wrapper: pins the turn, computes the caller-identity ' +
    'gate (#4172), and delegates to sendReply', () => {
    const after = gatewaySrc.split('async function executeReply(')[1] ?? ''
    const body = after.split('\nasync function ')[0] ?? after
    expect(body).toContain('return sendReply(gatewaySendReplyDeps(), {')
    expect(body).toContain('turn: currentTurn')
    // #4172 wiring pin — dropping the identity plumbing silently re-opens the
    // cron-edits-over-flushed-answer hole, so its presence is pinned here.
    expect(body).toContain('callerIsForeignSession: replyCallerIsForeignSession(callerAgentName)')
  })

  it('#4172 wiring — onToolCall threads the calling client identity into the dispatch', () => {
    expect(gatewaySrc).toContain('executeToolCall(msg.tool, msg.args, client.agentName)')
  })

  it('#4173/#4175 wiring — the owner-resolver candidates carry the completion ' +
    'window bounds (dropping them now fails CLOSED, not open)', () => {
    // The composition lives in reply-owner-wiring.ts (anti-inflation ratchet);
    // the gateway keeps a thin wrapper that binds its stateful lookups.
    const wiringSrc = readFileSync(
      new URL('../gateway/reply-owner-wiring.ts', import.meta.url),
      'utf8',
    )
    expect(wiringSrc).toContain('latestEndedTtlMs: SUPERSEDE_OPEN_CAP_MS')
    expect(wiringSrc).toContain('latestEndedRealEndAgeMs')
    expect(wiringSrc).toContain('latestEndedCompletedGraceMs: SUPERSEDE_GRACE_MS')
    const after = gatewaySrc.split('function resolveReplyOwnerTurn(')[1] ?? ''
    const body = after.split('\nfunction ')[0] ?? after
    expect(body).toContain('resolveReplyOwnerTurnWith(')
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
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')
  }

  it('CORE REGRESSION (red pre-fix): a handback with genuinely NEW content sends a ' +
    'FRESH message — no silent edit-in-place of the flushed message', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedFlushRecord(h, owner)
    // A background sub-agent handback WAS enqueued for this chat after the
    // flushed turn ended and within the supersede TTL — so this late reply might
    // BE that handback. The marker keeps the #3429 content gate. (owner.endedAt
    // = now-30s; handback at now-15s is after it and within the 60s TTL.)
    h.deps.getLastSubagentHandbackAt = () => Date.now() - 15_000

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
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')

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
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')

    const res = await sendReply(h.deps, req(FLUSHED_TEXT))

    expect(h.calls).toHaveLength(0) // nothing sent, nothing edited
    expect(res.content[0]!.text).toContain('deduped')
  })

  // ─── The REAL marko DM incident (fix/backstop-duplicate-reply) ───
  //
  // The dominant real duplicate: the model narrates its answer as prose (flushed
  // as message A), then fires the `reply` tool with a RE-WORDED version of the
  // same answer. On a DM this late reply has NO live turn, NO `origin_turn_id`
  // echo, and NO explicit `reply_to`, so it resolves its owner via the ambiguous
  // `latest-ended` tier — the #3429 content gate then declines (reworded text ⊄
  // flushed blob) and a fresh SECOND bubble ships = the visible duplicate
  // (agent:marko 2026-07-20: turns #1177/#1182/#1201 double-sent; 11/11 declines
  // were own-replies with NO handback in flight).
  //
  // The two cases are indistinguishable by tier (both latest-ended) and by
  // content (rewording). The deterministic discriminator is the gateway-
  // synthesized `subagent_handback` marker: case A has NONE enqueued after the
  // flushed turn ended; a genuine background handback (case B) does. These two
  // tests drive the REAL send path with the REAL supersede registry over the
  // SAME reworded text and the SAME latest-ended tier, differing ONLY in the
  // handback marker — proving it is the marker that flips the outcome.
  const REWORDED_SAME_TURN_ANSWER =
    'Good news on the fleet: every one of the twelve agents is running fine right now. ' +
    'The gateway, the vault broker and the approval kernel are all green, and nothing has ' +
    'restarted in the past day — so there is nothing you need to do.'

  function seedRecord(h: ReturnType<typeof makeHarness>, owner: CurrentTurn): void {
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: owner.turnId, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now(),
    )
  }

  it('CASE A — REAL marko DM incident: reworded own reply, latest-ended tier, ' +
    'NO handback in flight → supersedes the flushed draft, collapses to ONE message', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    // Late DM reply: latest-ended tier (the path the tier discriminator MISSES),
    // and crucially NO subagent_handback was enqueued for this chat after the
    // turn ended — so the reply is the flushed turn's OWN answer.
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // Exactly ONE client-visible message: the flushed message edited in place
    // into the reworded reply — NO fresh second bubble (duplicate closed).
    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(edits[0]!.text).toContain('every one of the twelve agents')
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
    // Record consumed.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        now: Date.now(),
      }).reason,
    ).toBe('no-record')
  })

  it('CASE B — genuine background handback: SAME reworded text, SAME latest-ended tier, ' +
    'but a handback WAS enqueued in-window → keeps the gate, sends FRESH (TWO messages)', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')
    // A background sub-agent handback was enqueued for this chat AFTER the turn
    // ended (now-30s) and within the 60s TTL (now-15s) — this reply might BE it.
    h.deps.getLastSubagentHandbackAt = () => Date.now() - 15_000

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // A fresh notifying bubble ships; the flushed message is NEITHER edited nor
    // deleted — flush (A) + fresh (B) = two surfaced messages (#3429 preserved).
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // Record NOT consumed.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  it('MUST-FIX 1 (silent-data-loss): a handback reply model-STEERED to the quoted ' +
    'tier (reply_to = the flushed turn\'s source msg) must NOT edit/delete the flushed ' +
    'answer while a handback is in flight — sends FRESH (two messages)', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    // The `quoted` tier is derived from the MODEL-SUPPLIED `args.reply_to`, so a
    // background handback turn can point reply_to at the user's original message
    // (which the prior turn's flush is recorded against) to resolve THAT turn via
    // `quoted`. A handback IS in flight, so a positive tier must NOT override the
    // #3429 content gate — else the reworded handback text silently edits over
    // the flushed turn's DELIVERED answer (Telegram edits don't re-notify).
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'quoted')
    h.deps.getLastSubagentHandbackAt = () => Date.now() - 15_000

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // Fresh notifying send; the flushed answer is NEITHER edited nor deleted.
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // Flush record NOT consumed — the flushed answer stands.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  it('the framework-owned `live` tier MAY still bypass a handback window (a live ' +
    'currentTurn is not model-derived and cannot collide with an ended turn\'s record)', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'live')
    h.deps.getLastSubagentHandbackAt = () => Date.now() - 15_000

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // Live tier bypasses → supersede via edit-in-place (one message).
    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })

  it('MUST-FIX 2 (boot-replay): a handback re-pushed through the buffer chokepoint ' +
    'stamps the marker (with the envelope ts) → gate preserved → FRESH send, no silent edit', async () => {
    // Real marker + real buffer wired exactly as the gateway wires them. The
    // boot-replay loop re-pushes un-acked spooled inbounds — including handback
    // envelopes — through this SAME push(); the chokepoint stamp is what makes a
    // replayed handback populate the (post-restart empty) marker.
    const marker = new SubagentHandbackMarker()
    const buffer = createPendingInboundBuffer({
      log: () => {},
      onHandbackEnqueue: (chatId, threadId, ts) => marker.record(chatId, threadId, ts),
    })

    // Simulate the boot-replay re-push of an un-acked spooled handback envelope.
    // The envelope carries its own ms `ts` (after the flushed turn ended, within
    // TTL) — owner.endedAt below is now-30s, this handback is now-15s.
    const handbackTs = Date.now() - 15_000
    buffer.push('marko', {
      type: 'inbound',
      chatId: CHAT,
      messageId: handbackTs,
      user: 'subagent-watcher',
      userId: 0,
      ts: handbackTs,
      text: 'handback result',
      meta: { source: 'subagent_handback' },
    })
    // The chokepoint stamped the marker from the replay push (pre-fix: empty).
    expect(marker.lastAt(CHAT, undefined)).toBe(handbackTs)

    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')
    // The gateway reads the marker the boot-replay stamped (chat-wide gate).
    h.deps.getLastSubagentHandbackAt = (chatId) => marker.lastAtInChat(chatId)

    const res = await sendReply(h.deps, req(HANDBACK))

    // Gate preserved → the replayed handback delivers FRESH; the post-boot
    // flushed answer is NEITHER edited nor deleted (no silent #3429 on restart).
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })

  it('the buffer chokepoint stamps ONLY handback envelopes (a normal inbound does not)', () => {
    const marker = new SubagentHandbackMarker()
    const buffer = createPendingInboundBuffer({
      log: () => {},
      onHandbackEnqueue: (chatId, threadId, ts) => marker.record(chatId, threadId, ts),
    })
    buffer.push('marko', {
      type: 'inbound', chatId: CHAT, messageId: 5, user: 'ken', userId: 1,
      ts: Date.now(), text: 'hi', meta: {},
    })
    expect(marker.lastAt(CHAT, undefined)).toBe(null)
  })

  // ─── MUST-FIX 2 (dup-audit / Fable): the gate is un-steerable by a model
  //     thread arg — a cross-topic handback still keeps the content gate ───
  //
  // Fable's PROVEN regression: F2's thread-keyed gate read let a foreign-content
  // reply carrying `message_thread_id=<other topic>` dodge a handback marker
  // stamped on the real topic → silent edit-over (the #3429 double-loss). Because
  // `findLatestEndedTurnForChat` resolves owners CHAT-WIDE, a topic-A handback can
  // resolve — and supersede — topic B's ended turn. The gate read is therefore
  // chat-wide (`lastAtInChat`): any in-window handback in the chat keeps the gate,
  // so the reply's own thread arg cannot bypass it. Drives the REAL buffer
  // chokepoint + REAL send path.
  it('MUST-FIX 2: a handback stamped in topic A keeps the content gate for a ' +
    'foreign reply steered to topic B (message_thread_id) — FRESH send, no silent edit-over', async () => {
    const TOPIC_A = 111
    const TOPIC_B = 222
    const marker = new SubagentHandbackMarker()
    const buffer = createPendingInboundBuffer({
      log: () => {},
      onHandbackEnqueue: (chatId, threadId, ts) => marker.record(chatId, threadId, ts),
    })
    // A background handback lands in TOPIC A (envelope threadId=A) via the real
    // chokepoint — after topic B's turn ended (now-30s), within the 60s TTL.
    const handbackTs = Date.now() - 15_000
    buffer.push('marko', {
      type: 'inbound', chatId: CHAT, threadId: TOPIC_A, messageId: handbackTs,
      user: 'subagent-watcher', userId: 0, ts: handbackTs, text: 'handback',
      meta: { source: 'subagent_handback' },
    })

    // Topic B has its OWN flush-delivered ended turn with a real answer.
    const h = makeHarness()
    const owner = { ...makeFlushDeliveredEndedTurn(), sessionThreadId: TOPIC_B } as unknown as CurrentTurn
    h.deps.flushedTurnSupersede.record(
      CHAT, TOPIC_B,
      { turnId: (owner as CurrentTurn).turnId, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now(),
    )
    // The topic-A handback's reply is STEERED to topic B (message_thread_id=222)
    // and resolves topic B's ended turn chat-wide (latest-ended), carrying FOREIGN
    // content. The gate read is chat-wide, so the topic-A stamp is seen.
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner as CurrentTurn, 'latest-ended')
    h.deps.getLastSubagentHandbackAt = (chatId) => marker.lastAtInChat(chatId)

    const res = await sendReply(
      h.deps,
      req(HANDBACK, { message_thread_id: TOPIC_B }),
    )

    // Gate kept → FRESH notifying send; topic B's flushed answer is NEITHER
    // edited nor deleted. (Under the F2 thread-keyed gate this was editMessageText
    // ×1 over msg 4242 — the silent-loss regression this closes.)
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // Topic B's flush record NOT consumed — the delivered answer stands.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, TOPIC_B, {
        liveTurnId: (owner as CurrentTurn).turnId,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  // Thread-keyed COLLAPSE still routes per-topic: a topic reply supersedes its
  // OWN topic's flush record (via the framework-resolved owner thread, not the
  // raw arg), so a genuine own-reply in a forum topic collapses to one message.
  it('F2 positive: a topic own-reply (no handback) supersedes its own topic\'s ' +
    'flush record — one message, on the framework-resolved thread lane', async () => {
    const TOPIC = 222
    const h = makeHarness()
    const owner = { ...makeFlushDeliveredEndedTurn(), sessionThreadId: TOPIC } as unknown as CurrentTurn
    // Flush recorded on the owner turn's OWN topic lane (what the flush does).
    h.deps.flushedTurnSupersede.record(
      CHAT, TOPIC,
      { turnId: (owner as CurrentTurn).turnId, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now(),
    )
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner as CurrentTurn, 'latest-ended')
    h.deps.getLastSubagentHandbackAt = () => null // no handback anywhere

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER, { message_thread_id: TOPIC }))

    // Collapses to ONE message: the topic's flushed message edited in place.
    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })

  // ─── F1 (dup-audit): negative outcome guard — no silent edit-over ───
  //
  // The content-gate bypass must NEVER silently edit over a flush-delivered
  // answer with FOREIGN content on a non-live tier. A decoupled completion (the
  // handback class the marker covers) landing with genuinely different content,
  // resolving an ended flushed turn via the latest-ended tier, must SEND FRESH —
  // the flushed answer left untouched (Telegram edits do not re-notify, so an
  // edit-over is a silent double-loss: the handback never surfaces AND the answer
  // is destroyed — the #3429 incident). This pins the invariant's OUTCOME: the
  // stamp (driven by the single chokepoint predicate) keeps the gate, and the
  // foreign reply never touches the delivered answer.
  it('F1: a decoupled foreign-content reply on a non-live tier resolving a ' +
    'DIFFERENT ended turn sends FRESH — the flushed answer is never edited/deleted', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    // The reply resolves the flush-delivered ENDED turn via the ambiguous
    // latest-ended tier (no live turn, no positive attribution) and carries
    // FOREIGN content (a worker report, not this turn's answer nor a rewording).
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')
    // A decoupled completion IS in the window (the marker stamped it) — so this
    // late reply might BE it. The invariant keeps the content gate.
    h.deps.getLastSubagentHandbackAt = () => Date.now() - 15_000

    const res = await sendReply(h.deps, req(HANDBACK))

    // FRESH notifying send; the flushed answer is NEITHER edited nor deleted.
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('migration audit')
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // The flush record is NOT consumed — the flushed answer stands, and the
    // turn's OWN canonical replay can still correct it.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  // Structural: the stamp membership lives in exactly ONE predicate, consulted
  // at the ONE buffer chokepoint. If a future refactor inlines a bare
  // `=== 'subagent_handback'` check at the chokepoint (bypassing the predicate),
  // the invariant's single-extension-point guarantee is lost — fail loudly.
  it('F1: the buffer chokepoint stamps via the stampsHandbackMarker predicate, ' +
    'not an inlined source literal', () => {
    const bufferSrc = readFileSync(new URL('../gateway/pending-inbound-buffer.ts', import.meta.url), 'utf8')
    expect(bufferSrc).toContain('stampsHandbackMarker(msg.meta?.source)')
    // The predicate itself is the single membership definition.
    expect(stampsHandbackMarker('subagent_handback')).toBe(true)
    expect(stampsHandbackMarker('cron')).toBe(false)
    expect(stampsHandbackMarker('resume_interrupted')).toBe(false)
    expect(stampsHandbackMarker(undefined)).toBe(false)
  })

  // ─── MUST-FIX 1 (dup-audit / Fable): an UNCORROBORATED steerable tier ───
  //
  // The `quoted`/`origin` tiers resolve from MODEL-supplied args (reply_to /
  // origin_turn_id), so a reply can steer ITSELF onto a DIFFERENT ended turn's
  // record and — with the content gate bypassed — silently edit over that turn's
  // delivered answer. Fable executed this exact path (quoted tier, no marker,
  // foreign content → editMessageText ×1 over the flushed answer).
  //
  // What blocks it is CORROBORATION, not a blanket tier ban: the steered
  // attribution points at a turn the FRAMEWORK-derived `latestEndedTurnId` does
  // NOT resolve, so `decideContentGateBypass` declines and the content gate
  // holds. The `latestEndedTurnId` override below is what makes this test model
  // steering rather than a plain self-echo.
  it('MUST-FIX 1: a quoted-tier reply STEERED onto a different turn than the ' +
    'framework resolves, with NO marker and FOREIGN content, does NOT bypass the ' +
    'content gate — FRESH send, flushed answer never edited/deleted', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    // Model-steered `quoted` attribution onto the flushed turn, while the
    // framework's own latest-ended candidate is a DIFFERENT, newer turn — the
    // divergence that proves the attribution is model-driven. No decoupled
    // completion anywhere in the chat (the residual F1 vector).
    h.deps.resolveReplyOwnerTurn = () =>
      ownerRes(owner, 'quoted', { latestEndedTurnId: `${CHAT}:_#ended-99` })
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, req(HANDBACK))

    // FRESH notifying send; the flushed answer is NEITHER edited nor deleted.
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('migration audit')
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // Flush record NOT consumed — the delivered answer stands.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  // Sibling positive: a quoted-tier reply carrying the turn's OWN answer (same
  // content, contained in the flushed blob) still collapses through the content
  // gate — the tier restriction only blocks FOREIGN content, not genuine replays.
  it('MUST-FIX 1 sibling: a quoted-tier reply with the SAME answer still collapses ' +
    '(content gate passes) — one message', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'quoted')
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, req(CANONICAL_REPLY))

    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })

  // ─── 2026-07-27 DM incident: a CORROBORATED `origin` echo must collapse ───
  //
  // The observed failure (a DM agent delivered two answers twice — a flushed
  // copy plus a reworded `reply` copy, each time):
  //
  //   1. the answer-ready quiescence flush posted the turn's composed prose as
  //      message A ("turn-flush firing — N chars without reply tool");
  //   2. the silent-end Stop hook told the agent its answer had not reached the
  //      user, so it fired `reply` with a RE-WORDED version of the same answer;
  //   3. the agent also echoed `origin_turn_id` back — pointing at its OWN turn —
  //      so owner resolution won on the `origin` tier, not `latest-ended`
  //      (`reply-route ... via=origin late=true originTurn=<same turn>`);
  //   4. `origin` was banned outright from the content-gate bypass, so the gate
  //      ran, the rewording defeated both equality and containment, and the
  //      gateway logged `flush supersede declined — new content (#3429)` and
  //      shipped message B — a visible duplicate.
  //
  // Note what the incident was NOT: not a captured-prose delivery (this is the
  // quiescence turn-flush path), and not a text-matcher failure that a smarter
  // matcher would fix. Rewording is model-dependent and cannot be matched
  // reliably; the deterministic signal is that the echoed turn is the SAME turn
  // the framework's own `latestEndedTurnId` resolves. This test drives the REAL
  // send path over that exact shape.
  it('2026-07-27 REGRESSION: a reworded same-turn reply that ALSO echoes ' +
    'origin_turn_id for its own turn collapses to ONE message (corroborated ' +
    '`origin` tier bypasses the content gate)', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    // `origin` tier — the model echoed origin_turn_id — but pointing at the SAME
    // turn the framework-derived latestEndedTurnId resolves (ownerRes's default),
    // i.e. corroborated: the model gained nothing it couldn't have had by
    // omitting the echo entirely.
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'origin')
    // No decoupled completion in the window — the reply is this turn's own answer.
    h.deps.getLastSubagentHandbackAt = () => null

    // The reworded answer defeats BOTH text paths the old gate relied on, so the
    // test cannot pass by accident through `flushedAnswerMatchesReply`.
    expect(flushedAnswerMatchesReply(FLUSHED_TEXT, REWORDED_SAME_TURN_ANSWER)).toBe(false)

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // OUTCOME: exactly ONE client-visible message. The flushed message A is
    // corrected in place into the reworded answer; NO second bubble ships.
    // (Pre-fix this was sendRichMessage ×1 alongside the surviving flush = the
    // two Telegram messages the user actually received.)
    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(edits[0]!.text).toContain('every one of the twelve agents')
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
    // Record consumed — the flush is gone, not merely shadowed.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        now: Date.now(),
      }).reason,
    ).toBe('no-record')
  })

  // The behaviour the old "new content" check was really protecting: an agent
  // that deliberately sends a SECOND, genuinely different message in the same
  // turn must not have its first one deleted. This is structural, not textual —
  // the registry CONSUMES the record on supersede, so the second reply finds
  // 'no-record' and can never reach the first message. No reply counter needed.
  it('PRESERVED: a deliberate SECOND reply in the same turn does NOT delete or ' +
    'edit the first — both messages survive', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'origin')
    h.deps.getLastSubagentHandbackAt = () => null

    // Reply #1 — the reworded answer; supersedes the flush (one message so far).
    await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))
    const afterFirst = h.calls.length
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1)

    // Reply #2 — a deliberate follow-up in the SAME turn, genuinely new content.
    const res = await sendReply(h.deps, req(HANDBACK))

    const later = h.calls.slice(afterFirst)
    // It ships as its OWN fresh notifying message…
    const fresh = later.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('migration audit')
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    // …and it neither deletes nor re-edits the message the first reply owns.
    expect(later.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(later.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })

  // Same corroboration rule on the other steerable tier, so a model that quotes
  // instead of echoing gets the same collapse rather than a duplicate.
  it('a reworded same-turn reply on a CORROBORATED `quoted` tier also collapses ' +
    'to one message', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'quoted')
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })

  // The corroboration must not resurrect the handback hazard: even a self-echoed
  // `origin` attribution keeps the content gate while a decoupled completion is
  // in the window, because the late reply might BE that completion.
  it('a corroborated `origin` reply STILL keeps the content gate while a handback ' +
    'is in the window — foreign content sends FRESH, flush untouched', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'origin')
    h.deps.getLastSubagentHandbackAt = () => Date.now() - 15_000

    const res = await sendReply(h.deps, req(HANDBACK))

    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('migration audit')
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // The flushed answer stands — its record is intact for the turn's own replay.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        replyText: CANONICAL_REPLY,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  // ─── #3727: the F1 RESIDUAL cell, pinned as an ACCEPTED trade-off ───
  //
  // Corroborated `origin`/`quoted` + FOREIGN content + NO handback marker in the
  // window. Both guards pass — the attribution is framework-corroborated, and
  // nothing says a decoupled completion is outstanding — so the content gate is
  // BYPASSED and the flushed answer is corrected in place. This is the accepted
  // outcome, not an oversight, and these tests exist so it can never flip
  // silently in either direction:
  //
  //   - it is NOT new reach. The identical reply reaches the identical outcome
  //     today by omitting `origin_turn_id` / `reply_to` and landing on
  //     `latest-ended` with the same turn (the zero-new-capability property,
  //     swept exhaustively in `reply-owner-resolve.test.ts`).
  //   - it IS the documented F1 residual: a genuinely decoupled completion that
  //     fails to stamp the `subagent_handback` marker is indistinguishable from
  //     the turn's own reworded answer, because rewording cannot be matched
  //     textually. The MITIGATION is the marker itself — stamped at the single
  //     buffer chokepoint via `stampsHandbackMarker` (see the F1 tests above,
  //     which pin the marked case sending FRESH with the flush untouched).
  //
  // If a future tightening of the corroboration rule flips this cell to a fresh
  // send, these go red — decide deliberately, don't drift into it.
  for (const tier of ['origin', 'quoted'] as const) {
    it(`#3727 (F1 residual, ACCEPTED): a corroborated \`${tier}\` reply with FOREIGN ` +
      'content and NO handback marker bypasses the gate — the flushed answer is ' +
      'edited in place, exactly one message survives', async () => {
      const h = makeHarness()
      const owner = makeFlushDeliveredEndedTurn()
      seedRecord(h, owner)
      // Corroborated: the model-supplied attribution names the SAME turn the
      // framework-derived `latestEndedTurnId` resolves (ownerRes's default).
      h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, tier)
      // No decoupled completion anywhere in the chat — the residual F1 vector.
      h.deps.getLastSubagentHandbackAt = () => null

      // The content is genuinely FOREIGN: the gate would have declined it, so
      // this test cannot pass by accident through `flushedAnswerMatchesReply`.
      expect(flushedAnswerMatchesReply(FLUSHED_TEXT, HANDBACK)).toBe(false)

      const res = await sendReply(h.deps, req(HANDBACK))

      // OUTCOME: exactly one client-visible message — the flushed message A is
      // edited into the foreign content; NO second bubble ships.
      const edits = h.calls.filter((c) => c.method === 'editMessageText')
      expect(edits).toHaveLength(1)
      expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
      expect(edits[0]!.text).toContain('migration audit')
      expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
      expect(res.content[0]!.text).toMatch(/^sent/)
      // The flush record is CONSUMED — the provisional answer is gone, not
      // merely shadowed.
      expect(
        h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
          liveTurnId: OWNER_TURN_ID,
          now: Date.now(),
        }).reason,
      ).toBe('no-record')
    })
  }

  // A STALE framework candidate must not corroborate anything: the latest-ended
  // freshness bound (F2) is what stops an old turn inheriting deletion authority.
  it('a `origin` echo does NOT bypass when the framework latest-ended candidate ' +
    'is STALE (past the supersede TTL) — content gate holds', async () => {
    const h = makeHarness()
    const owner = makeFlushDeliveredEndedTurn()
    seedRecord(h, owner)
    h.deps.resolveReplyOwnerTurn = () =>
      ownerRes(owner, 'origin', { latestEndedAgeMs: SUPERSEDE_OPEN_WINDOW_CAP_MS + 1 })
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, req(REWORDED_SAME_TURN_ANSWER))

    // Gate held → fresh send, flushed message untouched.
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })
})

describe('2026-08-01 klanker incident — slow flush→reply gap through the REAL send path', () => {
  // gateway-supervisor.log, chat 12345: the answer-ready quiescence flush
  // delivered msg 25680 at 21:17:04, a proactive /compact ran, the Stop hook
  // nudged the model, and the canonical `reply` landed at 21:19:28 — 143 s
  // after the flush, REWORDED post-compact (1770 vs 1563 chars). Under the old
  // 60 s SUPERSEDE_OPEN_WINDOW_CAP_MS the registry record was 'expired' AND the
  // latest-ended owner tier rejected the 143 s-old turn, so msg 25682 shipped
  // as a visible duplicate. This drives the REAL sendReply with the incident
  // timeline and asserts the outcome: the late reply corrects the flushed
  // message in place — never a second bubble.
  const OWNER_TURN_ID = `${CHAT}:_#25674`
  const FLUSH_MSG_ID = 25680
  const GAP_MS = 143_000
  const FLUSHED_TEXT =
    'Pulled the live numbers from the usage table. Two findings, and the second one matters: ' +
    'the per-turn cost is dominated by cache writes, not output tokens, so trimming the reply ' +
    'length will not move the bill much.'
  // Post-compact the model REGENERATED the answer — same substance, different
  // bytes. Neither exact-text dedup nor containment matching can catch this;
  // only turnId identity + the content-gate bypass (no handback in window) can.
  const REWORDED_REPLY =
    'I pulled the live numbers out of the usage table. Two findings — and the second is the one ' +
    'that matters: cache writes, not output tokens, dominate the per-turn cost, so shortening ' +
    'replies will barely move the bill.'

  function makeStaleFlushDeliveredTurn(): CurrentTurn {
    return {
      turnId: OWNER_TURN_ID,
      sessionChatId: CHAT,
      answerDelivered: 'flush',
      flushedAnswerText: FLUSHED_TEXT,
      endedAt: Date.now() - GAP_MS,
      replyCalled: false,
      finalAnswerDelivered: true,
      finalAnswerSubstantive: true,
    } as unknown as CurrentTurn
  }

  it('outcome: the reworded reply landing 143 s after the flush edits the flushed ' +
    'message in place — exactly one bubble, no duplicate', async () => {
    const h = makeHarness()
    const owner = makeStaleFlushDeliveredTurn()
    // The flush recorded its message 143 s ago (NOT freshly — the incident gap).
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: OWNER_TURN_ID, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now() - GAP_MS,
    )
    // Late DM reply: no live turn, no origin echo, no quote → latest-ended tier,
    // with the REAL 143 s age the gateway would compute from `endedAt`.
    h.deps.resolveReplyOwnerTurn = () =>
      ownerRes(owner, 'latest-ended', { latestEndedAgeMs: GAP_MS })
    // No subagent handback anywhere in the window (the incident had none).
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, req(REWORDED_REPLY))

    // The flushed message was edited into the canonical reply…
    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(edits[0]!.text).toContain('cache writes')
    // …and NO second bubble shipped — the exact duplicate the incident produced.
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })
})


describe('#4172 — a foreign-session (cheap-cron) reply can never touch a flushed answer', () => {
  const OWNER_TURN_ID = `${CHAT}:_#flushed-90`
  const FLUSH_MSG_ID = 25680
  const FLUSHED_TEXT =
    'Pulled the live numbers from the usage table. Two findings, and the second one matters: ' +
    'the per-turn cost is dominated by cache writes, not output tokens, so trimming reply ' +
    'length will not move the bill much.'
  // The measured #4172 shape: an unrelated Tier-1 cron digest landing 90 s
  // after the flush — decoupled (no live turn), foreign content, NO handback
  // marker (a cheap-cron fire never traverses pendingInboundBuffer.push).
  const CRON_DIGEST =
    'Morning digest: 3 PRs merged overnight, CI green on main, no pages. ' +
    'Standup is at 9:30 and the vault broker cert renews tomorrow.'

  function makeFlushedOwner(): CurrentTurn {
    return {
      turnId: OWNER_TURN_ID,
      sessionChatId: CHAT,
      answerDelivered: 'flush',
      flushedAnswerText: FLUSHED_TEXT,
      endedAt: Date.now() - 90_000,
      // #4173 — window OPEN: the flush ended the turn synthetically and the
      // session's real turn_end has not been observed.
      realEndObservedAt: null,
      replyCalled: false,
      finalAnswerDelivered: true,
      finalAnswerSubstantive: true,
    } as unknown as CurrentTurn
  }

  function seed(h: ReturnType<typeof makeHarness>): CurrentTurn {
    const owner = makeFlushedOwner()
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: OWNER_TURN_ID, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now() - 90_000,
    )
    // Latest-ended tier, corroborated, no marker → the bypass would apply for
    // a MAIN-session reply. The identity gate is the only thing standing
    // between the cron digest and the flushed answer.
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')
    h.deps.getLastSubagentHandbackAt = () => null
    return owner
  }

  it('BLOCKER REPRO: the cron digest sends FRESH — zero edits/deletes of the ' +
    'flushed message, record intact for the turn\'s own replay', async () => {
    const h = makeHarness()
    seed(h)

    const res = await sendReply(h.deps, {
      args: { chat_id: CHAT, text: CRON_DIGEST },
      turn: null,
      callerIsForeignSession: true, // the `<agent>-cron` bridge (#4172)
    })

    // OUTCOME: msg A untouched; the digest is a fresh, NOTIFYING message.
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('Morning digest')
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // The record survives for the flushed turn's own genuine late replay.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  it('NEGATIVE CONTROL (the measured failure): the SAME reply on the main-bridge ' +
    'path destroys the flushed answer by edit — proving the identity gate is ' +
    'load-bearing, not incidental', async () => {
    const h = makeHarness()
    seed(h)

    // Identical scenario, but the caller is treated as the main session (the
    // pre-fix behaviour): bypass applies → the digest edits over msg A — the
    // #4172 double loss (flushed answer destroyed, digest delivered silently).
    await sendReply(h.deps, {
      args: { chat_id: CHAT, text: CRON_DIGEST },
      turn: null,
      callerIsForeignSession: false,
    })

    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
  })

  it('a foreign-session reply is never swallowed by the flush-armed latch ' +
    '(pre-record race window)', async () => {
    // The flush FIRED but has not recorded yet (no supersede record, latch
    // armed, no flushed text stashed → replyMatchesFlushedAnswer resolves
    // null). A main-session late reply is suppressed here (the flush race);
    // the cron digest must NOT be — suppressing it silently drops the user's
    // scheduled output.
    const h = makeHarness()
    const owner = {
      ...makeFlushedOwner(),
      flushedAnswerText: null,
    } as unknown as CurrentTurn
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended')
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, {
      args: { chat_id: CHAT, text: CRON_DIGEST.repeat(2) }, // ≥200 chars → substantive
      turn: null,
      callerIsForeignSession: true,
    })

    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)
  })
})

describe('#4173 — the completed window closes the same-bridge decoupled-reply hole ' +
  '(Task sub-agent replying after the parent turn ended)', () => {
  const OWNER_TURN_ID = `${CHAT}:_#flushed-77`
  const FLUSH_MSG_ID = 31337
  const FLUSHED_TEXT =
    'Deployment review finished: the canary is healthy, error rates are flat, and the ' +
    'rollout can proceed to the next ring this afternoon.'
  const LATE_WORKER_REPLY =
    'Background worker done: the log-archive sweep compressed 14 GB across three agents ' +
    'and freed the disk pressure alert. Full manifest is in the shared drive.'

  it('a foreign-content reply landing 90 s AFTER the real turn_end resolves NO owner ' +
    'through the REAL tier rule → sends fresh, flushed answer untouched', async () => {
    const h = makeHarness()
    const realEndAgo = 90_000 // > SUPERSEDE_COMPLETED_GRACE_MS
    const owner = {
      turnId: OWNER_TURN_ID,
      sessionChatId: CHAT,
      answerDelivered: 'flush',
      flushedAnswerText: FLUSHED_TEXT,
      endedAt: Date.now() - realEndAgo,
      realEndObservedAt: Date.now() - realEndAgo, // real turn_end OBSERVED
      replyCalled: false,
      finalAnswerDelivered: true,
      finalAnswerSubstantive: true,
    } as unknown as CurrentTurn
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      {
        turnId: OWNER_TURN_ID,
        messageIds: [FLUSH_MSG_ID],
        text: FLUSHED_TEXT,
        completedAt: Date.now() - realEndAgo,
      },
      Date.now() - realEndAgo,
    )
    // Drive the REAL acceptance rule (the exact composition the gateway runs):
    // the candidates carry the completed-window signal, so the latest-ended
    // tier REJECTS the 90 s-stale turn and the owner resolves null.
    const candidates: ReplyOwnerCandidates = {
      liveTurnId: null,
      originTurnId: null,
      quotedTurnId: null,
      latestEndedTurnId: OWNER_TURN_ID,
      latestEndedAgeMs: realEndAgo,
      latestEndedTtlMs: SUPERSEDE_OPEN_WINDOW_CAP_MS,
      latestEndedRealEndAgeMs: realEndAgo,
      latestEndedCompletedGraceMs: SUPERSEDE_COMPLETED_GRACE_MS,
    }
    const tier = resolveReplyOwnerTier(candidates)
    expect(tier).toBe('none') // the completed window did its job
    const winnerId = resolveReplyOwnerTurnId(candidates)
    h.deps.resolveReplyOwnerTurn = () => ({
      turn: winnerId != null ? owner : null,
      tier,
      candidates,
    })
    h.deps.getLastSubagentHandbackAt = () => null

    const res = await sendReply(h.deps, {
      args: { chat_id: CHAT, text: LATE_WORKER_REPLY },
      turn: null, // decoupled — the parent turn ended long ago
    })

    // OUTCOME: fresh send; the flushed answer is not edited or deleted.
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('log-archive sweep')
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })
})


describe('#4174 — the handback gate-hold is bounded by its OWN 60 s recency window', () => {
  const OWNER_TURN_ID = `${CHAT}:_#flushed-55`
  const FLUSH_MSG_ID = 8181
  const FLUSHED_TEXT =
    'Checked the backup job: last night\'s run completed in 41 minutes, all four volumes ' +
    'verified clean, and the retention sweep pruned the January snapshots as scheduled.'
  const REWORDED_OWN_REPLY =
    'Backup status: the overnight run finished in about forty minutes, every volume passed ' +
    'verification, and the retention sweep removed the January snapshots on schedule.'

  it('a handback enqueued 90 s ago (outside HANDBACK_RECENCY_WINDOW_MS) no longer ' +
    'holds the content gate — the turn\'s own reworded reply still collapses to ONE message', async () => {
    const h = makeHarness()
    const owner = {
      turnId: OWNER_TURN_ID,
      sessionChatId: CHAT,
      answerDelivered: 'flush',
      flushedAnswerText: FLUSHED_TEXT,
      endedAt: Date.now() - 120_000,
      realEndObservedAt: null, // window open — session still composing
      replyCalled: false,
      finalAnswerDelivered: true,
      finalAnswerSubstantive: true,
    } as unknown as CurrentTurn
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: OWNER_TURN_ID, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now() - 120_000,
    )
    h.deps.resolveReplyOwnerTurn = () => ownerRes(owner, 'latest-ended', {
      latestEndedAgeMs: 120_000,
      latestEndedRealEndAgeMs: null,
    })
    // A handback WAS enqueued after the turn ended — but 90 s ago, outside the
    // 60 s recency window. Tying this read to the (minutes-long) supersede
    // bound would hold the gate here and ship a visible duplicate — the exact
    // #4174 regression; this test goes red under that mutation.
    h.deps.getLastSubagentHandbackAt = () => Date.now() - 90_000

    const res = await sendReply(h.deps, {
      args: { chat_id: CHAT, text: REWORDED_OWN_REPLY },
      turn: null,
    })

    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
    expect(res.content[0]!.text).toMatch(/^sent/)
  })
})

describe('#4176 — a BACKGROUND SUB-AGENT reply can never silently edit over a flushed answer', () => {
  // The MAJOR from the #4167 review. The #4173 window rests on "a reply landing
  // between the synthetic and the real turn_end is this turn's own answer,
  // because nothing else can run on the serial session". A background `Task`
  // sub-agent falsifies that: it runs CONCURRENTLY and calls `reply` over the
  // PARENT's IPC bridge, so #4172's identity gate cannot see it and no
  // `subagent_handback` marker is stamped (a direct tool call never traverses
  // pendingInboundBuffer). Owner resolution then lands on the flush-ended turn
  // (OPEN is accepted at any age up to the crash cap), the bypass grants
  // positive attribution, and the sub-agent's FOREIGN content supersedes —
  // editing over the user's delivered answer with no notification for either.
  const OWNER_TURN_ID = `${CHAT}:_#flushed-4176`
  const FLUSH_MSG_ID = 44176
  const FLUSHED_TEXT =
    'Traced the wedge to the broker socket: the gateway reconnects but never re-arms the ' +
    'heartbeat, so the supervisor sees it as healthy while every vault read times out.'
  // Genuinely foreign content — a researcher sub-agent reporting its own finding.
  // Defeats both arms of flushedAnswerMatchesReply, so nothing here can pass by
  // accident through the content matcher.
  const SUBAGENT_REPLY =
    'Sub-agent report: the calendar scope audit found four call sites that request the ' +
    'write scope where a read scope would do, all reachable from the OAuth consent screen.'

  function makeFlushedOwner(): CurrentTurn {
    return {
      turnId: OWNER_TURN_ID,
      sessionChatId: CHAT,
      answerDelivered: 'flush',
      flushedAnswerText: FLUSHED_TEXT,
      endedAt: Date.now() - 90_000,
      // Window OPEN: the flush ended the turn synthetically, the session's real
      // turn_end has not been observed (the parent is still delegating).
      realEndObservedAt: null,
      replyCalled: false,
      finalAnswerDelivered: true,
      finalAnswerSubstantive: true,
    } as unknown as CurrentTurn
  }

  function seed(h: ReturnType<typeof makeHarness>): void {
    h.deps.flushedTurnSupersede.record(
      CHAT,
      undefined,
      { turnId: OWNER_TURN_ID, messageIds: [FLUSH_MSG_ID], text: FLUSHED_TEXT },
      Date.now() - 90_000,
    )
    // Latest-ended tier, corroborated, no handback marker, MAIN bridge → every
    // other gate passes. The sub-agent liveness signal is the only thing left.
    h.deps.resolveReplyOwnerTurn = () => ownerRes(makeFlushedOwner(), 'latest-ended')
    h.deps.getLastSubagentHandbackAt = () => null
  }

  it('the content matcher cannot save this case (foreign content, both arms fail)', () => {
    expect(flushedAnswerMatchesReply(FLUSHED_TEXT, SUBAGENT_REPLY)).toBe(false)
  })

  it('MAJOR REPRO: with a live sub-agent, its reply ships FRESH — zero edits/deletes ' +
    'of the flushed message, record intact for the parent turn\'s own replay', async () => {
    const h = makeHarness()
    seed(h)
    // The REAL tracker, driven by the REAL framework-derived session events the
    // gateway feeds it — not a hand-set boolean.
    const authority = new SubagentReplyAuthority()
    authority.noteSessionEvent({ kind: 'sub_agent_started', agentId: 'researcher-1' })
    expect(authority.subagentCouldOwnReply()).toBe(true)
    h.deps.subagentReplyAuthority = authority

    const res = await sendReply(h.deps, {
      args: { chat_id: CHAT, text: SUBAGENT_REPLY },
      turn: null, // decoupled — the parent turn was ended by the flush
      callerIsForeignSession: false, // SAME bridge: #4172 cannot see this caller
    })

    // OUTCOME: msg A untouched; the sub-agent's report is a fresh, NOTIFYING
    // message the user actually receives.
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'deleteMessage')).toHaveLength(0)
    const fresh = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.text).toContain('calendar scope audit')
    expect(fresh[0]!.message_id).not.toBe(FLUSH_MSG_ID)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
    // The flush record survives for the parent turn's own genuine late replay.
    expect(
      h.deps.flushedTurnSupersede.peek(CHAT, undefined, {
        liveTurnId: OWNER_TURN_ID,
        now: Date.now(),
      }).supersede,
    ).toBe(true)
  })

  it('NEGATIVE CONTROL (the reviewed failure): the SAME reply with NO sub-agent live ' +
    'destroys the flushed answer by edit — proving the liveness gate is load-bearing', async () => {
    const h = makeHarness()
    seed(h)
    // Identical scenario, gate disarmed (the pre-fix behaviour): the bypass
    // applies and the foreign report edits over msg A — the double loss (the
    // user's answer destroyed, the report delivered without a notification).
    h.deps.subagentReplyAuthority = new SubagentReplyAuthority()

    await sendReply(h.deps, {
      args: { chat_id: CHAT, text: SUBAGENT_REPLY },
      turn: null,
      callerIsForeignSession: false,
    })

    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
  })

  it('liveness is released by sub_agent_turn_end: after the sub-agent finishes, the ' +
    'parent\'s OWN reworded answer still collapses to ONE message (#4166 preserved)', async () => {
    const h = makeHarness()
    seed(h)
    const authority = new SubagentReplyAuthority()
    authority.noteSessionEvent({ kind: 'sub_agent_started', agentId: 'researcher-1' })
    authority.noteSessionEvent({ kind: 'sub_agent_tool_use', agentId: 'researcher-1' })
    authority.noteSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'researcher-1' })
    expect(authority.liveCount()).toBe(0)
    h.deps.subagentReplyAuthority = authority

    // The parent's own answer, reworded (defeats the content matcher) — this is
    // the collapse the #4173/#4166 work exists to preserve.
    const REWORDED_OWN =
      'The wedge is the broker socket: the gateway does reconnect, but the heartbeat is ' +
      'never re-armed, so the supervisor reports healthy while all vault reads time out.'
    expect(flushedAnswerMatchesReply(FLUSHED_TEXT, REWORDED_OWN)).toBe(false)

    await sendReply(h.deps, { args: { chat_id: CHAT, text: REWORDED_OWN }, turn: null })

    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
  })

  it('a live sub-agent does NOT block a genuine same-content replay (supersede on ' +
    'equality is content-preserving)', async () => {
    const h = makeHarness()
    seed(h)
    const authority = new SubagentReplyAuthority()
    authority.noteSessionEvent({ kind: 'sub_agent_started', agentId: 'worker-2' })
    h.deps.subagentReplyAuthority = authority

    await sendReply(h.deps, { args: { chat_id: CHAT, text: FLUSHED_TEXT }, turn: null })

    const edits = h.calls.filter((c) => c.method === 'editMessageText')
    expect(edits).toHaveLength(1)
    expect(edits[0]!.message_id).toBe(FLUSH_MSG_ID)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(0)
  })

  it('an UNFINISHED sub-agent keeps the gate armed (missing turn_end fails SAFE), ' +
    'and reset() on bridge death releases it', async () => {
    const authority = new SubagentReplyAuthority()
    authority.noteSessionEvent({ kind: 'sub_agent_started', agentId: 'reviewer-3' })
    authority.noteSessionEvent({ kind: 'sub_agent_started', agentId: 'researcher-4' })
    authority.noteSessionEvent({ kind: 'sub_agent_turn_end', agentId: 'reviewer-3' })
    // One still live → gate armed.
    expect(authority.subagentCouldOwnReply()).toBe(true)

    const h = makeHarness()
    seed(h)
    h.deps.subagentReplyAuthority = authority
    await sendReply(h.deps, {
      args: { chat_id: CHAT, text: SUBAGENT_REPLY },
      turn: null,
    })
    expect(h.calls.filter((c) => c.method === 'editMessageText')).toHaveLength(0)
    expect(h.calls.filter((c) => c.method === 'sendRichMessage')).toHaveLength(1)

    // Bridge death: the claude session and every sub-agent under it are gone.
    authority.reset()
    expect(authority.subagentCouldOwnReply()).toBe(false)
  })

  it('non-sub_agent events never arm the gate (the feed takes the WHOLE stream ' +
    'un-filtered, so this is the discrimination that matters)', () => {
    const authority = new SubagentReplyAuthority()
    authority.noteSessionEvent({ kind: 'turn_end' })
    authority.noteSessionEvent({ kind: 'tool_use', agentId: 'not-a-subagent' })
    authority.noteSessionEvent({ kind: 'assistant_text' })
    authority.noteSessionEvent(null)
    authority.noteSessionEvent({ kind: 'sub_agent_started' }) // id-less → ignorable
    expect(authority.subagentCouldOwnReply()).toBe(false)
  })

  // Structural pins: gateway.ts / stream-render.ts are not importable from a
  // test runner (the singleton + boot-gated lockedBot), so the wiring that makes
  // the gate reachable in production is pinned by source assertion — the same
  // accepted pattern as the #4172 pin above. Dropping any of these three lines
  // silently disarms the gate with every behavioural test above still green.
  it('#4176 wiring — the session-event feed, the bridge-death reset, and the ' +
    'send-path dep are all present', () => {
    const streamSrc = readFileSync(new URL('../gateway/stream-render.ts', import.meta.url), 'utf8')
    // FEED: every event, before the kind switch (the `sub_agent_tool_use` case
    // early-returns when no turn is live, so the switch is not a usable site).
    expect(streamSrc).toContain('subagentReplyAuthority.noteSessionEvent(')
    const gwSrc = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
    // RESET on main-bridge disconnect + READ wired into the sendReply deps.
    expect(gwSrc).toContain('subagentReplyAuthority.reset()')
    expect(gwSrc).toMatch(/subagentReplyAuthority,/)
    const sendSrc = readFileSync(new URL('../gateway/outbound-send-path.ts', import.meta.url), 'utf8')
    expect(sendSrc).toContain('subagentReplyAuthority.subagentCouldOwnReply()')
    expect(sendSrc).toContain('subagentCouldOwnReply,')
  })
})

// ── cross-chat thread anchor, kill-switch branch (bug c) ──────────────────
//
// The default (`TURN_ORIGIN_ROUTING_ENABLED: true`) branch resolves the thread
// through `resolveAnswerThreadWithLog`, which drops a wrong-chat anchor inside
// `resolveAnswerThreadId`. The legacy branch (`SWITCHROOM_TURN_ORIGIN_ROUTING=0`)
// does NOT go through that resolver at all — it passes the pinned turn's
// `sessionThreadId` straight into `resolveThreadId`. When the pinned turn
// belongs to a DIFFERENT chat (the routine multi-chat case: one sequential CLI,
// a singleton live turn, replies fanning out to several chats) that hands chat
// B's topic id to a send into chat A, and Telegram answers
// `400 Bad Request: message thread not found` — the exact failure the guard
// exists to prevent, still reachable behind the switch.
//
// These drive the REAL `sendReply` and assert on the `message_thread_id` the
// send-path actually put on the wire, so they fail on the bug rather than on a
// refactor of how the decision is spelled.
//
// What the drop resolves TO: dropping the anchor does NOT mean "no thread id".
// The legacy branch still calls `resolveThreadId`, whose real body
// (`gateway.ts`) is `explicit ?? chatThreadMap.get(chat_id)` — so a dropped
// anchor falls through to the TARGET chat's own last-seen topic. That fallback
// is chat-scoped, so it can only ever yield a topic id valid for chat A; the
// class of failure the guard closes (chat B's topic on a send into chat A →
// `400 message thread not found`) stays closed either way. Cases below cover
// BOTH ends: an empty map (fallback misses → undefined) and a populated one
// (fallback hits → chat A's topic).
describe('kill switch SWITCHROOM_TURN_ORIGIN_ROUTING=0 still drops a cross-chat anchor', () => {
  const OTHER_CHAT = '2002'

  /** A live turn pinned at executeReply entry, owned by `chatId`. */
  function turnFor(chatId: string, threadId: number | undefined): CurrentTurn {
    return {
      turnId: `turn-${chatId}`,
      sessionChatId: chatId,
      sessionThreadId: threadId,
      replyCalled: false,
    } as unknown as CurrentTurn
  }

  const threadOnWire = (h: Harness): unknown =>
    h.calls.filter((c) => c.method === 'sendRichMessage')[0]!.opts.message_thread_id

  it('a reply into chat A pinned to a chat-B forum turn does NOT carry chat B\'s ' +
    'topic id — with no last-seen topic for chat A it resolves to no thread', async () => {
    // Empty `chatThreadMap`: the post-drop `resolveThreadId` fallback misses,
    // so the wire carries no thread. This is the fallback-misses END of the
    // behaviour, not the whole of it — see the populated-map case below.
    const h = makeHarness({ turnOriginRouting: false })
    const res = await sendReply(
      h.deps,
      req('The answer to the question asked in chat A.', {}, turnFor(OTHER_CHAT, 77)),
    )
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.chat_id).toBe(CHAT)
    // Pre-fix this is 77 — chat B's topic id on a send into chat A.
    expect(threadOnWire(h)).toBeUndefined()
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })

  it('the dropped anchor falls through to the TARGET chat\'s last-seen topic, ' +
    'not to no-thread: chat A last saw topic 12 → the send lands in A/12', async () => {
    // The production shape the empty-map case above cannot show: the agent is
    // live in supergroup B (topic 77) and replies into forum chat A, whose
    // `chatThreadMap` last saw topic 12. Dropping B's anchor hands the decision
    // to `resolveThreadId`, which is chat-scoped — so the send lands in A's own
    // topic 12. 77 on the wire here would be the `400 message thread not found`
    // the guard exists to prevent.
    const h = makeHarness({
      turnOriginRouting: false,
      chatThreadMap: new Map([[CHAT, 12], [OTHER_CHAT, 77]]),
    })
    const res = await sendReply(
      h.deps,
      req('Late answer into chat A.', {}, turnFor(OTHER_CHAT, 77)),
    )
    const sends = h.calls.filter((c) => c.method === 'sendRichMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.chat_id).toBe(CHAT)
    expect(threadOnWire(h)).toBe(12)
    expect(threadOnWire(h)).not.toBe(77)
    expect(res.content[0]!.text).toMatch(/^sent \(id: \d+\)$/)
  })

  it('an explicit message_thread_id from the model does NOT rescue a cross-chat ' +
    'anchor — but it is still honoured on its own', async () => {
    // Explicit wins in the legacy branch, so it must survive untouched.
    const h = makeHarness({ turnOriginRouting: false })
    await sendReply(
      h.deps,
      req('Explicit thread.', { message_thread_id: '31' }, turnFor(OTHER_CHAT, 77)),
    )
    expect(threadOnWire(h)).toBe(31)
  })

  it('BACK-COMPAT: a SAME-chat forum turn still lends its topic id (the guard ' +
    'must not over-fire and strip legitimate topic routing)', async () => {
    const h = makeHarness({ turnOriginRouting: false })
    await sendReply(h.deps, req('Same-chat topic reply.', {}, turnFor(CHAT, 77)))
    expect(threadOnWire(h)).toBe(77)
  })

  it('BACK-COMPAT: no pinned turn at all → no thread id, unchanged', async () => {
    const h = makeHarness({ turnOriginRouting: false })
    await sendReply(h.deps, req('Orphaned proactive send.'))
    expect(threadOnWire(h)).toBeUndefined()
  })

  // ── telemetry parity with the flag-on path ──────────────────────────────
  //
  // The flag-ON branch emits `CROSS_CHAT_ANCHOR_DROPPED(...)` through
  // `resolveAnswerThreadWithLog` → `formatReplyRouteLog`. Without the same line
  // here, a deployment running `SWITCHROOM_TURN_ORIGIN_ROUTING=0` silently
  // loses the audit trail the rest of this fix is built on: the drop still
  // happens, but nothing records that it did. The line is built by the SAME
  // `formatReplyRouteLog` — there is exactly one authoritative implementation.
  describe('telemetry: the legacy-branch drop is not silent', () => {
    const captureStderr = (): { lines: string[]; restore: () => void } => {
      const lines: string[] = []
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(((chunk: unknown) => {
          lines.push(String(chunk))
          return true
        }) as unknown as typeof process.stderr.write)
      return { lines, restore: () => spy.mockRestore() }
    }

    it('emits CROSS_CHAT_ANCHOR_DROPPED naming both chats and what it routed to', async () => {
      const h = makeHarness({
        turnOriginRouting: false,
        chatThreadMap: new Map([[CHAT, 12]]),
      })
      const cap = captureStderr()
      try {
        await sendReply(h.deps, req('Late answer into chat A.', {}, turnFor(OTHER_CHAT, 77)))
      } finally {
        cap.restore()
      }
      const line = cap.lines.find((l) => l.includes('CROSS_CHAT_ANCHOR_DROPPED('))
      expect(line).toBeDefined()
      // Same marker shape the flag-on path emits: target chat, the anchor's
      // chat + topic, and the thread the send actually routed to.
      expect(line).toContain('reply-route surface=reply')
      expect(line).toContain(`chat=${CHAT}`)
      expect(line).toContain(`live_chat=${OTHER_CHAT}`)
      expect(line).toContain('live_thread=77')
      expect(line).toContain('routed→12')
    })

    // NEGATIVE CONTROL (green against the pre-fix code by construction — the
    // pre-fix branch emits nothing at all). It earns its place under mutation:
    // asserting on the whole `reply-route` line rather than just the marker is
    // what makes it fail an UNCONDITIONAL emit, the plausible wrong shape here.
    // (Asserting only "no CROSS_CHAT_ANCHOR_DROPPED" would NOT — the formatter
    // omits the marker for a same-chat anchor anyway, so that weaker assertion
    // passes for a conditional and an unconditional emit alike.) The legacy
    // branch is a kill-switch path: it must stay byte-silent on the ordinary
    // send it exists to serve, and only speak when it drops something.
    it('stays silent on a SAME-chat anchor — no drop, and no reply-route line at all', async () => {
      const h = makeHarness({ turnOriginRouting: false })
      const cap = captureStderr()
      try {
        await sendReply(h.deps, req('Same-chat topic reply.', {}, turnFor(CHAT, 77)))
      } finally {
        cap.restore()
      }
      expect(cap.lines.some((l) => l.includes('CROSS_CHAT_ANCHOR_DROPPED'))).toBe(false)
      expect(cap.lines.some((l) => l.includes('reply-route surface='))).toBe(false)
    })
  })
})
