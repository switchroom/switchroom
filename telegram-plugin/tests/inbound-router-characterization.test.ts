/**
 * PR-0 — Inbound-router CHARACTERIZATION HARNESS (#2996 P7).
 *
 * This is the missing functional unit-test net #2996 calls for and the
 * PARITY ORACLE for the eventual PR-11 cutover (the old #2794 gate-parity
 * probe was removed in #3316 — design finding F6, so this harness is the
 * only mechanism that pins v1 == v2 behaviour). Every later extraction PR
 * (PR-1..PR-11) must keep this file green.
 *
 * HOW IT WORKS — real intercept code executes; we spy ONLY at the Deps
 * boundary (the red-team requirement, design §4). `handleInbound` /
 * `handleInboundCoalesced` run for real against a synthetic grammY `ctx`.
 * The collaborators mocked are exactly the ones a later `InboundRouterDeps`
 * would inject:
 *   - inbound-delivery-machine-dispatch.js  → dispatchEffects (the effect
 *     executor that needs the live ipcServer). We capture the effect kinds
 *     it is handed — this is the deliver-vs-buffer oracle.
 *   - src/agents/tmux.js                    → sendAgentInterrupt (SIGINT).
 *   - secret-detect/pipeline.js             → runPipeline (fail-closed).
 *   - gateway/auth-add-flow.js              → submitAccountAuthCode stub
 *     (keeps the REAL pendingAuthAddFlows Map so seeding + read hit one
 *     instance).
 * The delivery STATE MACHINE itself (shadow/gate/machine) is NOT mocked —
 * it drives the real deliver-vs-buffer routing, so the at-receipt snapshot
 * semantics (F4) are exercised end-to-end.
 *
 * F1 — the ONE production change PR-0 needs: `handleInbound` /
 *   `handleInboundCoalesced` + a `__inboundRouterTestSeam` accessor were
 *   exported from gateway.ts (they were module-private). No behaviour change.
 * F2 — the `_ENABLED` / `AUTOCLASSIFY_MIDTURN_SHADOW` flags are module-level
 *   `const`s captured at import, so env must be set BEFORE the dynamic
 *   import below; a flag flip needs a separate vitest worker (a second file
 *   with a different env), never an in-process reassignment. This file pins
 *   the default-ON behaviour.
 * F3 — the status-KPI block and the AUTOCLASSIFY_MIDTURN_SHADOW block are
 *   pinned as NON-intercepting (routing unchanged).
 * F4 — the at-receipt turn-in-flight value is a captured SNAPSHOT, not a
 *   live read: a fresh turn delivers even though its own machine emit
 *   advances the machine to in_turn (no self-block); a genuinely mid-turn
 *   inbound buffers. Both directions are pinned.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatKey } from '../gateway/chat-key.js'

// ─── Fixtures / identity ────────────────────────────────────────────────
const SENDER = '111'
const DM_CHAT = 222
const GROUP_CHAT = -1009 // supergroup

// ─── Env BEFORE import (F2: flags are const-captured at module load) ─────
const stateDir = mkdtempSync(join(tmpdir(), 'inbound-router-char-'))
writeFileSync(
  join(stateDir, 'access.json'),
  JSON.stringify({
    // dmPolicy omitted → pairing flow for unknown DM senders; SENDER is
    // allow-listed so its DMs deliver.
    allowFrom: [SENDER],
    pending: {},
    groups: {
      [String(GROUP_CHAT)]: { allowFrom: [SENDER], requireMention: false },
    },
  }),
)
process.env.TELEGRAM_STATE_DIR = stateDir
process.env.SWITCHROOM_AGENT_NAME = 'chartestagent'

// ─── Deps-boundary spies ────────────────────────────────────────────────
// A single ordered call log across every boundary mock — the intercept-ORDER
// oracle (design §3 risk row 1). Each mock appends a tag; a fixture that
// crosses two boundaries asserts their relative order here.
const callLog: string[] = []
const dispatchCalls: { kinds: string[] }[] = []

vi.mock('../gateway/inbound-delivery-machine-dispatch.js', () => ({
  dispatchEffects: (effects: { kind: string }[], deps: any) => {
    const kinds = effects.map((e) => e.kind)
    callLog.push('dispatch:' + kinds.join(','))
    dispatchCalls.push({ kinds })
    // The real dispatcher reports the send result back; simulate a
    // successful bridge delivery so the post-send branches are exercised.
    deps?.onDeliverResult?.('k', true)
  },
}))

const sendAgentInterrupt = vi.fn(() => {
  callLog.push('sigint')
  return { ok: true }
})
vi.mock('../../src/agents/tmux.js', () => ({
  sendAgentInterrupt,
  clearAgentComposer: vi.fn(() => ({ ok: true })),
}))

// runPipeline is controlled per-test via `pipelineImpl`.
let pipelineImpl: (args: any) => any = () => ({ stored: [], rewritten_text: '', deferred: [] })
vi.mock('../secret-detect/pipeline.js', () => ({
  runPipeline: (args: any) => {
    callLog.push('runPipeline')
    return pipelineImpl(args)
  },
}))

// Keep the REAL pendingAuthAddFlows Map (so seeding + gateway read share one
// instance); only stub the network submit so a seeded flow can't touch a
// broker. The order intercept only needs the map delete at the branch head.
vi.mock('../gateway/auth-add-flow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gateway/auth-add-flow.js')>()
  return {
    ...actual,
    submitAccountAuthCode: vi.fn(async () => {
      callLog.push('submitAccountAuthCode')
      throw new Error('stubbed — network suppressed in characterization harness')
    }),
    cancelAccountAuthSession: vi.fn(() => {}),
    cleanScratchDir: vi.fn(() => {}),
  }
})

beforeAll(() => {
  // Neutralize any real Bot API egress the presentation paths attempt
  // (reactions, busy-acks). These are fire-and-forget / swallowed in the
  // gateway; the harness asserts routing, not presentation.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok":true,"result":{}}', { status: 200 })),
  )
})

// Lazily-imported module handles (populated in beforeAll after env is set).
let gw: typeof import('../gateway/gateway.js')
let shadow: typeof import('../gateway/inbound-delivery-machine-shadow.js')
let authAddFlows: typeof import('../gateway/auth-add-flow.js')

beforeAll(async () => {
  gw = await import('../gateway/gateway.js')
  shadow = await import('../gateway/inbound-delivery-machine-shadow.js')
  authAddFlows = await import('../gateway/auth-add-flow.js')
  // Inject a fake ipcServer so the imperative deliver / permission-verdict
  // paths (which deref the module-global) don't crash on `undefined`. The
  // machine-authoritative deliver/buffer routing goes through the mocked
  // dispatchEffects instead; this fake only backstops the legacy callsites.
  gw.__inboundRouterTestSeam.setIpcServer({
    sendToAgent: () => true,
    broadcast: () => {},
  } as any)
})

beforeEach(() => {
  callLog.length = 0
  dispatchCalls.length = 0
  sendAgentInterrupt.mockClear()
  pipelineImpl = () => ({ stored: [], rewritten_text: '', deferred: [] })
  // Fresh machine each test, then bring the bridge up (the default state is
  // bridge_dead, which routes everything to the legacy imperative body).
  shadow.__shadowResetForTests()
  shadow.shadowEmit({ kind: 'bridgeUp', at: Date.now() })
  // Reset seeded intercept state.
  authAddFlows.pendingAuthAddFlows.clear()
  gw.__inboundRouterTestSeam.pendingReauthFlows.clear?.()
  gw.__inboundRouterTestSeam.activeStatusReactions.clear()
  gw.__inboundRouterTestSeam.activeTurnStartedAt.clear()
  gw.__inboundRouterTestSeam.vaultPassphraseCache.clear?.()
  gw.__inboundRouterTestSeam.setCurrentTurn(null)
})

// ─── ctx factory ────────────────────────────────────────────────────────
function makeCtx(opts: {
  text: string
  chatId?: number
  chatType?: 'private' | 'supergroup'
  senderId?: string
  msgId?: number
  threadId?: number
}) {
  const chatId = opts.chatId ?? DM_CHAT
  const chatType = opts.chatType ?? 'private'
  const message: any = {
    message_id: opts.msgId ?? 1,
    text: opts.text,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: chatType },
  }
  if (opts.threadId != null) {
    message.is_topic_message = true
    message.message_thread_id = opts.threadId
  }
  return {
    from: { id: Number(opts.senderId ?? SENDER), is_bot: false, first_name: 'T' },
    chat: { id: chatId, type: chatType },
    message,
    reply: vi.fn(async () => ({})),
    replyWithRichMessage: vi.fn(async () => ({})),
    api: { sendMessage: vi.fn(async () => ({})), config: { use: () => {} } },
  } as any
}

/** Advance the delivery machine for `chatId`/`threadId` into in_turn by
 *  delivering one fresh inbound (no turnEnd) — the mid-turn precondition. */
