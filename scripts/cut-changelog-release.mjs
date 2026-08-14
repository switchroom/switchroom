#!/usr/bin/env node
/**
 * cut-changelog-release — assemble the release section of CHANGELOG.md from
 * the staged `changelog.d/` fragments (plus anything hand-staged under
 * `## Unreleased`), and re-seed an empty staging area for the next cycle.
 *
 * Why this script exists
 * ----------------------
 * Per-PR changelog notes live as FRAGMENT files under `changelog.d/`
 * (see changelog.d/README.md): each PR adds its own file, so two in-flight
 * PRs never edit the same file and the merge-conflict class that ejected
 * three PRs from the merge queue in one day (#4678→#4679, #4679→#4712,
 * #4678→#4712) is gone. The cost is that cutting a release is no longer a
 * pure header rename — somebody has to fold the fragments into the
 * `## vX.Y.Z` section and delete them. That somebody is this script, so the
 * release step stays one command + a human review, not an assembly chore
 * (see skills/switchroom-release/SKILL.md, Step 1).
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────
 *
 *   1. Reads every fragment `changelog.d/<name>.md` (flat, README excluded —
 *      same definition as check-changelog-entry's `isChangelogFragment`, so
 *      the guard and the assembler always agree on the file set), sorted by
 *      name for determinism.
 *   2. Groups fragment bullets by the `.<type>.md` double extension via
 *      `categoryForType` (feat → Features, fix → Bug fixes, …); an unknown
 *      or missing type lands ungrouped at the top of the section.
 *   3. Carries over whatever sits under `## Unreleased` (the legacy /
 *      hand-staged path), minus the convention HTML comment — fragments merge
 *      INTO an existing `### <category>` block rather than duplicating it.
 *   4. Writes CHANGELOG.md with a fresh empty `## Unreleased` (header +
 *      convention comment) on top and the assembled `## vX.Y.Z — <summary>`
 *      section below it, then DELETES the consumed fragment files.
 *
 * The output section is exactly what `release.yml`'s guard job later feeds to
 * `scripts/ci/extract-changelog-section.mjs` to auto-create the draft GitHub
 * Release — tests/cut-changelog-release.test.ts pins that round-trip against
 * the real extractor.
 *
 * ── FAIL LOUD, NEVER INVENT ──────────────────────────────────────────────
 *
 *   - no --version / malformed version → exit 1
 *   - a `## <version>` section already exists → exit 1 (double cut)
 *   - NOTHING to release (no fragments AND an empty Unreleased) → exit 1:
 *      an empty release note is an anomaly to investigate, not a thing to
 *      ship (the v0.20.12 lesson).
 *
 * Run: `bun run changelog:cut -- --version v0.21.11 --summary "one-liner"`
 * Flags: --version <vX.Y.Z>  (required)
 *        --summary <text>    (required — becomes the ` — <summary>` tail)
 *        --dry-run           (print the assembled section, write nothing)
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { analyze, parseSections, isChangelogFragment, FRAGMENT_DIR } from './check-changelog-entry.mjs'
import { categoryForType } from './gen-changelog-entry.mjs'
import { normalizeVersion, parseHeading } from './ci/extract-changelog-section.mjs'

/**
 * The convention comment re-seeded under `## Unreleased` on every cut. Kept
 * here (the only writer) so the wording cannot drift between cuts.
 */
export const UNRELEASED_SEED = [
  '## Unreleased',
  '',
  '<!--',
  'Staging area for the NEXT release. Do NOT add entries here in a PR:',
  'per-PR notes are FRAGMENT files under changelog.d/ (one file per PR, so',
  'two in-flight PRs never conflict) — see changelog.d/README.md, or run',
  '`bun run changelog:generate`. `scripts/check-changelog-entry.mjs` (part of',
  '`npm run lint`) fails a PR that ships code without staging a note;',
  'docs/chore/test-only PRs opt out with a `no-changelog` label or a',
  '`[skip changelog]` token on its own line. Cutting a release assembles the',
  'fragments into `## vX.Y.Z — <summary>` below this block and re-seeds it:',
  '`bun run changelog:cut -- --version vX.Y.Z --summary "…"`',
  '(skills/switchroom-release/SKILL.md, Step 1). Keep this header present;',
  'hand-written entries under it still count for the guard, but they conflict',
  'with every other open PR — prefer a fragment.',
  '-->',
].join('\n')

/** Canonical category order for assembled sections. */
const CATEGORY_ORDER = [
  'Features',
  'Bug fixes',
  'Performance',
  'Refactoring',
  'Documentation',
  'Build & CI',
  'Reverts',
]

