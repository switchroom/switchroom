/**
 * outbox-audience-3865.test.ts — W1-d, "the audience bit" (issue #3865).
 *
 * THE BUG THIS GUARDS
 * -------------------
 * Nothing in capture → journal → sweep recorded WHO a piece of text was for.
 * Capture picks the terminal assistant-prose run structurally, so when the
 * reply tool throws (#3861) the agent's trailing WORKING NOTES become the
 * "final answer", get journaled, and the sweep faithfully delivers internal
 * orchestration prose into the operator's chat. That is a private-data leak.
 *
 * THE BAR
 * -------
 * Not "the right audience is delivered" — "the WRONG audience CANNOT receive".
 * So every assertion below drives REAL machinery, never a stub of it:
 *
 *   - the REAL Stop hook (`hooks/silent-end-interrupt-stop.mjs`) spawned as a
 *     subprocess against a REAL transcript, writing a REAL outbox record;
 *   - the REAL `sweepOutbox` tick, with the REAL `createOutboxSend` adapter
 *     wired to a RECORDING fake Bot API that counts every method that could
 *     put bytes in a chat (sendRichMessage / sendMessage / editMessageText);
 *   - the REAL fleet-health detectors from `src/fleet-health/detect.ts` for
 *     the honesty claims.
 *
 * `revert check` below is the load-bearing one: it flips the gate off and
 * asserts the leak REPRODUCES, proving the zero-sends assertion in the primary
 * test is actually testing the gate and not passing for some unrelated reason.
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
import { sha256Hex } from '../outbox.js'
import {
  decideCaptureAudience,
  resolveOpenObligation,
  resolveRecordAudience,
  shouldSuppressForAudience,
  formatInternalSuppression,
} from '../hooks/audience-classify.mjs'
import { scanForOutboxCapture } from '../hooks/silent-end-scan.mjs'
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
const PRIOR_MSG_ID = 4242

/** The internal working-notes prose that must never reach a chat. */
const WORKING_NOTES = [
  'Dispatched the worker onto the rebase and it came back clean, so the next',
  'step is to re-run the scoped suite before touching the sweep at all. If the',
  'suite is still red after that I will bisect from the merge base rather than',
  'guessing, and I should double-check whether the earlier claim about the',
  'adapter ordering actually holds, because I never verified it against HEAD.',
].join(' ')

/** A genuine answer, for the positive control. */
const REAL_ANSWER = [
  'The rebase is done and the suite is green. Two files changed: the sweep now',
  'checks the record before it routes anything, and the capture hook stamps the',
  'field it checks. Nothing else moved, and the flood queue behaves exactly as',
  'it did before because it stamps the same value it always implied.',
].join(' ')

function makeStateDir(): string {
  // NEVER ~/.switchroom — a test that writes there corrupts production state.
  return mkdtempSync(join(tmpdir(), 'w1d-audience-'))
}

function writeTranscript(dir: string, lines: object[]): string {
  const p = join(dir, 'transcript.jsonl')
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  return p
}

function runHook(transcriptPath: string, stateDir: string) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's', transcript_path: transcriptPath }),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
  })
}

interface RecordShape {
  turnNonce: string
  text: string
  audience?: string
  chatId: string | null
  originChatId?: string | null
  source: string
  textSha256: string
  createdAt: number
}

