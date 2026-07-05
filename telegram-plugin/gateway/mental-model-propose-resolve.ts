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
  | { outcome: "failed"; reason: string };

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

  // Pre-register the single-tap correlation so hostd auto-approves the edit
  // (operator already approved on this proposal card — no second card).
  deps.registerPreApproval(pending.agent, built.diff);
  let dispatch: ConfigEditDispatchResult;
  try {
    dispatch = await deps.dispatchConfigEdit({
      agent: pending.agent,
      diff: built.diff,
      reason:
        `Declare agent-proposed mental model "${pending.spec.name}"` +
        (pending.reason ? ` — ${pending.reason}` : ""),
    });
  } catch (err) {
    dispatch = { state: "error", reason: (err as Error).message };
  } finally {
    // Single-shot: drop the correlation whether or not hostd consumed it.
    deps.clearPreApproval(pending.agent, built.diff);
  }

  if (dispatch.state !== "applied") {
    deps.log?.(
      `mental_model_propose: config edit ${dispatch.state} for ${pending.agent} "${pending.spec.name}": ${dispatch.reason}`,
    );
    deps.injectInbound(
      buildMentalModelProposeFailedInbound({
        ctx,
        stageId,
        operatorId,
        reason: dispatch.reason,
        nowMs,
      }),
    );
    return { outcome: "failed", reason: dispatch.reason };
  }

  // Applied. Belt-and-suspenders ensure (reconcile already ensures via #2874;
  // this makes the model available without waiting for the restart). Never let
  // an ensure failure flip a successful declaration into a "failed" inbound —
  // the model IS declared and will be ensured at reconcile regardless.
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
    buildMentalModelProposeAppliedInbound({ ctx, stageId, operatorId, nowMs }),
  );
  return { outcome: "applied" };
}
