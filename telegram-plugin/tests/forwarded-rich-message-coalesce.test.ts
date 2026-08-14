/**
 * Outcome regression (#3516 follow-up): a forwarded rich (bot) message MUST
 * coalesce through the same sliding window as `message:text`.
 *
 * THE BUG: PR #3516 registered `message:rich_message` but wired it with
 * `mediaEnvelopeDeps`, whose `handleInbound` is the BARE (non-coalescing)
 * inbound function — the same surface the cluster-A media-envelope handlers
 * (contact/location/poll/…) use. The sibling text/photo/voice/attachment
 * handlers all route through `handleInboundCoalesced`. Result: a forwarded
 * bot message arriving in the same coalesce window as another inbound
 * message did NOT fold into one turn — it bypassed the window entirely,
 * contradicting rich-message-handler.ts's own docstring ("hands it to the
 * normal COALESCING inbound pipeline … identical to message:text").
 *
 * Two guards, both anchored to the real production code:
 *
 *   1. WIRING (source-parse, deterministic RED/GREEN): parse gateway.ts and
 *      assert the deps object passed to the `message:rich_message`
 *      registration binds `handleInbound` to `handleInboundCoalesced` (the
 *      coalescing entry point), the SAME path `message:text` takes. This
 *      guard is RED on the pre-fix wiring (`mediaEnvelopeDeps`, bare
 *      `handleInbound`) and GREEN after it.
 *
 *   2. OUTCOME (real grammy Bot + real handler + real coalescer): drive the
 *      production `handleRichMessageMessage` and `message:text` through one
 *      shared `createInboundCoalescer` (the exact module gateway.ts uses),
 *      and assert a rich message + a text message in the same window flush
 *      as ONE ordered turn — and that the bare (non-coalescing) surface the
 *      bug used would instead emit TWO turns.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { resetUpdateCounters } from './update-factory.js'
import { handleRichMessageMessage } from '../gateway/rich-message-handler.js'
import type { MediaEnvelopeDeps } from '../gateway/media-message-handlers.js'
import {
  createInboundCoalescer,
  inboundCoalesceKey,
} from '../gateway/inbound-coalesce.js'

// ---------------------------------------------------------------------------
// Guard 1 — wiring source-parse
// ---------------------------------------------------------------------------

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

/** The deps argument (arg 2) of `bot.on('message:rich_message', ctx =>
 * handleRichMessageMessage(ctx, DEPS))` as an AST node, or null. */
