/**
 * outbox-provenance-4141.test.ts — the FOREGROUND reply-throw case (issue
 * #4141, follow-up to #3865 / PR #4140).
 *
 * THE GAP THIS GUARDS
 * -------------------
 * #4140's audience gate marks a record `'internal'` only on positive evidence:
 * the reply tool threw AND no inbound obligation is open. An obligation only
 * closes on a substantive DELIVERED reply (`gateway/obligation-ledger.ts:153`),
 * so on a FOREGROUND Telegram turn where the reply tool threw, the obligation
 * is still OPEN, the record classifies `'user'`, and the agent's trailing
 * working notes are delivered to the waiting human presented as if they were
 * the answer.
 *
 * THE DESIGN UNDER TEST — FRAMING, NOT SUPPRESSION
 * -----------------------------------------------
 * Suppressing here would convert a visible wrong-content failure into an
 * invisible no-answer one, against a human who is provably still waiting. So
 * the rule is: state the provenance in front of the text and deliver it. The
 * two invariants this file exists to hold are therefore:
 *
 *   A. FRAMING NEVER SILENCES. Every framed case sends exactly as many
 *      chat-visible calls as the unframed case did, and the body still
 *      contains the captured prose verbatim.
 *   B. FRAMING IS OBSERVABLE. Every framed delivery carries a durable terminal
 *      stamp on the journal line plus one structured telemetry line.
 *
 * Every assertion drives REAL machinery: the REAL Stop hook spawned as a
 * subprocess against a REAL transcript, the REAL `sweepOutbox` with the REAL
 * `createOutboxSend` adapter against a RECORDING fake Bot API, the REAL flood
 * producer, and the REAL fleet-health detectors.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { sweepOutbox, createOutboxSend, turnIdFromNonce } from '../gateway/outbox-sweep.js'
import { decideOutboxSweep, sha256Hex } from '../outbox.js'
import { queueFloodBlockedReply } from '../gateway/flood-reply-queue.js'
import {
  REPLY_THROW_PROVENANCE_NOTICE,
  applyReplyThrowFraming,
  decideCaptureAudience,
  formatReplyThrowFraming,
  resolveOpenObligation,
  shouldFrameReplyThrow,
} from '../hooks/audience-classify.mjs'
import { scanForOutboxCapture } from '../hooks/silent-end-scan.mjs'
import { deliverCapturedProse } from '../gateway/outbound-send-path.js'
import { decideCapturedProseDelivery } from '../silent-end.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import { decideTurnFlush } from '../turn-flush-safety.js'
import { buildTurnRecord } from '../gateway/turn-record-status.js'
import {
  detectTurnFindings,
  detectGatewayFindings,
  extractTurnId,
  GATEWAY_SIGNATURES,
} from '../../src/fleet-health/detect.js'

const HOOK = resolve(__dirname, '..', 'hooks', 'silent-end-interrupt-stop.mjs')

// Synthetic ids only (check-no-pii-secrets forbids real chat/user ids).
const DM_CHAT = '5550001'
const INBOUND_MSG_ID = 7311
const NONCE = `${DM_CHAT}:_#${INBOUND_MSG_ID}`

/** Internal working notes — the text that must never masquerade as an answer. */
const WORKING_NOTES = [
  'Dispatched the worker onto the rebase and it came back clean, so the next',
  'step is to re-run the scoped suite before touching the sweep at all. If the',
  'suite is still red after that I will bisect from the merge base rather than',
  'guessing, and I should double-check whether the earlier claim about the',
  'adapter ordering actually holds, because I never verified it against HEAD.',
].join(' ')

/**
 * A genuine answer written as plain prose AFTER the reply tool errored — the
 * shape that makes suppression unsafe here. Structurally indistinguishable
 * from WORKING_NOTES to every classifier in this pipeline.
 */
const REAL_ANSWER = [
  'The rebase landed on the merge base and the suite is green. Two files moved:',
  'the sweep now checks the record before it routes anything, and the capture',
  'hook stamps the field it checks. Nothing else changed, and the flood queue',
  'behaves exactly as it did before because it stamps the same value it implied.',
].join(' ')

function makeStateDir(): string {
  // NEVER ~/.switchroom — a test that writes there corrupts production state.
  return mkdtempSync(join(tmpdir(), 'w1d-provenance-'))
}

function writeTranscript(dir: string, lines: object[]): string {
  const p = join(dir, 'transcript.jsonl')
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  return p
}

function runHook(
  transcriptPath: string,
  stateDir: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's', transcript_path: transcriptPath }),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, ...extraEnv },
  })
}

interface RecordShape {
  turnNonce: string
  text: string
  audience?: string
  replyToolThrewThisTurn?: unknown
  chatId: string | null
  source: string
  textSha256: string
  createdAt: number
}

function outboxRecords(dir: string): RecordShape[] {
  const outbox = join(dir, 'outbox')
  if (!existsSync(outbox)) return []
  return readdirSync(outbox)
    .filter((f) => f.endsWith('.json') && f !== 'delivered.jsonl')
    .map((f) => JSON.parse(readFileSync(join(outbox, f), 'utf8')) as RecordShape)
}

