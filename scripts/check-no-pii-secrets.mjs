#!/usr/bin/env node
/**
 * Regression gate: block re-introduction of operator PII scrubbed in
 * PR #1486 (fix(privacy): scrub operator PII from tracked tree).
 *
 * Why this script exists:
 *
 * The repo is public + canonical. A full audit found personal emails,
 * real Telegram chat IDs, and a real Tailscale host embedded across
 * source/tests/docs/CHANGELOG (115+ occurrences). They were replaced
 * with the repo's placeholder conventions. Nothing structurally stops
 * an agent from pasting a real address/ID back into a fixture — this
 * gate does, in the always-running `lint` sentinel (a required check),
 * so it cannot merge to `main`.
 *
 * The rule:
 *
 *   No tracked file may contain the scrubbed operator identifiers.
 *   The ONE sanctioned exception is the maintainer-contact email in
 *   the three plugin manifests (legitimate, intentional).
 *
 * Patterns are assembled at runtime from fragments so this file itself
 * never contains a contiguous PII literal (same discipline as the
 * token-fixture rule in CLAUDE.md → "Secrets in tests"), which keeps
 * the gate from flagging itself and avoids GitHub Push Protection.
 *
 * Run: `npm run lint:no-pii` (also part of `npm run lint`).
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// This script's own repo-relative path — never scan it (it documents
// the fragments it forbids).
const SELF = 'scripts/check-no-pii-secrets.mjs'

// NUL sentinel for the binary sniff, built without embedding a control
// byte in this source file.
const NUL = String.fromCharCode(0)

// The three plugin manifests legitimately carry the maintainer-contact
// email and are the ONLY place that email's domain is allowed.
const MAINTAINER_EMAIL_ALLOW = new Set([
  '.claude-plugin/marketplace.json',
  'docker/security-plugin/.claude-plugin/plugin.json',
  'telegram-plugin/.claude-plugin/plugin.json',
])

/**
 * Matcher for a known-real Telegram id, in EITHER form it appears in:
 * the bare internal id (`<the id>`) or the Bot API "marked" supergroup
 * form that prefixes it with `-100` (`-100<the id>`).
 *
 * The prefix alternative is load-bearing, and its absence was a real hole.
 * These rules used to be `\b<digits>\b`. In the marked form the character
 * immediately before the id is the `0` of `-100` — a word character — so
 * `\b` does NOT match there, and the marked form of an id this gate already
 * forbade sat in a tracked test file with lint green. `(?<!\d)` on the whole
 * literal (rather than on the digits alone) keeps the no-substring-hits
 * property while letting the `-100` prefix through.
 */
function realTelegramId(digits) {
  return new RegExp('(?<!\\d)(?:-?100)?' + digits + '(?!\\d)')
}

// Patterns assembled from fragments. `id` is for the message; `re` is
// the matcher; `allowIn` (optional) is a Set of repo-relative paths
// where this specific pattern is sanctioned.
const RULES = [
  { id: 'personal handle "pix' + 'soul"', re: new RegExp('pix' + 'soul', 'i') },
  {
    id: 'personal email domain ' + 'kenthompson' + '.com.au',
    re: new RegExp('kenthompson' + '\\.com\\.au', 'i'),
    allowIn: MAINTAINER_EMAIL_ALLOW,
  },
  { id: 'shorthand account token "me' + '@kt"', re: new RegExp('\\bme' + '@kt\\b', 'i') },
  {
    id: 'shorthand/real outlook account',
    re: new RegExp('ken' + '\\.thompson@outlook' + '|' + '\\bken' + '-outlook\\b', 'i'),
  },
  {
    id: 'bare outlook handle "ken' + '@outlook"',
    re: new RegExp('\\bken' + '@outlook\\b', 'i'),
  },
  {
    id: 'real personal account "lisa' + '_goodfellow"',
    re: new RegExp('\\blisa' + '_goodfellow\\b', 'i'),
  },
  { id: 'operator home path', re: new RegExp('/home/' + 'kenthompson') },
  { id: 'real Tailscale tailnet id', re: new RegExp('tail' + 'd78f7', 'i') },
  { id: 'real Telegram id (user)', re: realTelegramId('82487' + '03757') },
  { id: 'real Telegram id (alt)', re: realTelegramId('82881' + '44562') },
  { id: 'real Telegram id (group)', re: realTelegramId('38527' + '47971') },
  // Live Coolify service id for the LiteLLM proxy, scrubbed in #3527. It
  // identifies a real deployment (and the exact host path of the
  // operator-maintained proxy config). Docs use the `<litellm-service-id>`
  // placeholder; on-host code discovers the real path at runtime
  // (`discoverLiveLitellmConfigPath`) or takes `LITELLM_CONFIG_PATH`, so the
  // id itself never needs to appear in the tree. Without this rule nothing
  // stopped an agent pasting it back into a doc or a default and the scrub
  // would silently un-do itself — exactly the failure mode this gate exists
  // for.
  {
    id: 'live Coolify litellm service id (use <litellm-service-id>)',
    re: new RegExp('vhz4' + 'jc1tzvk6' + 'gdql8jue' + 'iwq4', 'i'),
  },
  // Any other long Coolify service-dir slug is deployment-identifying for the
  // same reason. The placeholder form `<litellm-service-id>` does not match
  // (angle brackets and hyphens are outside the char class), and neither does
  // the bare `COOLIFY_SERVICES_DIR` constant (no slug follows it).
  {
    id: 'deployment-identifying Coolify service dir (use <litellm-service-id>)',
    re: new RegExp('coolify/' + 'services/' + '[a-z0-9]{20,}'),
  },
  // Contiguous Anthropic-token-shaped literal. Real tokens were never
  // committed; this enforces the CLAUDE.md "Secrets in tests" rule —
  // token-shaped fixtures must be runtime-assembled, never a contiguous
  // source literal (also avoids GitHub Push Protection trips). The
  // {12,}-char body means bare `sk-ant-` prefixes, `.join()`-split
  // fragments, and regex char-classes do NOT match — only a real
  // glued token literal does.
  {
    id: 'contiguous Anthropic token literal (sk' + '-ant-…)',
    re: new RegExp('sk' + '-ant-' + '[A-Za-z0-9_-]{12,}'),
  },
]

