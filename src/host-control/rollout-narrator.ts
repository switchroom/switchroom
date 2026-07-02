/**
 * #2726 Part 2 — the log-tailed rollout NARRATION surface.
 *
 * ONE ordinary operator-DM message, edited in place through the phases
 * (`applying → canary → agent N/M → persisting pin → hostd/web deferred →
 * ✅ done`, or `❌` with the failed step/agent). NOT pinned, NOT a bespoke card —
 * in-chat narration, the `chat-is-the-single-source-of-truth` invariant's own
 * prescribed remedy (a plain message the operator can scroll to).
 *
 * WHERE the tail-and-render lives (design point 7): in hostd. hostd owns the
 * rollout request lifecycle and the durable audit log it writes per phase (the
 * single source of truth), and it already owns the gateway relay path it uses
 * for approval cards. So hostd tails ITS OWN rows (it is fed each phase as it
 * parses the child's stdout — the same event that appends the durable row) and
 * relays edit ops to the caller agent's live gateway.
 *
 * State + restart guarantee (be precise — this is NOT stateless): the narrator
 * DOES hold in-memory state for the current request — the message_id it is
 * editing and the last-applied seq. That state is ephemeral: a hostd restart
 * mid-roll loses it, so the post-restart narrator can't re-edit the original
 * message and instead RE-POSTS a fresh narration message (the in-chat surface
 * may duplicate on restart). What IS durable is the rollout status the
 * operator can query: the per-phase rows hostd writes are the single source of
 * truth, so `get_status(request_id)` recovers the roll's true state fully
 * regardless of any narration re-post. Summary: durable get_status recovers
 * fully; in-chat narration may re-post (not seamlessly re-edit) on a hostd
 * restart. We do NOT rely on a "recreate overlord last" assumption (it's
 * false) — the narrator lives in hostd, not overlord.
 *
 * Discipline (locked by the IPC review), all enforced here:
 *   - fire-and-forget: emits/edits are `void`, never awaited by the roll.
 *   - idempotent + monotonic by seq: an update with seq <= lastApplied is
 *     dropped.
 *   - frozen on terminal: once the final row is applied, no later edit can
 *     un-finalize the message.
 *   - debounced (trailing edge) so a 12-agent roll doesn't hammer Telegram's
 *     single-message edit rate limit; 429 `retry_after` is honored inside the
 *     renderer and never surfaced back toward the roll.
 *   - bound to a hostd-attested in-flight request_id: hostd only ever feeds
 *     phases for a real roll it is driving; a shape-only client IPC message
 *     can't reach this path.
 */

import type { RolloutNarrator } from "./server.js";
import type { StatusEntry } from "./server.js";
import type { RolloutPhase } from "../cli/rollout.js";
import {
  renderRolloutStatus,
  type RolloutRenderState,
} from "./render-rollout-status.js";

/**
 * The transport the narrator drives — a live gateway relay that can POST the
 * first status message (and learn its message_id) and EDIT it afterwards.
 * Both are fire-and-forget from the narrator's perspective; the post resolves
 * with a message_id (or null) so the narrator knows whether it can edit.
 */
export interface RolloutNarrationRelay {
  /**
   * Post ONE ordinary operator-DM message. Resolves with the Telegram
   * message_id (so the narrator can edit it) or null when the post failed /
   * no message_id came back. MUST NOT throw.
   */
  post(args: {
    requestId: string;
    agentName: string;
    text: string;
  }): Promise<number | null>;
  /**
   * Edit a previously-posted message in place. Fire-and-forget: MUST NOT throw
   * and MUST NOT surface an edit failure (incl. 429) back to the caller.
   */
  edit(args: {
    requestId: string;
    agentName: string;
    messageId: number;
    text: string;
  }): void;
}

/** Debounce window (trailing edge) for edits — long enough that a fast
 *  N-agent roll coalesces intermediate phases into one edit, short enough
 *  that the operator still sees live progress. */
const DEFAULT_DEBOUNCE_MS = 1500;