function journalLines(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, 'outbox', 'delivered.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** The OPEN inbound obligation that makes this the foreground case. */
function writeOpenObligation(dir: string): void {
  writeFileSync(
    join(dir, 'obligations.json'),
    JSON.stringify({
      v: 1,
      obligations: [
        {
          originTurnId: NONCE,
          chatId: DM_CHAT,
          messageId: INBOUND_MSG_ID,
          text: 'where did the rebase land?',
          openedAt: 1_000,
          representCount: 0,
        },
      ],
    }),
    'utf8',
  )
}

/**
 * A RECORDING fake Bot API. Every method that can put bytes into a chat is
 * counted, so a send-count assertion covers ALL of them, not the one method
 * the test remembered to stub.
 */
function recordingBot() {
  const calls: Array<{ method: string; chatId: string; text: string }> = []
  let nextId = 900
  return {
    calls,
    chatCalls: () => calls,
    api: {
      sendRichMessage: async (chatId: string, body: { markdown: string }) => {
        calls.push({ method: 'sendRichMessage', chatId, text: body.markdown })
        return { message_id: nextId++ }
      },
      sendMessage: async (chatId: string, text: string) => {
        calls.push({ method: 'sendMessage', chatId, text })
        return { message_id: nextId++ }
      },
      editMessageText: async (chatId: string, _mid: number, text: string) => {
        calls.push({ method: 'editMessageText', chatId, text })
        return { message_id: nextId++ }
      },
    },
  }
}

const passthroughRetry = <U>(fn: () => Promise<U>): Promise<U> => fn()

/** Drive ONE real sweep tick against the recording bot. */
async function realSweep(
  stateDir: string,
  bot: ReturnType<typeof recordingBot>,
  opts: { framingEnabled?: boolean } = {},
) {
  const logLines: string[] = []
  const framingLines: string[] = []
  const escalations: string[] = []
  const summary = await sweepOutbox({
    send: createOutboxSend({ getBot: () => bot, retry: passthroughRetry }),
    textAlreadyDelivered: () => false,
    stateDir,
    now: () => Date.now() + 60_000,
    quietMs: 0,
    log: (l) => logLines.push(l),
    ...(opts.framingEnabled === undefined
      ? {}
      : { provenanceFramingEnabled: () => opts.framingEnabled! }),
    logProvenanceFraming: (l) => framingLines.push(l),
    escalateInternalSuppression: (l) => escalations.push(l),
  })
  return { summary, logLines, framingLines, escalations }
}

/**
 * THE FOREGROUND SHAPE (#4141), verbatim in structure:
 *   1. a Telegram inbound — the anchor for THIS turn, and the reason an
 *      obligation is open;
 *   2. a reply-tool call, which THROWS;
 *   3. trailing prose, which capture then selects as "the answer".
 *
 * Note there is NO background wake here — that is the whole difference from
 * #4140's leak transcript, and it is what keeps the obligation open.
 */
function foregroundThrowTranscript(dir: string, prose: string): string {
  return writeTranscript(dir, [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${INBOUND_MSG_ID}">where did the rebase land?</channel>`,
      timestamp: 1000,
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_reply_1',
            name: 'mcp__switchroom-telegram__reply',
            input: { text: 'On it.', disable_notification: true },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_reply_1',
            is_error: true,
            content: 'Error: FLOOD_WAIT_ACTIVE — send rejected',
          },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: prose }] } },
  ])
}

