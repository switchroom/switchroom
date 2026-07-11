/**
 * crash-breadcrumb.ts — persistent last-gasp diagnostics for the MCP
 * bridge process (#3033).
 *
 * Why this exists: Claude Code captures an MCP server's stderr only
 * around connection startup — anything the bridge writes later is
 * dropped. In the 2026-07-11 clerk incident the bridge process died
 * within seconds of a gateway crash and the cause was unrecoverable:
 * no stderr, no log, nothing. And a dead bridge is terminal — Claude
 * Code never respawns a failed MCP server, so the chat surface stays
 * down (`No such tool available: mcp__switchroom-telegram__reply`)
 * until a full container restart.
 *
 * This module appends a bounded breadcrumb line to
 * `STATE_DIR/bridge-crash.log` from the bridge's uncaughtException /
 * unhandledRejection handlers so the NEXT incident is diagnosable.
 * Append-only, best-effort, never throws.
 */

import { appendFileSync, statSync, renameSync } from 'node:fs'

/** Rotate once past ~1MB — a crash-looping bridge must not fill the disk. */
const MAX_LOG_BYTES = 1024 * 1024

export function appendCrashBreadcrumb(
  logPath: string,
  kind: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  now: Date = new Date(),
): void {
  try {
    try {
      if (statSync(logPath).size > MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`)
    } catch { /* first write, or rotation raced — append anyway */ }
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    // Single line per event (stack newlines folded) — greppable, bounded.
    const folded = detail.replace(/\s*\n\s*/g, ' | ').slice(0, 4000)
    appendFileSync(logPath, `${now.toISOString()} ${kind} pid=${process.pid} ${folded}\n`)
  } catch {
    /* best-effort: a failing breadcrumb must never make the crash worse */
  }
}
