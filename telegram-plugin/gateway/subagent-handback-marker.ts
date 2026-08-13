/**
 * Per-chat-and-thread marker of the most recent gateway-synthesized
 * `subagent_handback` enqueue (fix/backstop-duplicate-reply).
 *
 * A BACKGROUND sub-agent completion is a GATEWAY-SYNTHESIZED event, not model
 * output: when a background worker terminates the gateway wakes the agent with a
 * `subagent_handback` inbound. Recording WHEN one was enqueued, per chat/thread,
 * is the ONE deterministic signal that distinguishes the two late-reply cases
 * that both resolve a flush-delivered ENDED turn via the latest-ended tier — the
 * case the owner-resolution tier alone cannot separate (a DM late reply has no
 * live/origin/quoted attribution, so both land on latest-ended):
 *
 *   - CASE A — the flushed turn's OWN reworded reply landing late. NO
 *     `subagent_handback` was enqueued for this chat/thread after the turn ended,
 *     so the reply is that turn's own answer → the supersede path collapses the
 *     provisional flush REGARDLESS of the model's rewording (closes the #3429
 *     reworded-duplicate regression: agent:marko 2026-07-20, turns
 *     #1177/#1182/#1201 double-sent).
 *   - CASE B — a background handback attributed to that ended turn. A
 *     `subagent_handback` WAS enqueued after the turn ended and within the
 *     handback recency window (`HANDBACK_RECENCY_WINDOW_MS` below, #4174), so
 *     the late reply might BE it → keep the #3429 content gate and send fresh
 *     (two messages), never silently edit/delete the flushed answer.
 *
 * ## Why thread-keyed (F2, dup-audit 2026-07-21)
 *
 * The supersede registry this marker gates is keyed on `chatId|threadId`
 * (`flushed-turn-supersede.ts` `makeKey`). Keying the marker on `chatId` ALONE
 * was inconsistent: in a forum supergroup a background handback in topic A
 * stamped the chat-wide marker, and a genuine CASE-A reworded own-reply in ANY
 * other topic within the 60 s TTL then computed `handbackCouldOwnReply = true` →
 * kept the content gate → shipped a second visible bubble instead of collapsing.
 * The blast radius was every topic in the chat for 60 s per handback. Keying on
 * `chatId + threadId` — the SAME lane the supersede registry uses — confines a
 * handback's gate-hold to the topic it actually landed in, so an unrelated
 * topic's CASE-A collapse is untouched. A DM (no thread) collapses to the
 * chat-only key, so single-lane behaviour is unchanged.
 *
 * One entry per chat/thread (overwritten on each enqueue), so bounded by
 * chat×topic count. No clock reads beyond the caller-supplied `now`; the gateway
 * wires the actual enqueue site and the supersede-path read. Deterministic —
 * keyed on a gateway-emitted event, never on model discipline (Ken's
 * controls-in-code rule).
 */
