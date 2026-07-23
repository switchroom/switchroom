/**
 * outbox-reply-then-recap-e2e.test.ts — end-to-end regression net for #3510
 * (Telegram double-send) AND its opposite failure mode (#3502 silent drop),
 * driven from ONE harness through the real delivery decision path:
 *
 *   transcript on disk
 *     → gateway reply-site simulation (send + conditional journal, mirroring
 *       `outbound-send-path.ts:2374-2376` — replies go out BEFORE Stop fires)
 *     → the REAL Stop hook (`hooks/silent-end-interrupt-stop.mjs`), spawned as
 *       a subprocess exactly as Claude Code runs it
 *     → the REAL `sweepOutbox` against the real on-disk outbox/journal, ticked
 *       repeatedly across the OUTBOX_QUIET_MS boundary (age-1 / age / age+1 /
 *       past the in-memory dedup TTL) to pressure-test the one-tick race
 *       window rather than a single happy-path tick.
 *
 * The oracle is deliberately FUNCTION-AGNOSTIC: assertions are on what the
 * user observably received — how many messages, with what content, via which
 * transport (`reply-tool` = the formatted reply; `sweep` = the plain-text
 * outbox flush). No assertion names an internal decision function; renaming or
 * refactoring the hook internals cannot green a real double-send or a real
 * drop.
 *
 *   Duplicate direction (#3510): a turn that delivers a reply and then emits a
 *   trailing prose recap (short / long / paraphrased — byte-exact dedup would
 *   miss the reworded ones) must yield EXACTLY ONE user-visible message: the
 *   formatted reply. On pre-fix main the sweep flushed the recap as a second,
 *   unformatted message.
 *
 *   Silence direction (#3502 backstop): a gateway-blind turn (task-notification
 *   handback, cron, zero-reply channel turn) whose only answer is transcript
 *   prose must yield EXACTLY ONE delivery — never zero. This pins that the
 *   #3510 fix did not regress the 2026-07-22 data-loss class.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { sweepOutbox, journalExternalDelivery } from '../gateway/outbox-sweep.js'
import { OUTBOX_QUIET_MS, type OutboxRecord, type DeliveredEntry } from '../outbox.js'
import { shouldJournalReplySiteDelivery, isFinalAnswerReply } from '../final-answer-detect.js'
import { decideTurnEndGate } from '../gateway/turn-end-gate.js'
import { deliverCapturedProse, type DeliverCapturedProseDeps } from '../gateway/outbound-send-path.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'
import type { FlushDecision } from '../turn-flush-safety.js'

const HOOK = resolve(__dirname, '..', 'hooks', 'silent-end-interrupt-stop.mjs')
const REPLY_TOOL = 'mcp__switchroom-telegram__reply'
const CHAT = '111'
const MSG_ID = '42'
/** The gateway's `deriveTurnId` nonce for the CHAT/MSG_ID envelope. */
const GATEWAY_NONCE = `${CHAT}:_#${MSG_ID}`
/** Mirrors the gateway's in-memory `outboundDedup` TTL (~60s). */
const DEDUP_TTL_MS = 60_000

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

interface Delivered {
  via: 'reply-tool' | 'sweep' | 'bridge'
  text: string
}

/** Transcript-line builders. */
const enqueueChannel = (body: string, source = 'telegram', messageId = MSG_ID) => ({
  type: 'queue-operation',
  operation: 'enqueue',
  content: `<channel source="${source}" chat_id="${CHAT}" message_id="${messageId}">${body}</channel>`,
  timestamp: 1000,
})
const enqueueTask = () => ({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<task-notification><task-id>a7cc7a0fa8f</task-id> worker done</task-notification>',
  timestamp: 2000,
})
const prose = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const reply = (text: string, input: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', name: REPLY_TOOL, input: { chat_id: CHAT, text, ...input } }],
  },
})

/**
 * Run one full turn through the real delivery path. Returns everything the
 * user received, in order, plus the on-disk journal/outbox for forensics.
 */
