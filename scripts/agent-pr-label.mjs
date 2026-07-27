#!/usr/bin/env node
/**
 * agent-pr-label — apply an `agent:<name>` label to a PR, derived from the
 * `Switchroom-Agent:` commit trailers on that PR's commits.
 *
 * Why the trailer is the source of truth
 * -------------------------------------
 * The label could have been applied by whatever opened the PR — a wrapper
 * around `gh pr create`, a rule in CLAUDE.md. Both are forgettable: an agent
 * that pushes a branch and opens the PR through the API, or through the web
 * UI, or that simply doesn't run the wrapper, produces an unlabelled PR and
 * nothing notices.
 *
 * So the label is not a thing anyone REMEMBERS to apply; it is a projection of
 * a fact already recorded in the commits by
 * `bin/git-agent-attribution-hook.sh`. One source of truth, two surfaces:
 * `git log` for the durable record (which survives after the PR is closed and
 * the label is meaningless), the label for the GitHub filter
 * (`gh pr list --label agent:klanker`). They cannot disagree, because the
 * label is computed from the trailers on every push.
 *
 * Create-on-demand, not a pre-created fixed set
 * ---------------------------------------------
 * The fleet roster lives in the operator's private `switchroom.yaml`, which
 * this repo cannot read; agents are added and renamed there without any commit
 * here. A pre-created fixed set of labels would therefore go stale silently —
 * a brand-new agent's first PR would find no label and either fail or (worse)
 * be quietly skipped. Creating on demand means the label set tracks the fleet
 * with no maintenance and no coupling to private config. The cost is that a
 * typo'd or renamed agent leaves a stale label behind; that is a one-line
 * `gh label delete`, and a stale label is visible, whereas a missing one is
 * not.
 *
 * One colour for the whole family
 * -------------------------------
 * Every `agent:*` label is the same colour. Deriving a per-agent colour from a
 * hash reads well with three agents and badly with fifteen — near-identical
 * hues that carry no meaning and cannot be told apart at a glance. The NAME
 * carries the identity; the COLOUR carries the family, so the label list reads
 * as one coherent block no matter how many agents come and go, and the scheme
 * never has to change (which would otherwise churn every existing label).
 *
 * Failure is loud, never silent
 * -----------------------------
 * Every `gh` call is checked and any failure aborts with a non-zero exit, so
 * the workflow step goes red on the PR. There is deliberately no "best effort,
 * carry on" path: an unlabelled PR that nobody was told about is precisely the
 * state this exists to prevent. The one sanctioned no-op is a PR whose commits
 * carry no `Switchroom-Agent:` trailer at all — a human PR, which correctly
 * gets no agent label.
 *
 * Usage:
 *   node scripts/agent-pr-label.mjs --repo owner/name --pr 123
 *   node scripts/agent-pr-label.mjs --repo owner/name --pr 123 --dry-run
 */

import { execFileSync } from 'node:child_process'

/** Shared colour for every `agent:*` label (GitHub wants 6 hex, no `#`). */
export const AGENT_LABEL_COLOR = '5319e7'

/** Prefix that makes the family filterable: `gh pr list --label agent:klanker`. */
export const AGENT_LABEL_PREFIX = 'agent:'

/** Same shape gate as scripts/check-agent-attribution-trailers.mjs. */
const AGENT_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** @param {string} agent */
export function labelNameFor(agent) {
  return `${AGENT_LABEL_PREFIX}${agent}`
}

/** @param {string} agent */
export function labelDescriptionFor(agent) {
  return `Opened by switchroom agent "${agent}" (auto-applied from commit trailers)`
}

/**
 * Extract the distinct, well-shaped agent slugs named by `Switchroom-Agent:`
 * trailers across a PR's commit messages.
 *
 * Sorted, so the label plan is deterministic regardless of commit order.
 *
 * @param {string[]} messages raw commit messages
 * @returns {string[]}
 */
export function agentsFromCommitMessages(messages) {
  /** @type {Set<string>} */
  const found = new Set()
  for (const msg of messages) {
    for (const line of String(msg).replace(/\r\n/g, '\n').split('\n')) {
      const m = /^switchroom-agent\s*:\s*(.+?)\s*$/i.exec(line)
      if (!m) continue
      const value = m[1]
      if (AGENT_VALUE_RE.test(value)) found.add(value)
    }
  }
  return [...found].sort()
}

/**
 * Decide which labels to add and which stale `agent:*` labels to remove.
 *
 * Removal matters: a PR rebased onto another agent's work, or one whose
 * commits were replaced, must not keep advertising an agent that no longer
 * appears in its commits. Only labels in the `agent:` namespace are ever
 * touched — every other label on the PR is left alone.
 *
 * @param {{agents: string[], currentLabels: string[]}} input
 * @returns {{add: string[], remove: string[]}}
 */