/**
 * ## The enforced invariant (F1, dup-audit 2026-07-21)
 *
 * The whole content-gate bypass rests on this premise: *a decoupled late reply
 * (turn == null) carrying content that is NOT the flushed turn's own answer,
 * resolving an ENDED flushed turn as its owner, can ONLY be a gateway-synthesized
 * completion — and every such completion stamps this marker.* If that premise
 * holds, then marker-ABSENCE in the window proves the late reply IS the flushed
 * turn's own (possibly reworded) answer, so bypassing the content gate is safe
 * (closes the marko duplicate). If a NEW synthesized-inbound source were ever
 * able to land as a decoupled late reply with foreign content WITHOUT stamping,
 * it would silently edit over a delivered answer (the #3429 failure).
 *
 * We make the premise an ENFORCED invariant rather than an architectural
 * coincidence by routing the stamp decision through this ONE predicate at the ONE
 * chokepoint every inbound funnels through (`pendingInboundBuffer.push` — live
 * synthesis, boot-replay, and every future source alike). The membership of the
 * decoupled-completion class is defined HERE and nowhere else:
 *
 *   - `subagent_handback` — the only source today that wakes the agent to emit a
 *     reply with NO live gateway turn of its own (a background worker completion),
 *     so its reply resolves a DIFFERENT, already-ended turn via the latest-ended
 *     tier. It is the F1 vector.
 *   - Every OTHER synthesized source that traverses THIS chokepoint (resume_*,
 *     reaction, vault_*, Tier-2 cron, …) lands as its OWN live inbound turn, so
 *     its reply resolves the `live` tier for its own turnId and structurally
 *     cannot supersede a different ended turn's flush record (`decideSupersede`
 *     requires `record.turnId === liveTurnId`). Those must NOT stamp — stamping
 *     them would needlessly hold the content gate open for an unrelated
 *     own-reply in the window (a safe but avoidable visible dup).
 *
 * ## What this chokepoint CANNOT see (#4172 — the caller-identity gate)
 *
 * The invariant above only covers sources delivered through
 * `pendingInboundBuffer.push`. A Tier-1 CHEAP-CRON fire is delivered via
 * `sendToAgent` to the derived `<agent>-cron` bridge and never traverses the
 * buffer — AND its session events are dropped for the cron identity in
 * `onSessionEvent`, so it never mints a live gateway turn either. Its `reply`
 * therefore arrives decoupled (turn == null) with foreign content and NO
 * marker — exactly the shape marker-absence was claimed to disprove. The same
 * holds for any reply arriving on a connection that is not the main agent
 * bridge. That class is closed at a DIFFERENT chokepoint: the reply send path
 * (`outbound-send-path.ts`) refuses supersede/bypass/latch authority to any
 * caller that is not the main agent bridge (`replyCallerIsForeignSession`,
 *  cron-session.ts) — identity, not marker stamping, is the deterministic
 * signal there. Setting `cron: { decoupledCompletion: true }` below would NOT
 * work: a Tier-1 fire never reaches this registry's write site.
 *
 * This predicate is therefore the SINGLE point of extension: any future feature
 * that synthesizes an inbound which can land as a DECOUPLED late reply (no live
 * turn) MUST add its `meta.source` here — and because the chokepoint consults
 * this predicate, doing so is the whole wiring. A source that forgets to opt in
 * cannot reach the bypass unnoticed: the negative outcome guard
 * (`send-reply-golden.test.ts`) pins that a decoupled foreign-content reply on a
 * non-live tier never silently edits over the flushed answer.
 *
 * ## Inbound meta.source classification registry (F1 durability — dup-audit
 * MUST-FIX 3, Fable 2026-07-21)
 *
 * The old predicate was a bare `=== 'subagent_handback'` with NO tripwire and an
 * UNSAFE default: adding a new decoupled-completion source tripped nothing — no
 * stamp → content-gate bypass eligible → silent edit-over of a delivered answer.
 * This registry makes the classification EXPLICIT, EXHAUSTIVE and FAIL-SAFE:
 *
 *   - Every known `meta.source` is listed with `decoupledCompletion`. Today ONLY
 *     `subagent_handback` is true; every other synthesized source lands as its
 *     OWN live inbound turn (live tier → cannot supersede a different ended
 *     turn's record), so it must NOT stamp.
 *   - An UNKNOWN / unclassified source FAILS SAFE: `stampsHandbackMarker` returns
 *     `true`, so it STAMPS → the content gate is KEPT → the worst case is a
 *     visible duplicate, NEVER a silent edit-over (inverted from the old
 *     deny-default, which failed toward silent loss).
 *   - The exhaustiveness test (`subagent-handback-marker.test.ts`) scans the
 *     gateway for `source:` / `meta.source ===` literals and FAILS when a new one
 *     is added without a registry entry — forcing a conscious classification.
 *
 * Defense-in-depth with the tier restriction (`outbound-send-path.ts`): the
 * content-gate bypass is now limited to the `live` + `latest-ended` tiers, so
 * model-steerable `quoted`/`origin` attributions can never bypass regardless of
 * the marker. This registry closes the residual `latest-ended` vector for a
 * FUTURE decoupled source, fail-safe.
 */
