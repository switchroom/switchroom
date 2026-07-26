import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'grammy'
import { InlineKeyboard } from 'grammy'
import {
  createCallbackQueryHandlers,
  isPassphraseMismatchBrokerError,
  buildAccessPassphrasePromptText,
  MAX_VAULT_PASSPHRASE_ATTEMPTS,
  type CallbackQueryHandlersDeps,
  type PendingVaultRequestAccess,
  type PendingVaultRequestSave,
  type PendingSecretRequest,
  type ArmedSecretCapture,
  type PendingMentalModelPropose,
  type DeferredSecret,
  type PendingVaultOp,
} from '../gateway/callback-query-handlers.js'
import { interceptVault, type InboundInterceptorDeps } from '../gateway/inbound-interceptors.js'
import { createSweepableCardStore } from '../gateway/approval-card-stores.js'
import { createSweepableStore } from '../gateway/pending-state-stores.js'
import { StagingMap } from '../secret-detect/staging.js'

// The broker is the only seam faked, and it is INJECTED through
// CallbackQueryHandlersDeps (#3627) rather than module-mocked. `vi.mock` is
// not an option here: CI sweeps this whole directory with `bun test`, whose
// `mock.module` is process-global and irreversible, so a broker-client mock
// registered by this file would leak into every later file (it did — it broke
// tests/linear-create-issue.test.ts, which reads its token through the same
// module). Injection matches the house pattern in vault-write-posture.test.ts.

/** The broker's real wrong-passphrase wire message (server.ts:2166-2172). */
const MISMATCH_MSG = "supplied passphrase does not match the broker's unlocked passphrase"

const CHAT = '111'

/**
 * Queued mint outcomes + recorded calls for the injected broker fake. Reset per
 * test; `makeHandlerDeps()` wires it into the handler families.
 */
const brokerState = {
  mintResults: [] as Array<Record<string, unknown>>,
  mintCalls: [] as Array<Record<string, unknown>>,
}

/**
 * A grant success writes the agent's `.vault-token`. The token path is
 * injected (`brokerVaultTokenFilePath`) at a scratch tmpdir so no test can
 * touch real fleet state — a `process.env.HOME` override would NOT do it here:
 * bun's `os.homedir()` snapshots the process's startup HOME and ignores a
 * later assignment, so the usual HOME override is silently inert under the
 * `bun test` sweep CI runs over this directory.
 */
let tokenDir = ''

beforeEach(() => {
  tokenDir = mkdtempSync(join(tmpdir(), 'vault-retry-test-'))
  brokerState.mintResults.length = 0
  brokerState.mintCalls.length = 0
})

// ── fakes ────────────────────────────────────────────────────────────────

function makeCtx(opts: { editThrows?: boolean } = {}) {
  const edits: Array<{ chatId: string; messageId: number; text: string }> = []
  const ctx = {
    from: { id: 111, username: 'op', first_name: 'op' },
    chat: { id: 111 },
    api: {
      editMessageText: vi.fn(
        async (chatId: string, messageId: number, body: { markdown?: string } | string) => {
          if (opts.editThrows) throw new Error('Bad Request: message to edit not found')
          edits.push({
            chatId,
            messageId,
            text: typeof body === 'string' ? body : (body.markdown ?? ''),
          })
          return true
        },
      ),
    },
    answerCallbackQuery: vi.fn(async () => true),
  }
  return { ctx: ctx as unknown as Context, edits, raw: ctx }
}

