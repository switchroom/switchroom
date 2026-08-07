#!/usr/bin/env node
/**
 * gen-changelog-entry — the AUTHOR-SIDE complement to
 * `scripts/check-changelog-entry.mjs`.
 *
 * Why this script exists
 * ----------------------
 * #4469 made a staged `## Unreleased` entry a REQUIRED-check precondition: a PR
 * that ships code without one goes red (`check-changelog-entry.mjs`, part of
 * `npm run lint`). That kept the release-cut a trivial rename, but at the cost
 * of a per-PR authoring round-trip — forget the line, watch CI red, push
 * again.
 *
 * The obvious fix (have CI auto-append the line and commit it back to the PR
 * branch) is a TRAP on this repo: a push made with the workflow's
 * `GITHUB_TOKEN` does not create new workflow runs (GitHub's recursion
 * guard), so the new head SHA would carry NONE of the seven required contexts
 * and the PR would wedge `BLOCKED` forever. A re-triggering push needs a
 * GitHub App / PAT credential the repo does not have. See
 * `.github/MERGE-QUEUE.md` § "Author-side changelog generation".
 *
 * So generation runs AUTHOR-SIDE instead: the author (an agent worker, before
 * `gh pr create`, or via `bun run changelog:generate`) stages the derived
 * entry in THEIR OWN commit. That push is an ordinary author push — it
 * re-triggers every required check normally, exactly the property the
 * CI-commit-back path cannot have. #4469 stays as the deterministic BACKSTOP:
 * if you skip this helper, CI still reds until an entry exists.
 *
 * ── WHAT IT DOES ─────────────────────────────────────────────────────────
 *
 *   1. Resolves the base..HEAD range (same cascade as check-changelog-entry).
 *   2. If no SHIPPABLE code changed → no-op (a docs/chore/test PR, or the
 *      release PR which touches CHANGELOG.md only, needs no entry).
 *   3. If an escape hatch is present (`no-changelog` label / `[skip changelog]`
 *      token on its own line in the PR body or any commit message) → no-op:
 *      the hatch opts OUT of both enforcement AND generation.
 *   4. If `## Unreleased` has ALREADY grown vs base → no-op: the author (or a
 *      prior run of this script) already staged an entry. This is what makes
 *      the helper IDEMPOTENT — run it twice, the second run sees its own entry
 *      as growth and does nothing.
 *   5. Otherwise derive an entry from the PR title / newest conventional-commit
 *      subject, and append it under `## Unreleased` (grouped under a `###`
 *      category subhead when the type maps to one), then write CHANGELOG.md.
 *
 * ── ESCAPE HATCHES (identical to check-changelog-entry) ──────────────────
 *
 *   - the `no-changelog` PR LABEL (via $CHANGELOG_PR_LABELS or --labels), or
 *   - a `[skip changelog]` token ALONE on its own line in the PR body
 *     ($CHANGELOG_PR_BODY / --body) or in ANY commit message on the branch.
 *
 * ── SKIPS (never write) ──────────────────────────────────────────────────
 *
 *   - `merge_group` event: the queue ref has empty PR context and no base to
 *     diff — generation there is meaningless. Mirrors the check's skip.
 *   - no base ref / no merge-base / no CHANGELOG.md at HEAD → no-op.
 *
 * Run: `node scripts/gen-changelog-entry.mjs` (or `bun run changelog:generate`).
 * Flags: --title <subject> --pr <n> --body <text> --labels <csv> --base <ref>
 *        --dry-run (print the entry + target, write nothing)
 *        --quiet   (suppress the informational log line)
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  isShippable,
  extractUnreleasedEntries,
  unreleasedGrew,
  hasSkipToken,
  hasSkipLabel,
  resolveRange,
} from './check-changelog-entry.mjs'

// ── conventional-commit parsing ──────────────────────────────────────────

/**
 * Parse a conventional-commit subject line.
 * `fix(memory)!: drop the stale key` →
 *   { type:'fix', scope:'memory', breaking:true, subject:'drop the stale key' }
 * A non-conventional line yields { type:null, scope:null, breaking:false,
 * subject:<the whole trimmed line> } so the caller always gets a usable subject.
 * @param {string} title
 */
export function parseConventional(title) {
  const line = String(title).replace(/\r?\n[\s\S]*$/, '').trim() // first line only
  const m = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/.exec(line)
  if (!m) {
    return { type: null, scope: null, breaking: false, subject: line }
  }
  return {
    type: m[1].toLowerCase(),
    scope: m[2] ? m[2].trim() : null,
    breaking: Boolean(m[3]),
    subject: m[4].trim(),
  }
}

