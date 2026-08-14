#!/usr/bin/env node
/**
 * check-changelog-entry — a PR that ships user- or fleet-visible change must
 * stage a CHANGELOG entry under `## Unreleased`, in the same PR.
 *
 * Why this script exists
 * ----------------------
 * Cutting a release should be a trivial rename: `## Unreleased` →
 * `## vX.Y.Z — <summary>` (see skills/switchroom-release, Step 1). That only
 * works if `## Unreleased` is *continuously* populated — every merged PR drops
 * its note there as it lands. Left to prompt discipline that section rots: the
 * v0.20.12 release shipped with NO `## Unreleased` section at all, so the
 * author had to reconstruct the entire release note from `git log`. This guard
 * is the deterministic mechanism that keeps the staging area populated so the
 * release step stays a rename, not an archaeology dig.
 *
 * ── THE RULE (and why a docs/chore/test PR is never blocked) ─────────────
 *
 *   A PR that changes SHIPPABLE code MUST stage a changelog note in the same
 *   PR, satisfied by EITHER:
 *
 *     (a) adding a NEW fragment file under `changelog.d/` — the preferred
 *         path; see `isChangelogFragment` and changelog.d/README.md — or
 *     (b) growing the `## Unreleased` section of CHANGELOG.md, i.e. adding at
 *         least one entry line under that header that was not already there
 *         on the base branch (the legacy path, kept open so in-flight PRs and
 *         deliberate hand-edits keep working).
 *
 *   Fragments exist because a single shared `## Unreleased` section makes any
 *   two in-flight PRs conflict on CHANGELOG.md — three merge-queue ejections
 *   in one day (#4678→#4679, #4679→#4712, #4678→#4712) over entries that never
 *   actually disagreed. A per-PR file under `changelog.d/` cannot conflict
 *   with another PR's file, so the conflict class disappears. The fragment
 *   must be ADDED in the range (`git diff --diff-filter=A`), not merely
 *   modified: rewording someone else's fragment stages nothing for THIS PR.
 *   Fragments are assembled into the `## vX.Y.Z` section (and deleted) at
 *   release time by `scripts/cut-changelog-release.mjs`.
 *
 *   SHIPPABLE = the real source/runtime/supply-chain paths (see
 *   SHIPPABLE_ROOTS): src, the Telegram plugin, bin, docker, profiles, skills,
 *   the vendored hindsight tree, and the CI workflows. Test files, docs,
 *   markdown, and `reference/` are EXEMPT even inside those roots (see
 *   EXEMPT_RE) — a pure test/docs PR ships nothing a user would read a
 *   changelog for.
 *
 *   A PR that changes no shippable code is never inspected and can never fail.
 *
 * ── ESCAPE HATCH (for a legitimate chore that touches shippable paths) ────
 *
 * A CI-only tweak, a comment fix, a dependency shuffle — shippable by path but
 * not worth a changelog line. Two ways out, either one passes:
 *
 *   - add the `no-changelog` LABEL to the PR (surfaced to CI via
 *     $CHANGELOG_PR_LABELS), or
 *   - put a `[skip changelog]` token ON ITS OWN LINE in the PR body
 *     ($CHANGELOG_PR_BODY) or in ANY commit message on the branch.
 *
 * The token must be alone on a line — merely MENTIONING it in prose (e.g. a PR
 * that documents this very feature) must not switch the gate off. See
 * `hasSkipToken`. The commit-message token is the git-native path: it works in
 * a local `npm run lint` with no GitHub context, exactly like the sibling
 * attribution guard operates on commits.
 *
 * ── Robustness: never false-positive on the release PR ───────────────────
 *
 * The check only fires when Unreleased has genuinely NOT grown vs base. The
 * release PR (which RENAMES `## Unreleased` to `## vX.Y.Z`) touches CHANGELOG.md
 * only, so it changes no shippable code and passes on that basis alone — it
 * never needs Unreleased to grow. And a PR that merged main into itself does
 * not inherit a false "grew" from someone else's entry: growth is measured
 * against the PR's own merge-base (`base...HEAD`).
 *
 * ── RULE 2: PLACEMENT (the post-release silent-corruption guard) ─────────
 *
 *   No CHANGELOG line ADDED in this range may land under a RELEASED version
 *   heading (`## vX.Y.Z …`) — unless that heading was itself added in the same
 *   range (which is exactly what the release PR does when it renames
 *   `## Unreleased`).
 *
 * Why this exists, and why RULE 1 alone cannot catch it: a PR stages its entry
 * under `## Unreleased`. A release is cut before it merges, renaming that
 * header to `## vX.Y.Z`. The merge is then TEXTUALLY CLEAN — git has no idea
 * the section changed meaning — and the entry lands INSIDE the already-shipped
 * section. Exit 0, zero conflicts, release notes silently wrong, the entry
 * buried forever. Four PRs (#4679–#4682) hit this simultaneously behind the
 * v0.21.9 cut.
 *
 * Nothing caught it because the only moment the corruption exists is the
 * MERGED result, and nothing inspected that:
 *   - the `pull_request` run measures growth against the PR's OWN merge-base,
 *     which predates the release, so from the PR's point of view the entry IS
 *     under `## Unreleased` — green;
 *   - the merge queue used to SKIP this script outright, so the merged result
 *     was never re-validated.
 *
 * Hence PLACEMENT runs on `merge_group` too (see the merge_group note under
 * Skips). It needs no GitHub PR context — only the diff — which is precisely
 * what makes it safe to run on a queue ref where RULE 1's escape hatch is
 * invisible.
 *
 * Placement escape hatch: `[changelog placement ok]` alone on a line in the PR
 * body or ANY commit message on the branch, for the rare deliberate edit to an
 * already-released section (fixing a typo in an old entry, a retroactive
 * backport note). Deliberately NOT the same token as `[skip changelog]`: that
 * one asserts "this PR needs no entry", which says nothing about where an entry
 * that DOES exist landed. It is commit-message-reachable on purpose — labels
 * are invisible on a queue ref.
 *
 * ── Skips (a skip is a pass, never a silent gate) ────────────────────────
 *
 * - `merge_group` event: RULE 1 is skipped, because the queue ref carries no
 *   `pull_request` payload, so the `no-changelog` label / PR-body escape hatch
 *   cannot be read there and a legitimately-escaped PR would red the train.
 *   RULE 2 (placement) still RUNS — it reads only the diff. The base is
 *   `github.event.merge_group.base_sha`, surfaced by ci-lint.yml as
 *   $CHANGELOG_BASE; it is an ancestor of the queue ref, so the workflow's
 *   existing `fetch-depth: 0` checkout already has it.
 * - No base ref resolvable (shallow clone, detached checkout): SKIP rather than
 *   fail. CI checks out with fetch-depth: 0 for exactly this reason. This
 *   applies to the `pull_request` / local path ONLY. On `merge_group`,
 *   $CHANGELOG_BASE is AUTHORITATIVE — there is no fallback cascade, and both
 *   "unset" and "set but unresolvable" are a FAIL. The cascade must not rescue a
 *   queue ref: `origin/main` always resolves on a fetch-depth: 0 checkout, so a
 *   broken $CHANGELOG_BASE would quietly diff a range that is NOT the merged
 *   result while reporting OK — a workflow misconfiguration silently disarming
 *   the only check that inspects that result.
 * - No merge-base between base and HEAD (unrelated histories): SKIP.
 * - No CHANGELOG.md at HEAD: SKIP (nothing to enforce).
 *
 * ── Non-vacuity: the empty-range WARN ────────────────────────────────────
 *
 * `base...HEAD` being EMPTY means this run certified nothing. That is normal on
 * `push: main`, and it is also the local-review trap that cost real reviewer
 * time: with an UNCOMMITTED merge in the worktree, HEAD is still the base
 * commit, the range is empty, and `npm run lint` reports a cheerful OK while
 * the staged merge is corrupt. So an empty range now says so out loud, and
 * names the fix (commit the merge, then re-run) when the worktree is dirty.
 *
 * Run: `npm run lint:changelog-entry` (also part of `npm run lint`).
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The REFERENCE CommonMark implementation (spec 0.31.2), a devDependency.
//
// This script is node-run lint tooling: `scripts/` is not in package.json
// `files`, and nothing under `src/`, `bin/` or `telegram-plugin/` imports it,
// so the shipped bun binary carries none of this. CI already installs
// devDependencies (`bun install --frozen-lockfile`) before running lint.
//
// `commonmark`'s package exports resolve to an ESM entry with NAMED exports
// only — `import cm from 'commonmark'` throws at load. Import the names.
//
// LOADED DEFENSIVELY, and that is not paranoia about CI. A STATIC
// `import { Parser } from 'commonmark'` makes any invocation without
// devDependencies installed die with `ERR_MODULE_NOT_FOUND` before a single
// line of this script runs — no message this file chose, no exit code it chose,
// a raw node stack trace. That contradicts the script's whole error posture:
// every other environment gap here (no base ref, no merge-base, no
// CHANGELOG.md) SKIPs with a sentence saying why, because the design principle
// is "skip rather than fail" for things that are not the developer's mistake.
// A developer running `node scripts/check-changelog-entry.mjs` in a fresh
// checkout deserves the same treatment. Guarded import plus the SKIP at the top
// of `run()` restores it. Top-level `await` is legal in an ESM `.mjs` module
// and every consumer (`bun lint`, vitest, `changelog-mask-differential.mjs`)
// imports this file, so the await is resolved before any export is touched.
/** @type {typeof import('commonmark').Parser | null} */
let Parser = null
try {
  ;({ Parser } = await import('commonmark'))
} catch {
  // Left null on purpose. `run()` turns it into a SKIP; `analyze` throws a
  // named error rather than an "undefined is not a constructor" TypeError.
}