describe('#4141 — the framing rule is pure, positive-evidence-only, and additive', () => {
  it('frames ONLY on an exact boolean true', () => {
    expect(shouldFrameReplyThrow({ replyToolThrewThisTurn: true })).toBe(true)
    // Anything else is no evidence → no change at all. A legacy record (the
    // field did not exist before this PR) is the `undefined` row.
    for (const v of [undefined, null, false, 'true', 'internal', 1, {}, []]) {
      expect(shouldFrameReplyThrow({ replyToolThrewThisTurn: v })).toBe(false)
    }
    expect(shouldFrameReplyThrow({})).toBe(false)
    // Kill switch — the seam the revert-check flips.
    expect(
      shouldFrameReplyThrow({ replyToolThrewThisTurn: true }, { frameEnabled: false }),
    ).toBe(false)
  })

  it('framing is ADDITIVE: the captured prose survives verbatim', () => {
    const framed = applyReplyThrowFraming(WORKING_NOTES)
    expect(framed).toContain(WORKING_NOTES)
    expect(framed.startsWith(REPLY_THROW_PROVENANCE_NOTICE)).toBe(true)
    expect(framed.length).toBeGreaterThan(WORKING_NOTES.length)
  })

  it('the banner carries no markdown specials that could parse-reject a rich send', () => {
    expect(REPLY_THROW_PROVENANCE_NOTICE).not.toMatch(/[*_`[\]]/)
  })

  it('an empty body is left alone — a banner about nothing is not a message', () => {
    expect(applyReplyThrowFraming('')).toBe('')
    expect(applyReplyThrowFraming('   \n ')).toBe('   \n ')
  })

  it('the pure sweep decision can never turn a send into a skip because of framing', () => {
    const base = {
      now: 100_000,
      deliveredNonces: new Set<string>(),
      textAlreadyDelivered: false,
      routable: true,
      quietMs: 0,
    }
    const rec = {
      turnNonce: NONCE,
      text: WORKING_NOTES,
      createdAt: 1000,
      replyToolThrewThisTurn: true,
    }
    const on = decideOutboxSweep({ ...base, record: rec })
    const off = decideOutboxSweep({ ...base, record: rec, provenanceFraming: false })
    expect(on.action).toBe(off.action)
    expect(on.action).toBe('send')
    expect(on.framedProvenance).toBe('reply-throw')
    expect(off.framedProvenance).toBeUndefined()
    expect(on.text).toContain(off.text!)
  })

  it('the banner sits between the delivery prefixes and the body, not in front of them', () => {
    const d = decideOutboxSweep({
      record: {
        turnNonce: NONCE,
        text: WORKING_NOTES,
        createdAt: 0,
        replyToolThrewThisTurn: true,
      },
      now: 60 * 60_000,
      deliveredNonces: new Set<string>(),
      textAlreadyDelivered: false,
      routable: true,
      routePrefix: '(from background task) ',
      quietMs: 0,
    })
    expect(d.action).toBe('send-delayed')
    expect(d.text!.startsWith('(delayed) (from background task) ')).toBe(true)
    expect(d.text).toContain(REPLY_THROW_PROVENANCE_NOTICE)
    expect(d.text).toContain(WORKING_NOTES)
  })
})

describe('#4141 — capture persists the raw reply-throw signal onto the record', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the REAL hook stamps replyToolThrewThisTurn alongside audience:user', () => {
    writeOpenObligation(dir)
    const t = foregroundThrowTranscript(dir, WORKING_NOTES)
    const scan = scanForOutboxCapture(readFileSync(t, 'utf8')) as {
      capture: boolean
      replyToolThrewThisTurn: boolean
    }
    expect(scan.capture).toBe(true)
    expect(scan.replyToolThrewThisTurn).toBe(true)

    expect(runHook(t, dir).status).toBe(0)
    const records = outboxRecords(dir)
    expect(records).toHaveLength(1)
    // The #4141 premise, confirmed against the real hook: the foreground case
    // classifies `user` (someone is waiting) — #4140's gate does NOT bind here.
    expect(records[0].audience).toBe('user')
    // ...and the raw signal survives the write. THIS is the hop that would
    // silently make the whole feature inert if it were dropped.
    expect(records[0].replyToolThrewThisTurn).toBe(true)
  })

  it('a turn where the reply tool did NOT throw stamps false — no framing anywhere', () => {
    writeOpenObligation(dir)
    const t = writeTranscript(dir, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${INBOUND_MSG_ID}">where did the rebase land?</channel>`,
        timestamp: 1000,
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: REAL_ANSWER }] } },
    ])
    expect(runHook(t, dir).status).toBe(0)
    const records = outboxRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0].replyToolThrewThisTurn).toBe(false)
    expect(shouldFrameReplyThrow(records[0])).toBe(false)
  })
})