export const INBOUND_SOURCE_CLASSIFICATION: Record<string, { decoupledCompletion: boolean }> = {
  // The ONE decoupled-completion source today: a background worker termination
  // wakes the agent with no live turn of its own → its reply resolves a
  // different, already-ended turn via the latest-ended tier. THE F1 vector.
  subagent_handback: { decoupledCompletion: true },
  // Everything below lands as its OWN live inbound turn (live tier), so its reply
  // resolves the live tier for its own turnId and structurally cannot supersede a
  // different ended turn's record → not a decoupled-completion vector, must not stamp.
  //
  // cron: `false` covers the TIER-2 (main-bridge, `context:'agent'`) fire, which
  // does land as its own live turn through this chokepoint. The TIER-1 cheap-cron
  // fire never traverses this chokepoint AT ALL (see "What this chokepoint
  // CANNOT see" above) — it is closed by the caller-identity gate in the reply
  // send path (#4172), and flipping this to `true` would not reach it.
  cron: { decoupledCompletion: false },
  reaction: { decoupledCompletion: false },
  subagent_progress: { decoupledCompletion: false },
  resume_interrupted: { decoupledCompletion: false },
  resume_deferred: { decoupledCompletion: false },
  resume_watchdog_timeout: { decoupledCompletion: false },
  vault_grant_approved: { decoupledCompletion: false },
  vault_grant_denied: { decoupledCompletion: false },
  vault_grant_timeout: { decoupledCompletion: false },
  vault_save_completed: { decoupledCompletion: false },
  vault_save_discarded: { decoupledCompletion: false },
  vault_save_failed: { decoupledCompletion: false },
  vault_save_timeout: { decoupledCompletion: false },
  secret_provided: { decoupledCompletion: false },
  secret_declined: { decoupledCompletion: false },
  secret_provide_failed: { decoupledCompletion: false },
  secret_request_timeout: { decoupledCompletion: false },
  mental_model_propose_timeout: { decoupledCompletion: false },
  bridge_dead_restart: { decoupledCompletion: false },
  obligation_represent: { decoupledCompletion: false },
  missed_approval_retry: { decoupledCompletion: false },
  skill_proposal_apply: { decoupledCompletion: false },
  warmup: { decoupledCompletion: false },
  // dup-audit pass-2 (Fable) — sources the widened exhaustiveness scanner now
  // sees. Each lands as its OWN live inbound turn (not a decoupled completion
  // resolving a DIFFERENT ended turn), so it must NOT stamp — else its fail-safe
  // stamp would hold the content gate chat-wide for 60 s and re-open the
  // reworded-own-answer visible dup in that window.
  //   - mental_model_proposal_{applied,denied,failed}: resume-synthetic inbounds
  //     injected via `deliverResumeSyntheticOrBuffer` as their own live turn.
  //   - webhook / linear: built in `src/web/webhook-dispatch.ts`, delivered via
  //     the gateway's `webhookInject` (`sendToAgent`, buffer on miss) as their
  //     own live turn.
  mental_model_proposal_applied: { decoupledCompletion: false },
  mental_model_proposal_denied: { decoupledCompletion: false },
  mental_model_proposal_failed: { decoupledCompletion: false },
  webhook: { decoupledCompletion: false },
  linear: { decoupledCompletion: false },
  // Eval-case proposal outcomes (#4662) — the operator's Approve/Dismiss tap on
  // an eval-case card wakes the PROPOSING agent with one of these, built in
  // `eval-case-proposal-inbound-builders.ts` and injected via
  // `deliverResumeSyntheticOrBuffer`. Exactly the `skill_proposal_apply` shape
  // above: each lands as its OWN live inbound turn, so its reply resolves the
  // live tier for its own turnId and structurally cannot supersede a different
  // ended turn — it must NOT stamp. (Left unclassified, the fail-safe default
  // stamps, holding the content gate chat-wide for 60 s after every eval-case
  // decision and re-opening the reworded-own-answer visible dup in that window.)
  eval_case_applied: { decoupledCompletion: false },
  eval_case_rejected: { decoupledCompletion: false },
  eval_case_apply_failed: { decoupledCompletion: false },
  // Eval-case proposal SUPPRESSED (#4664): the gateway declined to post a card
  // because the operator already dismissed this exact case, and tells the
  // proposing agent so instead of exiting silently
  // (buildEvalCaseSuppressedInbound, self-improve-proposal-wiring.ts). Delivered
  // via `deliverResumeSyntheticOrBuffer` as its OWN live inbound turn, same as
  // skill_proposal_apply above — it must NOT stamp.
  eval_case_suppressed: { decoupledCompletion: false },
  // Buzz co-channel (Phase 1): a Nostr kind:9 group message the buzz sidecar
  // injects onto the gateway IPC queue as its OWN live inbound turn (anonymous
  // inject, `meta.source="buzz"`) — never a decoupled completion resolving a
  // different ended turn, so it must NOT stamp.
  buzz: { decoupledCompletion: false },
  // Gateway boot briefing (session_continuity.briefing: gateway): a synthetic
  // FIRST user turn the gateway assembles from durable history and injects over
  // the spool (`<channel source="boot_briefing">`, boot-briefing-builder.ts).
  // Like the resume_* synthetics it lands as its OWN live inbound turn — its
  // briefing reply resolves the live tier for its own turnId and cannot
  // supersede a different ended turn's record — so it must NOT stamp.
  boot_briefing: { decoupledCompletion: false },
}

