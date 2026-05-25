/**
 * Pure helpers for the silent-end Stop hook — extracted so unit tests
 * can exercise the scan logic without spawning the .mjs subprocess.
 *
 * Closes the race documented in #1775: the gateway writes
 * `silent-end-pending.json` only AFTER the Stop hook fires (the
 * gateway's `turn_end` handler runs downstream of the `turn_duration`
 * JSONL line, which is itself written AFTER `stop_hook_summary`). The
 * fix: the hook stops depending on the gateway's state file as its
 * SIGNAL and instead scans `transcript_path` directly. Claude Code
 * flushes assistant content to the JSONL before firing Stop hooks
 * (verified empirically: `telegram-plugin/hooks/secret-scrub-stop.mjs`
 * already reads `transcript_path` at Stop time successfully in
 * production), so a transcript scan is race-free.
 *
 * The state file is preserved for retry-count bookkeeping (the
 * 1-retry budget + user-facing fallback chain in `silent-end.ts`),
 * but it is no longer the signal that drives the block/allow
 * decision.
 *
 * Same `isFinalAnswerReply` predicate the gateway applies at every
 * reply callsite (`final-answer-detect.ts:78-83`):
 *   done===true  OR  !disableNotification  OR  text.length >= 200
 *
 * Plus the `NO_REPLY` / `HEARTBEAT_OK` silent-marker carve-out — if
 * the model explicitly emitted that sentinel through the reply tool,
 * the turn is "intentionally silent" and the hook must allow stop.
 *
 * Sidechain filter: sub-agent (Task) tool_use lines that leak into
 * the parent transcript with `isSidechain:true` are skipped. The
 * sub-agent's OWN replies live in `subagents/agent-<id>.jsonl` (per
 * `session-tail.ts:277-281`) and never count toward the parent's
 * delivery obligation.
 */

const REPLY_TOOLS = new Set([
  'mcp__switchroom-telegram__reply',
  'mcp__switchroom-telegram__stream_reply',
])
const FINAL_ANSWER_MIN_CHARS = 200
// Match the gateway's silent-marker classifier (gateway.ts:6692 — the
// `isSilentFlushMarker` helper accepts trailing punctuation + case
// variants like "NO_REPLY." / "no_reply").
const SILENT_MARKER_RE = /^(NO_REPLY|HEARTBEAT_OK)[\s.!?]*$/i

/**
 * Predicate ported from `telegram-plugin/final-answer-detect.ts:78-83`.
 * Kept in this .mjs so the hook is fully self-contained (no TS import).
 * If the TS file ever diverges, the test fixture below (T14) catches it.
 */
export function isFinalAnswerReply({ text, disableNotification, done }) {
  if (done === true) return true
  if (!disableNotification) return true
  if ((text ?? '').length >= FINAL_ANSWER_MIN_CHARS) return true
  return false
}

/**
 * Scan a JSONL transcript and decide whether the current turn ended
 * with a final reply delivered.
 *
 * Returns:
 *   { decided: 'allow', reason }    — qualifying reply OR silent marker found
 *   { decided: 'block', reason }    — turn-start found, no qualifying reply, no marker
 *   { decided: 'unknown', reason }  — couldn't locate turn-start; caller fail-open
 *
 * Turn-start anchor: the most recent `queue-operation`/`enqueue` line
 * (the inbound message the gateway pushed onto the session). For
 * queued mid-turn messages (multiple `enqueue` lines per "turn"), we
 * anchor on the LAST enqueue — the model is responsible for at least
 * the most recent message. (Mild over-allow risk on the multi-enqueue
 * edge case where the model replied combined ahead of the second
 * enqueue's append; accepted residual.)
 *
 * @param {string} jsonl
 * @returns {{ decided: 'allow' | 'block' | 'unknown', reason: string }}
 */
export function scanTurnForFinalReply(jsonl) {
  const lines = jsonl.split('\n')

  // 1. Walk backward to most-recent queue-operation/enqueue.
  let startIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type === 'queue-operation' && obj.operation === 'enqueue') {
      startIdx = i
      break
    }
  }
  if (startIdx < 0) {
    return { decided: 'unknown', reason: 'no-turn-start' }
  }

  // 2. Scan forward from the turn start; look for qualifying tool_use
  //    or silent-marker text.
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line[0] !== '{') continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    // Skip sub-agent contamination (defensive — sub-agent lines should
    // be in a separate transcript file, but `isSidechain:true` is the
    // documented marker if they leak).
    if (obj?.isSidechain === true) continue
    if (obj?.type !== 'assistant') continue
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c?.type !== 'tool_use') continue
      if (!REPLY_TOOLS.has(c.name)) continue
      const input = c.input ?? {}
      const text = String(input.text ?? '')
      // Silent-marker carve-out: the operator explicitly signaled
      // "intentionally silent" (cron HEARTBEAT_OK, model-driven
      // NO_REPLY). Don't block — same posture as the gateway's
      // silent-marker suppression at gateway.ts:6692.
      if (SILENT_MARKER_RE.test(text.trim())) {
        return { decided: 'allow', reason: 'silent-marker' }
      }
      if (isFinalAnswerReply({
        text,
        disableNotification: input.disable_notification === true,
        done: input.done === true,
      })) {
        return { decided: 'allow', reason: 'final-reply' }
      }
    }
  }

  return { decided: 'block', reason: 'no-final-reply' }
}