async function runTurn(opts: {
  dir: string
  lines: object[]
  gatewayAlive?: boolean
  /** register a registry-chain hit for task anchors (default: unresolvable → origin route) */
  registryHit?: boolean
}): Promise<{
  delivered: Delivered[]
  hookStdout: string
  hookStderr: string
  records: OutboxRecord[]
  journal: DeliveredEntry[]
}> {
  const { dir, lines, gatewayAlive = true } = opts
  const delivered: Delivered[] = []

  // 1. Gateway reply-site simulation — replies are sent (and conditionally
  //    journaled, same gate as outbound-send-path.ts:2374) BEFORE Stop fires.
  for (const line of lines) {
    const content = (line as { message?: { content?: Array<Record<string, unknown>> } }).message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c.type !== 'tool_use' || c.name !== REPLY_TOOL) continue
      const input = c.input as { text?: string; done?: boolean; disable_notification?: boolean }
      const text = String(input.text ?? '')
      if (/^(NO_REPLY|HEARTBEAT_OK)[\s.!?]*$/i.test(text.trim())) continue
      delivered.push({ via: 'reply-tool', text })
      if (
        shouldJournalReplySiteDelivery({
          text,
          disableNotification: input.disable_notification === true,
          done: input.done === true,
        })
      ) {
        journalExternalDelivery(
          { turnNonce: GATEWAY_NONCE, text, tgMessageId: 1, replyAlreadyDeliveredThisTurn: true },
          dir,
        )
      }
    }
  }

  // 2. Gateway liveness heartbeat (fresh unless the case simulates a dead gateway).
  if (gatewayAlive) writeFileSync(join(dir, 'gateway-heartbeat'), 'hb', 'utf8')

  // 3. The REAL Stop hook, as a subprocess.
  const transcriptPath = join(dir, 'transcript.jsonl')
  writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8')
  const hook = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: 's', transcript_path: transcriptPath }),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, TELEGRAM_STATE_DIR: dir },
  })
  expect(hook.status).toBe(0)

  // 3.5 Gateway turn-end — the REAL gate + the REAL captured-prose bridge
  //     (#3511 review finding 2). `finalAnswerDelivered` is computed with the
  //     REAL `isFinalAnswerReply` classifier at the reply site — the exact code
  //     the gateway runs at outbound-send-path.ts ~2293 — and the disposition
  //     comes from the REAL `decideTurnEndGate`. When (and only when) the gate
  //     says 'reprompt' and the hook persisted `pendingText`, the REAL
  //     `deliverCapturedProse` runs against the same state dir/journal. This
  //     makes the load-bearing `isFinalAnswerReply` ⇔ `finalAnswerDelivered`
  //     agreement an asserted outcome: if the hook defers a shape the gateway
  //     does not consider delivered (or vice versa), the bridge fires and the
  //     exactly-one-message assertions go red.
  //     Only simulated for reply-called turns — a gateway-blind turn (no
  //     CurrentTurn) has no turn_end at all, which is the whole point of the
  //     outbox path.
  const replyInputs: Array<{ text: string; done: boolean; disableNotification: boolean }> = []
  for (const line of lines) {
    const content = (line as { message?: { content?: Array<Record<string, unknown>> } }).message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c.type !== 'tool_use' || c.name !== REPLY_TOOL) continue
      const input = c.input as { text?: string; done?: boolean; disable_notification?: boolean }
      replyInputs.push({
        text: String(input.text ?? ''),
        done: input.done === true,
        disableNotification: input.disable_notification === true,
      })
    }
  }
  const isSentinel = (t: string) => /^(NO_REPLY|HEARTBEAT_OK)[\s.!?]*$/i.test(t.trim())
  const nonSentinelReplies = replyInputs.filter((r) => !isSentinel(r.text))
  if (replyInputs.length > 0) {
    // Same classifier + same site semantics as outbound-send-path.ts ~2293.
    const finalAnswerDelivered = nonSentinelReplies.some((r) =>
      isFinalAnswerReply({ text: r.text, disableNotification: r.disableNotification, done: r.done }),
    )
    // Sentinel-only turns take the gateway's sentinel-suppression path and
    // return before the bridge (stream-render.ts ~1977 comment; verified live
    // in the #3511 review). Reply-called turns take the 'reply-called' skip.
    const flushDecision: FlushDecision =
      nonSentinelReplies.length === 0
        ? { kind: 'skip', reason: 'silent-marker' }
        : { kind: 'skip', reason: 'reply-called' }
    const gate = decideTurnEndGate({ flushDecision, finalAnswerDelivered })
    if (gate === 'reprompt') {
      const statePath = join(dir, 'silent-end-pending.json')
      const pendingText = existsSync(statePath)
        ? (JSON.parse(readFileSync(statePath, 'utf8')) as { pendingText?: string }).pendingText
        : undefined
      if (typeof pendingText === 'string' && pendingText.length > 0) {
        // The gateway's silent-end machinery hands pendingText to the REAL bridge.
        const dedup = new OutboundDedupCache()
        for (const r of nonSentinelReplies) dedup.record(CHAT, undefined, r.text, Date.now(), null)
        const bridgeDeps: DeliverCapturedProseDeps = {
          outboundDedup: dedup,
          bot: {
            api: {
              sendRichMessage: async (_chatId: string, rich: { markdown?: string }, _opts: object) => {
                delivered.push({ via: 'bridge', text: rich.markdown ?? '' })
                return { message_id: 2000 }
              },
            },
          } as unknown as DeliverCapturedProseDeps['bot'],
          robustApiCall: (fn) => fn(),
          redactOutboundText: (text) => text,
          recordOutbound: () => {},
          HISTORY_ENABLED: false,
          OBLIGATION_LEDGER_ENABLED: false,
          obligationLedger: { close: () => {} },
          clearSilentEndState: () => {},
          recordUndeliveredTurnEnd: () => ({ exhausted: false }),
          hasOutboundDeliveredSince: () => false,
        }
        // deliverCapturedProse journals via TELEGRAM_STATE_DIR — point it at
        // this test's isolated state dir for the duration of the call.
        const prevStateDir = process.env.TELEGRAM_STATE_DIR
        process.env.TELEGRAM_STATE_DIR = dir
        try {
          await deliverCapturedProse(bridgeDeps, {
            chatId: CHAT,
            threadId: undefined,
            statusKeyStr: `${CHAT}:main`,
            registryKey: null,
            originTurnId: GATEWAY_NONCE,
            text: pendingText,
          })
        } finally {
          if (prevStateDir == null) delete process.env.TELEGRAM_STATE_DIR
          else process.env.TELEGRAM_STATE_DIR = prevStateDir
        }
      }
    }
  }

  // 4. The REAL sweep, ticked aggressively across the quiet-window boundary.
  //    Tick times are anchored on the record's actual createdAt when one
  //    exists, so the boundary (age === quietMs - 1 / quietMs / quietMs + 1)
  //    is exercised exactly — an ordering regression is caught, not masked.
  const recordsBefore = readOutboxRecords(dir)
  const t0 = recordsBefore.length > 0 ? recordsBefore[0].createdAt : Date.now()
  const tickTimes = [
    t0, // age 0 — inside quiet window
    t0 + OUTBOX_QUIET_MS - 1, // one ms before eligibility
    t0 + OUTBOX_QUIET_MS, // boundary
    t0 + OUTBOX_QUIET_MS + 1, // just past
    t0 + DEDUP_TTL_MS + 1_000, // past the in-memory dedup TTL — journal must hold alone
  ]
  const sentLog: Array<{ text: string; at: number }> = []
  for (const now of tickTimes) {
    await sweepOutbox({
      stateDir: dir,
      now: () => now,
      send: async (_chatId, _threadId, text) => {
        delivered.push({ via: 'sweep', text })
        sentLog.push({ text, at: now })
        return 500
      },
      // Mirrors the gateway's TTL-bounded exact-text `outboundDedup` cache:
      // anything sent (reply or sweep) within the TTL dedups; older evicts.
      textAlreadyDelivered: (_chatId, _threadId, text) =>
        delivered.some(
          (d) =>
            d.text === text &&
            (d.via === 'reply-tool' || sentLog.some((s) => s.text === text && now - s.at < DEDUP_TTL_MS)),
        ),
      registryChainLookup: opts.registryHit ? () => ({ chatId: CHAT, threadId: null }) : () => null,
    })
  }

  return {
    delivered,
    hookStdout: hook.stdout ?? '',
    hookStderr: hook.stderr ?? '',
    records: readOutboxRecords(dir),
    journal: readJournal(dir),
  }
}