/**
 * Repo-relative path prefixes whose contents ship to users or the fleet. A
 * change under any of these requires a staged changelog entry — unless the
 * path is also matched by EXEMPT_RE below, which always wins.
 *
 * Deliberately NOT here: `scripts/**` (dev/lint tooling), `tests/**`,
 * `reference/**`, `docs/**`, top-level config. Those either ship nothing or
 * are covered by EXEMPT_RE.
 *
 * Scoping honesty: this guard only executes when `ci-lint`'s path filter fires
 * (`.github/path-filters.yml` key `lint`), because it runs inside `bun lint`.
 * Every root here except the vendored hindsight tree is covered by that filter
 * (via the TypeScript glob or the ws9f1-security anchor), so a shippable PR
 * reliably trips the guard. A pure NON-TypeScript change under the hindsight tree
 * can skip ci-lint entirely and thus skip this guard — that is UNDER-
 * enforcement (a missed reminder), never a false block, and it matches the
 * lint job's own gating. Erring toward under-enforcement is deliberate: the
 * cost of a false FAIL (a blocked legit PR) is far higher than a missed nudge.
 */
export const SHIPPABLE_ROOTS = [
  'src/',
  'telegram-plugin/',
  'bin/',
  'docker/',
  'profiles/',
  'skills/',
  'vendor/hindsight-memory/',
  '.github/workflows/',
]

/**
 * Paths that never require a changelog entry, even inside a shippable root.
 * Tests, docs, and markdown are the big exemptions: a test-only or docs-only
 * PR ships no behaviour a changelog would describe.
 */
export const EXEMPT_RE = [
  /(^|\/)tests?\//, // any tests/ or test/ directory
  /(^|\/)__tests__\//,
  /(^|\/)uat\//,
  /\.test\.[cm]?tsx?$/,
  /\.spec\.[cm]?tsx?$/,
  /\.md$/,
  /^docs\//,
  /^reference\//,
]

/**
 * Is a changed path shippable (i.e. does it demand a changelog entry)?
 * @param {string} p repo-relative path
 * @returns {boolean}
 */
export function isShippable(p) {
  const path = String(p).trim()
  if (!path) return false
  if (EXEMPT_RE.some((re) => re.test(path))) return false
  return SHIPPABLE_ROOTS.some((root) => path.startsWith(root))
}

/** The per-PR changelog fragment directory. Trailing slash on purpose. */
export const FRAGMENT_DIR = 'changelog.d/'

/**
 * Is a path a changelog FRAGMENT — a file whose ADDITION satisfies the staged-
 * entry requirement?
 *
 * Deliberately narrow, and every exclusion fails CLOSED (a non-fragment path
 * simply does not count; the PR then needs a real fragment or an Unreleased
 * entry — never the reverse):
 *   - flat files only: `changelog.d/<name>.md`, no subdirectories, so the
 *     release-cut assembler's flat readdir and this guard agree on the same
 *     file set;
 *   - `.md` only: the fragment body is pasted into CHANGELOG.md verbatim;
 *   - `README.md` (any case) is the convention doc, never an entry.
 *
 * @param {string} p repo-relative path
 * @returns {boolean}
 */
export function isChangelogFragment(p) {
  const path = String(p).trim()
  if (!path.startsWith(FRAGMENT_DIR)) return false
  const name = path.slice(FRAGMENT_DIR.length)
  if (!name || name.includes('/')) return false
  if (/^readme\.md$/i.test(name)) return false
  return /\.md$/i.test(name)
}

