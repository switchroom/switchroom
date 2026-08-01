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
 * Why this call opts out of TWO swallows
 * --------------------------------------
 * This handler infers edit success from the ABSENCE of a throw. That inference
 * is only sound if every "the edit did not land" path actually throws — and
 * the production stack has two layers that RESOLVE instead. Both are opted out
 * of explicitly at the `robustApiCall` call site in gateway.ts, because either
 * one alone is enough to make `gone` — the entire reason this module exists —
 * unreachable in production.
 *
 *  1. `priorityClass: 'critical'` — never inherit the untagged default
 *     (`UNTAGGED_SEND_CLASS`, today `'critical'`). A SHED send does not throw:
 *     the send gate returns `SEND_GATE_SHED` without ever calling Telegram. If
 *     a future change to that default made this call sheddable, the handler
 *     would reply `ok:true` for an edit that never happened.
 *
 *  2. `rethrowBenign400: true` — the retry policy's benign-400 swallow
 *     (`classifyBenignTelegram400`, retry-api-call.ts) treats
 *     `400 "message to edit not found"` as a non-event and resolves
 *     `undefined`. That description is EXACTLY the deleted-card case, i.e. the
 *     primary trigger for `gone`. Without the opt-out the seeded-resume
 *     scenario this module was written for — carried `narration_message_id`,
 *     operator deleted the card — threw nothing at all, so the handler replied
 *     `ok:true` and hostd recorded a frozen card as live. That is WORSE than
 *     pre-fix: hostd positively believes the card is fine.
 *
 * Both failures are silent by construction — green tests over an inert
 * feature — so neither is pinned by inspection alone.
 * `tests/rollout-status-edit-retry-policy.test.ts` drives the REAL retry
 * policy + send gate with a REAL `GrammyError` and asserts a deleted card
 * produces a re-post; `tests/rollout-narration-edit-socket.test.ts` pins the
 * transport that carries the reply back to hostd.
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
  /**
   * Perform the edit.
   *
   * CONTRACT — resolve IFF the edit landed, reject otherwise. This handler has
   * no other channel: it reads success from the absence of a throw. So the
   * implementation must be wrapped in the retry policy AND must opt out of
   * every layer that turns a failed edit into a resolved promise —
   * `priorityClass: 'critical'` (no shed) and `rethrowBenign400: true` (no
   * benign-400 swallow). See the "TWO swallows" note at the top of this file.
   */
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
