/**
 * pin_message tool retirement (#4452).
 *
 * The agent-facing `pin_message` MCP tool was removed: agents may no longer
 * hand-pin arbitrary messages. The framework's OWN auto-pin
 * (`pin_status_while_working` — the status/activity card and the 🛠 Worker
 * card) is unaffected; that is the one sanctioned pin and is exercised by
 * status-pin-lifecycle.test.ts.
 *
 * These are OUTCOME assertions on the actual offered surface — they fail if the
 * tool is ever re-registered in the bridge schema, re-wired into the gateway
 * dispatch, or re-granted in the agent scaffold. bridge.ts and gateway.ts each
 * run boot side-effects at import (a top-level `await main()` / the gateway boot
 * IIFE), so they cannot be imported here; we assert against their source, which
 * IS the registration surface.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('pin_message MCP tool is retired (#4452)', () => {
  it('is NOT registered as a bridge tool schema', () => {
    const bridge = read('../bridge/bridge.ts')
    // The tool-schema registration form is `name: 'pin_message'`. Its absence
    // means ListTools no longer offers it to the agent.
    expect(bridge).not.toMatch(/name:\s*['"]pin_message['"]/)
  })

  it('is NOT in the gateway IPC tool allowlist and has no dispatch case', () => {
    const gateway = read('../gateway/gateway.ts')
    // ALLOWED_TOOLS gate: a bridge could not invoke it even by name.
    expect(gateway).not.toMatch(/['"]pin_message['"]/)
    // No dispatch arm and no handler.
    expect(gateway).not.toMatch(/case\s+['"]pin_message['"]/)
    expect(gateway).not.toContain('executePinMessage')
  })

  it('is NOT granted in the agent scaffold permission surface', () => {
    const scaffold = read('../../src/agents/scaffold.ts')
    expect(scaffold).not.toContain('mcp__switchroom-telegram__pin_message')
  })

  // Sanity: prove the assertions above are meaningful by confirming a tool that
  // SURVIVED is still present in each surface (a test that can't fail is not a
  // test — this pins the read paths to real content).
  it('a surviving tool (delete_message) is still registered — guards false-green', () => {
    expect(read('../bridge/bridge.ts')).toMatch(/name:\s*['"]delete_message['"]/)
    expect(read('../gateway/gateway.ts')).toContain('executeDeleteMessage')
    expect(read('../../src/agents/scaffold.ts')).toContain(
      'mcp__switchroom-telegram__delete_message',
    )
  })

  it('the framework auto status-pin machinery is untouched', () => {
    // Change 1 must not disturb pin_status_while_working (the ONE sanctioned pin).
    const gateway = read('../gateway/gateway.ts')
    expect(gateway).toContain('PIN_STATUS_WHILE_WORKING')
    expect(gateway).toContain('runStatusPinBootCleanup')
    void here
  })
})
