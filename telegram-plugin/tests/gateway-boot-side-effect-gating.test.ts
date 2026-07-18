/**
 * Import-safety pin for the #2996 P0c move: the remaining module-load side
 * effects of gateway.ts are gated behind `isGatewayMain` so importing the
 * module performs NO boot side effects, and the boot sequence is the guarded
 * `startGateway()` at the bottom of the file.
 *
 * WHY this asserts on the parsed SOURCE, not a real `import()`:
 * the repo's oracle for "pin gateway structure without booting it" is
 * source-parsing via `ts.createSourceFile` — the same pattern as
 * gateway-bot-construction-deferral.test.ts (P0b) and
 * gateway-handler-registration-wiring.test.ts (P0a). (Since P0e, #3318, a
 * hermetic `await import()` of gateway.ts does complete cleanly; upgrading
 * this oracle to a real runtime import is possible but deliberately out of
 * scope here — the source parse stays the pinned pattern.) This test follows
 * it and asserts OUTCOMES:
 *
 *   1. `isGatewayMain` is a module-scope const whose value is the argv[1]
 *      main-check (true only when this module is the process entrypoint).
 *   2. The boot sequence is `async function startGateway()`, invoked EXACTLY
 *      once, and that sole invocation is guarded by `isGatewayMain`. The old
 *      top-level boot IIFE (`void (async () => …)()`) is gone.
 *   3. No UNGUARDED module-scope side effect remains: every top-level
 *      `setInterval` / `setTimeout` / `<x>.startTimer(…)` / `mkdirSync` /
 *      `runHistoryReaperNow` / `openTurnsDb` / `initHistory` /
 *      `acquireStartupLock` / `startWebhookIngestServer` /
 *      `createPollHealthCheck` / `loadObligations` /
 *      `installPosthogErrorHandlers` / `sweepActiveReactions` /
 *      `process.on(…)` call, and every module-scope `await`, sits inside an
 *      `isGatewayMain` guard (an `if (isGatewayMain …)` or an
 *      `isGatewayMain ? … : …` ternary) — or inside a function body.
 *
 * A regression that re-hoists a timer, the startup-lock await, the boot IIFE,
 * or the turn-registry open back to unguarded module scope fails (3).
 *
 * The process signal/error handlers (`process.on('SIGTERM'|'SIGINT'|
 * 'beforeExit'|'unhandledRejection'|'uncaughtException')`,
 * `installPosthogErrorHandlers()`) and the startup reaction sweep
 * (`sweepActiveReactions`) — the "P0d" inventory from the P0c handback — were
 * gated behind `isGatewayMain` by P0e (#3318, `ab34bb7b`) too; #2996 P0d was
 * verified already-delivered and closed with no PR (plan Amendment 11). They
 * ARE in the sentinel set below, so a regression that un-gates any of them
 * back to bare module scope fails (3) as well.
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

function lineOf(n: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(n.getStart(sourceFile)).line + 1
}

// The side-effect sentinels. Each of these, at module scope, MUST be
// isGatewayMain-guarded: the first block since P0c, the last two — the "P0d"
// process-wiring inventory, gated by P0e (#3318) — since P0e.
const CALL_SENTINELS = new Set([
  'setInterval',
  'setTimeout',
  'mkdirSync',
  'runHistoryReaperNow',
  'openTurnsDb',
  'initHistory',
  'acquireStartupLock',
  'startWebhookIngestServer',
  'createPollHealthCheck',
  'loadObligations',
  'installPosthogErrorHandlers',
  'sweepActiveReactions',
])

function sentinelName(n: ts.Node): string | null {
  if (ts.isCallExpression(n)) {
    const e = n.expression
    if (ts.isIdentifier(e) && CALL_SENTINELS.has(e.text)) return e.text
    // `<obj>.startTimer(...)` — the silencePoke / pendingProgress timers.
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'startTimer') {
      return `${e.expression.getText(sourceFile)}.startTimer`
    }
    // `process.on(...)` — the P0d signal/error-handler registrations
    // (SIGTERM / SIGINT / beforeExit / unhandledRejection /
    // uncaughtException), gated by P0e. Several route through shutdown() →
    // process.exit, so an unguarded registration makes exit reachable from a
    // bare import.
    if (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === 'on' &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === 'process'
    ) {
      return 'process.on'
    }
  }
  if (n.kind === ts.SyntaxKind.AwaitExpression) return 'await'
  return null
}

function guardsOnMain(cond: ts.Expression): boolean {
  return cond.getText(sourceFile).includes('isGatewayMain')
}

/**
 * Walk the module top level (never descending into function bodies) collecting
 * unguarded sentinels. `guarded` becomes true beneath an isGatewayMain
 * if/ternary branch.
 */