function readOutboxRecords(dir: string): OutboxRecord[] {
  const outbox = join(dir, 'outbox')
  try {
    return readdirSync(outbox)
      .filter((f) => f.endsWith('.json') && f !== 'delivered.jsonl' && !f.startsWith('.'))
      .map((f) => JSON.parse(readFileSync(join(outbox, f), 'utf8')) as OutboxRecord)
  } catch {
    return []
  }
}

function readJournal(dir: string): DeliveredEntry[] {
  const p = join(dir, 'outbox', 'delivered.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as DeliveredEntry)
}

// Reply/recap fixtures. The short reply pings (no disable_notification, no
// done) → user-visible final answer, but under the 200-char reply-site journal
// floor — the exact #3510 window (R1 High #1 + #2).
const SHORT_REPLY = 'Deployed the fix to staging — all 3 checks green. ' + 'Detail: '.padEnd(100, 'x')
const LONG_REPLY = 'Full answer with plenty of substance. '.padEnd(250, 'y')
const RECAP_LONG = 'To recap what I just sent: the fix is deployed to staging and all checks are green. '.padEnd(300, 'z')
const RECAP_PARAPHRASE =
  'Summary of the work above, in different words than the reply so byte-exact dedup can never match it. '.padEnd(400, 'w')
const RECAP_SHORT = 'Short recap under the floor.'
const REAL_ANSWER = 'The actual final answer that never went through a reply tool call. '.padEnd(300, 'a')
const HANDBACK_ANSWER = 'B'.repeat(1647)

describe('#3510 e2e — reply-then-recap turns yield EXACTLY ONE user-visible message', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-e2e-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Table: every duplicate-direction shape must end with exactly the formatted
  // reply — never a second sweep flush, whatever the recap's wording/length.
  const duplicateCases: Array<{ name: string; replyText: string; replyInput?: Record<string, unknown>; recap: string }> = [
    { name: 'short ping-final reply + long recap', replyText: SHORT_REPLY, recap: RECAP_LONG },
    { name: 'short ping-final reply + paraphrased recap (defeats byte-exact dedup)', replyText: SHORT_REPLY, recap: RECAP_PARAPHRASE },
    { name: 'short ping-final reply + short recap (below capture floor)', replyText: SHORT_REPLY, recap: RECAP_SHORT },
    { name: 'substantive journaled reply + reworded recap', replyText: LONG_REPLY, recap: RECAP_PARAPHRASE },
    { name: 'done:true reply + long recap', replyText: SHORT_REPLY, replyInput: { done: true }, recap: RECAP_LONG },
  ]

  for (const c of duplicateCases) {
    it(c.name, async () => {
      const r = await runTurn({
        dir,
        lines: [enqueueChannel('deploy it'), reply(c.replyText, c.replyInput), prose(c.recap)],
      })
      // THE user outcome: one message, it is the reply (formatted transport),
      // and no sweep flush ever fires for this turn.
      expect(r.delivered).toEqual([{ via: 'reply-tool', text: c.replyText }])
      // Durable state agrees: nothing pending for the sweep to resurrect later.
      expect(r.records).toHaveLength(0)
    })
  }

  it('dead gateway: still never a second message (worst case is a re-prompt, not a duplicate)', async () => {
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('deploy it'), reply(SHORT_REPLY), prose(RECAP_LONG)],
      gatewayAlive: false,
    })
    expect(r.delivered).toEqual([{ via: 'reply-tool', text: SHORT_REPLY }])
    expect(r.records).toHaveLength(0)
  })

  it('logs both SHAs when deferring, so a double-send is provable from logs alone', async () => {
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('deploy it'), reply(SHORT_REPLY), prose(RECAP_LONG)],
    })
    expect(r.hookStderr).toContain('replyAlreadyDeliveredThisTurn=true')
    expect(r.hookStderr).toContain(`capturedTextSha256=${sha256(RECAP_LONG.trim())}`)
    expect(r.hookStderr).toContain(`deliveredReplySha256=${sha256(SHORT_REPLY)}`)
  })
})