// ---------------------------------------------------------------------------
// Structural rule: NO unsanctioned Telegram supergroup id, full stop.
// ---------------------------------------------------------------------------
//
// The literal RULES above are a denylist: they only stop an id someone has
// already noticed and scrubbed. That is one scrub behind reality — three more
// real supergroup ids reached `main` as fixtures and doc examples after the
// #1486 scrub, and the `\b` hole documented on `realTelegramId` meant one of
// them was an id this very gate already listed.
//
// So this rule inverts the polarity for the one identifier shape that is
// cheap to recognise: a Bot API "marked" supergroup id is `-100` followed by
// the internal chat id. Any such literal in the tree must have a body that is
// STRUCTURALLY synthetic — a shape a real, effectively-random Telegram id
// cannot have. Anything else is rejected on sight, whether or not anyone has
// audited it.
//
// The allowlist below is deliberately shapes, not values: a literal list of
// every example id in the tree would be ~20 entries and would grow by one
// every time someone pasted a real id and "fixed" the lint by appending it.
// A shape can only be satisfied by writing an obviously-fake number.

const TELEGRAM_MARKED_ID = /-100(\d{8,13})/g
// The `t.me/c/<internal-id>/…` deep-link form, which drops the `-100` prefix.
// Same identifier, different spelling; the same allowlist applies to the body.
const TELEGRAM_DEEP_LINK = /t\.me\/c\/(\d{3,13})/g

// Sanctioned shapes for the id BODY (the digits after `-100`, or the digits
// in a `t.me/c/` link). Each entry must justify why a real id cannot look
// like this. Keep this list short — every entry is a hole.
const SANCTIONED_ID_SHAPES = [
  {
    re: /^1234567890?$/,
    why: 'ascending run — the repo-canonical example id -1001234567890 (~150 uses)',
  },
  {
    re: /^9876543210?$/,
    why: 'descending run — the second canonical example id',
  },
  {
    re: /^(\d)\1+$/,
    why: 'one repeated digit (-1001111111111, -1009999999999, …) — the fixture family used when a test needs several visibly-distinct chats',
  },
  {
    re: /^\d0{6,}$/,
    why: 'one digit then all zeros (-1001000000000, -1002000000000) — round sentinels',
  },
  {
    re: /^90000000\d{2}$/,
    why: 'the reserved -10090000000NN block (status-pin / worker-feed suites) — a numbered family for tests needing many distinct chats',
  },
  {
    re: /^9900112233$/,
    why: 'repeated-pair fixture (-1009900112233) in the supergroup docs/tests',
  },
]

// Escape hatch for a real id that is mid-removal in another in-flight PR, so
// this guard can land before that PR merges. DELIBERATELY EMPTY, and it must
// stay that way: a real id must NEVER be parked here to make lint pass —
// scrub it instead. If you add one, name the PR that removes it and delete the
// entry the day that PR merges. (It held one entry, for #4711, which merged
// before this landed.)
const GRANDFATHERED_REAL_IDS = new Map([])

function isSanctionedIdBody(body) {
  return SANCTIONED_ID_SHAPES.some((s) => s.re.test(body))
}

