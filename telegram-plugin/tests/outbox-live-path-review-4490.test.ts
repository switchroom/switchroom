/**
 * outbox-live-path-review-4490.test.ts — the self-improvement card gate on
 * the LIVE (elected) send path, issue #4490 (follow-up to PR #4485 / #4141).
 *
 * THE GAP THIS CLOSES
 * --------------------
 * #4485 wired the audience gate + title framing into the OUTBOX SWEEP only
 * (`decideOutboxSweep` in `outbox.ts`, exercised end-to-end in
 * `outbox-self-improve-review.test.ts`). But the outbox sweep only ever
 * fires when the Stop hook writes a durable outbox RECORD, and — exactly as
 * #4141 already found for the reply-throw case — the DOMINANT live shape
 * never does that:
 *
 *   A self-improvement review turn calls the reply tool (itself a prompt
 *   violation — the review's contract is to act silently), and it throws.
 *   `scanForOutboxCapture` classifies the reply-tool call from its INPUT,
 *   sees a QUALIFYING final answer, and marks
 *   `replyAlreadyDeliveredThisTurn = true` even though the call errored. The
 *   Stop hook's single-writer election therefore takes the #3510 branch,
 *   writes NO outbox record, and hands the trailing prose to the gateway's
 *   captured-prose bridge (`deliverCapturedProse`,
 *   `gateway/outbound-send-path.ts`) — a machine the outbox sweep's card
 *   gate can never reach.
 *
 * Before this fix that bridge had NO audience gate and NO self-improvement
 * framing at all: a non-card review turn's raw, unlabelled reasoning would
 * be sent to the operator exactly like any other captured prose — the same
 * leak #4485 closed on the sweep, still open on the bridge.
 *
 * WHAT THIS FILE PINS
 * --------------------
 *   (0) `parseChannelEnvelope` recovers `source="self_improve_review"` from
 *       the REAL double-sourced envelope shape the gateway actually emits
 *       (`<channel source="switchroom-telegram" … source="self_improve_review"
 *       …>`), not just the single-sourced shape other fixtures use.
 *   (a) SURFACING: a review turn ending in a CARD is delivered, self-labelled.
 *   (b) NO-OP: a review turn ending in RAW REASONING is suppressed on the
 *       bridge — zero chat-visible calls.
 *   (b') REVERT CHECK: with the audience gate off, the same raw reasoning
 *       still reaches the operator (proving (b) is load-bearing) but titled
 *       (the residual belt-and-braces framing, so it can never be raw).
 *   (c) ANTI-SILENCE / SEVERITY-3: a genuine waiting operator's answer is
 *       NEVER swallowed by the review branch — both for a normal foreground
 *       turn, and for the specific shape the reviewer flagged: a user
 *       message arriving mid-review-turn becomes the LAST enqueue, so
 *       `resolveCaptureAnchor` anchors on it instead of the review's own
 *       enqueue, and the review branch must not fire at all.
 *   (d) WIRED: the four hops between the transcript scan and the bridge
 *       (`silent-end-scan.mjs` → `silent-end-interrupt-stop.mjs` →
 *       `silent-end.ts` → `stream-render.ts`) actually carry the signal in
 *       production, not just in a hand-built `deliverCapturedProse` call.
 *
 * Every assertion drives REAL machinery: the REAL Stop hook spawned as a
 * subprocess against a REAL transcript, the REAL `decideCapturedProseDelivery`,
 * and the REAL `deliverCapturedProse` against a RECORDING fake Bot API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SELF_IMPROVEMENT_TITLE,
  REVIEW_SOURCE,
} from '../hooks/audience-classify.mjs'
import { scanTurnForFinalReply } from '../hooks/silent-end-scan.mjs'
import { deliverCapturedProse } from '../gateway/outbound-send-path.js'
import { decideCapturedProseDelivery } from '../silent-end.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'

const HOOK = resolve(__dirname, '..', 'hooks', 'silent-end-interrupt-stop.mjs')

// Synthetic ids only (check-no-pii-secrets forbids real chat/user ids).
const DM_CHAT = '5550002'
const INBOUND_MSG_ID = 9130
const USER_MSG_ID = 9131

/** Raw review reasoning — must never reach the operator unlabelled. */
const REVIEW_REASONING = [
  'The failing assertion traced back to a stale fixture, not the code path I',
  'was reviewing, so I am not proposing a change here — logging this as a',
  'non-finding rather than forcing a suggestion just to have said something.',
].join(' ')