describe('#4141 — the foreground leak, end to end through the real sweep', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Capture the foreground reply-throw shape through the REAL hook. */
  function captureForeground(prose: string): RecordShape {
    writeOpenObligation(dir)
    const t = foregroundThrowTranscript(dir, prose)
    expect(runHook(t, dir).status).toBe(0)
    const records = outboxRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0].audience).toBe('user')
    expect(records[0].replyToolThrewThisTurn).toBe(true)
    return records[0]
  }

  it('PRIMARY: the prose is delivered WITH its provenance stated, journaled terminally, and telemetered once', async () => {
    const rec = captureForeground(WORKING_NOTES)
    const bot = recordingBot()

    const run = await realSweep(dir, bot)

    // INVARIANT A — framing never silences. Exactly one chat-visible call.
    expect(bot.chatCalls()).toHaveLength(1)
    expect(run.summary.delivered).toBe(1)
    expect(run.summary.audienceSuppressed).toBeUndefined()

    // The user is told what this text IS before they read it...
    const body = bot.chatCalls()[0].text
    expect(body).toContain(REPLY_THROW_PROVENANCE_NOTICE)
    // ...and none of the captured prose was destroyed to say so.
    expect(body).toContain('I will bisect from the merge base')
    expect(body.indexOf(REPLY_THROW_PROVENANCE_NOTICE)).toBeLessThan(
      body.indexOf('Dispatched the worker'),
    )
    expect(bot.chatCalls()[0].chatId).toBe(DM_CHAT)

    // INVARIANT B — observable. A durable terminal stamp on the journal line...
    const journal = journalLines(dir)
    expect(journal).toHaveLength(1)
    expect(journal[0].turnNonce).toBe(rec.turnNonce)
    expect(journal[0].framedProvenance).toBe('reply-throw')
    expect(journal[0].deliverySource).toBe('sweep')
    // A framed delivery IS a delivery — it carries a message id, unlike a
    // #4140 suppression line.
    expect(journal[0].tgMessageId).toBeDefined()
    expect(journal[0].suppressedAudience).toBeUndefined()

    // ...plus exactly one structured telemetry line, on its own channel.
    expect(run.framingLines).toHaveLength(1)
    expect(run.framingLines[0]).toContain(`nonce=${rec.turnNonce}`)
    expect(run.framingLines[0]).toContain('replyToolThrew=true')
    expect(run.escalations).toHaveLength(0)
    expect(run.summary.provenanceFramed).toBe(1)

    // A SECOND tick sends nothing more (exactly-once is untouched).
    const second = await realSweep(dir, bot)
    expect(bot.chatCalls()).toHaveLength(1)
    expect(second.summary.scanned).toBe(0)
    expect(second.framingLines).toHaveLength(0)
  })

  it('REVERT CHECK: with framing disabled the leak reproduces UNLABELLED (so the assertion above is load-bearing)', async () => {
    captureForeground(WORKING_NOTES)
    const bot = recordingBot()

    const run = await realSweep(dir, bot, { framingEnabled: false })

    // The pre-change behaviour, verbatim: the working notes go to the waiting
    // human with nothing to say they are not the answer.
    expect(bot.chatCalls()).toHaveLength(1)
    expect(run.summary.delivered).toBe(1)
    expect(bot.chatCalls()[0].text).not.toContain(REPLY_THROW_PROVENANCE_NOTICE)
    expect(bot.chatCalls()[0].text).toContain('Dispatched the worker')
    expect(run.summary.provenanceFramed).toBeUndefined()
    expect(run.framingLines).toHaveLength(0)
    expect(journalLines(dir)[0].framedProvenance).toBeUndefined()
  })

  it('ANTI-SILENCE: a genuine answer re-written as prose after the throw still reaches the user in full', async () => {
    // This is why the rule is framing and not suppression. The transcript is
    // structurally IDENTICAL to the working-notes case; only the prose differs,
    // and no classifier in this pipeline can tell them apart. A suppression
    // rule would silently swallow this answer from a waiting human.
    captureForeground(REAL_ANSWER)
    const bot = recordingBot()

    const run = await realSweep(dir, bot)

    expect(run.summary.delivered).toBe(1)
    expect(bot.chatCalls()).toHaveLength(1)
    expect(bot.chatCalls()[0].text).toContain(REAL_ANSWER)
  })

  it('LEGACY: a record with no replyToolThrewThisTurn field delivers byte-for-byte unframed', async () => {
    const outbox = join(dir, 'outbox')
    mkdirSync(outbox, { recursive: true })
    const nonce = `${DM_CHAT}:_#5150`
    const legacy = {
      turnNonce: nonce,
      chatId: DM_CHAT,
      threadId: null,
      text: REAL_ANSWER,
      textSha256: sha256Hex(REAL_ANSWER),
      // Inside the max-age window, so the body carries NO prefix at all and
      // "byte-for-byte unframed" can be asserted as exact equality.
      createdAt: Date.now(),
      source: 'channel',
      audience: 'user',
    }
    expect(Object.keys(legacy)).not.toContain('replyToolThrewThisTurn')
    writeFileSync(join(outbox, `${nonce}.json`), JSON.stringify(legacy), 'utf8')

    const bot = recordingBot()
    const run = await realSweep(dir, bot)

    expect(run.summary.delivered).toBe(1)
    expect(bot.chatCalls()).toHaveLength(1)
    expect(bot.chatCalls()[0].text).toBe(REAL_ANSWER)
    expect(run.framingLines).toHaveLength(0)
  })

  it('#4140 still wins where it binds: an internal record is suppressed, never framed-and-sent', async () => {
    // Interaction check between the two gates. A background record can carry
    // BOTH signals (reply threw, nobody waiting); suppression is upstream at
    // entry selection, so framing must never resurrect it as a send.
    const outbox = join(dir, 'outbox')
    mkdirSync(outbox, { recursive: true })
    const nonce = `${DM_CHAT}:_#6160`
    writeFileSync(
      join(outbox, `${nonce}.json`),
      JSON.stringify({
        turnNonce: nonce,
        chatId: DM_CHAT,
        threadId: null,
        text: WORKING_NOTES,
        textSha256: sha256Hex(WORKING_NOTES),
        createdAt: 1000,
        source: 'task-notification',
        audience: 'internal',
        replyToolThrewThisTurn: true,
      }),
      'utf8',
    )

    const bot = recordingBot()
    const run = await realSweep(dir, bot)

    expect(bot.chatCalls()).toEqual([])
    expect(run.summary.audienceSuppressed).toBe(1)
    expect(run.summary.provenanceFramed).toBeUndefined()
    expect(run.framingLines).toHaveLength(0)
    expect(journalLines(dir)[0].suppressedAudience).toBe('internal')
    expect(journalLines(dir)[0].framedProvenance).toBeUndefined()
  })

  it('the OTHER live producer (flood-reply-queue) writes no throw signal and delivers unframed', async () => {
    // `gateway/flood-reply-queue.ts` is LIVE (imported by
    // gateway/outbound-send-path.ts). Its records are replies the agent
    // ALREADY chose to send — framing them would be a lie.
    const res = queueFloodBlockedReply({
      err: new Error('FLOOD_WAIT_ACTIVE — send rejected, retry_after 30'),
      chatId: DM_CHAT,
      threadId: null,
      text: REAL_ANSWER,
      createdAt: 1000,
      stateDir: dir,
    })
    expect(res).not.toBeNull()
    const rec = outboxRecords(dir)[0]
    expect(rec.audience).toBe('user')
    expect(rec.replyToolThrewThisTurn).toBeUndefined()

    const bot = recordingBot()
    const run = await realSweep(dir, bot)

    expect(run.summary.delivered).toBe(1)
    expect(bot.chatCalls()).toHaveLength(1)
    expect(bot.chatCalls()[0].text).not.toContain(REPLY_THROW_PROVENANCE_NOTICE)
    expect(bot.chatCalls()[0].text).toContain(REAL_ANSWER)
    expect(run.framingLines).toHaveLength(0)
  })
})