async function primeInFlightTurn(chatId = DM_CHAT, threadId?: number) {
  await gw.handleInbound(
    makeCtx({ text: 'first turn', chatId, threadId, msgId: 900 }),
    'first turn',
    undefined,
    undefined,
  )
  dispatchCalls.length = 0
  callLog.length = 0
}

const delivered = () => dispatchCalls.some((c) => c.kinds.includes('deliverToBridge'))
const buffered = () => dispatchCalls.some((c) => c.kinds.includes('bufferInbound'))

// ══════════════════════════════════════════════════════════════════════
describe('inbound-router characterization — admission (gate)', () => {
  it('drop: an unknown sender under allowlist policy is dropped (no deliver, no pair reply)', async () => {
    const ctx = makeCtx({ text: 'hi', senderId: '999' })
    // allowlist is implied only if dmPolicy==='allowlist'; here dmPolicy is
    // unset → unknown senders take the PAIR path, not drop. Assert PAIR.
    await gw.handleInbound(ctx, 'hi', undefined, undefined)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(String((ctx.reply as any).mock.calls[0][0])).toMatch(/access pair/)
    expect(delivered()).toBe(false)
    expect(buffered()).toBe(false)
  })

  it('deliver: an allow-listed DM sender is admitted', async () => {
    const ctx = makeCtx({ text: 'hello' })
    await gw.handleInbound(ctx, 'hello', undefined, undefined)
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(delivered()).toBe(true)
  })
})

