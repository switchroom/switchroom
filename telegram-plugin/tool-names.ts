/**
 * MCP tool-name classification helpers.
 *
 * Claude Code prefixes every MCP tool name with `mcp__<server-key>__` where
 * `<server-key>` is whatever name the host's `.mcp.json` used to register
 * this plugin. The key is user-chosen and historical agents still use
 * `clerk-telegram` while new installs use `switchroom-telegram` (and forks
 * may pick yet other names). Matching a single hardcoded prefix would
 * silently break the orphaned-reply backstop and status-reaction
 * suppression for anyone whose config didn't match — which is how bug
 * #TG-IDLE-LEAK regressed on 2026-04-14.
 *
 * Extracted from server.ts so the classification can be unit-tested
 * without importing the whole MCP-server module (which executes
 * side-effects at import: Bot creation, env-var validation, etc).
 */

const TELEGRAM_TOOL_PREFIX_RE = /^mcp__[^_].*?telegram__/

function stripPrefix(toolName: string): string | null {
  if (!TELEGRAM_TOOL_PREFIX_RE.test(toolName)) return null
  return toolName.replace(TELEGRAM_TOOL_PREFIX_RE, '')
}

/**
 * True if `toolName` is this plugin's `reply` or `stream_reply` tool
 * published under ANY registration key (`clerk-telegram`,
 * `switchroom-telegram`, a custom fork, …). Used by the session-tail
 * handler to set `currentTurnReplyCalled` — when this returns false for
 * a real reply call, turn_end mistakenly runs the orphaned-reply
 * backstop and duplicates the message.
 */
export function isTelegramReplyTool(toolName: string): boolean {
  const suffix = stripPrefix(toolName)
  return suffix === 'reply' || suffix === 'stream_reply'
}

/**
 * True if `toolName` is any Telegram surface tool whose own handler
 * owns the status-reaction lifecycle for the turn (reply, stream_reply,
 * edit_message, react). The session-tail skips driving a tool reaction
 * for these — the handler itself will fire `setDone()` when the API
 * call completes.
 */
export function isTelegramSurfaceTool(toolName: string): boolean {
  const suffix = stripPrefix(toolName)
  return (
    suffix === 'reply'
    || suffix === 'stream_reply'
    || suffix === 'edit_message'
    || suffix === 'react'
  )
}