/**
 * Whether an inbound of this `meta.source` must stamp the decoupled-completion
 * marker. Null/undefined (a normal user inbound — not synthesized) → false.
 * A known source → its registry classification. An UNKNOWN source → true
 * (fail-safe: stamp, so an unclassified future decoupled source can only cause a
 * visible dup, never a silent edit-over).
 */
export function stampsHandbackMarker(source: string | null | undefined): boolean {
  if (source == null) return false
  const known = INBOUND_SOURCE_CLASSIFICATION[source]
  if (known == null) return true // fail-safe: unknown synthesized source stamps
  return known.decoupledCompletion
}

/**
 * #4174 — how long after a `subagent_handback` enqueue the content gate stays
 * held for late replies attributed to an ended turn (`handbackCouldOwnReply`,
 * outbound-send-path.ts). This deliberately does NOT follow the supersede
 * window's bounds (#4173): the gate-hold is CHAT-WIDE (the latest-ended owner
 * tier is chat-wide, so the read must be too — MUST-FIX 2 above), which means
 * every in-window handback re-opens the reworded-own-answer visible-duplicate
 * class for EVERY topic in the chat for the window's length. 60 s — the
 * originally shipped bound — covers the enqueue→decoupled-reply gap the marker
 * exists for, while keeping the chat-wide dup exposure per handback small. In
 * a delegation-heavy agent, tying this to a minutes-long supersede bound would
 * hold the gate almost continuously — re-opening the exact duplicate class the
 * supersede machinery closes.
 */
export const HANDBACK_RECENCY_WINDOW_MS = 60_000

// ───────────────────────────────────────────────────────────────────────────
// CLI task-notification dedup ledger (double-wake fix, v0.20.8 candidate)
// ───────────────────────────────────────────────────────────────────────────
//
// One background sub-agent completion used to produce TWO independent wakes of
// the parent session:
//   1. The claude CLI's OWN `<task-notification>` — the CLI proactively
//      enqueues it into the parent session when a backgrounded task/agent
//      completes (projected as a `task_notification` SessionEvent at the
//      queue-operation enqueue line, session-tail.ts). The parent wakes,
//      sees the notification + summary, and typically reports to the user.
//   2. The gateway-synthesized `subagent_handback` inbound (subagent-watcher
//      `onFinish` → pendingInboundBuffer.push) — switchroom's deliberate
//      beat-4 wake, added because older CLIs surfaced a background result
//      only on the parent's NEXT user turn.
// Nothing linked them, so a single completion fanned out to two turns and two
// user-visible replies. The CLI-native wake cannot be suppressed (it is the
// CLI's internal queue); the ONE lever switchroom holds is the handback
// enqueue. This ledger records every terminal `<task-notification>` the
// session tail observes, keyed by its `<task-id>` — which is EXACTLY the
// sub-agent watcher's `agentId` (both are the `agent-<id>.jsonl` stem;
// verified against live transcripts: `<task-id>a204deeaedb27b580</task-id>`
// ↔ `subagents/agent-a204deeaedb27b580.jsonl`). `decideSubagentHandback`
// then skips the redundant handback ONLY on an exact-id hit inside a short
// TTL.
//
// FAIL-OPEN by construction — every uncertain path DELIVERS the handback:
//   - no notification seen for this exact id → deliver (a dropped real wake
//     means a silent worker and a user waiting forever; an occasional double
//     is strictly better);
//   - notification older than the TTL → deliver (a resumed worker's second
//     completion must not be swallowed by its first completion's entry);
//   - non-terminal notification status → never recorded, so → deliver;
//   - gateway restart (ledger is in-memory) → boot-replayed handbacks
//     deliver;
//   - the CLI notification landing AFTER the handback enqueue (lost race) →
//     deliver (the residual occasional double, accepted).
// The liveness consumer (background-shell-liveness.ts) is untouched: the same
// `task_notification` event still drives noteBackgroundShellDead —
// recording here is an independent, additive read of the event.

/**
 * How long a recorded terminal `<task-notification>` suppresses the matching
 * `subagent_handback`. The real gap between the CLI's notification enqueue
 * and the watcher's `onFinish` (its ~1s jsonl rescan) is a few seconds; 30s
 * covers scheduler jitter with a wide margin while staying far below any
 * plausible resume-and-complete-again cycle for the same agent id, so a
 * resumed worker's second completion falls outside the window → fail-open.
 */
export const TASK_NOTIFICATION_DEDUP_TTL_MS = 30_000

