/**
 * #4065 — the rollout narration card's EDIT relay, with a truthful reply.
 *
 * hostd owns the rollout card's lifecycle (post once, then edit in place
 * through the phases). Before #4065 this handler was pure fire-and-forget:
 * every edit failure was swallowed here and hostd never learned about it. That
 * is invisible in the steady state (hostd posted the card seconds earlier, so
 * it is virtually always editable) but NOT after a hostd self-bump: the
 * resumed narrator is SEEDED with the carried `narration_message_id` and takes
 * the edit branch forever. If that carried id is gone — operator deleted the
 * card, or the message is no longer editable — the roll edits into the void
 * and the operator is left staring at a stale card that never reaches a
 * terminal ✅/❌.
 *
 * So the handler now REPLIES with a `rollout_status_edited` outcome and, when
 * the failure means the target message no longer exists, says so (`gone`).
 * hostd's narrator turns exactly one `gone` into one fresh post and escalates
 * anything past that to telemetry — never a chat card asking the operator to
 * do something (the PR #4104 rule).
 *
 * Still fire-and-forget toward the ROLL: the reply is advisory, hostd never
 * blocks on it, and a gateway that predates this reply simply times out
 * hostd-side and behaves exactly as before.
 *
 * Why this call is tagged `priorityClass: 'critical'`
 * ---------------------------------------------------
 * The wiring in gateway.ts tags the `rollout-status-edit` `robustApiCall`
 * EXPLICITLY rather than inheriting the untagged default
 * (`UNTAGGED_SEND_CLASS`, today `'critical'` — never shed). The handler below
 * infers success from the ABSENCE of a throw, and a shed send does not throw:
 * the send gate returns `SEND_GATE_SHED` without ever calling Telegram. So if
 * a future change to the untagged default made this call sheddable, this
 * handler would reply `ok:true` for an edit that never happened, and hostd
 * would record the operator's card as live and current while it sat frozen —
 * the same silent-inertness class of bug as the dropped reply that
 * tests/rollout-narration-edit-socket.test.ts now pins. Tagging the class at
 * the call site makes that impossible to change by accident.
 */

import type {
  RolloutStatusEditMessage,
  RolloutStatusEditedEvent,
} from './ipc-protocol.js'

/**
 * The reply channel — structurally satisfied by `IpcClient` (whose `send`
 * accepts the wider `GatewayToClient` union). Kept narrow here so this module
 * doesn't depend on the IPC server.
 */
export interface RolloutStatusEditReplySink {
  send(msg: RolloutStatusEditedEvent): void
}

/**
 * Classification of an edit failure, from the perspective of "is the card the
 * operator can see still there?".
 *
 *  - `not-modified` — Telegram rejected the edit because the body is already
 *    byte-identical. The card IS live and correct; this is a success.
 *  - `gone`         — the target message no longer exists / can no longer be
 *    edited. Only this class may trigger a re-post.
 *  - `transient`    — anything else (429 past retries, network, chat errors).
 *    Re-posting would duplicate a card that is probably still fine.
 */
export type RolloutEditFailureClass = 'not-modified' | 'gone' | 'transient'

/** Telegram descriptions that mean "the message you asked me to edit is gone". */
const GONE_PATTERNS = [
  /message to edit not found/i,
  /message can't be edited/i,
  /message_id_invalid/i,
  /message to be edited not found/i,
]

/** True IFF the error means the edit body already equals the live message. */
const NOT_MODIFIED = /message is not modified/i

/**
 * Classify a thrown Telegram edit error. Reads `description` (grammy's
 * `GrammyError`) and falls back to the message string, so a plain `Error`
 * carrying the same text classifies identically.
 */
export function classifyRolloutEditError(err: unknown): RolloutEditFailureClass {
  const e = err as { description?: unknown; message?: unknown } | null
  const text = [
    typeof e?.description === 'string' ? e.description : '',
    typeof e?.message === 'string' ? e.message : '',
  ].join(' ')
  if (NOT_MODIFIED.test(text)) return 'not-modified'
  if (GONE_PATTERNS.some((re) => re.test(text))) return 'gone'
  return 'transient'
}

export interface RolloutStatusEditDeps {
  /** The gateway's own agent name (`SWITCHROOM_AGENT_NAME`), or undefined. */
  selfAgentName: string | undefined
  /** Operator chat (`allowFrom[0]`), or undefined when access is unconfigured. */
  operatorChatId: () => string | number | undefined
  /** Perform the edit. MUST already be wrapped in the retry policy. */
  editMessage: (chatId: string | number, messageId: number, text: string) => Promise<unknown>
  log: (line: string) => void
}

/**
 * Handle one `rollout_status_edit` and reply with its outcome. Never throws:
 * every failure path resolves after sending (best-effort) a
 * `rollout_status_edited` event.
 */
export async function handleRolloutStatusEdit(
  deps: RolloutStatusEditDeps,
  client: RolloutStatusEditReplySink,
  msg: RolloutStatusEditMessage,
): Promise<void> {
  const reply = (ok: boolean, extra: { gone?: boolean; reason?: string } = {}): void => {
    try {
      client.send({ type: 'rollout_status_edited', requestId: msg.requestId, ok, ...extra })
    } catch {
      /* best effort — hostd falls back to its bounded reply timeout */
    }
  }
  const self = deps.selfAgentName
  if (self && msg.agentName !== self) {
    deps.log(`rollout_status_edit rejected — agent mismatch (${msg.agentName} != ${self})`)
    reply(false, { gone: false, reason: 'agent mismatch' })
    return
  }
  const operator = deps.operatorChatId()
  if (operator === undefined) {
    deps.log('rollout_status_edit — no operator chat (allowFrom empty)')
    reply(false, { gone: false, reason: 'no operator chat' })
    return
  }
  try {
    await deps.editMessage(operator, msg.messageId, msg.text)
    reply(true)
  } catch (err) {
    const cls = classifyRolloutEditError(err)
    if (cls === 'not-modified') {
      // The live card already carries this exact body — a success, not a loss.
      reply(true)
      return
    }
    deps.log(
      `rollout_status_edit failed (${cls}) request=${msg.requestId} message_id=${msg.messageId}: ${(err as Error).message}`,
    )
    reply(false, { gone: cls === 'gone', reason: (err as Error).message })
  }
}
