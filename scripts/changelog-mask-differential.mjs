#!/usr/bin/env node
/**
 * Randomised CommonMark differential for the changelog guard's block parse.
 *
 * WHY THIS IS COMMITTED
 * ---------------------
 * `tests/fixtures/commonmark-mask-cases.mjs` is the *curated* differential: 42
 * hand-written rows, each one a defect somebody found by hand. It pins what is
 * already known. It cannot find anything new, and every review round of the
 * guard's old hand-written masker found its defect by generating documents and
 * diffing against a real parser — from a throwaway script that was never
 * committed. Round 4 called that out ("load-bearing evidence that is not in the
 * repo does not exist") and the curated table was the answer for the cases it
 * covers; this file is the answer for the SEARCH that produces them.
 *
 * A number quoted in a PR body — "N fail-opens over 60,000 documents" — is only
 * evidence if the next reviewer can re-derive it. This is that generator, with
 * its seeded RNG, so the same seed gives the same corpus and the same counts.
 *
 * The masker is gone: `check-changelog-entry.mjs` now parses with
 * `commonmark@0.31.2` itself. That does NOT make this script tautological. The
 * guard applies a deliberate FILTER on top of the parse (a heading is a section
 * only at column 0, only as an ATX `## ` opener), and a filter is exactly the
 * kind of thing that can be subtly wrong. So the oracle here is every level-2
 * heading NODE the reference implementation produces, unfiltered, and the
 * script's job is to prove that every heading the guard drops is dropped by
 * that documented policy and by nothing else.
 *
 * NOW RUNNABLE WITHOUT SETUP
 * --------------------------
 * `commonmark` is an ordinary devDependency, so the old out-of-tree install
 * dance (and the `--oracle` flag) is gone:
 *
 *   node scripts/changelog-mask-differential.mjs --docs 60000 --seed 1
 *
 * It is still a reviewer's tool, not a test: 60k random documents is far too
 * slow for CI, and the curated battery is what runs there.
 *
 * WHAT IT MEASURES
 * ----------------
 *   fail-OPEN   — the reference implementation produces a level-2 heading at a
 *                 COLUMN-0 `## ` line and the guard does not see it. The
 *                 placement rule then cannot check entries under it: a buried
 *                 entry reported OK. This is the direction that matters, and it
 *                 must be ZERO.
 *   fail-CLOSED — the guard reports a section the reference implementation does
 *                 not produce a heading for at all. Worst case a false FAIL.
 *                 Also expected to be zero now.
 *   policy      — a heading the reference DOES render that the guard drops
 *                 because it is indented 1–3 spaces or is a setext underline.
 *                 Deliberate, documented, fail-CLOSED (see `parseSections`).
 *                 Reported so the count is visible rather than silently folded
 *                 into "agrees".
 *
 * CONTAINER SAMPLING
 * ------------------
 * The container list used to attach its marker to the SAME line as the
 * construct (`- ```yaml`). That never generates the file's own house style —
 * a bullet on one line, the block indented UNDER it on the next — which is the
 * shape that produced the round-5 and round-7 fail-opens. Markers are now drawn
 * from both forms, and the indented form applies to EVERY line of the
 * construct, not just its opener.
 *
 * FLAGS
 * -----
 *   --docs N           corpus size (default 60000)
 *   --seed N           PRNG seed (default 1)
 *   --modelled-only    drop raw HTML blocks, block quotes and setext. Retained
 *                      for continuity with the numbers earlier rounds quoted;
 *                      with a real parser there is no longer anything the guard
 *                      does not model, so it should change nothing.
 */

import process from 'node:process'

import { Parser } from 'commonmark'

import { parseSections } from './check-changelog-entry.mjs'

/**
 * Deterministic 32-bit PRNG (mulberry32). Seeded so a quoted count is
 * reproducible; `Math.random()` would make every run a different corpus.
 * @param {number} seed
 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** @param {() => number} r @param {readonly any[]} xs */
const pick = (r, xs) => xs[Math.floor(r() * xs.length)]
/** @param {() => number} r @param {number} n */
const upto = (r, n) => Math.floor(r() * n)

const INDENTS = ['', ' ', '  ', '   ', '    ', '     ', '      ']

/**
 * How a construct is placed inside (or outside) a block container.
 *
 * `prefix` puts the marker on the construct's FIRST line, the way this script
 * used to do it exclusively. `lead` + `indent` puts the marker on a PRECEDING
 * line and indents EVERY line of the construct under it — the house style, and
 * the shape the old same-line-only list could never generate. Leaving it out
 * under-sampled the interesting half of the search space by roughly two orders
 * of magnitude; every container defect the review rounds found lives in it.
 */
