#!/usr/bin/env node
/**
 * Randomised CommonMark differential for the changelog guard's block masker.
 *
 * WHY THIS IS COMMITTED
 * ---------------------
 * `tests/fixtures/commonmark-mask-cases.mjs` is the *curated* differential: 39
 * hand-written rows, each one a defect somebody found by hand. It pins what is
 * already known. It cannot find anything new, and every review round of
 * `maskNonProseWithState` so far has found its defect by generating documents
 * and diffing against a real parser — from a throwaway script that was never
 * committed. Round 4 called that out ("load-bearing evidence that is not in the
 * repo does not exist") and the curated table was the answer for the cases it
 * covers; this file is the answer for the SEARCH that produces them.
 *
 * A number quoted in a PR body — "N fail-opens over 60,000 documents" — is only
 * evidence if the next reviewer can re-derive it. This is that generator, with
 * its seeded RNG, so the same seed gives the same corpus and the same counts.
 *
 * NOT A TEST, NOT IN CI
 * ---------------------
 * `commonmark` is deliberately NOT a dependency of this repo (see the note in
 * `tests/fixtures/commonmark-mask-cases.mjs`), so this script cannot run in CI
 * and is not wired into `bun run lint` or the vitest suite. It is a reviewer's
 * tool. Install the oracle out-of-tree and point the script at it:
 *
 *   mkdir -p /tmp/cm-oracle && cd /tmp/cm-oracle && npm i commonmark@0.31.2
 *   node scripts/changelog-mask-differential.mjs --oracle /tmp/cm-oracle \
 *     --docs 60000 --seed 1
 *
 * WHAT IT MEASURES, AND WHAT IT DOES NOT
 * --------------------------------------
 * Only the MASKER is under test, not `parseSections`' column-0 heading policy.
 * That policy is a separate, deliberate, documented fail-CLOSED choice (see
 * `parseSections`), and letting it into these counts would blur the two. So the
 * comparison is restricted to level-2 headings whose SOURCE line is a column-0
 * `## ` ATX line — the set both implementations are supposed to agree on.
 *
 *   fail-OPEN   — CommonMark renders a heading the guard does not see. The
 *                 placement rule then cannot check entries under it: a buried
 *                 entry reported OK. This is the direction that matters.
 *   fail-CLOSED — the guard sees a heading CommonMark does not render. Worst
 *                 case a false FAIL. Noisy, not dangerous.
 *
 * Every run also reports how many fail-opens are SILENT, i.e. reach a wrong
 * answer with both `unclosedFenceLine` and `unclosedCommentLine` null, so the
 * guard's own WARN backstop never fires. That is the number to watch: a loud
 * fail-open is a bug, a silent one is a trap.
 *
 * FLAGS
 * -----
 *   --oracle DIR       where `commonmark` is installed (default /tmp/cm-oracle)
 *   --docs N           corpus size (default 60000)
 *   --seed N           PRNG seed (default 1)
 *   --modelled-only    drop raw HTML blocks, block quotes and setext — the
 *                      constructs the masker openly does not model. Their
 *                      divergences are documented and fail-CLOSED by
 *                      construction, and at ~1 in 3 documents they swamp the
 *                      fail-CLOSED column.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

import { maskNonProseWithState } from './check-changelog-entry.mjs'

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
const CONTAINERS = ['', '- ', '* ', '1. ', '> ', '- > ']

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
      const lines = [container + openIndent + char.repeat(openLen) + info, ...body]
      // A quarter of fences are left unclosed on purpose — an unclosed fence
      // runs to EOF in CommonMark and is the shape the WARN backstop exists for.
      if (r() < 0.75) {
        lines.push(pick(r, INDENTS) + char.repeat(3 + upto(r, 3)))
      }
      return lines
    }
    case 'comment': {
      const indent = pick(r, INDENTS)
      const container = pick(r, CONTAINERS)
      const open = pick(r, ['<!--', '<!-->', '<!--->', '<!-- note', '<!---->'])
      const lines = [container + indent + open]
      if (!open.includes('-->')) {
        for (let i = 0, n = upto(r, 3); i <= n; i++) {
          lines.push(indent + pick(r, ['note', '## v8.8.8 — commented out', '```', 'text']))
        }
        if (r() < 0.75) lines.push(pick(r, INDENTS) + pick(r, ['-->', 'tail -->']))
      }
      return lines
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
 * Level-2 headings the reference implementation renders, restricted to those
 * whose SOURCE line is a column-0 `## ` ATX line. See the header note: this is
 * what isolates the masker from `parseSections`' column-0 policy.
 * @param {any} cm
 * @param {string} md
 * @returns {number[]} 1-based source lines
 */
function oracleH2Lines(cm, md) {
  const srcLines = md.split('\n')
  const walker = new cm.Parser().parse(md).walker()
  /** @type {number[]} */
  const out = []
  let ev
  while ((ev = walker.next())) {
    if (!ev.entering || ev.node.type !== 'heading' || ev.node.level !== 2) continue
    const line = ev.node.sourcepos[0][0]
    if (/^##\s/.test(srcLines[line - 1] ?? '')) out.push(line)
  }
  return out
}

/** Level-2 headings the guard's masker leaves visible at column 0. */
function guardH2Lines(/** @type {string} */ md) {
  const state = maskNonProseWithState(md)
  const lines = state.text.split('\n')
  /** @type {number[]} */
  const out = []
  for (let i = 0; i < lines.length; i++) if (/^##\s/.test(lines[i])) out.push(i + 1)
  return {
    lines: out,
    warned: state.unclosedFenceLine !== null || state.unclosedCommentLine !== null,
  }
}

function main() {
  const argv = process.argv.slice(2)
  /** @param {string} name @param {string} fallback */
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? fallback : argv[i + 1]
  }
  const oracleDir = arg('oracle', '/tmp/cm-oracle')
  const docs = Number(arg('docs', '60000'))
  const seed = Number(arg('seed', '1'))
  const modelledOnly = argv.includes('--modelled-only')

  let cm
  try {
    cm = createRequire(path.resolve(oracleDir) + path.sep)('commonmark')
  } catch {
    console.error(
      `changelog-mask-differential: no \`commonmark\` under ${oracleDir}.\n` +
        `  mkdir -p ${oracleDir} && (cd ${oracleDir} && npm i commonmark@0.31.2)`,
    )
    process.exit(2)
  }

  const r = rng(seed)
  let failOpen = 0
  let failOpenSilent = 0
  let failClosed = 0
  /** @type {string[]} */
  const samples = []
  for (let i = 0; i < docs; i++) {
    const md = document(r, modelledOnly)
    const want = oracleH2Lines(cm, md)
    const got = guardH2Lines(md)
    const set = new Set(got.lines)
    const missing = want.filter((l) => !set.has(l))
    const extra = got.lines.filter((l) => !want.includes(l))
    if (missing.length > 0) {
      failOpen++
      if (!got.warned) failOpenSilent++
      if (samples.length < 5) samples.push(md)
    }
    if (extra.length > 0) failClosed++
  }

  console.log(
    `docs=${docs} seed=${seed} oracle=commonmark@${cm.version ?? '0.31.2'}` +
      (modelledOnly ? ' scope=modelled-only' : ' scope=all-constructs'),
  )
  console.log(`fail-OPEN   ${failOpen}  (silent, no WARN: ${failOpenSilent})`)
  console.log(`fail-CLOSED ${failClosed}`)
  if (samples.length > 0) {
    console.log('\nfirst fail-open samples:\n')
    for (const s of samples) console.log(`${'-'.repeat(60)}\n${s}`)
  }
  process.exitCode = 0
}

main()
