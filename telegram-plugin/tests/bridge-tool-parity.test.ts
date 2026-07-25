import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEffectiveToolSchemas } from '../bridge/tool-filter.js'

/**
 * Half-wiring guard: every tool the gateway is willing to EXECUTE must be
 * ADVERTISED by the bridge's MCP surface.
 *
 * The failure this pins (observed live 2026-07-25): `progress_update` was in
 * the gateway's `ALLOWED_TOOLS` allowlist and had a full `executeProgressUpdate`
 * implementation, but it was never carried over into `bridge/bridge.ts`'s
 * `TOOL_SCHEMAS` when the legacy `server.ts` monolith was deleted (5496f792,
 * Wave 3 F4). The monolith had registered it (7206817a); the bridge never did.
 * Result: the tool was documented in every sub-agent's system prompt, executable
 * by the gateway, and completely unreachable — a sub-agent calling it got
 * "No such tool available". Nothing failed loudly; the capability just silently
 * did not exist for ~14 months.
 *
 * Why structural (source text, not imports): `gateway.ts` has heavy import-time
 * side effects (socket bind, bot construction) and `bridge.ts` exits the process
 * at import when no gateway socket is present, so neither can be imported into a
 * unit test. Both lists are plain string literals in source, so parsing them is
 * exact and cheap. If either declaration is refactored out of the shape these
 * regexes expect, the test FAILS (it never silently degrades to a no-op) —
 * update the parser, don't delete the assertion.
 */

const PLUGIN_DIR = join(import.meta.dirname, '..')

function readSource(rel: string): string {
  return readFileSync(join(PLUGIN_DIR, rel), 'utf8')
}

/** Tool names in the gateway's IPC execution allowlist (`ALLOWED_TOOLS`). */
function gatewayAllowedTools(): string[] {
  const src = readSource('gateway/gateway.ts')
  const m = src.match(/const ALLOWED_TOOLS = new Set\(\[([\s\S]*?)\]\)/)
  if (m == null) throw new Error('could not locate ALLOWED_TOOLS in gateway/gateway.ts')
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])
}

/** Tool names advertised by the bridge's MCP `tools/list` (`TOOL_SCHEMAS`). */
function bridgeToolSchemaNames(): string[] {
  const src = readSource('bridge/bridge.ts')
  const m = src.match(/const TOOL_SCHEMAS = \[([\s\S]*?)\n\]\n/)
  if (m == null) throw new Error('could not locate TOOL_SCHEMAS in bridge/bridge.ts')
  return [...m[1].matchAll(/^ {4}name: '([a-z0-9_]+)',$/gm)].map((x) => x[1])
}

/**
 * Tools deliberately executable-but-unadvertised. EMPTY on purpose.
 *
 * Adding a name here is a decision to make a capability unreachable by the
 * model — it needs a comment naming the reason, not just an entry. The whole
 * point of this file is that the omission is explicit and reviewed rather than
 * an accident of a refactor.
 */
const INTENTIONALLY_UNADVERTISED: ReadonlySet<string> = new Set([])

describe('bridge MCP tool surface ↔ gateway ALLOWED_TOOLS parity', () => {
  it('parses both declarations (guards against a silently no-op test)', () => {
    expect(gatewayAllowedTools().length).toBeGreaterThan(15)
    expect(bridgeToolSchemaNames().length).toBeGreaterThan(15)
  })

  it('advertises every gateway-executable tool', () => {
    const advertised = new Set(bridgeToolSchemaNames())
    const missing = gatewayAllowedTools().filter(
      (t) => !advertised.has(t) && !INTENTIONALLY_UNADVERTISED.has(t),
    )
    expect(missing).toEqual([])
  })

  it('advertises no tool the gateway would refuse to execute', () => {
    const allowed = new Set(gatewayAllowedTools())
    const orphans = bridgeToolSchemaNames().filter((t) => !allowed.has(t))
    expect(orphans).toEqual([])
  })

  it('registers progress_update — the tool this guard was written for', () => {
    expect(bridgeToolSchemaNames()).toContain('progress_update')
    expect(gatewayAllowedTools()).toContain('progress_update')
  })

  it('keeps progress_update reachable through the tool-surface filter', () => {
    // The Linear gate (tool-filter.ts) must not strip it, with or without a
    // Linear connection: an unregistered-in-effect tool is the same outage.
    const schemas = bridgeToolSchemaNames().map((name) => ({ name }))
    for (const linearEnabled of [false, true]) {
      const names = buildEffectiveToolSchemas(schemas, { linearEnabled }).map((t) => t.name)
      expect(names).toContain('progress_update')
    }
  })
})