/**
 * The BACKGROUND shape #4140's gate is built for: a task-notification wake
 * (never opens an obligation), a reply-tool throw, trailing working notes.
 * Used here to prove the stale-snapshot hole (#4146), because this is the only
 * shape where a bad "nobody is waiting" verdict can actually suppress.
 */
function backgroundThrowTranscript(dir: string, prose: string): string {
  return writeTranscript(dir, [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${INBOUND_MSG_ID}">where did the rebase land?</channel>`,
      timestamp: 1000,
    },
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification><task-id>a7cc7a0fa8f</task-id> worker done</task-notification>',
      timestamp: 2000,
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_reply_1',
            name: 'mcp__switchroom-telegram__reply',
            input: { text: 'On it.', disable_notification: true },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_reply_1',
            is_error: true,
            content: 'Error: FLOOD_WAIT_ACTIVE — send rejected',
          },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: prose }] } },
  ])
}

describe('#4146 — a snapshot that is not being maintained is not evidence', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('an explicit distrust beats anything on disk, including an empty open set', () => {
    const emptyButStale = JSON.stringify({ v: 1, obligations: [] })
    // Trusted: the pre-#4146 reading — positive proof that nobody is waiting.
    expect(
      resolveOpenObligation({ snapshotRaw: emptyButStale, chatId: DM_CHAT }),
    ).toBe(false)
    // Distrusted: the SAME bytes prove nothing.
    expect(
      resolveOpenObligation({
        snapshotRaw: emptyButStale,
        chatId: DM_CHAT,
        snapshotTrusted: false,
      }),
    ).toBe('unknown')
    // ...which flips the classifier back to the delivering direction.
    expect(
      decideCaptureAudience({
        replyToolThrewThisTurn: true,
        openInboundObligation: resolveOpenObligation({
          snapshotRaw: emptyButStale,
          chatId: DM_CHAT,
          snapshotTrusted: false,
        }),
      }),
    ).toBe('user')
    // Only an exact `false` distrusts — an unaware caller cannot weaken it.
    expect(
      resolveOpenObligation({ snapshotRaw: emptyButStale, chatId: DM_CHAT, snapshotTrusted: true }),
    ).toBe(false)
    expect(
      resolveOpenObligation({
        snapshotRaw: emptyButStale,
        chatId: DM_CHAT,
        snapshotTrusted: undefined,
      }),
    ).toBe(false)
  })

  it('OUTCOME: with the ledger off, a lingering empty snapshot no longer suppresses — the text still reaches the chat', async () => {
    // The exact #4146 configuration: the agent once ran with the ledger on, so
    // an empty `obligations.json` is on disk; the ledger is now off, so
    // obligations are going untracked and that file is a leftover.
    writeFileSync(join(dir, 'obligations.json'), JSON.stringify({ v: 1, obligations: [] }), 'utf8')
    const t = backgroundThrowTranscript(dir, REAL_ANSWER)
    expect(runHook(t, dir, { SWITCHROOM_OBLIGATION_LEDGER: '0' }).status).toBe(0)

    const rec = outboxRecords(dir)[0]
    expect(rec.audience).toBe('user')

    const bot = recordingBot()
    const run = await realSweep(dir, bot)
    expect(run.summary.delivered).toBe(1)
    expect(run.summary.audienceSuppressed).toBeUndefined()
    expect(bot.chatCalls()).toHaveLength(1)
    expect(bot.chatCalls()[0].text).toContain(REAL_ANSWER)
  })

  it('REVERT CHECK (#4146): with the ledger ON, the same lingering snapshot DOES suppress', async () => {
    // Same bytes, same transcript — only the trust signal differs. This is what
    // makes the assertion above load-bearing: without the guard the message is
    // swallowed with zero chat calls.
    writeFileSync(join(dir, 'obligations.json'), JSON.stringify({ v: 1, obligations: [] }), 'utf8')
    const t = backgroundThrowTranscript(dir, REAL_ANSWER)
    expect(runHook(t, dir, { SWITCHROOM_OBLIGATION_LEDGER: '1' }).status).toBe(0)

    expect(outboxRecords(dir)[0].audience).toBe('internal')

    const bot = recordingBot()
    const run = await realSweep(dir, bot)
    expect(bot.chatCalls()).toEqual([])
    expect(run.summary.audienceSuppressed).toBe(1)
  })
})

