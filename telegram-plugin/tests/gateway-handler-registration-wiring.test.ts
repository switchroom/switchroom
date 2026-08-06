/**
 * Registration-wiring pin for the #2996 P0a leaf move.
 *
 * P0a extracted the 62 top-level grammY registration statements — the 60
 * `bot.use` / `bot.command` / `bot.on` / `bot.catch` calls PLUS the two
 * interleaved handler-registering helpers (`registerOpsInfoCommands` and the
 * terminal `installUnhandledMessageCatchAll`) — out of their previously
 * module-scope-interspersed positions in gateway.ts and into a single
 * `registerGatewayHandlers(bot, deps)` function, called exactly once at the
 * same point in module evaluation as the old last registration.
 *
 * grammY middleware/handler ORDER is load-bearing — the admin-gate `bot.use`
 * must run before any command, and the specific `message:*` handlers before
 * the catch-all. This test is the deterministic guard that the move (and any
 * future edit to the block) preserves the EXACT ordered registration
 * sequence. It is outcome-asserting: it fails if a registration is dropped,
 * reordered, duplicated, or added, and if any registration leaks back out to
 * module top-level (which would change its evaluation order relative to the
 * single call site).
 *
 * P0b (#2996) update: the single `registerGatewayHandlers(bot, {})` call moved
 * OFF module top level into the boot function `initGatewayBot()` — because P0b
 * defers `new Bot` construction to boot, so `bot` no longer exists at import.
 * The call still fires exactly once, after construction and before the runner,
 * preserving registration order. The call-site assertion below now pins that
 * new location (zero top-level calls; exactly one inside initGatewayBot).
 *
 * The golden sequence below was captured from `origin/main` immediately
 * BEFORE the move (parser-extracted top-level `bot.*` order) so the same
 * assertion holds pre- and post-move — the ordered list is a behaviour
 * invariant, not an artifact of the new structure.
 *
 * Source-parsing (not import) mirrors gateway-pending-command-wiring.test.ts:
 * gateway.ts is not import-safe under vitest until the #2996 P0 importability
 * seam lands, so we assert on the parsed source instead.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_PATH = resolve(__dirname, '..', 'gateway', 'gateway.ts')
const GATEWAY_SRC = readFileSync(GATEWAY_PATH, 'utf8')

/**
 * The frozen, ordered registration sequence. Order is significant — this is
 * the exact top-level order captured from origin/main BEFORE the move.
 * Format: `use` / `catch` (no name), `command:<name>`, `on:<event>`,
 * `helper:<fn>` for the interleaved handler-registering helper calls.
 */
const GOLDEN_REGISTRATIONS: readonly string[] = [
  'use',
  'helper:registerStartInfoCommands',
  'command:inject',
  'command:compact',
  'command:clear',
  'command:private',
  'command:public',
  'helper:registerModelEffortCommands',
  'command:agentstart',
  'command:agentstop',
  'command:stop',
  'command:restart',
  'command:new',
  'command:update',
  'command:upgradestatus',
  'command:upgrade',
  'command:audit',
  'command:approve',
  'command:deny',
  'command:folders',
  'command:pending',
  'command:interrupt',
  'command:connect',
  'command:auth',
  'command:vault',
  'command:topics',
  'command:logs',
  'command:memory',
  'command:issues',
  'command:usage',
  'helper:registerOpsInfoCommands',
  'on:callback_query:data',
  'on:message:text',
  'on:message:photo',
  'on:message:document',
  'on:message:voice',
  'on:message:audio',
  'on:message:video',
  'on:message:video_note',
  'on:message:sticker',
  'on:message:animation',
  'on:message:contact',
  'on:message:location',
  'on:message:venue',
  'on:message:poll',
  'on:message:web_app_data',
  'on:message:users_shared',
  'on:message:chat_shared',
  'on:message:dice',
  'on:message:game',
  'on:message:story',
  'on:message:paid_media',
  'on:message:successful_payment',
  'on:message:passport_data',
  'on:message:checklist_tasks_done',
  'on:message:checklist_tasks_added',
  'on:message:pinned_message',
  'on:message:rich_message',
  'helper:installUnhandledMessageCatchAll',
  'on:message_reaction',
  'catch',
]