function makeHandlerDeps() {
  /** Fresh messages the locked bot sent (prompts + resolution fallbacks). */
  const sent: Array<{ chatId: string; text: string; threadId?: number }> = []
  const fakeBot = {
    api: {
      editMessageText: vi.fn(async () => true),
      sendRichMessage: vi.fn(
        async (chatId: string, body: { markdown: string }, other?: { message_thread_id?: number }) => {
          sent.push({
            chatId,
            text: body.markdown,
            ...(other?.message_thread_id != null ? { threadId: other.message_thread_id } : {}),
          })
          return { message_id: 900 + sent.length }
        },
      ),
    },
  }
  const deps: CallbackQueryHandlersDeps = {
    bot: fakeBot,
    lockedBot: fakeBot,
    loadAccess: () => ({ allowFrom: ['111'] }),
    escapeHtmlForTg: (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    switchroomReply: vi.fn(async () => undefined),
    resolveThreadId: (_chatId, explicit) => (explicit == null ? undefined : Number(explicit)),
    deliverResumeSyntheticOrBuffer: vi.fn(
      () => true,
    ) as unknown as CallbackQueryHandlersDeps['deliverResumeSyntheticOrBuffer'],
    expireMentalModelProposeCard: vi.fn(),
    readLiveSwitchroomConfigText: () => 'agents: {}\n',
    mentalModelCorrelationKey: (a, d) => `${a}::${d.length}`,
    getMyAgentName: () => 'test-agent',
    triggerSelfRestart: vi.fn(() => true),
    runSwitchroomAuthCommand: vi.fn(async () => undefined),
    switchroomExecJson: <T,>(_args: string[]): T | null => null,
    assertSafeAgentName: () => {},
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
    brokerMintGrant: (async (args: Record<string, unknown>) => {
      brokerState.mintCalls.push(args)
      return (
        brokerState.mintResults.shift() ?? {
          kind: 'ok',
          token: 'vgt_test',
          id: 'vg_abc123',
          expires_at: null,
        }
      )
    }) as unknown as CallbackQueryHandlersDeps['brokerMintGrant'],
    // No standing-ACL coverage and no prior grants: keeps the union /
    // short-circuit preamble inert so each test observes the mint outcome only.
    brokerList: (async () => null) as unknown as CallbackQueryHandlersDeps['brokerList'],
    brokerListGrants: (async () => ({
      kind: 'error',
      msg: 'unavailable in test',
    })) as unknown as CallbackQueryHandlersDeps['brokerListGrants'],
    brokerVaultTokenFilePath: (slug: string) => join(tokenDir, slug, '.vault-token'),
    getVaultApprovalAuthMode: () => 'passphrase',
    getAdminOnlyKeys: () => [],
    vaultKeyRegex: /^[A-Za-z0-9_./-]{1,200}$/,
    mentalModelProposeTtlMs: 60 * 60 * 1000,
    emitOperatorEvent: vi.fn(),
  }
  return { deps, sent, fakeBot }
}

function stagedAccess(over: Partial<PendingVaultRequestAccess> = {}): PendingVaultRequestAccess {
  return {
    agent: 'worker',
    chat_id: CHAT,
    card_message_id: 42,
    key: 'github/token',
    scope: 'read',
    ttl_seconds: 30 * 24 * 60 * 60,
    staged_at: Date.now(),
    ...over,
  }
}

/**
 * Wire the REAL interceptor deps over the real handler families, so a test
 * drives the same code path a typed passphrase takes in production.
 */
function makeInterceptDeps(handlerDeps: CallbackQueryHandlersDeps) {
  const handlers = createCallbackQueryHandlers(handlerDeps)
  const deleted: number[] = []
  const deps = {
    pendingVaultOps: handlerDeps.pendingVaultOps,
    vaultInputTtlMs: 10 * 60 * 1000,
    vaultPassphraseTtlMs: 10 * 60 * 1000,
    vaultPassphraseCache: handlerDeps.vaultPassphraseCache,
    deleteSensitiveMessage: vi.fn(async (_c: string, msgId: number) => {
      deleted.push(msgId)
    }),
    executeVaultOp: vi.fn(async () => {}),
    unlockViaBroker: vi.fn(async () => ({ ok: true })),
    callbackQueryHandlers: () => handlers,
    pendingVaultRequestAccesses: handlerDeps.pendingVaultRequestAccesses,
    pendingVaultRequestSaves: handlerDeps.pendingVaultRequestSaves,
    switchroomReply: handlerDeps.switchroomReply,
    escapeHtmlForTg: handlerDeps.escapeHtmlForTg,
    vaultKeyRegex: handlerDeps.vaultKeyRegex,
    vaultKeyRegexLabel: 'slug',
    secretStaging: handlerDeps.secretStaging,
  } as unknown as InboundInterceptorDeps
  return { deps, handlers, deleted }
}

/** Type the pending op down to the access-approve variant for assertions. */
function accessOp(op: PendingVaultOp | undefined) {
  if (op?.kind !== 'passphrase-for-access-approve') return undefined
  return op
}

/** Arm the queue exactly as an Approve tap on a locked vault would. */
function armQueue(
  handlerDeps: CallbackQueryHandlersDeps,
  items: Array<{ stageId: string; cardMessageId: number }>,
  attempts?: number,
) {
  handlerDeps.pendingVaultOps.set(CHAT, {
    kind: 'passphrase-for-access-approve',
    items: items.map((it) => ({
      stageId: it.stageId,
      cardChatId: CHAT,
      cardMessageId: it.cardMessageId,
      senderId: '111',
    })),
    ...(attempts != null ? { attempts } : {}),
    startedAt: Date.now(),
  })
}

// ── the mismatch classifier ──────────────────────────────────────────────

describe('isPassphraseMismatchBrokerError', () => {
  it('recognises the broker wrong-passphrase denial', () => {
    expect(isPassphraseMismatchBrokerError(MISMATCH_MSG)).toBe(true)
    expect(isPassphraseMismatchBrokerError('denied:passphrase-mismatch')).toBe(true)
  })

  it('does NOT treat other refusals as retryable', () => {
    // These must stay terminal — retrying burns the operator's attempts on
    // something no passphrase can fix.
    expect(isPassphraseMismatchBrokerError('agent not permitted to hold this key')).toBe(false)
    expect(isPassphraseMismatchBrokerError('mint_grant: keys must be a non-empty array')).toBe(false)
    expect(isPassphraseMismatchBrokerError('vault is locked')).toBe(false)
  })
})

// ── prompt copy ──────────────────────────────────────────────────────────

describe('buildAccessPassphrasePromptText', () => {
  it('leads with 🚨 on every variant (#3627 item 1)', () => {
    for (const variant of ['batch', 'admin-only', 'locked'] as const) {
      const text = buildAccessPassphrasePromptText({
        kind: 'first',
        variant,
        itemCount: 2,
        agentEscaped: 'worker',
        key: 'github/token',
      })
      expect(text.startsWith('**🚨🔐 ACTION NEEDED: passphrase required**')).toBe(true)
      expect(text).not.toContain('⚠️')
    }
  })

  it('pluralises the remaining-attempts line', () => {
    const two = buildAccessPassphrasePromptText({
      kind: 'retry',
      itemCount: 1,
      retryRemaining: 2,
    })
    expect(two).toContain('Wrong passphrase. 2 attempts remaining.')
    const one = buildAccessPassphrasePromptText({
      kind: 'retry',
      itemCount: 1,
      retryRemaining: 1,
    })
    expect(one).toContain('Wrong passphrase. 1 attempt remaining.')
  })
})

// ── the retry loop, driven through interceptVault ────────────────────────

describe('wrong-passphrase retry (#3627 item 3)', () => {
  it('keeps the stage alive and re-prompts with the remaining count', async () => {
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx, edits } = makeCtx()
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })

    const out = await interceptVault({ ctx, text: 'wrong-one', chat_id: CHAT, msgId: 7 }, deps)

    expect(out.handled).toBe(true)
    // Stage survives — the operator can still complete this approval.
    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(true)
    expect(hDeps.pendingCardStore.remove).not.toHaveBeenCalled()
    // Counter advanced on the passphrase ENTRY, queue re-armed with the
    // still-unresolved stage.
    const op = accessOp(hDeps.pendingVaultOps.get(CHAT))
    expect(op?.attempts).toBe(1)
    expect(op?.items.map((i) => i.stageId)).toEqual(['s1'])
    // Operator sees a fresh, loud re-prompt with the count.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('🚨🔐 ACTION NEEDED: passphrase required')
    expect(sent[0]!.text).toContain('Wrong passphrase. 2 attempts remaining.')
    // The card is NOT edited to a terminal failure.
    expect(edits.some((e) => e.text.includes('mint_grant failed'))).toBe(false)
    // The wrong passphrase must not linger in the chat cache — otherwise the
    // next Approve tap silently re-uses it.
    expect(hDeps.vaultPassphraseCache.get(CHAT)).toBeUndefined()
  })

  it('counts down across attempts and locks out on the third', async () => {
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx, edits } = makeCtx()

    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })
    await interceptVault({ ctx, text: 'nope-1', chat_id: CHAT, msgId: 7 }, deps)
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })
    await interceptVault({ ctx, text: 'nope-2', chat_id: CHAT, msgId: 8 }, deps)

    expect(accessOp(hDeps.pendingVaultOps.get(CHAT))?.attempts).toBe(2)
    expect(sent[1]!.text).toContain('Wrong passphrase. 1 attempt remaining.')
    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(true)

    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })
    await interceptVault({ ctx, text: 'nope-3', chat_id: CHAT, msgId: 9 }, deps)

    // Third failure is terminal: stage dropped, card store cleaned, no
    // further prompt, and a card edit that names the lockout.
    expect(MAX_VAULT_PASSPHRASE_ATTEMPTS).toBe(3)
    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(false)
    expect(hDeps.pendingCardStore.remove).toHaveBeenCalledWith('s1')
    expect(hDeps.pendingVaultOps.get(CHAT)).toBeUndefined()
    expect(sent).toHaveLength(2)
    const lockout = edits.at(-1)!
    expect(lockout.messageId).toBe(42)
    expect(lockout.text).toContain('Too many wrong passphrase attempts')
    expect(lockout.text).toContain('ask the agent to re-issue')
    // The broker's own reason is carried through for forensics.
    expect(lockout.text).toContain('does not match')
    // Three attempts, three mints — never a silent extra retry.
    expect(brokerState.mintCalls).toHaveLength(3)
  })

  it('counts one attempt for a batch, not one per card', async () => {
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    hDeps.pendingVaultRequestAccesses.set(
      's2',
      stagedAccess({ key: 'coolify/api-token', card_message_id: 43 }),
    )
    armQueue(hDeps, [
      { stageId: 's1', cardMessageId: 42 },
      { stageId: 's2', cardMessageId: 43 },
    ])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx } = makeCtx()
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })

    await interceptVault({ ctx, text: 'wrong', chat_id: CHAT, msgId: 7 }, deps)

    const op = accessOp(hDeps.pendingVaultOps.get(CHAT))
    // One typo = one attempt, even though it failed two cards.
    expect(op?.attempts).toBe(1)
    expect(op?.items.map((i) => i.stageId)).toEqual(['s1', 's2'])
    // And exactly ONE re-prompt for the whole batch.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Wrong passphrase. 2 attempts remaining.')
    expect(sent[0]!.text).toContain('One entry covers **2** pending approvals')
  })

  it('a batch mixing a mint success with a non-retryable refusal stays terminal', async () => {
    const { deps: hDeps } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    hDeps.pendingVaultRequestAccesses.set(
      's2',
      stagedAccess({ key: 'coolify/api-token', card_message_id: 43 }),
    )
    armQueue(hDeps, [
      { stageId: 's1', cardMessageId: 42 },
      { stageId: 's2', cardMessageId: 43 },
    ])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx } = makeCtx()
    // s1 mints fine; s2 is refused for a NON-passphrase reason.
    brokerState.mintResults.push({ kind: 'ok', token: 't', id: 'vg_1', expires_at: null })
    brokerState.mintResults.push({ kind: 'error', msg: 'agent not permitted to hold this key' })

    await interceptVault({ ctx, text: 'right', chat_id: CHAT, msgId: 7 }, deps)

    // Neither is retryable → no re-prompt, no surviving queue.
    expect(hDeps.pendingVaultOps.get(CHAT)).toBeUndefined()
    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(false)
    expect(hDeps.pendingVaultRequestAccesses.has('s2')).toBe(false)
  })

  it('a non-mismatch broker error stays terminal on the FIRST failure', async () => {
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx, edits } = makeCtx()
    brokerState.mintResults.push({ kind: 'error', msg: 'agent not permitted to hold this key' })

    await interceptVault({ ctx, text: 'correct-passphrase', chat_id: CHAT, msgId: 7 }, deps)

    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(false)
    expect(hDeps.pendingCardStore.remove).toHaveBeenCalledWith('s1')
    expect(hDeps.pendingVaultOps.get(CHAT)).toBeUndefined()
    // No re-prompt at all — the operator is told what failed, once.
    expect(sent).toHaveLength(0)
    expect(edits.at(-1)!.text).toContain('mint_grant failed')
    expect(edits.at(-1)!.text).toContain('agent not permitted')
    expect(brokerState.mintCalls).toHaveLength(1)
  })

  it('re-arming the queue never strands a card that was queued concurrently', async () => {
    // The cached-passphrase Approve path can hit a mismatch for ONE card
    // while another card is already queued for the same chat waiting on a
    // passphrase entry. Overwriting the pending op with just the failed card
    // would leave the other one staged, its card still saying "waiting", with
    // no pending op left to route the next passphrase entry back to it.
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    hDeps.pendingVaultRequestAccesses.set(
      's2',
      stagedAccess({ key: 'coolify/api-token', card_message_id: 43 }),
    )
    const handlers = createCallbackQueryHandlers(hDeps)
    const { ctx } = makeCtx()
    // s2 is sitting in an open queue (tapped, awaiting a passphrase entry).
    armQueue(hDeps, [{ stageId: 's2', cardMessageId: 43 }])

    await handlers.resolveAccessApprovalPassphraseMismatch(ctx, {
      chat_id: CHAT,
      failed: [{ stageId: 's1', cardChatId: CHAT, cardMessageId: 42, senderId: '111' }],
      priorAttempts: 0,
      brokerMsg: MISMATCH_MSG,
    })

    const op = accessOp(hDeps.pendingVaultOps.get(CHAT))
    expect(op?.items.map((i) => i.stageId).sort()).toEqual(['s1', 's2'])
    expect(op?.attempts).toBe(1)
    // And the operator is told the entry covers both.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('One entry covers **2** pending approvals')
  })

  it('a correct passphrase after a failed attempt still mints', async () => {
    const { deps: hDeps } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx, edits } = makeCtx()

    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })
    await interceptVault({ ctx, text: 'wrong', chat_id: CHAT, msgId: 7 }, deps)
    brokerState.mintResults.push({ kind: 'ok', token: 't', id: 'vg_ok1', expires_at: null })
    await interceptVault({ ctx, text: 'right', chat_id: CHAT, msgId: 8 }, deps)

    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(false)
    expect(hDeps.pendingVaultOps.get(CHAT)).toBeUndefined()
    expect(edits.at(-1)!.text).toContain('vg_ok1')
  })
})

