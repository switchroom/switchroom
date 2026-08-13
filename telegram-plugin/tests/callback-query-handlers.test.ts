/**
 * Harness for the callback-query handler extraction (#2996 Phase 5,
 * remaining item 2).
 *
 * `createCallbackQueryHandlers` receives every gateway dep injected, so the
 * handler families run here against a fake bot / fake deps with the REAL
 * store factories (`createSweepableCardStore` / `createSweepableStore`) —
 * the same surfaces gateway.ts wires in. Covered routes:
 *
 *   - vrd:*  authorization + payload validation (vault recent-denials)
 *   - vra:*  approve/deny lifecycle: deny wake-up inbound, expired card,
 *            admin-only non-admin refusal, passphrase-capture queueing
 *   - vrs:*  discard wake-up, rename intercept (secret capture)
 *   - vd:*   deferred-secret cancel (kernel deny recorded) + unlock intercept
 *   - vg:*   grant-wizard step state machine (cancel / expired session)
 *            + pure helpers (parseGrantDuration, formatGrantExpiry, keyboards)
 *   - mmp:*  deny resolution + expired-card TTL enforcement at tap time
 *   - sp:*   authorization gate + malformed payload
 *   - op:*   dismiss finalize, restart happy-path, agent-name validation
 *   - auth:* refresh throttle + unknown-button dismissal (auth dashboard)
 *
 * Broker-touching paths (mint/list over the real UDS client) are exercised
 * only up to the seam where the handler would leave process state — the
 * assertions here pin the state transitions and card edits that precede any
 * broker call, which is exactly the behavior the extraction must not change.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Context } from 'grammy'
import {
  createCallbackQueryHandlers,
  type CallbackQueryHandlersDeps,
  type PendingVaultRequestAccess,
  type PendingVaultRequestSave,
  type PendingSecretRequest,
  type ArmedSecretCapture,
  type PendingMentalModelPropose,
  type DeferredSecret,
  type PendingVaultOp,
} from '../gateway/callback-query-handlers.js'
import { createSweepableCardStore } from '../gateway/approval-card-stores.js'
import { createSweepableStore } from '../gateway/pending-state-stores.js'
import { StagingMap } from '../secret-detect/staging.js'
import { InlineKeyboard } from 'grammy'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enqueueEvalCaseProposal } from '../../src/self-improve/eval-case-proposals.js'

// Mock the auth-broker client so the `auth:use:` swap path is observable
// (spy on setActive) without a live UDS broker. Only handleAuthDashboardCallback
// touches getAuthBrokerClient, so this is inert for every other family here.
//
// The spy is created *inside* the factory and re-exported as a test-only
// handle (`__setActiveSpy`) rather than closed over from a `vi.hoisted`
// binding: bun's vitest-compat layer implements `vi.mock`/`vi.fn` but NOT
// `vi.hoisted`, so a hoisted-closure mock throws `vi.hoisted is not a
// function` under `bun test` (CI's bun-test-run shard runs this whole dir).
// A single `setActive` instance is closed over and returned by every
// `getAuthBrokerClient()` call, so the handler and the tests observe the
// same spy.
vi.mock('../gateway/auth-broker-client.js', () => {
  const setActive = vi.fn(async () => ({ active: 'acct-b', fanned: ['a1'] }))
  return {
    getAuthBrokerClient: vi.fn(async () => ({ setActive })),
  }
})
import { getAuthBrokerClient } from '../gateway/auth-broker-client.js'
// The mocked getAuthBrokerClient closes over one shared `setActive` spy and
// returns it on every call, so resolving the client here yields the SAME spy
// the handler observes. A getter defers the read to test-run time (after the
// mock is live under both runners); a beforeEach caches the resolved spy.
let resolvedSetActiveSpy: ReturnType<typeof vi.fn> | undefined
const brokerMock = {
  get setActive(): ReturnType<typeof vi.fn> {
    if (!resolvedSetActiveSpy) throw new Error('setActive spy not resolved yet')
    return resolvedSetActiveSpy
  },
}
beforeEach(async () => {
  const client = (await getAuthBrokerClient('test-agent')) as {
    setActive: ReturnType<typeof vi.fn>
  }
  resolvedSetActiveSpy = client.setActive
})

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakeCtxOpts {
  data?: string
  senderId?: string
  chatId?: string
  messageId?: number
  messageText?: string
  threadId?: number
  username?: string
}

function makeCtx(opts: FakeCtxOpts = {}) {
  const {
    data = '',
    senderId = '111',
    chatId = '111',
    messageId = 42,
    messageText = 'card body',
    threadId,
    username = 'op',
  } = opts
  const calls: Record<string, unknown[][]> = {
    answerCallbackQuery: [],
    editMessageText: [],
    editMessageReplyMarkup: [],
    apiEditMessageText: [],
    replyWithRichMessage: [],
    reply: [],
  }
  const ctx = {
    from: { id: Number(senderId), username, first_name: username },
    chat: { id: Number(chatId) },
    callbackQuery: {
      data,
      message: {
        message_id: messageId,
        chat: { id: Number(chatId) },
        text: messageText,
        ...(threadId != null ? { message_thread_id: threadId } : {}),
      },
    },
    answerCallbackQuery: vi.fn(async (...a: unknown[]) => {
      calls.answerCallbackQuery.push(a)
      return true
    }),
    editMessageText: vi.fn(async (...a: unknown[]) => {
      calls.editMessageText.push(a)
      return true
    }),
    editMessageReplyMarkup: vi.fn(async (...a: unknown[]) => {
      calls.editMessageReplyMarkup.push(a)
      return true
    }),
    replyWithRichMessage: vi.fn(async (...a: unknown[]) => {
      calls.replyWithRichMessage.push(a)
      return { message_id: 900 }
    }),
    api: {
      editMessageText: vi.fn(async (...a: unknown[]) => {
        calls.apiEditMessageText.push(a)
        return true
      }),
      sendRichMessage: vi.fn(async () => ({ message_id: 901 })),
    },
  }
  return { ctx: ctx as unknown as Context, raw: ctx, calls }
}

function makeDeps(overrides: Partial<CallbackQueryHandlersDeps> = {}) {
  const injected: Array<{ agent: string; text: string }> = []
  const fakeBot = {
    api: {
      editMessageText: vi.fn(async () => true),
      sendRichMessage: vi.fn(async () => ({ message_id: 902 })),
    },
  }
  const deps: CallbackQueryHandlersDeps = {
    bot: fakeBot,
    lockedBot: fakeBot,
    loadAccess: () => ({ allowFrom: ['111', '222'] }),
    escapeHtmlForTg: (t) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    switchroomReply: vi.fn(async () => undefined),
    resolveThreadId: (_chatId, explicit) =>
      explicit == null ? undefined : Number(explicit),
    deliverResumeSyntheticOrBuffer: vi.fn((agent: string, inbound: { text: string }) => {
      injected.push({ agent, text: inbound.text })
      return true
    }) as unknown as CallbackQueryHandlersDeps['deliverResumeSyntheticOrBuffer'],
    expireMentalModelProposeCard: vi.fn(),
    readLiveSwitchroomConfigText: () => 'agents: {}\n',
    mentalModelCorrelationKey: (a, d) => `${a}::${d.length}`,
    getMyAgentName: () => 'test-agent',
    triggerSelfRestart: vi.fn(() => true),
    runSwitchroomAuthCommand: vi.fn(async () => undefined),
    switchroomExecJson: <T,>(_args: string[]): T | null => null,
    assertSafeAgentName: (name: string) => {
      if (!/^[a-z][a-z0-9-]{0,62}$/i.test(name)) throw new Error('unsafe agent name')
    },
    buildDeferredSecretKeyboard: () => new InlineKeyboard().text('x', 'vd:unlock:k'),
    recordDeferredSecretKernelDecision: vi.fn(async () => undefined),
    mintGrantWizardKernelRequest: vi.fn(async () => null),
    recordGrantWizardKernelDecision: vi.fn(async () => undefined),
    robustApiCall: (fn) => fn(),
    swallowingApiCall: async (fn) => {
      try {
        return await fn()
      } catch {
        return undefined
      }
    },
    pendingVaultRequestAccesses: createSweepableCardStore<PendingVaultRequestAccess>({
      isExpired: () => false,
      expire: () => () => {},
      log: () => () => {},
    }),
    pendingVaultRequestSaves: createSweepableCardStore<PendingVaultRequestSave>({
      isExpired: () => false,
      expire: () => () => {},
      log: () => () => {},
    }),
    pendingSecretRequests: createSweepableCardStore<PendingSecretRequest>({
      isExpired: () => false,
      expire: () => () => {},
      log: () => () => {},
    }),
    armedSecretCaptures: createSweepableStore<ArmedSecretCapture>(() => false),
    pendingMentalModelProposes: createSweepableCardStore<PendingMentalModelPropose>({
      isExpired: () => false,
      expire: () => () => {},
      log: () => () => {},
    }),
    pendingCardStore: { remove: vi.fn() },
    pendingMentalModelCorrelations: createSweepableStore(() => false),
    pendingVaultOps: createSweepableStore<PendingVaultOp>(() => false),
    vaultPassphraseCache: createSweepableStore(() => false),
    deferredSecrets: createSweepableStore<DeferredSecret>(() => false),
    pendingReauthFlows: createSweepableStore(() => false),
    secretStaging: new StagingMap(),
    lastAuthRefreshAtMs: new Map<string, number>(),
    getVaultApprovalAuthMode: () => 'passphrase',
    getAdminOnlyKeys: () => [],
    vaultKeyRegex: /^[A-Za-z0-9_./-]{1,200}$/,
    mentalModelProposeTtlMs: 60 * 60 * 1000,
    ...overrides,
  }
  return { deps, injected, fakeBot }
}

function stagedAccess(over: Partial<PendingVaultRequestAccess> = {}): PendingVaultRequestAccess {
  return {
    agent: 'worker',
    chat_id: '111',
    card_message_id: 42,
    key: 'github/token',
    scope: 'read',
    ttl_seconds: 30 * 24 * 60 * 60,
    staged_at: Date.now(),
    ...over,
  }
}

// ── vrd:* — recent-denials one-tap allow ────────────────────────────────

describe('handleVaultRecentDenialCallback', () => {
  it('refuses a sender not on allowFrom', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx({ senderId: '999', data: 'vrd:worker:github/token' })
    await h.handleVaultRecentDenialCallback(ctx, 'vrd:worker:github/token')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
  })

  it('rejects a malformed payload before any broker work', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultRecentDenialCallback(ctx, 'vrd:only-two-parts')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Bad request' })
  })

  it('rejects an invalid agent slug', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultRecentDenialCallback(ctx, 'vrd:__bad:key')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Invalid agent name' })
  })
})

// ── vra:* — vault_request_access approve/deny ───────────────────────────

describe('handleVaultRequestAccessCallback', () => {
  it('edits an expired/unknown stage card and stops', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultRequestAccessCallback(ctx, 'vra:approve:nope')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Card expired — ask the agent to re-request.',
    })
    expect(raw.api.editMessageText).toHaveBeenCalled()
  })

  it('deny: drops the stage, edits the card, wakes the agent with a denied inbound', async () => {
    const { deps, injected } = makeDeps()
    deps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultRequestAccessCallback(ctx, 'vra:deny:s1')
    expect(deps.pendingVaultRequestAccesses.has('s1')).toBe(false)
    expect(deps.pendingCardStore.remove).toHaveBeenCalledWith('s1')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: '🚫 Denied' })
    expect(raw.api.editMessageText).toHaveBeenCalled()
    expect(injected).toHaveLength(1)
    expect(injected[0]!.agent).toBe('worker')
    expect(injected[0]!.text).toContain('github/token')
  })

  it('approve on an admin-only key from a non-admin allowFrom member is refused (card intact)', async () => {
    const { deps } = makeDeps({ getAdminOnlyKeys: () => ['github/token'] })
    deps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    const h = createCallbackQueryHandlers(deps)
    // 222 is on allowFrom but is not allowFrom[0].
    const { ctx, raw } = makeCtx({ senderId: '222' })
    await h.handleVaultRequestAccessCallback(ctx, 'vra:approve:s1')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: '🔒 Admin-only credential — only the owner can approve this.',
    })
    // Stage must survive so the admin can still approve.
    expect(deps.pendingVaultRequestAccesses.has('s1')).toBe(true)
  })

  it('approve without a cached passphrase queues a passphrase-for-access-approve intercept', async () => {
    const { deps, fakeBot } = makeDeps()
    deps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    const h = createCallbackQueryHandlers(deps)
    const { ctx } = makeCtx()
    await h.handleVaultRequestAccessCallback(ctx, 'vra:approve:s1')
    const op = deps.pendingVaultOps.get('111')
    expect(op?.kind).toBe('passphrase-for-access-approve')
    if (op?.kind === 'passphrase-for-access-approve') {
      expect(op.items).toEqual([
        { stageId: 's1', cardChatId: '111', cardMessageId: 42, senderId: '111' },
      ])
    }
    // A fresh passphrase prompt goes out via the locked bot.
    expect(fakeBot.api.sendRichMessage).toHaveBeenCalled()
  })

  it('a second approve tap joins the existing passphrase queue instead of overwriting it', async () => {
    const { deps } = makeDeps()
    deps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    deps.pendingVaultRequestAccesses.set('s2', stagedAccess({ key: 'coolify/api-token', card_message_id: 43 }))
    const h = createCallbackQueryHandlers(deps)
    await h.handleVaultRequestAccessCallback(makeCtx().ctx, 'vra:approve:s1')
    await h.handleVaultRequestAccessCallback(makeCtx({ messageId: 43 }).ctx, 'vra:approve:s2')
    const op = deps.pendingVaultOps.get('111')
    expect(op?.kind).toBe('passphrase-for-access-approve')
    if (op?.kind === 'passphrase-for-access-approve') {
      expect(op.items.map((i) => i.stageId)).toEqual(['s1', 's2'])
    }
  })
})

// ── vrs:* — vault_request_save (secret capture) ─────────────────────────

function stagedSave(over: Partial<PendingVaultRequestSave> = {}): PendingVaultRequestSave {
  return {
    agent: 'worker',
    chat_id: '111',
    card_message_id: 42,
    key: 'github/token',
    kind: 'string',
    value: 'sk-' + 'fake-value',
    staged_at: Date.now(),
    ...over,
  }
}

describe('handleVaultRequestSaveCallback', () => {
  it('discard: drops the stage, edits the card, wakes the agent', async () => {
    const { deps, injected } = makeDeps()
    deps.pendingVaultRequestSaves.set('s1', stagedSave())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultRequestSaveCallback(ctx, 'vrs:discard:s1')
    expect(deps.pendingVaultRequestSaves.has('s1')).toBe(false)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: '🚫 Discarded' })
    expect(injected).toHaveLength(1)
    expect(injected[0]!.text).toContain('github/token')
  })

  it('rename: registers the rename-vault-save intercept and finalizes the card', async () => {
    const { deps } = makeDeps()
    deps.pendingVaultRequestSaves.set('s1', stagedSave())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultRequestSaveCallback(ctx, 'vrs:rename:s1')
    const op = deps.pendingVaultOps.get('111')
    expect(op?.kind).toBe('rename-vault-save')
    if (op?.kind === 'rename-vault-save') expect(op.stageId).toBe('s1')
    // finalizeCallback path: ack toast + atomic edit.
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Send the new key name as your next message.',
    })
    expect(raw.editMessageText).toHaveBeenCalled()
  })

  it('save on a restart-restored card (value lost) degrades gracefully and wakes the agent', async () => {
    const { deps, injected } = makeDeps()
    deps.pendingVaultRequestSaves.set('s1', stagedSave({ restoredWithoutValue: true, value: '' }))
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultRequestSaveCallback(ctx, 'vrs:save:s1')
    expect(deps.pendingVaultRequestSaves.has('s1')).toBe(false)
    expect(raw.api.editMessageText).toHaveBeenCalled()
    expect(injected).toHaveLength(1)
    expect(injected[0]!.text.toLowerCase()).toContain('github/token')
  })
})

// ── vd:* — deferred-secret capture ──────────────────────────────────────

function deferred(over: Partial<DeferredSecret> = {}): DeferredSecret {
  return {
    chat_id: '111',
    original_message_id: 7,
    text: 'hunter2-secret',
    staged_at: Date.now(),
    suggested_slug: 'my_secret',
    kernel_request_id: 'kr_1',
    ...over,
  }
}

describe('handleVaultDeferCallback', () => {
  it('cancel: records the kernel deny, drops the secret, strips the card', async () => {
    const { deps } = makeDeps()
    deps.deferredSecrets.set('111:7', deferred())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultDeferCallback(ctx, 'vd:cancel:111:7')
    expect(deps.recordDeferredSecretKernelDecision).toHaveBeenCalledWith(
      'kr_1',
      'deny',
      111,
      ['111', '222'],
    )
    expect(deps.deferredSecrets.has('111:7')).toBe(false)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Discarded.' })
  })

  it('unlock without a cached passphrase registers the passphrase-for-deferred intercept', async () => {
    const { deps } = makeDeps()
    deps.deferredSecrets.set('111:7', deferred())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultDeferCallback(ctx, 'vd:unlock:111:7')
    expect(deps.recordDeferredSecretKernelDecision).toHaveBeenCalledWith(
      'kr_1',
      'allow_once',
      111,
      ['111', '222'],
    )
    const op = deps.pendingVaultOps.get('111')
    expect(op?.kind).toBe('passphrase-for-deferred')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Send your passphrase…' })
  })

  it('expired card: toast + keyboard strip, no state change', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultDeferCallback(ctx, 'vd:unlock:111:7')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'This card expired. Re-send the secret.',
    })
    expect(raw.editMessageReplyMarkup).toHaveBeenCalled()
  })
})

// ── vsp:* — request_secret (agent asks operator to PROVIDE a secret) ─────

function stagedSecretRequest(over: Partial<PendingSecretRequest> = {}): PendingSecretRequest {
  return {
    agent: 'worker',
    chat_id: '111',
    card_message_id: 42,
    key: 'openai/api_key',
    reason: 'need it to call the API',
    staged_at: Date.now(),
    ...over,
  }
}

describe('handleSecretRequestCallback', () => {
  it('refuses a sender not on allowFrom (never touches state)', async () => {
    const { deps } = makeDeps()
    deps.pendingSecretRequests.set('s1', stagedSecretRequest())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx({ senderId: '999' })
    await h.handleSecretRequestCallback(ctx, 'vsp:provide:s1')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    // Auth gate runs before any capture is armed.
    expect(deps.armedSecretCaptures.has('111')).toBe(false)
  })

  // Race pin (#2996 P5 mandate — verdict-during-expiry): a tap that lands after
  // the card's TTL sweep already dropped the pending request must degrade to
  // the expired toast, NOT arm a capture or wake the agent.
  it('a tap on an already-expired/unknown stage toasts "This request expired." and changes nothing', async () => {
    const { deps, injected } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleSecretRequestCallback(ctx, 'vsp:provide:gone')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'This request expired.' })
    expect(deps.armedSecretCaptures.has('111')).toBe(false)
    expect(injected).toHaveLength(0)
  })

  it('provide: arms the capture keyed by chat_id and swaps the card to the send-now prompt', async () => {
    const { deps } = makeDeps()
    deps.pendingSecretRequests.set('s1', stagedSecretRequest({ threadId: 7 }))
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleSecretRequestCallback(ctx, 'vsp:provide:s1')
    const armed = deps.armedSecretCaptures.get('111')
    expect(armed?.key).toBe('openai/api_key')
    expect(armed?.stageId).toBe('s1')
    expect(armed?.threadId).toBe(7)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Send the value now — it auto-deletes.',
    })
    // Card edited to the "send the value" prompt with the keyboard stripped.
    expect(raw.api.editMessageText).toHaveBeenCalled()
    // The pending request survives until the value actually arrives.
    expect(deps.pendingSecretRequests.has('s1')).toBe(true)
  })

  it('decline: drops the stage, clears any armed capture, edits the card, wakes the agent', async () => {
    const { deps, injected } = makeDeps()
    deps.pendingSecretRequests.set('s1', stagedSecretRequest())
    deps.armedSecretCaptures.set('111', {
      key: 'openai/api_key',
      agent: 'worker',
      stageId: 's1',
      armed_at: Date.now(),
    })
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleSecretRequestCallback(ctx, 'vsp:decline:s1')
    expect(deps.pendingSecretRequests.has('s1')).toBe(false)
    expect(deps.pendingCardStore.remove).toHaveBeenCalledWith('s1')
    expect(deps.armedSecretCaptures.has('111')).toBe(false)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Declined.' })
    expect(raw.api.editMessageText).toHaveBeenCalled()
    expect(injected).toHaveLength(1)
    expect(injected[0]!.agent).toBe('worker')
    expect(injected[0]!.text).toContain('openai/api_key')
  })

  it('an unknown action just acknowledges without mutating state', async () => {
    const { deps, injected } = makeDeps()
    deps.pendingSecretRequests.set('s1', stagedSecretRequest())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleSecretRequestCallback(ctx, 'vsp:bogus:s1')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith()
    expect(deps.pendingSecretRequests.has('s1')).toBe(true)
    expect(injected).toHaveLength(0)
  })
})

// ── mmp:* — mental-model proposal ───────────────────────────────────────

function stagedPropose(over: Partial<PendingMentalModelPropose> = {}): PendingMentalModelPropose {
  return {
    agent: 'worker',
    chat_id: '111',
    card_message_id: 42,
    spec: { name: 'user-goals', source_query: 'what does the user want' },
    staged_at: Date.now(),
    ...over,
  }
}

describe('handleMentalModelProposeCallback', () => {
  it('deny: resolves the proposal, edits the card, wakes the agent', async () => {
    const { deps, injected } = makeDeps()
    deps.pendingMentalModelProposes.set('m1', stagedPropose())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleMentalModelProposeCallback(ctx, 'mmp:deny:m1')
    expect(deps.pendingMentalModelProposes.has('m1')).toBe(false)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: '🚫 Denied' })
    expect(raw.api.editMessageText).toHaveBeenCalled()
    expect(injected.length).toBeGreaterThan(0)
  })

  it('a tap past the TTL routes through the shared expiry path instead of resolving', async () => {
    const { deps } = makeDeps({ mentalModelProposeTtlMs: 1000 })
    const stale = stagedPropose({ staged_at: Date.now() - 10_000 })
    deps.pendingMentalModelProposes.set('m1', stale)
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleMentalModelProposeCallback(ctx, 'mmp:approve:m1')
    expect(deps.expireMentalModelProposeCard).toHaveBeenCalledWith('m1', stale, expect.any(Number))
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Card expired — the agent was notified.',
    })
  })

  it('refuses a non-allowlisted tapper (agent self-approve is impossible)', async () => {
    const { deps } = makeDeps()
    deps.pendingMentalModelProposes.set('m1', stagedPropose())
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx({ senderId: '999' })
    await h.handleMentalModelProposeCallback(ctx, 'mmp:approve:m1')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    expect(deps.pendingMentalModelProposes.has('m1')).toBe(true)
  })
})

// ── sp:* — skill proposal ───────────────────────────────────────────────

describe('handleSkillProposalCallback', () => {
  it('refuses a non-allowlisted tapper', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx({ senderId: '999' })
    await h.handleSkillProposalCallback(ctx, 'sp:approve:p1')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
  })

  it('rejects a malformed payload', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleSkillProposalCallback(ctx, 'sp:bogus')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Bad request' })
  })
})

// ── evcase:* — eval-case proposal ───────────────────────────────────────
//
// The defect these pin: this handler was a copy of the skill handler that
// dropped the `deliverResumeSyntheticOrBuffer` call, so BOTH exits — dismiss
// and approve — edited the card and returned without telling the proposing
// agent anything. The agent had been steered to end its turn and wait for a
// wake-up that no code path sent. On unmodified code every assertion below on
// `deliverResumeSyntheticOrBuffer` fails with 0 calls.
//
// `handleEvalCaseProposalCallback` reads the proposal store off disk (not from
// an injected store), so these drive a REAL tmp state dir via the real
// `enqueueEvalCaseProposal`. `TELEGRAM_STATE_DIR` is NOT one of
// `agent-state-dir-guard`'s GUARDED_STATE_DIR_VARS, so the guard neither
// redirects nor blocks it — setting it here is the whole isolation.

describe('handleEvalCaseProposalCallback', () => {
  let stateDir: string
  let prevStateDir: string | undefined
  let prevAgent: string | undefined

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'evcase-cb-'))
    prevStateDir = process.env.TELEGRAM_STATE_DIR
    prevAgent = process.env.SWITCHROOM_AGENT_NAME
    process.env.TELEGRAM_STATE_DIR = stateDir
    process.env.SWITCHROOM_AGENT_NAME = 'test-agent'
  })

  afterEach(() => {
    if (prevStateDir == null) delete process.env.TELEGRAM_STATE_DIR
    else process.env.TELEGRAM_STATE_DIR = prevStateDir
    if (prevAgent == null) delete process.env.SWITCHROOM_AGENT_NAME
    else process.env.SWITCHROOM_AGENT_NAME = prevAgent
    rmSync(stateDir, { recursive: true, force: true })
  })

  function seedProposal(over: { heldOut?: boolean } = {}) {
    return enqueueEvalCaseProposal(stateDir, {
      skill_slug: 'deploy-checklist',
      skill_dir: join(stateDir, 'skills', 'deploy-checklist'),
      case: { prompt: 'the correction, as an input' },
      fingerprint: 'fp-1',
      held_out: over.heldOut === true,
    })
  }

  it('dismiss wakes the agent with an eval_case_rejected inbound', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const p = seedProposal()
    const { ctx } = makeCtx()
    await h.handleEvalCaseProposalCallback(ctx, `evcase:deny:${p.id}`)
    expect(deps.deliverResumeSyntheticOrBuffer).toHaveBeenCalledWith(
      'test-agent',
      expect.objectContaining({
        meta: expect.objectContaining({
          source: 'eval_case_rejected',
          proposal_id: p.id,
          skill_slug: 'deploy-checklist',
        }),
      }),
    )
  })

  it('approve with a successful applier wakes the agent with eval_case_applied', async () => {
    const runEvalCaseApply = vi.fn(() => ({ ok: true, out: 'added 1 case' }))
    const { deps } = makeDeps({ runEvalCaseApply })
    const h = createCallbackQueryHandlers(deps)
    const p = seedProposal()
    const { ctx } = makeCtx()
    await h.handleEvalCaseProposalCallback(ctx, `evcase:approve:${p.id}`)
    expect(runEvalCaseApply).toHaveBeenCalledWith(p.id)
    expect(deps.deliverResumeSyntheticOrBuffer).toHaveBeenCalledWith(
      'test-agent',
      expect.objectContaining({
        meta: expect.objectContaining({ source: 'eval_case_applied', proposal_id: p.id }),
      }),
    )
  })

  it('approve with a failing applier wakes the agent with eval_case_apply_failed + the output', async () => {
    const runEvalCaseApply = vi.fn(() => ({ ok: false, out: 'ENOENT: skill dir missing' }))
    const { deps, injected } = makeDeps({ runEvalCaseApply })
    const h = createCallbackQueryHandlers(deps)
    const p = seedProposal()
    const { ctx } = makeCtx()
    await h.handleEvalCaseProposalCallback(ctx, `evcase:approve:${p.id}`)
    expect(deps.deliverResumeSyntheticOrBuffer).toHaveBeenCalledWith(
      'test-agent',
      expect.objectContaining({
        meta: expect.objectContaining({ source: 'eval_case_apply_failed', proposal_id: p.id }),
      }),
    )
    // The applier's own diagnosis reaches the agent, not just "it failed".
    expect(injected[0]?.text).toContain('ENOENT: skill dir missing')
  })

  it('carries the card’s forum topic into the outcome inbound', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const p = seedProposal()
    const { ctx } = makeCtx({ threadId: 7 })
    await h.handleEvalCaseProposalCallback(ctx, `evcase:deny:${p.id}`)
    expect(deps.deliverResumeSyntheticOrBuffer).toHaveBeenCalledWith(
      'test-agent',
      expect.objectContaining({
        threadId: 7,
        meta: expect.objectContaining({ message_thread_id: '7' }),
      }),
    )
  })

  it('a second tap injects nothing — the non-pending guard runs before every injection', async () => {
    const runEvalCaseApply = vi.fn(() => ({ ok: true, out: '' }))
    const { deps } = makeDeps({ runEvalCaseApply })
    const h = createCallbackQueryHandlers(deps)
    const p = seedProposal()
    const { ctx } = makeCtx()
    await h.handleEvalCaseProposalCallback(ctx, `evcase:approve:${p.id}`)
    await h.handleEvalCaseProposalCallback(ctx, `evcase:approve:${p.id}`)
    await h.handleEvalCaseProposalCallback(ctx, `evcase:deny:${p.id}`)
    expect(deps.deliverResumeSyntheticOrBuffer).toHaveBeenCalledTimes(1)
    expect(runEvalCaseApply).toHaveBeenCalledTimes(1)
  })

  it('a non-allowlisted tapper neither applies nor wakes the agent', async () => {
    const runEvalCaseApply = vi.fn(() => ({ ok: true, out: '' }))
    const { deps } = makeDeps({ runEvalCaseApply })
    const h = createCallbackQueryHandlers(deps)
    const p = seedProposal()
    const { ctx, raw } = makeCtx({ senderId: '999' })
    await h.handleEvalCaseProposalCallback(ctx, `evcase:approve:${p.id}`)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    expect(runEvalCaseApply).not.toHaveBeenCalled()
    expect(deps.deliverResumeSyntheticOrBuffer).not.toHaveBeenCalled()
  })
})

// ── op:* — operator-event card actions ──────────────────────────────────

describe('handleOperatorEventCallback', () => {
  it('dismiss finalizes the card with a status line', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx({ messageText: 'agent worker crashed' })
    await h.handleOperatorEventCallback(ctx, 'op:dismiss:worker')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Dismissed' })
    const edit = raw.editMessageText.mock.calls[0]!
    expect(JSON.stringify(edit[0])).toContain('Dismissed by operator')
  })

  it('restart triggers the restart and finalizes on success', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleOperatorEventCallback(ctx, 'op:restart:worker')
    expect(deps.triggerSelfRestart).toHaveBeenCalledWith('worker', 'inline-button-restart')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Restarting worker…' })
  })

  it('rejects an invalid agent name', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleOperatorEventCallback(ctx, `op:restart:${encodeURIComponent('../etc')}`)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Invalid agent name.' })
    expect(deps.triggerSelfRestart).not.toHaveBeenCalled()
  })

  it('reauth finalizes the card and seeds pendingReauthFlows via synthInbound', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx } = makeCtx({ threadId: 5 })
    await h.handleOperatorEventCallback(ctx, 'op:reauth:worker')
    expect(deps.runSwitchroomAuthCommand).toHaveBeenCalledWith(
      expect.anything(),
      ['auth', 'reauth', 'worker'],
      'auth reauth worker',
    )
    const flow = deps.pendingReauthFlows.get('111:5')
    expect(flow?.agent).toBe('worker')
  })
})

// ── auth:* — auth dashboard ─────────────────────────────────────────────

describe('handleAuthDashboardCallback', () => {
  it('unknown auth:* buttons are dismissed with a /auth hint', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx({ data: 'auth:whatever' })
    await h.handleAuthDashboardCallback(ctx)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Unknown auth button. Send /auth for current state.',
      show_alert: false,
    })
  })

  it('auth:refresh inside the throttle window toasts instead of re-probing', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    deps.lastAuthRefreshAtMs.set('111:42', Date.now())
    const { ctx, raw } = makeCtx({ data: 'auth:refresh' })
    await h.handleAuthDashboardCallback(ctx)
    const toast = raw.answerCallbackQuery.mock.calls[0]![0] as { text: string }
    expect(toast.text).toMatch(/Just refreshed — try again in \d+s/)
  })

  it('auth:use with a missing label toasts and stops', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx({ data: 'auth:use:' })
    await h.handleAuthDashboardCallback(ctx)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({
      text: 'Missing account label.',
      show_alert: false,
    })
  })

  // Security gate (found in an adversarial security review): the auth: family
  // is a mutating callback family (auth:use:<label> → broker.setActive, a
  // fleet-wide OAuth account swap) and MUST enforce the same allowFrom gate as
  // every sibling family. Without the gate, any tapper on an admin forum/
  // supergroup with an empty group allowFrom could swap the active account.
  it('rejects an auth:use swap from a sender not on allowFrom (never reaches setActive)', async () => {
    const { deps } = makeDeps() // allowFrom = ['111','222']
    const h = createCallbackQueryHandlers(deps)
    brokerMock.setActive.mockClear()
    const { ctx, raw } = makeCtx({ senderId: '999', data: 'auth:use:acct-b' })
    await h.handleAuthDashboardCallback(ctx)
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    // The load-bearing assertion: the swap must not fire for an unauthorized tap.
    expect(brokerMock.setActive).not.toHaveBeenCalled()
  })

  it('lets an allowFrom sender through to the setActive swap path', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    brokerMock.setActive.mockClear()
    const { ctx, raw } = makeCtx({ senderId: '111', data: 'auth:use:acct-b' })
    await h.handleAuthDashboardCallback(ctx)
    expect(brokerMock.setActive).toHaveBeenCalledWith('acct-b')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Switched fleet → acct-b') }),
    )
  })
})

// ── vg:* — grant wizard + management ────────────────────────────────────

describe('grant wizard', () => {
  it('parseGrantDuration parses d/h and rejects junk', () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    expect(h.parseGrantDuration('30d')).toBe(30 * 86400)
    expect(h.parseGrantDuration('12h')).toBe(12 * 3600)
    expect(h.parseGrantDuration('0d')).toBeNull()
    expect(h.parseGrantDuration('soon')).toBeNull()
  })

  it('formatGrantExpiry renders Never and an ISO date', () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    expect(h.formatGrantExpiry(null)).toBe('Never')
    const now = new Date('2026-07-11T00:00:00Z')
    expect(h.formatGrantExpiry(86400, now)).toBe('2026-07-12')
  })

  it('keyboards carry the vg:* callback data contract', () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const kb = h.buildGrantKeysKeyboard(['a', 'b'], new Set(['b']))
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>
    expect(flat.map((b) => b.callback_data)).toEqual([
      'vg:key:a',
      'vg:key:b',
      'vg:keys-continue',
      'vg:cancel',
    ])
    expect(flat[0]!.text).toBe('☐ a')
    expect(flat[1]!.text).toBe('☑ b')
  })

  it('vg:cancel clears the wizard state and records the kernel deny when confirm was reached', async () => {
    const { deps } = makeDeps()
    deps.pendingVaultOps.set('111', {
      kind: 'grant-wizard',
      step: 'confirm',
      agent: 'worker',
      selectedKeys: ['k'],
      kernel_request_id: 'kr_9',
      startedAt: Date.now(),
    })
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultGrantCallback(ctx, 'vg:cancel')
    expect(deps.recordGrantWizardKernelDecision).toHaveBeenCalledWith('kr_9', 'deny', 111, [
      '111',
      '222',
    ])
    expect(deps.pendingVaultOps.has('111')).toBe(false)
    expect(raw.editMessageText).toHaveBeenCalledWith('❌ Grant wizard cancelled.')
  })

  it('a wizard tap with no session edits to the expired notice', async () => {
    const { deps } = makeDeps()
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultGrantCallback(ctx, 'vg:keys-continue')
    expect(raw.editMessageText).toHaveBeenCalledWith(
      '⚠️ Wizard session expired. Run /vault grant to start again.',
    )
  })

  it('vg:key toggles selection and re-renders the keyboard', async () => {
    const { deps } = makeDeps()
    deps.pendingVaultOps.set('111', {
      kind: 'grant-wizard',
      step: 'keys',
      agent: 'worker',
      selectedKeys: [],
      availableKeys: ['a', 'b'],
      wizardMsgId: 42,
      startedAt: Date.now(),
    })
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultGrantCallback(ctx, 'vg:key:a')
    const st = deps.pendingVaultOps.get('111')
    expect(st?.kind).toBe('grant-wizard')
    if (st?.kind === 'grant-wizard') expect(st.selectedKeys).toEqual(['a'])
    expect(raw.editMessageReplyMarkup).toHaveBeenCalled()
  })

  it('vg:keys-continue with nothing selected toasts instead of advancing', async () => {
    const { deps } = makeDeps()
    deps.pendingVaultOps.set('111', {
      kind: 'grant-wizard',
      step: 'keys',
      agent: 'worker',
      selectedKeys: [],
      availableKeys: ['a'],
      wizardMsgId: 42,
      startedAt: Date.now(),
    })
    const h = createCallbackQueryHandlers(deps)
    const { ctx, raw } = makeCtx()
    await h.handleVaultGrantCallback(ctx, 'vg:keys-continue')
    expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Select at least one key.' })
    const st = deps.pendingVaultOps.get('111')
    if (st?.kind === 'grant-wizard') expect(st.step).toBe('keys')
  })
})

// ── Cross-cutting: every mutating family enforces the allowFrom gate ────

describe('authorization gate parity', () => {
  const routes: Array<[string, (h: ReturnType<typeof createCallbackQueryHandlers>, ctx: Context) => Promise<void>]> = [
    ['vrd', (h, ctx) => h.handleVaultRecentDenialCallback(ctx, 'vrd:worker:k')],
    ['vra', (h, ctx) => h.handleVaultRequestAccessCallback(ctx, 'vra:approve:s1')],
    ['vrs', (h, ctx) => h.handleVaultRequestSaveCallback(ctx, 'vrs:save:s1')],
    ['vsp', (h, ctx) => h.handleSecretRequestCallback(ctx, 'vsp:provide:s1')],
    ['vd', (h, ctx) => h.handleVaultDeferCallback(ctx, 'vd:unlock:111:7')],
    ['vg', (h, ctx) => h.handleVaultGrantCallback(ctx, 'vg:cancel')],
    ['mmp', (h, ctx) => h.handleMentalModelProposeCallback(ctx, 'mmp:approve:m1')],
    ['sp', (h, ctx) => h.handleSkillProposalCallback(ctx, 'sp:approve:p1')],
    ['op', (h, ctx) => h.handleOperatorEventCallback(ctx, 'op:dismiss:worker')],
  ]
  for (const [name, run] of routes) {
    it(`${name}:* refuses a non-allowlisted sender`, async () => {
      const { deps } = makeDeps()
      const h = createCallbackQueryHandlers(deps)
      const { ctx, raw } = makeCtx({ senderId: '999' })
      await run(h, ctx)
      expect(raw.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Not authorized.' })
    })
  }
})
