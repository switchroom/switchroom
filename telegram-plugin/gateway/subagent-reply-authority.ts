/**
 * #4176 — sub-agent reply authority: the discriminator the "serial session"
 * premise was missing.
 *
 * ## The premise that was false
 *
 * The turn-completion window (#4173, `flushed-turn-supersede.ts`) rests on this
 * claim: a `reply` landing on the MAIN agent bridge between a flush's SYNTHETIC
 * turn_end and the session's REAL turn_end is, by construction, that turn's own
 * answer still being composed. The stated justification was that no other work
 * can run on the serial claude session in that span.
 *
 * That is true of the session's OWN loop and false of its sub-agents. A
 * background `Task` sub-agent runs CONCURRENTLY with the parent loop, and it
 * calls MCP tools through the SAME plugin process and therefore the SAME IPC
 * bridge — so `client.agentName` is the main agent and the #4172 caller-identity
 * gate (`replyCallerIsForeignSession`) does not see it. In this fleet the
 * `researcher` and `reviewer` sub-agent types hold the full tool set, `reply`
 * included (`worker` holds only `progress_update`).
 *
 * The concrete loss that made this a MAJOR (review of #4167): the quiescence
 * flush delivers the answer as message A and the window is OPEN; a background
 * sub-agent calls `reply` into the same chat; owner resolution lands on the
 * flush-ended turn (OPEN is accepted at ANY age up to the crash cap); no
 * `subagent_handback` marker exists because a DIRECT tool call never traverses
 * `pendingInboundBuffer.push`; `decideContentGateBypass` therefore grants
 * `positiveAttribution`, and `decideSupersede` supersedes REGARDLESS of content
 * — the sub-agent's message silently EDITS OVER the user's flushed answer
 * (Telegram edits do not re-notify: both messages are lost client-side). The
 * class pre-exists on `main` bounded by the old 60 s TTL; #4173 extends the tail
 * to the OPEN-phase cap, which is why it is closed here rather than narrowed.
 *
 * ## The discriminator: gateway-observed sub-agent LIVENESS
 *
 * The gateway already receives the whole session-event stream, including every
 * `sub_agent_*` kind, at `onSessionEvent` → `handleSessionEvent`. Those events
 * are derived by the framework from the sidechain transcript
 * (`projectSubagentLine`, session-tail.ts) — never from model discipline, never
 * from anything a reply can steer.
 *
 * A sub-agent is tracked LIVE from any `sub_agent_*` event carrying its
 * `agentId` until its `sub_agent_turn_end`. While ANY sub-agent is live, a
 * decoupled reply on the main bridge MIGHT be that sub-agent's, so it is denied
 * the #3429 content-gate bypass (`decideContentGateBypass`) — the reply must
 * then BE the flushed answer to supersede it. A sub-agent's own (foreign)
 * content therefore decides `'new-content'` and ships as a fresh, notifying
 * message, with the flush record left intact for the turn's genuine replay.
 *
 * ### Why liveness and not per-reply correlation
 *
 * Correlating the landing MCP call with the `sub_agent_tool_use` event for that
 * same `reply` would be exact, but the two arrive on independent transports (an
 * MCP stdio round-trip vs. a JSONL tail), so the event can land AFTER the reply
 * it describes — a race whose losing side is the silent edit-over. Liveness has
 * the ordering the correlation lacks: a sub-agent cannot call a tool before it
 * exists, and `sub_agent_started` is projected from its FIRST transcript line,
 * which precedes any tool call it makes by a full model round-trip. The gate is
 * therefore armed by the time the reply can exist — a structural ordering
 * argument, not a tuned delay.
 *
 * ### Failure directions (all fail SAFE)
 *
 *   - A sub-agent whose `sub_agent_turn_end` is never observed (capped, killed,
 *     crashed tail) stays live: the content gate holds, so the worst case is a
 *     REWORDED own-answer shipping as a visible duplicate. Never an edit-over.
 *     `reset()` on bridge death bounds it — the sub-agents die with the session.
 *   - A sub-agent steered after its `turn_end` (switchroom's `SendMessage`
 *     pattern) re-arms on its next `sub_agent_*` event, which again precedes any
 *     reply it makes by a model round-trip.
 *   - No sub-agent live ⇒ the premise HOLDS and the #4166 collapse is untouched;
 *     this gate costs nothing in the non-delegating case.
 *
 * ### Residual, stated honestly
 *
 * Denying the BYPASS (rather than supersede authority wholesale) is deliberate:
 * with the gate on, a reply still supersedes when it IS the flushed answer
 * (`flushedAnswerMatchesReply` — equality, or containment above
 * `SUPERSEDE_MATCH_MIN_CONTAINMENT_CHARS`). Superseding on equality is
 * content-preserving by definition. The residual is the containment arm: a
 * sub-agent reply that is a ≥32-char verbatim substring of the flushed answer
 * would still collapse into it. Denying supersede outright instead would, in a
 * delegation-heavy agent where a background worker is nearly always live,
 * re-open #4166 for every own-answer replay — a far larger, constant cost for a
 * class that requires a sub-agent to emit a verbatim substring of the parent's
 * answer.
 *
 * Pure: a set of ids, no clock reads, no I/O. The gateway wires the feed
 * (`onSessionEvent`) and the read (the `sendReply` deps).
 */

/** The read surface the reply send path consumes (injected, so the golden
 *  harness drives it without touching the singleton). */
export interface SubagentReplyAuthorityView {
  /** True when at least one sub-agent is live on this session and could
   *  therefore be the author of a decoupled reply landing right now. */
  subagentCouldOwnReply(): boolean
}

/** The minimal session-event shape this tracker reads. Structural so the module
 *  never imports the session-tail union (no cycle, trivially fake-able). */
export interface SubagentLifecycleEvent {
  kind: string
  agentId?: string
}

const SUB_AGENT_KIND_PREFIX = 'sub_agent_'

export class SubagentReplyAuthority implements SubagentReplyAuthorityView {
  private readonly live = new Set<string>()

  /** Feed EVERY session event here. Non-`sub_agent_*` kinds are ignored, so the
   *  call site needs no filtering (and cannot drift from this one). */
  noteSessionEvent(ev: SubagentLifecycleEvent | null | undefined): void {
    if (ev == null) return
    const kind = ev.kind
    if (typeof kind !== 'string' || !kind.startsWith(SUB_AGENT_KIND_PREFIX)) return
    const agentId = ev.agentId
    // An id-less sub-agent event cannot be attributed to a lifecycle; ignoring
    // it is the safe direction for `turn_end` (liveness persists → gate holds)
    // and merely a missed arm otherwise — every other kind for a real sub-agent
    // carries the id.
    if (typeof agentId !== 'string' || agentId === '') return
    if (kind === `${SUB_AGENT_KIND_PREFIX}turn_end`) this.live.delete(agentId)
    else this.live.add(agentId)
  }

  subagentCouldOwnReply(): boolean {
    return this.live.size > 0
  }

  /** The bridge died: the claude session and every sub-agent under it are gone.
   *  Bounds a leaked liveness entry (see "Failure directions"). */
  reset(): void {
    this.live.clear()
  }

  /** Test/diagnostics: how many sub-agents are currently tracked live. */
  liveCount(): number {
    return this.live.size
  }
}

/** The ONE live instance (one CLI session per gateway process — the same
 *  module-singleton shape as `flushCompletionTracker` in stream-render.ts).
 *  Re-`new`ing this anywhere else splits the signal and silently re-opens the
 *  edit-over hole. */
export const subagentReplyAuthority = new SubagentReplyAuthority()
