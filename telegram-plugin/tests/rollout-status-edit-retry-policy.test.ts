/**
 * #4065 follow-up — the SECOND inertness layer: the retry policy's benign-400
 * swallow.
 *
 * Why this file exists
 * --------------------
 * `rollout-status-edit.test.ts` drives `handleRolloutStatusEdit` with an
 * injected `editMessage` that throws a PLAIN `Error`, so `robustApiCall` is
 * never in the loop. Production wires that same `editMessage` through
 * `robustApiCall` (gateway.ts, `onRolloutStatusEdit`), and the retry policy
 * classifies `400 "message to edit not found"` as a BENIGN 400
 * (`classifyBenignTelegram400` → `'message_not_found'`) and RESOLVES
 * `undefined` instead of rethrowing.
 *
 * The handler reads success from the absence of a throw. So on the real path,
 * for the exact scenario the feature was written for — a seeded-resume
 * narrator holding a carried `narration_message_id` whose card the operator
 * deleted — the handler replied `{ok:true}`, hostd recorded a frozen card as
 * live, and no re-post ever happened. Worse than pre-fix: hostd positively
 * believed the card was fine. The `gone` signal was unreachable for its
 * primary trigger while every test for it was green.
 *
 * So this suite refuses the fake seam twice over:
 *
 *   - the edit goes through a `robustApiCall` composed EXACTLY as gateway.ts
 *     composes it (real `createSendGate.gate` wrapping the real
 *     `createRetryApiCall`), with a REAL `GrammyError` carrying Telegram's
 *     real `description`;
 *   - and the outcome is asserted where the operator feels it — the REAL
 *     `LogTailRolloutNarrator`, which must answer a deleted card with exactly
 *     one fresh post.
 *
 * A test that only asserted `{ok:false, gone:true}` would not have failed on
 * the original #4065 bug either, so this one asserts the re-post.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GrammyError } from 'grammy'
import { createRetryApiCall, type RetryCallOpts } from '../retry-api-call.js'
import { createSendGate } from '../send-gate.js'
import { handleRolloutStatusEdit } from '../gateway/rollout-status-edit.js'
import type { RolloutStatusEditMessage } from '../gateway/ipc-protocol.js'
import {
  LogTailRolloutNarrator,
  type RolloutCardEscalation,
  type RolloutEditOutcome,
  type RolloutNarrationRelay,
} from '../../src/host-control/rollout-narrator.js'
import type { StatusEntry } from '../../src/host-control/server.js'
import type { RolloutPhase } from '../../src/cli/rollout.js'

/** A real grammy 400, byte-identical in shape to what Bot API returns. */
function telegram400(description: string): GrammyError {
  return new GrammyError(
    "Call to 'editMessageText' failed!",
    {
      ok: false,
      error_code: 400,
      description: `Bad Request: ${description}`,
    } as never,
    'editMessageText',
    {} as never,
  )
}

/**
 * `robustApiCall` composed exactly as gateway.ts:~5740 composes it:
 * `sendGate.gate(() => rawRetry(fn, opts), opts)`. No stubs on either layer —
 * this is the production sandwich, and the bug lived between its two slices.
 */
function makeProductionRobustApiCall(): <T>(
  fn: () => Promise<T>,
  opts?: RetryCallOpts,
) => Promise<T> {
  const rawRetry = createRetryApiCall({
    // Only the sleep is injected (fake timers would otherwise stall the
    // network-retry backoff); every classification branch is the real one.
    sleep: async () => {},
  })
  const sendGate = createSendGate({ initialWindows: [], bootRamp: {} })
  return <T>(fn: () => Promise<T>, opts?: RetryCallOpts): Promise<T> =>
    sendGate.gate(() => rawRetry(fn, opts), opts) as Promise<T>
}

/**
 * The gateway's `onRolloutStatusEdit` deps, reproduced with the SAME
 * `robustApiCall` opts the production call site passes — including
 * `rethrowBenign400: true`, the fix under test.
 */
function editThroughGateway(
  fail: (() => never) | null,
  seen: { edits: number },
): (chatId: string | number, messageId: number, text: string) => Promise<unknown> {
  const robustApiCall = makeProductionRobustApiCall()
  return (chatId, messageId, _text) =>
    robustApiCall(
      async () => {
        seen.edits++
        if (fail) fail()
        return { message_id: messageId }
      },
      {
        chat_id: String(chatId),
        verb: 'rollout-status-edit',
        priorityClass: 'critical',
        rethrowBenign400: true,
      },
    )
}

