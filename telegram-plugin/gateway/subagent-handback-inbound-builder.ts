/**
 * Pure builder for the synthetic `subagent_handback` inbound the gateway
 * injects when a *background* sub-agent (worker / researcher) finishes.
 *
 * Why this exists (conversational-pacing beat 4 — the handback):
 * A foreground sub-agent hands its result straight back as the `Task`
 * tool result, in the parent's own turn — the model sees it in-context.
 * A background sub-agent does not: it finishes decoupled from any turn
 * boundary, and when it completes the parent agent is typically idle
 * with no turn in flight to receive the result. Claude Code surfaces a
 * background result only on the parent's *next* turn — for a Telegram
 * agent that means the user must send another message before they ever
 * hear back. The agent never proactively says "the worker's done".
 *
 * This builder produces the InboundMessage that closes that gap. The
 * gateway's subagent-watcher `onFinish` callback (which already knows
 * the moment a background sub-agent terminates) feeds the worker's
 * result text in here; the gateway delivers the envelope through the
 * same idle-drain path cron and vault-grant wake-ups use. The model
 * wakes, sees `<channel source="subagent_handback">`, and synthesises a
 * user-facing handback in its own voice — beat 4 made deterministic.
 *
 * Shape contract (mirrors `vault-grant-inbound-builders.ts`): the
 * `meta.source` string is load-bearing — the MCP channel notification
 * wraps it as `<channel source="subagent_handback">`. A regression that
 * changes the source string or drops a meta field silently breaks the
 * wake-up. Pinned by `subagent-handback-inbound-builder.test.ts`.
 */

import type { InboundMessage } from './ipc-protocol.js'

/** Cap on the worker result text carried in the inbound. The model
 *  synthesises a fresh handback from it — the full transcript is never
 *  needed, and an unbounded paste bloats the parent's context. */
export const HANDBACK_RESULT_MAX = 3000
/** Cap on the dispatch-time task description echoed back for context. */
export const HANDBACK_DESC_MAX = 200

export interface SubagentHandbackContext {
  /** Telegram chat the work was dispatched from — the synthesized
   *  handback turn lands here so it stays with the conversation. */
  chatId: string
  /** Dispatch-time task description (the sub-agent's `description`). */
  taskDescription: string
  /** The worker's final result text — its last narrative emission
   *  before terminating. May be empty if the watcher never observed a
   *  text line (rare: a worker that only ran tools then exited). */
  resultText: string
  /** Terminal outcome as classified by the watcher. */
  outcome: 'completed' | 'failed'
}

function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * Build the synthetic InboundMessage for a finished background
 * sub-agent. Deterministic under a fixed `nowMs` for tests.
 */
export function buildSubagentHandbackInbound(opts: {
  ctx: SubagentHandbackContext
  nowMs?: number
}): InboundMessage {
  const ts = opts.nowMs ?? Date.now()
  const desc = truncate(opts.ctx.taskDescription, HANDBACK_DESC_MAX) || '(no description)'
  const result = truncate(opts.ctx.resultText, HANDBACK_RESULT_MAX)

  const text =
    opts.ctx.outcome === 'failed'
      ? `🤝 A background worker you dispatched has FAILED.\n\n` +
        `Task: ${desc}\n\n` +
        (result ? `What it reported before failing:\n${result}\n\n` : '') +
        `This is beat 4 — the handback. Tell the user plainly that the ` +
        `delegated work did not complete, what is known, and your ` +
        `recommended next step — one \`reply\` in your own voice. Do not ` +
        `stay silent.`
      : `🤝 A background worker you dispatched has finished.\n\n` +
        `Task: ${desc}\n\n` +
        (result
          ? `What the worker reported:\n${result}\n\n`
          : `The worker left no summary text.\n\n`) +
        `This is beat 4 — the handback. Synthesise this for the user ` +
        `now: one \`reply\` in your own voice covering what the worker ` +
        `found and your recommended next step. Do NOT paste the raw ` +
        `report and do NOT stay silent — the user dispatched this and ` +
        `is waiting to hear back.`

  return {
    type: 'inbound',
    chatId: opts.ctx.chatId,
    messageId: ts, // synthetic — no Telegram message id exists
    user: 'subagent-watcher',
    userId: 0,
    ts,
    text,
    meta: {
      source: 'subagent_handback',
      outcome: opts.ctx.outcome,
    },
  }
}
