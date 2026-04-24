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

  it('sets awaitingAuthCodeAt when emitting the "Paste the browser code here" prompt', () => {
    // Find the block that sends the ForceReply prompt and confirm the map.set is nearby
    const promptIdx = src.indexOf("'📋 Paste the browser code here ↓'")
    expect(promptIdx).toBeGreaterThan(0)
    // Within 500 chars after the prompt, awaitingAuthCodeAt.set must appear
    const window = src.slice(promptIdx, promptIdx + 500)
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
    // hit is deferred even without a cached passphrase
    const noPpIdx = src.indexOf('No passphrase cached — detect, but defer')
    expect(noPpIdx).toBeGreaterThan(0)
    const window = src.slice(noPpIdx, noPpIdx + 400)
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
