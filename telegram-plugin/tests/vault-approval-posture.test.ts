/**
 * Contract pins for the `vault.broker.approvalAuth` posture toggle and
 * its #1115 follow-up — broker-mediated attestation.
 *
 * Posture summary:
 *   - `passphrase` (default): Approve on a grant card prompts the
 *     operator for the vault passphrase. Two-factor (Telegram ID +
 *     passphrase). Gateway holds the passphrase only briefly after
 *     operator typing.
 *   - `telegram-id` (opt-in): Approve mints immediately. The gateway
 *     signals operator-tap intent to the broker via
 *     `attest_via_posture: true` on the mint_grant call; the broker
 *     uses its OWN retained passphrase internally. Single-factor;
 *     passphrase never leaves the broker process.
 *
 * Load-bearing invariants pinned here:
 *   1. The resolver returns the posture mode and nothing else — the
 *      gateway no longer holds the passphrase in memory under
 *      telegram-id (the #1115 first-cut and #1115-follow-up-v1
 *      designs did, and the reviewer flagged it as a bypass).
 *   2. The allowlist check is the FIRST gate in every vault callback
 *      handler — no posture branching, no mint, no
 *      `pendingVaultOps.set` runs before it.
 *   3. handleVaultDeferCallback and handleVaultRequestSaveCallback
 *      under telegram-id NO LONGER short-circuit on an in-memory
 *      passphrase — they fall through to the standard
 *      cached-passphrase path (#1115 follow-up cleanup; the original
 *      shortcut was the same bypass class as the access-approve
 *      one).
 *   4. handleVaultRequestAccessCallback under telegram-id calls
 *      `performVaultAccessApproval` with `{ kind: 'posture' }` — the
 *      attestation type that drives `attest_via_posture: true` on
 *      mint_grant.
 *   5. `handleVaultGrantCallback` (operator-initiated wizard) NEVER
 *      references `VAULT_APPROVAL_AUTH_MODE` — flipping posture
 *      cannot change wizard behaviour.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveVaultApprovalPosture } from '../vault-approval-posture.js'

// #2996 Phase 5: the callback-query handler families moved verbatim to
// gateway/callback-query-handlers.ts; these pins read the gateway source
// COMBINED with that module so the wiring assertions keep covering the
// same runtime source text.
const gatewaySrc =
  readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8') +
  '\n' +
  readFileSync(resolve(__dirname, '..', 'gateway', 'callback-query-handlers.ts'), 'utf-8') +
  '\n' +
  // P7 PR-8 (#2996): vault pending-op intercept moved to inbound-interceptors.ts.
  readFileSync(resolve(__dirname, '..', 'gateway', 'inbound-interceptors.ts'), 'utf-8')

function sliceAccessApproveBlock(): string {
  const fn =
    gatewaySrc.split('async function handleVaultRequestAccessCallback')[1]?.split('async function')[0] ?? ''
  return fn.split("if (action === 'approve')")[1]?.split("await ctx.answerCallbackQuery({ text: 'Unknown action'")[0] ?? ''
}

describe('vault grant approval posture — module-level wiring', () => {
  it('declares the posture mode holder; does NOT hold the passphrase in memory', () => {
    expect(gatewaySrc).toMatch(/let VAULT_APPROVAL_AUTH_MODE:\s*['"]passphrase['"]\s*\|\s*['"]telegram-id['"]/)
    // Regression guard: post-#1115-follow-up the gateway must NOT
    // declare AUTO_UNLOCK_PASSPHRASE — the passphrase stays in the
    // broker. If a future change reintroduces this variable, the
    // reviewer's "agent can self-mint" bypass returns.
    expect(gatewaySrc).not.toMatch(/let AUTO_UNLOCK_PASSPHRASE/)
    expect(gatewaySrc).not.toMatch(/AUTO_UNLOCK_PASSPHRASE\s*=/)
  })

  it('initialises posture from switchroom config at startup', () => {
    expect(gatewaySrc).toMatch(/function initVaultApprovalPosture/)
    expect(gatewaySrc).toMatch(/initVaultApprovalPosture\(\)/)
    expect(gatewaySrc).toMatch(/resolveVaultApprovalPosture\(/)
  })
})

describe('handleVaultRequestAccessCallback — posture branch', () => {
  it('mints via posture attestation (NOT in-memory passphrase) when posture is telegram-id', () => {
    const approveBlock = sliceAccessApproveBlock()
    // #2996 Phase 5: inside the extracted handler module the mutable gateway
    // `let` is read via the injected getter (gateway wires it as
    // `getVaultApprovalAuthMode: () => VAULT_APPROVAL_AUTH_MODE`).
    expect(approveBlock).toMatch(/getVaultApprovalAuthMode\(\) === ['"]telegram-id['"]/)
    // Pinned: the call shape MUST be `{ kind: 'posture' }`. If the
    // gateway ever reverts to passing a real passphrase here, the
    // bypass surface returns.
    expect(approveBlock).toMatch(/performVaultAccessApproval\(ctx, pending, stageId, senderId, \{ kind: ['"]posture['"] \}\)/)
    expect(approveBlock).toMatch(/Approved by @/)
  })

  it('preserves the allowlist guard regardless of posture', () => {
    const handlerBlock =
      gatewaySrc.split('async function handleVaultRequestAccessCallback')[1]?.split('async function')[0] ?? ''
    expect(handlerBlock).toMatch(/if \(!access\.allowFrom\.includes\(senderId\)\)/)
    expect(handlerBlock).toMatch(/Not authorized/)
  })

  it('passphrase-mode branch unchanged: cache lookup + prompt still present', () => {
    const approveBlock = sliceAccessApproveBlock()
    expect(approveBlock).toMatch(/vaultPassphraseCache\.get\(pending\.chat_id\)/)
    // #3627: the prompt COPY moved into the shared
    // `buildAccessPassphrasePromptText` builder (so the first prompt and the
    // wrong-passphrase re-prompt can't drift). The passphrase-mode branch
    // must still route into it.
    expect(approveBlock).toMatch(/sendAccessPassphrasePrompt\(/)
    expect(gatewaySrc).toMatch(/Reply with your passphrase/i)
    expect(approveBlock).toMatch(/passphrase-for-access-approve/)
    // Pinned: the queued-drain path passes the typed passphrase via
    // the new attestation shape `{ kind: 'passphrase', passphrase }`.
    // P7 PR-8: the queued-drain call site moved into interceptVault
    // (inbound-interceptors.ts) — ctx is `p.ctx` and the handler resolves via
    // the lazy deps accessor. Same attestation shape pinned.
    expect(gatewaySrc).toMatch(/performVaultAccessApproval\((?:p\.)?ctx, stagedAccess, item\.stageId, item\.senderId, \{ kind: ['"]passphrase['"], passphrase \}\)/)
  })
})

describe('performVaultAccessApproval — broker-mediated attestation', () => {
  it('builds brokerAuthOpts from the AccessApprovalAttestation discriminator', () => {
    const fnBlock =
      gatewaySrc
        .split('async function performVaultAccessApproval')[1]
        ?.split('async function handleVaultRequestAccessCallback')[0] ?? ''
    // Pinned: the passphrase variant feeds the broker passphrase
    // attestation; the posture variant feeds `attest_via_posture:
    // true`. NOT a free-form union — the discriminator is what
    // makes the call shapes type-safe.
    expect(fnBlock).toMatch(/attestation\.kind === ['"]passphrase['"]/)
    expect(fnBlock).toMatch(/attest_via_posture: true/)
    expect(fnBlock).toMatch(/passphrase: attestation\.passphrase/)
    // Pinned: the same brokerAuthOpts threads both
    // listGrantsViaBroker (for #1051 grant-union) AND
    // mintGrantViaBroker. If only one is wired, the union path
    // silently re-strands the prior token under telegram-id.
    expect(fnBlock).toMatch(/listGrantsViaBroker\(pending\.agent, brokerAuthOpts\)/)
    expect(fnBlock).toMatch(/\.\.\.brokerAuthOpts/)
  })
})

describe('handleVaultRequestSaveCallback — posture-attested broker put (#1115 follow-up)', () => {
  it('NO in-memory passphrase under telegram-id; routes the save through the broker via attest_via_posture', () => {
    const fnBlock =
      gatewaySrc
        .split('async function handleVaultRequestSaveCallback')[1]
        ?.split('async function handleVaultDeferCallback')[0] ?? ''
    // Regression guard (original #1115 first-cut withdrawal): the
    // handler must NOT pull a long-lived in-memory passphrase under
    // telegram-id. That was a bypass surface — claude in the same
    // container could exfiltrate it. The follow-up replaces it with
    // a broker-IPC `attest_via_posture` call so the passphrase
    // never leaves the broker process.
    expect(fnBlock).not.toMatch(/AUTO_UNLOCK_PASSPHRASE/)
    // The #1115 follow-up wiring: under telegram-id the handler
    // calls `defaultVaultWritePosture` (posture-attested broker put,
    // no passphrase). Under passphrase mode it keeps the legacy
    // cached-passphrase + shell-out path.
    // #2996 Phase 5: getter read of the gateway's mutable posture `let`.
    expect(fnBlock).toMatch(/getVaultApprovalAuthMode\(\) === 'telegram-id'/)
    expect(fnBlock).toMatch(/defaultVaultWritePosture\(/)
    // Passphrase-mode branch still present.
    expect(fnBlock).toMatch(/vaultPassphraseCache\.get\(pending\.chat_id\)/)
    expect(fnBlock).toMatch(/defaultVaultWrite\(pending\.key, pending\.value, cached\.passphrase\)/)
    // The misleading pre-fix card text ("Vault is locked") must be
    // rephrased — the broker IS unlocked under telegram-id; only
    // the chat's passphrase cache needs warming up under passphrase
    // mode. Pin the corrected wording so the wedge UX can't
    // silently regress.
    expect(fnBlock).toMatch(/Passphrase not cached for this chat/)
  })
})

describe('handleVaultDeferCallback — telegram-id silent path withdrawn', () => {
  it('NO LONGER reads an in-memory passphrase for telegram-id; falls through to cached-passphrase path', () => {
    const fnBlock =
      gatewaySrc
        .split('async function handleVaultDeferCallback')[1]
        ?.split('\nasync function ')[0] ?? ''
    expect(fnBlock).not.toMatch(/AUTO_UNLOCK_PASSPHRASE/)
    // Cached-passphrase path still present.
    const unlockBranch = fnBlock.split("if (action === 'unlock')")[1] ?? ''
    expect(unlockBranch).toMatch(/vaultPassphraseCache\.get\(/)
  })
})

describe('handleVaultGrantCallback (wizard) — posture cannot affect wizard', () => {
  it('wizard handler never references VAULT_APPROVAL_AUTH_MODE — posture flips are inert here', () => {
    const fnBlock =
      gatewaySrc
        .split('async function handleVaultGrantCallback')[1]
        ?.split('\nasync function ')[0] ?? ''
    expect(fnBlock).not.toMatch(/VAULT_APPROVAL_AUTH_MODE/)
    expect(fnBlock).not.toMatch(/AUTO_UNLOCK_PASSPHRASE/)
    expect(fnBlock).not.toMatch(/attest_via_posture/)
  })
})

describe('allowlist is the first gate in every vault callback handler', () => {
  function handlerBody(name: string): string {
    const after = gatewaySrc.split(`async function ${name}(`)[1] ?? ''
    return after.split('\nasync function ')[0] ?? ''
  }
  for (const handler of [
    'handleVaultRequestAccessCallback',
    'handleVaultRequestSaveCallback',
    'handleVaultDeferCallback',
    'handleVaultGrantCallback',
  ]) {
    it(`${handler}: allowlist check fires before any other branching`, () => {
      const body = handlerBody(handler)
      expect(body).not.toBe('')
      const idx = body.indexOf('if (')
      const firstGuard = body.slice(idx, body.indexOf('\n', body.indexOf('\n', idx) + 1))
      expect(firstGuard).toMatch(/access\.allowFrom\.includes\(senderId\)/)
    })

    it(`${handler}: no callback side-effect appears before the allowlist check`, () => {
      const body = handlerBody(handler)
      const beforeAllowlist = body.split('access.allowFrom.includes(senderId)')[0] ?? body
      for (const sentinel of [
        'mintGrantViaBroker',
        'performVaultAccessApproval',
        'pendingVaultOps.set',
        "getVaultApprovalAuthMode() === 'telegram-id'",
        'attest_via_posture',
      ]) {
        expect(
          beforeAllowlist.includes(sentinel),
          `${handler}: sentinel "${sentinel}" must NOT appear before the allowlist check`,
        ).toBe(false)
      }
    })
  }
})

describe('resolveVaultApprovalPosture — runtime behaviour', () => {
  it('passphrase posture when approvalAuth is absent', () => {
    expect(resolveVaultApprovalPosture(undefined)).toEqual({ mode: 'passphrase' })
    expect(resolveVaultApprovalPosture({})).toEqual({ mode: 'passphrase' })
  })

  it('passphrase posture when approvalAuth is explicitly passphrase', () => {
    expect(resolveVaultApprovalPosture({ approvalAuth: 'passphrase' })).toEqual({ mode: 'passphrase' })
  })

  it('telegram-id posture when approvalAuth is telegram-id', () => {
    expect(resolveVaultApprovalPosture({ approvalAuth: 'telegram-id' })).toEqual({ mode: 'telegram-id' })
  })

  it('defence-in-depth: unknown approvalAuth values fall back to passphrase (schema rejects them, but trust nothing)', () => {
    expect(resolveVaultApprovalPosture({ approvalAuth: 'TELEGRAM-ID' })).toEqual({ mode: 'passphrase' })
    expect(resolveVaultApprovalPosture({ approvalAuth: 'telegram_id' })).toEqual({ mode: 'passphrase' })
    expect(resolveVaultApprovalPosture({ approvalAuth: '' })).toEqual({ mode: 'passphrase' })
    expect(resolveVaultApprovalPosture({ approvalAuth: 'nonsense' })).toEqual({ mode: 'passphrase' })
  })

  it('adversarial fuzz: 200 random inputs never return a non-passphrase, non-telegram-id mode and never throw', () => {
    const rand = mulberry32(0xdeadbeef)
    const choices: any[] = [
      undefined,
      'passphrase',
      'telegram-id',
      'PASSPHRASE',
      '',
      'nonsense',
      null,
      0,
      false,
      { nested: 'telegram-id' },
    ]
    for (let i = 0; i < 200; i++) {
      const broker = { approvalAuth: choices[Math.floor(rand() * choices.length)] }
      const result = resolveVaultApprovalPosture(broker as never)
      expect(result.mode === 'passphrase' || result.mode === 'telegram-id', `iter ${i}: mode must be one of the two literals`).toBe(true)
    }
  })
})

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
