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
 * `commonmark@0.31.2` itself. The guard still applies a deliberate FILTER on
 * top of the parse (a heading is a section only at column 0, only as an ATX
 * `## ` opener), and a filter is exactly the kind of thing that can be subtly
 * wrong — so the script's job is to prove that every heading the guard drops is
 * dropped by that documented policy and by nothing else.
 *
 * WHY THE SCORING LOOKS THE WAY IT DOES (review of #4703)
 * ------------------------------------------------------
 * The first version of this file shipped with a header claiming it was not
 * tautological, and it was. Its oracle computed
 *
 *   columnZero = sourcepos[0][1] === 1 && /^##\s/.test(src[line - 1])
 *
 * which is character-for-character the predicate at `check-changelog-entry.mjs`
 * `analyze`. Since `headings[]` is built from parser heading nodes and nothing
 * else, `parseSections` WAS the oracle's column-zero set for every input, and
 * `failOpen` / `failClosed` were hard-wired to 0. Measured, at 20k docs seed 1:
 * breaking the guard's heading filter (honour the ≤3-space tolerance) and
 * disabling fence masking outright (`const fenced = false`) each left the
 * report at `fail-OPEN 0  fail-CLOSED 0` and exit 0. Both mutants die in the
 * vitest suites; neither was visible to the PR's headline evidence.
 *
 * So the policy is now RE-DERIVED FROM THE SOURCE TEXT (`classifyH2` below),
 * the way `tests/changelog-mask-commonmark-battery.test.ts`'s divergence test
 * already did it, and the comparison runs against ALL rendered level-2 nodes.
 * Two consequences worth stating out loud:
 *
 *   - the anchor's OWN fail-open direction is now scored (`policy-VIOLATION`):
 *     a guard that starts honouring the indent tolerance reports headings the
 *     policy says it must drop, which the old oracle counted as agreement;
 *   - block masking is scored at all (`mask-fail-OPEN`), through the consumer
 *     that actually depends on it. A heading-shaped line the reference renders
 *     as CODE must never be credited as a staged entry, and that question is
 *     answered by the reference's heading nodes rather than by re-deriving the
 *     guard's `code_block`/`html_block` walk.
 *
 * Non-vacuity is not a claim here, it is a command. Both mutants above now
 * report non-zero and exit 1; re-run them before trusting a number from this
 * file.
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
 *   fail-OPEN    — the reference renders a level-2 heading whose source line is
 *                  a plain, unindented ATX opener and the guard does not report
 *                  it. The placement rule then cannot check entries under it: a
 *                  buried entry reported OK. Must be ZERO.
 *   fail-CLOSED  — the guard reports a section at a line where the reference
 *                  renders no heading at all. Worst case a false FAIL. Must be
 *                  ZERO.
 *   policy-VIOL  — the guard reports a heading the documented policy says it
 *                  MUST drop (indented, or setext). This is the anchor's own
 *                  fail-open direction, the one the old oracle could not see:
 *                  honouring CommonMark's ≤3-space tolerance lets a list line
 *                  reading `   ## Unreleased` un-release the rest of the file.
 *                  Must be ZERO.
 *   unenforced   — an indented heading the guard drops and `findIndentedHeadings`
 *                  does NOT report. Silently losing a section is the fail-open
 *                  the anchor's enforcement closes, so a drop that nothing names
 *                  is a defect. Must be ZERO.
 *   mask-fail-OPEN — a heading-shaped source line the reference renders as CODE
 *                  (no heading node) that the guard nevertheless credits as a
 *                  staged `## Unreleased` entry. This is the block-masking half,
 *                  which the old scoring did not exercise at all. Must be ZERO.
 *   policy       — how many headings the reference renders that the guard
 *                  deliberately drops (indented / setext). Reported for
 *                  visibility, not scored: a corpus change moves it, and a
 *                  reader deserves to see it move rather than have it folded
 *                  into "agrees".
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

import {
  extractUnreleasedEntries,
  findIndentedHeadings,
  parseSections,
} from './check-changelog-entry.mjs'

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
 * Serial number stamped into every generated sentinel line, so no two source
 * lines in a document share text.
 *
 * Not cosmetic. `mask-fail-OPEN` has to attribute a credited entry back to the
 * SOURCE LINE it came from, and `extractUnreleasedEntries` returns trimmed text
 * (it is RULE 1's real input, which is the point of scoring through it). With a
 * shared `## v9.9.9 — pasted` sentinel, a document that carried one copy inside
 * a fence and another inside a 4-space INDENTED code block scored a false
 * fail-open on every run: the guard deliberately does NOT mask indented code —
 * a literal block under `## Unreleased` is a legitimate entry body — so
 * crediting the second copy is correct, and text alone cannot tell it from the
 * first. Measured: 37 such false positives at 20k docs seed 1. Unique text
 * makes the comparison line-precise without teaching the oracle the guard's
 * fenced-vs-indented rule, which is the thing under test.
 *
 * Reset per document so a seed still reproduces a corpus exactly.
 */
let serial = 0

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
        body.push(
          openIndent + pick(r, ['key: value', '$ cmd', `## v9.9.9 — pasted ${serial++}`, '<!-- x', '-->']),
        )
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
          lines.push(indent + pick(r, ['note', `## v8.8.8 — commented out ${serial++}`, '```', 'text']))
        }
        if (r() < 0.75) lines.push(pick(r, INDENTS) + pick(r, ['-->', 'tail -->']))
      }
      return place(lines, container)
    }
    case 'heading':
      return [`## S${upto(r, 100)}-${serial++}`]
    case 'prose':
      return [pick(r, ['some prose', 'more words here', 'a line', '`inline` code'])]
    case 'list':
      return [`${pick(r, ['- ', '* ', '1. '])}item`, `${pick(r, ['  ', '   '])}continued`]
    case 'quote':
      return ['> quoted', `> ## S404 — inside a block quote ${serial++}`]
    case 'indented-code':
      return ['    literal code', `    ## v7.7.7 — indented, not a heading ${serial++}`]
    case 'setext':
      return ['Setext heading', pick(r, ['---', '===', '- - -'])]
    case 'html-block':
      // Types 1/6/7 — the ones the masker explicitly does not model.
      return [
        pick(r, ['<div>', '<pre>', '<table>', '<script>']),
        `## S500 — raw HTML ${serial++}`,
        '</div>',
      ]
    case 'tabs':
      return ['\t```', '\ttabbed code']
    default:
      return ['fallback']
  }
}