/**
 * Parse a changelog with the REFERENCE CommonMark implementation and return
 * the two facts every rule below needs: which lines are prose, and where the
 * level-2 headings are.
 *
 * WHY A REAL PARSER
 * -----------------
 * This used to be `maskNonProseWithState`, a ~200-line hand-written partial
 * CommonMark implementation that modelled fenced code blocks and HTML block
 * type 2 and approximated container scoping with a dedent/resync latch. Seven
 * review rounds found seven defects of the same class, the last of them a
 * silent fail-OPEN on the repo's own CHANGELOG.md: when PROSE caused the
 * dedent out of a list item the latch carried no pending closer, the next bare
 * delimiter was read as a fresh OPENER, fence parity inverted, and the masker
 * blanked every heading through to EOF — 429 real `<h2>`s seen as 179, with
 * both unclosed-* WARNs null. Approximating block structure with line-anchored
 * regexes is the defect class; the fix is to stop approximating.
 *
 * WHAT COUNTS AS NON-PROSE
 * ------------------------
 * FENCED code blocks and HTML blocks only — deliberately NOT indented (4-space)
 * code blocks. A 4-space-indented literal block under `## Unreleased` is a
 * legitimate entry body and must still count as growth (pinned by
 * `tests/changelog-entry-check.test.ts`). That is exactly the scope the old
 * masker had, so this is not a behaviour change.
 *
 * Inline (mid-line) comments are NOT masked. A comment on its own line is an
 * HTML block and is masked as one; a mid-line `<!-- … -->` leaves a prose line
 * prose, and base and head are compared the same way, so nothing depends on it.
 *
 * HEADINGS: COLUMN 0 ONLY — see `parseSections` for why.
 *
 * Cached on the exact input string (one entry): CHANGELOG.md is >1.3 MiB here
 * and a single run parses it several times.
 *
 * INDENTED HEADINGS are not silently dropped — see `indented` below and
 * `findIndentedHeadings`.
 *
 * @param {string} changelog
 * @returns {{lines: string[], prose: boolean[], headings: {line: number, text: string}[], indented: {line: number, text: string}[]}}
 *   `prose[i]` is for 1-based line `i + 1`.
 */