/** A well-formed card, exactly as `buildReviewPrompt` instructs the model. */
const REVIEW_CARD = [
  `${SELF_IMPROVEMENT_TITLE} — pending suggestion logged`,
  '- **Signal:** repeated manual retry of the same flaky assertion',
  '- **Suggestion:** add a fixture reset before the retry loop',
  '- **Status:** T2, logged for your review, nothing auto-applied',
].join('\n')

/**
 * A normal operator answer on a normal (non-review) turn. Must clear the
 * scanner's 200-char `FINAL_ANSWER_MIN_CHARS` substance floor for the
 * `trailing-text-after-reply` path (silent-end-scan.mjs:578) — a qualifying
 * reply-tool call already happened in these fixtures (it just threw), so
 * anything shorter is amnestied as a mere "interim ack closer" and the scan
 * returns `{decided:'allow'}` instead of electing the bridge, which starved
 * these fixtures of any elected state to test against.
 */
const NORMAL_ANSWER =
  'The deploy went out cleanly and the health check came back green a minute ' +
  'later, all three services reporting healthy and no errors in the logs ' +
  'since the rollout finished. Latency held steady through the rollout window ' +
  'and no alerts fired on any of the dashboards I checked afterward.'

function makeStateDir(): string {
  // NEVER ~/.switchroom — a test that writes there corrupts production state.
  return mkdtempSync(join(tmpdir(), 'w4490-live-review-'))
}

function writeTranscript(dir: string, lines: object[]): string {
  const p = join(dir, 'transcript.jsonl')
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  return p
}

function runHook(transcriptPath: string, stateDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's', transcript_path: transcriptPath }),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, ...extraEnv },
  })
}

function writeFreshHeartbeat(dir: string): void {
  writeFileSync(join(dir, 'gateway-heartbeat'), 'up', 'utf8')
}

function readElectedState(dir: string): Record<string, unknown> | null {
  const p = join(dir, 'silent-end-pending.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

function journalLines(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, 'outbox', 'delivered.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function outboxRecordCount(dir: string): number {
  const outbox = join(dir, 'outbox')
  if (!existsSync(outbox)) return 0
  return readdirSync(outbox).filter((f) => f.endsWith('.json') && f !== 'delivered.jsonl').length
}

/**
 * A RECORDING fake Bot API — every chat-visible method is counted, so a
 * send-count assertion covers all of them, not just the one the test
 * remembered to stub.
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

/**
 * The REAL review-turn ELECTED shape, using the REAL double-sourced envelope
 * (`source="switchroom-telegram"` from the outer wrapper, THEN
 * `source="self_improve_review"` from the synthesized-inbound meta the
 * gateway hoists onto the same tag — `review-prompt.ts:60-61`), a QUALIFYING
 * reply-tool call (no `disable_notification`, so `isFinalAnswerReply` is true
 * on the input alone — the review turn violating its own silent-turn
 * contract), which THROWS, followed by trailing prose over the bridge's
 * floor.
 */
function electedReviewThrowTranscript(dir: string, prose: string): string {
  return writeTranscript(dir, [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        `<channel source="switchroom-telegram" chat_id="${DM_CHAT}" ` +
        `message_id="${INBOUND_MSG_ID}" source="${REVIEW_SOURCE}">` +
        `[self-improvement review] The turn-end gate detected a learning signal. ` +
        `Run a focused, forked review.</channel>`,
      timestamp: 1000,
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_review_elected',
            name: 'mcp__switchroom-telegram__reply',
            input: { text: 'Here is what I found.' },
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
            tool_use_id: 'toolu_review_elected',
            is_error: true,
            content: 'Error: request timed out after 30000ms',
          },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: prose }] } },
  ])
}

