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

/** Hostname only, `www.` stripped — the WebFetch label form ("Reading example.com"). */
function urlHost(u) {
  if (!u || typeof u !== 'string') return ''
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u
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
 * ALLOWLIST-style summary of a Bash command, for when the model omitted the
 * optional `description`.
 *
 * The failure this closes: `description` is optional, so a sub-agent that never
 * writes one produced the constant label "Running a command" for EVERY Bash
 * call. The worker feed's narrative dedup then dropped every repeat and the
 * card froze on one line for the whole job — the user could not tell a running
 * worker from a wedged one. The card must never depend on a model volunteering
 * an optional field.
 *
 * SECURITY: a command line routinely carries tokens, passwords, URLs with
 * credentials, and private paths, and this string is rendered into a Telegram
 * message. So this is NOT a clip of the command — nothing is echoed unless it
 * passes a strict allowlist:
 *   - only the PROGRAM name (basename, no directory), and
 *   - for a known multiplexer (git/docker/npm/…), at most one bare subcommand
 *     of pure lowercase letters/hyphens.
 * Anything with a slash, `=`, digit-mixed shape, quote, or any other character
 * is refused and we fall back to the generic label. Arguments, flag VALUES,
 * env assignments, redirections and heredocs are never considered at all.
 *
 * Returns '' when nothing safe can be derived (caller uses the generic label).
 */
export function summariseBashCommand(cmd) {
  if (typeof cmd !== 'string') return ''
  // First line only — a heredoc/multiline body must never be inspected.
  const firstLine = cmd.split('\n', 1)[0]
  if (!firstLine) return ''

  // Split on shell separators and prefer the first segment that actually runs
  // something (`cd /x && git status` should read as "git status", not "cd").
  const NAV = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'unset'])
  const PREFIXES = new Set(['sudo', 'env', 'nohup', 'time', 'exec', 'command', 'doas', 'runuser', 'nice', 'xargs'])
  const segments = firstLine.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return ''

  const PROGRAM_RE = /^[A-Za-z][A-Za-z0-9._+-]{0,19}$/
  const SUBCOMMAND_RE = /^[a-z][a-z-]{1,15}$/
  const MULTIPLEXERS = new Set([
    'git', 'docker', 'npm', 'npx', 'bun', 'yarn', 'pnpm', 'cargo', 'go', 'gh',
    'kubectl', 'systemctl', 'apt', 'apt-get', 'brew', 'pip', 'pip3', 'poetry',
    'uv', 'terraform', 'aws', 'gcloud', 'helm', 'switchroom', 'make', 'openssl',
  ])

  /** Program + optional subcommand for one segment, or null. */
  function fromSegment(seg) {
    let tokens = seg.split(/\s+/).filter(Boolean)
    // Drop leading env assignments (FOO=bar) and wrapper prefixes.
    while (tokens.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || PREFIXES.has(tokens[0]))) {
      tokens = tokens.slice(1)
    }
    if (tokens.length === 0) return null
    // Basename only: never surface a directory (paths leak layout, usernames).
    const head = safeBasename(tokens[0])
    if (!PROGRAM_RE.test(head)) return null
    if (NAV.has(head)) return { program: head, nav: true }
    if (!MULTIPLEXERS.has(head)) return { program: head, nav: false }
    for (const t of tokens.slice(1)) {
      if (t.startsWith('-')) continue
      return SUBCOMMAND_RE.test(t) ? { program: `${head} ${t}`, nav: false } : { program: head, nav: false }
    }
    return { program: head, nav: false }
  }

  let firstAny = null
  for (const seg of segments) {
    const r = fromSegment(seg)
    if (r == null) continue
    if (firstAny == null) firstAny = r
    if (!r.nav) return r.program
  }
  return firstAny != null ? firstAny.program : ''
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
    case 'Bash': {
      const described = clip(asText(i.description), 70).trim()
      if (described) return described
      // No model-authored description — derive a sanitised one from the
      // command itself rather than emitting the constant "Running a command"
      // that freezes the step feed. See summariseBashCommand.
      const derived = summariseBashCommand(asText(i.command))
      return derived ? `Running ${derived}` : 'Running a command'
    }
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
  //
  // THE single status vocabulary. This function is the ONE composer for the
  // per-tool activity wording on EVERY surface: the real-time sidecar drives
  // the live feed from here, and the gateway/watcher flush paths delegate via
  // `describeToolUse` (tool-activity-summary.ts). Do NOT fork a second
  // wording table — status-vocabulary-unification.test.ts pins the
  // delegation, so drift fails CI.
  switch (toolName) {
    case 'Read': {
      const f = clip(safeBasename(i.file_path))
      return f ? `Reading ${f}` : 'Reading a file'
    }
    case 'Edit':
    case 'MultiEdit': {
      const f = clip(safeBasename(i.file_path))
      return f ? `Editing ${f}` : 'Editing a file'
    }
    case 'Write': {
      const f = clip(safeBasename(i.file_path))
      return f ? `Writing ${f}` : 'Writing a file'
    }
    case 'Grep': {
      const pat = clip(asText(i.pattern), 40)
      if (!pat) return 'Searching files'
      const path = i.path ? clip(asText(i.path), 40) : ''
      return path ? `Searching ${path} for ${pat}` : `Searching for ${pat}`
    }
    case 'Glob': {
      const pat = clip(asText(i.pattern), 60)
      return pat ? `Finding files matching ${pat}` : 'Searching files'
    }
    case 'WebFetch': {
      const h = clip(urlHost(i.url), 60)
      return h ? `Reading ${h}` : 'Reading a web page'
    }
    case 'WebSearch': {
      const q = clip(asText(i.query), 60)
      return q ? `Searching the web for ${q}` : 'Searching the web'
    }
    case 'NotebookEdit': {
      const f = clip(safeBasename(i.notebook_path))
      return f ? `Editing ${f}` : 'Editing a notebook'
    }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
      return 'Updating the plan'
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
    // Telegram-plugin tools: matched by the key-agnostic regex so renames/forks work.
    // Strip the `mcp__<server>__` prefix to get just the tool suffix.
    const TELEGRAM_PREFIX_RE = /^mcp__[^_].*?telegram__/
    const telegramMatch = TELEGRAM_PREFIX_RE.exec(toolName)
    if (telegramMatch) {
      const suffix = toolName.slice(telegramMatch[0].length)
      // Surface tools (reply, stream_reply, edit_message, react) are the
      // conversation itself — suppress them from the activity feed entirely.
      // Mirrors isTelegramSurfaceTool in tool-names.ts.
      if (
        suffix === 'reply' ||
        suffix === 'stream_reply' ||
        suffix === 'edit_message' ||
        suffix === 'react'
      ) return null
      if (suffix === 'get_recent_messages') return 'Reading chat history'
      // send_typing and all other surface/control tools: suppress.
      return null
    }
    // Explicit labels / suppressions for the hindsight server.
    switch (toolName) {
      case 'mcp__hindsight__recall':
      case 'mcp__hindsight__reflect':
        return 'Searching memory'
      case 'mcp__hindsight__retain':
      case 'mcp__hindsight__update_memory':
        return 'Saving to memory'
      // Explicit suppressions — return null so we don't emit a sidecar line.
      case 'mcp__hindsight__sync_retain':
        return null
    }
    // Generic fallback for ANY other MCP tool (operator-configured servers
    // — perplexity, webkite, gdrive, notion, …). These previously returned
    // null → invisible in the live activity feed, so a research turn driven
    // entirely by MCP tools read as pure silence (only a typing dot + the
    // 👀 reaction) — the "I can't see what it's doing" report. Mirror the
    // gateway's describeToolUse: friendly per-server labels, else a
    // model-authored field, else a humanized tool name. NEVER label any
    // Telegram surface/control tools (they ARE the conversation). Use the
    // same regex predicate as isTelegramSurfaceTool in tool-names.ts so
    // this works regardless of the plugin's registration key (clerk-telegram,
    // switchroom-telegram, custom fork, …).
    const TELEGRAM_SURFACE_RE = /^mcp__[^_].*?telegram__/
    if (TELEGRAM_SURFACE_RE.test(toolName)) return null
    const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
    if (!m) return null
    const server = m[1].toLowerCase()
    const tool = m[2].toLowerCase()
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
