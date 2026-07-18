import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Structural test for the `request_secret` tool (#2045) — the secure
 * "agent asks the operator to PROVIDE a missing secret" flow. The operator
 * taps [Provide securely], sends the value once, and the gateway deletes it
 * + writes it straight to the vault; the raw value is never recorded,
 * logged, or returned to the agent.
 *
 * Structural because the gateway handlers (handleInbound, executeToolCall,
 * the callback router) aren't exported — same constraint as
 * gateway-secret-detect.test.ts. The vault-write reuse + card UX are
 * exercised end-to-end by the mtcute UAT (jtbd-request-secret-dm).
 */
describe('request_secret — gateway wiring', () => {
  const gw = readFileSync(new URL('../gateway/gateway.ts', import.meta.url), 'utf8')
  // executeRequestSecret moved verbatim to card-tool-handlers.ts (#2996 P5-tail);
  // the handler-body pins below read that module. The dispatch case + the
  // secure-capture path (captureProvidedSecret / handleInbound) stay in gateway.ts.
  const cardTool = readFileSync(new URL('../gateway/card-tool-handlers.ts', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../bridge/bridge.ts', import.meta.url), 'utf8')

  it('declares the MCP tool with required {chat_id,key} and NO value arg', () => {
    const idx = bridge.indexOf(`name: 'request_secret'`)
    expect(idx).toBeGreaterThan(0)
    const schema = bridge.slice(idx, idx + 3000)
    expect(schema).toMatch(/required: \['chat_id', 'key'\]/)
    // The whole point: the agent does NOT supply the value.
    expect(schema).not.toMatch(/\bvalue:\s*\{/)
    // Tells the agent never to ask for a chat paste.
    expect(schema).toMatch(/NEVER ask the user to paste/i)
  })

  it('is allow-listed and dispatched', () => {
    expect(gw).toMatch(/'request_secret',\n/)
    expect(gw).toMatch(/case 'request_secret':\s*\n\s*return cardToolHandlers\.executeRequestSecret\(args\)/)
  })

  it('routes the vsp: callback', () => {
    expect(gw).toMatch(/data\.startsWith\('vsp:'\)/)
    expect(gw).toMatch(/handleSecretRequestCallback\(ctx, data\)/)
  })

  it('captures the provided value BEFORE recordInbound and the broadcast', () => {
    const start = gw.indexOf('async function handleInbound(')
    const captureIdx = gw.indexOf('captureProvidedSecret(ctx, chat_id', start)
    const recordIdx = gw.indexOf('recordInbound(', captureIdx)
    const broadcastIdx = gw.indexOf('ipcServer.broadcast(inboundMsg)', captureIdx)
    expect(captureIdx).toBeGreaterThan(start)
    expect(recordIdx).toBeGreaterThan(captureIdx)
    expect(broadcastIdx).toBeGreaterThan(captureIdx)
  })

  it('the capture deletes the raw message and writes to the vault, then returns', () => {
    const idx = gw.indexOf('async function captureProvidedSecret(')
    expect(idx).toBeGreaterThan(0)
    const body = gw.slice(idx, idx + 3600)
    // delete the raw message before anything else
    expect(body).toMatch(/deleteSensitiveMessage\(chat_id, msgId/)
    // write via the posture/passphrase helper
    expect(body).toMatch(/writeRequestedSecret\(armed\.key, value, chat_id\)/)
  })

  it('the agent-resume inbound carries the key but NOT the value', () => {
    const idx = gw.indexOf('async function captureProvidedSecret(')
    const body = gw.slice(idx, idx + 3600)
    const syntheticIdx = body.indexOf("source: 'secret_provided'")
    expect(syntheticIdx).toBeGreaterThan(0)
    // The synthetic text references vault:<key>, never the raw `value`.
    expect(body).toMatch(/vault:\$\{armed\.key\}/)
    const textIdx = body.lastIndexOf('text:', syntheticIdx)
    const metaIdx = body.indexOf('meta:', syntheticIdx)
    expect(body.slice(textIdx, metaIdx)).not.toMatch(/\$\{value\}/)
  })

  it('dedupes to one open request per (chat,key)', () => {
    const idx = cardTool.indexOf('async function executeRequestSecret(')
    const body = cardTool.slice(idx, idx + 1800)
    expect(body).toMatch(/p\.chat_id === chat_id && p\.key === key/)
  })
})