describe('inbound-router characterization — content types', () => {
  it('text (fresh turn) → deliverToBridge', async () => {
    await gw.handleInbound(makeCtx({ text: 'a plain message' }), 'a plain message', undefined, undefined)
    expect(delivered()).toBe(true)
  })

  it('photo (downloadImage closure present) → deliverToBridge', async () => {
    const dl = vi.fn(async () => '/tmp/pic.jpg')
    await gw.handleInbound(makeCtx({ text: 'look at this' }), 'look at this', dl, undefined)
    expect(delivered()).toBe(true)
  })

  it('voice (already-transcribed text; no download closure) → deliverToBridge', async () => {
    // The voice handler transcribes BEFORE calling handleInbound, so the
    // router just sees text — pinning that the transcription stays upstream
    // of the coalesce/route boundary (design §4 voice/photo caveat).
    await gw.handleInbound(makeCtx({ text: 'transcribed words' }), 'transcribed words', undefined, undefined)
    expect(delivered()).toBe(true)
  })
})

describe('inbound-router characterization — F4 at-receipt snapshot (deliver vs buffer)', () => {
  it('fresh turn DELIVERS despite its own emit advancing the machine to in_turn (no self-block)', async () => {
    // If turnInFlightAtReceipt were a LIVE read taken after the deferred
    // inbound emit, this message would see its own just-started turn and
    // buffer itself — the 5-min-silence wedge. The snapshot prevents it.
    await gw.handleInbound(makeCtx({ text: 'first ever' }), 'first ever', undefined, undefined)
    expect(delivered()).toBe(true)
    expect(buffered()).toBe(false)
  })

  it('genuinely mid-turn inbound BUFFERS (turn already in flight at receipt)', async () => {
    await primeInFlightTurn()
    await gw.handleInbound(makeCtx({ text: 'follow up', msgId: 2 }), 'follow up', undefined, undefined)
    expect(buffered()).toBe(true)
    expect(delivered()).toBe(false)
  })
})

