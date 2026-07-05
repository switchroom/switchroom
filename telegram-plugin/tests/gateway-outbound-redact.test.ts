import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural test for the outbound secret-scrub (#2044).
 *
 * Outbound (agent→user) text previously had NO redaction — an agent that
 * echoed a secret it read from a file/env/not-yet-vaulted value would send
 * the raw bytes to Telegram, log a preview to stderr, and store them in
 * history. This pins that `redactOutboundText()` runs at the ENTRY of each
 * agent-free-text tool (reply / edit_message), before the
 * stderr preview, the dedup key, the send, and the history record.
 *
 * Why structural: executeReply/executeEditMessage are
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

  it('edit_message: scrubs at entry, before the voice scrub + send', () => {
    const start = src.indexOf('async function executeEditMessage(')
    const redactIdx = src.indexOf(`redactOutboundText(editRawText, 'edit_message')`, start)
    const scrubIdx = src.indexOf(`site: 'edit_message'`, start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(scrubIdx).toBeGreaterThan(redactIdx)
  })

  it('turn-flush backstop: scrubs the model terminal prose before send', () => {
    // Turn-flush delivers the model's answer when it skipped reply/stream_reply
    // — arbitrary agent free-text that hits the wire + stderr preview.
    const redactIdx = src.indexOf(`redactOutboundText(capturedText, 'turn_flush')`)
    const scrubSiteIdx = src.indexOf(`site: 'turn_flush'`)
    expect(redactIdx).toBeGreaterThan(0)
    expect(scrubSiteIdx).toBeGreaterThan(redactIdx) // mask BEFORE the voice scrub + send
  })

  it('progress_update: scrubs at entry, BEFORE the 300-char truncation', () => {
    // progress_update was the only send site not calling redactOutboundText.
    // The mask MUST run before the truncation so a secret straddling the
    // 300-char cut can't be sliced apart and evade the token-shape detector.
    const start = src.indexOf('async function executeProgressUpdate(')
    const redactIdx = src.indexOf(`redactOutboundText(text, 'progress_update')`, start)
    const truncIdx = src.indexOf('Truncate to 300 chars', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(truncIdx).toBeGreaterThan(redactIdx) // mask BEFORE the slice
  })

  it('does not log the secret value when a mask fires', () => {
    const idx = src.indexOf('function redactOutboundText(')
    const body = src.slice(idx, idx + 400)
    // The log line names the site, never the text/masked value.
    expect(body).toMatch(/outbound secret masked site=\$\{site\}/)
    expect(body).not.toMatch(/\$\{text\}|\$\{masked\}/)
  })
})