function outboxRecords(dir: string): RecordShape[] {
  const outbox = join(dir, 'outbox')
  if (!existsSync(outbox)) return []
  return readdirSync(outbox)
    .filter((f) => f.endsWith('.json'))
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

function writeObligations(dir: string, obligations: object[]): void {
  writeFileSync(join(dir, 'obligations.json'), JSON.stringify({ v: 1, obligations }), 'utf8')
}

function openObligation(chatId: string) {
  return {
    originTurnId: `${chatId}:_#${PRIOR_MSG_ID}`,
    chatId,
    messageId: PRIOR_MSG_ID,
    text: 'where did the rebase land?',
    openedAt: 1_000,
    representCount: 0,
  }
}

/**
 * A RECORDING fake Bot API. Every method that can put bytes into a chat is
 * counted, so "zero sends" means zero of ANY of them — not "zero of the one
 * method I remembered to stub".
 */
function recordingBot() {
  const calls: Array<{ method: string; chatId: string; text: string }> = []
  let nextId = 900
  return {
    calls,
    /** Every chat-visible call, whatever the method. */
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
  opts: { gateEnabled?: boolean; now?: number } = {},
) {
  const logLines: string[] = []
  const escalations: string[] = []
  const summary = await sweepOutbox({
    send: createOutboxSend({ getBot: () => bot, retry: passthroughRetry }),
    textAlreadyDelivered: () => false,
    stateDir,
    // Past the quiet window so the record is eligible this tick.
    now: () => opts.now ?? Date.now() + 60_000,
    quietMs: 0,
    log: (l) => logLines.push(l),
    ...(opts.gateEnabled === undefined ? {} : { audienceGateEnabled: () => opts.gateEnabled! }),
    escalateInternalSuppression: (l) => escalations.push(l),
  })
  return { summary, logLines, escalations }
}

/**
 * The #3861 transcript shape, verbatim in structure:
 *   1. an EARLIER Telegram inbound (the session's origin chat, already answered
 *      — this is what `resolveSessionOriginChat` stamps as `originChatId`, and
 *      it is the chat the leak lands in);
 *   2. a background wake (task-notification) — the anchor for THIS turn;
 *   3. an interim reply-tool ack, which THROWS;
 *   4. trailing working-notes prose, which capture then selects as "the answer".
 */
function leakTranscript(dir: string, prose: string): string {
  return writeTranscript(dir, [
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: `<channel source="telegram" chat_id="${DM_CHAT}" message_id="${PRIOR_MSG_ID}">where did the rebase land?</channel>`,
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

describe('W1-d — audience classifier (pure)', () => {
  it('marks internal ONLY on positive evidence: reply threw AND no open obligation', () => {
    expect(
      decideCaptureAudience({ replyToolThrewThisTurn: true, openInboundObligation: false }),
    ).toBe('internal')
  })

  it('every other combination resolves to user (the conservative direction)', () => {
    // A misclassified answer is a SILENT NO-OP (sev-3). A misclassified note is
    // the status quo. So uncertainty must always land on `user`.
    for (const oblig of [true, false, 'unknown'] as const) {
      expect(
        decideCaptureAudience({ replyToolThrewThisTurn: false, openInboundObligation: oblig }),
      ).toBe('user')
    }
    expect(
      decideCaptureAudience({ replyToolThrewThisTurn: true, openInboundObligation: true }),
    ).toBe('user')
    expect(
      decideCaptureAudience({ replyToolThrewThisTurn: true, openInboundObligation: 'unknown' }),
    ).toBe('user')
    expect(decideCaptureAudience({})).toBe('user')
  })

  it('obligation state is three-valued: absent/corrupt snapshots are unknown, not empty', () => {
    expect(resolveOpenObligation({ snapshotRaw: null, chatId: DM_CHAT })).toBe('unknown')
    expect(resolveOpenObligation({ snapshotRaw: '{not json', chatId: DM_CHAT })).toBe('unknown')
    expect(resolveOpenObligation({ snapshotRaw: '{"v":1}', chatId: DM_CHAT })).toBe('unknown')
    expect(
      resolveOpenObligation({ snapshotRaw: '{"v":1,"obligations":[]}', chatId: DM_CHAT }),
    ).toBe(false)
    expect(
      resolveOpenObligation({
        snapshotRaw: JSON.stringify({ v: 1, obligations: [openObligation(DM_CHAT)] }),
        chatId: DM_CHAT,
      }),
    ).toBe(true)
    // Scoped: an obligation in ANOTHER chat does not block this one...
    expect(
      resolveOpenObligation({
        snapshotRaw: JSON.stringify({ v: 1, obligations: [openObligation('5550002')] }),
        chatId: DM_CHAT,
      }),
    ).toBe(false)
    // ...but an UNRESOLVED chat with someone waiting somewhere is unknown.
    expect(
      resolveOpenObligation({
        snapshotRaw: JSON.stringify({ v: 1, obligations: [openObligation('5550002')] }),
        chatId: null,
      }),
    ).toBe('unknown')
  })

  it('suppression requires the exact `internal` literal — nothing else counts', () => {
    expect(resolveRecordAudience('internal')).toBe('internal')
    for (const v of [undefined, null, '', 'user', 'INTERNAL', 'internal ', 1, {}, ['internal']]) {
      expect(resolveRecordAudience(v)).toBe('user')
    }
  })
})

describe('W1-d — capture tags the audience at the real Stop hook', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reproduces #3861: the errored reply tool is visible in the transcript scan', () => {
    const t = leakTranscript(dir, WORKING_NOTES)
    const capture = scanForOutboxCapture(readFileSync(t, 'utf8')) as {
      capture: boolean
      text: string
      replyToolThrewThisTurn: boolean
      originChatId: string | null
    }
    // The bug shape: capture still fires (structural selection of terminal
    // prose) — the working notes ARE what would be delivered.
    expect(capture.capture).toBe(true)
    expect(capture.text).toBe(WORKING_NOTES)
    expect(capture.originChatId).toBe(DM_CHAT)
    // The new signal. Pre-change the scanner never read tool_result at all.
    expect(capture.replyToolThrewThisTurn).toBe(true)
  })

  it('the real hook writes audience:internal for the #3861 shape', () => {
    writeObligations(dir, [])
    const t = leakTranscript(dir, WORKING_NOTES)
    const r = runHook(t, dir)
    expect(r.status).toBe(0)
    const records = outboxRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0].audience).toBe('internal')
    expect(records[0].text).toBe(WORKING_NOTES)
  })

  it('the real hook writes audience:user when someone IS waiting on that chat', () => {
    writeObligations(dir, [openObligation(DM_CHAT)])
    const t = leakTranscript(dir, REAL_ANSWER)
    const r = runHook(t, dir)
    expect(r.status).toBe(0)
    const records = outboxRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0].audience).toBe('user')
  })

  it('the real hook writes audience:user when no reply tool threw', () => {
    writeObligations(dir, [])
    const t = writeTranscript(dir, [
      {
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification><task-id>a7cc7a0fa8f</task-id> worker done</task-notification>',
        timestamp: 2000,
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: REAL_ANSWER }] } },
    ])
    const r = runHook(t, dir)
    expect(r.status).toBe(0)
    expect(outboxRecords(dir)[0].audience).toBe('user')
  })
})

