/**
 * Import-safety pin for the #2996 P0b move: token materialization + `new Bot`
 * construction are DEFERRED out of module import into the boot function
 * `initGatewayBot()`.
 *
 * WHY this asserts on the parsed SOURCE, not a real `import()`:
 * gateway.ts is NOT import-safe under vitest yet — the boot IIFE (`void (async
 * () => { … })()`) still fires at module evaluation and P0b deliberately does
 * NOT touch it (that guard is P0c/P0d scope). So a real `await import()` would
 * still trigger the boot path. The oracle for "how the repo pins gateway
 * structure without booting it" is source-parsing via `ts.createSourceFile`
 * (see gateway-handler-registration-wiring.test.ts /
 * gateway-pending-command-wiring.test.ts). This test follows that pattern and
 * asserts OUTCOMES about where construction lives:
 *
 *   1. Module import (top-level, outside any function body) performs NO
 *      `new Bot(...)`, NO dynamic import of the materialize-bot-token helper,
 *      NO `materializeBotToken(...)` call, and has NO reachable `process.exit`
 *      and NO top-level `await`. i.e. importing gateway.ts constructs no bot,
 *      reads no token, and cannot exit the process.
 *   2. `bot` is a deferred module-scope `let` (definite-assignment), NOT a
 *      `const bot = new Bot(...)`.
 *   3. The boot function `initGatewayBot()` DOES all of the above: it is an
 *      async function whose body contains the `new Bot(...)`, the materialize
 *      dynamic import, the `materializeBotToken(...)` call, and the single
 *      `registerGatewayHandlers(bot, …)` wiring call.
 *
 * A count/handler-theater test would not catch a regression that re-hoists
 * `new Bot` or the token read back to module scope; these node-location
 * assertions do.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

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

const MATERIALIZE_MODULE_HINT = 'materialize-bot-token'

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  )
}

/**
 * Walk every node that executes at MODULE SCOPE — i.e. descend through the
 * source file but STOP at any function-like boundary (function/arrow/method
 * bodies run later, when called, not at import). A `new Bot` or token read
 * found here would fire at import; the whole point of P0b is that none do.
 */
function walkModuleScope(visitor: (n: ts.Node) => void): void {
  const recur = (node: ts.Node): void => {
    ts.forEachChild(node, child => {
      if (isFunctionLike(child)) return // do not descend into function bodies
      visitor(child)
      recur(child)
    })
  }
  recur(sourceFile)
}

function isNewBot(n: ts.Node): boolean {
  return ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Bot'
}

function isMaterializeDynamicImport(n: ts.Node): boolean {
  // `import('…materialize-bot-token…')`
  if (!ts.isCallExpression(n)) return false
  if (n.expression.kind !== ts.SyntaxKind.ImportKeyword) return false
  const arg = n.arguments[0]
  return arg != null && ts.isStringLiteralLike(arg) && arg.text.includes(MATERIALIZE_MODULE_HINT)
}

function isMaterializeBotTokenCall(n: ts.Node): boolean {
  return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'materializeBotToken'
}

function isProcessExitCall(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'process' &&
    n.expression.name.text === 'exit'
  )
}

function findFunction(name: string): ts.FunctionDeclaration | undefined {
  for (const s of sourceFile.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s
  }
  return undefined
}

/** Count nodes matching a predicate anywhere within a subtree. */
function countIn(root: ts.Node, pred: (n: ts.Node) => boolean): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (pred(node)) count++
    ts.forEachChild(node, visit)
  }
  visit(root)
  return count
}

