#!/usr/bin/env node
/**
 * PreToolUse hook — emits a deterministic human label per tool call.
 *
 * Claude Code PreToolUse protocol (v1):
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, tool_use_id, cwd, ... }
 *   Output: exit 0 + empty stdout → allow. We NEVER emit JSON to stdout
 *           (would risk hookSpecificOutput.updatedInput collisions). We
 *           NEVER exit non-zero (exit 2 BLOCKS the tool call).
 *
 * Side effect: appends one JSON line to
 *   $TELEGRAM_STATE_DIR/tool-labels-${session_id}.jsonl
 * with shape { ts, tool_use_id, agent_id, label, tool_name }.
 *
 * If $TELEGRAM_STATE_DIR is unset → silent skip (renderer just falls back
 * to its existing precedence ladder). If session_id or tool_use_id is
 * missing → skip (the row could never be joined anyway). If the rule
 * table doesn't produce a label for the tool → skip.
 *
 * Tools intentionally NOT labeled here (handled by existing description
 * / TodoWrite / sub-agent panels in the renderer):
 *   Bash, Task, Agent, TodoWrite
 *
 * Issue #783.
 */

import { readFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Coerce a tool-input field to display text WITHOUT the `[object Object]`
 * trap. Only primitives carry a meaningful label: strings pass through,
 * numbers/booleans stringify cleanly. Objects and arrays return '' so the
 * caller falls through to its next fallback (a sibling field, or the
 * humanized tool name) instead of surfacing literal "[object Object]".
 *
 * This guards the MCP-tool path in particular: an operator-configured
 * server (e.g. Brevo CRM) may pass a filter/query OBJECT in `query` /
 * `description` / `title`, and the old `String(i.query ?? '')` coercion
 * rendered that as "[object Object]" on the live activity feed. The
 * renderer's own `clip()` already rejects non-strings; this mirrors that
 * contract at the hook so the bad value never reaches the sidecar JSONL.
 */
function asText(v) {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/**
 * One-line, length-bounded escape of a value for inclusion in a label.
 * Newlines collapsed, very long strings truncated with an ellipsis.
 */
function clip(s, max = 80) {
  if (s == null) return ''
  let v = String(s).replace(/\s+/g, ' ').trim()
  if (v.length > max) v = v.slice(0, max - 1) + '…'
  return v
}

function safeBasename(p) {
  if (!p || typeof p !== 'string') return ''
  try {
    const b = basename(p)
    return b || p
  } catch {
    return p
  }
}

function urlHostPath(u) {
  if (!u || typeof u !== 'string') return ''
  try {
    const x = new URL(u)
    return x.host + (x.pathname && x.pathname !== '/' ? x.pathname : '')
  } catch {
    return u
  }
}

/**
 * Compute a label for a (toolName, input) pair. Returns null when the
 * tool should NOT be labeled (suppress / fall through to existing
 * renderer precedence).
 */
export function computeLabel(toolName, input) {
  const i = input ?? {}

  // Bash / Task / ToolSearch / TodoWrite: previously emitted nothing
  // (deferred to the session-JSONL description path). The draft-mirror
  // now drives off THIS sidecar in real time (flush-independent), so we
  // must label them here too — otherwise the most common tool (Bash)
  // never reaches the live draft. Uses the model-authored `description`
  // for Bash/Task, matching the gateway's describeToolUse rendering.
  switch (toolName) {
    case 'Bash':
      return clip(asText(i.description), 70).trim() || 'Running a command'
    case 'Task':
    case 'Agent': {
      const d = clip(asText(i.description), 60).trim()
      return d ? `Delegating: ${d}` : 'Delegating to a sub-agent'
    }
    case 'TodoWrite':
      return 'Updating the plan'
    case 'ToolSearch':
      return 'Finding the right tool'
  }

  // Built-in rule table.
  switch (toolName) {
    case 'Read':
      return `Reading ${clip(safeBasename(i.file_path))}`.trim()
    case 'Edit':
      return `Editing ${clip(safeBasename(i.file_path))}`.trim()
    case 'Write':
      return `Writing ${clip(safeBasename(i.file_path))}`.trim()
    case 'Grep': {
      const path = i.path ? clip(asText(i.path), 40) : '.'
      const pat = clip(asText(i.pattern), 40)
      return `Searching ${path} for ${pat}`
    }
    case 'Glob':
      return `Finding files matching ${clip(asText(i.pattern), 60)}`
    case 'WebFetch':
      return `Fetching ${clip(urlHostPath(i.url), 60)}`
    case 'WebSearch':
      return `Searching the web for ${clip(asText(i.query), 60)}`
    case 'NotebookEdit':
      return `Editing notebook ${clip(safeBasename(i.notebook_path))}`
    case 'BashOutput':
      return 'Reading background output'
    case 'KillBash':
    case 'KillShell':
      return 'Stopping background process'
    case 'Skill': {
      // The Skill tool's input is `{ skill: "<slug>", args?: "..." }`.
      // We emit `Running skill <slug>` so downstream observers
      // (notably the skill-coverage UAT runner at
      // telegram-plugin/uat/runners/skill-coverage.ts) can tail the
      // sidecar JSONL and recover which skill fired per turn —
      // the progress card path that used to surface this was retired
      // when `progressDriver` was nulled out in #1122 PR3.
      const slug = clip(asText(i.skill), 64)
      // Empty-slug Skill stays suppressed (degenerate/malformed call): the
      // liveness feed-open backstops visibility for a tool-less turn, so this
      // does not need a label. Keeps the #2111 sidecar contract.
      return slug ? `Running skill ${slug}` : null
    }
  }

  // MCP tools.
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
    // Explicit labels / suppressions for the built-in servers.
    switch (toolName) {
      case 'mcp__switchroom-telegram__reply':
      case 'mcp__switchroom-telegram__stream_reply':
        return 'Replying'
      case 'mcp__switchroom-telegram__react': {
        const emoji = clip(asText(i.emoji), 8)
        return emoji ? `Reacting ${emoji}` : 'Reacting'
      }
      case 'mcp__switchroom-telegram__get_recent_messages':
        return 'Reading chat history'
      case 'mcp__hindsight__recall':
      case 'mcp__hindsight__reflect':
        return 'Searching memory'
      case 'mcp__hindsight__retain':
        return 'Saving memory'
      // Explicit suppressions — return null so we don't emit a sidecar line.
      case 'mcp__switchroom-telegram__send_typing':
      case 'mcp__hindsight__sync_retain':
        return null
    }
    // Generic fallback for ANY other MCP tool (operator-configured servers
    // — perplexity, webkite, gdrive, notion, …). These previously returned
    // null → invisible in the live activity feed, so a research turn driven
    // entirely by MCP tools read as pure silence (only a typing dot + the
    // 👀 reaction) — the "I can't see what it's doing" report. Mirror the
    // gateway's describeToolUse: friendly per-server labels, else a
    // model-authored field, else a humanized tool name. NEVER label
    // switchroom-telegram surface/control tools (they ARE the conversation).
    const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
    if (!m) return null
    const server = m[1].toLowerCase()
    const tool = m[2].toLowerCase()
    if (server === 'switchroom-telegram') return null
    if (server === 'hindsight') return 'Working with memory'
    if (server === 'google-workspace' || server === 'claude_ai_google_calendar')
      return 'Checking your calendar'
    if (server === 'claude_ai_gmail') return 'Checking your email'
    if (server === 'claude_ai_google_drive' || server === 'gdrive')
      return 'Looking through your files'
    if (server === 'notion' || server === 'claude_ai_notion') return 'Checking your notes'
    if (server === 'perplexity') {
      const q = clip(asText(i.query) || asText(i.description), 60).trim()
      return q ? `Searching the web for ${q}` : 'Searching the web'
    }
    if (server === 'webkite') {
      const u = clip(urlHostPath(i.url ?? ''), 60).trim()
      return u ? `Reading ${u}` : 'Reading the web'
    }
    // Unknown MCP server: prefer a model-authored field, else humanized tool.
    const desc =
      clip(asText(i.description), 60).trim() ||
      clip(asText(i.query), 50).trim() ||
      clip(asText(i.title), 50).trim()
    if (desc) return desc
    return `Using ${tool.replace(/[-_]+/g, ' ')}`
  }

  // Never-null fallthrough: any unrecognized BUILT-IN tool (no mcp__ prefix,
  // not matched above) gets a generic label rather than dropping its sidecar
  // line. A null here was the dark-turn mechanism — if such a tool was a
  // turn's first/only tool, no tool_label event fired, the activity feed
  // never opened, and a working turn read as pure silence. Surface tools
  // (reply/react/send_typing/sync_retain) return earlier and are also
  // suppressed at the gateway's isTelegramSurfaceTool guard, so this does
  // not resurface them.
  return 'Working…'
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

  const stateDir = process.env.TELEGRAM_STATE_DIR
  if (!stateDir || stateDir.length === 0) process.exit(0)

  const sessionId = event.session_id
  const toolUseId = event.tool_use_id
  const toolName = event.tool_name
  if (!sessionId || !toolUseId || !toolName) process.exit(0)

  let label
  try {
    label = computeLabel(toolName, event.tool_input)
  } catch {
    process.exit(0)
  }
  if (!label) process.exit(0)

  // agent_id: Claude Code does not pass sub-agent agent_id directly to
  // the hook; fall back to SWITCHROOM_AGENT_NAME or the cwd basename.
  const agentId =
    process.env.SWITCHROOM_AGENT_NAME ??
    (event.cwd ? safeBasename(event.cwd) : null) ??
    null

  const line = JSON.stringify({
    ts: Date.now(),
    tool_use_id: toolUseId,
    agent_id: agentId,
    label,
    tool_name: toolName,
  }) + '\n'

  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true })
    }
    const target = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    appendFileSync(target, line)
  } catch (err) {
    // Never block. Surface to stderr (captured by plugin-logger).
    try {
      process.stderr.write(
        `[tool-label-pretool] write failed: ${err?.message ?? err}\n`,
      )
    } catch { /* ignore */ }
  }

  process.exit(0)
}

// Skip main() when imported (for unit tests of computeLabel).
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ?? ''
    return argv1.endsWith('tool-label-pretool.mjs')
  } catch {
    return false
  }
})()
if (isMain) main()
