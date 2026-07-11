/**
 * The approve/deny ORCHESTRATION for the mental-model proposal flow (hindsight
 * Phase 5, stacked on #2874), factored out of gateway.ts so the invariants are
 * unit-testable with injected deps (no gateway, no Telegram, no hostd, no
 * network):
 *
 *   - APPROVE appends the model to config (via the injected config-edit
 *     dispatch) AND ensures it, then wakes the agent with an "applied" inbound.
 *   - DENY writes NOTHING (never reads config, never builds a diff, never
 *     dispatches an edit, never ensures) and wakes the agent with a "denied"
 *     inbound.
 *   - A duplicate / agent-not-found / no-change proposal is REJECTED before any
 *     edit is dispatched, and the agent gets a "failed" inbound.
 *
 * The gateway callback is a thin adapter that wires the real deps (read live
 * config bytes, register the single-tap correlation, `config_propose_edit` via
 * hostd, `ensureMentalModel`, inject-inbound) into `resolveMentalModelProposal`.
 * Self-approval is impossible by construction: this function is only ever
 * reached AFTER the gateway callback has verified the tapper is an allow-listed
 * operator — the agent has no path to invoke it.
 */

import {
  buildMentalModelAppendDiff,
  type MentalModelProposeSpec,
} from "./mental-model-propose-diff.js";
import {
  buildMentalModelProposeAppliedInbound,
  buildMentalModelProposeDeniedInbound,
  buildMentalModelProposeFailedInbound,
  type MentalModelProposeInboundContext,
} from "./mental-model-propose-inbound-builders.js";
import type { InboundMessage } from "./ipc-protocol.js";

/** The pending proposal state the resolver needs. */
export interface MentalModelPendingProposal {
  agent: string;
  chat_id: string;
  threadId?: number;
  spec: MentalModelProposeSpec;
  /** Human-readable rationale, echoed into the config-edit reason. */
  reason?: string;
}

/** Outcome of dispatching the config edit through hostd's apply+reconcile. */
export type ConfigEditDispatchResult =
  | { state: "applied" }
  | { state: "denied"; reason: string }
  /**
   * hostd threw `E_RATE_LIMITED` (the agent's config_propose_edit bucket is
   * exhausted). `retryAtMs` is the epoch-ms parsed from the structured
   * `fix.retry_after` hostd emits — the moment the sliding window frees a
   * slot. #2975 Stage 1 schedules exactly ONE re-dispatch at that time so an
   * operator-APPROVED persist is never silently lost to the throttle.
   */
  | { state: "rate_limited"; reason: string; retryAtMs: number }
  | { state: "error"; reason: string };