/**
 * Parse a fragment file name's `.<type>.md` double extension into a category
 * heading (or null for ungrouped). `4711-fix-the-thing.fix.md` → 'Bug fixes'.
 * @param {string} name file name, no directory
 * @returns {string|null}
 */
export function categoryForFragmentName(name) {
  const m = /\.([a-z]+)\.md$/i.exec(String(name))
  return m ? categoryForType(m[1].toLowerCase()) : null
}

/**
 * Read the staged fragments from `<root>/changelog.d`, sorted by file name.
 * Uses the SAME path predicate as the CI guard (`isChangelogFragment`), so a
 * file the guard credited as a staged note cannot be silently dropped here.
 * @param {string} root repo root
 * @returns {{name: string, category: string|null, body: string}[]}
 */
export function readFragments(root) {
  const dir = join(root, FRAGMENT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isChangelogFragment(`${FRAGMENT_DIR}${e.name}`))
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      category: categoryForFragmentName(name),
      body: readFileSync(join(dir, name), 'utf-8').replace(/\r\n/g, '\n').replace(/\n+$/, ''),
    }))
    .filter((f) => f.body.trim().length > 0)
}

/**
 * Extract the CARRIED body of `## Unreleased`: everything under the header up
 * to the next `## ` heading, minus a LEADING HTML-comment block (the seeded
 * convention comment) and surrounding blank runs. Fence-aware via the guard's
 * own `parseSections`/`analyze`, so a pasted `## ` inside a code block never
 * truncates the carry.
 * @param {string} changelog
 * @returns {string[]} body lines ([] when the section is absent or empty)
 */
export function carriedUnreleased(changelog) {
  const sections = parseSections(changelog)
  const unreleased = sections.find((s) => !s.released)
  if (!unreleased) return []
  const { lines, prose } = analyze(changelog)
  let from = unreleased.start
  let to = Math.min(unreleased.end, lines.length)
  // Skip leading blanks, then ONE leading non-prose (HTML comment) block, then
  // blanks again. Only the LEADING comment is the seeded convention text; a
  // comment or fence deeper in the body belongs to a real entry and is kept.
  while (from <= to && (lines[from - 1] ?? '').trim() === '') from++
  if (from <= to && !prose[from - 1]) {
    while (from <= to && !prose[from - 1]) from++
  }
  while (from <= to && (lines[from - 1] ?? '').trim() === '') from++
  while (to >= from && (lines[to - 1] ?? '').trim() === '') to--
  if (from > to) return []
  return lines.slice(from - 1, to)
}

/**
 * Merge fragment bullets into a carried body: append to an existing
 * `### <category>` group where one exists, create missing groups in canonical
 * order, and put ungrouped bullets at the top. Pure string/array transform.
 * @param {string[]} carried body lines (may be [])
 * @param {{name: string, category: string|null, body: string}[]} fragments
 * @returns {string[]} assembled section body lines
 */
