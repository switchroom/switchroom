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
    // #2996: the entry pipeline (normalize → redact → punctuation/bold →
    // voice-scrub) is extracted into outbound-send-path.ts. The reply path now
    // delegates via `normalizeOutboundBody(rawText, 'reply', redactOutboundText)`
    // — the injected redactor still runs at entry, before the stderr preview.
    const start = src.indexOf('async function executeReply(')
    const redactIdx = src.indexOf(`normalizeOutboundBody(rawText, 'reply', redactOutboundText)`, start)
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

  it('ask_user: redacts question + option labels at entry, BEFORE the send', () => {
    // F1 — ask_user sent the question + button labels unredacted. The scrub
    // must run at the top of executeAskUser (via redactAskUserFields), before
    // the keyboard is built and the question is sent to Telegram.
    const start = src.indexOf('async function executeAskUser(')
    const redactIdx = src.indexOf('redactAskUserFields(args.question, args.options', start)
    const keyboardIdx = src.indexOf('const keyboard = new InlineKeyboard()', start)
    const sendIdx = src.indexOf('sendRichMessage(args.chatId, richMessage(args.question)', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(keyboardIdx).toBeGreaterThan(redactIdx) // mask BEFORE labels become buttons
    expect(sendIdx).toBeGreaterThan(redactIdx) // mask BEFORE the question is sent
  })

  it('send_checklist: redacts title + task text BEFORE rawSendChecklist', () => {
    // F2 — checklist title + task strings were sent unredacted.
    const start = src.indexOf('async function executeSendChecklist(')
    const redactIdx = src.indexOf('redactChecklistFields(', start)
    const sendIdx = src.indexOf('rawSendChecklist({', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(sendIdx).toBeGreaterThan(redactIdx) // mask BEFORE the send
  })

  it('update_checklist: redacts title + task text BEFORE rawEditMessageChecklist', () => {
    // F2 sibling — update_checklist shares the identical leak class.
    const start = src.indexOf('async function executeUpdateChecklist(')
    const redactIdx = src.indexOf('redactChecklistFields(', start)
    const editIdx = src.indexOf('rawEditMessageChecklist({', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(editIdx).toBeGreaterThan(redactIdx) // mask BEFORE the edit
  })

  it('pty draft-preview: redacts at the gateway boundary BEFORE the stream', () => {
    // F3 — the PTY-tail partial (assistant reply text extracted from the TUI)
    // forwards straight to the draft-preview stream. Mask at the top of
    // handlePtyPartial, before it hands off to handlePtyPartialPure.
    const start = src.indexOf('function handlePtyPartial(text: string): void {')
    const redactIdx = src.indexOf(`redactOutboundText(text, 'pty_preview')`, start)
    const pureIdx = src.indexOf('handlePtyPartialPure(text, state', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(pureIdx).toBeGreaterThan(redactIdx) // mask BEFORE the stream push
  })

  it('pty activity: redacts at the gateway boundary BEFORE the stream', () => {
    // F3 — the (currently-unwired) PTY-activity lane is masked too so the fix
    // is durable if it is ever re-armed.
    const start = src.indexOf('function handlePtyActivity(text: string): void {')
    const redactIdx = src.indexOf(`redactOutboundText(text, 'pty_activity')`, start)
    const streamIdx = src.indexOf('handleStreamReply(', start)
    expect(start).toBeGreaterThan(0)
    expect(redactIdx).toBeGreaterThan(start)
    expect(streamIdx).toBeGreaterThan(redactIdx) // mask BEFORE the stream
  })

  it('does not log the secret value when a mask fires', () => {
    const idx = src.indexOf('function redactOutboundText(')
    const body = src.slice(idx, idx + 400)
    // The log line names the site, never the text/masked value.
    expect(body).toMatch(/outbound secret masked site=\$\{site\}/)
    expect(body).not.toMatch(/\$\{text\}|\$\{masked\}/)
  })
})