/** Fail-closed self-check: a rule whose config went empty is a no-op. */
function assertRuleIsLive() {
  if (!Array.isArray(RULES) || RULES.length === 0) {
    throw new Error('RULES is empty — the PII denylist would pass everything')
  }
  if (!Array.isArray(SANCTIONED_ID_SHAPES) || SANCTIONED_ID_SHAPES.length === 0) {
    throw new Error('SANCTIONED_ID_SHAPES is empty — no example id could ever pass')
  }
  for (const s of SANCTIONED_ID_SHAPES) {
    if (!(s.re instanceof RegExp) || typeof s.why !== 'string' || s.why.trim() === '') {
      throw new Error(`SANCTIONED_ID_SHAPES entry missing a regex or a justification: ${JSON.stringify(s)}`)
    }
    // A shape that admits an arbitrary body is a vacuous allowlist.
    if (s.re.test('4223' + '464247') || s.re.test('3852' + '747971')) {
      throw new Error(`SANCTIONED_ID_SHAPES entry ${s.re} matches a real-shaped id — too broad`)
    }
  }
}

const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|webp|pdf|bin|woff2?|ttf|eot|zip|gz|tgz|tar|mp4|mov|sqlite|wasm)$/i

function listTrackedFiles() {
  const out = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf-8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function scanIdsInLine(line, lineNo, relPath, offenders) {
  for (const [re, label] of [
    [TELEGRAM_MARKED_ID, 'unsanctioned Telegram supergroup id'],
    [TELEGRAM_DEEP_LINK, 'unsanctioned Telegram chat id in a t.me/c/ link'],
  ]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(line)) !== null) {
      const body = m[1]
      if (isSanctionedIdBody(body)) continue
      if (GRANDFATHERED_REAL_IDS.has(body)) continue
      offenders.push({ file: relPath, line: lineNo, rule: `${label} \`${m[0]}\`` })
    }
  }
}

// Everything below runs inside a try: any throw — a bad regex, an unreadable
// tree, a git failure — must exit NON-ZERO. A guard that crashes into a
// green build is worse than no guard (this repo has shipped that bug twice).
let offenders = []
let scanned = 0
try {
  assertRuleIsLive()

  const tracked = listTrackedFiles()
  if (tracked.length === 0) {
    throw new Error('git ls-files returned no files — refusing to report clean on an empty scan')
  }

  const unreadable = []
  for (const relPath of tracked) {
    if (relPath === SELF) continue
    if (BINARY_EXT.test(relPath)) continue
    let src
    try {
      src = readFileSync(resolve(repoRoot, relPath), 'utf-8')
    } catch (err) {
      // Previously a silent `continue`: an unreadable file was scanned as if
      // clean. Collect and fail instead.
      unreadable.push(`${relPath}: ${err.message}`)
      continue
    }
    if (src.indexOf(NUL) !== -1) continue // binary sniff
    scanned++
    const lines = src.split('\n')
    for (const rule of RULES) {
      if (rule.allowIn && rule.allowIn.has(relPath)) continue
      for (let i = 0; i < lines.length; i++) {
        if (rule.re.test(lines[i])) {
          offenders.push({ file: relPath, line: i + 1, rule: rule.id })
        }
      }
    }
    for (let i = 0; i < lines.length; i++) {
      scanIdsInLine(lines[i], i + 1, relPath, offenders)
    }
  }

  if (unreadable.length > 0) {
    throw new Error(
      `${unreadable.length} tracked file(s) could not be read, so the scan is incomplete:\n  ${unreadable.join('\n  ')}`,
    )
  }
  if (scanned === 0) {
    throw new Error('0 text files scanned — the guard degraded to a no-op')
  }
} catch (err) {
  console.error(`check-no-pii-secrets: FAILED CLOSED — ${err.message}`)
  process.exit(1)
}

if (offenders.length > 0) {
  console.error(
    'check-no-pii-secrets: scrubbed operator PII re-introduced (see PR #1486). Remove it / use the placeholder conventions (you@example.com, alice@/bob@example.com, synthetic 12345 / -1001234567890, example-host.tailnet.ts.net, ~ for home paths):\n',
  )
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  — ${o.rule}`)
  }
  console.error(
    '\nIf a hit is a legitimate maintainer-contact manifest, add it to MAINTAINER_EMAIL_ALLOW in scripts/check-no-pii-secrets.mjs (do NOT broaden the patterns).',
  )
  console.error(
    'If a hit is an "unsanctioned Telegram ... id": that number must not be in a public repo.\n' +
      'Replace it with a sanctioned example id — one of these shapes:\n' +
      SANCTIONED_ID_SHAPES.map((s) => `  ${s.re.source}  — ${s.why}`).join('\n') +
      '\ne.g. -1001234567890, or -100<one digit repeated ten times> when a test needs several\n' +
      'distinguishable chats. Do NOT add a real id to SANCTIONED_ID_SHAPES or\n' +
      'GRANDFATHERED_REAL_IDS to make this pass; add a shape only if you are introducing a\n' +
      'genuinely new SYNTHETIC family, with a comment saying why a real id cannot match it.',
  )
  process.exit(1)
}

console.log(`check-no-pii-secrets: clean (${scanned} tracked text files scanned)`)
