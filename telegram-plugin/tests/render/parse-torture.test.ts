// Cross-check the new markdown->IR parser (render/parse.ts) against the
// existing adversarial torture-fixture set (formatting-torture-set.ts).
//
// This does NOT exercise the renderer or chunker (out of scope for the
// parser+IR increment) — it feeds each fixture's raw `input` straight into
// `parse()` and walks the resulting IR tree collecting a flat entity list,
// then asserts every entity the fixture's `expect` block calls for is
// present in that list. This is a structural cross-check independent of the
// existing gateway-pipeline oracle: it proves the new parser captures the
// same intent the current hand-rolled pipeline is required to preserve.
import { describe, it, expect } from 'vitest'
import { parse } from '../../render/parse.js'
import type { Block, Inline } from '../../render/ir.js'
import { TORTURE_SET, type ExpectEntity } from '../formatting-torture-set.js'
import type { EntityType } from '../rich-markdown-oracle.js'

interface FlatEntity {
  type: EntityType
  text: string
  url?: string
  lang?: string
}

function textOf(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'plain':
        case 'code':
          return n.text
        default:
          return textOf(n.children)
      }
    })
    .join('')
}

function walkInline(node: Inline, out: FlatEntity[]) {
  switch (node.type) {
    case 'bold':
      out.push({ type: 'bold', text: textOf(node.children) })
      node.children.forEach((c) => walkInline(c, out))
      break
    case 'italic':
      out.push({ type: 'italic', text: textOf(node.children) })
      node.children.forEach((c) => walkInline(c, out))
      break
    case 'strike':
      out.push({ type: 'strikethrough', text: textOf(node.children) })
      node.children.forEach((c) => walkInline(c, out))
      break
    case 'code':
      out.push({ type: 'code', text: node.text })
      break
    case 'link':
      out.push({ type: 'link', text: textOf(node.children), url: node.href })
      node.children.forEach((c) => walkInline(c, out))
      break
    case 'plain':
      break
    case 'spoiler':
      node.children.forEach((c) => walkInline(c, out))
      break
  }
}

function walkBlock(node: Block, out: FlatEntity[]) {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      node.children.forEach((c) => walkInline(c, out))
      break
    case 'blockquote':
      node.children.forEach((c) => walkBlock(c, out))
      break
    case 'code-block':
      out.push({ type: 'pre', text: node.text, lang: node.language ?? undefined })
      break
    case 'list':
      for (const item of node.items) item.children.forEach((c) => walkBlock(c, out))
      break
    case 'table':
      for (const row of [node.header, ...node.rows]) {
        for (const cell of row.cells) cell.children.forEach((c) => walkInline(c, out))
      }
      break
    case 'thematic-break':
      break
  }
}

function flatten(input: string): FlatEntity[] {
  const doc = parse(input)
  const out: FlatEntity[] = []
  doc.blocks.forEach((b) => walkBlock(b, out))
  return out
}

function matches(found: FlatEntity[], want: ExpectEntity): boolean {
  return found.some(
    (f) =>
      f.type === want.type &&
      f.text === want.text &&
      (want.url === undefined || f.url === want.url) &&
      (want.lang === undefined || f.lang === want.lang),
  )
}

describe('parse: torture-fixture cross-check', () => {
  for (const fixture of TORTURE_SET) {
    if (fixture.expect.length === 0) {
      // No entity assertions for this fixture — just prove parse() doesn't
      // throw and returns at least one block (structure-only fixtures).
      it(`${fixture.name}: parses without throwing`, () => {
        const doc = parse(fixture.input)
        expect(doc.blocks.length).toBeGreaterThan(0)
      })
      continue
    }

    it(`${fixture.name}: IR captures every expected entity`, () => {
      const found = flatten(fixture.input)
      for (const want of fixture.expect) {
        expect(
          matches(found, want),
          `expected a ${want.type} entity with text ${JSON.stringify(want.text)} in fixture "${fixture.name}"; found: ${JSON.stringify(found)}`,
        ).toBe(true)
      }
    })
  }
})