describe('#3502 backstop e2e — gateway-blind turns yield EXACTLY ONE delivery, never zero', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-e2e-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('task-notification handback with prose-only answer (2026-07-22 incident shape) is delivered once', async () => {
    const r = await runTurn({
      dir,
      // A prior real channel inbound gives the session its origin chat (F2).
      lines: [enqueueChannel('earlier question', 'telegram', '7'), enqueueTask(), prose(HANDBACK_ANSWER)],
    })
    const sweeps = r.delivered.filter((d) => d.via === 'sweep')
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].text).toContain(HANDBACK_ANSWER)
    expect(r.delivered).toHaveLength(1) // and nothing else — exactly one delivery
    expect(r.records).toHaveLength(0) // record consumed, not resurrectable
  })

  it('cron turn ending in prose is delivered once', async () => {
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('digest time', 'cron', '9'), prose(REAL_ANSWER)],
    })
    expect(r.delivered).toEqual([{ via: 'sweep', text: REAL_ANSWER.trim() }])
  })

  it('zero-reply channel turn ending in prose is delivered once', async () => {
    const r = await runTurn({ dir, lines: [enqueueChannel('question'), prose(REAL_ANSWER)] })
    expect(r.delivered).toEqual([{ via: 'sweep', text: REAL_ANSWER.trim() }])
  })

  it('interim ack then a real prose answer: the answer is delivered exactly once (not suppressed by the ack)', async () => {
    const ack = 'On it — digging in now.'
    const r = await runTurn({
      dir,
      lines: [
        enqueueChannel('question'),
        reply(ack, { disable_notification: true }), // interim ack: silent, short, not done
        prose(REAL_ANSWER),
      ],
    })
    // User sees the ack (sent live) and the recovered answer — once each.
    expect(r.delivered).toEqual([
      { via: 'reply-tool', text: ack },
      { via: 'sweep', text: REAL_ANSWER.trim() },
    ])
  })

  it('pure NO_REPLY turn delivers nothing', async () => {
    const r = await runTurn({ dir, lines: [enqueueChannel('ping'), prose('NO_REPLY')] })
    expect(r.delivered).toHaveLength(0)
  })

  it('reply-tool NO_REPLY then a substantive prose answer: the answer is delivered exactly once (#3511 finding 1)', async () => {
    // The silence regression the #3511 review caught: a `reply("NO_REPLY")`
    // delivered NOTHING to the user, and the gateway suppresses sentinel turns
    // BEFORE the bridge can run — so if the hook treats the sentinel as
    // "reply already delivered" and defers to the election, the trailing
    // answer is orphaned and DROPPED. The discriminator must count only
    // genuine final-reply deliveries, keeping this shape on the durable
    // outbox/sweep path.
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('question'), reply('NO_REPLY'), prose(REAL_ANSWER)],
    })
    expect(r.delivered).toEqual([{ via: 'sweep', text: REAL_ANSWER.trim() }])
    // Durable path was used: the record existed and was consumed, not elected.
    expect(r.journal.filter((e) => e.deliverySource === 'sweep')).toHaveLength(1)
    expect(r.journal[r.journal.length - 1].replyAlreadyDeliveredThisTurn).toBe(false)
  })

  it('reply-tool NO_REPLY then prose survives a dead gateway (outbox is gateway-liveness-independent)', async () => {
    // The old capture path's durability property must hold for this shape:
    // no heartbeat, no election — the record is still written and swept.
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('question'), reply('NO_REPLY'), prose(REAL_ANSWER)],
      gatewayAlive: false,
    })
    expect(r.delivered).toEqual([{ via: 'sweep', text: REAL_ANSWER.trim() }])
  })
})

