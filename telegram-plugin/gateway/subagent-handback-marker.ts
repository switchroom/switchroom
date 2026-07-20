/**
 * Per-chat marker of the most recent gateway-synthesized `subagent_handback`
 * enqueue (fix/backstop-duplicate-reply).
 *
 * A BACKGROUND sub-agent completion is a GATEWAY-SYNTHESIZED event, not model
 * output: when a background worker terminates the gateway wakes the agent with a
 * `subagent_handback` inbound. Recording WHEN one was enqueued, per chat, is the
 * ONE deterministic signal that distinguishes the two late-reply cases that both
 * resolve a flush-delivered ENDED turn via the latest-ended tier — the case the
 * owner-resolution tier alone cannot separate (a DM late reply has no
 * live/origin/quoted attribution, so both land on latest-ended):
 *
 *   - CASE A — the flushed turn's OWN reworded reply landing late. NO
 *     `subagent_handback` was enqueued for this chat after the turn ended, so the
 *     reply is that turn's own answer → the supersede path collapses the
 *     provisional flush REGARDLESS of the model's rewording (closes the #3429
 *     reworded-duplicate regression: agent:marko 2026-07-20, turns
 *     #1177/#1182/#1201 double-sent).
 *   - CASE B — a background handback attributed to that ended turn. A
 *     `subagent_handback` WAS enqueued after the turn ended and within the
 *     supersede TTL, so the late reply might BE it → keep the #3429 content gate
 *     and send fresh (two messages), never silently edit/delete the flushed
 *     answer.
 *
 * One entry per chat (overwritten on each enqueue), so bounded by chat count. No
 * clock reads beyond the caller-supplied `now`; the gateway wires the actual
 * enqueue site and the supersede-path read. Deterministic — keyed on a
 * gateway-emitted event, never on model discipline (Ken's controls-in-code rule).
 */
export class SubagentHandbackMarker {
  private readonly lastAtByChat = new Map<string, number>()

  /** Record that a `subagent_handback` was enqueued for `chatId` at `now` (ms). */
  record(chatId: string, now: number): void {
    this.lastAtByChat.set(chatId, now)
  }

  /** Wall-clock ms of the most recent handback enqueue for `chatId`, or null. */
  lastAt(chatId: string): number | null {
    return this.lastAtByChat.get(chatId) ?? null
  }
}
