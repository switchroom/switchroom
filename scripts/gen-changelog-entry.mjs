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
 *   4. If a changelog note is ALREADY staged — a `changelog.d/` fragment added
 *      in the range or sitting uncommitted in the worktree, or a grown
 *      `## Unreleased` — → no-op. This is what makes the helper IDEMPOTENT:
 *      run it twice, the second run sees its own fragment and does nothing.
 *   5. Otherwise derive an entry from the PR title / newest conventional-commit
 *      subject and write it as a NEW fragment file,
 *      `changelog.d/<pr>-<slug>.<type>.md`. It deliberately does NOT touch
 *      CHANGELOG.md: a per-PR fragment file cannot conflict with another
 *      in-flight PR, which is the whole point (see changelog.d/README.md).
 *      The release cut assembles fragments into the `## vX.Y.Z` section via
 *      `scripts/cut-changelog-release.mjs`.
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  isShippable,
  isChangelogFragment,
  FRAGMENT_DIR,
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
 * Slug a subject line for a fragment file name: lowercase, alphanumerics
 * joined by single dashes, bounded so a long PR title cannot mint an
 * unwieldy path. Deterministic so a second run derives the same name
 * (idempotency depends on it).
 * @param {string} subject
 * @returns {string}
 */
export function slugify(subject) {
  return (
    String(subject)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'entry'
  )
}

/**
 * Derive the fragment file name for a parsed title + optional PR number:
 * `<pr>-<slug>.<type>.md` (PR number omitted when unknown, type falling back
 * to `other` for a non-conventional title). The `.<type>.md` double extension
 * is what `cut-changelog-release.mjs` maps to a `###` category at release
 * time; an unknown type simply lands ungrouped, never an error.
 * @param {{type:string|null, subject:string}} parsed
 * @param {string|null} prNumber
 * @returns {string} file name (no directory)
 */
export function fragmentFileName(parsed, prNumber) {
  const type = parsed.type && /^[a-z]+$/.test(parsed.type) ? parsed.type : 'other'
  const prefix = prNumber ? `${prNumber}-` : ''
  return `${prefix}${slugify(parsed.subject)}.${type}.md`
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
 *   addedFiles?: string[],
 *   baseChangelog: string,
 *   headChangelog: string,
 *   title: string,
 *   prNumber: string|null,
 *   commitMessages?: string[],
 *   prBody?: string,
 *   prLabels?: string,
 * }} input
 * @returns {{action:'write'|'skip', reason:string, entryLine?:string,
 *            category?:string|null, fragmentPath?:string, fragmentContent?:string}}
 */
export function plan({
  changedFiles,
  addedFiles = [],
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
  // A fragment already staged in the range (or uncommitted in the worktree —
  // the caller folds both into addedFiles) is the primary idempotency check:
  // run this helper twice and the second run sees the first run's file.
  const staged = (addedFiles || []).filter(isChangelogFragment)
  if (staged.length > 0) {
    return { action: 'skip', reason: `a changelog fragment is already staged (${staged[0]})` }
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

  // Defence-in-depth idempotency against the LEGACY path: an entry already
  // hand-staged under ## Unreleased (same bullet, or any bullet carrying this
  // PR number) must not gain a duplicate fragment.
  const existing = extractUnreleasedEntries(headChangelog)
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase()
  if (existing.some((e) => norm(e) === norm(entryLine))) {
    return { action: 'skip', reason: 'entry already present under ## Unreleased' }
  }
  if (prNumber && existing.some((e) => e.includes(`(#${prNumber})`))) {
    return { action: 'skip', reason: `an entry for (#${prNumber}) is already present` }
  }

  const fragmentPath = `${FRAGMENT_DIR}${fragmentFileName(parsed, prNumber)}`
  return {
    action: 'write',
    reason: 'staged a changelog fragment',
    entryLine,
    category,
    fragmentPath,
    fragmentContent: `${entryLine}\n`,
  }
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
  // `resolveRange` reports failure as an `{error}` object rather than null (so
  // its queue-ref caller can tell "base unset" from "base unresolvable"). This
  // author-side helper skips on either — but it must TEST for the error rather
  // than for falsiness, since `{error}` is truthy.
  const range = resolveRange(cwd, baseArg ? { ...env, CHANGELOG_BASE: baseArg } : env)
  if ('error' in range) {
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

  // Files ADDED — committed adds in the range, uncommitted adds vs HEAD, and
  // untracked files. Fragment idempotency keys on these: a fragment this
  // helper wrote a minute ago is untracked (or committed), and either way a
  // re-run must see it and no-op. `--no-renames` matches the checker.
  const addedFiles = [
    ...gitSoft(
      ['diff', '--name-only', '--no-renames', '--diff-filter=A', `${mergeBase}..${range.head}`],
      cwd,
    ).split('\n'),
    ...gitSoft(['diff', '--name-only', '--no-renames', '--diff-filter=A', 'HEAD'], cwd).split('\n'),
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
    addedFiles,
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

  if (args.dryRun) {
    return {
      status: 'skip',
      lines: [
        `gen-changelog-entry: DRY RUN — would write ${verdict.fragmentPath}:`,
        `  ${verdict.entryLine}`,
      ],
    }
  }

  const root = resolveRepoRoot(cwd)
  mkdirSync(join(root, FRAGMENT_DIR), { recursive: true })
  writeFileSync(join(root, verdict.fragmentPath), verdict.fragmentContent)
  return {
    status: 'wrote',
    lines: [
      `gen-changelog-entry: wrote ${verdict.fragmentPath}:`,
      `  ${verdict.entryLine}`,
      '  Commit the fragment in this PR; check-changelog-entry stays the CI backstop.',
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