/**
 * The SEVERITY-3 shape: the review's own enqueue, THEN a genuine user
 * message enqueued mid-turn (the LAST enqueue in the file), THEN the
 * review's reply-tool throw and trailing prose. `resolveCaptureAnchor`
 * anchors on the LAST enqueue, so this transcript's anchor is the user
 * message, not the review — the review's `source` must never leak through.
 */
function userMessageDuringReviewTranscript(dir: string, prose: string): string {
  return writeTranscript(dir, [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content:
        `<channel source="switchroom-telegram" chat_id="${DM_CHAT}" ` +
        `message_id="${INBOUND_MSG_ID}" source="${REVIEW_SOURCE}">` +
        `[self-improvement review] The turn-end gate detected a learning signal.</channel>`,
      timestamp: 1000,
    },
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${USER_MSG_ID}">are you still there?</channel>`,
      timestamp: 2000,
    },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_review_mid',
            name: 'mcp__switchroom-telegram__reply',
            input: { text: 'One sec.' },
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
            tool_use_id: 'toolu_review_mid',
            is_error: true,
            content: 'Error: request timed out after 30000ms',
          },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'text', text: prose }] } },
  ])
}

/** Drive the REAL captured-prose bridge against the recording bot. */
async function realBridge(
  stateDir: string,
  bot: ReturnType<typeof recordingBot>,
  decision: { text?: string; replyToolThrewThisTurn?: boolean; reviewOriginated?: boolean },
) {
  const stderr: string[] = []
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
        reviewOriginated: decision.reviewOriginated === true,
      },
    )
  } finally {
    ;(process.stderr as unknown as { write: typeof origWrite }).write = origWrite
    if (prevStateDir === undefined) delete process.env.TELEGRAM_STATE_DIR
    else process.env.TELEGRAM_STATE_DIR = prevStateDir
  }
  return { stderr }
}

const NONCE = `${DM_CHAT}:_#${INBOUND_MSG_ID}`

