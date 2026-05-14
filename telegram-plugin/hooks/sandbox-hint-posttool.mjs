#!/usr/bin/env node
/**
 * PostToolUse hook — detects sandbox-related errors in tool_response and
 * injects a one-line hint via Claude Code's `hookSpecificOutput.
 * additionalContext` channel. The hint reminds the agent that the
 * read-only file system / EROFS error is the switchroom sandbox working
 * as intended, and that it should respond to the user with a concrete
 * "Operator action: ..." line rather than retrying or echoing the raw
 * kernel error.
 *
 * Pairs with the SANDBOX_GUIDANCE primer in --append-system-prompt
 * (src/agents/scaffold.ts). The primer is the always-on context; this
 * hook is the just-in-time nudge that fires only when the agent
 * actually hits the boundary.
 *
 * Claude Code PostToolUse protocol:
 *   stdin:  JSON { tool_name, tool_use_id, tool_input, tool_response, ... }
 *   stdout: optional JSON
 *             {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *              "additionalContext":"<text>"}}
 *           prepended to the model's next-turn context after the tool
 *           result is shown.
 *   exit:   0 always. Hook failures must never block the tool flow.
 *
 * Design notes:
 *   - Detection is a substring/regex match against the stringified
 *     tool_response (covers stdout, stderr, error fields).
 *   - No DB writes, no IPC. Pure stdin → stdout, fail-silent.
 *   - Idempotent: re-reading the same tool_response yields the same
 *     hint. Claude Code dedupes additionalContext naturally because the
 *     hook fires once per PostToolUse event.
 */

import { readFileSync } from 'node:fs'

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Patterns that indicate a sandbox-boundary hit, in order of specificity.
 * Each entry: [regex, hint-key]. Hint text is composed below from the
 * matched key — keeps the patterns easy to scan.
 */
const PATTERNS = [
  // The canonical kernel error code + message. Covers most write/mkdir/
  // rename/unlink failures against the read-only rootfs.
  [/\bEROFS\b/, 'erofs'],
  [/read[- ]only file ?system/i, 'erofs'],
  // npm/pip install attempts that hit a read-only prefix. These usually
  // surface as ENOENT or permission errors against /usr/lib/node_modules
  // or /usr/local/lib — listing the explicit paths keeps us from
  // false-matching on user code that legitimately mentions /usr.
  [/EACCES.+\/(usr|opt|etc|bin|lib)\//, 'eacces-rootfs'],
  // apt / dpkg refusing to write to /var/lib/dpkg etc.
  [/dpkg.*permission denied|apt.*permission denied|Unable to acquire the dpkg/i, 'apt'],
]

function buildHint(key) {
  const common =
    'Sandbox boundary hit. The agent container has `read_only: true` rootfs ' +
    '(see the SANDBOX primer in the system prompt). Do NOT retry the same ' +
    'write. Tell the user what you tried, why the sandbox blocked it, and ' +
    'name an operator action (e.g. "edit on host then `switchroom apply`", ' +
    'or "add to docker/Dockerfile.agent and rebuild"). Writable paths: ' +
    '$HOME (/state/agent/home), /tmp, /state/agent/**, /var/log/switchroom.'

  if (key === 'apt') {
    return (
      common +
      ' For package installs specifically: ask the operator to add the ' +
      'package to docker/Dockerfile.agent and rebuild the agent image — ' +
      'in-container apt is not the right path.'
    )
  }
  return common
}

function emitContext(text) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: text,
    },
  }
  process.stdout.write(JSON.stringify(payload) + '\n')
}

/**
 * #1303: classify a tool_response as a failure. Only failures can have
 * hit a kernel sandbox boundary. Pre-fix the hook stringified the whole
 * tool_response and pattern-matched against it — that meant a SUCCESSFUL
 * Read/Edit/Bash whose payload merely MENTIONED "EROFS" or "Read-only
 * file system" (e.g. file content, code comments, grep results, the hook
 * source itself) tripped the advisory. Verified live during #1291/#1292
 * PR work: every `Read` on a file talking about the sandbox model
 * produced a false positive; every `Edit` adding a comment that
 * mentioned read-only-fs did too.
 *
 * Recognise failure across the three observed tool_response shapes:
 *   - Edit / Write / NotebookEdit / MCP: `{ is_error: true, ... }`
 *   - Bash: `{ exit_code: <non-zero>, stdout, stderr, ... }`
 *   - Free-form string body: assume failure if the string parses; the
 *     pattern match downstream still gates the advisory text.
 *
 * Also exported as `legacy.error` style for forward-compat: any
 * non-null `tool_response.error` field is treated as failure.
 *
 * If no failure signal is found we have no kernel error to advise on,
 * and the hook stays silent.
 */
