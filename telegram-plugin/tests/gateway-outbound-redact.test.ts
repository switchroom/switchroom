import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural test for the outbound secret-scrub (#2044).
 *
 * Outbound (agent→user) text previously had NO redaction — an agent that
 * echoed a secret it read from a file/env/not-yet-vaulted value would send
 * the raw bytes to Telegram, log a preview to stderr, and store them in
 * history. This pins that `redactOutboundText()` runs at the ENTRY of each
 * agent-free-text tool (reply / stream_reply / edit_message), before the
 * stderr preview, the dedup key, the send, and the history record.
 *
 * Why structural: executeReply/executeStreamReply/executeEditMessage are
 * not exported (same constraint as gateway-secret-detect.test.ts). The
 * masking itself — that `redact()` covers the Sanctum shape and every
 * provider token — is exercised behaviorally in secret-detect-sanctum.test.ts
 * and the redact() unit tests; what's left to pin here is the wiring + slot.
 */
describe('gateway outbound secret-scrub — structural wiring', () => {
  const src = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  it('imports the shared redactor', () => {
    expect(src).toMatch(/import \{ redact \} from '\.\.\/secret-detect\/redact\.js'/)
  })

  it('defines the redactOutboundText helper backed by redact()', () => {
    const idx = src.indexOf('function redactOutboundText(')
    expect(idx).toBeGreaterThan(0)
    const body = src.slice(idx, idx + 400)
    expect(body).toMatch(/redact\(text\)/)
  })

  it('reply: scrubs at entry, before the stderr preview log', () => {
    const start = src.indexOf('async function executeReply(')
    const redactIdx = src.indexOf(`redactOutboundText(text, 'reply')`, start)
    const previewIdx = src.indexOf('reply: invoked chatId=', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(previewIdx).toBeGreaterThan(redactIdx) // mask BEFORE the preview is logged
  })

  it('stream_reply: scrubs at entry, before the voice scrub + dedup', () => {
    const start = src.indexOf('async function executeStreamReply(')
    const redactIdx = src.indexOf(`redactOutboundText(args.text as string, 'stream_reply')`, start)
    const scrubIdx = src.indexOf(`site: 'stream_reply'`, start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(scrubIdx).toBeGreaterThan(redactIdx)
  })

  it('edit_message: scrubs at entry, before the voice scrub + send', () => {
    const start = src.indexOf('async function executeEditMessage(')
    const redactIdx = src.indexOf(`redactOutboundText(editRawText, 'edit_message')`, start)
    const scrubIdx = src.indexOf(`site: 'edit_message'`, start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(scrubIdx).toBeGreaterThan(redactIdx)
  })

  it('does not log the secret value when a mask fires', () => {
    const idx = src.indexOf('function redactOutboundText(')
    const body = src.slice(idx, idx + 400)
    // The log line names the site, never the text/masked value.
    expect(body).toMatch(/outbound secret masked site=\$\{site\}/)
    expect(body).not.toMatch(/\$\{text\}|\$\{masked\}/)
  })
})
