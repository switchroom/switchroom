#!/usr/bin/env node
/**
 * PreToolUse hook — drops a `reply` / `stream_reply` call whose entire
 * payload is only the silent sentinel(s) NO_REPLY / HEARTBEAT_OK.
 *
 * Defense-in-depth for #2053. The silent-end Stop hook and the gateway
 * flush gate already recognise prose+trailing-NO_REPLY as "intentionally
 * silent", but if a nag-loop (or any other path) ever pushes a
 * sentinel-only payload through the reply tool, it must NEVER reach the
 * Telegram chat. This guard is the last line: it intercepts the tool
 * call itself, before the gateway sees it.
 *
 * Match discipline — EXACT, not substring:
 *   - The trimmed payload must be ONLY one or more silent markers
 *     (each on its own line, optional trailing punctuation per marker).
 *   - A real reply that happens to mention "NO_REPLY" inside genuine
 *     prose (e.g. "reply with exactly NO_REPLY if nothing to add") is
 *     NOT dropped — it has non-marker content, so it is delivered.
 *
 * Claude Code PreToolUse protocol (v1):
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON stdout { decision: "block", reason } → block.
 *
 * Fail-open on any parse/IO error — a malfunctioning guard must not wedge
 * the reply path.
 */

import { readFileSync } from 'node:fs'
import { argv } from 'node:process'
import { fileURLToPath } from 'node:url'

const REPLY_TOOLS = new Set([
  'mcp__switchroom-telegram__reply',
  'mcp__switchroom-telegram__stream_reply',
])

// Mirrors turn-flush-safety.ts:isSilentFlushMarker and
// silent-end-scan.mjs:SILENT_MARKER_RE — a single bare marker with
// optional trailing punctuation.
const SILENT_MARKER_RE = /^(NO_REPLY|HEARTBEAT_OK)[\s.!?]*$/i

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * True when `text` is composed ENTIRELY of silent markers — every
 * non-empty line is a bare NO_REPLY / HEARTBEAT_OK — with at least one
 * such line. Exact-match per line, never a substring of prose.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSentinelOnly(text) {
  if (typeof text !== 'string') return false
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return false
  return lines.every((l) => SILENT_MARKER_RE.test(l))
}

function main() {
  const raw = readStdin().trim()
  if (!raw) process.exit(0)

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const toolName = event?.tool_name
  if (!REPLY_TOOLS.has(toolName)) process.exit(0)

  const text = event?.tool_input?.text
  if (typeof text !== 'string') process.exit(0)

  if (isSentinelOnly(text)) {
    process.stderr.write(
      '[sentinel-reply-guard] dropped sentinel-only reply payload (#2053) — ' +
        'NO_REPLY/HEARTBEAT_OK must never reach chat\n',
    )
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason:
          'This reply payload is only the silent sentinel (NO_REPLY / ' +
          'HEARTBEAT_OK). That sentinel signals "send nothing" — it must not ' +
          'be delivered to the user as a message. The turn is already ' +
          'treated as intentionally silent; do not call the reply tool with ' +
          'it. End your turn.',
      }),
    )
    process.exit(0)
  }

  process.exit(0)
}

// Only run the stdin-reading entrypoint when invoked directly as the hook
// script. When imported (e.g. by the unit test exercising `isSentinelOnly`)
// the top-level `readFileSync(0)` would otherwise block on the importer's
// stdin and hang the process.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
}