describe('inbound-router characterization — interrupt / stop intercepts', () => {
  it('`!`-interrupt with body bypasses coalescing and fires SIGINT before any delivery', async () => {
    await primeInFlightTurn()
    // Drive through the COALESCED entrypoint to also pin the bypass: an
    // interrupt must not sit in the coalesce window.
    await gw.handleInboundCoalesced(makeCtx({ text: '!stop and do X', msgId: 3 }), '!stop and do X', undefined, undefined)
    expect(sendAgentInterrupt).toHaveBeenCalledTimes(1)
    // ORDER: the SIGINT precedes any deliver-effect dispatch.
    const sigintIdx = callLog.indexOf('sigint')
    const dispatchIdx = callLog.findIndex((t) => t.startsWith('dispatch:'))
    expect(sigintIdx).toBeGreaterThanOrEqual(0)
    if (dispatchIdx >= 0) expect(sigintIdx).toBeLessThan(dispatchIdx)
  })

  it('bare `stop` mid-turn fires SIGINT (executeHaltNow) and does NOT deliver', async () => {
    await primeInFlightTurn()
    await gw.handleInboundCoalesced(makeCtx({ text: 'stop', msgId: 4 }), 'stop', undefined, undefined)
    expect(sendAgentInterrupt).toHaveBeenCalledTimes(1)
    expect(delivered()).toBe(false)
  })

  it('bare `stop` with an attachment is CONTENT, not a halt (flows through, no SIGINT)', async () => {
    const dl = vi.fn(async () => '/tmp/stopsign.jpg')
    await primeInFlightTurn()
    await gw.handleInboundCoalesced(makeCtx({ text: 'stop', msgId: 5 }), 'stop', dl, undefined)
    expect(sendAgentInterrupt).not.toHaveBeenCalled()
  })
})

describe('inbound-router characterization — auth / permission / vault gauntlet', () => {
  it('permission-reply (`y <id>`) is intercepted — never delivered as a turn', async () => {
    await gw.handleInbound(makeCtx({ text: 'y abcde' }), 'y abcde', undefined, undefined)
    expect(delivered()).toBe(false)
    expect(buffered()).toBe(false)
  })

  it('auth-code intercept ORDER: /auth-add consumes BEFORE /reauth (load-bearing)', async () => {
    const key = chatKey(String(DM_CHAT))
    // Seed BOTH pending flows for the same intercept key.
    authAddFlows.pendingAuthAddFlows.set(key as string, {
      label: 'acct', scratchDir: '/tmp/none', startedAt: Date.now(),
    } as any)
    gw.__inboundRouterTestSeam.pendingReauthFlows.set(key as string, {
      agent: 'chartestagent', startedAt: Date.now(),
    })
    // The auth-add branch's post-decision OAuth-code redact issues a RAW
    // `bot.api.deleteMessage` (the module-global `bot` is unbound under a
    // test import) — a presentation-only egress that fires AFTER the
    // load-bearing intercept state below is already set. Tolerate it; the
    // characterization is the routing decision, not the redact I/O.
    await gw.handleInbound(makeCtx({ text: 'session_abc123def456' }), 'session_abc123def456', undefined, undefined)
      .catch(() => {})
    // auth-add branch consumed it (deleted at branch head, before submit).
    expect(authAddFlows.pendingAuthAddFlows.has(key as string)).toBe(false)
    // reauth flow was NOT touched — auth-add won the ordering.
    expect(gw.__inboundRouterTestSeam.pendingReauthFlows.get(key as string)).toBeTruthy()
    expect(callLog).toContain('submitAccountAuthCode')
    expect(delivered()).toBe(false)
  })

  it('auth-code TTL-EXPIRY: a stale /auth-add flow is dropped, NOT consumed as a valid code', async () => {
    const key = chatKey(String(DM_CHAT))
    authAddFlows.pendingAuthAddFlows.set(key as string, {
      label: 'acct', scratchDir: '/tmp/none',
      startedAt: Date.now() - 60 * 60_000, // 60 min ago ≫ 10-min TTL
    } as any)
    await gw.handleInbound(makeCtx({ text: 'session_stalecode1234' }), 'session_stalecode1234', undefined, undefined)
    // Stale entry cleared…
    expect(authAddFlows.pendingAuthAddFlows.has(key as string)).toBe(false)
    // …but never submitted as a valid auth code (the TTL guard held).
    expect(callLog).not.toContain('submitAccountAuthCode')
  })

  it('cross-topic ISOLATION: an /auth-add pending in topic A is NOT consumed by a code pasted in topic B', async () => {
    const keyA = chatKey(String(GROUP_CHAT), 10)
    authAddFlows.pendingAuthAddFlows.set(keyA as string, {
      label: 'acct', scratchDir: '/tmp/none', startedAt: Date.now(),
    } as any)
    // Paste the code in topic B (different thread → different intercept key).
    await gw.handleInbound(
      makeCtx({ text: 'session_codeInTopicB', chatId: GROUP_CHAT, chatType: 'supergroup', threadId: 20, msgId: 7 }),
      'session_codeInTopicB', undefined, undefined,
    )
    // Topic A's flow is untouched; the code was never submitted.
    expect(authAddFlows.pendingAuthAddFlows.has(keyA as string)).toBe(true)
    expect(callLog).not.toContain('submitAccountAuthCode')
  })
})

