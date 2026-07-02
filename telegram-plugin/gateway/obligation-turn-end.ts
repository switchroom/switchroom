/**
 * Pure decision for what a turn_end does to the ending turn's delivery
 * obligation (#2624).
 *
 * Two branches, both must be pinned by tests:
 *
 *   - **Normal reply** — the turn either delivered a genuine final answer
 *     (`finalAnswerDelivered`) OR the model explicitly called reply
 *     (`replyCalled`, true even for a short LiteLLM sr-* `reply("OK",
 *     {disable_notification:true})` that `isFinalAnswerReply` demoted to
 *     non-final). Either way the obligation is satisfied → close it at
 *     turn_end.
 *
 *   - **Ack-then-ghost / no-reply** — the turn ended with no reply at all
 *     (no ack, no answer). The obligation must NOT close at turn_end; it
 *     stays open and the idle sweep later ends it via the silence_fallback
 *     path. At turn_end we only stamp the grace clock (`note-ended`).
 *
 * Returns the action the caller applies to the ledger. Pure — no ledger
 * mutation, no module state.
 */
export function decideObligationTurnEnd(
  finalAnswerDelivered: boolean,
  replyCalled: boolean,
): 'close' | 'note-ended' {
  return finalAnswerDelivered || replyCalled ? 'close' : 'note-ended'
}