const CONTAINERS = [
  { lead: [], prefix: '', indent: '' },
  { lead: [], prefix: '- ', indent: '' },
  { lead: [], prefix: '* ', indent: '' },
  { lead: [], prefix: '1. ', indent: '' },
  { lead: [], prefix: '> ', indent: '' },
  { lead: [], prefix: '- > ', indent: '' },
  { lead: ['- an entry with an example:', ''], prefix: '', indent: '  ' },
  { lead: ['- an entry with an example:'], prefix: '', indent: '  ' },
  { lead: ['* an entry with an example:', ''], prefix: '', indent: '  ' },
  { lead: ['1. an entry with an example:', ''], prefix: '', indent: '   ' },
  { lead: ['- an entry, over-indented example:', ''], prefix: '', indent: '    ' },
  { lead: ['> quoted context', ''], prefix: '', indent: '> ' },
]

/**
 * Place `lines` in `container`. The marker either leads the first line or sits
 * on its own line above, with the whole construct indented beneath it.
 * @param {string[]} lines
 * @param {{lead: string[], prefix: string, indent: string}} container
 * @returns {string[]}
 */
function place(lines, container) {
  if (container.lead.length === 0) {
    return lines.map((l, i) => (i === 0 ? container.prefix + l : l))
  }
  return [...container.lead, ...lines.map((l) => container.indent + l)]
}

/**
 * Emit one random block construct as an array of lines.
 *
 * The generator is written from the SPEC, not from the masker's source: it does
 * not know which shapes the guard finds hard, which is the whole point of a
 * differential. Constructs are drawn independently and concatenated, so the
 * interesting cases (a fence opened in a container and closed at column 0, a
 * comment interleaved with a fence, a delimiter whose length or indent does not
 * match its opener) arise from the composition rather than being planted.
 *
 * @param {() => number} r
 * @param {boolean} modelledOnly drop the constructs the masker openly does not
 *   model (raw HTML blocks, block quotes, setext). Their divergences are known,
 *   documented and fail-CLOSED by construction; leaving them in swamps the
 *   fail-CLOSED column with ~34% noise and hides movement in the numbers that
 *   are actually about fences and comments.
 * @returns {string[]}
 */
function construct(r, modelledOnly) {
  const kind = pick(
    r,
    modelledOnly
      ? ['fence', 'fence', 'fence', 'comment', 'comment', 'heading', 'heading', 'prose', 'list', 'indented-code', 'tabs']
      : [
          'fence',
          'fence',
          'fence',
          'comment',
          'comment',
          'heading',
          'heading',
          'prose',
          'list',
          'quote',
          'indented-code',
          'setext',
          'html-block',
          'tabs',
        ],
  )
  switch (kind) {
    case 'fence': {
      // Opener and closer are drawn INDEPENDENTLY: char, run length and indent
      // may all mismatch, which is where CommonMark's "closer must be the same
      // char and at least as long" rule earns its keep.
      const char = pick(r, ['`', '~'])
      const openLen = 3 + upto(r, 3)
      const openIndent = pick(r, INDENTS)
      const container = pick(r, CONTAINERS)
      const info = char === '`' ? pick(r, ['', 'yaml', 'console', 'text']) : pick(r, ['', 'js'])
      const body = []
      for (let i = 0, n = upto(r, 3); i <= n; i++) {
        body.push(openIndent + pick(r, ['key: value', '$ cmd', '## v9.9.9 — pasted', '<!-- x', '-->']))
      }
      const lines = [openIndent + char.repeat(openLen) + info, ...body]
      // A quarter of fences are left unclosed on purpose — an unclosed fence
      // runs to EOF in CommonMark, and inside a container it ends with the
      // container instead, which is the whole container question.
      if (r() < 0.75) {
        lines.push(pick(r, INDENTS) + char.repeat(3 + upto(r, 3)))
      }
      return place(lines, container)
    }
    case 'comment': {
      const indent = pick(r, INDENTS)
      const container = pick(r, CONTAINERS)
      const open = pick(r, ['<!--', '<!-->', '<!--->', '<!-- note', '<!---->'])
      const lines = [indent + open]
      if (!open.includes('-->')) {
        for (let i = 0, n = upto(r, 3); i <= n; i++) {
          lines.push(indent + pick(r, ['note', '## v8.8.8 — commented out', '```', 'text']))
        }
        if (r() < 0.75) lines.push(pick(r, INDENTS) + pick(r, ['-->', 'tail -->']))
      }
      return place(lines, container)
    }
    case 'heading':
      return [`## S${upto(r, 100)}`]
    case 'prose':
      return [pick(r, ['some prose', 'more words here', 'a line', '`inline` code'])]
    case 'list':
      return [`${pick(r, ['- ', '* ', '1. '])}item`, `${pick(r, ['  ', '   '])}continued`]
    case 'quote':
      return ['> quoted', '> ## S404 — inside a block quote']
    case 'indented-code':
      return ['    literal code', '    ## v7.7.7 — indented, not a heading']
    case 'setext':
      return ['Setext heading', pick(r, ['---', '===', '- - -'])]
    case 'html-block':
      // Types 1/6/7 — the ones the masker explicitly does not model.
      return [pick(r, ['<div>', '<pre>', '<table>', '<script>']), '## S500 — raw HTML', '</div>']
    case 'tabs':
      return ['\t```', '\ttabbed code']
    default:
      return ['fallback']
  }
}