/**
 * HARD ceiling on post() calls per request — the anti-re-post-storm cap. Two
 * attempts is enough: the initial first-contact post, plus one reserved retry
 * on the terminal phase for a genuinely-missed initial post (so the operator
 * still gets a final ✅/❌). Anything beyond that would be duplicate operator
 * DMs on a roll where the relay gateway is flaky/being-recreated — worse than
 * silence, and the durable audit log is the record either way.
 */
const MAX_POST_ATTEMPTS = 2;

/** Per-request narration state. */
interface NarrationState {
  agentName: string;
  /** Highest phase-sequence applied so far (monotonic gate). */
  lastAppliedSeq: number;
  /** The message_id once the first post lands; null until then. */
  messageId: number | null;
  /** True while a post() is in flight (so we don't double-post). */
  posting: boolean;
  /**
   * Total post() calls dispatched for this request — the HARD ceiling against
   * a re-post storm. A post() that resolves null (gateway restarted mid-roll,
   * or the rollout_status_posted reply timed out at 5s while the send actually
   * reached Telegram) leaves messageId null; without this cap every subsequent
   * phase would re-enter the post branch → ~one duplicate DM per agent. Capped
   * at MAX_POST_ATTEMPTS.
   */
  postAttempts: number;
  /**
   * True once a post() resolved null. We then STOP re-posting on every phase
   * (edits are impossible without a messageId anyway) and back off, reserving
   * at most one final post attempt on the terminal phase so a genuinely-missed
   * post still yields a final ✅/❌ message.
   */
  postFailed: boolean;
  /** The latest render state (rebuilt as phases arrive). */
  render: RolloutRenderState;
  /** Frozen once the terminal row is applied — no later edit may un-finalize. */
  frozen: boolean;
  /** Pending debounce timer for a trailing-edge edit. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Phases buffered before the first post's message_id arrived. */
  pendingEditAfterPost: boolean;
}

/**
 * Log-tailed narrator. Instantiated once per hostd process; keyed by
 * request_id so concurrent rolls (there is only ever one, per the
 * fleet-mutation lock, but be defensive) don't cross-edit.
 */
export class LogTailRolloutNarrator implements RolloutNarrator {
  private states = new Map<string, NarrationState>();

  constructor(
    private relay: RolloutNarrationRelay,
    private opts: { debounceMs?: number; log?: (m: string) => void } = {},
  ) {}

  /**
   * Monotonic sequence for a phase, so out-of-order / duplicate phases drop.
   * hostd feeds phases in stdout order; this is defense-in-depth.
   *
   * The dominant axis is the roll TIMELINE, and for per-agent phases that is
   * the agent's roll-order index `n` (1-based). So the sequence is
   * `timelineBase + n*2 + within`, where `within` distinguishes the -start /
   * -done pair for the SAME agent. This keeps `agent-start(n=2)` strictly after
   * `agent-done(n=1)` — the bug a phase-enum-major ordering had (a later
   * agent's start could sort before an earlier agent's done and get dropped).
   *
   * The canary is agent n=1, so canary-start/pass/fail slot naturally into the
   * n=1 window. persist-pin (hostd path: after the canary) and
   * hostd-web-deferred (end) get fixed high/low anchors outside the per-agent
   * band so they never collide with an agent index.
   */
  private static seqFor(phase: RolloutPhase): number {
    switch (phase.phase) {
      case "apply":
        return 0; // always first
      case "canary-start":
        return 2 * 1 + 0; // n=1 window, start
      case "canary-pass":
      case "canary-fail":
        return 2 * 1 + 1; // n=1 window, done
      case "persist-pin":
        // hostd path: right after the canary confirms (between n=1 and n=2).
        return 2 * 1 + 1; // co-timed with canary-done; monotonic, never regresses
      case "agent-start":
        return 2 * (phase.n ?? 1) + 0;
      case "agent-done":
        return 2 * (phase.n ?? 1) + 1;
      case "hostd-web-deferred":
        return Number.MAX_SAFE_INTEGER - 1; // near the end, before terminal
      default:
        return 0;
    }
  }