// ── item 2: no silent failure when the resolution edit itself fails ───────

describe('resolution edit failure fallback (#3627 item 2)', () => {
  it('sends a fresh message carrying the resolved state when the edit fails', async () => {
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx } = makeCtx({ editThrows: true })
    brokerState.mintResults.push({ kind: 'ok', token: 't', id: 'vg_fallback', expires_at: null })

    await interceptVault({ ctx, text: 'right', chat_id: CHAT, msgId: 7 }, deps)

    // The card edit blew up, but the operator still learns the outcome.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('vg_fallback')
  })

  it('does not throw into the caller when the fallback send ALSO fails', async () => {
    const { deps: hDeps, fakeBot } = makeHandlerDeps()
    fakeBot.api.sendRichMessage.mockImplementation(async () => {
      throw new Error('chat not found')
    })
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx } = makeCtx({ editThrows: true })
    brokerState.mintResults.push({ kind: 'ok', token: 't', id: 'vg_x', expires_at: null })

    const out = await interceptVault({ ctx, text: 'right', chat_id: CHAT, msgId: 7 }, deps)

    // The intercept still completes and still consumes the message — a
    // Telegram-side failure must never leak into the drain loop.
    expect(out.handled).toBe(true)
    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(false)
  })
})

// ── review follow-ups: the retry loop's edges ─────────────────────────────