/** Run one `rollout_status_edit` end-to-end and return the reply hostd sees. */
async function relayOneEdit(
  fail: (() => never) | null,
  messageId = 4242,
): Promise<{ reply: Record<string, unknown> | undefined; edits: number }> {
  const seen = { edits: 0 }
  const sent: Record<string, unknown>[] = []
  await handleRolloutStatusEdit(
    {
      selfAgentName: 'overlord',
      operatorChatId: () => 12345,
      editMessage: editThroughGateway(fail, seen),
      log: () => {},
    },
    { send: (m) => void sent.push(m as unknown as Record<string, unknown>) },
    {
      type: 'rollout_status_edit',
      requestId: 'ro-1',
      agentName: 'overlord',
      messageId,
      text: 'phase: self-bump-done',
    } as RolloutStatusEditMessage,
  )
  return { reply: sent[0], edits: seen.edits }
}

describe('rollout-status-edit through the REAL retry policy', () => {
  it('a DELETED card surfaces gone:true (the benign-400 swallow is opted out of)', async () => {
    // Before the fix this resolved `{ok:true}` — the swallow ate the 400 and
    // the handler saw no throw. That is the whole bug.
    const { reply, edits } = await relayOneEdit(() => {
      throw telegram400('message to edit not found')
    })
    expect(edits).toBe(1) // not retried — a benign 400 is terminal
    expect(reply).toMatchObject({
      type: 'rollout_status_edited',
      requestId: 'ro-1',
      ok: false,
      gone: true,
    })
  })

  it('"message is not modified" is a SUCCESS, not a gone (the card is live and correct)', async () => {
    // Also swallowed by default; rethrowing it puts ONE classifier in charge
    // rather than leaving the right answer to a coincidence.
    const { reply } = await relayOneEdit(() => {
      throw telegram400('message is not modified')
    })
    expect(reply).toMatchObject({ type: 'rollout_status_edited', ok: true })
    expect(reply).not.toHaveProperty('gone')
  })

  it("\"message can't be edited\" is also gone", async () => {
    const { reply } = await relayOneEdit(() => {
      throw telegram400("message can't be edited")
    })
    expect(reply).toMatchObject({ ok: false, gone: true })
  })

  it('a NON-benign rejection stays transient (no duplicate card)', async () => {
    const { reply } = await relayOneEdit(() => {
      throw telegram400('chat not found')
    })
    expect(reply).toMatchObject({ ok: false, gone: false })
  })

  it('an applied edit still replies ok:true', async () => {
    const { reply, edits } = await relayOneEdit(null)
    expect(edits).toBe(1)
    expect(reply).toEqual({ type: 'rollout_status_edited', requestId: 'ro-1', ok: true })
  })
})

describe('rethrowBenign400 is scoped — other callers keep the swallow', () => {
  it('a call WITHOUT the opt-out still resolves undefined on a benign 400', async () => {
    const robustApiCall = makeProductionRobustApiCall()
    const res = await robustApiCall(
      async () => {
        throw telegram400('message to edit not found')
      },
      { chat_id: '12345', verb: 'some-card-repaint' },
    )
    expect(res).toBeUndefined()
  })

  it('the benign observer still fires when the error is rethrown', async () => {
    const kinds: string[] = []
    const retry = createRetryApiCall({
      sleep: async () => {},
      observer: { onBenign: ({ kind }) => void kinds.push(kind) },
    })
    await expect(
      retry(
        async () => {
          throw telegram400('message to edit not found')
        },
        { rethrowBenign400: true },
      ),
    ).rejects.toBeInstanceOf(GrammyError)
    expect(kinds).toEqual(['message_not_found'])
  })
})

// ── The operator-visible outcome: a deleted card gets a fresh one ────────────
//
// The reply shape above is a means, not the end. What the operator feels is
// whether a roll whose card was deleted still ends on a truthful ✅/❌. So the
// last test drives the REAL narrator whose relay is the REAL handler over the
// REAL retry policy, and asserts the re-post.

function makeEntry(over: Partial<StatusEntry> = {}): StatusEntry {
  return {
    request_id: 'ro-1',
    caller: { kind: 'agent', name: 'overlord' },
    op: 'rollout',
    result: 'started',
    exit_code: null,
    started_at: Date.now(),
    finished_at: null,
    stdout_tail: '',
    stderr_tail: '',
    pin: 'v1.2.3',
    ...over,
  }
}

