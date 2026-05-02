/**
 * Tests for the Anthropic OAuth browser-code detection added in issue #44.
 *
 * Channel A — anchored pattern (`anthropic_oauth_code`):
 *   Positive: two URL-safe base64 segments (≥20 chars each) separated by `#`.
 *   Negative: ordinary URL fragments, short anchors, markdown link targets.
 *
 * Channel B — context rule (`awaitingAuthCodeAt` map in gateway.ts):
 *   Tested structurally: verify the gateway source wires the map, sets it
 *   when emitting the "Paste the browser code here" prompt, checks it on
 *   inbound, and clears it after one message.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { detectSecrets } from '../secret-detect/index.js'
import { runPipeline } from '../secret-detect/pipeline.js'
import { setAuditSink } from '../secret-detect/audit.js'
import type { VaultWriteFn, VaultListFn } from '../secret-detect/vault-write.js'

// ─── Channel A — pattern unit tests ──────────────────────────────────────────

describe('anthropic_oauth_code pattern — Channel A', () => {
  it('detects a bare auth code (two long url-safe-b64 segments with #)', () => {
    // Shape emitted by the claude.com/cai authorize flow
    const code = 'tle0rmXYZabc123defGHIjkl#00EySjXYZabc123defGHIjklmno'
    const d = detectSecrets(code)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(true)
    const hit = d.find((h) => h.rule_id === 'anthropic_oauth_code')!
    expect(hit.confidence).toBe('high')
    expect(hit.matched_text).toBe(code)
  })

  it('detects a code embedded in prose (prefixed with "here is the code:")', () => {
    const code = 'aBcDeFgHiJkLmNoPqRsTuVwX#xYz123456789abcdefghijkl'
    const text = `here is the browser code: ${code} please use it`
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(true)
    const hit = d.find((h) => h.rule_id === 'anthropic_oauth_code')!
    expect(hit.matched_text).toBe(code)
  })

  it('does NOT match https:// URL fragments (section anchor)', () => {
    const text = 'see https://example.com/docs#installation for more'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)
  })

  it('does NOT match a short first segment (ordinary markdown anchor)', () => {
    // "callback" is only 8 chars — below the 20-char minimum
    const text = 'https://claude.ai/callback#state123456789012345'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)
  })

  it('does NOT match a markdown link target like [link](/foo#bar)', () => {
    // "/foo" is 4 chars — well below minimum; "bar" is 3 chars — also below
    const text = '[see here](/features#quickstart-guide)'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)
  })

  it('does NOT match when either segment is shorter than 20 chars', () => {
    // First segment: 19 chars (one short)
    const text = 'aBcDeFgHiJkLmNoPqRs#xYz123456789abcdefghijkl'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)

    // Second segment: 19 chars
    const text2 = 'aBcDeFgHiJkLmNoPqRsT#xYz123456789abcde'
    const d2 = detectSecrets(text2)
    // "xYz123456789abcde" is 18 chars — below minimum
    expect(d2.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)
  })

  it('flows through runPipeline and stores the code in the vault', () => {
    const store = new Map<string, string>()
    const write: VaultWriteFn = (slug, value) => { store.set(slug, value); return { ok: true, output: 'ok' } }
    const list: VaultListFn = () => ({ ok: true, keys: [...store.keys()] })

    const code = 'tle0rmXYZabc123defGHIjkl#00EySjXYZabc123defGHIjklmno'
    const res = runPipeline({
      chat_id: 'test-chat',
      message_id: 1,
      text: code,
      passphrase: 'pw',
      vaultWrite: write,
      vaultList: list,
    })

    expect(res.stored).toHaveLength(1)
    expect(res.stored[0]!.detection.rule_id).toBe('anthropic_oauth_code')
    expect(res.rewritten_text).not.toContain(code)
    expect(res.rewritten_text).toContain('[secret stored as vault:')
    expect([...store.values()]).toContain(code)
  })
})

// ─── Channel B — context rule structural tests ────────────────────────────────

describe('auth-flow context rule — Channel B (structural wiring in gateway.ts)', () => {
  const src = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('declares awaitingAuthCodeAt map and AUTH_CODE_CONTEXT_TTL_MS constant', () => {
    expect(src).toMatch(/const awaitingAuthCodeAt = new Map<string, number>/)
    expect(src).toMatch(/AUTH_CODE_CONTEXT_TTL_MS\s*=\s*5\s*\*\s*60_000/)
  })

  it('sets awaitingAuthCodeAt near the "Paste the browser code here" prompt (before or after)', () => {
    // awaitingAuthCodeAt.set is armed before the ForceReply attempt so that a
    // switchroomReply throw doesn't leave Channel B unarmed. Verify it lives
    // within 500 chars of the prompt string in either direction.
    const promptIdx = src.indexOf("'📋 Paste the browser code here ↓'")
    expect(promptIdx).toBeGreaterThan(0)
    const start = Math.max(0, promptIdx - 500)
    const window = src.slice(start, promptIdx + 500)
    expect(window).toMatch(/awaitingAuthCodeAt\.set\(/)
  })

  it('clears awaitingAuthCodeAt (delete) in the inbound handler when the flag is active', () => {
    // The inbound handler must call delete after reading the flag
    expect(src).toMatch(/awaitingAuthCodeAt\.delete\(chat_id\)/)
  })

  it('checks isAuthFlowContext in the secret-detect block (passphrase path)', () => {
    const pipelineIdx = src.indexOf('runPipeline({')
    expect(pipelineIdx).toBeGreaterThan(0)
    // After the pipeline call, isAuthFlowContext must gate the fallback branch
    const tail = src.slice(pipelineIdx, pipelineIdx + 2000)
    expect(tail).toMatch(/isAuthFlowContext/)
  })

  it('checks isAuthFlowContext in the no-passphrase path (deferred branch)', () => {
    // The no-passphrase branch must also check isAuthFlowContext so a context
    // hit is deferred even without a cached passphrase. (Window widened in
    // #44's PR — the comment block above the branch grew when the legacy
    // "/vault list + re-paste" UX got replaced with the inline-button
    // flow; the structural invariant we're pinning is unchanged.)
    const noPpIdx = src.indexOf('No passphrase cached — detect, but defer')
    expect(noPpIdx).toBeGreaterThan(0)
    const window = src.slice(noPpIdx, noPpIdx + 1200)
    expect(window).toMatch(/isAuthFlowContext/)
  })

  it('reaps awaitingAuthCodeAt in the TTL reaper alongside other pending-state maps', () => {
    // The pendingStateReaper interval must sweep expired auth-code-context entries
    const reaperIdx = src.indexOf('pendingStateReaper = setInterval')
    expect(reaperIdx).toBeGreaterThan(0)
    const reaperBlock = src.slice(reaperIdx, reaperIdx + 800)
    expect(reaperBlock).toMatch(/awaitingAuthCodeAt/)
    expect(reaperBlock).toMatch(/AUTH_CODE_CONTEXT_TTL_MS/)
  })

  it('auth-flow context rule sits BEFORE recordInbound() and broadcast()', () => {
    const contextIdx = src.indexOf('isAuthFlowContext')
    const recordIdx = src.indexOf('recordInbound(', contextIdx)
    const broadcastIdx = src.indexOf('ipcServer.broadcast(inboundMsg)', contextIdx)
    expect(contextIdx).toBeGreaterThan(0)
    expect(recordIdx).toBeGreaterThan(contextIdx)
    expect(broadcastIdx).toBeGreaterThan(contextIdx)
  })
})

// ─── New tests for reviewer-requested coverage ────────────────────────────────

// Test 1: Negative URL test — Channel A regex must NOT match real URLs with
// long path segments + long fragment anchors (Blocker 2 regression test).
describe('anthropic_oauth_code pattern — URL false-positive regression', () => {
  it('does NOT match a URL with long path segment and long fragment (inline in sentence)', () => {
    const text = 'see https://docs.com/getting-started-tutorial#installation-and-setup-guide for details'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)
  })

  it('does NOT match a markdown link with long path + long anchor', () => {
    const text = '[docs](https://docs.com/getting-started-tutorial#installation-and-setup-guide)'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)
  })

  it('does NOT match a GitHub permalink URL (long path + long heading anchor)', () => {
    const text = 'See https://github.com/owner/repo/blob/main/README.md#installation-and-setup-guide for info.'
    const d = detectSecrets(text)
    expect(d.some((h) => h.rule_id === 'anthropic_oauth_code')).toBe(false)
  })
})

// Test 2: Blocker 1 sequencing — structural check that deleteMessage is called
// inside the pendingReauthFlows intercept path, before setMessageReaction.
describe('pendingReauthFlows intercept — deleteMessage sequencing (Blocker 1)', () => {
  const src = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('redacts the OAuth code message inside the pendingReauthFlows intercept', () => {
    // Locate the pendingReauthFlows intercept block. Was previously
    // checked by greppinng for `bot.api.deleteMessage(...)` and
    // `setMessageReaction(...)` literals, but #488 consolidated all 6
    // auth-code paste paths through `redactAuthCodeMessage`. The pin
    // is now: the intercept block must call the helper.
    const interceptIdx = src.indexOf('// Auth-code intercept')
    expect(interceptIdx).toBeGreaterThan(0)

    // Find the end of this intercept block — the next blank line after
    // the redaction call. Bounds the window so we don't accidentally
    // match a downstream auth-code path's redaction.
    const window = src.slice(interceptIdx, interceptIdx + 2000)
    // Allow the optional 4th `log` argument added in #561 (diagnostic
     // sink for redaction failures) — required is the first three args.
     expect(window).toMatch(/redactAuthCodeMessage\(bot\.api,\s*chat_id,\s*msgId(?:,\s*[^)]+)?\)/)
  })

  it('redaction lands AFTER the success/error reply renders', () => {
    // Sequencing pin: the user-visible reply (success or error) must
    // be queued before the redaction so the user sees the auth result
    // even if their original message disappears mid-render. Same
    // ordering the helper preserves — fire-and-forget redaction
    // happens after `await switchroomReply(...)`.
    const interceptIdx = src.indexOf('// Auth-code intercept')
    const window = src.slice(interceptIdx, interceptIdx + 2000)
    const replyIdx = window.indexOf('switchroomReply(ctx,')
    const redactIdx = window.indexOf('redactAuthCodeMessage(')
    expect(replyIdx).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(0)
    expect(replyIdx).toBeLessThan(redactIdx)
  })
})

// Test 3: Flag consumption — awaitingAuthCodeAt is NOT cleared on a non-detection
// inbound (a stray "ok" within the 5-min window should not disarm Channel B).
describe('awaitingAuthCodeAt flag — consumption only on actual detection', () => {
  const src = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('delete(chat_id) does NOT appear at the top of the isAuthFlowContext block (no early consume)', () => {
    // The old bug: delete fired unconditionally inside `if (isAuthFlowContext)`.
    // After the fix, there must be no `awaitingAuthCodeAt.delete` within
    // the isAuthFlowContext guard block itself — only in the downstream branches.
    const contextIdx = src.indexOf('const isAuthFlowContext =')
    expect(contextIdx).toBeGreaterThan(0)
    // Grab the isAuthFlowContext if-block (ends at the next blank line after the log line)
    const logLineEnd = src.indexOf('\n', src.indexOf('[secret-detect] auth-flow context rule active', contextIdx))
    const guardBlock = src.slice(contextIdx, logLineEnd + 5)
    // Must NOT contain a delete call in the guard itself
    expect(guardBlock).not.toMatch(/awaitingAuthCodeAt\.delete/)
  })

  it('awaitingAuthCodeAt.delete appears inside the Channel B fallback branch (pipeRes.stored === 0)', () => {
    // Verify the consume is co-located with the actual auth-flow handling
    const fallbackIdx = src.indexOf('Channel B fallback: pattern didn\'t fire')
    expect(fallbackIdx).toBeGreaterThan(0)
    // Within 400 chars after the comment, delete must appear
    const window = src.slice(fallbackIdx, fallbackIdx + 400)
    expect(window).toMatch(/awaitingAuthCodeAt\.delete\(chat_id\)/)
  })

  it('awaitingAuthCodeAt.delete appears inside the no-passphrase hasHigh branch', () => {
    const noPpIdx = src.indexOf('No passphrase cached — detect, but defer')
    expect(noPpIdx).toBeGreaterThan(0)
    // Window widened — see the matching note on the
    // "checks isAuthFlowContext in the no-passphrase path" test.
    const window = src.slice(noPpIdx, noPpIdx + 1200)
    // Conditional consume: only fires if isAuthFlowContext
    expect(window).toMatch(/if \(isAuthFlowContext\)/)
    expect(window).toMatch(/awaitingAuthCodeAt\.delete\(chat_id\)/)
  })
})

// Test 4: Armer-outside-catch — awaitingAuthCodeAt.set is before the try block,
// so if switchroomReply throws, Channel B is still armed.
describe('awaitingAuthCodeAt.set — arming is unconditional (outside catch)', () => {
  const src = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('awaitingAuthCodeAt.set appears BEFORE switchroomReply inside the formatted.url block', () => {
    const urlBlockIdx = src.indexOf('if (formatted.url)')
    expect(urlBlockIdx).toBeGreaterThan(0)
    const urlBlock = src.slice(urlBlockIdx, urlBlockIdx + 800)
    const setIdx = urlBlock.indexOf('awaitingAuthCodeAt.set(')
    const replyIdx = urlBlock.indexOf("'📋 Paste the browser code here ↓'")
    expect(setIdx).toBeGreaterThan(0)
    expect(replyIdx).toBeGreaterThan(0)
    // The .set must come BEFORE the ForceReply switchroomReply call
    expect(setIdx).toBeLessThan(replyIdx)
  })

  it('awaitingAuthCodeAt.set is NOT inside the inner try block', () => {
    // The inner try starts with "await switchroomReply(ctx, '📋 Paste..."
    // The .set should appear before that try keyword in the formatted.url block
    const urlBlockIdx = src.indexOf('if (formatted.url)')
    const urlBlock = src.slice(urlBlockIdx, urlBlockIdx + 800)
    const setIdx = urlBlock.indexOf('awaitingAuthCodeAt.set(')
    // Find the try block that wraps the ForceReply call
    const innerTryIdx = urlBlock.indexOf('try {', setIdx)
    // The inner try (ForceReply try block) must come AFTER the .set call
    expect(innerTryIdx).toBeGreaterThan(setIdx)
  })
})