/** `<task-notification>` statuses that mean the task genuinely ended and the
 *  CLI woke (or will wake) the parent with the completion. Mirrors the
 *  liveness consumer's terminal set (background-shell-liveness.ts). */
const NOTIF_TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed'])

/**
 * In-memory seen-set of terminal CLI `<task-notification>` task ids.
 * Deliberately process-local: absence after a restart fails open (deliver).
 */
export class CliTaskNotificationLedger {
  private readonly seen = new Map<string, number>()

  /** Record a parsed `task_notification` session event. Non-terminal
   *  statuses and empty ids are ignored (they must never suppress). */
  record(taskId: string, status: string, now: number): void {
    if (taskId.length === 0 || !NOTIF_TERMINAL_STATUSES.has(status)) return
    this.seen.set(taskId, now)
    // Bounded: prune expired entries on write so the map tracks only the
    // live window (a handful of ids), never the process lifetime.
    for (const [id, ts] of this.seen) {
      if (now - ts > TASK_NOTIFICATION_DEDUP_TTL_MS) this.seen.delete(id)
    }
  }

  /** True iff a terminal notification for EXACTLY `taskId` was recorded
   *  within the TTL. Anything else → false → the handback delivers. */
  seenRecently(taskId: string, now: number): boolean {
    const ts = this.seen.get(taskId)
    return ts != null && now - ts <= TASK_NOTIFICATION_DEDUP_TTL_MS
  }
}

/**
 * The gateway's process-wide ledger instance (one gateway process per agent,
 * one main session — a module singleton keeps the gateway.ts wiring to two
 * lines under the anti-inflation ratchet, #2996). Written at the gateway's
 * `onSessionEvent` (OUTSIDE the currentTurn guard — the CLI enqueues the
 * notification while the parent is typically idle with no live gateway turn);
 * read at the `onFinish` handback decide site. Tests construct their own
 * `CliTaskNotificationLedger` instances.
 */
export const cliTaskNotifLedger = new CliTaskNotificationLedger()

/** Sentinel thread key for the no-thread (DM / bare-chat) lane. */
const MAIN_THREAD_KEY = '<main>'

export class SubagentHandbackMarker {
  // chatId → (threadKey → last enqueue ms). Nested so the CONTENT-GATE read can
  // query chat-wide (`lastAtInChat`) while the record stays thread-resolved.
  private readonly byChat = new Map<string, Map<string, number>>()

  private threadKey(threadId: number | undefined): string {
    return threadId == null ? MAIN_THREAD_KEY : String(threadId)
  }

  /** Record that a `subagent_handback` was enqueued for `chatId`/`threadId` at
   *  `now` (ms). Thread-resolved so the record retains the originating topic. */
  record(chatId: string, threadId: number | undefined, now: number): void {
    let inner = this.byChat.get(chatId)
    if (inner == null) {
      inner = new Map<string, number>()
      this.byChat.set(chatId, inner)
    }
    inner.set(this.threadKey(threadId), now)
  }

  /** Wall-clock ms of the most recent handback enqueue for a SPECIFIC
   *  `chatId`/`threadId` lane, or null. (Diagnostics / unit tests.) */
  lastAt(chatId: string, threadId: number | undefined): number | null {
    return this.byChat.get(chatId)?.get(this.threadKey(threadId)) ?? null
  }

  /**
   * Wall-clock ms of the most recent handback enqueue ANYWHERE in `chatId`
   * (across every topic lane), or null. This is what the content-gate read uses
   * (dup-audit MUST-FIX 2, Fable 2026-07-21): the owner-resolution latest-ended
   * tier is CHAT-WIDE (`findLatestTurnForChat` ignores thread), so a
   * background handback in topic A can resolve — and supersede — topic B's
   * ended turn. A thread-SPECIFIC gate read (the F2 regression) let a reply
   * dodge that handback by carrying a different `message_thread_id`, silently
   * editing over the answer. Querying chat-wide makes the gate un-steerable by
   * the reply's own thread arg: any in-window handback in the chat keeps the
   * content gate. The cost is the F2 visible-dup (a handback in one topic keeps
   * the gate for a coinciding own-reply in another for ≤TTL) — a self-healing
   * visible duplicate, which is strictly better than a silent edit-over.
   */
  lastAtInChat(chatId: string): number | null {
    const inner = this.byChat.get(chatId)
    if (inner == null || inner.size === 0) return null
    let max = -Infinity
    for (const ts of inner.values()) if (ts > max) max = ts
    return max === -Infinity ? null : max
  }
}