  onPhase(entry: StatusEntry, phase: RolloutPhase): void {
    try {
      const st = this.ensureState(entry);
      if (st.frozen) return; // terminal already applied — never un-finalize.

      // Monotonic gate. seqFor already folds the roll-order index `n` into the
      // timeline, so a strictly-earlier phase (stale / out-of-order) drops.
      //
      // The comparison is strict `<` ON PURPOSE — do NOT "fix" it to `<=`.
      // Equal-seq is REFINE-ONLY: two phases can share a seq window and the
      // later one refines the earlier (canary-pass refines canary-start at
      // seq=3; persist-pin co-times with canary-done). Letting an equal-seq
      // phase through applies that refinement. This relies on hostd feeding
      // phases in stdout order (the roll emits them in order), so an equal-seq
      // pair always arrives newest-last; `<=` would wrongly DROP the refining
      // phase and freeze the surface on the coarser one.
      const seq = LogTailRolloutNarrator.seqFor(phase);
      if (seq < st.lastAppliedSeq) return; // stale — drop.
      st.lastAppliedSeq = seq;

      // Rebuild the render state from this phase (pull-shaped: each phase is a
      // projection of the latest durable row hostd just wrote).
      st.render = {
        ...st.render,
        target: phase.target,
        phase: phase.phase,
        ...(phase.n !== undefined ? { n: phase.n } : {}),
        ...(phase.m !== undefined ? { m: phase.m } : {}),
        ...(phase.agent !== undefined ? { agent: phase.agent } : {}),
        rolled: entry.rolled,
      };
      this.scheduleRenderOrPost(entry.request_id);
    } catch (e) {
      this.opts.log?.(`onPhase threw (non-fatal): ${(e as Error).message}`);
    }
  }

  onTerminal(entry: StatusEntry): void {
    try {
      const st = this.ensureState(entry);
      // Terminal wins unconditionally and FREEZES the surface.
      st.render = {
        target: entry.pin ?? st.render.target,
        rolled: entry.rolled ?? st.render.rolled,
        terminal: entry.result === "completed" ? "completed" : "error",
        ...(entry.failed_step ? { failedStep: entry.failed_step } : {}),
        ...(entry.failed_agent ? { failedAgent: entry.failed_agent } : {}),
        ...(entry.got !== undefined ? { got: entry.got } : {}),
      };
      st.frozen = true;
      // Cancel any pending debounced edit — the terminal render supersedes it —
      // and flush the terminal state immediately (no debounce on the final
      // message: the operator wants the outcome now).
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      this.flush(entry.request_id, /* immediate */ true);
      // Drop state shortly after the terminal flush so the map doesn't grow.
      setTimeout(() => this.states.delete(entry.request_id), 10_000).unref?.();
    } catch (e) {
      this.opts.log?.(`onTerminal threw (non-fatal): ${(e as Error).message}`);
    }
  }

  private ensureState(entry: StatusEntry): NarrationState {
    let st = this.states.get(entry.request_id);
    if (!st) {
      const agentName =
        entry.caller.kind === "agent" ? entry.caller.name : "";
      st = {
        agentName,
        lastAppliedSeq: -1,
        messageId: null,
        posting: false,
        postAttempts: 0,
        postFailed: false,
        render: { target: entry.pin ?? "" },
        frozen: false,
        timer: null,
        pendingEditAfterPost: false,
      };
      this.states.set(entry.request_id, st);
    }
    return st;
  }

