#!/usr/bin/env node
/**
 * PreToolUse hook — when the agent first touches a file in a code repo
 * outside its workspace, locate that repo's CLAUDE.md (or AGENTS.md /
 * AGENT.md) and inject it as additionalContext on this tool call.
 *
 * Why this exists (#1811). Claude Code's native CLAUDE.md auto-loading
 * is cwd-at-session-start + parents only. A switchroom agent's session
 * starts at the agent's workspace, so when a user (often a non-coder
 * over Telegram) asks the agent to "go work on ~/code/foo", the foo
 * repo's CLAUDE.md is NOT in the agent's context — the agent has to
 * remember to `Read` it manually. The agent's system prompt nudges
 * this behaviour but it's a soft contract that depends on model
 * obedience.
 *
 * This hook closes the loop. The first time the agent's Read / Edit /
 * Write / MultiEdit / NotebookEdit / Bash touches a path under a repo
 * that has a CLAUDE.md (etc), the hook reads it once and injects it.
 * Subsequent tool calls in the same repo are no-ops (tracked per
 * session in /tmp).
 *
 * Claude Code PreToolUse protocol (v1):
 *   Input:  JSON on stdin — { session_id, transcript_path, cwd,
 *           tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout                       → allow, no change
 *           exit 0 + JSON {"hookSpecificOutput":
 *             {"hookEventName":"PreToolUse",
 *              "additionalContext":"<text>"}}           → allow, inject text
 *
 * Kill switch:
 *   SWITCHROOM_DISABLE_REPO_CONTEXT_HOOK=1   disables entirely
 *
 * Tunables (env, optional):
 *   SWITCHROOM_REPO_CONTEXT_PER_FILE_MAX_BYTES   default 30_000
 *   SWITCHROOM_REPO_CONTEXT_PER_SESSION_MAX_BYTES default 100_000
 *   SWITCHROOM_REPO_CONTEXT_PER_SESSION_MAX_FILES default 5
 *
 * Fail-open by design: any error (bad JSON, missing fields, fs error,
 * unparseable path) → exit 0 with no output. The hook is a soft
 * UX-improver; never break tool execution because of it.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// ─── Tunables ─────────────────────────────────────────────────────────────

const MARKER_FILES = ['CLAUDE.md', 'AGENTS.md', 'AGENT.md']

function envInt(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw.length === 0) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const PER_FILE_MAX_BYTES = envInt(
  'SWITCHROOM_REPO_CONTEXT_PER_FILE_MAX_BYTES',
  30_000,
)
const PER_SESSION_MAX_BYTES = envInt(
  'SWITCHROOM_REPO_CONTEXT_PER_SESSION_MAX_BYTES',
  100_000,
)
const PER_SESSION_MAX_FILES = envInt(
  'SWITCHROOM_REPO_CONTEXT_PER_SESSION_MAX_FILES',
  5,
)

// Walk-up upper bound — never traverse past these directory roots
// when looking for a marker. Avoids picking up an operator's
// $HOME/CLAUDE.md on every random tool call.
const WALK_STOP_DIRS = new Set(['/', homedir()])

// ─── Helpers ──────────────────────────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function isDisabled() {
  const v = process.env.SWITCHROOM_DISABLE_REPO_CONTEXT_HOOK
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Pick the target directory for the marker walk based on tool shape:
 *   - File tools (Read/Edit/Write/MultiEdit/NotebookEdit) — dirname of
 *     `tool_input.file_path`.
 *   - Bash — the hook envelope's `cwd` (which the Bash tool maintains
 *     across calls via its persistent shell, per Claude Code docs).
 *   - Anything else — null (skip).
 *
 * Returns an absolute, normalised path or null.
 */
