// #1122 silence-poke session-event wiring.
//
// Extracted from gateway.ts (the file is under a hard line ratchet — see
// switchroom#2996). Maps a parsed session event onto the silence-poke activity
// registry so the 300s framework-fallback message wording is honest (thinking
// vs working, plus the longest-running in-flight tool), threads the #1445
// cross-turn pending-async ambient, and feeds the #3519 background-shell
// liveness signal. Called once per session event from the gateway's event loop
// while a turn is live (the caller owns the `currentTurn != null` guard and the
// `key` derivation).
import type { SessionEvent } from '../session-tail.js'
import { isTelegramSurfaceTool } from '../tool-names.js'
import { toolLabel } from '../tool-labels.js'
import { applyBackgroundShellLiveness } from './background-shell-liveness.js'
import { removeCompactionMarker, resolveTelegramStateDir } from './compaction-marker.js'

/** The silence-poke module namespace (kept as `typeof` so no surface drift). */
type SilencePoke = typeof import('../silence-poke.js')
/** The pending-work-progress module namespace. */
type PendingProgress = typeof import('../pending-work-progress.js')

/**
 * Apply the activity signals carried by `ev` to silence-poke / pending-progress
 * for the live turn identified by `key`. Behaviour is identical to the inline
 * block this replaced — a pure extract/move.
 */
export function applySilencePokeSessionEvent(
  silencePoke: SilencePoke,
  pendingProgress: PendingProgress,
  key: string,
  ev: SessionEvent,
): void {
  if (ev.kind === 'thinking') {
    silencePoke.noteThinking(key, Date.now())
  } else if (ev.kind === 'tool_use') {
    // #1292: track in-flight tool calls so the 300s framework
    // fallback message can name the actual observable (e.g.
    // "running Grep \"foo\" for 4m") instead of the dishonest
    // generic "still working… no update in 5 min" when the agent
    // is clearly busy on tool calls. Telegram-surface tools are
    // excluded — their job IS the outbound message, the silence
    // clock resets via noteOutbound when they fire. Sub-agent
    // tool_use events (kind='sub_agent_tool_use') intentionally
    // NOT tracked: the parent's Task tool_use is already on the
    // map and represents the user-observable wait.
    if (
      ev.toolUseId != null
      && ev.toolUseId.length > 0
      && !isTelegramSurfaceTool(ev.toolName)
    ) {
      const label = toolLabel(
        ev.toolName,
        ev.input,
        /*preamble*/ undefined,
        ev.precomputedLabel,
      )
      silencePoke.noteToolStart(
        key,
        ev.toolUseId,
        ev.toolName,
        label.length > 0 ? label : null,
        Date.now(),
      )
      // #1445 cross-turn pending-async ambient. Mark the chat as
      // having dispatched background work this turn so a turn_end
      // that follows activates the edit-in-place ambient line.
      // Covers `Agent` / `Task` (the harness-managed async path
      // — handback channel turn clears it) and `Bash` with
      // run_in_background:true (model is expected to poll
      // BashOutput; the ambient ticks until next inbound or the
      // 30-min budget cap).
      const evInput = ev.input as { run_in_background?: boolean } | undefined
      if (
        ev.toolName === 'Agent'
        || ev.toolName === 'Task'
        || (ev.toolName === 'Bash' && evInput?.run_in_background === true)
      ) {
        pendingProgress.noteAsyncDispatch(key)
      }
    }
  } else if (ev.kind === 'tool_result') {
    // #1292: drain the in-flight entry. Idempotent on unknown ids
    // (covers Telegram-surface tools we skipped at start time).
    if (ev.toolUseId != null && ev.toolUseId.length > 0) {
      silencePoke.noteToolEnd(key, ev.toolUseId, Date.now())
    }
  } else if (ev.kind === 'compact_boundary') {
    // #4058 — mid-turn compaction ENDED (the transcript's compact_boundary
    // record only exists once compaction is done). Two effects:
    //   1. Clear the PreCompact marker so the compaction defer stops holding
    //      the 300s fallback (a post-compaction wedge fires on schedule).
    //   2. Count the boundary as PRODUCTION: the silence clock ran the whole
    //      compaction, so without a reset the fallback would fire on the very
    //      next tick — before the resumed model's first output can land. The
    //      transcript resuming IS observable progress; a turn that stays
    //      silent AFTER compaction still fires one full window later.
    removeCompactionMarker(resolveTelegramStateDir())
    silencePoke.noteProduction(key, Date.now())
  }
  // #3519 sharpen: feed background-shell liveness (ALIVE/DEAD) to silence-poke — see background-shell-liveness.ts.
  applyBackgroundShellLiveness(silencePoke, key, ev)
}
