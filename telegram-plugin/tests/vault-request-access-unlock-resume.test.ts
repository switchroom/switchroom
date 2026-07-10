/**
 * Contract pin for the tap-to-unlock-and-approve flow added on top of
 * #1012 Phase 2 (#1030 broker passphrase-attested mint_grant).
 *
 * Before this PR: tapping Approve on a vault_request_access card
 * without first unlocking the vault edited the card to "🔒 Vault is
 * locked. Run /vault unlock... then ask the agent to re-issue." The
 * operator had to (a) clear that card, (b) /vault unlock, (c) ask
 * the agent to re-emit the request, (d) tap Approve again. Four steps
 * for one decision.
 *
 * After this PR: the cache-miss tap keeps the card open, prompts for
 * the passphrase as the next message, captures+caches it, deletes the
 * passphrase message from chat, then auto-resumes the mint. One tap
 * + one reply = one grant.
 *
 * Mirrors the `passphrase-for-deferred` flow from #44 (deferred-secret
 * card's "🔓 Unlock vault & save"). Same idiom, same trust posture.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// #2996 Phase 5: the callback-query handler families moved verbatim to
// gateway/callback-query-handlers.ts; these pins read the gateway source
// COMBINED with that module so the wiring assertions keep covering the
// same runtime source text.
const gatewaySrc =
  readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8') +
  '\n' +
  readFileSync(resolve(__dirname, '..', 'gateway', 'callback-query-handlers.ts'), 'utf-8')

describe('vault_request_access — tap-to-unlock-and-approve UX', () => {
  it('declares the passphrase-for-access-approve PendingVaultOp variant', () => {
    // fails when: the new PendingVaultOp kind is dropped. The
    // resume flow leans on this discriminator — without it the
    // text handler can't route the passphrase reply back to the
    // staged request.
    expect(gatewaySrc).toMatch(/kind:\s*['"]passphrase-for-access-approve['"]/)
  })

  it('Approve on a locked vault stages a passphrase prompt instead of clearing the card', () => {
    // fails when: the cache-miss branch reverts to the old behaviour
    // of editing the card to "ask the agent to re-issue." That UX
    // is the four-step workaround we just replaced.
    //
    // Anchor: the approve-action block inside handleVaultRequestAccessCallback.
    const approveBlock =
      gatewaySrc.split('if (action === \'approve\')')[1]?.split('await ctx.answerCallbackQuery({ text: \'Unknown action\'')[0] ?? ''
    expect(approveBlock).toMatch(/pendingVaultOps\.set/)
    expect(approveBlock).toMatch(/passphrase-for-access-approve/)
    // Card text must invite a passphrase reply, not punt to a
    // /vault unlock detour.
    expect(approveBlock).toMatch(/Reply with your passphrase/i)
    // The "ask the agent to re-issue the request card" copy belonged
    // to the pre-fix path. Should be gone from the cache-miss branch.
    expect(approveBlock).not.toMatch(/ask the agent to re-issue the request card/)
  })

  it('passphrase prompt goes out as a NEW rich message, not an in-place edit', () => {
    // fails when: the cache-miss branch reverts to overloading the
    // ORIGINAL card as the prompt via editMessageText. An in-place
    // edit fires no notification and stays stapled to the card's old
    // position, so a busy topic buries it and the operator never sees
    // the passphrase ask (the reported v0.16.45 admin-key miss). The
    // prompt must be a fresh `sendRichMessage` below.
    const approveBlock =
      gatewaySrc.split('if (action === \'approve\')')[1]?.split('await ctx.answerCallbackQuery({ text: \'Unknown action\'')[0] ?? ''
    // A distinct passphrase-prompt send exists (verb-tagged).
    expect(approveBlock).toMatch(/sendRichMessage\(pending\.chat_id, richMessage\(promptText\)/)
    expect(approveBlock).toMatch(/vault_request_access\.passphrase_prompt/)
  })

  it('passphrase prompt renders via richMessage — no raw literal-markdown edit', () => {
    // ROOT CAUSE of the reported bug: the old admin-only and
    // joining-batch branches passed RAW markdown strings (with literal
    // `**`/`_`) straight to editMessageText (parse_mode=none), so the
    // bold/italic rendered as literal characters, and the "locked"
    // branch concatenated a string with a richMessage() object
    // (→ "[object Object]"). Every branch must now flow through the
    // richMessage() GFM render path.
    const approveBlock =
      gatewaySrc.split('if (action === \'approve\')')[1]?.split('await ctx.answerCallbackQuery({ text: \'Unknown action\'')[0] ?? ''
    // The prompt text is assembled once and wrapped in richMessage.
    expect(approveBlock).toMatch(/const promptText =/)
    // Regression guard: the old raw-string admin-only edit copy is gone.
    expect(approveBlock).not.toMatch(/requires your vault passphrase to grant/)
    // Regression guard: no string-concatenated richMessage() object
    // (the "[object Object]" bug) remains.
    expect(approveBlock).not.toMatch(/\+\s*\n\s*richMessage\(/)
  })

  it('passphrase prompt is attention-grabbing and does NOT suppress notifications', () => {
    // fails when: the prompt loses its strong header or someone adds
    // disable_notification to it. The whole point of the fix is that
    // the operator gets PINGED — a silent prompt is the bug.
    const approveBlock =
      gatewaySrc.split('if (action === \'approve\')')[1]?.split('await ctx.answerCallbackQuery({ text: \'Unknown action\'')[0] ?? ''
    expect(approveBlock).toMatch(/ACTION NEEDED: passphrase required/)
    // The send options for the prompt must not carry disable_notification.
    const promptSend =
      approveBlock.split('const promptText =')[1]?.split('return')[0] ?? ''
    expect(promptSend).not.toMatch(/disable_notification/)
  })

  it('passphrase intercept deletes the chat message and resumes mint', () => {
    // fails when: the new pending-op handler stops calling
    // deleteSensitiveMessage on the passphrase message OR stops
    // routing into performVaultAccessApproval. Both are load-bearing:
    //   - delete: prevents the passphrase from lingering in chat history
    //   - resume: closes the "one decision" UX promise
    //
    // Anchor: the text-handler branch keyed on the new kind.
    const handlerBlock =
      gatewaySrc
        .split("pendingVault.kind === 'passphrase-for-access-approve'")[1]
        ?.split("pendingVault.kind === 'grant-wizard'")[0] ?? ''
    expect(handlerBlock).toMatch(/deleteSensitiveMessage/)
    expect(handlerBlock).toMatch(/performVaultAccessApproval/)
    // Cache the passphrase so future operations in the same chat
    // don't re-prompt within the TTL window.
    expect(handlerBlock).toMatch(/vaultPassphraseCache\.set/)
  })

  it('expired-stage path edits the card cleanly, does not silently drop', () => {
    // fails when: the resume path forgets to handle the edge case
    // where the staged access entry's 10-min TTL elapsed between
    // tap-on-locked and passphrase reply. Without this branch the
    // operator types their passphrase, gets nothing visible back,
    // and is confused about whether their secret leaked.
    const handlerBlock =
      gatewaySrc
        .split("pendingVault.kind === 'passphrase-for-access-approve'")[1]
        ?.split("pendingVault.kind === 'grant-wizard'")[0] ?? ''
    expect(handlerBlock).toMatch(/expired before you replied|expired/)
    expect(handlerBlock).toMatch(/editMessageText/)
  })

  it('mint failure (e.g. wrong passphrase) edits the card; does not silent-drop', () => {
    // fails when: performVaultAccessApproval's error branch returns
    // without editing the card. Without the edit, a wrong-passphrase
    // attempt leaves the locked-vault prompt on screen forever and
    // the operator can't tell whether the system saw their reply.
    //
    // Anchor: performVaultAccessApproval's `result.kind === 'error'`
    // branch.
    const mintHelper =
      gatewaySrc.split('async function performVaultAccessApproval')[1]?.split('async function handleVaultRequestAccessCallback')[0] ?? ''
    expect(mintHelper).toMatch(/result\.kind === 'error'/)
    // After error: card edited AND pending entry dropped (no
    // zombie staged request).
    expect(mintHelper).toMatch(/editMessageText[\s\S]{0,400}mint_grant failed/)
    expect(mintHelper).toMatch(/pendingVaultRequestAccesses\.delete/)
  })
})