const phase = (p: string, over: Partial<RolloutPhase> = {}): RolloutPhase =>
  ({ phase: p as RolloutPhase['phase'], target: 'v1.2.3', ...over }) as RolloutPhase

/**
 * A narration relay whose `edit()` runs the REAL gateway handler over the REAL
 * retry policy and maps the reply exactly as `SocketRolloutNarrationRelay`
 * does (`ok===true` → `{ok:true}`, else `{ok:false, gone: obj.gone===true}`).
 * The socket transport between them is pinned separately by
 * `rollout-narration-edit-socket.test.ts`; what is under test here is the
 * classification, which has to happen where the error still exists.
 */
function makeRealPathRelay(
  deadMessageIds: Set<number>,
  nextMessageId: number | null,
): RolloutNarrationRelay & { posts: number[]; edits: { messageId: number; text: string }[] } {
  const posts: number[] = []
  const edits: { messageId: number; text: string }[] = []
  return {
    posts,
    edits,
    async post() {
      posts.push(nextMessageId ?? -1)
      return nextMessageId
    },
    async edit(args): Promise<RolloutEditOutcome> {
      edits.push({ messageId: args.messageId, text: args.text })
      const dead = deadMessageIds.has(args.messageId)
      const seen = { edits: 0 }
      const sent: Record<string, unknown>[] = []
      await handleRolloutStatusEdit(
        {
          selfAgentName: args.agentName,
          operatorChatId: () => 12345,
          editMessage: editThroughGateway(
            dead
              ? () => {
                  throw telegram400('message to edit not found')
                }
              : null,
            seen,
          ),
          log: () => {},
        },
        { send: (m) => void sent.push(m as unknown as Record<string, unknown>) },
        {
          type: 'rollout_status_edit',
          requestId: args.requestId,
          agentName: args.agentName,
          messageId: args.messageId,
          text: args.text,
        } as RolloutStatusEditMessage,
      )
      const reply = sent[0]
      if (reply?.ok === true) return { ok: true }
      return {
        ok: false,
        gone: reply?.gone === true,
        ...(typeof reply?.reason === 'string' ? { reason: reply.reason } : {}),
      }
    },
  }
}

describe('a deleted rollout card produces a re-post, driven through the real retry policy', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('seeded narrator + operator-deleted card → exactly one fresh post, terminal lands on it', async () => {
    // Card 4242 was carried across the self-bump and then deleted by the
    // operator. 5555 (the re-post) is editable.
    const relay = makeRealPathRelay(new Set([4242]), 5555)
    const escalations: RolloutCardEscalation[] = []
    const n = new LogTailRolloutNarrator(relay, {
      debounceMs: 1000,
      escalate: (e) => void escalations.push(e),
    })
    const entry = makeEntry()

    n.seedPostedMessage('ro-1', 'overlord', 4242)
    n.onPhase(entry, phase('self-bump-done'))
    await vi.runAllTimersAsync()

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR. With the benign-400 swallow in
    // place the handler replied ok:true, the narrator saw a healthy edit, and
    // `posts` stayed empty forever.
    expect(relay.posts).toEqual([5555])

    n.onTerminal(makeEntry({ result: 'completed', rolled: ['a', 'b'] }))
    await vi.runAllTimersAsync()

    // Exactly one re-post (no storm), and the operator's live card carries the
    // terminal outcome.
    expect(relay.posts).toEqual([5555])
    expect(relay.edits.at(-1)!.messageId).toBe(5555)
    expect(relay.edits.at(-1)!.text).toContain('✅')
    // A restored card is not a failure.
    expect(escalations).toEqual([])
  })

  it('a live card is never re-posted (no duplicate on the happy path)', async () => {
    const relay = makeRealPathRelay(new Set(), 5555)
    const n = new LogTailRolloutNarrator(relay, { debounceMs: 1000 })
    const entry = makeEntry()

    n.seedPostedMessage('ro-1', 'overlord', 4242)
    n.onPhase(entry, phase('self-bump-done'))
    await vi.runAllTimersAsync()
    n.onTerminal(makeEntry({ result: 'completed', rolled: ['a'] }))
    await vi.runAllTimersAsync()

    expect(relay.posts).toEqual([])
    expect(relay.edits.at(-1)!.messageId).toBe(4242)
  })
})
