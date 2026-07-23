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
import { shouldJournalReplySiteDelivery } from '../final-answer-detect.js'

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
  via: 'reply-tool' | 'sweep'
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