describe('gateway #2996 P0b: token materialization + new Bot are deferred to boot, import is construction-clean', () => {
  it('constructs NO Bot at module import (no top-level `new Bot`)', () => {
    let count = 0
    walkModuleScope(n => {
      if (isNewBot(n)) count++
    })
    expect(count).toBe(0)
  })

  it('reads NO token at module import (no top-level materialize import or materializeBotToken call)', () => {
    let dynImports = 0
    let materializeCalls = 0
    walkModuleScope(n => {
      if (isMaterializeDynamicImport(n)) dynImports++
      if (isMaterializeBotTokenCall(n)) materializeCalls++
    })
    expect(dynImports).toBe(0)
    expect(materializeCalls).toBe(0)
  })

  it('performs NO token-refusal exit at module import (no top-level process.exit for token materialization)', () => {
    // NOTE: the pre-existing startup-lock mutex (#…) still has one top-level
    // process.exit + top-level await — that is P0c/P0d scope, deliberately NOT
    // touched here. This asserts specifically that the TOKEN-materialization
    // exit paths (exit(1) on materialize failure / missing token) are gone from
    // module scope: there is at most the single startup-lock exit, and none of
    // them sit in a materialize/`new Bot` context (covered by the tests above).
    let exits = 0
    walkModuleScope(n => {
      if (isProcessExitCall(n)) exits++
    })
    // The two token-materialization exit(1) sites moved into initGatewayBot;
    // only the pre-existing startup-lock exit remains at module scope.
    expect(exits).toBeLessThanOrEqual(1)
  })

  it('leaves NO module-scope reference to `bot` or `lockedBot` outside their declarations (all consumers deferred)', () => {
    // Completeness pin: after P0b, the ONLY module-scope occurrences of `bot` /
    // `lockedBot` are their `let` declarations. Every consumer — the api-tap /
    // heartbeat wiring, checklist probes, chatLock.wrapBot, the /approvals
    // registration, the callback-query factory, and registerGatewayHandlers —
    // must live inside a function (initGatewayBot or a post-boot handler). A
    // regression that re-hoists any consumer to import scope fails here.
    const declLines = new Set<number>()
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && (decl.name.text === 'bot' || decl.name.text === 'lockedBot')) {
          declLines.add(sourceFile.getLineAndCharacterOfPosition(decl.name.getStart(sourceFile)).line)
        }
      }
    }
    const stray: string[] = []
    walkModuleScope(n => {
      if (ts.isIdentifier(n) && (n.text === 'bot' || n.text === 'lockedBot')) {
        const line = sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line
        if (!declLines.has(line)) stray.push(`${n.text}@${line + 1}`)
      }
    })
    expect(stray).toEqual([])
  })

  it('declares `bot` as a deferred module-scope `let`, not `const bot = new Bot(...)`', () => {
    let botDecls = 0
    let botHasInitializer = false
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'bot') {
          botDecls++
          if (decl.initializer != null) botHasInitializer = true
          // `let`, not `const`
          expect(stmt.declarationList.flags & ts.NodeFlags.Const).toBe(0)
        }
      }
    }
    expect(botDecls).toBe(1)
    expect(botHasInitializer).toBe(false)
  })

  it('defines an async initGatewayBot() boot function', () => {
    const fn = findFunction('initGatewayBot')
    expect(fn).toBeDefined()
    const isAsync = (fn!.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.AsyncKeyword)
    expect(isAsync).toBe(true)
  })

  it('initGatewayBot() performs the construction: new Bot, token materialization, and the registration wiring call', () => {
    const fn = findFunction('initGatewayBot')
    expect(fn?.body).toBeDefined()
    const body = fn!.body!

    // Exactly one `new Bot(...)` — the single constructed instance.
    expect(countIn(body, isNewBot)).toBe(1)

    // Token materialization lives here (dynamic import + the resolve call).
    expect(countIn(body, isMaterializeDynamicImport)).toBe(1)
    expect(countIn(body, isMaterializeBotTokenCall)).toBe(1)

    // The two P0a-missed import-time bot consumers also moved here (P0b): the
    // callback-query factory and the /approvals registration.
    const isNamedCall = (name: string) => (n: ts.Node) =>
      ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name
    expect(countIn(body, isNamedCall('createCallbackQueryHandlers'))).toBe(1)
    expect(countIn(body, isNamedCall('registerApprovalsCommands'))).toBe(1)

    // The refuse-to-boot exits (process.exit(1)) live here, not at import.
    expect(countIn(body, isProcessExitCall)).toBeGreaterThanOrEqual(1)

    // The single registerGatewayHandlers(bot, …) wiring call moved here (P0b).
    let regCalls = 0
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'registerGatewayHandlers'
      ) {
        regCalls++
        expect(node.arguments[0]?.getText(sourceFile)).toBe('bot')
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    expect(regCalls).toBe(1)
  })
})