describe('W1-d — the sweep cannot deliver internal prose', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  /** Capture the #3861 leak shape through the REAL hook. */
  function captureLeak(): RecordShape {
    writeObligations(dir, [])
    const t = leakTranscript(dir, WORKING_NOTES)
    expect(runHook(t, dir).status).toBe(0)
    const records = outboxRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0].audience).toBe('internal')
    return records[0]
  }

  it('PRIMARY: a real sweep tick makes ZERO chat calls, fires ONE telemetry line, and terminally claims the entry', async () => {
    const rec = captureLeak()
    const bot = recordingBot()

    const first = await realSweep(dir, bot)

    // 1. The bar: the wrong audience CANNOT receive. Not "no sendMessage" —
    //    no call of ANY chat-visible method, carrying that content or not.
    expect(bot.chatCalls()).toEqual([])
    expect(first.summary.delivered).toBe(0)
    expect(first.summary.audienceSuppressed).toBe(1)

    // 2. Exactly one structured telemetry line, on the NON-CHAT channel.
    expect(first.escalations).toHaveLength(1)
    expect(first.escalations[0]).toContain('audience=internal')
    expect(first.escalations[0]).toContain(`nonce=${rec.turnNonce}`)

    // 3. Terminally claimed: the pending record is gone and the nonce is
    //    journaled with an explicit, named suppression outcome.
    expect(outboxRecords(dir)).toHaveLength(0)
    const journal = journalLines(dir)
    expect(journal).toHaveLength(1)
    expect(journal[0].turnNonce).toBe(rec.turnNonce)
    expect(journal[0].suppressedAudience).toBe('internal')
    expect(journal[0].deliverySource).toBe('sweep')
    expect(journal[0].tgMessageId).toBeUndefined()

    // 4. A SECOND tick sends nothing and re-escalates nothing.
    const second = await realSweep(dir, bot)
    expect(bot.chatCalls()).toEqual([])
    expect(second.summary.scanned).toBe(0)
    expect(second.escalations).toHaveLength(0)
  })

  it('REVERT CHECK: with the gate disabled the leak REPRODUCES (so the assertion above is load-bearing)', async () => {
    captureLeak()
    const bot = recordingBot()

    const run = await realSweep(dir, bot, { gateEnabled: false })

    // The pre-change behaviour, verbatim: the working notes go to the chat.
    expect(bot.chatCalls().length).toBe(1)
    expect(bot.chatCalls()[0].chatId).toBe(DM_CHAT)
    expect(bot.chatCalls()[0].text).toContain('I will bisect from the merge base')
    expect(run.summary.delivered).toBe(1)
    expect(run.summary.audienceSuppressed).toBeUndefined()
    expect(run.escalations).toHaveLength(0)
  })

  it('POSITIVE CONTROL: an audience:user record with an open obligation delivers unchanged', async () => {
    writeObligations(dir, [openObligation(DM_CHAT)])
    const t = leakTranscript(dir, REAL_ANSWER)
    expect(runHook(t, dir).status).toBe(0)
    const rec = outboxRecords(dir)[0]
    expect(rec.audience).toBe('user')

    const bot = recordingBot()
    const run = await realSweep(dir, bot)

    expect(run.summary.delivered).toBe(1)
    expect(run.summary.audienceSuppressed).toBeUndefined()
    expect(bot.chatCalls().length).toBe(1)
    expect(bot.chatCalls()[0].chatId).toBe(DM_CHAT)
    expect(bot.chatCalls()[0].text).toContain('The rebase is done')
    const journal = journalLines(dir)
    expect(journal).toHaveLength(1)
    expect(journal[0].suppressedAudience).toBeUndefined()
    expect(journal[0].tgMessageId).toBeDefined()
    expect(run.escalations).toHaveLength(0)
  })

  it('LEGACY: a record with NO audience field follows the documented default (user) and delivers', async () => {
    // Byte-for-byte a pre-change record: no `audience` key at all.
    const outbox = join(dir, 'outbox')
    mkdirSync(outbox, { recursive: true })
    const nonce = `${DM_CHAT}:_#5150`
    const legacy = {
      turnNonce: nonce,
      chatId: DM_CHAT,
      threadId: null,
      text: REAL_ANSWER,
      textSha256: sha256Hex(REAL_ANSWER),
      createdAt: 1000,
      source: 'channel',
    }
    expect(Object.keys(legacy)).not.toContain('audience')
    writeFileSync(join(outbox, `${nonce}.json`), JSON.stringify(legacy), 'utf8')

    const bot = recordingBot()
    const run = await realSweep(dir, bot)

    expect(run.summary.delivered).toBe(1)
    expect(run.summary.audienceSuppressed).toBeUndefined()
    expect(bot.chatCalls().length).toBe(1)
    expect(bot.chatCalls()[0].text).toContain('The rebase is done')
  })

  it('the gate is a property of the RECORD, not of the send adapter (W1-b swap safety)', async () => {
    captureLeak()
    // A send adapter that would EXPLODE if it were ever reached. The gate sits
    // upstream at entry selection, so swapping the adapter (W1-b) cannot
    // reintroduce the leak.
    const summary = await sweepOutbox({
      send: async () => {
        throw new Error('send adapter must never be reached for an internal record')
      },
      textAlreadyDelivered: () => false,
      stateDir: dir,
      now: () => Date.now() + 60_000,
      quietMs: 0,
      escalateInternalSuppression: () => {},
    })
    expect(summary.audienceSuppressed).toBe(1)
    expect(summary.sendFailures).toBe(0)
  })
})

