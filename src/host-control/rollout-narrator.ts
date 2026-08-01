/**
 * #2726 Part 2 — the log-tailed rollout NARRATION surface.
 *
 * ONE ordinary operator-DM message, edited in place through the phases
 * (`applying → canary → agent N/M → persisting pin → web refresh → hostd deferred →
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
  type AgentRollProgress,
  type RolloutRenderState,
  type SingletonRollProgress,
} from "./render-rollout-status.js";

/**
 * Display names for the singleton / shared-service checklist rows. Stable
 * strings — the narrator keys row updates on them.
 */
export const SINGLETON_WEB = "switchroom-web";
export const SINGLETON_HINDSIGHT = "hindsight";
export const SINGLETON_HOSTD = "hostd";
export const SINGLETON_SHARED =
  "shared services (approval-kernel · auth-broker · vault-broker · voice)";

/**
 * Initial singleton checklist for a narrated roll. The narrator only exists
 * on the hostd/agent-invoked path (hostd tails its own child's phases), so
 * the initial states encode that path's plan truthfully:
 *   - web + hindsight are in-plan refresh steps → pending until their phase;
 *   - hostd is ALWAYS deferred there (an agent-invoked roll cannot recreate
 *     its own hostd mid-roll) — refined to "updated" only if a self-bump is
 *     actually observed;
 *   - the shared fleet singletons self-heal on the first `agent restart`
 *     (#2170) and are only individually OBSERVED by the terminal
 *     verify-components gate, so they start pending with that stated.
 */
function initialSingletons(): SingletonRollProgress[] {
  return [
    { name: SINGLETON_WEB, status: "pending" },
    { name: SINGLETON_HINDSIGHT, status: "pending" },
    {
      name: SINGLETON_HOSTD,
      status: "deferred",
      detail: "host-side (agent-invoked roll cannot recreate its own hostd)",
    },
    {
      name: SINGLETON_SHARED,
      status: "pending",
      detail: "self-heal with the first agent restart",
    },
  ];
}

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
   * Edit a previously-posted message in place. Fire-and-forget toward the ROLL
   * (never awaited by it) and MUST NOT throw or reject: an edit failure is
   * REPORTED, never propagated. #4065 — the resolved outcome is what lets the
   * narrator notice it is editing a card that no longer exists.
   */
  edit(args: {
    requestId: string;
    agentName: string;
    messageId: number;
    text: string;
  }): Promise<RolloutEditOutcome>;
}

/**
 * #4065 — the outcome of ONE relayed edit. `gone` is the only class that
 * justifies a re-post: it means the target message no longer exists, so the
 * operator currently has NO live card. A transient failure (429 past the
 * gateway's retries, a socket blip, an unwired/old gateway that never replies)
 * leaves a perfectly good card in the chat, and re-posting would duplicate it.
 */
export type RolloutEditOutcome =
  | { ok: true }
  | { ok: false; gone: boolean; reason?: string };

/**
 * #4065 — emitted (NEVER to chat) when the rollout card cannot be kept alive:
 * the seeded/held message_id is gone AND the one allowed re-post did not land.
 * Follows the PR #4104 rule — an internal failure escalates to telemetry, not
 * to a card asking the operator to do something. The durable rollout rows
 * (`get_status`) remain the record either way.
 */
