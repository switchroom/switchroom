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
  { id: 'real Telegram id (user)', re: new RegExp('\\b' + '82487' + '03757\\b') },
  { id: 'real Telegram id (alt)', re: new RegExp('\\b' + '82881' + '44562\\b') },
  { id: 'real Telegram id (group)', re: new RegExp('\\b' + '38527' + '47971\\b') },
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

const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|webp|pdf|bin|woff2?|ttf|eot|zip|gz|tgz|tar|mp4|mov|sqlite|wasm)$/i

function listTrackedFiles() {
  const out = execSync('git ls-files', { cwd: repoRoot, encoding: 'utf-8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const offenders = []
for (const relPath of listTrackedFiles()) {
  if (relPath === SELF) continue
  if (BINARY_EXT.test(relPath)) continue
  let src
  try {
    src = readFileSync(resolve(repoRoot, relPath), 'utf-8')
  } catch {
    continue
  }
  if (src.indexOf(NUL) !== -1) continue // binary sniff
  const lines = src.split('\n')
  for (const rule of RULES) {
    if (rule.allowIn && rule.allowIn.has(relPath)) continue
    for (let i = 0; i < lines.length; i++) {
      if (rule.re.test(lines[i])) {
        offenders.push({ file: relPath, line: i + 1, rule: rule.id })
      }
    }
  }
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
  process.exit(1)
}

console.log(
  `check-no-pii-secrets: clean (${listTrackedFiles().length} tracked files scanned)`,
)
