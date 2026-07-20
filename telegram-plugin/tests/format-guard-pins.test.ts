/**
 * Pin tests for the accidental-formatting guard (#3252/#3463).
 *
 * Two internal-hardening assertions, no user-visible change:
 *
 *  1. Documents the `#{1,6}` cap in ACCIDENTAL_HEADING as intentional: a run of
 *     7+ `#` glued to non-space is left UNescaped (CommonMark caps heading
 *     promotion at 6 `#`, and the guard mirrors that). Correctness-audit F2
 *     flagged this as asserted-but-untested.
 *
 *  2. A wiring assertion that PR1's `installRichMarkdownGuard` transformer is
 *     actually installed on the production Bot in `initGatewayBot()`, so the
 *     universal seam can't be silently dropped in a later refactor. Grammy's
 *     installed transformers are anonymous fns (nothing to grip at runtime), so
 *     this is a source-level AST assertion on the boot path — the same approach
 *     `gateway-bot-construction-deferral.test.ts` uses.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { guardAccidentalFormatting } from '../rich-send.js'
import { guardAccidentalHeading } from '../render/line-start-guard.js'

describe('accidental-heading guard: #{1,6} cap is intentional (F2)', () => {
  it('escapes a 6-# run glued to non-space (upper bound of the cap)', () => {
    expect(guardAccidentalHeading('######x')).toBe('\\######x')
    expect(guardAccidentalFormatting('######x')).toBe('\\######x')
  })

  it('leaves a 7-# run glued to non-space UNescaped (past the CommonMark cap)', () => {
    expect(guardAccidentalHeading('#######x')).toBe('#######x')
    expect(guardAccidentalFormatting('#######x')).toBe('#######x')
  })

  it('leaves an 8+-# run glued to non-space UNescaped', () => {
    expect(guardAccidentalHeading('##########x')).toBe('##########x')
    expect(guardAccidentalFormatting('##########x')).toBe('##########x')
  })
})

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_PATH = resolve(__dirname, '..', 'gateway', 'gateway.ts')
const GATEWAY_SRC = readFileSync(GATEWAY_PATH, 'utf8')
const sourceFile = ts.createSourceFile(
  GATEWAY_PATH,
  GATEWAY_SRC,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)

function findFunction(name: string): ts.FunctionDeclaration | undefined {
  for (const s of sourceFile.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s
  }
  return undefined
}

function countCallsTo(root: ts.Node, name: string): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      count++
      // Installed on the constructed bot instance.
      expect(node.arguments[0]?.getText(sourceFile)).toBe('bot')
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return count
}

describe('boot wiring: installRichMarkdownGuard is installed on the production Bot', () => {
  it('imports installRichMarkdownGuard from ../shared/bot-runtime.js', () => {
    // The import must exist for the boot call to resolve; a refactor that drops
    // the import would break the seam.
    expect(GATEWAY_SRC).toMatch(
      /import\s*\{[^}]*\binstallRichMarkdownGuard\b[^}]*\}\s*from\s*'\.\.\/shared\/bot-runtime\.js'/,
    )
  })

  it('calls installRichMarkdownGuard(bot) exactly once inside initGatewayBot()', () => {
    const fn = findFunction('initGatewayBot')
    expect(fn?.body).toBeDefined()
    expect(countCallsTo(fn!.body!, 'installRichMarkdownGuard')).toBe(1)
  })
})