function collectUnguarded(): string[] {
  const findings: string[] = []
  function walk(node: ts.Node, guarded: boolean): void {
    if (isFunctionLike(node)) return
    if (ts.isIfStatement(node) && guardsOnMain(node.expression)) {
      walk(node.thenStatement, true)
      if (node.elseStatement) walk(node.elseStatement, guarded)
      return
    }
    if (ts.isConditionalExpression(node) && guardsOnMain(node.condition)) {
      walk(node.whenTrue, true)
      walk(node.whenFalse, guarded)
      return
    }
    const s = sentinelName(node)
    if (s && !guarded) findings.push(`${s}@${lineOf(node)}`)
    ts.forEachChild(node, c => walk(c, guarded))
  }
  for (const stmt of sourceFile.statements) walk(stmt, false)
  return findings
}

describe('gateway #2996 P0c: module-load boot side effects are gated behind isGatewayMain', () => {
  it('declares `isGatewayMain` as a module-scope const with the argv[1] main-check', () => {
    let found = false
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'isGatewayMain') {
          found = true
          const init = decl.initializer?.getText(sourceFile) ?? ''
          // Guards on argv[1] ending in the source or the built bundle name.
          expect(init).toContain('process.argv[1]')
          expect(init).toContain("endsWith('gateway.ts')")
          expect(init).toContain("endsWith('gateway.js')")
        }
      }
    }
    expect(found).toBe(true)
  })

  it('defines an async `startGateway()` boot function and NO leftover boot IIFE', () => {
    let startGatewayFn: ts.FunctionDeclaration | undefined
    for (const stmt of sourceFile.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === 'startGateway') {
        startGatewayFn = stmt
      }
    }
    expect(startGatewayFn).toBeDefined()
    const isAsync = (startGatewayFn!.modifiers ?? []).some(
      m => m.kind === ts.SyntaxKind.AsyncKeyword,
    )
    expect(isAsync).toBe(true)

    // The old top-level boot IIFE `void (async () => {…})()` must be gone: no
    // module-scope immediately-invoked async arrow remains.
    let bootIifes = 0
    for (const stmt of sourceFile.statements) {
      if (!ts.isExpressionStatement(stmt)) continue
      let expr = stmt.expression
      if (ts.isVoidExpression(expr)) expr = expr.expression
      if (
        ts.isCallExpression(expr) &&
        (ts.isArrowFunction(expr.expression) || ts.isFunctionExpression(expr.expression))
      ) {
        const inner = expr.expression
        const asyncArrow =
          (inner.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.AsyncKeyword)
        if (asyncArrow) bootIifes++
      }
    }
    expect(bootIifes).toBe(0)
  })

  it('invokes startGateway() EXACTLY once, guarded by isGatewayMain', () => {
    let total = 0
    let guardedCalls = 0
    function walk(node: ts.Node, guarded: boolean): void {
      if (isFunctionLike(node)) return // only the module-scope invocation
      if (ts.isIfStatement(node) && guardsOnMain(node.expression)) {
        walk(node.thenStatement, true)
        if (node.elseStatement) walk(node.elseStatement, guarded)
        return
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'startGateway'
      ) {
        total++
        if (guarded) guardedCalls++
      }
      ts.forEachChild(node, c => walk(c, guarded))
    }
    for (const stmt of sourceFile.statements) walk(stmt, false)
    expect(total).toBe(1)
    expect(guardedCalls).toBe(1)
  })

  it('leaves NO unguarded module-scope timer / boot-I/O / startup-lock side effect', () => {
    // If this fails it prints exactly which sentinel (e.g. `setInterval@1234`,
    // `await@9750`, `openTurnsDb@1700`) escaped the isGatewayMain guard.
    expect(collectUnguarded()).toEqual([])
  })

  it('gates every module-scope timer handle (the 4 reaper/tick consts)', () => {
    // pendingStateReaper / midSessionCardReaper / _deliveryMachineTick /
    // _deliveryConfirmSweep are `const X = isGatewayMain ? setInterval(…) :
    // undefined` — their setInterval must be inside an isGatewayMain ternary.
    const timerConsts = new Set([
      'pendingStateReaper',
      'midSessionCardReaper',
      '_deliveryMachineTick',
      '_deliveryConfirmSweep',
    ])
    const seen = new Set<string>()
    for (const stmt of sourceFile.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          timerConsts.has(decl.name.text) &&
          decl.initializer
        ) {
          seen.add(decl.name.text)
          const init = decl.initializer
          // Must be a conditional whose condition mentions isGatewayMain and
          // whose truthy branch is the setInterval call.
          expect(ts.isConditionalExpression(init)).toBe(true)
          if (ts.isConditionalExpression(init)) {
            expect(guardsOnMain(init.condition)).toBe(true)
            expect(init.whenTrue.getText(sourceFile)).toContain('setInterval')
          }
        }
      }
    }
    expect([...seen].sort()).toEqual([...timerConsts].sort())
  })
})
