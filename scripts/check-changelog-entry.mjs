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
 *   A PR that changes SHIPPABLE code MUST grow the `## Unreleased` section of
 *   CHANGELOG.md — i.e. add at least one entry line under that header that was
 *   not already there on the base branch.
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
 * ── Skips (a skip is a pass, never a silent gate) ────────────────────────
 *
 * - `merge_group` event: the queue builds a synthetic squash commit with no PR
 *   base to diff against; enforcement already happened at the `pull_request`
 *   event via the required `lint` context. Mirrors check-agent-attribution-
 *   trailers.mjs's merge_group skip.
 * - No base ref resolvable (shallow clone, detached checkout): SKIP rather than
 *   fail. CI checks out with fetch-depth: 0 for exactly this reason.
 * - No merge-base between base and HEAD (unrelated histories): SKIP.
 * - No CHANGELOG.md at HEAD: SKIP (nothing to enforce).
 *
 * Run: `npm run lint:changelog-entry` (also part of `npm run lint`).
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * Strip `<!-- ... -->` HTML comment blocks (possibly multi-line) so the
 * convention comment seeded under `## Unreleased` is never counted as an
 * entry.
 * @param {string} text
 * @returns {string}
 */
export function stripHtmlComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Extract the trimmed, meaningful entry lines under the `## Unreleased`
 * header — every non-blank line up to the next `## ` heading, with HTML
 * comments removed first.
 *
 * A missing Unreleased section yields `[]` (not an error): the guard treats
 * "no section" and "empty section" identically — either way it has not grown.
 *
 * @param {string} changelog full CHANGELOG.md text
 * @returns {string[]}
 */
export function extractUnreleasedEntries(changelog) {
  const text = stripHtmlComments(String(changelog).replace(/\r\n/g, '\n'))
  const lines = text.split('\n')
  let i = 0
  // Find the `## Unreleased` header (case-insensitive, tolerant of trailing
  // text like `## Unreleased — staged`).
  while (i < lines.length && !/^##\s+unreleased\b/i.test(lines[i].trim())) i++
  if (i >= lines.length) return []
  i++ // move past the header line
  /** @type {string[]} */
  const entries = []
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break // next section header ends Unreleased
    const trimmed = line.trim()
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
 * }} input
 * @returns {{status: 'pass'|'fail', reason: string, shippable?: string[]}}
 */
export function evaluate({
  changedFiles,
  baseChangelog,
  headChangelog,
  commitMessages = [],
  prBody = '',
  prLabels = '',
}) {
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
  if (unreleasedGrew(baseChangelog, headChangelog)) {
    return { status: 'pass', reason: '## Unreleased grew' }
  }
  return { status: 'fail', reason: 'shippable change with no new ## Unreleased entry', shippable }
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
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {{base: string, head: string} | null}
 */
export function resolveRange(cwd, env = process.env) {
  const head = env.CHANGELOG_HEAD || 'HEAD'
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
  return null
}

const RECORD = '\x1e'

/**
 * @param {string} cwd
 * @returns {{status: 'pass'|'fail'|'skip', lines: string[]}}
 */
export function run(cwd = resolveRepoRoot(process.cwd()), env = process.env) {
  if (env.GITHUB_EVENT_NAME === 'merge_group') {
    return {
      status: 'skip',
      lines: [
        'check-changelog-entry: SKIP — merge_group event.',
        '  The queue builds a synthetic squash commit with no PR base to diff;',
        '  the changelog requirement was already enforced at the pull_request event.',
      ],
    }
  }

  const range = resolveRange(cwd, env)
  if (!range) {
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

  const changedFiles = gitSoft(['diff', '--name-only', `${mergeBase}..${range.head}`], cwd)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const baseChangelog = gitSoft(['show', `${mergeBase}:CHANGELOG.md`], cwd)
  const headChangelog = gitSoft(['show', `${range.head}:CHANGELOG.md`], cwd)

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
  })

  if (verdict.status === 'pass') {
    return {
      status: 'pass',
      lines: [`check-changelog-entry: OK — ${verdict.reason} (${range.base}...${range.head}).`],
    }
  }

  return {
    status: 'fail',
    lines: [
      'check-changelog-entry: FAIL',
      '',
      'This PR changes shippable code but adds no new entry under `## Unreleased`',
      'in CHANGELOG.md. Shippable paths changed:',
      '',
      ...verdict.shippable.map((p) => `  ${p}`),
      '',
      'Add a one-line entry under the `## Unreleased` header describing the change,',
      'in this same PR. Cutting a release then just renames that header to',
      '`## vX.Y.Z — <summary>` (see skills/switchroom-release/SKILL.md, Step 1).',
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