describe('retry loop — attestation, topic routing and the token write', () => {
  it('a POSTURE attestation never retries a mismatch-shaped error', async () => {
    // `approvalAuth: telegram-id` mints with `{ kind: 'posture' }` — the
    // gateway never sent a passphrase, so there is nothing for the operator
    // to retype. A mismatch-shaped broker message on that path must stay
    // TERMINAL; treating it as retryable would leave the stage alive with a
    // re-prompt the operator can't satisfy.
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    const handlers = createCallbackQueryHandlers(hDeps)
    const { ctx, edits } = makeCtx()
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })

    const outcome = await handlers.performVaultAccessApproval(
      ctx,
      stagedAccess(),
      's1',
      '111',
      { kind: 'posture' },
    )

    expect(outcome.kind).toBe('failed')
    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(false)
    expect(hDeps.pendingCardStore.remove).toHaveBeenCalledWith('s1')
    expect(sent).toHaveLength(0)
    expect(edits.at(-1)!.text).toContain('mint_grant failed')
  })

  it('a card tapped mid-retry INHERITS the burned attempts (no free reset)', async () => {
    // Tapping a second Approve between attempts must not hand out a fresh
    // budget of 3. Drives the real approve callback so the queue-join branch
    // itself is under test, not a hand-built pending op.
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    hDeps.pendingVaultRequestAccesses.set(
      's2',
      stagedAccess({ key: 'coolify/api-token', card_message_id: 43 }),
    )
    // Two wrong entries already burned on s1.
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }], 2)
    const handlers = createCallbackQueryHandlers(hDeps)
    const { ctx } = makeCtx()

    await handlers.handleVaultRequestAccessCallback(ctx, 'vra:approve:s2')

    const joined = accessOp(hDeps.pendingVaultOps.get(CHAT))
    expect(joined?.attempts).toBe(2)
    expect(joined?.items.map((i) => i.stageId)).toEqual(['s1', 's2'])

    // The very next wrong passphrase is the third — terminal for BOTH cards.
    const { deps } = makeInterceptDeps(hDeps)
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })
    await interceptVault({ ctx, text: 'nope-3', chat_id: CHAT, msgId: 9 }, deps)

    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(false)
    expect(hDeps.pendingVaultRequestAccesses.has('s2')).toBe(false)
    expect(hDeps.pendingVaultOps.get(CHAT)).toBeUndefined()
    // The join prompt is the only send — no retry prompt after the lockout.
    expect(sent.filter((s) => s.text.includes('attempts remaining'))).toHaveLength(0)
  })

  it('routes the retry prompt into the card’s forum topic', async () => {
    // A batch re-prompt posted to General while the card sits in a busy topic
    // is the same "operator never sees it" failure #3627 item 1 closes.
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess({ threadId: 77 }))
    hDeps.pendingVaultOps.set(CHAT, {
      kind: 'passphrase-for-access-approve',
      items: [{ stageId: 's1', cardChatId: CHAT, cardMessageId: 42, senderId: '111', threadId: 77 }],
      startedAt: Date.now(),
    })
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx } = makeCtx()
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })

    await interceptVault({ ctx, text: 'wrong', chat_id: CHAT, msgId: 7 }, deps)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.threadId).toBe(77)
  })

  it('the CACHED-passphrase tap re-prompts, and survives a card with no message id', async () => {
    // The Approve tap with a live (but wrong) cached passphrase never reaches
    // interceptVault, so it has its own mismatch wiring. Also exercises the
    // `card_message_id == null` case: there is no card to edit, so the
    // resolution has to reach the operator as a fresh message instead.
    const { deps: hDeps, sent } = makeHandlerDeps()
    hDeps.vaultPassphraseCache.set(CHAT, { passphrase: 'stale', expiresAt: Date.now() + 60_000 })
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess({ card_message_id: undefined }))
    const handlers = createCallbackQueryHandlers(hDeps)
    const { ctx, edits } = makeCtx()
    brokerState.mintResults.push({ kind: 'error', msg: MISMATCH_MSG })

    await handlers.handleVaultRequestAccessCallback(ctx, 'vra:approve:s1')

    // Stage survives, the stale cache is dropped, and the operator is asked
    // again with the count.
    expect(hDeps.pendingVaultRequestAccesses.has('s1')).toBe(true)
    expect(hDeps.vaultPassphraseCache.get(CHAT)).toBeUndefined()
    expect(accessOp(hDeps.pendingVaultOps.get(CHAT))?.attempts).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Wrong passphrase. 2 attempts remaining.')
    expect(edits).toHaveLength(0)
  })

  it('writes the minted token to the injected vaultTokenFilePath', async () => {
    // Pins the #3627 switch from an inline `homedir()` path formula to the
    // broker client's `vaultTokenFilePath` seam: the gateway must write where
    // the reader looks, not where `homedir()` happens to point.
    const { deps: hDeps } = makeHandlerDeps()
    hDeps.pendingVaultRequestAccesses.set('s1', stagedAccess())
    armQueue(hDeps, [{ stageId: 's1', cardMessageId: 42 }])
    const { deps } = makeInterceptDeps(hDeps)
    const { ctx } = makeCtx()
    brokerState.mintResults.push({ kind: 'ok', token: 'vgt_fake', id: 'vg_tok', expires_at: null })

    await interceptVault({ ctx, text: 'right', chat_id: CHAT, msgId: 7 }, deps)

    const path = join(tokenDir, 'worker', '.vault-token')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('vgt_fake')
  })
})
