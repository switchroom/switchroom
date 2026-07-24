// #3519 sharpen — background-shell liveness signal wiring.
//
// Extracted from gateway.ts (the file is under a hard line ratchet — see
// switchroom#2996). Maps parsed session events to the silence-poke
// background-shell registry so the 300s silence-fallback defers ONLY while a
// CLI-side background shell is proven alive, and recovers at ~300s once it
// finishes. Called once per session event from the gateway's event loop.
//
// The three real, deterministic markers (all proven from captured transcript
// data — carrie session a6d2d33a-…, claude v2.1.197; see the fixture at
// telegram-plugin/tests/fixtures/bg-shell-liveness-3519.jsonl):
//   • ALIVE — a tool_result carrying `backgroundTaskId` (a foreground Bash the
//     CLI auto-moved to the background past its ~120s window, or an explicit
//     run_in_background:true). session-tail resolves it from the structured
//     `toolUseResult.backgroundTaskId` field, with the launch string as a
//     secondary.
//   • DEAD (completed/failed) — the CLI's proactive `<task-notification>`,
//     projected as a `task_notification` event.
//   • DEAD (explicit) — a `KillShell` tool_use naming the shell via
//     `input.shell_id`.
import type { SessionEvent } from '../session-tail.js'

/** The subset of silence-poke this wiring drives (kept narrow for testability). */
export interface BackgroundShellRegistry {
  noteBackgroundShellAlive(key: string, shellId: string): void
  noteBackgroundShellDead(key: string, shellId: string): void
}

/** Terminal `<task-notification>` statuses that genuinely mean the shell ended. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed'])

/**
 * Apply the background-shell liveness signal carried by `ev` (if any) to the
 * registry for `key`. A no-op for events that carry no marker, so the caller
 * can invoke it unconditionally on every session event.
 */
export function applyBackgroundShellLiveness(
  registry: BackgroundShellRegistry,
  key: string,
  ev: SessionEvent,
): void {
  if (ev.kind === 'tool_result') {
    if (ev.backgroundTaskId != null && ev.backgroundTaskId.length > 0) {
      registry.noteBackgroundShellAlive(key, ev.backgroundTaskId)
    }
    return
  }
  if (ev.kind === 'task_notification') {
    // Defensive terminal-status gate: real captured data proves every genuine
    // parseable <task-notification> carries a terminal status, so today ANY
    // parsed notification is safe to treat as DEAD. This guards a hypothetical
    // FUTURE CLI that emits an interim (non-terminal) notification for a still-
    // running shell — we must not drop such a shell from the alive-set early.
    if (ev.taskId.length > 0 && TERMINAL_STATUSES.has(ev.status)) {
      registry.noteBackgroundShellDead(key, ev.taskId)
    }
    return
  }
  if (ev.kind === 'tool_use' && ev.toolName === 'KillShell') {
    const killId = (ev.input as { shell_id?: string } | undefined)?.shell_id
    if (typeof killId === 'string' && killId.length > 0) {
      registry.noteBackgroundShellDead(key, killId)
    }
  }
}
