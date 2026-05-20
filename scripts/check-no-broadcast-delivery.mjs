#!/usr/bin/env node
/**
 * Check `telegram-plugin/**.ts` for `ipcServer.broadcast(...)` calls that
 * lack an `// allow-broadcast: <reason>` marker on the immediately
 * preceding line.
 *
 * Why this script exists:
 *
 * Eight PRs in 36h (#1536, #1537, #1539, #1541, #1545, #1546, #1549, #1555,
 * #1558, #1564) bolted onto the gateway inbound-delivery surface to fix
 * "agents stop replying" wedges. The root class of bug: `ipcServer.broadcast(...)`
 * is fire-and-forget — if the bridge is mid-reconnect or absent, the
 * message is silently dropped. The cluster eliminated broadcast for every
 * delivery-bearing callsite (inbound, button-tap, permission verdict),
 * routing them through `ipcServer.sendToAgent()` with `pendingInboundBuffer`
 * / `pendingPermissionBuffer` / `inbound-spool` fallback. Two broadcasts
 * remain by design — both informational (checklist task notify, shutdown
 * status).
 *
 * The rule:
 *
 *   Every `ipcServer.broadcast(` call in `telegram-plugin/**.ts` (excluding
 *   `*.test.ts`) must have a marker `// allow-broadcast: <reason>` on the
 *   IMMEDIATELY preceding line. New delivery-bearing broadcasts will fail
 *   this lint, forcing the author to either (a) migrate to `sendToAgent`
 *   or (b) explicitly justify why this broadcast is safe to fire-and-forget.
 *
 * The check ignores matches inside `//` line comments and `/* ... *\/` block
 * comments (so doc-comments mentioning `ipcServer.broadcast` don't trip the
 * lint).
 *
 * Run: `npm run lint:no-broadcast-delivery` (also part of `npm run lint`).
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const TARGET = 'ipcServer.broadcast('
const MARKER_RE = /\/\/\s*allow-broadcast:\s*\S/

function listTelegramPluginFiles() {
  const out = execSync(
    `git ls-files 'telegram-plugin/*.ts' 'telegram-plugin/**/*.ts'`,
    { cwd: repoRoot, encoding: 'utf-8' },
  )
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.endsWith('.test.ts'))
    .filter((line) => !line.endsWith('.d.ts'))
}

// Walk the source character by character to find `ipcServer.broadcast(`
// matches that are NOT inside comments or string literals. Returns an
// array of { line, col } for each real match.
function findRealBroadcastCalls(src) {
  const matches = []
  let i = 0
  let line = 1
  let col = 1
  let inLineComment = false
  let inBlockComment = false
  let inString = null // "'" | '"' | '`' | null

  while (i < src.length) {
    const c = src[i]
    const c2 = src.slice(i, i + 2)

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false
        line++
        col = 1
        i++
        continue
      }
      i++
      col++
      continue
    }

    if (inBlockComment) {
      if (c2 === '*/') {
        inBlockComment = false
        i += 2
        col += 2
        continue
      }
      if (c === '\n') {
        line++
        col = 1
      } else {
        col++
      }
      i++
      continue
    }

    if (inString) {
      if (c === '\\') {
        // Skip the next char (escape sequence).
        i += 2
        col += 2
        continue
      }
      if (c === inString) {
        inString = null
      }
      if (c === '\n') {
        line++
        col = 1
      } else {
        col++
      }
      i++
      continue
    }

    // Not in any comment or string.
    if (c2 === '//') {
      inLineComment = true
      i += 2
      col += 2
      continue
    }
    if (c2 === '/*') {
      inBlockComment = true
      i += 2
      col += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c
      i++
      col++
      continue
    }
    if (c === '\n') {
      line++
      col = 1
      i++
      continue
    }

    if (src.startsWith(TARGET, i)) {
      matches.push({ line, col })
      i += TARGET.length
      col += TARGET.length
      continue
    }

    i++
    col++
  }
  return matches
}

const files = listTelegramPluginFiles()
const offenders = []

for (const relPath of files) {
  let src
  try {
    src = readFileSync(resolve(repoRoot, relPath), 'utf-8')
  } catch {
    continue
  }
  if (!src.includes(TARGET)) continue
  const matches = findRealBroadcastCalls(src)
  if (matches.length === 0) continue
  const lines = src.split('\n')
  for (const m of matches) {
    const prevLine = lines[m.line - 2] ?? ''
    if (!MARKER_RE.test(prevLine)) {
      offenders.push({ file: relPath, line: m.line, lineText: lines[m.line - 1] ?? '' })
    }
  }
}

if (offenders.length > 0) {
  console.error(
    'check-no-broadcast-delivery: the following `ipcServer.broadcast(...)` calls lack a marker:\n',
  )
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  ${o.lineText.trim()}`)
  }
  console.error(
    '\nFor each call, either:\n' +
      '  (a) migrate to `ipcServer.sendToAgent(agentName, msg)` with `pendingInboundBuffer.push()` fallback (the proven pattern from PRs #1537/#1539/#1546 — see telegram-plugin/gateway/pending-inbound-buffer.ts and pending-permission-decisions.ts); OR\n' +
      '  (b) add `// allow-broadcast: <reason>` on the line IMMEDIATELY preceding the call, explaining why this broadcast is safe to fire-and-forget (informational, terminal, etc.).\n',
  )
  console.error(
    'See scripts/check-no-broadcast-delivery.mjs for the rationale (the gateway wedge cluster of 2026-05-19).',
  )
  process.exit(1)
}

console.log(
  `check-no-broadcast-delivery: clean (${files.length} files scanned)`,
)
