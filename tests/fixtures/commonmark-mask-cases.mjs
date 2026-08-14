/**
 * The CommonMark differential battery for the changelog guard's block parse in
 * `scripts/check-changelog-entry.mjs`.
 *
 * Why this file exists
 * --------------------
 * The guard used to approximate CommonMark block structure with a hand-written
 * masker. Every review round of it turned on the question "what does CommonMark
 * actually say here?", and each round the answer was argued from a throwaway
 * script that was never committed — so the next round could not re-run it, and
 * real fail-opens survived several of them. Load-bearing evidence that is not in
 * the repo does not exist. This is that evidence, committed.
 *
 * The guard now uses the reference implementation itself (`commonmark@0.31.2`,
 * a devDependency), so this table is no longer a record of where an
 * approximation went wrong. It is the CONFORMANCE corpus: the block shapes that
 * cost seven review rounds to get right, pinned so a future change to the
 * heading policy — or a parser upgrade — has to face them.
 *
 * How to read a row
 * -----------------
 * Each case is a tiny changelog.
 *
 *   - `commonmarkH2` — every level-2 heading the reference implementation
 *     RENDERS, in order.
 *   - `guardH2`      — the headings `parseSections` reports.
 *
 * The two differ ONLY where the guard's one deliberate divergence bites: a
 * heading is recognised at COLUMN 0 only, even though CommonMark allows up to 3
 * spaces of indent. That is a documented fail-CLOSED choice (see `parseSections`
 * for why it is fail-OPEN to honour the tolerance). Everywhere else the guard is
 * the parser, and the accompanying test proves it by deriving BOTH columns from
 * the reference implementation LIVE rather than trusting the numbers below —
 * these are committed so a human can read them, not so the test can believe them.
 *
 * Regenerating
 * ------------
 * `commonmark` is now an ordinary devDependency, so there is no out-of-tree
 * recipe any more:
 *
 *   node --input-type=module -e '
 *     import { Parser, HtmlRenderer } from "commonmark"
 *     const { CASES } = await import("./tests/fixtures/commonmark-mask-cases.mjs")
 *     for (const c of CASES) {
 *       const html = new HtmlRenderer().render(new Parser().parse(c.md))
 *       console.log(c.name, JSON.stringify([...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1])))
 *     }'
 */