export interface RolloutCardEscalation {
  requestId: string;
  agentName: string;
  /** The message_id that was found to be gone. */
  staleMessageId: number;
  /** Why the card could not be restored. */
  reason: "repost-failed" | "repost-unavailable" | "gone-again";
  detail?: string;
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
  /** Per-agent checklist progress, in roll order (fed into render.agents). */
  agents: AgentRollProgress[];
  /** Singleton / shared-service checklist (fed into render.singletons). */
  singletons: SingletonRollProgress[];
  /** Frozen once the terminal row is applied — no later edit may un-finalize. */
  frozen: boolean;
  /** Pending debounce timer for a trailing-edge edit. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Phases buffered before the first post's message_id arrived. */
  pendingEditAfterPost: boolean;
  /**
   * #4065 — ONE-SHOT latch: true once a `gone` edit outcome has already been
   * answered with a re-post for this request. A second `gone` escalates to
   * telemetry instead of posting again, so a chat can never be spammed and the
   * edit→gone→post→gone loop cannot run.
   */
  goneRepostUsed: boolean;
  /**
   * #4065 — the message_id that was found gone, held while the compensating
   * re-post is in flight so a null-resolving post escalates with the right id.
   * Null when no re-post is pending.
   */
  goneRepostForMessageId: number | null;
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
    private opts: {
      debounceMs?: number;
      log?: (m: string) => void;
      /** Clock seam for tests; defaults to Date.now. */
      now?: () => number;
      /**
       * Called once the first post lands with a real Telegram message_id, so a
       * caller can durably persist it (into the pending-rollout marker) and let
       * a post-self-bump resume EDIT the same card instead of re-posting.
       */
      onMessageId?: (requestId: string, messageId: number) => void;
      /**
       * #4065 — telemetry sink for "the operator's rollout card is gone and we
       * could not restore it". NEVER a chat surface (PR #4104's rule). Defaults
       * to a structured, greppable line through `log`.
       */
      escalate?: (escalation: RolloutCardEscalation) => void;
    } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Upsert an agent's checklist entry (keyed by name, roll order preserved). */
  private static upsertAgent(
    st: NarrationState,
    name: string,
    patch: Partial<AgentRollProgress>,
  ): void {
    const existing = st.agents.find((a) => a.name === name);
    if (existing) Object.assign(existing, patch);
    else st.agents.push({ name, status: "pending", ...patch });
  }

