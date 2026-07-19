/**
 * P7 F-1 — `runPasteBackIntercepts` INTERNAL-ORDER unit pins (#2996).
 *
 * The v2 consolidated paste-back chain (inbound-router.ts) runs its intercepts
 * in a fixed sequence:
 *
 *   perm → authAdd → loopback → reauth → vault → secretStaging
 *
 * The P7 adversarial review (F-1) proved that ordering was UNPINNED: swapping
 * `interceptReauth` ahead of `interceptAuthAdd` (or `interceptVault` ahead of
 * `interceptReauth`) left every suite green, because no test drove a single
 * message that TWO adjacent intercepts both claim. The gateway integration
 * harness can't seed `pendingVaultOps` (it isn't on `__inboundRouterTestSeam`),
 * so these two pins call `runPasteBackIntercepts` DIRECTLY with a stub
 * `InboundInterceptorDeps` whose stores we can seed on both sides of a boundary.
 *
 * Each test seeds the precondition for TWO adjacent intercepts with one message
 * that both would claim, then asserts the EARLIER intercept in the production
 * order wins (consumes the message; the later store is left untouched and its
 * side-effect never fires). Reversing the two intercepts in
 * `runPasteBackIntercepts` flips every assertion — the mutation evidence in the
 * PR body. These are load-bearing: they assert WHICH handler consumed, not just
 * that the message was handled.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  runPasteBackIntercepts,
} from '../telegram-plugin/gateway/inbound-router.js'
import type {
  AuthAddParams,
  InboundInterceptorDeps,
} from '../telegram-plugin/gateway/inbound-interceptors.js'

const CHAT = '4242'
const KEY = 'chatkey:4242'
const AUTH_CODE = 'session_abc123def456'

function makeParams(): AuthAddParams {
  return {
    ctx: { reply: vi.fn(async () => ({})) } as never,
    text: AUTH_CODE,
    chat_id: CHAT,
    msgId: 7,
    interceptKey: KEY,
  }
}

/**
 * A minimal `InboundInterceptorDeps` covering exactly the fields the
 * paste-back intercepts touch on the paths these tests drive. Stores are plain
 * Maps (the intercepts use only .get/.set/.delete/.has — a superset-compatible
 * shape with the prod sweepable stores). Every effect fn is a spy so a test can
 * assert which branch's side-effect fired.
 */
function makeDeps(seed: {
  authAdd?: boolean
  reauth?: boolean
  vault?: boolean
}) {
  const pendingAuthAddFlows = new Map<string, any>()
  const pendingReauthFlows = new Map<string, any>()
  const pendingVaultOps = new Map<string, any>()
  if (seed.authAdd)
    pendingAuthAddFlows.set(KEY, { label: 'acct', scratchDir: '/tmp/none', startedAt: Date.now() })
  if (seed.reauth)
    pendingReauthFlows.set(KEY, { agent: 'a', startedAt: Date.now() })
  if (seed.vault)
    pendingVaultOps.set(CHAT, { kind: 'passphrase', op: 'get', key: 'k', startedAt: Date.now() })

  const spies = {
    submitAccountAuthCode: vi.fn(async () => { throw new Error('network suppressed') }),
    execAuthCode: vi.fn(() => ({ result: null, errorText: undefined })),
    executeVaultOp: vi.fn(async () => {}),
    redactAuthCode: vi.fn(() => {}),
    switchroomReply: vi.fn(async () => {}),
    deleteSensitiveMessage: vi.fn(async () => {}),
    dispatchPermissionVerdict: vi.fn(() => {}),
    resumeReactionAfterVerdict: vi.fn(() => {}),
    postPermissionResumeMessage: vi.fn(() => {}),
    sendReaction: vi.fn(async () => ({})),
  }

  const deps = {
    // stores (live references — seeded above)
    pendingAuthAddFlows,
    pendingReauthFlows,
    pendingVaultOps,
    pendingPermissions: new Map(),
    vaultPassphraseCache: new Map(),
    secretStaging: { latestForChat: () => null },
    // predicates / TTLs
    looksLikeAuthCode: () => true,
    reauthInterceptTtlMs: 600_000,
    vaultInputTtlMs: 600_000,
    vaultPassphraseTtlMs: 600_000,
    // formatting helpers (reached only on the auth-add broker path)
    escapeHtmlForTg: (s: string) => s,
    preBlock: (s: string) => s,
    formatSwitchroomOutput: (s: string) => s,
    formatAuthOutputForTelegram: (s: string) => ({ text: s }),
    renderAuthCodeOutcome: () => null,
    cleanAuthAddScratchDir: () => {},
    cancelAccountAuthSession: () => {},
    addAccountViaBroker: async () => {},
    ...spies,
  } as unknown as InboundInterceptorDeps

  return { deps, spies, pendingAuthAddFlows, pendingReauthFlows, pendingVaultOps }
}

describe('runPasteBackIntercepts — internal order (F-1 mutation pins)', () => {
  it('auth-add BEFORE reauth: /auth-add consumes the code; reauth flow untouched', async () => {
    const { deps, spies, pendingAuthAddFlows, pendingReauthFlows } = makeDeps({
      authAdd: true,
      reauth: true,
    })
    const outcome = await runPasteBackIntercepts(makeParams(), deps)
    expect(outcome.handled).toBe(true)
    // auth-add won: it deleted its own flow and ran the add-flow submit…
    expect(pendingAuthAddFlows.has(KEY)).toBe(false)
    expect(spies.submitAccountAuthCode).toHaveBeenCalledTimes(1)
    // …and reauth NEVER ran (its flow survives, execAuthCode never fired).
    // A reauth-ahead-of-authAdd mutation flips BOTH of these.
    expect(pendingReauthFlows.has(KEY)).toBe(true)
    expect(spies.execAuthCode).not.toHaveBeenCalled()
  })

  it('reauth BEFORE vault: /reauth consumes the code; pending vault op untouched', async () => {
    const { deps, spies, pendingReauthFlows, pendingVaultOps } = makeDeps({
      reauth: true,
      vault: true,
    })
    const outcome = await runPasteBackIntercepts(makeParams(), deps)
    expect(outcome.handled).toBe(true)
    // reauth won: it deleted its own flow and ran the auth-code exec…
    expect(pendingReauthFlows.has(KEY)).toBe(false)
    expect(spies.execAuthCode).toHaveBeenCalledTimes(1)
    // …and the vault intercept NEVER ran (its pending op survives,
    // executeVaultOp never fired). A vault-ahead-of-reauth mutation flips
    // BOTH of these.
    expect(pendingVaultOps.has(CHAT)).toBe(true)
    expect(spies.executeVaultOp).not.toHaveBeenCalled()
  })
})