export function planLabels({ agents, currentLabels }) {
  const desired = new Set(agents.map(labelNameFor))
  const current = new Set(currentLabels)
  const add = [...desired].filter((l) => !current.has(l)).sort()
  const remove = [...current]
    .filter((l) => l.startsWith(AGENT_LABEL_PREFIX) && !desired.has(l))
    .sort()
  return { add, remove }
}

// ── gh plumbing ──────────────────────────────────────────────────────────

/**
 * @param {string[]} args
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function gh(args) {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message ?? err),
    }
  }
}

/** @param {string[]} args */
function ghOrThrow(args, what) {
  const r = gh(args)
  if (r.code !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${what}): ${r.stderr.trim() || r.stdout.trim()}`)
  }
  return r.stdout
}

/**
 * `gh api --paginate --slurp` yields an array of pages; older gh yields a
 * single array. Flatten either shape rather than pinning a gh version.
 * @param {string} raw
 */
function flattenPages(raw) {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((x) => (Array.isArray(x) ? x : [x]))
}

/**
 * @param {{repo: string, pr: string|number, dryRun: boolean, log?: (s: string) => void}} opts
 * @returns {{agents: string[], add: string[], remove: string[], created: string[]}}
 */
export function applyAgentLabels({ repo, pr, dryRun = false, log = console.log }) {
  const commitsRaw = ghOrThrow(
    ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/commits?per_page=100`],
    'listing PR commits',
  )
  const messages = flattenPages(commitsRaw).map((c) => c?.commit?.message ?? '')
  const agents = agentsFromCommitMessages(messages)

  const labelsRaw = ghOrThrow(
    ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/labels?per_page=100`],
    'listing PR labels',
  )
  const currentLabels = flattenPages(labelsRaw).map((l) => l?.name ?? '').filter(Boolean)

  const { add, remove } = planLabels({ agents, currentLabels })

  if (agents.length === 0) {
    log('agent-pr-label: no `Switchroom-Agent:` trailer on any commit — human PR, nothing to label.')
  } else {
    log(`agent-pr-label: agents=${agents.join(', ')} add=[${add.join(', ')}] remove=[${remove.join(', ')}]`)
  }

  if (dryRun) return { agents, add, remove, created: [] }

  /** @type {string[]} */
  const created = []
  for (const name of add) {
    // Existence probe, then create. `gh label create` has an `--force` that
    // would silently rewrite an existing label's colour/description; probing
    // keeps a hand-tuned description intact.
    const probe = gh(['api', `repos/${repo}/labels/${encodeURIComponent(name)}`])
    if (probe.code !== 0) {
      const agent = name.slice(AGENT_LABEL_PREFIX.length)
      ghOrThrow(
        [
          'api', '--method', 'POST', `repos/${repo}/labels`,
          '-f', `name=${name}`,
          '-f', `color=${AGENT_LABEL_COLOR}`,
          '-f', `description=${labelDescriptionFor(agent)}`,
        ],
        `creating label ${name}`,
      )
      created.push(name)
    }
    ghOrThrow(
      ['api', '--method', 'POST', `repos/${repo}/issues/${pr}/labels`, '-f', `labels[]=${name}`],
      `applying label ${name}`,
    )
  }

  for (const name of remove) {
    ghOrThrow(
      ['api', '--method', 'DELETE', `repos/${repo}/issues/${pr}/labels/${encodeURIComponent(name)}`],
      `removing stale label ${name}`,
    )
  }

  return { agents, add, remove, created }
}

// ── CLI ──────────────────────────────────────────────────────────────────

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--pr') out.pr = argv[++i]
  }
  return out
}

const invokedDirectly = process.argv[1]?.endsWith('agent-pr-label.mjs')
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.repo || !args.pr) {
    console.error('usage: agent-pr-label.mjs --repo owner/name --pr <number> [--dry-run]')
    process.exit(2)
  }
  try {
    applyAgentLabels({ repo: String(args.repo), pr: String(args.pr), dryRun: Boolean(args.dryRun) })
  } catch (err) {
    console.error(`agent-pr-label: FAILED — ${err instanceof Error ? err.message : String(err)}`)
    console.error(
      'This is deliberately fatal: a PR that silently ends up without its agent label\n' +
        'is the exact state this job exists to prevent. Re-run the job once the cause\n' +
        '(permissions, rate limit, API outage) is cleared.',
    )
    process.exit(1)
  }
}