function classifyFailure(toolResponse) {
  if (toolResponse == null) return null
  if (typeof toolResponse === 'string') {
    // Bare string body — no structured failure marker. Treat as a
    // candidate; the pattern match decides.
    return { kind: 'bare-string', body: toolResponse }
  }
  if (typeof toolResponse !== 'object') return null
  const isError =
    toolResponse.is_error === true
    || toolResponse.success === false
    || toolResponse.error != null
    || (typeof toolResponse.exit_code === 'number'
        && toolResponse.exit_code !== 0)
  if (!isError) return null
  // Extract error-bearing fields only — never the full response. For a
  // failed Bash, stdout may carry the relevant kernel message alongside
  // stderr (some commands write errors to stdout), so include stdout
  // when there's a non-zero exit code.
  const parts = []
  if (typeof toolResponse.error === 'string') parts.push(toolResponse.error)
  if (typeof toolResponse.stderr === 'string') parts.push(toolResponse.stderr)
  if (toolResponse.exit_code != null && toolResponse.exit_code !== 0
      && typeof toolResponse.stdout === 'string') {
    parts.push(toolResponse.stdout)
  }
  // Fallback: failure was signalled but no error-bearing field
  // surfaced — stringify the structured response so we don't miss an
  // unusual tool that puts the kernel error in an unexpected key.
  // Bounded by the 64 KiB cap downstream.
  if (parts.length === 0) {
    try { parts.push(JSON.stringify(toolResponse)) } catch { /* unprintable */ }
  }
  return { kind: 'structured-failure', body: parts.join('\n') }
}

/**
 * #1303 secondary defence: only write-capable tools can hit a kernel
 * sandbox boundary. Read/Grep/Glob/WebFetch/etc. cannot EROFS — even if
 * settings.json wires this hook with matcher ".*", we gate at the
 * script level so a future scaffold change can't re-introduce the
 * false-positive class. Bash is included because it's the canonical
 * write surface (mkdir, rm, install, apt, etc.). MCP tools that may
 * proxy writes are included by an `mcp__` prefix check.
 */
const WRITE_CAPABLE_TOOLS = new Set([
  'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash',
])

function isWriteCapableTool(toolName) {
  if (typeof toolName !== 'string') return false
  if (WRITE_CAPABLE_TOOLS.has(toolName)) return true
  if (toolName.startsWith('mcp__')) return true
  return false
}

function main() {
  const raw = readStdin()
  if (!raw) return

  let evt
  try {
    evt = JSON.parse(raw)
  } catch {
    return
  }

  if (!isWriteCapableTool(evt.tool_name)) return

  // #1303 primary fix: classify success vs failure FIRST. A successful
  // tool can't have hit a kernel sandbox boundary by definition — its
  // payload may mention EROFS / read-only-fs in benign content but
  // that's not a kernel error.
  const failure = classifyFailure(evt.tool_response)
  if (failure == null) return

  let body = failure.body
  if (typeof body !== 'string') return
  if (body.length === 0) return
  if (body.length > 64 * 1024) body = body.slice(0, 64 * 1024)

  for (const [pattern, key] of PATTERNS) {
    if (pattern.test(body)) {
      emitContext(buildHint(key))
      return
    }
  }
}

// Test-only export hooks. Node ESM doesn't expose internal symbols
// without a named export; tests import `__internals` and assert against
// `classifyFailure` / `isWriteCapableTool` directly. Production paths
// use `main()` and never touch this object.
export const __internals = {
  classifyFailure,
  isWriteCapableTool,
  WRITE_CAPABLE_TOOLS,
  PATTERNS,
  buildHint,
}

try {
  main()
} catch {
  // Fail-silent. The PostToolUse must never block the tool flow.
}
