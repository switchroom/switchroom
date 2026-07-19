/**
 * P7 PR-11 — v2 intercept-chain smoke/parity suite (#2996).
 *
 * Runs the SAME harness fixtures as tests/inbound-router-characterization.test.ts
 * but with `SWITCHROOM_INBOUND_ROUTER_V2=1` set BEFORE the gateway import
 * (design F2: the flag is a module-level const captured at load — a flip
 * requires a separate vitest worker/file, exactly this one). The
 * characterization harness pins the legacy arm; this file pins the v2
 * consolidated chain (runPreTurnIntercepts / runPasteBackIntercepts) producing
 * the SAME observable effects for the load-bearing cases:
 *   - bare `stop` mid-turn halts (SIGINT) and never delivers
 *   - `stop` + attachment is content (no SIGINT)
 *   - `!`-interrupt fires SIGINT before the replacement body ships
 *   - permission-reply `y <id>` is consumed, never forwarded
 *   - a fresh turn still DELIVERS (F4 at-receipt snapshot — no self-block)
 *   - a genuinely mid-turn inbound still BUFFERS
 *   - the secret-detect fail-closed drop still drops
 *
 * Together with the characterization harness (the PR-11 parity oracle, F6)
 * this is the merge gate for the cutover: both arms green on every PR.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inboundCoalesceKey } from '../telegram-plugin/gateway/inbound-coalesce.js'

const SENDER = '111'
const DM_CHAT = 222

// ─── Env BEFORE import (F2) ─────────────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), 'inbound-router-v2-'))
writeFileSync(
  join(stateDir, 'access.json'),
  JSON.stringify({ allowFrom: [SENDER], pending: {}, groups: {} }),
)
process.env.TELEGRAM_STATE_DIR = stateDir
process.env.SWITCHROOM_AGENT_NAME = 'v2testagent'
process.env.SWITCHROOM_INBOUND_ROUTER_V2 = '1' // THE cutover flag — v2 arm

// ─── Deps-boundary spies (same boundary as the characterization harness) ─
const callLog: string[] = []
const dispatchCalls: { kinds: string[] }[] = []

vi.mock('../telegram-plugin/gateway/inbound-delivery-machine-dispatch.js', () => ({
  dispatchEffects: (effects: { kind: string }[], deps: any) => {
    const kinds = effects.map((e) => e.kind)
    callLog.push('dispatch:' + kinds.join(','))
    dispatchCalls.push({ kinds })
    deps?.onDeliverResult?.('k', true)
  },
}))

const sendAgentInterrupt = vi.fn(() => {
  callLog.push('sigint')
  return { ok: true }
})
vi.mock('../src/agents/tmux.js', () => ({
  sendAgentInterrupt,
  clearAgentComposer: vi.fn(() => ({ ok: true })),
}))

let pipelineImpl: (args: any) => any = () => ({ stored: [], rewritten_text: '', deferred: [] })
vi.mock('../telegram-plugin/secret-detect/pipeline.js', () => ({
  runPipeline: (args: any) => {
    callLog.push('runPipeline')
    return pipelineImpl(args)
  },
}))

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok":true,"result":{}}', { status: 200 })),
  )
})

let gw: typeof import('../telegram-plugin/gateway/gateway.js')
let router: typeof import('../telegram-plugin/gateway/inbound-router.js')
let shadow: typeof import('../telegram-plugin/gateway/inbound-delivery-machine-shadow.js')

beforeAll(async () => {
  gw = await import('../telegram-plugin/gateway/gateway.js')
  router = await import('../telegram-plugin/gateway/inbound-router.js')
  shadow = await import('../telegram-plugin/gateway/inbound-delivery-machine-shadow.js')
  gw.__inboundRouterTestSeam.setIpcServer({
    sendToAgent: () => { callLog.push('ipcSend'); return true },
    broadcast: () => {},
  } as any)
})

beforeEach(() => {
  callLog.length = 0
  dispatchCalls.length = 0
  sendAgentInterrupt.mockClear()
  pipelineImpl = () => ({ stored: [], rewritten_text: '', deferred: [] })
  shadow.__shadowResetForTests()
  shadow.shadowEmit({ kind: 'bridgeUp', at: Date.now() })
  gw.__inboundRouterTestSeam.activeStatusReactions.clear()
  gw.__inboundRouterTestSeam.activeTurnStartedAt.clear()
  gw.__inboundRouterTestSeam.vaultPassphraseCache.clear?.()
  gw.__inboundRouterTestSeam.inboundCoalescer.reset()
})

function makeCtx(opts: { text: string; msgId?: number }) {
  const message: any = {
    message_id: opts.msgId ?? 1,
    text: opts.text,
    date: Math.floor(Date.now() / 1000),
    chat: { id: DM_CHAT, type: 'private' },
  }
  return {
    from: { id: Number(SENDER), is_bot: false, first_name: 'T' },
    chat: { id: DM_CHAT, type: 'private' },
    message,
    reply: vi.fn(async () => ({})),
    replyWithRichMessage: vi.fn(async () => ({})),
    api: { sendMessage: vi.fn(async () => ({})), config: { use: () => {} } },
  } as any
}

async function primeInFlightTurn() {
  await gw.handleInbound(makeCtx({ text: 'first turn', msgId: 900 }), 'first turn', undefined, undefined)
  dispatchCalls.length = 0
  callLog.length = 0
}

const delivered = () => dispatchCalls.some((c) => c.kinds.includes('deliverToBridge'))
const buffered = () => dispatchCalls.some((c) => c.kinds.includes('bufferInbound'))

describe('v2 chain — flag sanity', () => {
  it('this worker runs with INBOUND_ROUTER_V2 = true (env captured at import)', () => {
    expect(router.INBOUND_ROUTER_V2).toBe(true)
  })
})

describe('v2 chain — pre-turn intercepts (segment 1)', () => {
  it('bare `stop` mid-turn fires SIGINT and does NOT deliver', async () => {
    await primeInFlightTurn()
    await gw.handleInboundCoalesced(makeCtx({ text: 'stop', msgId: 4 }), 'stop', undefined, undefined)
    expect(sendAgentInterrupt).toHaveBeenCalledTimes(1)
    expect(delivered()).toBe(false)
  })

  it('bare `stop` with an attachment is CONTENT, not a halt (no SIGINT)', async () => {
    const dl = vi.fn(async () => '/tmp/stopsign.jpg')
    await primeInFlightTurn()
    await gw.handleInboundCoalesced(makeCtx({ text: 'stop', msgId: 5 }), 'stop', dl, undefined)
    expect(sendAgentInterrupt).not.toHaveBeenCalled()
    const key = inboundCoalesceKey(String(DM_CHAT), undefined, SENDER)
    expect(gw.__inboundRouterTestSeam.inboundCoalescer.peek(key as string)?.count).toBe(1)
  })

  it('`!`-interrupt with body fires SIGINT before the replacement body ships', async () => {
    await primeInFlightTurn()
    await gw.handleInboundCoalesced(makeCtx({ text: '!stop and do X', msgId: 3 }), '!stop and do X', undefined, undefined)
    expect(sendAgentInterrupt).toHaveBeenCalledTimes(1)
    const sigintIdx = callLog.indexOf('sigint')
    const ipcSendIdx = callLog.indexOf('ipcSend')
    expect(sigintIdx).toBeGreaterThanOrEqual(0)
    expect(ipcSendIdx).toBeGreaterThanOrEqual(0)
    expect(sigintIdx).toBeLessThan(ipcSendIdx)
  })
})

describe('v2 chain — paste-back gauntlet (segment 2)', () => {
  it('permission-reply (`y <id>`) is intercepted — never delivered as a turn', async () => {
    await gw.handleInbound(makeCtx({ text: 'y abcde' }), 'y abcde', undefined, undefined)
    expect(delivered()).toBe(false)
    expect(buffered()).toBe(false)
  })
})

describe('v2 chain — F4 at-receipt snapshot unchanged', () => {
  it('fresh turn DELIVERS despite its own emit advancing the machine (no self-block)', async () => {
    await gw.handleInbound(makeCtx({ text: 'first ever' }), 'first ever', undefined, undefined)
    expect(delivered()).toBe(true)
    expect(buffered()).toBe(false)
  })

  it('genuinely mid-turn inbound BUFFERS', async () => {
    await primeInFlightTurn()
    await gw.handleInbound(makeCtx({ text: 'follow up', msgId: 2 }), 'follow up', undefined, undefined)
    expect(buffered()).toBe(true)
    expect(delivered()).toBe(false)
  })
})

describe('v2 chain — secret-detect fail-closed unchanged', () => {
  it('a pipeline throw drops the message (never delivered with raw bytes)', async () => {
    // Cache a passphrase so the pipeline path runs.
    gw.__inboundRouterTestSeam.vaultPassphraseCache.set(String(DM_CHAT), {
      passphrase: 'pp',
      expiresAt: Date.now() + 60_000,
    })
    pipelineImpl = () => {
      throw new Error('boom')
    }
    await gw.handleInbound(makeCtx({ text: 'sk-' + 'ant-fake-secret', msgId: 7 }), 'sk-' + 'ant-fake-secret', undefined, undefined)
    expect(delivered()).toBe(false)
    expect(buffered()).toBe(false)
  })
})