/** @param {() => number} r @param {boolean} modelledOnly */
function document(r, modelledOnly) {
  serial = 0
  /** @type {string[]} */
  const lines = ['## Unreleased', '', '- **Entry (#0):** staged.', '']
  for (let i = 0, n = 1 + upto(r, 5); i < n; i++) {
    lines.push(...construct(r, modelledOnly), '')
  }
  lines.push('## v0.20.11 — a released section', '', '- **Shipped (#1):** prose.', '')
  return lines.join('\n')
}

/**
 * Which documented policy class a rendered level-2 heading falls into, decided
 * from its SOURCE LINE and nothing else.
 *
 * This is the whole point of the rewrite. The predicate the guard uses is
 * `sourcepos[0][1] === 1 && /^##\s/.test(raw)`; copying it here is what made
 * the old oracle a mirror. These three shapes are facts about the text —
 * "starts with 1–3 spaces then a `#`", "does not start with a `#` at all, so
 * the node came from a setext underline", "everything else" — and they are the
 * same classification `tests/changelog-mask-commonmark-battery.test.ts`'s
 * divergence test derives independently.
 *
 * @param {string} raw the source line the heading node starts on
 * @returns {'indented' | 'setext' | 'plain'}
 */
function classifyH2(raw) {
  if (/^ {1,3}#/.test(raw)) return 'indented'
  if (!/^ {0,3}#/.test(raw)) return 'setext'
  return 'plain'
}

/**
 * EVERY level-2 heading node the reference implementation produces, with the
 * source line it came from and its policy class. Deliberately UNFILTERED: the
 * guard's column-0 policy is the thing under test, so the oracle must not bake
 * it in.
 * @param {string} md
 * @returns {{line: number, cls: 'indented' | 'setext' | 'plain'}[]}
 */
function oracleH2(md) {
  const srcLines = md.split('\n')
  const walker = new Parser().parse(md).walker()
  /** @type {{line: number, cls: 'indented' | 'setext' | 'plain'}[]} */
  const out = []
  let ev
  while ((ev = walker.next())) {
    if (!ev.entering || ev.node.type !== 'heading' || ev.node.level !== 2) continue
    const line = ev.node.sourcepos[0][0]
    out.push({ line, cls: classifyH2(srcLines[line - 1] ?? '') })
  }
  return out
}

/**
 * The heading-shaped source lines the reference renders as CODE rather than as
 * headings, as trimmed text — i.e. the lines block masking exists to suppress.
 *
 * Derived from the reference's heading NODES (a `#`-shaped line that produced
 * no heading is inside a fence, an HTML block or an indented code block), NOT
 * from re-walking `code_block` / `html_block` the way the guard does. A text
 * that appears BOTH swallowed and as a real heading somewhere in the same
 * document is excluded: crediting it as an entry would then be legitimate, and
 * an oracle that cannot tell the two apart invents fail-opens.
 *
 * @param {string} md
 * @returns {Set<string>}
 */
function swallowedHeadingText(md) {
  const src = md.split('\n')
  const walker = new Parser().parse(md).walker()
  /** @type {Set<number>} */
  const headingLines = new Set()
  let ev
  while ((ev = walker.next())) {
    if (ev.entering && ev.node.type === 'heading') headingLines.add(ev.node.sourcepos[0][0])
  }
  /** @type {Set<string>} */
  const swallowed = new Set()
  /** @type {Set<string>} */
  const real = new Set()
  src.forEach((raw, i) => {
    if (!/^ {0,3}#{1,6}\s/.test(raw)) return
    ;(headingLines.has(i + 1) ? real : swallowed).add(raw.trim())
  })
  for (const t of real) swallowed.delete(t)
  return swallowed
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
  let policyViolation = 0
  let unenforced = 0
  let maskFailOpen = 0
  let policy = 0
  /** @type {{why: string, md: string}[]} */
  const samples = []
  /** @param {string} why @param {string} md */
  const sample = (why, md) => {
    if (samples.length < 5) samples.push({ why, md })
  }
  for (let i = 0; i < docs; i++) {
    const md = document(r, modelledOnly)
    const want = oracleH2(md)
    const got = new Set(guardH2Lines(md))
    const wantLines = new Set(want.map((h) => h.line))

    // Expected = every rendered h2 the documented policy does NOT drop. The
    // policy set comes from `classifyH2`, i.e. from the source text — not from
    // the guard, which is the thing being scored.
    let docFailOpen = false
    let docPolicyViolation = false
    for (const h of want) {
      const dropped = h.cls !== 'plain'
      if (dropped) policy++
      if (got.has(h.line)) {
        // The guard reported it. Legal only for the plain class: reporting an
        // indented or setext heading IS the anchor's fail-open.
        if (dropped) docPolicyViolation = true
      } else if (!dropped) {
        docFailOpen = true
      }
    }
    if (docFailOpen) {
      failOpen++
      sample('fail-OPEN', md)
    }
    if (docPolicyViolation) {
      policyViolation++
      sample('policy-VIOLATION', md)
    }

    // A section the guard reports where the reference produced no heading at all.
    if ([...got].some((l) => !wantLines.has(l))) {
      failClosed++
      sample('fail-CLOSED', md)
    }

    // Every indented heading the guard drops must be NAMED by the enforcement
    // that makes the drop safe. A silent drop is the fail-open that let an entry
    // buried under an indented `## v0.21.9` pass at exit 0.
    const named = new Set(findIndentedHeadings(md).map((h) => h.line))
    if (want.some((h) => h.cls === 'indented' && !got.has(h.line) && !named.has(h.line))) {
      unenforced++
      sample('unenforced-indent', md)
    }

    // Block masking, scored through the consumer that depends on it: a
    // heading-shaped line the reference renders as CODE must never be credited
    // as a staged entry.
    const swallowed = swallowedHeadingText(md)
    if (swallowed.size > 0 && extractUnreleasedEntries(md).some((e) => swallowed.has(e))) {
      maskFailOpen++
      sample('mask-fail-OPEN', md)
    }
  }

  console.log(
    `docs=${docs} seed=${seed} oracle=commonmark@0.31.2` +
      (modelledOnly ? ' scope=modelled-only' : ' scope=all-constructs'),
  )
  console.log(`fail-OPEN      ${failOpen}`)
  console.log(`fail-CLOSED    ${failClosed}`)
  console.log(`policy-VIOL    ${policyViolation}  (guard reported a heading the policy drops)`)
  console.log(`unenforced     ${unenforced}  (indented h2 dropped and not reported)`)
  console.log(`mask-fail-OPEN ${maskFailOpen}  (code credited as a staged entry)`)
  console.log(`policy         ${policy}  (indented / setext h2 the guard deliberately drops)`)
  if (samples.length > 0) {
    console.log('\nfirst failing samples:\n')
    for (const s of samples) console.log(`${'-'.repeat(60)}\n# ${s.why}\n${s.md}`)
  }
  process.exitCode =
    failOpen > 0 || failClosed > 0 || policyViolation > 0 || unenforced > 0 || maskFailOpen > 0
      ? 1
      : 0
}

main()