describe('#4490 (0) — the envelope parser recovers the review source from the REAL double-sourced tag', () => {
  it('scanTurnForFinalReply carries the double-sourced envelope\'s source through to the block result', () => {
    const dir = makeStateDir()
    try {
      const t = electedReviewThrowTranscript(dir, REVIEW_REASONING)
      const result = scanTurnForFinalReply(readFileSync(t, 'utf8')) as {
        decided: string
        source?: string
        replyToolThrewThisTurn?: boolean
      }
      expect(result.decided).toBe('block')
      expect(result.source).toBe(REVIEW_SOURCE)
      expect(result.replyToolThrewThisTurn).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#4490 (d) — the signal is WIRED end to end through the real Stop hook', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
    writeFreshHeartbeat(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('PREMISE: a thrown QUALIFYING reply on a review turn writes no outbox record and elects the bridge', () => {
    const t = electedReviewThrowTranscript(dir, REVIEW_REASONING)
    const res = runHook(t, dir)
    expect(res.status).toBe(0)
    expect(outboxRecordCount(dir)).toBe(0)
    expect(res.stderr).toContain('deferring to single-writer election')
  })

  it('the elected state file carries reviewOriginated to the bridge', () => {
    runHook(electedReviewThrowTranscript(dir, REVIEW_REASONING), dir)
    const state = readElectedState(dir)
    expect(state).not.toBeNull()
    expect(state!.reviewOriginated).toBe(true)
    expect(state!.pendingText).toBe(REVIEW_REASONING)
  })

  it('a NON-review turn carries no reviewOriginated field — no stale carryover', () => {
    // Seed a state file that already claims review-origin, then run a CLEAN
    // (non-review) turn. `buildNextState` must DELETE the field, not spread
    // it forward.
    writeFileSync(
      join(dir, 'silent-end-pending.json'),
      JSON.stringify({ retryCount: 0, reviewOriginated: true, turnKey: 'stale' }),
      'utf8',
    )
    const t = writeTranscript(dir, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${INBOUND_MSG_ID}">status?</channel>`,
        timestamp: 1000,
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_normal',
              name: 'mcp__switchroom-telegram__reply',
              input: { text: 'checking' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_normal', is_error: true, content: 'Error: timeout' }],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: NORMAL_ANSWER }] } },
    ])
    runHook(t, dir)
    const state = readElectedState(dir)
    expect(state).not.toBeNull()
    expect(state!.reviewOriginated).toBeUndefined()
  })

  it('decideCapturedProseDelivery surfaces reviewOriginated from the state file', () => {
    runHook(electedReviewThrowTranscript(dir, REVIEW_REASONING), dir)
    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
      { stateDir: dir },
    )
    expect(decision.deliver).toBe(true)
    expect(decision.reviewOriginated).toBe(true)
    expect(decision.text).toBe(REVIEW_REASONING)
  })

  it('stream-render forwards reviewOriginated from the decision into the bridge call (structural pin)', () => {
    // Mirrors the #4141 structural pin for `replyToolThrewThisTurn`: the ONE
    // link between the decision and the bridge lives inside a ~2000-line
    // event handler that cannot be driven in isolation, so pin it by source
    // inspection — without this argument the feature is inert in production
    // while every decision-side / bridge-side test in this file still passes.
    const src = readFileSync(resolve(__dirname, '..', 'gateway', 'stream-render.ts'), 'utf8')
    const call = src.slice(src.indexOf('void deliverCapturedProse({'))
    const body = call.slice(0, call.indexOf('\n            })'))
    expect(body).toContain('reviewOriginated: proseDecision.reviewOriginated === true')
  })
})

describe('#4490 (a)/(b)/(b\') — the card gate on the LIVE bridge, end to end', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
    writeFreshHeartbeat(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('(a) SURFACING: a review turn ending in a CARD is delivered on the bridge, self-labelled', async () => {
    runHook(electedReviewThrowTranscript(dir, REVIEW_CARD), dir)
    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
      { stateDir: dir },
    )
    expect(decision.reviewOriginated).toBe(true)

    const bot = recordingBot()
    await realBridge(dir, bot, decision)

    expect(bot.chatCalls()).toHaveLength(1)
    const sent = bot.chatCalls()[0]!.text
    // This fixture's qualifying reply also THREW (#4141 provenance banner),
    // so the composed body is [banner][card] — the banner is prepended
    // before the card, not the title. Assert exactly one title occurrence
    // (no double-framing of an already-titled card, per #4489) rather than
    // `startsWith`, which would be a false requirement here.
    const titleOccurrences = sent.split(SELF_IMPROVEMENT_TITLE).length - 1
    expect(titleOccurrences).toBe(1)
    expect(sent).toContain('add a fixture reset before the retry loop')
    expect(journalLines(dir)[0]!.suppressedAudience).toBeUndefined()
    expect(journalLines(dir)[0]!.audience).toBe('user')
  })

  it('(b) NO-OP — THE GAP THIS CLOSES: a review turn ending in RAW REASONING is suppressed on the bridge, zero sends', async () => {
    runHook(electedReviewThrowTranscript(dir, REVIEW_REASONING), dir)
    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
      { stateDir: dir },
    )
    expect(decision.reviewOriginated).toBe(true)

    const bot = recordingBot()
    await realBridge(dir, bot, decision)

    // THE assertion this whole file exists to make: before #4490's fix this
    // path had no audience gate at all, so the raw reasoning was sent here
    // exactly like any other captured prose.
    expect(bot.chatCalls()).toEqual([])
    const journal = journalLines(dir)
    expect(journal).toHaveLength(1)
    expect(journal[0]!.suppressedAudience).toBe('internal')
    expect(journal[0]!.audience).toBe('internal')
    expect(journal[0]!.tgMessageId).toBeUndefined()
  })

  it('(b\') REVERT CHECK: with the audience gate OFF the same reasoning still reaches the operator — but TITLED, never raw', async () => {
    const prev = process.env.SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE
    process.env.SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE = '0'
    try {
      runHook(electedReviewThrowTranscript(dir, REVIEW_REASONING), dir)
      const decision = decideCapturedProseDelivery(
        { turnKey: `${DM_CHAT}:_`, turnId: NONCE },
        { stateDir: dir },
      )
      const bot = recordingBot()
      await realBridge(dir, bot, decision)

      expect(bot.chatCalls()).toHaveLength(1)
      const sent = bot.chatCalls()[0]!.text
      // The raw reasoning is present (degraded-config leak surface) BUT
      // titled — the belt-and-braces residual guarantee.
      expect(sent).toContain(REVIEW_REASONING)
      expect(sent.startsWith(SELF_IMPROVEMENT_TITLE)).toBe(true)
      expect(journalLines(dir)[0]!.framedSelfImprovement).toBe('self-improve')
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE
      else process.env.SWITCHROOM_TG_OUTBOX_AUDIENCE_GATE = prev
    }
  })
})

describe('#4490 (c) — ANTI-SILENCE / SEVERITY-3: a genuine waiting operator is never swallowed', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
    writeFreshHeartbeat(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a normal (non-review) foreground turn is delivered in full, unsuppressed', async () => {
    const t = writeTranscript(dir, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${INBOUND_MSG_ID}">how did the deploy go?</channel>`,
        timestamp: 1000,
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_normal_2',
              name: 'mcp__switchroom-telegram__reply',
              input: { text: 'checking' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_normal_2', is_error: true, content: 'Error: timeout' }],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: NORMAL_ANSWER }] } },
    ])
    runHook(t, dir)
    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: `${DM_CHAT}:_#${INBOUND_MSG_ID}` },
      { stateDir: dir },
    )
    expect(decision.reviewOriginated).toBeUndefined()

    const bot = recordingBot()
    await realBridge(dir, bot, decision)
    expect(bot.chatCalls()).toHaveLength(1)
    expect(bot.chatCalls()[0]!.text).toContain(NORMAL_ANSWER)
  })

  it('SEVERITY-3: a user message arriving mid-review-turn becomes the anchor — the review source never leaks through, and the answer is delivered, not swallowed', async () => {
    // `resolveCaptureAnchor` (silent-end-scan.mjs) anchors on the LAST
    // enqueue in the transcript. Here the review's own enqueue is FIRST and
    // a genuine user message is enqueued SECOND (mid-turn), so the anchor —
    // and therefore `envelope.source` — must be the user's `"telegram"`
    // source, not the review's. If this regressed (e.g. anchoring on the
    // FIRST enqueue instead), a real waiting operator's answer would be
    // misclassified as review-internal and suppressed — strictly worse than
    // the pre-#4490 behaviour on a turn that was never a review leak at all.
    const t = userMessageDuringReviewTranscript(dir, NORMAL_ANSWER)
    const scan = scanTurnForFinalReply(readFileSync(t, 'utf8')) as { source?: string }
    expect(scan.source).toBe('telegram')
    expect(scan.source).not.toBe(REVIEW_SOURCE)

    runHook(t, dir)
    const state = readElectedState(dir)
    expect(state).not.toBeNull()
    expect(state!.reviewOriginated).toBeUndefined()

    const decision = decideCapturedProseDelivery(
      { turnKey: `${DM_CHAT}:_`, turnId: `${DM_CHAT}:_#${USER_MSG_ID}` },
      { stateDir: dir },
    )
    expect(decision.reviewOriginated).toBeUndefined()

    const bot = recordingBot()
    await realBridge(dir, bot, decision)
    // The answer reaches the operator — not suppressed as review-internal.
    expect(bot.chatCalls()).toHaveLength(1)
    expect(bot.chatCalls()[0]!.text).toContain(NORMAL_ANSWER)
  })
})