describe('#4141 — framing is honest telemetry and cannot launder a broken turn', () => {
  it('the framing line matches NO gateway alarm signature (a framed delivery is a delivery)', () => {
    const line = formatReplyThrowFraming({
      turnNonce: NONCE,
      turnId: NONCE,
      chatId: DM_CHAT,
      textSha256: sha256Hex(WORKING_NOTES),
      source: 'channel',
    })
    for (const [name, re] of Object.entries(GATEWAY_SIGNATURES)) {
      expect(re.test(line), `${name} must not match a by-design framed delivery`).toBe(false)
    }
    expect(detectGatewayFindings('klanker', line).findings).toEqual([])
  })

  it('the framing line carries a turn id the fleet-health scanner can join on', () => {
    expect(turnIdFromNonce(NONCE)).toBe(NONCE)
    const line = formatReplyThrowFraming({ turnNonce: NONCE, turnId: NONCE, chatId: DM_CHAT })
    expect(extractTurnId(line)).toBe(NONCE)
  })

  it('DISJOINTNESS: a framed turn has tools>=1, so it can never enter the silent-no-op branch', () => {
    // Checked through the REAL builder + REAL detector, not by inspection.
    // Framing is only reachable when the reply tool was CALLED and threw, so
    // the turn has >= 1 tool call; the silent-no-op branch requires
    // `tools === 0` (src/fleet-health/detect.ts:305-333).
    const now = Math.floor(Date.now() / 1000)
    const row = buildTurnRecord(
      {
        agent: 'klanker',
        startedAt: 1000,
        toolCallCount: 1, // the reply tool call that threw
        turnId: NONCE,
        finalAnswerDelivered: false,
        replyCalled: true,
      },
      Date.now(),
    )
    expect(row.tools).toBe(1)
    expect(row.route).toBe('none')
    const findings = detectTurnFindings('klanker', [{ ...row, ts: now }])
    expect(findings.filter((f) => f.signal === 'silent-no-op-candidate')).toEqual([])
  })

  it('CONTROL: the silent-no-op detector is NOT blinded — a zero-tool no-op still scores', () => {
    // The disjointness claim above is only meaningful if the detector would
    // otherwise fire on the SAME call. This is that control: same detector,
    // tools=0, complete, and no honest `route` — the regression shape
    // `detect.ts:333-343` treats as `none` and scores sev-3.
    const now = Math.floor(Date.now() / 1000)
    const row = buildTurnRecord(
      {
        agent: 'klanker',
        startedAt: 1000,
        toolCallCount: 0,
        turnId: `${DM_CHAT}:_#9999`,
        finalAnswerDelivered: true,
      },
      Date.now(),
    )
    expect(row.tools).toBe(0)
    expect(row.status).toBe('complete')
    const { route: _dropped, ...legacyRow } = row
    const findings = detectTurnFindings('klanker', [{ ...legacyRow, ts: now }])
    expect(findings.filter((f) => f.signal === 'silent-no-op-candidate')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #4141 REVIEW FINDING — THE ELECTED PATH
//
// The sweep-path framing above binds only when the Stop hook writes an outbox
// RECORD. On the dominant live shape it does not:
//
//   The reply tool is called with a QUALIFYING final answer and it THROWS.
//   `scanForOutboxCapture` classifies a qualifying reply-tool call from its
//   INPUT (`isFinalAnswerReply`, silent-end-scan.mjs:1008) and never consults
//   the tool_result, so `replyAlreadyDeliveredThisTurn` is true even though the
//   call errored. The hook therefore takes the #3510 branch, writes NO outbox
//   record, and falls through to the single-writer election, which hands the
//   trailing prose to the gateway's captured-prose bridge.
//
// So on a healthy gateway the FIRST, common occurrence goes out through a
// machine the outbox sweep never touches. These tests pin the label onto THAT
// machine, driving the real hook, the real `decideCapturedProseDelivery`, and
// the real `deliverCapturedProse` against the recording bot.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ELECTED foreground shape: a QUALIFYING final-answer reply (no
 * `disable_notification`, so `isFinalAnswerReply` is true on the input alone)
 * that throws, followed by trailing prose over the bridge's 200-char floor.
 */
function electedThrowTranscript(dir: string, prose: string, opts: { throws?: boolean } = {}) {
  const lines: object[] = [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${INBOUND_MSG_ID}">where did the rebase land?</channel>`,
      timestamp: 1000,
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_reply_elected',
            name: 'mcp__switchroom-telegram__reply',
            // No `disable_notification` ⇒ qualifying final answer by input.
            input: { text: 'The rebase landed cleanly on the merge base.' },
          },
        ],
      },
    },
  ]
  if (opts.throws !== false) {
    lines.push({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_reply_elected',
            is_error: true,
            content: 'Error: request timed out after 30000ms',
          },
        ],
      },
    })
  } else {
    lines.push({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_reply_elected', content: 'sent' },
        ],
      },
    })
  }
  lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: prose }] } })
  return writeTranscript(dir, lines)
}

/** Make the election's gateway-liveness gate pass. */
function writeFreshHeartbeat(dir: string): void {
  writeFileSync(join(dir, 'gateway-heartbeat'), 'up', 'utf8')
}