/**
 * Map a conventional-commit type to a CHANGELOG `###` category heading, or
 * `null` for "no category — emit a plain top-level bullet". Kept small and
 * deterministic; an unrecognised type falls through to `null`.
 * @param {string|null} type
 * @returns {string|null}
 */
export function categoryForType(type) {
  switch (type) {
    case 'feat':
      return 'Features'
    case 'fix':
      return 'Bug fixes'
    case 'perf':
      return 'Performance'
    case 'refactor':
      return 'Refactoring'
    case 'docs':
      return 'Documentation'
    case 'build':
    case 'ci':
      return 'Build & CI'
    case 'revert':
      return 'Reverts'
    default:
      return null
  }
}

/**
 * Build the bullet line for a parsed title + optional PR number. Deterministic
 * and stable so a second run produces a byte-identical line (idempotency).
 * @param {{scope:string|null, breaking:boolean, subject:string}} parsed
 * @param {string|null} prNumber
 * @returns {string}
 */
export function buildEntryLine(parsed, prNumber) {
  const suffix = prNumber ? ` (#${prNumber})` : ''
  const bang = parsed.breaking ? '**BREAKING** ' : ''
  const scoped = parsed.scope ? `${parsed.scope}: ${parsed.subject}` : parsed.subject
  return `- ${bang}**${scoped}${suffix}**`
}

/**
 * Insert `entryLine` under `## Unreleased`, optionally beneath a `### category`
 * subhead (created if absent). Pure string transform — no IO.
 *
 * Placement rules:
 *  - Under an existing matching `### category`, append after its last bullet.
 *  - Else create the `### category` block at the TOP of the section (after the
 *    HTML-comment preamble), so newest work reads first.
 *  - With no category, insert the bullet directly at the top of the section.
 * @param {string} changelog
 * @param {string} entryLine
 * @param {string|null} category
 * @returns {string}
 */
export function insertEntry(changelog, entryLine, category) {
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n'
  const lines = changelog.replace(/\r\n/g, '\n').split('\n')

  // Locate `## Unreleased`. If absent, seed one right after the `# Changelog`
  // title (or at the very top) so there is always a section to stage into.
  let head = lines.findIndex((l) => /^##\s+unreleased\b/i.test(l.trim()))
  if (head === -1) {
    const titleIdx = lines.findIndex((l) => /^#\s+/.test(l.trim()))
    const at = titleIdx === -1 ? 0 : titleIdx + 1
    lines.splice(at, 0, '', '## Unreleased', '')
    head = lines.findIndex((l) => /^##\s+unreleased\b/i.test(l.trim()))
  }

  // Section body spans (head, end): up to the next `## ` heading (NOT `###`).
  let end = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }

  // Skip the HTML-comment preamble + leading blanks to find the section's
  // first real content line (`preambleEnd`).
  let preambleEnd = head + 1
  let inComment = false
  for (let i = head + 1; i < end; i++) {
    const t = lines[i].trim()
    if (inComment) {
      if (/-->/.test(t)) inComment = false
      preambleEnd = i + 1
      continue
    }
    if (/^<!--/.test(t)) {
      inComment = !/-->/.test(t)
      preambleEnd = i + 1
      continue
    }
    if (t === '') {
      preambleEnd = i + 1
      continue
    }
    break
  }

  const bullet = entryLine

  if (!category) {
    // Plain bullet at the top of the section body.
    lines.splice(preambleEnd, 0, bullet, '')
    return lines.join(eol)
  }

  // Find an existing `### <category>` within the section.
  const catRe = new RegExp(`^###\\s+${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')
  let catIdx = -1
  for (let i = preambleEnd; i < end; i++) {
    if (catRe.test(lines[i].trim())) {
      catIdx = i
      break
    }
  }

  if (catIdx !== -1) {
    // Append after the category's existing bullets (up to next `###`/`##`/end).
    let insertAt = end
    for (let i = catIdx + 1; i < end; i++) {
      if (/^###?\s/.test(lines[i])) {
        insertAt = i
        break
      }
    }
    // Back up over trailing blank lines so the bullet joins the list.
    while (insertAt > catIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--
    lines.splice(insertAt, 0, bullet)
    return lines.join(eol)
  }

  // Create the category block at the top of the section.
  lines.splice(preambleEnd, 0, `### ${category}`, '', bullet, '')
  return lines.join(eol)
}

// ── git plumbing (minimal; parsing reused from check-changelog-entry.mjs) ──

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024, // CHANGELOG.md is >1 MiB; see check-changelog-entry.mjs
  })
}