describe('#3511 finding 2 — the gateway BRIDGE path agrees with the hook (paraphrase safe end to end)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-e2e-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('genuine reply + paraphrased recap: pendingText IS persisted for the bridge, yet the bridge never fires — exactly one message', async () => {
    // The load-bearing invariant: the hook's fall-through classifier
    // (isFinalAnswerReply on the deliver block) and the gateway's bridge gate
    // (turn.finalAnswerDelivered, set by the SAME classifier) must agree. The
    // harness computes finalAnswerDelivered with the real classifier and runs
    // the real decideTurnEndGate + real deliverCapturedProse when it says
    // 'reprompt' — so if either side of the agreement breaks, the paraphrased
    // recap goes out via the bridge and this goes red with 2 messages.
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('deploy it'), reply(SHORT_REPLY), prose(RECAP_PARAPHRASE)],
    })
    // The election really did elect the bridge as the would-be single writer…
    const state = JSON.parse(readFileSync(join(dir, 'silent-end-pending.json'), 'utf8'))
    expect(state.pendingText).toBe(RECAP_PARAPHRASE.trim())
    // …but the gateway's gate (finalAnswerDelivered=true, same classifier)
    // keeps the bridge off: the user got exactly the formatted reply.
    expect(r.delivered).toEqual([{ via: 'reply-tool', text: SHORT_REPLY }])
    expect(r.delivered.filter((d) => d.via === 'bridge')).toHaveLength(0)
  })

  it('interim ack + real answer: the bridge-eligible turn still yields the answer exactly once', async () => {
    // Counter-case proving the bridge stage in the harness is live, not inert:
    // an ack-only turn has finalAnswerDelivered=false (real classifier), the
    // gate says reprompt — but the hook put the answer on the OUTBOX path
    // (no pendingText persisted), so the sweep delivers and the bridge stays
    // quiet. One ack + one answer, no third copy from any machine.
    const ack = 'On it.'
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('question'), reply(ack, { disable_notification: true }), prose(REAL_ANSWER)],
    })
    const answers = r.delivered.filter((d) => d.text.includes(REAL_ANSWER.trim()))
    expect(answers).toHaveLength(1)
    expect(answers[0].via).toBe('sweep')
  })
})

