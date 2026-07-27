/**
 * GOLDEN SUITE — every status/progress card variant, pinned byte-for-byte.
 *
 * Why this exists: card rendering now flows through ONE layout core
 * (`card-layout.ts`). That is the point — but it also means a change made for
 * one card silently reshapes the other twenty. This suite is the alarm: it
 * renders all variants in `card-variants.ts` through the real renderers and
 * compares the exact wire text against a checked-in golden file. Any diff, in
 * any card, fails.
 *
 * Regenerate deliberately (and read the diff in the PR):
 *   UPDATE_CARD_GOLDEN=1 npx vitest run telegram-plugin/tests/card-golden.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CARD_VARIANTS, GOLDEN_DELIMITER, renderGoldenDocument } from './card-variants.js'

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'card-variants.golden.txt')

describe('card golden suite', () => {
  it('every card variant renders exactly its pinned golden text', () => {
    const actual = renderGoldenDocument()
    if (process.env.UPDATE_CARD_GOLDEN === '1') {
      writeFileSync(GOLDEN_PATH, actual, 'utf8')
    }
    const expected = readFileSync(GOLDEN_PATH, 'utf8')
    // Compare per-variant first: a one-card regression should name that card,
    // not dump a 21-card diff.
    const split = (doc: string): Map<string, string> => {
      const out = new Map<string, string>()
      for (const chunk of doc.split(GOLDEN_DELIMITER).slice(1)) {
        const nl = chunk.indexOf('\n')
        out.set(chunk.slice(0, nl).trim(), chunk.slice(nl + 1))
      }
      return out
    }
    const exp = split(expected)
    const act = split(actual)
    for (const [name, body] of act) {
      expect(exp.has(name), `golden has no entry for "${name}" — regenerate it`).toBe(true)
      expect(body, `card "${name}" no longer renders its golden text`).toBe(exp.get(name))
    }
    // And the whole document, so a REMOVED or reordered variant also fails.
    expect(actual).toBe(expected)
  })

  it('the golden covers every variant in the catalogue and nothing else', () => {
    const golden = readFileSync(GOLDEN_PATH, 'utf8')
    const namesInGolden = golden
      .split(GOLDEN_DELIMITER)
      .slice(1)
      .map((c) => c.slice(0, c.indexOf('\n')).trim())
    expect(namesInGolden).toEqual(CARD_VARIANTS.map((v) => v.name))
    // Guards against a fixture that silently stops rendering (e.g. a renderer
    // starting to return null) and thus stops asserting anything real.
    expect(namesInGolden.length).toBeGreaterThanOrEqual(21)
  })

  it('no variant renders empty or null', () => {
    for (const v of CARD_VARIANTS) {
      const text = v.render()
      expect(text, `variant "${v.name}" rendered null`).not.toBeNull()
      expect((text ?? '').trim().length, `variant "${v.name}" rendered empty`).toBeGreaterThan(0)
    }
  })
})
