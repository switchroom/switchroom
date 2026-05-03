/**
 * Pin the wiring for #354's PROGRESS_CARD_DRAFT_TRANSPORT env flag.
 *
 * Two regressions this guards against:
 *
 *   1. The flag drifting silently — someone refactors the progress-
 *      card emit and forgets to thread isPrivateChat / sendMessageDraft
 *      when the flag is on. Result: the card stays on the legacy edit
 *      path even though the operator opted in.
 *
 *   2. The flag turning on by default before the spike unknowns are
 *      validated. Default-OFF is load-bearing: until we know drafts
 *      can be pinned and survive bot crashes, the legacy path is the
 *      safe one.
 *
 * Source-level pinning rather than behavioural — the gateway emit
 * lives inside the bot startup wiring and is hard to drive in
 * isolation. The contract here is the literal env-var check + the
 * fact that draft deps are conditional on it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('progress-card draft transport flag (#354)', () => {
  it('is gated behind PROGRESS_CARD_DRAFT_TRANSPORT=1 (default OFF)', () => {
    // The flag check must be an explicit `=== '1'` not a truthy check
    // — `process.env.X === '1'` is the project convention, and a
    // truthy check would mis-fire on `=0` or `=false`.
    expect(gatewaySrc).toMatch(
      /process\.env\.PROGRESS_CARD_DRAFT_TRANSPORT\s*===\s*['"]1['"]/,
    )
  })

  it('only enables draft when the chat is a DM (no threads, isDmChatId)', () => {
    // Drafts don't support forum topics. The flag-check block must
    // gate on isDmChatId(chatId) and threadId == null — otherwise a
    // forum-topic message would be sent via draft and Telegram would
    // reject with DRAFT_CHAT_UNSUPPORTED.
    const block = extractDraftBlock(gatewaySrc)
    expect(block).toMatch(/isDmChatId\(chatId\)/)
    expect(block).toMatch(/threadId\s*==\s*null/)
  })

  it('passes both isPrivateChat AND sendMessageDraft when eligible', () => {
    // Without sendMessageDraft, stream-reply-handler resolves transport
    // to 'message' (line 432: `isForumTopic || deps.sendMessageDraft == null`).
    // Both deps must be threaded together for the draft path to fire.
    const block = extractDraftBlock(gatewaySrc)
    expect(block).toMatch(/isPrivateChat:\s*true/)
    expect(block).toMatch(/sendMessageDraft:\s*sendMessageDraftFn/)
  })

  it('documents the spike unknowns from #354 inline so an operator can validate', () => {
    // The flag exists because pinning + crash behavior are unverified.
    // The block comment must call out both so a future contributor
    // doesn't flip the default to ON without doing the spike first.
    const block = extractDraftBlock(gatewaySrc)
    expect(block.toLowerCase()).toMatch(/pin/)
    expect(block.toLowerCase()).toMatch(/spike|unknown/)
  })
})

/** Pull the #354 spike block out of gateway.ts for source-level assertions. */
function extractDraftBlock(src: string): string {
  // The block starts at the spike comment marker and ends at the next
  // `handleStreamReply(` invocation. Big enough to span the gate +
  // the conditional draft-deps spread.
  const start = src.indexOf('// #354 spike')
  expect(start, '#354 spike block not found in gateway.ts').toBeGreaterThan(0)
  const end = src.indexOf(').then', start)
  expect(end, '#354 spike block end not found').toBeGreaterThan(start)
  return src.slice(start, end)
}
