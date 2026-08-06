/**
 * Call-site pin for the gateway-owned session-start privacy reset (PR3).
 *
 * The whole point of PR3 (FIX 2 / FIX 3) is that the reset fires on GENUINE new
 * sessions and is EXEMPT on paths that reattach to a persisting session. That
 * is a wiring invariant, not a behavior a unit test on the module can observe —
 * so this test parses gateway.ts and asserts WHERE `resetPrivacyForNewSession`
 * is (and is not) called, the same source-parsing approach as
 * `gateway-handler-registration-wiring.test.ts`.
 *
 * Instrumented (must call resetPrivacyForNewSession):
 *   - the `'boot'` boot-card branch (cold start / crash / planned restart)
 *   - the `bot.command('clear')` handler
 *   - the idle-clear dispatch (`maybeIdleClear`)
 *
 * Exempt by construction (must NOT call it):
 *   - `bridge-reconnect` (reattaches to a persisting session)
 *   - `bot.command('compact')` and resume/continue
 *
 * Run: npx vitest run telegram-plugin/tests/privacy-reset-call-sites.test.ts
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_PATH = resolve(__dirname, '..', 'gateway', 'gateway.ts')
const GATEWAY_SRC = readFileSync(GATEWAY_PATH, 'utf8')
const RESET = 'resetPrivacyForNewSession'

const sourceFile = ts.createSourceFile(
  GATEWAY_PATH,
  GATEWAY_SRC,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)

/** Line number (1-based) of every CALL to `resetPrivacyForNewSession(...)`. */
function resetCallLines(): number[] {
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === RESET
    ) {
      lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return lines.sort((a, b) => a - b)
}

/** The enclosing function/arrow name for a source line, best-effort. */
function enclosingContext(line: number): string {
  const idx = line - 1
  // Walk upward for the nearest recognizable anchor.
  const lines = GATEWAY_SRC.split('\n')
  for (let i = idx; i >= 0 && i > idx - 200; i--) {
    const t = lines[i]
    if (/bot\.command\('clear'/.test(t)) return 'command:clear'
    if (/function maybeIdleClear/.test(t)) return 'maybeIdleClear'
    if (/resolveBootChatId\(marker, markerAgeMs\)/.test(t)) return 'boot'
  }
  return 'unknown'
}

describe('privacy reset call sites (PR3 FIX 2 / FIX 3)', () => {
  it('calls resetPrivacyForNewSession exactly THREE times', () => {
    expect(resetCallLines()).toHaveLength(3)
  })

  it('the three calls are the boot branch, the /clear handler, and idle-clear', () => {
    const contexts = resetCallLines().map(enclosingContext).sort()
    expect(contexts).toEqual(['boot', 'command:clear', 'maybeIdleClear'])
  })

  it('is NOT wired into the bridge-reconnect boot-card path', () => {
    // Scope tightly to the bridge-reconnect block: from its dedupe tag to the
    // `startBootCard(` it posts. The boot-path reset sits right before ITS
    // startBootCard, so if the reconnect path were (wrongly) instrumented the
    // reset would land in this same window. It must not.
    const reconnectIdx = GATEWAY_SRC.indexOf("shouldSkipDuplicateBootCard({ activeBootCard, bootCardPending }, 'bridge-reconnect')")
    expect(reconnectIdx).toBeGreaterThan(-1)
    const reconnectBootCard = GATEWAY_SRC.indexOf('startBootCard(', reconnectIdx)
    expect(reconnectBootCard).toBeGreaterThan(reconnectIdx)
    const window = GATEWAY_SRC.slice(reconnectIdx, reconnectBootCard)
    expect(window.includes(RESET)).toBe(false)
  })

  it("is NOT wired into the /compact handler", () => {
    const compactIdx = GATEWAY_SRC.indexOf("bot.command('compact'")
    const clearIdx = GATEWAY_SRC.indexOf("bot.command('clear'")
    expect(compactIdx).toBeGreaterThan(-1)
    expect(clearIdx).toBeGreaterThan(compactIdx)
    // The compact handler body sits between the compact and clear registrations.
    const compactBody = GATEWAY_SRC.slice(compactIdx, clearIdx)
    expect(compactBody.includes(RESET)).toBe(false)
  })
})