/**
 * @typedef {object} MaskCase
 * @property {string} name
 * @property {string} md the whole document
 * @property {string[]} commonmarkH2 level-2 headings the reference impl renders
 * @property {string[]} guardH2 headings `parseSections` reports (trimmed)
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
    why: 'HTML block type 2 opens and closes on the same line.',
  },
  {
    name: 'comment body carries a `## ` line',
    md: doc(['<!--', '## v1.2.3 — a note, not a section', '-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Inside an HTML block a `## ` line is raw HTML, not an ATX heading.',
  },
  {
    name: 'BLOCKER: `<!-->` is a COMPLETE comment',
    md: doc(['<!-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'CommonMark 0.30+: `<!-->` is a comment; type 2 ends on a line containing `-->`.',
  },
  {
    name: 'BLOCKER: `<!--->` is a COMPLETE comment',
    md: doc(['<!--->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'CommonMark 0.30+: `<!--->` is a comment, closer overlaps the opener dashes.',
  },
  {
    name: '`<!---->` (four dashes each side) closes normally',
    md: doc(['<!---->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'The `-->` starts at offset 4; no overlap involved.',
  },
  {
    name: 'unterminated line-start `<!--` swallows to the next `-->`',
    md: doc(['<!--', '', '## v0.0.1 — swallowed', '', '-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Type 2 runs until a line contains `-->`; a blank line does not end it.',
  },
  {
    name: 'line-start `<!--` never closed runs to EOF',
    md: ['## Unreleased', '', '<!--', '', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    why: 'An HTML block with no end condition runs to end of document.',
  },
  {
    name: 'mid-line `<!--` is inline raw HTML and stays literal',
    md: doc(['- prose quoting a bare `<!--` opener']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Type 2 must be line-start-anchored; inline raw HTML cannot span lines.',
  },
  {
    name: '3-space indented `<!--` opens a block that a column-0 line ends',
    md: doc(['   <!--', '## v0.0.1 — swallowed', '-->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'A ≤3-space indent still opens a doc-level HTML block; the `-->` closes it. The approximation ended it at the dedent and invented a section.',
  },
  {
    name: '4-space indented `<!--` is indented code, not an opener',
    md: doc(['', '    <!--', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: '4 spaces is an indented code block; the ≤3-space anchor already excludes it.',
  },
  {
    name: 'text after a closing `-->` on the same line is not a heading',
    md: doc(['<!-- note --> ## v0.0.1']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'The `## ` is mid-line text, and an ATX heading must start its line.',
  },
  {
    name: 'tail after a multi-line comment closes mid-line',
    md: doc(['<!--', 'note', '--> trailing prose <!-- and a pair -->']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'The tail is prose; intra-line pairs in it are still comments.',
  },
  {
    name: 'an unterminated `<!--` in the TAIL cannot reopen a block',
    md: doc(['<!--', 'note', '--> tail with a bare <!-- in it', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'A tail is mid-line by construction, so no opener there is line-start-anchored.',
  },

  // ── Fenced code blocks ───────────────────────────────────────────────────
  {
    name: 'backtick fence hides a `## ` line',
    md: doc(['```', '## v0.0.1 — pasted stdout', '```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Fence content is literal code.',
  },
  {
    name: 'tilde fence hides a `## ` line',
    md: doc(['~~~', '## v0.0.1 — pasted stdout', '~~~']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Tilde fences behave identically to backtick fences.',
  },
  {
    name: 'fence with an info string',
    md: doc(['```console', '## v0.0.1 — pasted stdout', '```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'An info string does not change the fence.',
  },
  {
    name: 'a longer fence may contain a shorter one',
    md: doc(['````', '```', '## v0.0.1', '```', '````']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'The closer must be at least as long as the opener.',
  },
  {
    name: 'a shorter fence does NOT close a longer one',
    md: ['## Unreleased', '', '````', '```', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    why: 'Closer shorter than opener is content; the block runs to EOF.',
  },
  {
    name: 'a closer with trailing text does not close',
    md: ['## Unreleased', '', '```', 'x', '``` nope', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    why: 'Only whitespace may follow a closing fence.',
  },
  {
    name: '3-space indented fence opens, but a column-0 line ends it',
    md: doc(['   ```', '## v0.0.1', '   ```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'A ≤3-space indent still opens a doc-level fence; the closer closes it. The approximation ended it at the dedent and invented a section.',
  },
  {
    name: 'an opener whose info string holds a backtick is not a fence',
    md: doc(['``` a `tick` in the info string', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'A backtick-fence info string may not contain a backtick.',
  },
  {
    name: 'unclosed fence runs to EOF',
    md: ['## Unreleased', '', '```', 'oops', '', '## v9.9.9', '', '- entry', ''].join('\n'),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    why: 'An unclosed fence runs to end of document — hence the WARN.',
  },
  {
    name: 'a `<!--` INSIDE a fence is code, and the fence still closes',
    md: doc(['```html', '<!-- unterminated on purpose', '```', '', '- prose with an --> arrow']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Inside a fence nothing else is markup — the round-2 fail-open.',
  },
  {
    name: 'a fence marker inside a real comment does not open a fence',
    md: doc(['<!--', '```', 'still comment', '-->', '', '- prose after']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Whichever construct opens FIRST swallows the other.',
  },
  {
    name: 'a fence opened inside a comment does not survive the `-->`',
    md: doc(['<!--', '```', '-->', '', '## v0.0.2 — a REAL heading after the comment']),
    commonmarkH2: ['Unreleased', 'v0.0.2 — a REAL heading after the comment', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v0.0.2 — a REAL heading after the comment', '## v9.9.9'],
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
    why: 'The list item ends at the column-0 heading, so the fence inside it ends too.',
  },
  {
    name: 'CONTAINER: an unclosed comment indented under a list item ends with the item',
    md: ['## Unreleased', '', '- entry', '  <!--', '', '## v9.9.9', '', '- entry', '', '-->', ''].join(
      '\n',
    ),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Same container rule for HTML block type 2: the `-->` far below does not keep it open.',
  },
  {
    name: 'CONTAINER: a fence under a bullet that closes normally (the house style)',
    md: doc(['- an entry with an example:', '', '  ```yaml', '  key: value', '  ```']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'The common shape: a closer at the opener indent closes it before any dedent.',
  },
  {
    name: 'CONTAINER: a column-0 closer CLOSES an indented fence, it does not open one',
    md: ['## Unreleased', '', '  ```', '- entry', '```', '', '## v9.9.9', '', '- entry', ''].join(
      '\n',
    ),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
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
    why: 'The fence half of the resync rule: miss the pending closer and the fence below never masks, so its `## ` becomes a phantom section.',
  },
  {
    name: 'CONTAINER: a doc-level indented fence really does run to EOF',
    md: ['## Unreleased', '', '  ```yaml', '  key: value', '', '## v9.9.9', '', '- entry', ''].join(
      '\n',
    ),
    commonmarkH2: ['Unreleased'],
    guardH2: ['## Unreleased'],
    why: 'With no bullet the block IS document-level, so it really does run to EOF. The approximation ended it at the dedent and invented a section.',
  },

  // ── HTML block types 1 and 3–7 ───────────────────────────────────────────
  // These are the types the hand-written masker never modelled — it knew type 2
  // (comments) and nothing else, so each of these rows was a divergence, five
  // fail-CLOSED and one fail-OPEN. There is nothing to model any more: the
  // reference implementation knows all seven types, so they are ordinary rows.
  // Kept because "the guard handles every HTML block type" is a claim, and a
  // claim in a docstring with no row behind it is how this file started.
  {
    name: 'HTML type 1 (`<script>`) containing a `## ` line',
    md: doc(['<script>', '## v0.0.1 — inside a script block', '</script>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Type 1 content is raw HTML, so the `## ` is not a heading. The approximation modelled no HTML type but 2 and invented a section.',
  },
  {
    name: 'HTML type 3 (`<?`) containing a `## ` line',
    md: doc(['<?php', '## v0.0.1 — inside a processing instruction', '?>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Type 3 runs to `?>`, and everything inside it is raw HTML.',
  },
  {
    name: 'HTML type 4 (`<!DECLARATION`) containing a `## ` line',
    md: doc(['<!DOCTYPE html', '## v0.0.1 — inside a declaration', '>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Type 4 runs to `>`, and everything inside it is raw HTML.',
  },
  {
    name: 'HTML type 5 (`<![CDATA[`) containing a `## ` line',
    md: doc(['<![CDATA[', '## v0.0.1 — inside CDATA', ']]>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Type 5 runs to `]]>`, and everything inside it is raw HTML.',
  },
  {
    name: 'HTML type 6 (`<div>`) containing a `## ` line',
    md: doc(['<div>', '## v0.0.1 — inside a div', '</div>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Type 6 runs to a blank line, and everything inside it is raw HTML.',
  },
  {
    name: 'HTML type 6 whose body holds a line-start `<!--`',
    md: doc(['<div>', '<!-- a comment INSIDE the html block', '</div>']),
    commonmarkH2: ['Unreleased', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Inside a type-6 block the `<!--` is content, not an opener. The approximation read it as one and masked to EOF — the last fail-OPEN row.',
  },

  // ── The column-0 heading policy: the guard's ONE deliberate divergence ────
  // CommonMark allows an ATX opener up to 3 spaces of indent. The guard refuses
  // them, and these are the rows where that shows. It is fail-CLOSED and it is
  // load-bearing, not decorative — see `parseSections`. Nothing in the repo
  // enforces "CHANGELOG.md has no indented headings"; the count is zero today
  // because nobody has written one, which is exactly why the guard cannot
  // assume it.
  {
    name: 'POLICY: a 3-space `## ` is a real heading to CommonMark, and not to the guard',
    md: doc(['   ## v0.0.1 — indented by three spaces']),
    commonmarkH2: ['Unreleased', 'v0.0.1 — indented by three spaces', 'v9.9.9'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'Fail-CLOSED: honouring the tolerance lets an indented `## Unreleased` inside a released section un-release the whole rest of the file.',
  },
  {
    name: 'POLICY: an indented `## Unreleased` inside a list item does not open a section',
    md: [
      '## Unreleased',
      '',
      '- entry',
      '',
      '## v9.9.9',
      '',
      '- an entry that shows the staging header:',
      '',
      '   ## Unreleased',
      '',
      '- buried',
      '',
    ].join('\n'),
    commonmarkH2: ['Unreleased', 'v9.9.9', 'Unreleased'],
    guardH2: ['## Unreleased', '## v9.9.9'],
    why: 'The concrete fail-OPEN the policy prevents: honour the indent and everything from that line on stops being a released section.',
  },
  {
    name: 'POLICY: a SETEXT h2 is not a section either',
    md: ['## Unreleased', '', '- entry', '', 'v0.0.1 — setext', '---', '', '- buried', ''].join('\n'),
    commonmarkH2: ['Unreleased', 'v0.0.1 — setext'],
    guardH2: ['## Unreleased'],
    why: 'CommonMark renders a setext underline as `<h2>`; the guard requires a literal `## ` ATX opener, so it reports one section.',
  },
]
