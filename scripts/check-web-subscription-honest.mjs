#!/usr/bin/env node
/**
 * Regression gate: keep `src/web/**` (the dashboard) subscription-honest.
 *
 * Why this script exists:
 *
 * Switchroom's core compliance pillar (CLAUDE.md → "Claude-native,
 * subscription-funded") forbids ANY path that calls a model off the
 * operator's Pro/Max subscription: no Anthropic SDK, no raw Anthropic
 * API, no `ANTHROPIC_API_KEY`, no `claude -p` / `claude --print` spawn.
 * The web dashboard is a read-only / trigger-only surface — its memory
 * remediation handlers POKE hindsight (which runs the model on its own
 * provider), the web itself makes ZERO model calls. Nothing structural
 * stops a future change from importing `@anthropic-ai/sdk` or POSTing
 * `api.anthropic.com/v1/messages` straight from the dashboard. This gate
 * does, in the always-running `lint` sentinel (a required check), so such
 * a change cannot merge to `main`.
 *
 * Scope: every `src/web/**` non-test `.ts` file PLUS the inline `<script>`
 * block in `src/web/ui/index.html` (the dashboard SPA). `*.test.ts` files
 * are excluded — they legitimately NAME the ban in assertion descriptions
 * (e.g. `it('… no claude -p spawn', …)`); the gate exists to keep the
 * dashboard *implementation* honest, and the bridge-flap guard already
 * polices `claude -p` spawns across all of `src/`.
 *
 * The rule (any hit fails the build):
 *   - an import of the Anthropic SDK (`@anthropic-ai/…`, `from "anthropic"`),
 *   - a raw Anthropic API call (`api.anthropic.com`, `/v1/messages`,
 *     `ANTHROPIC_API_KEY`),
 *   - a headless `claude -p` / `claude --print` spawn (string or argv).
 *
 * Comment lines that merely DESCRIBE the ban are allowed: the matcher
 * strips `//` and `*` comment lines before scanning, so prose like this
 * header (which names every forbidden token) does NOT trip the gate. The
 * patterns are also assembled from fragments so this file never contains a
 * contiguous forbidden literal (same discipline as the token-fixture rule
 * in CLAUDE.md → "Secrets in tests"), keeping the gate from flagging
 * itself.
 *
 * Run: `npm run lint:web-subscription-honest` (also part of `npm run lint`).
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// This script's own repo-relative path — never scan it (it documents the
// fragments it forbids). It also lives under scripts/, not src/web/, so it
// wouldn't be scanned anyway; the explicit skip is defence in depth.
const SELF = 'scripts/check-web-subscription-honest.mjs'

// Patterns assembled from fragments. `id` is for the message; `re` is the
// matcher. Each is built so this source never embeds a contiguous literal.
const RULES = [
  {
    id: 'Anthropic SDK import (@anthropic' + '-ai/… or from "anthropic")',
    re: new RegExp(
      "@anthropic" + "-ai/" + "|" +
        "from\\s+['\"]anthropic['\"]" + "|" +
        "require\\(\\s*['\"]anthropic['\"]",
    ),
  },
  {
    id: 'raw Anthropic API host (api.' + 'anthropic.com)',
    re: new RegExp("api\\." + "anthropic" + "\\.com"),
  },
  {
    // Match the messages endpoint as a path literal, not the words in prose.
    id: 'raw Anthropic messages endpoint (/v1/' + 'messages)',
    re: new RegExp("/v1/" + "messages"),
  },
  {
    id: 'ANTHROPIC' + '_API_KEY usage',
    re: new RegExp("ANTHROPIC" + "_API_KEY"),
  },
  {
    // `claude -p` or `claude --print` as a spawn/string — claude as a word,
    // then the headless flag.
    id: 'headless claude spawn (claude ' + '-p / --print)',
    re: new RegExp("\\bclaude\\s+(?:-p\\b|--print\\b)"),
  },
]

/**
 * Map each source line to a code-or-comment classification, preserving the
 * ORIGINAL 1-based line numbers (so offender reports point at the real file
 * line). A line is treated as comment iff it is a whole-line `//` comment,
 * a `/* … *\/` block line (first non-space char `*`, or a `/*`-opening /
 * `*\/`-closing line). Pragmatic, not a full tokenizer: it removes the
 * comment PROSE that legitimately names the forbidden tokens (like this
 * file's own header) so the gate doesn't flag descriptions, while still
 * catching real code on its own line. A forbidden token glued onto a line
 * that ALSO has code is NOT a comment line — so it can't be hidden behind a
 * trailing `// comment`. Returns `[{ n, text }]` for the CODE lines only.
 */
function codeLines(src) {
  const out = []
  let inBlock = false
  const all = src.split('\n')
  for (let i = 0; i < all.length; i++) {
    const line = all[i]
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      continue
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    out.push({ n: i + 1, text: line })
  }
  return out
}

function listWebTsFiles() {
  const out = execSync('git ls-files src/web', { cwd: repoRoot, encoding: 'utf-8' })
  return out
    .split('\n')
    .map((l) => l.trim())
    // Implementation only — test files legitimately name the ban in their
    // assertion descriptions, and the bridge-flap guard polices spawns.
    .filter((l) => l.endsWith('.ts') && !l.endsWith('.test.ts'))
}

/**
 * Extract the inline <script> bodies from src/web/ui/index.html so the
 * dashboard SPA is scanned with the same rules as the .ts files.
 */
function extractHtmlScripts(relPath) {
  let html
  try {
    html = readFileSync(resolve(repoRoot, relPath), 'utf-8')
  } catch {
    return []
  }
  const scripts = []
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) scripts.push(m[1])
  return scripts
}

const targets = []
for (const rel of listWebTsFiles()) {
  if (rel === SELF) continue
  let src
  try {
    src = readFileSync(resolve(repoRoot, rel), 'utf-8')
  } catch {
    continue
  }
  targets.push({ rel, src })
}
const HTML = 'src/web/ui/index.html'
for (const body of extractHtmlScripts(HTML)) {
  targets.push({ rel: `${HTML} (inline <script>)`, src: body })
}

const offenders = []
for (const { rel, src } of targets) {
  for (const { n, text } of codeLines(src)) {
    for (const rule of RULES) {
      if (rule.re.test(text)) {
        offenders.push({ file: rel, line: n, rule: rule.id })
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(
    'check-web-subscription-honest: the dashboard (src/web/**) must make ZERO model calls ' +
      '(CLAUDE.md → "Claude-native, subscription-funded"). A forbidden Anthropic SDK import, ' +
      'raw Anthropic API call, or headless `claude -p`/`--print` spawn was found:\n',
  )
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  — ${o.rule}`)
  }
  console.error(
    '\nThe web is read-only / trigger-only: POKE hindsight (which runs the model on its own ' +
      'provider) or inject a turn into the live claude session instead. Never call a model from src/web/.',
  )
  process.exit(1)
}

console.log(
  `check-web-subscription-honest: clean (${targets.length} dashboard sources scanned)`,
)