/** @param {string[]} args @param {string} cwd → '' on any failure. */
function gitSoft(args, cwd) {
  try {
    return git(args, cwd)
  } catch {
    return ''
  }
}

/** @param {string} treeishPath @param {string} cwd */
function gitPathExists(treeishPath, cwd) {
  try {
    git(['cat-file', '-e', treeishPath], cwd)
    return true
  } catch {
    return false
  }
}

/** @param {string} dir → git toplevel, or dir itself. */
function resolveRepoRoot(dir) {
  try {
    return git(['rev-parse', '--show-toplevel'], dir).trim() || dir
  } catch {
    return dir
  }
}

const RECORD = '\x1e'

// ── argv ───────────────────────────────────────────────────────────────────

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string,string|boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--quiet') out.quiet = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    }
  }
  return out
}

/**
 * Resolve the PR number from --pr / env, else try `gh pr view` on the current
 * branch (no-op if gh is absent or no PR exists yet), else null.
 * @param {Record<string,string|boolean>} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @returns {string|null}
 */
function resolvePrNumber(args, env, cwd) {
  const explicit = args.pr || env.CHANGELOG_PR_NUMBER
  if (explicit && explicit !== true) {
    const n = String(explicit).replace(/^#/, '').trim()
    return /^\d+$/.test(n) ? n : null
  }
  let viewed = ''
  try {
    viewed = execFileSync('gh', ['pr', 'view', '--json', 'number', '-q', '.number'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    viewed = ''
  }
  return /^\d+$/.test(viewed) ? viewed : null
}

/**
 * Resolve the title/subject: --title / env, else the newest conventional-commit
 * subject in the range, else the newest commit subject.
 * @param {Record<string,string|boolean>} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} commitSubjects newest-first
 * @returns {string}
 */
export function resolveTitle(args, env, commitSubjects) {
  const explicit = args.title || env.CHANGELOG_PR_TITLE
  if (explicit && explicit !== true) return String(explicit)
  const conventional = commitSubjects.find((s) => parseConventional(s).type !== null)
  return conventional || commitSubjects[0] || ''
}

/**
 * The pure planner. Given the resolved inputs, decide whether to write and what.
 * Shared by the CLI and the tests so the decision is asserted directly.
 * @param {{
 *   changedFiles: string[],
 *   baseChangelog: string,
 *   headChangelog: string,
 *   title: string,
 *   prNumber: string|null,
 *   commitMessages?: string[],
 *   prBody?: string,
 *   prLabels?: string,
 * }} input
 * @returns {{action:'write'|'skip', reason:string, entryLine?:string,
 *            category?:string|null, changelog?:string}}
 */
export function plan({
  changedFiles,
  baseChangelog,
  headChangelog,
  title,
  prNumber,
  commitMessages = [],
  prBody = '',
  prLabels = '',
}) {
  const shippable = (changedFiles || []).filter(isShippable)
  if (shippable.length === 0) {
    return { action: 'skip', reason: 'no shippable code changed' }
  }
  const escaped =
    hasSkipLabel(prLabels) ||
    hasSkipToken(prBody) ||
    commitMessages.some((m) => hasSkipToken(m))
  if (escaped) {
    return { action: 'skip', reason: 'escape hatch (no-changelog label / [skip changelog] token)' }
  }
  if (unreleasedGrew(baseChangelog, headChangelog)) {
    return { action: 'skip', reason: '## Unreleased already has a new entry (idempotent no-op)' }
  }
  const parsed = parseConventional(title)
  if (!parsed.subject) {
    return { action: 'skip', reason: 'no title/commit subject to derive an entry from' }
  }
  const category = categoryForType(parsed.type)
  const entryLine = buildEntryLine(parsed, prNumber)

  // Defence-in-depth idempotency: if a line normalising to the same bullet, or
  // one already carrying this PR number, is present, do not add a duplicate.
  const existing = extractUnreleasedEntries(headChangelog)
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  if (existing.some((e) => norm(e) === norm(entryLine))) {
    return { action: 'skip', reason: 'entry already present under ## Unreleased' }
  }
  if (prNumber && existing.some((e) => e.includes(`(#${prNumber})`))) {
    return { action: 'skip', reason: `an entry for (#${prNumber}) is already present` }
  }

  const changelog = insertEntry(headChangelog, entryLine, category)
  return { action: 'write', reason: 'staged a derived ## Unreleased entry', entryLine, category, changelog }
}

/**
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} argv
 * @returns {{status:'wrote'|'skip', lines:string[]}}
 */
export function run(cwd = resolveRepoRoot(process.cwd()), env = process.env, argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  if (env.GITHUB_EVENT_NAME === 'merge_group') {
    return { status: 'skip', lines: ['gen-changelog-entry: SKIP — merge_group event (empty PR context).'] }
  }

  const baseArg = typeof args.base === 'string' ? args.base : undefined
  const range = resolveRange(cwd, baseArg ? { ...env, CHANGELOG_BASE: baseArg } : env)
  if (!range) {
    return { status: 'skip', lines: ['gen-changelog-entry: SKIP — no base ref to diff against.'] }
  }
  const mergeBase = gitSoft(['merge-base', range.base, range.head], cwd).trim()
  if (!mergeBase) {
    return { status: 'skip', lines: ['gen-changelog-entry: SKIP — could not resolve a merge-base.'] }
  }
  if (!gitPathExists(`${range.head}:CHANGELOG.md`, cwd)) {
    return { status: 'skip', lines: ['gen-changelog-entry: SKIP — no CHANGELOG.md at HEAD.'] }
  }

  // Changed files: the committed range PLUS any uncommitted work-tree changes
  // and new files — the author may run this before OR after committing code.
  const changedFiles = [
    ...gitSoft(['diff', '--name-only', `${mergeBase}..${range.head}`], cwd).split('\n'),
    ...gitSoft(['diff', '--name-only', 'HEAD'], cwd).split('\n'),
    ...gitSoft(['ls-files', '--others', '--exclude-standard'], cwd).split('\n'),
  ]
    .map((l) => l.trim())
    .filter(Boolean)

  const baseChangelog = gitSoft(['show', `${mergeBase}:CHANGELOG.md`], cwd)
  // HEAD content is the WORKING-TREE CHANGELOG.md the author is about to commit,
  // not the committed blob — so an already-staged (or already-generated but
  // uncommitted) entry counts as growth and a re-run is a genuine no-op, rather
  // than double-adding when run twice before the commit lands.
  const changelogPath = `${resolveRepoRoot(cwd)}/CHANGELOG.md`
  const headChangelog = existsSync(changelogPath)
    ? readFileSync(changelogPath, 'utf-8')
    : gitSoft(['show', `${range.head}:CHANGELOG.md`], cwd)
  const commitMessages = gitSoft(['log', `--format=%B${RECORD}`, `${mergeBase}..${range.head}`], cwd)
    .split(RECORD)
    .map((m) => m.trim())
    .filter(Boolean)
  const commitSubjects = gitSoft(['log', '--format=%s', `${mergeBase}..${range.head}`], cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  const title = resolveTitle(args, env, commitSubjects)
  const prNumber = resolvePrNumber(args, env, cwd)

  const verdict = plan({
    changedFiles,
    baseChangelog,
    headChangelog,
    title,
    prNumber,
    commitMessages,
    prBody: typeof args.body === 'string' ? args.body : env.CHANGELOG_PR_BODY || '',
    prLabels: typeof args.labels === 'string' ? args.labels : env.CHANGELOG_PR_LABELS || '',
  })

  if (verdict.action === 'skip') {
    return { status: 'skip', lines: [`gen-changelog-entry: no change — ${verdict.reason}.`] }
  }

  const grouped = verdict.category ? ` / ### ${verdict.category}` : ''
  if (args.dryRun) {
    return {
      status: 'skip',
      lines: [
        `gen-changelog-entry: DRY RUN — would stage under ## Unreleased${grouped}:`,
        `  ${verdict.entryLine}`,
      ],
    }
  }

  writeFileSync(`${resolveRepoRoot(cwd)}/CHANGELOG.md`, verdict.changelog)
  return {
    status: 'wrote',
    lines: [
      `gen-changelog-entry: staged an entry under ## Unreleased${grouped}:`,
      `  ${verdict.entryLine}`,
      '  Commit CHANGELOG.md in this PR; #4469 stays as the CI backstop.',
    ],
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('gen-changelog-entry.mjs')
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const result = run()
  if (!args.quiet) for (const l of result.lines) console.log(l)
  process.exit(0)
}