/**
 * The interleaved handler-registering helper calls. Their position in the
 * sequence is load-bearing: `installUnhandledMessageCatchAll` MUST come after
 * every `message:*` handler (grammY no-double-handling; see
 * catch-all-unhandled-message.test.ts) and before `message_reaction`.
 */
const HELPER_REGISTRARS = new Set(['registerOpsInfoCommands', 'registerStartInfoCommands', 'registerModelEffortCommands', 'installUnhandledMessageCatchAll'])

const sourceFile = ts.createSourceFile(
  GATEWAY_PATH,
  GATEWAY_SRC,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)

/** `bot.<verb>` for a CallExpression whose callee is `bot.<verb>`, else null. */
function botVerb(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr)) return null
  const callee = expr.expression
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    if (callee.expression.text === 'bot') return callee.name.text
  }
  return null
}

/** Unwrap a possibly `as`-cast string literal to its text; else null. */
function stringArg(arg: ts.Expression | undefined): string | null {
  if (!arg) return null
  let node: ts.Expression = arg
  if (ts.isAsExpression(node)) node = node.expression
  if (ts.isStringLiteralLike(node)) return node.text
  return null
}

/** Canonical signature for a registration statement, or null if not one. */
function registrationSig(stmt: ts.Statement): string | null {
  if (!ts.isExpressionStatement(stmt)) return null
  const expr = stmt.expression
  if (!ts.isCallExpression(expr)) return null
  // Interleaved handler-registering helper: `helperName(bot, ...)`.
  if (ts.isIdentifier(expr.expression) && HELPER_REGISTRARS.has(expr.expression.text)) {
    return `helper:${expr.expression.text}`
  }
  const verb = botVerb(expr)
  if (verb === null) return null
  if (verb === 'command' || verb === 'on') {
    const name = stringArg(expr.arguments[0])
    return name === null ? `${verb}:<non-literal>` : `${verb}:${name}`
  }
  return verb // use / catch / anything else with no name key
}

function findFunction(name: string): ts.FunctionDeclaration | undefined {
  for (const s of sourceFile.statements) {
    if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s
  }
  return undefined
}