export function resolveTargetDir(toolName, toolInput, envelopeCwd) {
  const fileTools = new Set([
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
  ])
  if (fileTools.has(toolName)) {
    const raw = toolInput?.file_path ?? toolInput?.notebook_path
    if (typeof raw !== 'string' || raw.length === 0) return null
    const abs = isAbsolute(raw) ? raw : null
    // Skip relative file paths — Claude Code overwhelmingly passes
    // absolute paths; a relative one is ambiguous (relative to what?)
    // and the hook envelope's `cwd` may not match the model's intent.
    if (!abs) return null
    return normalize(dirname(abs))
  }
  if (toolName === 'Bash') {
    if (typeof envelopeCwd !== 'string' || envelopeCwd.length === 0) return null
    if (!isAbsolute(envelopeCwd)) return null
    return normalize(envelopeCwd)
  }
  return null
}

/**
 * Walk up from `startDir` looking for the first marker file
 * (CLAUDE.md, AGENTS.md, AGENT.md, in that order). Stops at filesystem
 * root, the operator's $HOME, or after a generous depth cap.
 *
 * Returns the absolute path of the first marker found, or null.
 */
export function findNearestMarker(startDir) {
  if (typeof startDir !== 'string' || startDir.length === 0) return null
  let dir = resolve(startDir)
  const MAX_HOPS = 20
  for (let i = 0; i < MAX_HOPS; i++) {
    for (const name of MARKER_FILES) {
      const candidate = join(dir, name)
      try {
        const st = statSync(candidate)
        if (st.isFile()) return candidate
      } catch {
        // ENOENT and similar — try the next marker name / parent dir
      }
    }
    if (WALK_STOP_DIRS.has(dir)) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Is `targetDir` inside the agent's own workspace? The workspace
 * CLAUDE.md is auto-loaded by Claude Code at session start, so
 * re-injecting it via additionalContext would be a redundant token
 * cost. The workspace dir comes from the well-known
 * `~/.switchroom/agents/<name>/workspace/` path (set up by the
 * switchroom scaffold).
 */
export function isUnderAgentWorkspace(targetDir, agentName, home) {
  if (!agentName || typeof targetDir !== 'string') return false
  const wsRoot = normalize(
    join(home, '.switchroom', 'agents', agentName, 'workspace'),
  )
  const t = normalize(targetDir)
  return t === wsRoot || t.startsWith(wsRoot + sep)
}

// ─── Session-scoped loaded-set tracker ────────────────────────────────────

/**
 * Per-session state file — one path per line. Lazily created. Survives
 * for the session and is mopped up by tmpfs eviction (or the next
 * reboot inside the agent container, since /tmp is tmpfs there).
 *
 * Returns { stateDir, loadedPath, loaded: Set<string>, totalBytes }
 */
function readSessionState(sessionId) {
  // Sanitise session_id — Claude Code session ids are uuids but be
  // defensive about path injection.
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  const stateDir = join(tmpdir(), `switchroom-repo-context-${safeId}`)
  const loadedPath = join(stateDir, 'loaded.txt')
  const loaded = new Set()
  let totalBytes = 0
  try {
    if (existsSync(loadedPath)) {
      const lines = readFileSync(loadedPath, 'utf8').split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        // Each line: "<path>\t<bytes>"
        const tabIdx = trimmed.indexOf('\t')
        if (tabIdx < 0) {
          loaded.add(trimmed)
          continue
        }
        const path = trimmed.slice(0, tabIdx)
        const sz = Number.parseInt(trimmed.slice(tabIdx + 1), 10)
        loaded.add(path)
        if (Number.isFinite(sz) && sz > 0) totalBytes += sz
      }
    }
  } catch {
    // best-effort
  }
  return { stateDir, loadedPath, loaded, totalBytes }
}

function recordLoaded(state, markerPath, bytes) {
  try {
    if (!existsSync(state.stateDir)) {
      mkdirSync(state.stateDir, { recursive: true, mode: 0o700 })
    }
    appendFileSync(state.loadedPath, `${markerPath}\t${bytes}\n`, {
      mode: 0o600,
    })
  } catch {
    // If we can't persist, the worst case is we re-inject on the
    // next tool call. Acceptable.
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

function buildContext(markerPath, body, truncated) {
  const truncNote = truncated
    ? '\n\n[…repo CLAUDE.md was truncated to fit the per-file injection budget — `Read` it directly for the full contents.]'
    : ''
  return (
    '<repo-context source="switchroom repo-context hook">\n' +
    `The agent's tool call is touching a path under \`${dirname(markerPath)}\` ` +
    `which has guidance at \`${markerPath}\`. ` +
    `That guidance is reproduced here so it's part of this turn's context ` +
    `(Claude Code's native CLAUDE.md auto-load only fires for the session's ` +
    `start cwd and parents, not for repos the agent navigates into ` +
    `mid-session). Follow this repo's conventions for any work in it.\n\n` +
    '---\n' +
    body +
    truncNote +
    '\n---\n' +
    '</repo-context>\n'
  )
}

function buildPointer(markerPath) {
  return (
    '<repo-context source="switchroom repo-context hook">\n' +
    `The agent's tool call is touching a path under \`${dirname(markerPath)}\`. ` +
    `That repo has guidance at \`${markerPath}\` which is larger than the ` +
    `per-file injection budget — \`Read\` it directly before any ` +
    `substantive work in this repo.\n` +
    '</repo-context>\n'
  )
}

async function main() {
  if (isDisabled()) process.exit(0)

  const raw = readStdin().trim()
  if (raw.length === 0) process.exit(0)

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const toolName = event?.tool_name
  const toolInput = event?.tool_input
  const sessionId = event?.session_id
  const envelopeCwd = event?.cwd
  if (typeof toolName !== 'string' || !sessionId) process.exit(0)

  const targetDir = resolveTargetDir(toolName, toolInput, envelopeCwd)
  if (targetDir == null) process.exit(0)

  // Skip the agent's own workspace — Claude Code already loaded its
  // CLAUDE.md at session start. Re-injecting would be a token-cost
  // duplicate.
  const agentName = process.env.SWITCHROOM_AGENT_NAME ?? ''
  const home = homedir()
  if (isUnderAgentWorkspace(targetDir, agentName, home)) process.exit(0)

  const markerPath = findNearestMarker(targetDir)
  if (markerPath == null) process.exit(0)

  const state = readSessionState(sessionId)

  // Already-loaded dedup — the load-once-per-repo-per-session invariant.
  if (state.loaded.has(markerPath)) process.exit(0)

  // Per-session caps — degrade gracefully when the agent wanders.
  if (state.loaded.size >= PER_SESSION_MAX_FILES) process.exit(0)
  if (state.totalBytes >= PER_SESSION_MAX_BYTES) process.exit(0)

  // Read the marker. Skip if oversized — emit a pointer instead so the
  // agent at least knows the file exists.
  let body = ''
  let truncated = false
  try {
    body = readFileSync(markerPath, 'utf8')
  } catch {
    process.exit(0)
  }

  let outputContext
  if (body.length > PER_FILE_MAX_BYTES) {
    outputContext = buildPointer(markerPath)
    // Record so we don't pointer-spam either.
    recordLoaded(state, markerPath, outputContext.length)
  } else {
    // Trim trailing whitespace so the wrapped envelope reads cleanly.
    body = body.replace(/\s+$/, '')
    outputContext = buildContext(markerPath, body, truncated)
    recordLoaded(state, markerPath, outputContext.length)
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: outputContext,
      },
    }),
  )
  process.exit(0)
}

// Gate the entrypoint to direct-invocation only. When this module is
// imported (by the vitest/bun test that exercises the pure helpers),
// running main() would block forever on stdin — the test harness has
// no stdin to feed it, and readFileSync(0) hangs.
const invokedDirectly =
  typeof process !== 'undefined'
  && Array.isArray(process.argv)
  && process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch(() => process.exit(0))
}