let analyzeCacheKey = /** @type {string | null} */ (null)
let analyzeCacheValue = /** @type {any} */ (null)
export function analyze(changelog) {
  if (!Parser) {
    throw new Error(
      'check-changelog-entry: the `commonmark` devDependency is not installed. ' +
        'Run `bun install` (CI does this before lint).',
    )
  }
  const md = String(changelog).replace(/\r\n/g, '\n')
  if (analyzeCacheKey === md) return analyzeCacheValue

  const lines = md.split('\n')
  const prose = new Array(lines.length).fill(true)
  /** @type {{line: number, text: string}[]} */
  const headings = []
  /** @type {{line: number, text: string}[]} */
  const indented = []

  const walker = new Parser().parse(md).walker()
  let ev
  while ((ev = walker.next())) {
    if (!ev.entering) continue
    const node = ev.node
    const pos = node.sourcepos
    if (!pos) continue
    // FENCED vs INDENTED code: `node.info` is the public discriminator, and it
    // is the only one. commonmark 0.31.2 has no `isFenced` accessor on Node —
    // the flag exists solely as the private `_isFenced` (`lib/node.js:84`,
    // absent from the `defineProperty(proto, …)` list) and reading `.isFenced`
    // silently yields `undefined`, i.e. "never mask a fence". `info` is a real
    // accessor (`lib/node.js:170`) and is `null` for an indented block and a
    // string (`""` when there is no info string) for a fenced one.
    const fenced = node.type === 'code_block' && typeof node.info === 'string'
    if (fenced || node.type === 'html_block') {
      for (let n = pos[0][0]; n <= pos[1][0]; n++) {
        if (n >= 1 && n <= lines.length) prose[n - 1] = false
      }
      continue
    }
    if (node.type !== 'heading' || node.level !== 2) continue
    const line = pos[0][0]
    const raw = lines[line - 1] ?? ''
    // Column 0 only, and `^##\s` besides — which also excludes a SETEXT h2,
    // whose sourcepos points at its text line, not at the `---` underline.
    if (pos[0][1] !== 1 || !/^##\s/.test(raw)) {
      // An INDENTED ATX h2 (1–3 spaces) is a heading to CommonMark and to
      // GitHub, and invisible to every rule below. Record it so the guard can
      // FAIL on it instead of quietly losing the section. See
      // `findIndentedHeadings` for why silence here is a fail-OPEN.
      if (/^ {1,3}#{1,6}\s/.test(raw)) indented.push({ line, text: raw.trim() })
      continue
    }
    headings.push({ line, text: raw.trim() })
  }

  const value = { lines, prose, headings, indented }
  analyzeCacheKey = md
  analyzeCacheValue = value
  return value
}

/**
 * Extract the trimmed, meaningful entry lines under the `## Unreleased`
 * header — every non-blank line up to the next `## ` heading, with HTML
 * comments removed first.
 *
 * A missing Unreleased section yields `[]` (not an error): the guard treats
 * "no section" and "empty section" identically — either way it has not grown.
 *
 * Heading recognition is COLUMN-0 anchored, deliberately, and identically to
 * `parseSections` (see the indent note there). This used to `.trim()` the line,
 * which accepted an `## Unreleased` at ANY indent — including the 4+ spaces
 * CommonMark reads as an indented CODE block. That was both fail-OPEN and
 * inconsistent: RULE 1 credited growth under a "header" that neither CommonMark
 * nor `parseSections` considers a heading, while RULE 2, looking at the same
 * file, reported it as having no staging section at all.
 *
 * @param {string} changelog full CHANGELOG.md text
 * @returns {string[]}
 */
export function extractUnreleasedEntries(changelog) {
  const { lines, prose, headings } = analyze(changelog)
  const at = headings.findIndex((h) => /^##\s+unreleased\b/i.test(h.text))
  if (at === -1) return []
  const from = headings[at].line + 1
  const to = at + 1 < headings.length ? headings[at + 1].line - 1 : lines.length
  /** @type {string[]} */
  const entries = []
  for (let n = from; n <= to; n++) {
    // Fenced code and HTML blocks are not entries: a `## ` line that is merely
    // PASTED OUTPUT inside a fence must not be credited as staged prose.
    if (!prose[n - 1]) continue
    const trimmed = (lines[n - 1] ?? '').trim()
    if (trimmed.length > 0) entries.push(trimmed)
  }
  return entries
}

/**
 * Did `## Unreleased` genuinely grow between base and head? True iff head has
 * at least one entry line the base section did not.
 * @param {string} baseChangelog
 * @param {string} headChangelog
 * @returns {boolean}
 */
export function unreleasedGrew(baseChangelog, headChangelog) {
  const base = new Set(extractUnreleasedEntries(baseChangelog))
  const head = extractUnreleasedEntries(headChangelog)
  return head.some((line) => !base.has(line))
}

/**
 * Split a changelog into its `## ` sections with 1-based line numbers.
 *
 * INDENT: a heading is recognised at COLUMN 0 only, even though CommonMark
 * allows up to 3 spaces of indent. That is deliberate and it is the direction
 * that fails CLOSED. Honouring the ≤3-space tolerance here would be fail-OPEN:
 * a prose or list line reading `   ## Unreleased` *inside* an already-released
 * section would open a new, NON-released section, and every entry added below
 * it — the whole rest of the file — would silently stop being checked for
 * placement. `extractUnreleasedEntries` anchors at column 0 for the same reason,
 * so the two agree on what a heading is. It is also not hypothetical:
 * `tests/changelog-entry-check.test.ts` pins a case
 * where `   ## Unreleased` sits inside a list item in an already-released
 * section. CommonMark renders that as a genuine `<h2>`; honouring the tolerance
 * would un-release the entire rest of the file and turn a real FAIL into a pass.
 *
 * THE MIRROR DIRECTION IS NOT "MERELY NOISY" — this comment used to claim it
 * was, and the claim was WRONG. It holds only when the indented heading is
 * `## Unreleased` itself: the guard then reports "no staging section" and reds
 * the PR. When the indented heading is a RELEASED one the section VANISHES —
 * its body is absorbed into whatever section precedes it. A file whose
 * ` ## v0.21.9` is indented by one space has ONE section as far as this guard
 * is concerned (`## Unreleased`), so `findMisplacedEntries` finds no released
 * section to check and an entry that GitHub renders under `## v0.21.9` is
 * reported OK at exit 0 — the exact corruption RULE 2 exists to catch — while
 * `extractUnreleasedEntries` simultaneously credits the whole shipped section
 * as staged content. That is a fail-OPEN, in the direction that matters.
 *
 * So the anchor is kept and the zero it depends on is ENFORCED rather than
 * assumed: `analyze` records every level-2 heading node this filter rejects for
 * being indented, and `evaluate` FAILs on it. See `findIndentedHeadings`.
 *
 * Now that the block structure comes from the reference implementation, this is
 * the ONLY place the guard deliberately diverges from CommonMark, and it is one
 * filter rather than an approximation: keep the parser's heading nodes whose
 * start column is 1 and whose source line is a literal `## ` ATX opener.
 *
 * @param {string} changelog
 * @returns {{heading: string, headingLine: number, start: number, end: number, released: boolean}[]}
 *   `start`/`end` bound the section BODY (inclusive); `released` is true for any
 *   `## ` heading that is not `## Unreleased`.
 */
export function parseSections(changelog) {
  const { lines, headings } = analyze(changelog)
  /** @type {{heading: string, headingLine: number, start: number, end: number, released: boolean}[]} */
  const sections = []
  for (const h of headings) {
    if (sections.length > 0) sections[sections.length - 1].end = h.line - 1
    sections.push({
      heading: h.text,
      headingLine: h.line,
      start: h.line + 1,
      end: lines.length,
      released: !/^##\s+unreleased\b/i.test(h.text),
    })
  }
  return sections
}

/**
 * Every level-2 heading CommonMark renders that `parseSections`' column-0
 * anchor drops for being indented 1–3 spaces.
 *
 * WHY THIS IS A FAIL, not a warning and not a silent drop
 * ------------------------------------------------------
 * The column-0 anchor (see `parseSections`) is deliberate and it closes a real
 * fail-open. What it does NOT do is make an indented heading harmless. Take:
 *
 *     ## Unreleased
 *
 *      ## v0.21.9 — a released section          <- ONE leading space
 *
 *     - **My entry:** oops.
 *
 * CommonMark renders two `<h2>`s and GitHub shows the entry under v0.21.9.
 * `parseSections` sees ONE section, `## Unreleased`, running to EOF. RULE 2
 * finds no released section, so nothing is misplaced; RULE 1 counts the
 * released heading and its body as Unreleased content. Exit 0, silently, over
 * precisely the buried-entry corruption this guard was written for.
 *
 * The old comment argued the policy was safe because the mirror mistake is
 * "merely noisy". That is true for an indented `## Unreleased` and false for an
 * indented RELEASED heading, and it was the only thing standing in for
 * enforcement — the file's `grep -c '^ \{1,3\}#\{1,6\} '` → 0 was asserted in
 * prose and checked by nothing. This makes it a check.
 *
 * SCOPE: level-2 headings only, because sections are what the guard reasons
 * about; an indented `### ` opens no section and hides nothing. The FIX offered
 * to the author is exact and always available — unindent it (a real heading),
 * indent it to 4+ spaces, or fence it (an example, which CommonMark then renders
 * as code and this guard already ignores).
 *
 * @param {string} changelog
 * @returns {{line: number, text: string}[]}
 */
export function findIndentedHeadings(changelog) {
  return analyze(changelog).indented
}

/**
 * Parse the 1-based NEW-file line numbers of every added line out of a
 * `git diff -U0` unified diff.
 *
 * Line numbers rather than line TEXT on purpose: matching added lines by text
 * would confuse an added line with an identical line that merely appears
 * elsewhere as context (changelog entries repeat phrasing constantly), which
 * could both miss a real hit and invent a false one.
 *
 * @param {string} diffText
 * @returns {Set<number>}
 */
export function parseAddedLineNumbers(diffText) {
  /** @type {Set<number>} */
  const added = new Set()
  let next = 0
  for (const line of String(diffText).replace(/\r\n/g, '\n').split('\n')) {
    // A new file's header block resets the cursor, so the `+++ b/<path>` /
    // `--- a/<path>` header lines below are only ever seen with `next === 0`.
    if (line.startsWith('diff --git ')) {
      next = 0
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      next = Number(hunk[1])
      continue
    }
    // Everything before the first hunk of a file — including the `+++`/`---`
    // file headers — is skipped here. Testing for `+++` INSIDE a hunk body was
    // a desync bug: `+++foo` there is an added line whose text begins with `+`,
    // and skipping it without advancing `next` mis-attributed every later added
    // line in the hunk one line too low — dropping a real entry out of the
    // placement check, or landing a line number on a heading and exempting the
    // whole section.
    if (next === 0) continue
    if (line.startsWith('+')) {
      added.add(next)
      next++
    }
    // `-` lines and the `\ No newline` marker do not advance the new-file
    // cursor; with -U0 there are no context lines to account for.
  }
  return added
}

/**
 * The identity of a section, for "is this the SAME section as before?": the
 * version token, not the whole heading. `## v0.21.0 — a summary` → `v0.21.0`,
 * so a heading whose ` — summary` tail was edited still resolves to the same
 * section.
 * @param {string} heading
 * @returns {string}
 */
function sectionKey(heading) {
  const m = /^#{1,6}\s+(\S+)/.exec(String(heading).trim())
  return (m ? m[1] : String(heading).trim()).toLowerCase()
}

/**
 * The version tokens of every `## ` heading REMOVED in a `git diff -U0` range.
 *
 * Used to tell a heading that was RENAMED (`## Unreleased` → `## v0.21.0`: the
 * release PR, and a legitimately new section) from one that was merely EDITED
 * (`## v1.0.0 — teh cut` → `## v1.0.0 — the cut`: a typo fix on a section that
 * already shipped). Both show the heading line as "added"; only the second one
 * removes a heading carrying the SAME version token.
 *
 * @param {string} diffText
 * @returns {Set<string>}
 */
export function parseRemovedSectionKeys(diffText) {
  /** @type {Set<string>} */
  const keys = new Set()
  let inHunk = false
  for (const line of String(diffText).replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false
      continue
    }
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      inHunk = true
      continue
    }
    if (!inHunk) continue // skips the `--- a/<path>` file header
    if (!line.startsWith('-')) continue
    const body = line.slice(1)
    if (/^##\s/.test(body)) keys.add(sectionKey(body))
  }
  return keys
}

/**
 * Find entries added in this range that landed under an ALREADY-RELEASED
 * heading — the post-release silent-corruption signature.
 *
 * A section that is NEW in this range is exempt: that is the release PR
 * renaming `## Unreleased` to `## vX.Y.Z`, where every line beneath it is
 * legitimately "new" to the diff.
 *
 * "New" keys on the SECTION, not on the heading LINE. Keying it on the line —
 * "the heading changed, so exempt everything under it" — meant a one-character
 * typo fix on an old heading blanket-exempted that entire released section, so
 * a genuinely buried entry in the same change went unreported. A section is new
 * iff its heading line was added AND the range did not remove a heading with
 * the same version token (the rename removes `## Unreleased`; the typo fix
 * removes `## v1.0.0 — teh cut`).
 *
 * KNOWN GAP, deliberately left open: because newness keys on the version TOKEN,
 * an edit that changes the token ITSELF (`## v1.0.0-rc — x` → `## v1.0.0 — x`)
 * still reads as a brand-new section and blanket-exempts everything under it, so
 * an entry buried in that same section in that same range goes unreported. This
 * is inherent to the heuristic, not a bug to patch: a released heading whose
 * version token was rewritten is textually INDISTINGUISHABLE from a legitimately
 * new section (which is exactly what the release PR's `## Unreleased` → `## vX.Y.Z`
 * rename is), so closing it would trade a rare miss for a false FAIL on every
 * release cut. The token rule is strictly better than the heading-line rule it
 * replaced — it closes the common case (a typo fix in the heading's summary tail)
 * — but it does not make the section-newness exemption airtight.
 *
 * @param {string} headChangelog CHANGELOG.md text at HEAD
 * @param {Set<number>} addedLineNumbers 1-based new-file line numbers
 * @param {Set<string>} removedSectionKeys from `parseRemovedSectionKeys`
 * @returns {{section: string, line: number, text: string}[]}
 */
export function findMisplacedEntries(
  headChangelog,
  addedLineNumbers,
  removedSectionKeys = new Set(),
) {
  const { lines: rawLines, prose } = analyze(headChangelog)
  const sections = parseSections(headChangelog)
  /** @type {{section: string, line: number, text: string}[]} */
  const hits = []
  for (const s of sections) {
    if (!s.released) continue
    const isNewSection =
      addedLineNumbers.has(s.headingLine) && !removedSectionKeys.has(sectionKey(s.heading))
    if (isNewSection) continue // release PR: `## Unreleased` renamed to `## vX.Y.Z`
    for (let n = s.start; n <= s.end; n++) {
      if (!addedLineNumbers.has(n)) continue
      if (!prose[n - 1]) continue // fenced code or an HTML block, not an entry
      const text = (rawLines[n - 1] ?? '').trim()
      if (!text) continue // blank
      if (/^#{1,6}\s/.test(text)) continue // a sub-heading is structure, not an entry
      hits.push({ section: s.heading, line: n, text: (rawLines[n - 1] ?? '').trim() })
    }
  }
  return hits
}

/**
 * Does any text carry the `[skip changelog]` escape token?
 *
 * The token must sit ALONE on its own line (`^\s*[skip changelog]\s*$`,
 * multiline). This is deliberate: a substring match anywhere would let the
 * gate be disabled by prose that merely *mentions* the token — e.g. a PR body
 * or commit message that documents the escape hatch ("we support a
 * `[skip changelog]` token") would silently switch enforcement off. Requiring
 * the token on its own line keeps "I used the escape hatch" (a deliberate line)
 * distinct from "I talked about the escape hatch" (inline prose). Case-
 * insensitive, and tolerant of `_`/`-`/space between `skip` and `changelog`.
 * @param {string} text
 * @returns {boolean}
 */
export function hasSkipToken(text) {
  return /^[ \t]*\[[ \t]*skip[ \t_-]*changelog[ \t]*\][ \t]*$/im.test(String(text))
}

/**
 * Does any text carry the `[changelog placement ok]` escape token?
 *
 * Same own-line discipline (and the same reason) as `hasSkipToken`. Kept
 * SEPARATE from `[skip changelog]`: "this PR needs no entry" and "this PR
 * deliberately edits an already-released section" are different assertions, and
 * conflating them would let every escape-hatched PR silently corrupt a released
 * section too.
 * @param {string} text
 * @returns {boolean}
 */
export function hasPlacementToken(text) {
  return /^[ \t]*\[[ \t]*changelog[ \t_-]*placement[ \t_-]*ok[ \t]*\][ \t]*$/im.test(String(text))
}

/**
 * Does a label list carry the `no-changelog` escape label? Labels arrive as a
 * space/comma-separated string (CI joins `pull_request.labels[].name`).
 * @param {string} labels
 * @returns {boolean}
 */
export function hasSkipLabel(labels) {
  return String(labels)
    .split(/[\s,]+/)
    .map((l) => l.trim().toLowerCase())
    .includes('no-changelog')
}

/**
 * The pure verdict. Shared by the CLI and the tests.
 *
 * @param {{
 *   changedFiles: string[],
 *   baseChangelog: string,
 *   headChangelog: string,
 *   commitMessages?: string[],
 *   prBody?: string,
 *   prLabels?: string,
 *   addedChangelogLines?: Set<number>,
 *   removedChangelogSections?: Set<string>,
 *   placementOnly?: boolean,
 * }} input
 * @returns {{status: 'pass'|'fail', reason: string, shippable?: string[], misplaced?: {section: string, line: number, text: string}[], indentedHeadings?: {line: number, text: string}[]}}
 */
export function evaluate({
  changedFiles,
  baseChangelog,
  headChangelog,
  commitMessages = [],
  prBody = '',
  prLabels = '',
  addedFiles = [],
  addedChangelogLines = new Set(),
  removedChangelogSections = new Set(),
  placementOnly = false,
}) {
  // RULE 0: an indented `## ` heading makes every rule below read a DIFFERENT
  // document from the one GitHub renders, so it is checked first and it is not
  // escapable — `[changelog placement ok]` says "I meant to edit a released
  // section", which is not an assertion about the file's block structure.
  // Unconditional on the range too: the heading that hides a section may have
  // been there before this PR, and RULE 2 is just as blind to it either way.
  const indentedHeadings = findIndentedHeadings(headChangelog)

  // RULE 2: a misplaced entry is a corruption of already-shipped release notes,
  // and it outranks "did Unreleased grow" — which, in exactly this situation,
  // reports the misleading symptom (`no new entry`) instead of the cause
  // (`your entry is under ## v0.21.8`). Reported BEFORE the indent FAIL when
  // both fire: a named buried entry is the more actionable of the two, and the
  // indent block is appended to the same report rather than replacing it.
  const placementEscaped =
    hasPlacementToken(prBody) || (commitMessages || []).some((m) => hasPlacementToken(m))
  if (!placementEscaped && addedChangelogLines.size > 0) {
    const misplaced = findMisplacedEntries(
      headChangelog,
      addedChangelogLines,
      removedChangelogSections,
    )
    if (misplaced.length > 0) {
      return {
        status: 'fail',
        reason: 'entry added under a released section',
        misplaced,
        indentedHeadings,
      }
    }
  }
  if (indentedHeadings.length > 0) {
    return { status: 'fail', reason: 'an indented `## ` heading hides a section', indentedHeadings }
  }
  if (placementOnly) {
    return { status: 'pass', reason: 'no entry added under a released section' }
  }

  const shippable = (changedFiles || []).filter(isShippable)
  if (shippable.length === 0) {
    return { status: 'pass', reason: 'no shippable code changed' }
  }
  const escaped =
    hasSkipLabel(prLabels) ||
    hasSkipToken(prBody) ||
    commitMessages.some((m) => hasSkipToken(m))
  if (escaped) {
    return { status: 'pass', reason: 'escape hatch (no-changelog label / [skip changelog] token)' }
  }
  // The preferred path: a NEW fragment file under changelog.d/. Checked after
  // RULE 2 on purpose — a fragment satisfies the staged-entry requirement, it
  // never buys immunity for corrupting an already-released section.
  const fragments = (addedFiles || []).filter(isChangelogFragment)
  if (fragments.length > 0) {
    return { status: 'pass', reason: `changelog fragment staged (${fragments.join(', ')})` }
  }
  if (unreleasedGrew(baseChangelog, headChangelog)) {
    return { status: 'pass', reason: '## Unreleased grew' }
  }
  return { status: 'fail', reason: 'shippable change with no staged changelog note', shippable }
}

// ── git plumbing ───────────────────────────────────────────────────────────

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // CHANGELOG.md is well over execFileSync's 1 MiB default maxBuffer (it is
    // >1.3 MiB and only grows), and so is the concatenated commit-message
    // stream on a long branch. Without this, `git show <ref>:CHANGELOG.md`
    // throws ENOBUFS, gitSoft() swallows it to '', both changelog snapshots
    // read as empty, `unreleasedGrew` is falsely false, and the guard reds
    // every shippable PR. 64 MiB is comfortably clear of the real ceiling.
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** @param {string[]} args @param {string} cwd → '' on any failure (missing ref/path). */
function gitSoft(args, cwd) {
  try {
    return git(args, cwd)
  } catch {
    return ''
  }
}

/**
 * Does `<tree-ish>:<path>` exist? `git cat-file -e` exits 0 if the object is
 * present, non-zero otherwise — the clean existence probe (gitSoft can't tell
 * "present but empty output" from "absent").
 * @param {string} treeishPath e.g. `HEAD:CHANGELOG.md`
 * @param {string} cwd
 * @returns {boolean}
 */
function gitPathExists(treeishPath, cwd) {
  try {
    git(['cat-file', '-e', treeishPath], cwd)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the base ref to diff against. Mirrors the candidate cascade in
 * check-agent-attribution-trailers.mjs.
 *
 * `authoritativeBase` disables the cascade: `$CHANGELOG_BASE` is the ONLY
 * candidate, and its absence is as fatal as its being unresolvable. That is the
 * queue-ref mode. The cascade cannot be allowed to rescue a merge_group run:
 * on a `fetch-depth: 0` checkout `origin/main` ALWAYS resolves, so a broken
 * `$CHANGELOG_BASE` would silently fall through to a range that is NOT the
 * merged result, and the only check that ever inspects that result would report
 * a cheerful OK. Distinguishing the two failures matters — deleting the env
 * line from the workflow leaves the variable UNSET, which a "set but bad" test
 * would never catch.
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {{authoritativeBase?: boolean}} [opts]
 * @returns {{base: string, head: string} | {error: 'missing-base'|'unresolvable-base'|'no-base'}}
 */
export function resolveRange(cwd, env = process.env, opts = {}) {
  const head = env.CHANGELOG_HEAD || 'HEAD'
  if (opts.authoritativeBase) {
    const base = env.CHANGELOG_BASE
    if (!base) return { error: 'missing-base' }
    try {
      git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd)
      git(['merge-base', base, head], cwd)
      return { base, head }
    } catch {
      return { error: 'unresolvable-base' }
    }
  }
  const candidates = [
    env.CHANGELOG_BASE,
    env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : undefined,
    'origin/main',
    'main',
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${c}^{commit}`], cwd)
      git(['merge-base', c, head], cwd)
      return { base: c, head }
    } catch {
      /* try next candidate */
    }
  }
  return { error: 'no-base' }
}

const RECORD = '\x1e'

/**
 * @param {string} cwd
 * @returns {{status: 'pass'|'fail'|'skip', lines: string[]}}
 */
export function run(cwd = resolveRepoRoot(process.cwd()), env = process.env) {
  // No parser, no verdict. SKIP rather than the raw ERR_MODULE_NOT_FOUND stack
  // a static import would throw — see the guarded import at the top of the file.
  if (!Parser) {
    return {
      status: 'skip',
      lines: [
        'check-changelog-entry: SKIP — the `commonmark` devDependency is not installed.',
        '  This guard parses CHANGELOG.md with the reference CommonMark implementation.',
        '  Run `bun install` and re-run; CI installs devDependencies before lint.',
      ],
    }
  }

  // On a queue ref only RULE 2 (placement) runs — RULE 1's escape hatch lives
  // in the `pull_request` payload, which does not exist here. See the header.
  const placementOnly = env.GITHUB_EVENT_NAME === 'merge_group'

  // On a queue ref $CHANGELOG_BASE is the ONLY acceptable base — no cascade.
  const range = resolveRange(cwd, env, { authoritativeBase: placementOnly })
  if ('error' in range) {
    // A broken merge_group run is a broken workflow, not a shallow clone — and
    // silently skipping it re-opens the exact hole this check exists to close.
    // Fail loudly, and name which of the two failures it was.
    if (range.error === 'missing-base') {
      return {
        status: 'fail',
        lines: [
          'check-changelog-entry: FAIL — merge_group ran with no base ref.',
          '',
          '  $CHANGELOG_BASE is not set. On a queue ref it must carry',
          '  github.event.merge_group.base_sha — see the `CHANGELOG_BASE:` line in',
          '  .github/workflows/ci-lint.yml. Falling back to origin/main here would',
          '  diff the WRONG range (and always succeed on a fetch-depth: 0 checkout),',
          '  so the placement check would certify nothing while reporting OK.',
        ],
      }
    }
    if (range.error === 'unresolvable-base') {
      return {
        status: 'fail',
        lines: [
          'check-changelog-entry: FAIL — merge_group base ref is unresolvable.',
          '',
          `  $CHANGELOG_BASE=${env.CHANGELOG_BASE} does not resolve in this checkout.`,
          '  On a queue ref this must be github.event.merge_group.base_sha, and the',
          '  checkout must use fetch-depth: 0 so that commit is present. Without it',
          '  the placement check certifies nothing — see .github/workflows/ci-lint.yml.',
        ],
      }
    }
    return {
      status: 'skip',
      lines: [
        'check-changelog-entry: SKIP — no base ref to diff against.',
        '  Tried $CHANGELOG_BASE, origin/$GITHUB_BASE_REF, origin/main, main.',
        '  A shallow clone has no base; CI checks out with fetch-depth: 0.',
      ],
    }
  }

  // SINGLE SOURCE OF TRUTH for "base": the merge-base of the base ref and HEAD,
  // resolved ONCE and used for the file diff, both CHANGELOG snapshots, and the
  // commit-message range. Reading `${range.base}:CHANGELOG.md` (the TIP of
  // origin/main) while diffing files three-dot (merge-base-relative) let the
  // two halves disagree: right after a release renames `## Unreleased`, an
  // un-rebased branch still carries the old Unreleased lines, and comparing
  // them against origin/main's now-empty Unreleased made `unreleasedGrew`
  // falsely true — a forgotten-entry PR sailed through exactly in the
  // post-release window. Anchoring everything on the merge-base fixes that:
  // "grew" is measured against the branch's own fork point, not whatever main
  // has done since.
  const mergeBase = gitSoft(['merge-base', range.base, range.head], cwd).trim()
  if (!mergeBase) {
    return {
      status: 'skip',
      lines: [
        'check-changelog-entry: SKIP — could not resolve a merge-base.',
        `  git merge-base ${range.base} ${range.head} produced nothing (unrelated histories?).`,
      ],
    }
  }

  // No CHANGELOG.md in the repo → nothing to enforce. `git cat-file -e` exits
  // 0 when the path exists at that tree, non-zero when absent.
  if (!gitPathExists(`${range.head}:CHANGELOG.md`, cwd)) {
    return {
      status: 'skip',
      lines: [
        'check-changelog-entry: SKIP — no CHANGELOG.md at HEAD.',
        '  A repo (or a checkout) with no changelog has nothing to stage entries in.',
      ],
    }
  }

  // Non-vacuity: an empty range certifies nothing. Say so rather than printing
  // a cheerful OK. Normal on `push: main`; the local-review trap is the dirty-
  // worktree case, which gets the actionable line.
  const headSha = gitSoft(['rev-parse', `${range.head}^{commit}`], cwd).trim()
  /** @type {string[]} */
  const warnings = []
  if (headSha && headSha === mergeBase) {
    const dirty = gitSoft(['status', '--porcelain'], cwd).trim().length > 0
    warnings.push(
      `check-changelog-entry: WARN — ${range.base}...${range.head} is an EMPTY range; this run checked nothing.`,
    )
    warnings.push(
      dirty
        ? '  Your worktree has UNCOMMITTED changes. If you are testing a merge, COMMIT it first —'
        : '  Normal on a push to main (HEAD is the base). Nothing was validated.',
    )
    if (dirty) {
      warnings.push(
        '  the guard diffs commits, so an uncommitted merge is invisible to it and passes vacuously.',
      )
    }
  }

  const changedFiles = gitSoft(['diff', '--name-only', `${mergeBase}..${range.head}`], cwd)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // Files ADDED in the range, for the changelog.d/ fragment rule. `--no-renames`
  // keeps this deterministic against `diff.renames` config: a rename must show
  // as delete+add, so a moved-in fragment still counts and a config difference
  // between CI and a laptop cannot flip the verdict.
  const addedFiles = gitSoft(
    ['diff', '--name-only', '--no-renames', '--diff-filter=A', `${mergeBase}..${range.head}`],
    cwd,
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const changelogDiff = gitSoft(
    ['diff', '-U0', '--no-color', `${mergeBase}..${range.head}`, '--', 'CHANGELOG.md'],
    cwd,
  )
  const addedChangelogLines = parseAddedLineNumbers(changelogDiff)
  const removedChangelogSections = parseRemovedSectionKeys(changelogDiff)

  const baseChangelog = gitSoft(['show', `${mergeBase}:CHANGELOG.md`], cwd)
  const headChangelog = gitSoft(['show', `${range.head}:CHANGELOG.md`], cwd)

  // NOTE: the unclosed-fence / unclosed-comment WARNs that used to live here
  // were a backstop for the hand-written masker's own guesswork — "I may have
  // masked to EOF, so I might be blind below this line". With the reference
  // implementation doing the block parse there is nothing to warn ABOUT: an
  // unclosed fence really does run to end-of-document, the parser says so
  // exactly, and the guard's view of what is a heading is now the same view
  // GitHub renders. A WARN with no referent is noise.

  const commitMessages = gitSoft(['log', `--format=%B${RECORD}`, `${mergeBase}..${range.head}`], cwd)
    .split(RECORD)
    .map((m) => m.trim())
    .filter(Boolean)

  const verdict = evaluate({
    changedFiles,
    baseChangelog,
    headChangelog,
    commitMessages,
    prBody: env.CHANGELOG_PR_BODY || '',
    prLabels: env.CHANGELOG_PR_LABELS || '',
    addedFiles,
    addedChangelogLines,
    removedChangelogSections,
    placementOnly,
  })

  if (verdict.status === 'pass') {
    return {
      status: 'pass',
      lines: [
        ...warnings,
        `check-changelog-entry: OK — ${verdict.reason} (${range.base}...${range.head}).`,
      ],
    }
  }

  // The indent report. Appended to the misplaced-entry FAIL when both fire (the
  // named buried entry is the more actionable half) and stands alone otherwise.
  const indentReport =
    verdict.indentedHeadings && verdict.indentedHeadings.length > 0
      ? [
          '',
          'check-changelog-entry: FAIL — an INDENTED `## ` heading hides a section.',
          '',
          'CommonMark (and GitHub) render these lines as level-2 headings, but this guard',
          'anchors headings at column 0, so the section each one opens is INVISIBLE to the',
          'placement check and its body is credited to the section above it:',
          '',
          ...verdict.indentedHeadings.map((h) => `  CHANGELOG.md:${h.line}\n    ${h.text}`),
          '',
          'Left alone, an entry added below an indented RELEASED heading is reported OK',
          'while GitHub shows it buried in a shipped section. Fix the line, not the guard:',
          '',
          '  - a real heading  → remove the leading spaces (column 0)',
          '  - an EXAMPLE of a heading → put it in a fenced code block, or indent it to 4+',
          '    spaces, either of which CommonMark reads as code rather than a heading',
        ]
      : []

  if (verdict.misplaced) {
    // Release headings carry a long ` — <summary>` tail; the version token is
    // the part a reader needs, and the full line makes the report unreadable.
    const short = (/** @type {string} */ h) => h.split(' — ')[0].trim()
    const sections = [...new Set(verdict.misplaced.map((m) => short(m.section)))]
    // The post-release-trap story below is simply wrong when there is no
    // staging section at all: with no `## Unreleased`, EVERY added line is
    // necessarily under a released heading, and the fix is to restore the
    // header, not to rebase. Say which one the reader is looking at.
    const noUnreleased = !parseSections(headChangelog).some((s) => !s.released)
    return {
      status: 'fail',
      lines: [
        ...warnings,
        'check-changelog-entry: FAIL — a CHANGELOG entry landed in an ALREADY-RELEASED section.',
        '',
        'These lines were added by this change, but they sit under a released version',
        'heading instead of under `## Unreleased`:',
        '',
        ...verdict.misplaced.map(
          (m) => `  CHANGELOG.md:${m.line}  under \`${short(m.section)}\`\n    ${m.text}`,
        ),
        '',
        ...(noUnreleased
          ? [
              'NOTE: this CHANGELOG.md has NO `## Unreleased` section, so every added line',
              'necessarily lands under a released heading. Re-add the `## Unreleased` header',
              'above the newest release and move your entry under it — that section is what',
              'cutting a release renames, so it must always exist.',
              '',
            ]
          : []),
        'This is almost always the post-release merge trap: you staged the entry under',
        '`## Unreleased`, a release was cut before this merged (renaming that header to',
        `${sections.map((s) => `\`${s}\``).join(', ')}), and the merge then applied your entry TEXTUALLY`,
        'CLEAN into what is now a shipped section. No conflict, no error — just wrong',
        'release notes and an entry buried where nobody will read it.',
        '',
        'Fix: rebase onto the current base, then MOVE your entry back under',
        '`## Unreleased`. Verify with a COMMITTED merge (an uncommitted one is an empty',
        'diff range and passes vacuously):',
        '',
        '  git fetch origin && git merge origin/main && node scripts/check-changelog-entry.mjs',
        '',
        'If you are deliberately editing an already-released section (fixing a typo in an',
        'old entry, a retroactive backport note), put `[changelog placement ok]` on its',
        'OWN LINE in the PR body or a commit message.',
        ...indentReport,
      ],
    }
  }

  if (indentReport.length > 0) {
    return { status: 'fail', lines: [...warnings, ...indentReport.slice(1)] }
  }

  return {
    status: 'fail',
    lines: [
      ...warnings,
      'check-changelog-entry: FAIL',
      '',
      'This PR changes shippable code but stages no changelog note. Shippable',
      'paths changed:',
      '',
      ...verdict.shippable.map((p) => `  ${p}`),
      '',
      'Add a NEW fragment file under `changelog.d/` describing the change, in this',
      'same PR — `bun run changelog:generate` derives one from your conventional-',
      'commit title, or write `changelog.d/<pr>-<slug>.<type>.md` by hand (see',
      'changelog.d/README.md). Fragments are per-PR files, so they never conflict',
      'with another in-flight PR; the release cut assembles them into the',
      '`## vX.Y.Z` section (skills/switchroom-release/SKILL.md, Step 1).',
      '',
      '(A hand-written entry under `## Unreleased` in CHANGELOG.md still counts',
      'too, but it WILL conflict with every other open PR — prefer the fragment.)',
      '',
      'If this really is a docs/chore/test-only change that ships nothing a user',
      'would read a changelog for, take the escape hatch:',
      '  - add the `no-changelog` label to the PR, or',
      '  - put `[skip changelog]` on its OWN LINE in the PR body or a commit message.',
    ],
  }
}

/** @param {string} dir The git toplevel containing `dir`, or `dir` itself. */
function resolveRepoRoot(dir) {
  try {
    return git(['rev-parse', '--show-toplevel'], dir).trim() || dir
  } catch {
    return dir
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const result = run()
  const sink = result.status === 'fail' ? console.error : console.log
  for (const l of result.lines) sink(l)
  process.exit(result.status === 'fail' ? 1 : 0)
}