describe('gateway #2996 P0a: registerGatewayHandlers is the single ordered registration unit', () => {
  it('defines registerGatewayHandlers(bot, deps) at module top level', () => {
    const fn = findFunction('registerGatewayHandlers')
    expect(fn).toBeDefined()
    expect(fn!.parameters.length).toBe(2)
    expect(fn!.parameters[0].name.getText(sourceFile)).toBe('bot')
    expect(fn!.parameters[1].name.getText(sourceFile)).toBe('deps')
  })

  it('registers the EXACT golden ordered sequence inside the function', () => {
    const fn = findFunction('registerGatewayHandlers')
    expect(fn?.body).toBeDefined()
    const actual: string[] = []
    for (const stmt of fn!.body!.statements) {
      const sig = registrationSig(stmt)
      if (sig !== null) actual.push(sig)
    }
    // Deep, ordered equality — fails on drop, reorder, duplicate, or add.
    expect(actual).toEqual([...GOLDEN_REGISTRATIONS])
  })

  it('has no duplicate registrations', () => {
    const fn = findFunction('registerGatewayHandlers')
    const sigs: string[] = []
    for (const stmt of fn!.body!.statements) {
      const sig = registrationSig(stmt)
      if (sig !== null) sigs.push(sig)
    }
    expect(new Set(sigs).size).toBe(sigs.length)
  })

  it('leaves ZERO bot.* registrations at module top level (all live in the function)', () => {
    const leaked: string[] = []
    for (const stmt of sourceFile.statements) {
      const sig = registrationSig(stmt)
      if (sig !== null) leaked.push(sig)
    }
    expect(leaked).toEqual([])
  })

  it('calls registerGatewayHandlers(bot, ...) exactly once, inside initGatewayBot (P0b), never at module top level', () => {
    // P0b (#2996): the call moved off module top level into the boot function
    // initGatewayBot(). Assert (a) ZERO top-level calls — proving the deferral —
    // and (b) exactly one call in the whole file, with `bot` as its first arg,
    // located inside initGatewayBot's body.
    let topLevelCalls = 0
    for (const stmt of sourceFile.statements) {
      if (
        ts.isExpressionStatement(stmt) &&
        ts.isCallExpression(stmt.expression) &&
        ts.isIdentifier(stmt.expression.expression) &&
        stmt.expression.expression.text === 'registerGatewayHandlers'
      ) {
        topLevelCalls++
      }
    }
    expect(topLevelCalls).toBe(0)

    // Count every registerGatewayHandlers(...) call anywhere in the module, and
    // record whether it is lexically inside the initGatewayBot function.
    const initGatewayBot = findFunction('initGatewayBot')
    expect(initGatewayBot).toBeDefined()
    const initStart = initGatewayBot!.getStart(sourceFile)
    const initEnd = initGatewayBot!.getEnd()

    let totalCalls = 0
    let callsInsideInit = 0
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'registerGatewayHandlers'
      ) {
        totalCalls++
        // first arg is the bot singleton
        expect(node.arguments[0]?.getText(sourceFile)).toBe('bot')
        const start = node.getStart(sourceFile)
        if (start >= initStart && node.getEnd() <= initEnd) callsInsideInit++
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)

    expect(totalCalls).toBe(1)
    expect(callsInsideInit).toBe(1)
  })

  it('registers the admin-gate middleware (bot.use) FIRST and the error boundary (bot.catch) LAST', () => {
    const fn = findFunction('registerGatewayHandlers')
    const sigs: string[] = []
    for (const stmt of fn!.body!.statements) {
      const sig = registrationSig(stmt)
      if (sig !== null) sigs.push(sig)
    }
    expect(sigs[0]).toBe('use')
    expect(sigs[sigs.length - 1]).toBe('catch')
    // the catch-all-ish specific media handlers precede message_reaction, which
    // precedes the error boundary
    expect(sigs.indexOf('on:message:text')).toBeGreaterThan(sigs.indexOf('use'))
    expect(sigs.indexOf('on:message_reaction')).toBeGreaterThan(sigs.indexOf('on:message:text'))
  })

  it('installs the terminal catch-all AFTER every message:* handler and before message_reaction', () => {
    const fn = findFunction('registerGatewayHandlers')
    const sigs: string[] = []
    for (const stmt of fn!.body!.statements) {
      const sig = registrationSig(stmt)
      if (sig !== null) sigs.push(sig)
    }
    const catchAllIdx = sigs.indexOf('helper:installUnhandledMessageCatchAll')
    expect(catchAllIdx).toBeGreaterThan(0)
    // Every message:* handler precedes the catch-all (grammY no-double-handling).
    const messageHandlers = sigs.filter(s => /^on:message(:|$)/.test(s) && s !== 'on:message_reaction')
    expect(messageHandlers.length).toBeGreaterThan(0)
    for (const mh of messageHandlers) {
      expect(sigs.indexOf(mh)).toBeLessThan(catchAllIdx)
    }
    // message_reaction (a different update type) is registered AFTER the catch-all.
    expect(sigs.indexOf('on:message_reaction')).toBeGreaterThan(catchAllIdx)
    // ops-info commands register between the last /command and callback_query:data.
    const opsIdx = sigs.indexOf('helper:registerOpsInfoCommands')
    expect(opsIdx).toBeGreaterThan(sigs.indexOf('command:usage'))
    expect(opsIdx).toBeLessThan(sigs.indexOf('on:callback_query:data'))
  })
})
