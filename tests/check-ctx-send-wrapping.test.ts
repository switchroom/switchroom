/**
 * Unit tests for the #4599 context-SEND wrapping guard.
 *
 * The bug this guard exists for: `check-bot-api-wrapping.sh`'s pattern is
 * anchored on `\.api\.`, so `ctx.replyWithRichMessage(` — the path every
 * slash-command card takes via `switchroomReply` — could never match it, yet
 * `gateway/system-message-observer.ts` documented that guard as proof that
 * `robustApiCall` saw every send. Measured consequence: agent overlord message
 * id 20938, a `/usage` card with no history row, so a native reply to it
 * resolved to an id with no text.
 *
 * These tests pin the ratchet, the escape hatch, the two structural facts the
 * false claim rested on, and run the guard over the real tree so a stale
 * inventory reds here as well as in lint.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  evaluateCtxSendWrapping,
  countRawCtxSends,
  listSourceFiles,
  BASELINE_PATH,
  SEND_CTX_METHODS,
  EXEMPT_MARKER,
} from '../scripts/check-ctx-send-wrapping.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

describe('counting raw context sends', () => {
  it('counts ctx.reply and ctx.replyWithRichMessage', () => {
    const r = countRawCtxSends(
      'x.ts',
      ['await ctx.reply("hi")', 'await ctx.replyWithRichMessage(richMessage("hi"))'].join('\n'),
    )
    expect(r.count).toBe(2)
    expect(r.sites.map((s) => s.line)).toEqual([1, 2])
  })

  it('does not count a send already inside a retry wrapper', () => {
    const r = countRawCtxSends(
      'x.ts',
      ['await robustApiCall(() =>', '  ctx.replyWithRichMessage(richMessage("hi")),', ')'].join(
        '\n',
      ),
    )
    expect(r.count).toBe(0)
  })

  it('does not count a mention inside a comment', () => {
    expect(countRawCtxSends('x.ts', '// see ctx.reply(…) for the card path').count).toBe(0)
  })

  it('does not count ctx.api.* — that is the bash guard’s jurisdiction', () => {
    // Double-counting would make the two ratchets fight over one call site.
    expect(countRawCtxSends('x.ts', 'await ctx.api.sendMessage(chatId, "hi")').count).toBe(0)
  })

  it('the plain `reply` alternative does not shadow a replyWith… sibling', () => {
    const r = countRawCtxSends('x.ts', 'await ctx.replyWithPhoto(p)')
    expect(r.count).toBe(1)
  })

  it('honours the escape hatch, and rejects it with no reason', () => {
    const ok = countRawCtxSends(
      'x.ts',
      [`// ${EXEMPT_MARKER} pairing prompt, never in a topic`, 'await ctx.reply("pair")'].join('\n'),
    )
    expect(ok.count).toBe(0)
    expect(ok.errors).toEqual([])

    const bad = countRawCtxSends('x.ts', [`// ${EXEMPT_MARKER}`, 'await ctx.reply("pair")'].join('\n'))
    expect(bad.errors).toHaveLength(1)
    expect(bad.errors[0]).toContain('with no reason')
  })
})

describe('the ratchet', () => {
  it('fails when a NEW raw send lands in a file the inventory does not list', () => {
    const r = evaluateCtxSendWrapping(
      [{ path: 'new-handler.ts', source: 'await ctx.replyWithRichMessage(richMessage("card"))' }],
      {},
    )
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('inventory says 0')
    expect(r.errors[0]).toContain('leaves no history row')
  })

  it('fails when a listed file grows one', () => {
    const r = evaluateCtxSendWrapping(
      [{ path: 'a.ts', source: 'ctx.reply("1")\nctx.reply("2")' }],
      { 'a.ts': 1 },
    )
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('inventory says 1')
  })

  it('fails when a listed file shrinks — the inventory must be lowered too', () => {
    const r = evaluateCtxSendWrapping([{ path: 'a.ts', source: 'ctx.reply("1")' }], { 'a.ts': 2 })
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('lower the number')
  })

  it('passes on an exact match', () => {
    const r = evaluateCtxSendWrapping([{ path: 'a.ts', source: 'ctx.reply("1")' }], { 'a.ts': 1 })
    expect(r.ok).toBe(true)
  })
})

describe('the real tree', () => {
  it('matches the checked-in inventory exactly', () => {
    const baseline = JSON.parse(readFileSync(resolve(repoRoot, BASELINE_PATH), 'utf-8'))
    const files = []
    for (const rel of listSourceFiles(repoRoot)) {
      let source: string
      try {
        source = readFileSync(resolve(repoRoot, rel), 'utf-8')
      } catch {
        continue
      }
      if (!source.includes('ctx.reply')) continue
      files.push({ path: rel, source })
    }
    const r = evaluateCtxSendWrapping(files, baseline.files)
    expect(r.errors).toEqual([])
    // Not vacuously true: the guard really is scanning the tree.
    expect(Object.keys(r.actual).length).toBeGreaterThanOrEqual(5)
  })

  it('inventories the slash-command card path that #4571 missed', () => {
    // `switchroomReply` in shared/bot-runtime.ts is the exact bypass that left
    // id 20938 unrecorded. It must be in the inventory (or wrapped) — never
    // invisible again.
    const baseline = JSON.parse(readFileSync(resolve(repoRoot, BASELINE_PATH), 'utf-8'))
    expect(baseline.files['telegram-plugin/shared/bot-runtime.ts']).toBeGreaterThan(0)
    const src = readFileSync(resolve(repoRoot, 'telegram-plugin/shared/bot-runtime.ts'), 'utf-8')
    expect(src).toContain('ctx.replyWithRichMessage')
  })
})

describe('the bash guard’s verb list', () => {
  it('covers sendRichMessage — the Bot API 10.1 verb it shipped without', () => {
    const sh = readFileSync(resolve(repoRoot, 'scripts/check-bot-api-wrapping.sh'), 'utf-8')
    const pattern = sh.split('\n').find((l) => l.startsWith('PATTERN='))
    expect(pattern).toBeDefined()
    expect(pattern).toContain('sendRichMessage')
    expect(pattern).toContain('sendRichMessageDraft')
  })

  it('cannot match ctx.reply — which is WHY this ratchet exists', () => {
    // Pins the structural fact the false docblock in system-message-observer.ts
    // rested on. If someone ever widens the bash pattern to cover ctx.reply,
    // this test reds and the two guards must be reconciled deliberately.
    const sh = readFileSync(resolve(repoRoot, 'scripts/check-bot-api-wrapping.sh'), 'utf-8')
    const line = sh.split('\n').find((l) => l.startsWith('PATTERN='))!
    const body = line.slice('PATTERN='.length).replace(/^'|'$/g, '')
    const re = new RegExp(body.replace(/\\b/g, '\\b'))
    expect(re.test('await ctx.replyWithRichMessage(richMessage("x"))')).toBe(false)
    expect(re.test('await ctx.api.sendRichMessage(chatId, { markdown: "x" })')).toBe(true)
  })

  it('the send family is a class, not just the two verbs in the tree today', () => {
    expect(SEND_CTX_METHODS).toContain('reply')
    expect(SEND_CTX_METHODS).toContain('replyWithRichMessage')
    expect(SEND_CTX_METHODS).toContain('replyWithPhoto')
  })
})