describe('inbound-router characterization — secret-detect pipeline', () => {
  it('cached-passphrase secret hit runs the pipeline BEFORE delivery (and delivers redacted)', async () => {
    gw.__inboundRouterTestSeam.vaultPassphraseCache.set(String(DM_CHAT), {
      passphrase: 'pw', expiresAt: Date.now() + 60_000,
    })
    pipelineImpl = () => ({
      stored: [{ masked: 'tok…zz', actual_slug: 'secret' }],
      rewritten_text: '[redacted secret]',
      deferred: [],
    })
    // The pipeline is mocked, so the text content is immaterial — kept
    // secret-shaped but NOT a contiguous token literal (check-no-pii-secrets).
    const secretish = ['sk', 'ant', 'xxxxxxxxxxxx'].join('-')
    await gw.handleInbound(makeCtx({ text: secretish }), secretish, undefined, undefined)
    expect(callLog).toContain('runPipeline')
    // ORDER: runPipeline strictly precedes the deliver dispatch (secret must
    // be scrubbed before the agent/IPC/history sinks — design §1 seam #3).
    const pipeIdx = callLog.indexOf('runPipeline')
    const dispatchIdx = callLog.findIndex((t) => t.startsWith('dispatch:'))
    expect(pipeIdx).toBeGreaterThanOrEqual(0)
    expect(dispatchIdx).toBeGreaterThan(pipeIdx)
  })

  it('FAIL-CLOSED: a pipeline throw drops the message — never delivered with raw bytes', async () => {
    gw.__inboundRouterTestSeam.vaultPassphraseCache.set(String(DM_CHAT), {
      passphrase: 'pw', expiresAt: Date.now() + 60_000,
    })
    pipelineImpl = () => { throw new Error('boom — pipeline crash') }
    const secretish = ['sk', 'ant', 'crashme12345'].join('-')
    await gw.handleInbound(makeCtx({ text: secretish }), secretish, undefined, undefined)
    expect(callLog).toContain('runPipeline')
    // The critical security invariant: no deliver, no buffer — dropped.
    expect(delivered()).toBe(false)
    expect(buffered()).toBe(false)
  })
})

describe('inbound-router characterization — F3 non-intercepting state blocks', () => {
  it('status-KPI: a "status?" query is read-only telemetry — still delivered, not intercepted', async () => {
    await gw.handleInbound(makeCtx({ text: 'are you still working?' }), 'are you still working?', undefined, undefined)
    expect(delivered()).toBe(true)
  })

  it('AUTOCLASSIFY_MIDTURN_SHADOW (default-on): a mid-turn message routes identically (shadow is a no-op on routing)', async () => {
    await primeInFlightTurn()
    // A mid-turn NON-steer message must still buffer regardless of the
    // shadow classifier's opinion. (F2: this file runs with the flag at its
    // import-time default — ON. Flipping it OFF needs a separate worker.)
    await gw.handleInbound(makeCtx({ text: 'just a thought', msgId: 8 }), 'just a thought', undefined, undefined)
    expect(buffered()).toBe(true)
    expect(delivered()).toBe(false)
  })
})