function findRichMessageDepsArg(): ts.Expression | null {
  let found: ts.Expression | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'bot' &&
      node.expression.name.text === 'on'
    ) {
      const arg0 = node.arguments[0]
      const evName = arg0 && ts.isStringLiteralLike(arg0) ? arg0.text : null
      if (evName === 'message:rich_message') {
        // arg1 is `ctx => handleRichMessageMessage(ctx, DEPS)`
        const arg1 = node.arguments[1]
        if (arg1 && (ts.isArrowFunction(arg1) || ts.isFunctionExpression(arg1))) {
          const body = arg1.body
          const inner = !ts.isBlock(body) && ts.isCallExpression(body) ? body : undefined
          if (inner && inner.arguments.length >= 2) found = inner.arguments[1]
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** Resolve the deps arg to its source text — inline object literal directly,
 * or the initializer of the `const <name> = { … }` it names. */
function resolveDepsText(arg: ts.Expression): string | null {
  if (ts.isObjectLiteralExpression(arg)) return arg.getText(sourceFile)
  if (ts.isIdentifier(arg)) {
    let text: string | null = null
    const visit = (node: ts.Node): void => {
      if (text) return
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === arg.text &&
        node.initializer
      ) {
        text = node.initializer.getText(sourceFile)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return text
  }
  return null
}

describe('wiring: message:rich_message dispatches through the coalescing path', () => {
  it('the rich_message registration passes deps that bind handleInbound to handleInboundCoalesced', () => {
    const depsArg = findRichMessageDepsArg()
    expect(depsArg, 'could not locate the message:rich_message registration deps arg').not.toBeNull()

    const depsText = resolveDepsText(depsArg as ts.Expression)
    expect(depsText, 'could not resolve the rich_message deps source text').not.toBeNull()

    // The coalescing entry point — the same one message:text routes through.
    // Pre-fix the deps was `mediaEnvelopeDeps` (bare `handleInbound,`
    // shorthand), so this assertion is RED on the bug and GREEN with the fix.
    expect(depsText).toContain('handleInbound: handleInboundCoalesced')
  })
})

// ---------------------------------------------------------------------------
// Guard 2 — outcome: real handler + real coalescer
//
// NOTE: Guard 2 drives its OWN `richCoalesces` boolean toggle rather than
// importing the gateway's dispatch wiring, so it validates the coalescer
// CONTRACT (folding/ordering into one turn vs. the pre-fix split) — it is NOT
// a wiring regression guard. Guard 1 (the AST/source-parse over gateway.ts) is
// the SOLE guard that regresses if the rich_message registration stops routing
// through `handleInboundCoalesced`.
// ---------------------------------------------------------------------------

const CHAT_ID = -1004444444444
const USER_ID = 777

function makeBotInfo() {
  return {
    id: 999,
    is_bot: true,
    first_name: 'TestBot',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  }
}

/** Forwarded rich (bot) message, no top-level text/caption — the live shape. */
function makeForwardedRichUpdate(update_id: number, blocks: unknown[]): Update {
  const originUser = { id: 8500000001, is_bot: true, first_name: 'Sidekick', username: 'example_sidekick_bot' }
  return {
    update_id,
    message: {
      message_id: update_id,
      chat: { id: CHAT_ID, type: 'supergroup', title: 'Example Supergroup', is_forum: true },
      from: { id: USER_ID, is_bot: false, first_name: 'Alice' },
      date: 1784837003,
      forward_origin: { type: 'user', date: 1784830000, sender_user: originUser },
      forward_from: originUser,
      forward_date: 1784830000,
      rich_message: { blocks },
    },
  } as unknown as Update
}

function makeTextUpdate(update_id: number, text: string): Update {
  return {
    update_id,
    message: {
      message_id: update_id,
      chat: { id: CHAT_ID, type: 'supergroup', title: 'Example Supergroup', is_forum: true },
      from: { id: USER_ID, is_bot: false, first_name: 'Alice' },
      date: 1784837004,
      text,
    },
  } as unknown as Update
}

interface HarnessOptions {
  /** Bind the rich handler's dispatch to the coalescing path (the fix) or to
   * the bare non-coalescing path (the pre-fix bug). */
  richCoalesces: boolean
}

/**
 * Wire a real grammy Bot the way the production gateway does: message:text
 * enqueues into a shared coalescer; message:rich_message goes through the
 * REAL production handler with deps whose `handleInbound` is bound to either
 * the same coalescer (fix) or a bare immediate dispatch (bug).
 */
function buildHarness(opts: HarnessOptions) {
  const flushed: string[] = []

  // The exact coalescer module the gateway uses. 1500ms sliding window.
  const coalescer = createInboundCoalescer<{ text: string }>({
    gapMs: 1500,
    merge: entries => ({ text: entries.map(e => e.text).join('\n') }),
    onFlush: (_key, merged) => flushed.push(merged.text),
  })

  const key = inboundCoalesceKey(String(CHAT_ID), null, String(USER_ID))

  /** Coalescing dispatch — mirrors handleInboundCoalesced's enqueue step. */
  const coalescedDispatch = async (text: string): Promise<void> => {
    const { bypass } = coalescer.enqueue(key, { text })
    if (bypass) flushed.push(text)
  }
  /** Bare dispatch — the pre-fix bug: every message is its own turn. */
  const bareDispatch = async (text: string): Promise<void> => {
    flushed.push(text)
  }

  const bot = new Bot('12345:TEST_TOKEN_NOT_REAL')
  bot.botInfo = makeBotInfo()

  bot.on('message:text', async ctx => {
    await coalescedDispatch(ctx.message.text)
  })

  const richDeps: MediaEnvelopeDeps = {
    handleInbound: async (_ctx, text) => {
      await (opts.richCoalesces ? coalescedDispatch(text) : bareDispatch(text))
    },
    handleAckOnly: async () => {},
    handleRefusal: async () => {},
    log: () => {},
  }
  bot.on('message:rich_message', ctx => handleRichMessageMessage(ctx, richDeps))

  return { bot, flushed }
}

const BLOCKS = [{ type: 'paragraph', text: 'forwarded body from a bot' }]

describe('outcome: forwarded rich message coalesces with a sibling inbound', () => {
  beforeEach(() => {
    resetUpdateCounters()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('rich + text in the same window flush as ONE ordered turn (the fix)', async () => {
    const { bot, flushed } = buildHarness({ richCoalesces: true })

    await bot.handleUpdate(makeForwardedRichUpdate(9001, BLOCKS))
    // A second inbound arrives 500ms later — inside the 1500ms window.
    vi.advanceTimersByTime(500)
    await bot.handleUpdate(makeTextUpdate(9002, 'and my own note about it'))

    // Nothing flushed yet — the window is still open.
    expect(flushed).toEqual([])

    // Window closes 1500ms after the LAST message (sliding window).
    vi.advanceTimersByTime(1500)

    // ONE turn, both bodies, rich body first (arrival order preserved).
    expect(flushed).toHaveLength(1)
    expect(flushed[0]).toBe('forwarded body from a bot\nand my own note about it')
  })

  it('the pre-fix bare wiring would split them into TWO turns (bug characterization)', async () => {
    const { bot, flushed } = buildHarness({ richCoalesces: false })

    await bot.handleUpdate(makeForwardedRichUpdate(9003, BLOCKS))
    // The rich message bypassed the window: it flushes immediately.
    expect(flushed).toEqual(['forwarded body from a bot'])

    vi.advanceTimersByTime(500)
    await bot.handleUpdate(makeTextUpdate(9004, 'and my own note about it'))
    vi.advanceTimersByTime(1500)

    // Two separate turns — the fragmentation the fix eliminates.
    expect(flushed).toEqual([
      'forwarded body from a bot',
      'and my own note about it',
    ])
  })
})