  /** Fold a phase into the per-agent checklist (✓/⏳/·/✗ + durations). */
  private trackAgentProgress(st: NarrationState, phase: RolloutPhase): void {
    const now = this.now();
    switch (phase.phase) {
      case "canary-start":
      case "agent-start":
        if (phase.agent) {
          LogTailRolloutNarrator.upsertAgent(st, phase.agent, {
            status: "running",
            startedAtMs: now,
            ...(phase.phase === "canary-start" ? { canary: true } : {}),
          });
        }
        break;
      case "canary-pass":
      case "agent-done":
      case "canary-fail": {
        if (!phase.agent) break;
        const a = st.agents.find((x) => x.name === phase.agent);
        const durationMs =
          a?.startedAtMs !== undefined ? now - a.startedAtMs : undefined;
        LogTailRolloutNarrator.upsertAgent(st, phase.agent, {
          status: phase.phase === "canary-fail" ? "failed" : "done",
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(phase.phase !== "agent-done" ? { canary: true } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  /** Patch one singleton row in place (rows are fixed at ensureState). */
  private static patchSingleton(
    st: NarrationState,
    name: string,
    patch: Partial<SingletonRollProgress>,
  ): void {
    const row = st.singletons.find((g) => g.name === name);
    if (row) Object.assign(row, patch);
  }

  /**
   * Fold a phase into the singleton / shared-service checklist. Every
   * transition mirrors a REAL emitted phase (rollout.ts emits `…-done` only
   * on an observed success), so no row ever shows a ✓ the roll didn't see.
   */
  private trackSingletonProgress(st: NarrationState, phase: RolloutPhase): void {
    const patch = LogTailRolloutNarrator.patchSingleton;
    switch (phase.phase) {
      case "canary-pass":
      case "agent-done": {
        // #2170 — the fleet's shared singletons are recreated by the FIRST
        // agent restart. Mark the mechanism as having run; "updated" waits
        // for the terminal row (the verify-components gate is what actually
        // observes them).
        const shared = st.singletons.find((g) => g.name === SINGLETON_SHARED);
        if (shared && shared.status === "pending") {
          shared.status = "updating";
          shared.detail =
            "recreated with the first agent restart — verified at roll end";
        }
        break;
      }
      case "web-refresh":
        patch(st, SINGLETON_WEB, { status: "updating", detail: "webd install…" });
        break;
      case "web-refresh-done":
        patch(st, SINGLETON_WEB, { status: "updated", detail: undefined });
        break;
      case "hindsight-refresh":
        patch(st, SINGLETON_HINDSIGHT, {
          status: "updating",
          detail: "memory setup --recreate…",
        });
        break;
      case "hindsight-refresh-done":
        patch(st, SINGLETON_HINDSIGHT, { status: "updated", detail: undefined });
        break;
      case "hindsight-skipped":
        patch(st, SINGLETON_HINDSIGHT, {
          status: "skipped",
          detail: "no hindsight container on this host",
        });
        break;
      case "self-bump":
        patch(st, SINGLETON_HOSTD, {
          status: "updating",
          detail: "self-bump to the target…",
        });
        break;
      case "self-bump-done":
        patch(st, SINGLETON_HOSTD, {
          status: "updated",
          detail: "self-bump; template regen stays host-side",
        });
        break;
      case "hostd-web-deferred": {
        // Don't downgrade an observed self-bump back to "deferred".
        const hostd = st.singletons.find((g) => g.name === SINGLETON_HOSTD);
        if (hostd && hostd.status !== "updated") {
          hostd.status = "deferred";
          hostd.detail = "host-side";
        }
        break;
      }
      default:
        break;
    }
  }

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
      case "self-bump":
      case "self-bump-done":
        // #2645 — hostd self-refresh precedes the roll proper. Co-timed with
        // apply's window (equal-seq is refine-only, and the daemon feeds
        // self-bump → self-bump-done → apply strictly in order).
        return 0;
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
      case "web-refresh":
      case "web-refresh-done":
        // In-plan web singleton refresh — after every agent restart, before
        // the hindsight refresh. Equal-seq: -done REFINES -start (the
        // executor emits them strictly in order on one stdout).
        return Number.MAX_SAFE_INTEGER - 4;
      case "hindsight-refresh":
      case "hindsight-refresh-done":
      case "hindsight-skipped":
        // After the web refresh, before the deferral note. Same equal-seq
        // refine-only shape as web above.
        return Number.MAX_SAFE_INTEGER - 3;
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

      // Fold the phase into the per-agent checklist (✓/⏳/·/✗ + durations)
      // and the singleton / shared-service checklist.
      this.trackAgentProgress(st, phase);
      this.trackSingletonProgress(st, phase);

      // #2726 fix — during the roll, `entry.rolled` is still empty: hostd only
      // parses the child's result sentinel into `entry.rolled` AFTER the whole
      // subprocess exits (server.ts spawnRollout `.then()`), so an in-flight
      // phase always reads `[]` there and the footer froze at "0/M rolled".
      // The per-agent checklist we already accumulate (`st.agents`) is the
      // authoritative live source: an agent flips to "done" the moment its
      // agent-done / canary-pass phase lands. Derive the rolled list from it so
      // the footer count tracks real completions; fall back to the terminal
      // `entry.rolled` only when it's actually populated.
      const doneNames = st.agents
        .filter((a) => a.status === "done")
        .map((a) => a.name);
      const rolledSoFar =
        entry.rolled && entry.rolled.length > 0 ? entry.rolled : doneNames;

      // Rebuild the render state from this phase (pull-shaped: each phase is a
      // projection of the latest durable row hostd just wrote).
      st.render = {
        ...st.render,
        target: phase.target,
        phase: phase.phase,
        ...(phase.n !== undefined ? { n: phase.n } : {}),
        ...(phase.m !== undefined ? { m: phase.m } : {}),
        ...(phase.agent !== undefined ? { agent: phase.agent } : {}),
        rolled: rolledSoFar,
        agents: st.agents,
        singletons: st.singletons,
        requestId: entry.request_id,
        ...(entry.prior_pin ? { fromVersion: entry.prior_pin } : {}),
        startedAtMs: entry.started_at,
      };
      this.scheduleRenderOrPost(entry.request_id);
    } catch (e) {
      this.opts.log?.(`onPhase threw (non-fatal): ${(e as Error).message}`);
    }
  }

  onTerminal(entry: StatusEntry): void {
    try {
      const st = this.ensureState(entry);
      // Reconcile the checklist against the terminal row: the failed agent is
      // marked ✗; any other agent still shown "running" (its -done row never
      // arrived) is downgraded to pending unless the rolled[] list confirms it.
      const rolled = new Set(entry.rolled ?? []);
      for (const a of st.agents) {
        if (entry.failed_agent && a.name === entry.failed_agent) {
          a.status = "failed";
        } else if (rolled.has(a.name)) {
          a.status = "done";
        } else if (a.status === "running") {
          a.status = "pending";
        }
      }
      this.reconcileSingletonsAtTerminal(st, entry);
      // Terminal wins unconditionally and FREEZES the surface.
      st.render = {
        target: entry.pin ?? st.render.target,
        rolled: entry.rolled ?? st.render.rolled,
        terminal: entry.result === "completed" ? "completed" : "error",
        ...(entry.failed_step ? { failedStep: entry.failed_step } : {}),
        ...(entry.failed_agent ? { failedAgent: entry.failed_agent } : {}),
        ...(entry.got !== undefined ? { got: entry.got } : {}),
        // #3928 — the narration card is the operator's live view of the roll;
        // without this it would freeze on a bare "STOPPED at
        // verify-components" and never name what is actually stale.
        ...(entry.drifted && entry.drifted.length > 0
          ? { drifted: entry.drifted }
          : {}),
        ...(st.agents.length > 0 ? { agents: st.agents } : {}),
        ...(st.singletons.length > 0 ? { singletons: st.singletons } : {}),
        ...(st.render.m !== undefined ? { m: st.render.m } : {}),
        requestId: entry.request_id,
        ...(entry.prior_pin ?? st.render.fromVersion
          ? { fromVersion: entry.prior_pin ?? st.render.fromVersion }
          : {}),
        elapsedMs: (entry.finished_at ?? this.now()) - entry.started_at,
        // The fresh terminal ping (server.ts pushRolloutTerminal) already
        // carries the full Deferred command block; suppress it on THIS edited
        // card so a successful roll doesn't render the 3-command list twice.
        deferred: false,
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

  /**
   * Reconcile the singleton checklist against the TERMINAL row — the only
   * point where the roll has actually OBSERVED the singletons as a set (the
   * verify-components gate: a `completed` terminal means every in-scope
   * component passed it; a drifted list names exactly what did not).
   */
  private reconcileSingletonsAtTerminal(
    st: NarrationState,
    entry: StatusEntry,
  ): void {
    const completed = entry.result === "completed";
    const drifted = new Set(entry.drifted ?? []);
    const driftedHits = (row: string): string[] => {
      switch (row) {
        case SINGLETON_WEB:
          return [...drifted].filter((d) => d === "switchroom-web");
        case SINGLETON_HINDSIGHT:
          return [...drifted].filter((d) => d === "switchroom-hindsight");
        case SINGLETON_HOSTD:
          // The autoheal sidecar runs the hostd image in the hostd compose
          // project (component-scope.ts) — its drift is hostd's to fix.
          return [...drifted].filter(
            (d) => d === "switchroom-hostd" || d === "switchroom-hindsight-autoheal",
          );
        case SINGLETON_SHARED:
          return [...drifted].filter(
            (d) =>
              d.includes("broker") || d.includes("kernel") || d.includes("voice"),
          );
        default:
          return [];
      }
    };
    for (const g of st.singletons) {
      const hits = driftedHits(g.name);
      if (hits.length > 0) {
        // The terminal drift gate NAMED it still behind — that observation
        // outranks any in-flight phase (incl. a web-refresh-done whose
        // install was later disproven).
        g.status = "failed";
        g.detail = `still behind (${hits.join(", ")}) — see the roll's warnings`;
        continue;
      }
      if (entry.failed_step === "refresh-hindsight" && g.name === SINGLETON_HINDSIGHT) {
        g.status = "failed";
        g.detail =
          "recreate FAILED — memory backend down; run `switchroom memory setup`";
        continue;
      }
      if (!completed) {
        // A stopped roll: leave each row's last honest state (pending rows
        // simply never got reached; "updating" without an outcome phase is
        // unproven, so say so rather than claim either way).
        if (g.status === "updating" && g.name !== SINGLETON_SHARED) {
          g.detail = "outcome unknown — the roll stopped; see warnings";
        }
        continue;
      }
      // Completed roll: the verify-components gate passed with this row's
      // components in scope wherever their plan step ran.
      switch (g.name) {
        case SINGLETON_WEB:
        case SINGLETON_HINDSIGHT:
          if (g.status === "updated") break;
          if (g.status === "updating") {
            // Its -done phase never arrived (lost line / older CLI), but the
            // terminal gate proved convergence.
            g.status = "updated";
            g.detail = "verified by the end-of-roll component check";
          } else if (g.status === "pending") {
            // The roll finished without this narrator seeing its refresh
            // phase — --skip-web, a plan without the step, or a narration
            // restart mid-roll. Not a failure; not a ✓ either.
            g.status = "skipped";
            g.detail = "no refresh observed in this roll — see warnings";
          }
          break;
        case SINGLETON_SHARED:
          g.status = "updated";
          g.detail =
            "self-healed with the first agent restart; end-of-roll check passed";
          break;
        default:
          break; // hostd keeps its deferred / self-bump state — that IS the truth.
      }
    }
  }

  private freshState(agentName: string, target: string): NarrationState {
    return {
      agentName,
      lastAppliedSeq: -1,
      messageId: null,
      posting: false,
      postAttempts: 0,
      postFailed: false,
      render: { target },
      agents: [],
      singletons: initialSingletons(),
      frozen: false,
      timer: null,
      pendingEditAfterPost: false,
      goneRepostUsed: false,
      goneRepostForMessageId: null,
    };
  }

  /**
   * #4065 — escalate to telemetry. Structured + greppable by default; an
   * injected sink (hostd's stderr writer, or a test) takes precedence. A
   * throwing sink must never break narration.
   */
  private escalateCard(esc: RolloutCardEscalation): void {
    try {
      if (this.opts.escalate) {
        this.opts.escalate(esc);
        return;
      }
      this.opts.log?.(
        `rollout card escalation request=${esc.requestId} agent=${esc.agentName} ` +
          `staleMessageId=${esc.staleMessageId} reason=${esc.reason}` +
          `${esc.detail !== undefined ? ` detail=${esc.detail}` : ""} ` +
          `— card could not be restored, no operator card issued (get_status remains the record)`,
      );
    } catch {
      /* a throwing telemetry sink must not break narration */
    }
  }

  /**
   * #4065 — the edit-failure policy: ONE re-post, then telemetry.
   *
   * Only a `gone` outcome (the target message no longer exists) may re-post —
   * a transient failure leaves a live card that a re-post would duplicate. The
   * re-post is gated by a per-request one-shot latch AND by tryPost's existing
   * MAX_POST_ATTEMPTS cap, so the loop edit→gone→post→gone terminates in
   * telemetry rather than in a second card.
   *
   * Shaped to be absorbed by the general CardHandle edit policy (design D5)
   * without changing behaviour: identity (requestId) + the id the outcome
   * refers to + one re-post + telemetry.
   */
  private onEditOutcome(
    requestId: string,
    editedMessageId: number,
    outcome: RolloutEditOutcome,
  ): void {
    if (outcome.ok) return;
    const st = this.states.get(requestId);
    if (!st) return;
    if (!outcome.gone) {
      // Transient: the card is (almost certainly) still there. Same behaviour
      // as before #4065 — log and let the next phase's edit try again.
      this.opts.log?.(
        `rollout narration edit failed (transient, requestId=${requestId}): ${outcome.reason ?? "unknown"}`,
      );
      return;
    }
    // Stale outcome for a card we have already replaced — ignore, or we would
    // spend the re-post twice for one loss.
    if (st.messageId !== editedMessageId) return;
    if (st.goneRepostUsed) {
      this.escalateCard({
        requestId,
        agentName: st.agentName,
        staleMessageId: editedMessageId,
        reason: "gone-again",
        detail: outcome.reason,
      });
      return;
    }
    st.goneRepostUsed = true;
    st.messageId = null;
    st.postFailed = false;
    st.goneRepostForMessageId = editedMessageId;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    this.opts.log?.(
      `rollout narration card ${editedMessageId} is gone (requestId=${requestId}); re-posting once`,
    );
    // terminal=true: this is the reserved attempt — a roll that already froze
    // still owes the operator its ✅/❌, and st.render carries that terminal
    // body, so the re-post lands the truthful final card.
    if (!this.tryPost(requestId, /* terminal */ true)) {
      st.goneRepostForMessageId = null;
      this.escalateCard({
        requestId,
        agentName: st.agentName,
        staleMessageId: editedMessageId,
        reason: "repost-unavailable",
        detail: "post-attempt cap reached",
      });
    }
  }

  private ensureState(entry: StatusEntry): NarrationState {
    let st = this.states.get(entry.request_id);
    if (!st) {
      const agentName =
        entry.caller.kind === "agent" ? entry.caller.name : "";
      st = this.freshState(agentName, entry.pin ?? "");
      this.states.set(entry.request_id, st);
    }
    return st;
  }

  /**
   * Seed a narration state that already has a posted message_id — used after a
   * hostd self-bump so the RESUMED narrator adopts the card the OLD hostd
   * posted (message_id carried across the recreate via the pending-rollout
   * marker) and its first `onPhase` takes the EDIT branch instead of posting a
   * fresh card and stranding the original. Idempotent: if a state already
   * exists for this request (e.g. onPhase raced ahead), only backfill a still-
   * null messageId rather than clobbering live progress.
   */
  seedPostedMessage(
    requestId: string,
    agentName: string,
    messageId: number,
  ): void {
    const existing = this.states.get(requestId);
    if (existing) {
      if (existing.messageId === null) {
        existing.messageId = messageId;
        existing.posting = false;
        existing.postFailed = false;
        if (existing.postAttempts < 1) existing.postAttempts = 1;
        existing.pendingEditAfterPost = false;
      }
      return;
    }
    const st = this.freshState(agentName, "");
    st.messageId = messageId;
    st.postAttempts = 1;
    this.states.set(requestId, st);
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
    const text = renderRolloutStatus({ ...st.render, nowMs: this.now() });
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
          // #4065 — this post WAS the one compensating re-post for a card that
          // is gone. It didn't land, so the operator has no card at all: that
          // is telemetry, not another post and not a chat card.
          if (st.goneRepostForMessageId !== null) {
            const stale = st.goneRepostForMessageId;
            st.goneRepostForMessageId = null;
            this.escalateCard({
              requestId,
              agentName: st.agentName,
              staleMessageId: stale,
              reason: "repost-failed",
              detail: "post returned no message_id",
            });
          }
          return;
        }
        st.messageId = mid;
        st.postFailed = false;
        st.goneRepostForMessageId = null;
        // Surface the learned id so it can be persisted for a post-self-bump
        // resume (best-effort; a throwing sink must not break narration).
        try {
          this.opts.onMessageId?.(requestId, mid);
        } catch (e) {
          this.opts.log?.(
            `onMessageId sink threw (non-fatal): ${(e as Error).message}`,
          );
        }
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
        // Same as the null resolution: a failed compensating re-post means no
        // card at all → telemetry (#4065). The relay contract says post never
        // throws; this keeps the guarantee if one ever does.
        if (st.goneRepostForMessageId !== null) {
          const stale = st.goneRepostForMessageId;
          st.goneRepostForMessageId = null;
          this.escalateCard({
            requestId,
            agentName: st.agentName,
            staleMessageId: stale,
            reason: "repost-failed",
            detail: (e as Error).message,
          });
        }
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
    // Edit in place. Fire-and-forget toward the roll — never awaited — but the
    // OUTCOME is read (#4065): an edit into a card that no longer exists gets
    // exactly one re-post, then telemetry, so a roll always ends on a truthful
    // card instead of a frozen one.
    const text = renderRolloutStatus({ ...st.render, nowMs: this.now() });
    const editedMessageId = st.messageId;
    void this.relay
      .edit({
        requestId,
        agentName: st.agentName,
        messageId: editedMessageId,
        text,
      })
      .then((outcome) => this.onEditOutcome(requestId, editedMessageId, outcome))
      .catch((e) => {
        // The relay contract forbids rejection; treat a broken relay as a
        // transient failure rather than losing the narration loop.
        this.opts.log?.(
          `rollout narration edit relay rejected (non-fatal): ${(e as Error).message}`,
        );
      });
  }
}
