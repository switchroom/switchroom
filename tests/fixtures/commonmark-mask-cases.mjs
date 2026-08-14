/**
 * The CommonMark differential battery for `maskNonProseWithState` in
 * `scripts/check-changelog-entry.mjs`.
 *
 * Why this file exists
 * --------------------
 * The guard's masker is a hand-written partial CommonMark implementation: it
 * models fenced code blocks and HTML block type 2 (comments) and nothing else.
 * Every review round of that masker has turned on the question "what does
 * CommonMark actually say here?", and each round the answer was argued from a
 * throwaway script that was never committed — so the next round could not
 * re-run it, and a real fail-open (`<!-->`, a COMPLETE comment per CommonMark
 * 0.30+, read as an unterminated opener) survived two of them. Load-bearing
 * evidence that is not in the repo does not exist. This is that evidence,
 * committed.
 *
 * How to read a row
 * -----------------
 * Each case is a tiny changelog. `commonmarkH2` is the list of level-2 headings
 * the REFERENCE implementation renders; `guardH2` is what `parseSections` sees.
 * `agrees` records whether the guard matches CommonMark, and for the rows where
 * it does not, `divergence` names the DIRECTION:
 *
 *   - `fail-closed` — the guard invents a section CommonMark does not render.
 *     Worst case a false FAIL (a legitimate PR blocked), repo-wide and sticky
 *     once such a block lands on main.
 *   - `fail-open`   — the guard loses a section CommonMark does render, so the
 *     placement rule cannot see entries under it. Worst case a buried entry
 *     reported as OK, which is the failure this guard exists to prevent.
 *
 * The test asserts BOTH columns, so a change that closes a divergence (or opens
 * a new one) fails loudly and forces this table to be updated rather than
 * quietly changing what the guard believes.
 *
 * Regenerating the `commonmarkH2` column
 * --------------------------------------
 * `commonmark` is the reference implementation and is deliberately NOT a
 * dependency of this repo — one differential table does not justify a
 * supply-chain entry. Regenerate out-of-tree:
 *
 *   mkdir -p /tmp/cm-oracle && cd /tmp/cm-oracle && npm i commonmark
 *   node --input-type=module -e '
 *     import { createRequire } from "node:module"
 *     const require = createRequire("/tmp/cm-oracle/")
 *     const cm = require("commonmark")
 *     const { CASES } = await import("<repo>/tests/fixtures/commonmark-mask-cases.mjs")
 *     const p = new cm.Parser(), w = new cm.HtmlRenderer()
 *     for (const c of CASES) {
 *       const html = w.render(p.parse(c.md))
 *       const h2 = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1])
 *       console.log(c.name, JSON.stringify(h2))
 *     }'
 *
 * Every row below was produced that way against commonmark@0.31.2 (the JS
 * reference implementation, spec 0.31.2) on 2026-08-14.
 */

/**
 * @typedef {object} MaskCase
 * @property {string} name
 * @property {string} md the whole document
 * @property {string[]} commonmarkH2 level-2 headings the reference impl renders
 * @property {string[]} guardH2 headings `parseSections` reports (trimmed)
 * @property {boolean} agrees
 * @property {'fail-open'|'fail-closed'|null} divergence
 * @property {string} why one line of spec grounding
 */

/** Build a document: `## Unreleased`, the construct under test, then a release. */
const doc = (/** @type {string[]} */ construct) =>
  ['## Unreleased', '', ...construct, '', '## v9.9.9', '', '- entry', ''].join('\n')