  /** Post the first message (once), then debounce edits for subsequent phases. */
  private scheduleRenderOrPost(requestId: string): void {
    const st = this.states.get(requestId);
    if (!st) return;
    if (st.agentName.length === 0) return; // operator-initiated / unknown — no relay target.

    // Have a message_id → debounce a trailing-edge edit. This is the steady
    // state for every phase after the first successful post.
    if (st.messageId !== null) {
      this.scheduleDebouncedEdit(requestId);
      return;
    }

    // Post in flight → remember to apply the newest render once it lands.
    if (st.posting) {
      st.pendingEditAfterPost = true;
      return;
    }

    // messageId is null and no post in flight. First contact posts once. A
    // LATER phase does NOT re-post here — tryPost's cap + postFailed back-off
    // suppress the re-post storm (a null-returning relay would otherwise fire
    // one post per phase). A genuinely-missed post is re-attempted only on the
    // terminal phase (see flush(immediate) → tryPost with terminal=true).
    if (st.postFailed) return; // backed off — wait for the terminal retry.
    this.tryPost(requestId, /* terminal */ false);
  }

  /**
   * Dispatch a single post() under the anti-storm cap. Fire-and-forget: the
   * post promise is never awaited by the roll. Honors:
   *   - MAX_POST_ATTEMPTS: a hard ceiling on total post() calls per request.
   *   - postFailed: a null resolution sets it so phase-driven re-posts stop;
   *     `terminal` callers may still spend one reserved attempt.
   * Returns true when a post was actually dispatched.
   */
  private tryPost(requestId: string, terminal: boolean): boolean {
    const st = this.states.get(requestId);
    if (!st) return false;
    if (st.messageId !== null || st.posting) return false;
    if (st.postAttempts >= MAX_POST_ATTEMPTS) return false;
    // After a failed post, only the terminal flush is allowed to re-attempt —
    // an in-flight phase must not keep re-posting.
    if (st.postFailed && !terminal) return false;
    st.posting = true;
    st.postAttempts += 1;
    const text = renderRolloutStatus(st.render);
    void this.relay
      .post({ requestId, agentName: st.agentName, text })
      .then((mid) => {
        st.posting = false;
        if (mid === null) {
          // Post failed (or the reply timed out). Back off phase-driven
          // re-posts; the durable audit log remains the record.
          st.postFailed = true;
          this.opts.log?.(
            `rollout narration post returned no message_id (requestId=${requestId}); backing off re-posts`,
          );
          return;
        }
        st.messageId = mid;
        st.postFailed = false;
        // If phases arrived while we were posting, apply the latest now.
        if (st.pendingEditAfterPost) {
          st.pendingEditAfterPost = false;
          this.flush(requestId, /* immediate */ false);
        }
      })
      .catch((e) => {
        st.posting = false;
        st.postFailed = true;
        this.opts.log?.(`rollout narration post failed (non-fatal): ${(e as Error).message}`);
      });
    return true;
  }

  private scheduleDebouncedEdit(requestId: string): void {
    const st = this.states.get(requestId);
    if (!st) return;
    if (st.timer) return; // a trailing-edge edit is already scheduled.
    const ms = this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    st.timer = setTimeout(() => {
      st.timer = null;
      this.flush(requestId, /* immediate */ true);
    }, ms);
    st.timer.unref?.();
  }

  /** Render current state and edit the message (or post if none yet). */
  private flush(requestId: string, immediate: boolean): void {
    const st = this.states.get(requestId);
    if (!st) return;
    if (st.agentName.length === 0) return;
    if (!immediate) {
      this.scheduleDebouncedEdit(requestId);
      return;
    }
    if (st.messageId === null) {
      // No message yet (terminal fired before the first phase posted, the post
      // is still in flight, or an earlier post failed). An immediate flush is
      // the terminal path — spend one reserved post attempt (tryPost enforces
      // MAX_POST_ATTEMPTS and the postFailed back-off). If a post is in flight,
      // remember to apply the newest render once it lands.
      if (st.posting) {
        st.pendingEditAfterPost = true;
        return;
      }
      this.tryPost(requestId, /* terminal */ true);
      return;
    }
    // Edit in place (fire-and-forget; relay swallows failures incl. 429).
    const text = renderRolloutStatus(st.render);
    this.relay.edit({
      requestId,
      agentName: st.agentName,
      messageId: st.messageId,
      text,
    });
  }
}