function readElectedState(dir: string): Record<string, unknown> | null {
  const p = join(dir, 'silent-end-pending.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

/** Drive the REAL captured-prose bridge against the recording bot. */
async function realBridge(
  stateDir: string,
  bot: ReturnType<typeof recordingBot>,
  decision: { text?: string; replyToolThrewThisTurn?: boolean },
) {
  const stderr: string[] = []
  // `journalExternalDelivery` resolves its state dir from the env (the bridge
  // takes no stateDir arg), so point it at this test's dir for the duration.
  const prevStateDir = process.env.TELEGRAM_STATE_DIR
  process.env.TELEGRAM_STATE_DIR = stateDir
  const origWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    stderr.push(String(s))
    return true
  }
  try {
    await deliverCapturedProse(
      {
        outboundDedup: new OutboundDedupCache({}),
        bot: bot as never,
        robustApiCall: passthroughRetry,
        redactOutboundText: (t: string) => t,
        recordOutbound: () => {},
        HISTORY_ENABLED: false,
        OBLIGATION_LEDGER_ENABLED: false,
        obligationLedger: { close: () => {} },
        clearSilentEndState: () => {},
        recordUndeliveredTurnEnd: () => ({ exhausted: false }),
        hasOutboundDeliveredSince: () => false,
      },
      {
        chatId: DM_CHAT,
        threadId: undefined,
        statusKeyStr: `${DM_CHAT}:_`,
        registryKey: null,
        originTurnId: NONCE,
        text: decision.text!,
        replyToolThrewThisTurn: decision.replyToolThrewThisTurn === true,
      },
    )
  } finally {
    ;(process.stderr as unknown as { write: typeof origWrite }).write = origWrite
    if (prevStateDir === undefined) delete process.env.TELEGRAM_STATE_DIR
    else process.env.TELEGRAM_STATE_DIR = prevStateDir
  }
  return { stderr }
}

describe('#4141 elected path — the bridge, not the sweep, is the common deliverer', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
    writeFreshHeartbeat(dir)
    writeOpenObligation(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('PREMISE: a thrown QUALIFYING reply writes no outbox record and elects the bridge', () => {
    const t = electedThrowTranscript(dir, WORKING_NOTES)
    const res = runHook(t, dir)
    expect(res.status).toBe(0)
    // The sweep-path record — the only thing the outbox framing can label —
    // is never written on this shape. This is exactly why the sweep-side fix
    // alone left #4141 open.
    expect(outboxRecords(dir)).toEqual([])
    expect(res.stderr).toContain('deferring to single-writer election')
    expect(res.stderr).toContain('single-writer election ALLOWED stop')
    // ...and a real sweep tick therefore has nothing at all to deliver.
    expect(outboxRecords(dir)).toHaveLength(0)
  })

  it('the elected state file carries the reply-throw signal to the bridge', () => {
    runHook(electedThrowTranscript(dir, WORKING_NOTES), dir)
    const state = readElectedState(dir)
    expect(state).not.toBeNull()
    expect(state!.replyToolThrewThisTurn).toBe(true)
    expect(state!.pendingText).toBe(WORKING_NOTES)
    expect(state!.turnId).toBe(NONCE)
  })

  it('a turn whose reply did NOT throw carries no signal — no stale carryover', () => {
    // Seed a state file that already claims a throw, then run a CLEAN turn.
    // `buildNextState` must DELETE the field, not spread it forward.
    writeFileSync(
      join(dir, 'silent-end-pending.json'),
      JSON.stringify({ retryCount: 0, replyToolThrewThisTurn: true, turnKey: 'stale' }),
      'utf8',
    )
    runHook(electedThrowTranscript(dir, WORKING_NOTES, { throws: false }), dir)
    const state = readElectedState(dir)
    expect(state).not.toBeNull()
    expect(state!.replyToolThrewThisTurn).toBeUndefined()
  })

  it('OUTCOME: the bridge delivers the prose WITH its provenance stated', async () => {
    runHook(electedThrowTranscript(dir, WORKING_NOTES), dir)
    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
      { stateDir: dir },
    )
    expect(decision.deliver).toBe(true)
    expect(decision.text).toBe(WORKING_NOTES)
    expect(decision.replyToolThrewThisTurn).toBe(true)

    const bot = recordingBot()
    const { stderr } = await realBridge(dir, bot, decision)

    // A. FRAMING NEVER SILENCES — exactly one chat-visible call, prose intact.
    expect(bot.chatCalls()).toHaveLength(1)
    const sent = bot.chatCalls()[0]!.text
    expect(sent).toContain(WORKING_NOTES)
    expect(sent).toContain(REPLY_THROW_PROVENANCE_NOTICE)
    expect(sent.indexOf(REPLY_THROW_PROVENANCE_NOTICE)).toBeLessThan(sent.indexOf(WORKING_NOTES))

    // B. FRAMING IS OBSERVABLE — durable journal stamp + one telemetry line.
    const journal = journalLines(dir)
    expect(journal).toHaveLength(1)
    expect(journal[0]!.framedProvenance).toBe('reply-throw')
    expect(journal[0]!.tgMessageId).toBeDefined()
    // The journal key stays on the RAW text so exactly-once-among-backstops
    // is unaffected by the label.
    expect(journal[0]!.textSha256).toBe(sha256Hex(WORKING_NOTES))
    expect(stderr.filter((l) => l.includes('outbox provenance framing'))).toHaveLength(1)
  })

  it('REVERT CHECK: with framing off the bridge reproduces the #4141 leak', async () => {
    const prev = process.env.SWITCHROOM_TG_OUTBOX_PROVENANCE_FRAMING
    process.env.SWITCHROOM_TG_OUTBOX_PROVENANCE_FRAMING = '0'
    try {
      runHook(electedThrowTranscript(dir, WORKING_NOTES), dir)
      const decision = decideCapturedProseDelivery(
        { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
        { stateDir: dir },
      )
      const bot = recordingBot()
      await realBridge(dir, bot, decision)
      expect(bot.chatCalls()).toHaveLength(1)
      // The bug: working notes delivered to a waiting human, unlabelled.
      expect(bot.chatCalls()[0]!.text).toBe(WORKING_NOTES)
      expect(bot.chatCalls()[0]!.text).not.toContain(REPLY_THROW_PROVENANCE_NOTICE)
      expect(journalLines(dir)[0]!.framedProvenance).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_TG_OUTBOX_PROVENANCE_FRAMING
      else process.env.SWITCHROOM_TG_OUTBOX_PROVENANCE_FRAMING = prev
    }
  })

  it('ANTI-SILENCE: a genuine answer rewritten as prose still arrives in full', async () => {
    runHook(electedThrowTranscript(dir, REAL_ANSWER), dir)
    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
      { stateDir: dir },
    )
    const bot = recordingBot()
    await realBridge(dir, bot, decision)
    expect(bot.chatCalls()).toHaveLength(1)
    expect(bot.chatCalls()[0]!.text).toContain(REAL_ANSWER)
  })

  it('LEGACY: a state file with no signal delivers byte-for-byte unframed', async () => {
    writeFileSync(
      join(dir, 'silent-end-pending.json'),
      JSON.stringify({
        retryCount: 0,
        turnKey: `${DM_CHAT}:_`,
        turnId: NONCE,
        chatId: DM_CHAT,
        threadId: null,
        timestamp: Date.now(),
        pendingText: WORKING_NOTES,
      }),
      'utf8',
    )
    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
      { stateDir: dir },
    )
    expect(decision.replyToolThrewThisTurn).toBeUndefined()
    const bot = recordingBot()
    await realBridge(dir, bot, decision)
    expect(bot.chatCalls()[0]!.text).toBe(WORKING_NOTES)
  })

  it('the label is presentation only — dedup still keys on the RAW prose', async () => {
    // Additive-by-construction, re-established on THIS path: this path has its
    // own send ladder and its own dedup, so the sweep's proof does not carry.
    // A second bridge call with the same raw text must dedup (zero new sends)
    // even though the first send carried the banner.
    const dedup = new OutboundDedupCache({})
    const bot = recordingBot()
    const deps = {
      outboundDedup: dedup,
      bot: bot as never,
      robustApiCall: passthroughRetry,
      redactOutboundText: (t: string) => t,
      recordOutbound: () => {},
      HISTORY_ENABLED: false,
      OBLIGATION_LEDGER_ENABLED: false,
      obligationLedger: { close: () => {} },
      clearSilentEndState: () => {},
      recordUndeliveredTurnEnd: () => ({ exhausted: false }),
      hasOutboundDeliveredSince: () => false,
    }
    const args = {
      chatId: DM_CHAT,
      threadId: undefined,
      statusKeyStr: `${DM_CHAT}:_`,
      registryKey: null,
      originTurnId: NONCE,
      text: WORKING_NOTES,
      replyToolThrewThisTurn: true,
    }
    await deliverCapturedProse(deps, args)
    expect(bot.chatCalls()).toHaveLength(1)
    // Same raw text arriving unframed (e.g. a late reply-tool retry) is still
    // recognised as already-sent — the banner did not change the identity.
    await deliverCapturedProse(deps, { ...args, replyToolThrewThisTurn: false })
    expect(bot.chatCalls()).toHaveLength(1)
  })

  it('DISJOINTNESS: the turn-flush machine cannot deliver on a reply-throw turn', () => {
    // The elected `no-final-reply` leg names the flush as the deliverer, so it
    // is fair to ask whether IT also needs the label. It does not, and this is
    // structural rather than a judgement: `turn.replyCalled` is set on the
    // reply tool's CALL event (stream-render.ts:1196), before any result, so a
    // thrown reply still sets it — and `decideTurnFlush` skips outright on
    // `replyCalled`. A reply-throw turn can therefore never reach the flush
    // send site, which is why framing lives on the bridge instead.
    const flushed = decideTurnFlush({
      replyCalled: true,
      capturedText: [WORKING_NOTES],
      turnFlushSafetyEnabled: true,
    } as never)
    expect(flushed.kind).toBe('skip')
    expect(flushed.reason).toBe('reply-called')
  })
})

describe('#4141 — the elected path is WIRED, not just implemented', () => {
  it('stream-render forwards the signal from the decision into the bridge call', () => {
    // The two ends of this path are covered by outcome tests above
    // (`decideCapturedProseDelivery` surfaces the signal; `deliverCapturedProse`
    // frames on it). The ONE link between them is a single argument in
    // stream-render's turn_end handler, which cannot be driven in isolation —
    // it lives inside a ~2000-line event handler with the whole gateway as its
    // closure. So it is pinned structurally: without this argument the feature
    // is inert in production while every other test in this file still passes,
    // which is exactly the failure mode this pin exists to catch.
    const src = readFileSync(resolve(__dirname, '..', 'gateway', 'stream-render.ts'), 'utf8')
    const call = src.slice(src.indexOf('void deliverCapturedProse({'))
    const body = call.slice(0, call.indexOf('\n            })'))
    expect(body).toContain('replyToolThrewThisTurn: proseDecision.replyToolThrewThisTurn === true')
  })
})