/** @param {() => number} r @param {boolean} modelledOnly */
function document(r, modelledOnly) {
  /** @type {string[]} */
  const lines = ['## Unreleased', '', '- **Entry (#0):** staged.', '']
  for (let i = 0, n = 1 + upto(r, 5); i < n; i++) {
    lines.push(...construct(r, modelledOnly), '')
  }
  lines.push('## v0.20.11 — a released section', '', '- **Shipped (#1):** prose.', '')
  return lines.join('\n')
}

/**
 * EVERY level-2 heading node the reference implementation produces, with the
 * source line it came from and whether that line is a column-0 `## ` ATX
 * opener. Deliberately UNFILTERED: the guard's column-0 policy is the thing
 * under test, so the oracle must not bake it in.
 * @param {string} md
 * @returns {{line: number, columnZero: boolean}[]}
 */
function oracleH2(md) {
  const srcLines = md.split('\n')
  const walker = new Parser().parse(md).walker()
  /** @type {{line: number, columnZero: boolean}[]} */
  const out = []
  let ev
  while ((ev = walker.next())) {
    if (!ev.entering || ev.node.type !== 'heading' || ev.node.level !== 2) continue
    const line = ev.node.sourcepos[0][0]
    out.push({
      line,
      columnZero: ev.node.sourcepos[0][1] === 1 && /^##\s/.test(srcLines[line - 1] ?? ''),
    })
  }
  return out
}

/** The 1-based lines the guard reports as section headings. */
function guardH2Lines(/** @type {string} */ md) {
  return parseSections(md).map((s) => s.headingLine)
}

function main() {
  const argv = process.argv.slice(2)
  /** @param {string} name @param {string} fallback */
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? fallback : argv[i + 1]
  }
  const docs = Number(arg('docs', '60000'))
  const seed = Number(arg('seed', '1'))
  const modelledOnly = argv.includes('--modelled-only')

  const r = rng(seed)
  let failOpen = 0
  let failClosed = 0
  let policy = 0
  /** @type {string[]} */
  const samples = []
  for (let i = 0; i < docs; i++) {
    const md = document(r, modelledOnly)
    const want = oracleH2(md)
    const got = new Set(guardH2Lines(md))
    const wantLines = new Set(want.map((h) => h.line))

    // A heading the reference produced that the guard does not report. If its
    // source line is a column-0 `## ` opener that is a genuine fail-OPEN; if it
    // is indented or setext it is the documented policy.
    let docFailOpen = false
    for (const h of want) {
      if (got.has(h.line)) continue
      if (h.columnZero) docFailOpen = true
      else policy++
    }
    if (docFailOpen) {
      failOpen++
      if (samples.length < 5) samples.push(md)
    }
    // A section the guard reports where the reference produced no heading at all.
    if ([...got].some((l) => !wantLines.has(l))) failClosed++
  }

  console.log(
    `docs=${docs} seed=${seed} oracle=commonmark@0.31.2` +
      (modelledOnly ? ' scope=modelled-only' : ' scope=all-constructs'),
  )
  console.log(`fail-OPEN   ${failOpen}`)
  console.log(`fail-CLOSED ${failClosed}`)
  console.log(`policy      ${policy}  (indented / setext h2 the guard deliberately drops)`)
  if (samples.length > 0) {
    console.log('\nfirst fail-open samples:\n')
    for (const s of samples) console.log(`${'-'.repeat(60)}\n${s}`)
  }
  process.exitCode = failOpen > 0 ? 1 : 0
}

main()