describe('W1-d — suppression is honest telemetry, not a delivery failure', () => {
  let dir: string
  beforeEach(() => {
    dir = makeStateDir()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the suppression line matches NO gateway alarm signature', () => {
    const line = formatInternalSuppression({
      turnNonce: `${DM_CHAT}:_#${PRIOR_MSG_ID}`,
      turnId: `${DM_CHAT}:_#${PRIOR_MSG_ID}`,
      chatId: DM_CHAT,
      textSha256: sha256Hex(WORKING_NOTES),
      ageMs: 61_000,
      source: 'task-notification',
      pastWindow: true,
    })
    for (const [name, re] of Object.entries(GATEWAY_SIGNATURES)) {
      expect(re.test(line), `${name} must not match a by-design suppression`).toBe(false)
    }
    const gw = detectGatewayFindings('klanker', line)
    expect(gw.findings).toEqual([])
  })

  it('the suppression line carries a turn id the fleet-health scanner can join on', () => {
    const nonce = `${DM_CHAT}:_#${PRIOR_MSG_ID}`
    expect(turnIdFromNonce(nonce)).toBe(nonce)
    // The sha256 fallback nonce (envelope-less anchor) is NOT a turn id and
    // must not be emitted as one.
    expect(turnIdFromNonce('a'.repeat(64))).toBeNull()
    const line = formatInternalSuppression({ turnNonce: nonce, turnId: nonce, chatId: DM_CHAT })
    expect(extractTurnId(line)).toBe(nonce)
  })

  it('a suppressed turn cannot present as silent-no-op:completed-zero-tools', () => {
    // Structural argument, checked rather than asserted by hand: suppression is
    // only reachable when the reply tool was CALLED and threw, so the turn has
    // >= 1 tool call — and the detector's silent-no-op branch requires
    // `tools === 0` (src/fleet-health/detect.ts:305-333). The two shapes are
    // disjoint by construction.
    const now = Math.floor(Date.now() / 1000)
    const row = buildTurnRecord(
      {
        agent: 'klanker',
        startedAt: 1000,
        toolCallCount: 1, // the reply tool call that threw
        turnId: `${DM_CHAT}:_#${PRIOR_MSG_ID}`,
        finalAnswerDelivered: false,
        replyCalled: true,
      },
      Date.now(),
    )
    expect(row.tools).toBe(1)
    // The turn row is written honestly at turn end: nothing reached the user.
    expect(row.status).toBe('no_reply')
    expect(row.route).toBe('none')
    const findings = detectTurnFindings('klanker', [{ ...row, ts: now }])
    expect(findings.filter((f) => f.signal === 'silent-no-op-candidate')).toEqual([])
  })

  it('the sweep gate itself is pure and record-scoped', () => {
    expect(shouldSuppressForAudience({ audience: 'internal' })).toBe(true)
    expect(shouldSuppressForAudience({ audience: 'user' })).toBe(false)
    expect(shouldSuppressForAudience({})).toBe(false)
    // Kill switch (revert-check seam).
    expect(shouldSuppressForAudience({ audience: 'internal' }, { gateEnabled: false })).toBe(false)
  })
})