export function assembleBody(carried, fragments) {
  /** @type {Map<string, string[]>} */
  const groups = new Map()
  /** @type {string[]} */
  const ungrouped = []
  for (const f of fragments) {
    const bulletLines = f.body.split('\n')
    if (f.category) {
      if (!groups.has(f.category)) groups.set(f.category, [])
      groups.get(f.category).push(...bulletLines)
    } else {
      ungrouped.push(...bulletLines)
    }
  }

  let lines = [...carried]

  // Merge into existing `### <category>` groups, one category at a time —
  // re-scanning after each splice keeps indices honest, and the guard's
  // `analyze` keeps a pasted `###` inside a fence from matching.
  for (const category of CATEGORY_ORDER) {
    const bullets = groups.get(category)
    if (!bullets || bullets.length === 0) continue
    const { prose } = analyze(lines.join('\n'))
    const catRe = new RegExp(
      `^###\\s+${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'i',
    )
    let catIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (prose[i] && catRe.test(lines[i])) {
        catIdx = i
        break
      }
    }
    if (catIdx === -1) continue // no existing group; appended below
    // Group ends at the next prose `## `/`### ` heading, or the body's end.
    let end = lines.length
    for (let i = catIdx + 1; i < lines.length; i++) {
      if (prose[i] && /^###?\s/.test(lines[i])) {
        end = i
        break
      }
    }
    while (end > catIdx + 1 && (lines[end - 1] ?? '').trim() === '') end--
    lines.splice(end, 0, ...bullets)
    groups.delete(category)
  }

  // Missing groups, in canonical order, appended after the carried body.
  for (const category of CATEGORY_ORDER) {
    const bullets = groups.get(category)
    if (!bullets || bullets.length === 0) continue
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('')
    lines.push(`### ${category}`, '', ...bullets)
  }

  // Ungrouped bullets read first, before any `###` group.
  if (ungrouped.length > 0) {
    lines = lines.length > 0 ? [...ungrouped, '', ...lines] : [...ungrouped]
  }

  // Normalise the edges.
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/**
 * The pure planner: given the changelog text and fragments, produce the new
 * changelog text and the release section body, or a refusal.
 * @param {{changelog: string, fragments: {name: string, category: string|null, body: string}[],
 *          version: string, summary: string}} input
 * @returns {{ok: true, changelog: string, sectionBody: string[]}
 *         | {ok: false, error: string}}
 */
export function plan({ changelog, fragments, version, summary }) {
  const v = String(version || '').trim()
  if (!/^v\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(v)) {
    return { ok: false, error: `--version must look like vX.Y.Z (got ${JSON.stringify(v)})` }
  }
  if (!String(summary || '').trim()) {
    return { ok: false, error: '--summary is required (the one-line release description)' }
  }
  const md = String(changelog).replace(/\r\n/g, '\n')
  const { lines } = analyze(md)
  const sections = parseSections(md)

  for (const s of sections) {
    const h = parseHeading(s.heading)
    if (h && normalizeVersion(h.version) === normalizeVersion(v)) {
      return { ok: false, error: `a \`## ${v}\` section already exists (line ${s.headingLine}) — double cut?` }
    }
  }

  const carried = carriedUnreleased(md)
  if (carried.length === 0 && fragments.length === 0) {
    return {
      ok: false,
      error:
        'nothing to release: no changelog.d/ fragments and an empty ## Unreleased. ' +
        'If real shippable work landed since the last tag, entries were bypassed — investigate ' +
        'before cutting (skills/switchroom-release/SKILL.md, pre-flight 4).',
    }
  }

  const sectionBody = assembleBody(carried, fragments)
  const heading = `## ${v} — ${String(summary).trim()}`

  const unreleased = sections.find((s) => !s.released)
  // Preamble: everything above `## Unreleased` (the `# Changelog` title), or
  // above the first section when no Unreleased exists.
  const cutAt = unreleased
    ? unreleased.headingLine
    : sections.length > 0
      ? sections[0].headingLine
      : lines.length + 1
  const preamble = lines.slice(0, cutAt - 1)
  while (preamble.length > 0 && preamble[preamble.length - 1].trim() === '') preamble.pop()
  // Tail: everything below the Unreleased body (the released history).
  const tailFrom = unreleased ? unreleased.end + 1 : cutAt
  const tail = lines.slice(tailFrom - 1)
  while (tail.length > 0 && tail[0].trim() === '') tail.shift()

  const out = [
    ...preamble,
    '',
    UNRELEASED_SEED,
    '',
    heading,
    '',
    ...sectionBody,
    ...(tail.length > 0 ? ['', ...tail] : []),
    '',
  ].join('\n')

  return { ok: true, changelog: out, sectionBody }
}

// ── CLI ────────────────────────────────────────────────────────────────────

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string,string|boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      out[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
  }
  return out
}

/** @param {string} dir → git toplevel, or dir itself. */
function resolveRepoRoot(dir) {
  try {
    return (
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() || dir
    )
  } catch {
    return dir
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const root = resolveRepoRoot(process.cwd())
  const changelogPath = join(root, 'CHANGELOG.md')
  if (!existsSync(changelogPath)) {
    console.error('cut-changelog-release: FAIL — no CHANGELOG.md at the repo root.')
    process.exit(1)
  }
  const fragments = readFragments(root)
  const verdict = plan({
    changelog: readFileSync(changelogPath, 'utf-8'),
    fragments,
    version: typeof args.version === 'string' ? args.version : '',
    summary: typeof args.summary === 'string' ? args.summary : '',
  })
  if (!verdict.ok) {
    console.error(`cut-changelog-release: FAIL — ${verdict.error}`)
    process.exit(1)
  }
  if (args.dryRun) {
    console.log('cut-changelog-release: DRY RUN — would write this section and delete', `${fragments.length} fragment(s):`)
    console.log('')
    for (const l of verdict.sectionBody) console.log(`  ${l}`)
    process.exit(0)
  }
  writeFileSync(changelogPath, verdict.changelog)
  for (const f of fragments) unlinkSync(join(root, FRAGMENT_DIR, f.name))
  console.log(
    `cut-changelog-release: wrote the ## ${String(args.version).trim()} section ` +
      `(${verdict.sectionBody.length} lines) and deleted ${fragments.length} fragment(s).`,
  )
  console.log('  Review the section, then commit CHANGELOG.md + the deletions as the release PR.')
}