describe('#3510 instrumentation — the journal alone proves who delivered what', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-e2e-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sweep deliveries journal deliverySource=sweep with the record capture-time flag', async () => {
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('question'), prose(REAL_ANSWER)],
    })
    const sweepEntries = r.journal.filter((e) => e.deliverySource === 'sweep')
    expect(sweepEntries).toHaveLength(1)
    expect(sweepEntries[0].replyAlreadyDeliveredThisTurn).toBe(false)
    expect(sweepEntries[0].textSha256).toBe(sha256(REAL_ANSWER.trim()))
  })

  it('reply-site deliveries journal deliverySource=reply-tool with replyAlreadyDeliveredThisTurn=true', async () => {
    const r = await runTurn({
      dir,
      lines: [enqueueChannel('question'), reply(LONG_REPLY), prose(RECAP_PARAPHRASE)],
    })
    const replyEntries = r.journal.filter((e) => e.deliverySource === 'reply-tool')
    expect(replyEntries).toHaveLength(1)
    expect(replyEntries[0].replyAlreadyDeliveredThisTurn).toBe(true)
    expect(replyEntries[0].textSha256).toBe(sha256(LONG_REPLY))
    // And no sweep entry exists for the turn — one writer, one journal line.
    expect(r.journal.filter((e) => e.deliverySource === 'sweep')).toHaveLength(0)
  })

  it('a bridge delivery journals replyAlreadyDeliveredThisTurn=false (#3511 finding 3)', async () => {
    // The bridge only runs when no genuine final answer was delivered
    // (decideTurnEndGate 'reprompt' requires finalAnswerDelivered === false),
    // so its journal line must stamp the flag false — making a bridge
    // double-send after a reply provable from the journal alone.
    const dedup = new OutboundDedupCache()
    const deps: DeliverCapturedProseDeps = {
      outboundDedup: dedup,
      bot: {
        api: { sendRichMessage: async () => ({ message_id: 3000 }) },
      } as unknown as DeliverCapturedProseDeps['bot'],
      robustApiCall: (fn) => fn(),
      redactOutboundText: (text) => text,
      recordOutbound: () => {},
      HISTORY_ENABLED: false,
      OBLIGATION_LEDGER_ENABLED: false,
      obligationLedger: { close: () => {} },
      clearSilentEndState: () => {},
      recordUndeliveredTurnEnd: () => ({ exhausted: false }),
      hasOutboundDeliveredSince: () => false,
    }
    const prevStateDir = process.env.TELEGRAM_STATE_DIR
    process.env.TELEGRAM_STATE_DIR = dir
    try {
      await deliverCapturedProse(deps, {
        chatId: CHAT,
        threadId: undefined,
        statusKeyStr: `${CHAT}:main`,
        registryKey: null,
        originTurnId: GATEWAY_NONCE,
        text: REAL_ANSWER,
      })
    } finally {
      if (prevStateDir == null) delete process.env.TELEGRAM_STATE_DIR
      else process.env.TELEGRAM_STATE_DIR = prevStateDir
    }
    const journal = readJournal(dir)
    expect(journal).toHaveLength(1)
    expect(journal[0].deliverySource).toBe('reply-tool')
    expect(journal[0].replyAlreadyDeliveredThisTurn).toBe(false)
  })

  it('a captured (gateway-blind) record carries replyAlreadyDeliveredThisTurn=false on disk', async () => {
    // Run only the hook (no sweep) so the record is observable before delivery.
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(
      transcriptPath,
      [enqueueTask(), prose(HANDBACK_ANSWER)].map((l) => JSON.stringify(l)).join('\n'),
      'utf8',
    )
    const hook = spawnSync('node', [HOOK], {
      input: JSON.stringify({ session_id: 's', transcript_path: transcriptPath }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, TELEGRAM_STATE_DIR: dir },
    })
    expect(hook.status).toBe(0)
    const records = readOutboxRecords(dir)
    expect(records).toHaveLength(1)
    expect(records[0].replyAlreadyDeliveredThisTurn).toBe(false)
  })
})