/** @type {MaskCase[]} */
export const CASES = [
  // ── HTML comments (the only HTML block type the guard models) ────────────
  {
    name: 'closed comment, one line',
    md: doc(['<!-- staging area -->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'HTML block type 2 opens and closes on the same line.',
  },
  {
    name: 'comment body carries a `## ` line',
    md: doc(['<!--', '## v1.2.3 — a note, not a section', '-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Inside an HTML block a `## ` line is raw HTML, not an ATX heading.',
  },
  {
    name: 'BLOCKER: `<!-->` is a COMPLETE comment',
    md: doc(['<!-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'CommonMark 0.30+: `<!-->` is a comment; type 2 ends on a line containing `-->`.',
  },
  {
    name: 'BLOCKER: `<!--->` is a COMPLETE comment',
    md: doc(['<!--->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'CommonMark 0.30+: `<!--->` is a comment, closer overlaps the opener dashes.',
  },
  {
    name: '`<!---->` (four dashes each side) closes normally',
    md: doc(['<!---->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The `-->` starts at offset 4; no overlap involved.',
  },
  {
    name: 'unterminated line-start `<!--` swallows to the next `-->`',
    md: doc(['<!--', '', '## v0.0.1 — swallowed', '', '-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Type 2 runs until a line contains `-->`; a blank line does not end it.',
  },
  {
    name: 'line-start `<!--` never closed runs to EOF',
    md: ['## Unreleased', '', '<!--', '', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    agrees: true,
    why: 'An HTML block with no end condition runs to end of document.',
  },
  {
    name: 'mid-line `<!--` is inline raw HTML and stays literal',
    md: doc(['- prose quoting a bare `<!--` opener']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Type 2 must be line-start-anchored; inline raw HTML cannot span lines.',
  },
  {
    name: '3-space indented `<!--` opens a block that a column-0 line ends',
    md: doc(['   <!--', '## v0.0.1 — swallowed', '-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.1 — swallowed', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'CommonMark keeps this doc-level block open; the guard ends it at the dedent (container scoping) and sees a phantom section.',
  },
  {
    name: '4-space indented `<!--` is indented code, not an opener',
    md: doc(['', '    <!--', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: '4 spaces is an indented code block; the ≤3-space anchor already excludes it.',
  },
  {
    name: 'text after a closing `-->` on the same line is not a heading',
    md: doc(['<!-- note --> ## v0.0.1']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The `## ` is mid-line text, and an ATX heading must start its line.',
  },
  {
    name: 'tail after a multi-line comment closes mid-line',
    md: doc(['<!--', 'note', '--> trailing prose <!-- and a pair -->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The tail is prose; intra-line pairs in it are still comments.',
  },
  {
    name: 'an unterminated `<!--` in the TAIL cannot reopen a block',
    md: doc(['<!--', 'note', '--> tail with a bare <!-- in it', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'A tail is mid-line by construction, so no opener there is line-start-anchored.',
  },

  // ── Fenced code blocks ───────────────────────────────────────────────────
  {
    name: 'backtick fence hides a `## ` line',
    md: doc(['```', '## v0.0.1 — pasted stdout', '```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Fence content is literal code.',
  },
  {
    name: 'tilde fence hides a `## ` line',
    md: doc(['~~~', '## v0.0.1 — pasted stdout', '~~~']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Tilde fences behave identically to backtick fences.',
  },
  {
    name: 'fence with an info string',
    md: doc(['```console', '## v0.0.1 — pasted stdout', '```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'An info string does not change the fence.',
  },
  {
    name: 'a longer fence may contain a shorter one',
    md: doc(['````', '```', '## v0.0.1', '```', '````']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The closer must be at least as long as the opener.',
  },
  {
    name: 'a shorter fence does NOT close a longer one',
    md: ['## Unreleased', '', '````', '```', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    agrees: true,
    why: 'Closer shorter than opener is content; the block runs to EOF.',
  },
  {
    name: 'a closer with trailing text does not close',
    md: ['## Unreleased', '', '```', 'x', '``` nope', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    agrees: true,
    why: 'Only whitespace may follow a closing fence.',
  },
  {
    name: '3-space indented fence opens, but a column-0 line ends it',
    md: doc(['   ```', '## v0.0.1', '   ```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.1', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'Same container-scoping trade as the indented `<!--` row: the dedent ends the block early, so the guard invents a section.',
  },
  {
    name: 'an opener whose info string holds a backtick is not a fence',
    md: doc(['``` a `tick` in the info string', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'A backtick-fence info string may not contain a backtick.',
  },
  {
    name: 'unclosed fence runs to EOF',
    md: ['## Unreleased', '', '```', 'oops', '', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    agrees: true,
    why: 'An unclosed fence runs to end of document — hence the WARN.',
  },
  {
    name: 'a `<!--` INSIDE a fence is code, and the fence still closes',
    md: doc(['```html', '<!-- unterminated on purpose', '```', '', '- prose with an --> arrow']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Inside a fence nothing else is markup — the round-2 fail-open.',
  },
  {
    name: 'a fence marker inside a real comment does not open a fence',
    md: doc(['<!--', '```', 'still comment', '-->', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Whichever construct opens FIRST swallows the other.',
  },
  {
    name: 'a fence opened inside a comment does not survive the `-->`',
    md: doc(['<!--', '```', '-->', '', '## v0.0.2 — a REAL heading after the comment']),
    commonmarkH2: ['Unreleased', 'v0.0.2 — a REAL heading after the comment', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.2 — a REAL heading after the comment', '## v9.9.9'],
    agrees: true,
    why: 'The comment ends at `-->`; the ``` inside it never opened anything.',
  },

  // ── Container scoping (the round-5 fail-open) ────────────────────────────
  // CommonMark scopes a fence or HTML block opened INSIDE a list item to that
  // list item: a column-0 line ends the list, ends the block, and is a real
  // heading. A masker with no notion of the container keeps the block open at
  // document level and blanks straight through every heading below it. This is
  // NOT a hypothetical shape — the real CHANGELOG.md already ships it (an entry
  // whose example block is indented under its bullet).
  {
    name: 'CONTAINER: an unclosed fence indented under a list item ends with the item',
    md: doc([
      '- an entry whose example block is indented under the bullet:',
      '',
      '  ```yaml',
      '  key: value',
    ]),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The list item ends at the column-0 heading, so the fence inside it ends too.',
  },
  {
    name: 'CONTAINER: an unclosed comment indented under a list item ends with the item',
    md: ['## Unreleased', '', '- entry', '  <!--', '', '## v9.9.9', '', '- entry', '', '-->', ''].join(
      '\n',
    ),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'Same container rule for HTML block type 2: the `-->` far below does not keep it open.',
  },
  {
    name: 'CONTAINER: a fence under a bullet that closes normally (the house style)',
    md: doc(['- an entry with an example:', '', '  ```yaml', '  key: value', '  ```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The common shape: a closer at the opener indent closes it before any dedent.',
  },
  {
    name: 'CONTAINER: a column-0 closer CLOSES an indented fence, it does not open one',
    md: ['## Unreleased', '', '  ```', '- entry', '```', '', '## v9.9.9', '', '- entry', ''].join(
      '\n',
    ),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'A closer may be indented less than its opener; misreading it as an opener would run to EOF (fail-open).',
  },
  {
    name: "CONTAINER: a dedented comment's real `-->` still closes it",
    md: [
      '## Unreleased',
      '',
      '- entry',
      ' <!--',
      '~~~',
      '<!-- pair -->',
      '',
      '## v9.9.9',
      '',
      '- entry',
      '',
    ].join('\n'),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'After a dedent the guard opens nothing until the pending closer, so the `~~~` cannot start a run-to-EOF fence.',
  },
  {
    name: "CONTAINER: masking RESUMES once the dedented comment's `-->` is seen",
    md: [
      '## Unreleased',
      '',
      '- entry',
      ' <!--',
      'still comment',
      '<!-- reviewer note -->',
      '',
      '```console',
      '## v0.0.1 — pasted output',
      '```',
      '',
      '## v9.9.9',
      '',
      '- entry',
      '',
    ].join('\n'),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The resync state is not a one-way latch: leave it stuck and the fence below never masks, so its `## ` becomes a phantom section.',
  },
  {
    name: "CONTAINER: masking RESUMES once the dedented fence's closer is seen",
    md: [
      '## Unreleased',
      '',
      '- entry',
      '  ```yaml',
      'key: value',
      '```',
      '',
      '```console',
      '## v0.0.1 — pasted output',
      '```',
      '',
      '## v9.9.9',
      '',
      '- entry',
      '',
    ].join('\n'),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: true,
    why: 'The fence half of the resync rule: miss the pending closer and the fence below never masks, so its `## ` becomes a phantom section.',
  },
  {
    name: 'CONTAINER: a doc-level indented fence really does run to EOF',
    md: ['## Unreleased', '', '  ```yaml', '  key: value', '', '## v9.9.9', '', '- entry', ''].join(
      '\n',
    ),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'The price of container scoping: with no bullet the block IS document-level, and the guard ends it early.',
  },

  // ── HTML block types the guard deliberately does NOT model ───────────────
  // Realism on THIS file is nil (the real CHANGELOG.md has zero line-start HTML
  // block openers), but the directions are recorded so the docstring's claim is
  // checkable rather than asserted.
  {
    name: 'UNMODELLED type 1 (`<script>`) containing a `## ` line',
    md: doc(['<script>', '## v0.0.1 — inside a script block', '</script>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.1 — inside a script block', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'Type 1 content is raw HTML; the guard reads the `## ` as a phantom released section.',
  },
  {
    name: 'UNMODELLED type 3 (`<?`) containing a `## ` line',
    md: doc(['<?php', '## v0.0.1 — inside a processing instruction', '?>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.1 — inside a processing instruction', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'Type 3 runs to `?>`; the guard sees a phantom released section inside it.',
  },
  {
    name: 'UNMODELLED type 4 (`<!DECLARATION`) containing a `## ` line',
    md: doc(['<!DOCTYPE html', '## v0.0.1 — inside a declaration', '>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.1 — inside a declaration', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'Type 4 runs to `>`; same phantom-section direction.',
  },
  {
    name: 'UNMODELLED type 5 (`<![CDATA[`) containing a `## ` line',
    md: doc(['<![CDATA[', '## v0.0.1 — inside CDATA', ']]>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.1 — inside CDATA', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'Type 5 runs to `]]>`; same phantom-section direction.',
  },
  {
    name: 'UNMODELLED type 6 (`<div>`) containing a `## ` line',
    md: doc(['<div>', '## v0.0.1 — inside a div', '</div>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.1 — inside a div', '## v9.9.9'],
    agrees: false,
    divergence: 'fail-closed',
    why: 'Type 6 runs to a blank line; same phantom-section direction.',
  },
  {
    name: 'UNMODELLED type 6 whose body holds a line-start `<!--`',
    md: doc(['<div>', '<!-- a comment INSIDE the html block', '</div>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased'],
    agrees: false,
    divergence: 'fail-open',
    why: 'Inside a type-6 block the `<!--` is content, not an opener; the guard masks past it.',
  },
]