export interface ResolveDeps {
  /** Read the live switchroom.yaml bytes (before-image for the diff). */
  readConfigText: () => string;
  /**
   * Register a single-tap correlation so hostd's config-approval callback
   * auto-resolves the edit WITHOUT posting a SECOND operator card — the
   * operator already approved on THIS proposal card. Forge-resistance is the
   * caller's job (exact diff byte-match). Called only on the approve path,
   * only after a diff was successfully built.
   */
  registerPreApproval: (agent: string, diff: string) => void;
  /** Drop a previously-registered correlation (cleanup, single-shot). */
  clearPreApproval: (agent: string, diff: string) => void;
  /**
   * Persist the append diff via hostd `config_propose_edit`
   * (validate → approve → apply → reconcile). Reconcile runs
   * `ensureDeclaredMentalModels` (#2874), materialising the model.
   */
  dispatchConfigEdit: (args: {
    agent: string;
    diff: string;
    reason: string;
  }) => Promise<ConfigEditDispatchResult>;
  /**
   * Best-effort belt-and-suspenders ensure of the model in the bank
   * immediately after apply (reconcile is the authoritative suspenders). Must
   * not throw. Optional — when absent, ensure is left entirely to reconcile.
   */
  ensureModel?: (spec: MentalModelProposeSpec) => Promise<void>;
  /** Deliver a synthetic inbound to wake the agent with the outcome. */
  injectInbound: (inbound: InboundMessage) => void;
  /**
   * #2975 Stage 1 — schedule EXACTLY ONE bounded re-dispatch of an
   * operator-approved persist that hostd rate-limited (`E_RATE_LIMITED`).
   * `delayMs` is the wait until hostd's `fix.retry_after` window opens; `fn`
   * re-runs the persist ONCE (it never re-schedules — bounded, no loop).
   * Injectable so tests drive it with a mocked clock. When absent, a rate-
   * limited persist can't be retried and falls straight to the loud-failure
   * path (no silent loss).
   *
   * Stage-1 caveat (documented, accepted): the timer lives only in gateway
   * memory. A gateway restart between schedule and fire LOSES the retry —
   * acceptable for Stage 1; Stage 2 (hostd `checkPreApproved` bypass) removes
   * the rate-limit collision entirely so no retry is needed.
   */
  scheduleRetry?: (delayMs: number, fn: () => void | Promise<void>) => void;
  /**
   * #2975 Stage 1 — edit the operator's proposal card to the
   * "approved — applying at HH:MM (rate window)" state so a rate-deferred
   * (but approved) change is visibly not lost while the retry is pending.
   */
  editProposalCardRateWindow?: (retryAtMs: number) => void;
  /**
   * #2975 Stage 1 — loud, operator-visible failure (operator-events path)
   * when the single scheduled retry ALSO fails, so an approved change is
   * never silently dropped. Must not throw.
   */
  notifyPersistFailed?: (reason: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable git binary for the diff subprocess (tests). */
  gitBin?: string;
  log?: (msg: string) => void;
}

export type ResolveOutcome =
  | { outcome: "applied" }
  | { outcome: "denied" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "failed"; reason: string }
  /**
   * #2975 Stage 1 — the persist was rate-limited but the operator already
   * approved, so exactly one re-dispatch is scheduled at `retryAtMs`. The
   * proposal card was edited to the "applying at HH:MM" state; the agent's
   * turn resolves later when the retry injects its own applied/failed inbound.
   */
  | { outcome: "scheduled_retry"; retryAtMs: number };

/**
 * Resolve an operator's Approve / Deny decision on a mental-model proposal.
 * Pure orchestration — all side effects go through `deps`.
 */
export async function resolveMentalModelProposal(
  action: "approve" | "deny",
  pending: MentalModelPendingProposal,
  stageId: string,
  operatorId: string,
  deps: ResolveDeps,
): Promise<ResolveOutcome> {
  const nowMs = (deps.now ?? Date.now)();
  const ctx: MentalModelProposeInboundContext = {
    agent: pending.agent,
    name: pending.spec.name,
    chat_id: pending.chat_id,
    ...(pending.threadId != null ? { threadId: pending.threadId } : {}),
  };

  // ── DENY: write NOTHING. No config read, no diff, no dispatch, no ensure. ──
  if (action === "deny") {
    deps.injectInbound(
      buildMentalModelProposeDeniedInbound({ ctx, stageId, operatorId, nowMs }),
    );
    return { outcome: "denied" };
  }

  // ── APPROVE: append to config (reused apply+reconcile) + ensure. ──
  const configText = deps.readConfigText();
  const built = buildMentalModelAppendDiff({
    configText,
    agentName: pending.agent,
    spec: pending.spec,
    ...(deps.gitBin ? { gitBin: deps.gitBin } : {}),
  });
  if (!built.ok) {
    // Duplicate / agent-not-found / no-change / parse-error — reject BEFORE
    // any edit is dispatched. Nothing is written.
    deps.log?.(
      `mental_model_propose: approve rejected (${built.error}) for ${pending.agent} "${pending.spec.name}": ${built.detail}`,
    );
    deps.injectInbound(
      buildMentalModelProposeFailedInbound({
        ctx,
        stageId,
        operatorId,
        reason: built.detail,
        nowMs,
      }),
    );
    return { outcome: "rejected", reason: built.detail };
  }

  const persistReason =
    `Declare agent-proposed mental model "${pending.spec.name}"` +
    (pending.reason ? ` — ${pending.reason}` : "");
  const clock = deps.now ?? Date.now;

  // ONE dispatch attempt. Atomically re-registers the single-tap correlation
  // with the SAME diff bytes each call BEFORE dispatching — the register and
  // dispatch MUST use identical bytes (forge-resistance contract, file header
  // lines 54-63): hostd's config-approval callback auto-resolves only on an
  // exact byte-match, so a rebuilt/whitespace-drifted diff would fail to
  // auto-approve and post a SECOND operator card. Because the initial and the
  // #2975 retry both re-run this closure over the same captured `built.diff`,
  // they are byte-identical by construction.
  const dispatchOnce = async (): Promise<ConfigEditDispatchResult> => {
    deps.registerPreApproval(pending.agent, built.diff);
    try {
      return await deps.dispatchConfigEdit({
        agent: pending.agent,
        diff: built.diff,
        reason: persistReason,
      });
    } catch (err) {
      return { state: "error", reason: (err as Error).message };
    } finally {
      // Single-shot: drop the correlation whether or not hostd consumed it.
      deps.clearPreApproval(pending.agent, built.diff);
    }
  };

  // Applied — belt-and-suspenders ensure (reconcile already ensures via #2874;
  // this makes the model available without waiting for the restart). Never let
  // an ensure failure flip a successful declaration into a "failed" inbound —
  // the model IS declared and will be ensured at reconcile regardless.
  const finishApplied = async (): Promise<void> => {
    if (deps.ensureModel) {
      try {
        await deps.ensureModel(pending.spec);
      } catch (err) {
        deps.log?.(
          `mental_model_propose: best-effort ensure threw (declaration still applied) for ${pending.agent} "${pending.spec.name}": ${(err as Error).message}`,
        );
      }
    }
    deps.injectInbound(
      buildMentalModelProposeAppliedInbound({
        ctx,
        stageId,
        operatorId,
        nowMs: clock(),
      }),
    );
  };

  const finishFailed = (reason: string, loud: boolean): void => {
    deps.log?.(
      `mental_model_propose: config edit failed for ${pending.agent} "${pending.spec.name}": ${reason}`,
    );
    // Loud, operator-visible failure only on the RETRY exhaustion path — the
    // initial-failure path already surfaces via the card edit + agent inbound.
    if (loud) {
      try {
        deps.notifyPersistFailed?.(reason);
      } catch {
        // notify must never break the failed-inbound delivery below.
      }
    }
    deps.injectInbound(
      buildMentalModelProposeFailedInbound({
        ctx,
        stageId,
        operatorId,
        reason,
        nowMs: clock(),
      }),
    );
  };

  const dispatch = await dispatchOnce();

  // #2975 Stage 1 backstop — an operator-APPROVED persist that hostd rate-
  // limited must NOT be silently lost. Schedule EXACTLY ONE re-dispatch at the
  // window-open time hostd handed back in `fix.retry_after`, and flip the card
  // to the "applying at HH:MM (rate window)" state so the operator sees it's
  // deferred, not dropped.
  if (dispatch.state === "rate_limited") {
    if (deps.scheduleRetry) {
      const { retryAtMs } = dispatch;
      deps.editProposalCardRateWindow?.(retryAtMs);
      const delayMs = Math.max(0, retryAtMs - clock());
      deps.log?.(
        `mental_model_propose: config edit rate-limited for ${pending.agent} "${pending.spec.name}"; scheduling one retry in ${delayMs}ms (window opens ${new Date(retryAtMs).toISOString()})`,
      );
      deps.scheduleRetry(delayMs, async () => {
        // Bounded: this is the ONE and ONLY retry — it never re-schedules.
        const retryResult = await dispatchOnce();
        if (retryResult.state === "applied") {
          await finishApplied();
        } else {
          // Every non-applied state (denied / rate_limited / error) carries a
          // reason. A second rate_limit is treated as a terminal failure — the
          // retry is bounded to one; we do NOT re-schedule.
          finishFailed(retryResult.reason, true);
        }
      });
      return { outcome: "scheduled_retry", retryAtMs };
    }
    // No scheduler wired — can't defer the retry; fail loudly rather than
    // silently drop the approved change.
    finishFailed(dispatch.reason, true);
    return { outcome: "failed", reason: dispatch.reason };
  }

  if (dispatch.state !== "applied") {
    finishFailed(dispatch.reason, false);
    return { outcome: "failed", reason: dispatch.reason };
  }

  await finishApplied();
  return { outcome: "applied" };
}
