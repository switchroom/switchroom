/**
 * silent-reply-anchor.ts — pure decision predicate for the
 * "consecutive silent replies edit one growing message" UX fix.
 *
 * Background. Modern Claude 2.1.x on this fleet implements
 * conversational pacing (`reference/conversational-pacing.md` beats
 * 1 + 3 + 5) by calling the `reply` MCP tool multiple times in a
 * turn — a silent ack, silent per-step updates, and one pinged
 * final answer. The over-ping safety net (#1674) caps the
 * notifications at one. But the user still SEES N separate chat
 * bubbles for the silent replies, which reads as visual spam even
 * when no device pings. The operator's original complaint was
 * exactly this shape:
 *
 *   "I would like more regular process updates, where it edits a
 *    status message in place vs spamming multiple messages."
 *
 * Fix: consecutive silent replies within a turn EDIT a single
 * anchor message instead of each sending a fresh bubble. The
 * model's intent (silent mid-turn updates) is honoured; the
 * framework controls the visual placement (one growing bubble,
 * not many). Final pinged reply lands as a separate fresh bubble
 * (it's the final answer; the silent anchor is the preamble).
 *
 * Net visual for a multi-step turn:
 *   pre-fix:  4 bubbles (silent ack + 2 silent steps + 1 pinged final)
 *   post-fix: 2 bubbles (1 silent anchor with all 3 thoughts + 1 pinged final)
 *
 * Pinged replies always fresh-send. Reply-tool calls with files
 * or button keyboards bypass the anchor (fresh send) because the
 * edit path can't merge those cleanly.
 *
 * Accumulation format: `${anchorText}\n\n${newReplyText}` —
 * blank-line paragraph separator. Reads naturally as the model
 * "thinking out loud" with paragraph breaks per thought.
 *
 * Kill switch: `SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT=1` — turns
 * the safety net off; reverts to per-reply fresh send.
 */

/** Telegram caption / text limit. The accumulator stays under this. */
export const TELEGRAM_MSG_CAP = 4000

export interface SilentReplyAnchorDecisionInput {
  /** True when the model passed `disable_notification: true` for
   *  this reply (i.e. the model intends this to be silent — a
   *  beat 1/3 update). The over-ping safety net coerces other
   *  pings to silent; this predicate sees the EFFECTIVE flag, not
   *  the raw model intent. */
  effectivelySilent: boolean
  /** Wall-clock ms of the current anchor's existence, or null when
   *  no silent anchor has been set this turn. */
  anchorMessageId: number | null
  /** Text content of the current anchor (accumulated). Empty when
   *  no anchor exists. */
  anchorText: string
  /** Text content of the incoming reply, BEFORE any anchor merge. */
  newReplyText: string
  /** True if the incoming reply has attached files (photos,
   *  documents, etc). Anchor merge bypassed when true — edits
   *  can't add media to an existing text message. */
  hasFiles: boolean
  /** True if the incoming reply has an inline keyboard. Anchor
   *  merge bypassed when true — keyboard semantics across edits
   *  are too easy to get wrong, and the markup is rare enough
   *  that fresh-send is the safer default. */
  hasButtons: boolean
}

/**
 * What the caller should do with this reply.
 *
 *   - `kind: 'fresh'` — send a normal new message; if it should
 *     become the next anchor (silent + no attachments), the caller
 *     captures its message_id after send and sets the anchor.
 *
 *   - `kind: 'edit-anchor'` — DO NOT send; edit the existing
 *     anchor message with `mergedText` as the new content. The
 *     caller updates `anchor.text = mergedText` after a successful
 *     edit. messageId is the anchor's existing id.
 */
export type SilentReplyAnchorDecision =
  | { kind: 'fresh'; becomesAnchor: boolean }
  | { kind: 'edit-anchor'; messageId: number; mergedText: string }

function enabled(): boolean {
  const v = process.env.SWITCHROOM_DISABLE_SILENT_REPLY_AUTOEDIT
  return !(v === '1' || v === 'true')
}

/**
 * Decide whether to merge this reply into an existing silent
 * anchor or fresh-send. Pure: no IO, no mutation, kill-switch
 * checked per call.
 */
export function decideSilentReplyAnchor(
  input: SilentReplyAnchorDecisionInput,
): SilentReplyAnchorDecision {
  // Kill switch disengages the whole mechanism — every reply
  // falls through to fresh-send with no anchor capture.
  if (!enabled()) {
    return { kind: 'fresh', becomesAnchor: false }
  }

  // Pinged replies never merge — they're the final answer bubble,
  // semantically distinct from the silent preamble.
  if (!input.effectivelySilent) {
    return { kind: 'fresh', becomesAnchor: false }
  }

  // Files / buttons bypass the anchor — edit-text can't merge
  // media, and keyboards across edits are a foot-gun.
  if (input.hasFiles || input.hasButtons) {
    return { kind: 'fresh', becomesAnchor: false }
  }

  // Empty body — let the caller's existing validation handle it.
  // We treat as fresh-but-don't-anchor so a downstream "drop empty"
  // doesn't leave a stale anchor pointer.
  if (input.newReplyText.trim().length === 0) {
    return { kind: 'fresh', becomesAnchor: false }
  }

  // No anchor yet this turn → this reply BECOMES the anchor.
  if (input.anchorMessageId == null) {
    return { kind: 'fresh', becomesAnchor: true }
  }

  // Anchor exists → try to merge. The merge format is paragraph-
  // break separation. If the merged result would exceed the
  // Telegram text cap, give up on the anchor and start fresh —
  // the new reply becomes a new anchor.
  const merged = `${input.anchorText}\n\n${input.newReplyText}`
  if (merged.length > TELEGRAM_MSG_CAP) {
    return { kind: 'fresh', becomesAnchor: true }
  }
  return {
    kind: 'edit-anchor',
    messageId: input.anchorMessageId,
    mergedText: merged,
  }
}
