import { describe, it, expect, vi } from "vitest";
import {
  resolveMentalModelProposal,
  type MentalModelPendingProposal,
  type ResolveDeps,
} from "../gateway/mental-model-propose-resolve.js";

/**
 * The approve/deny orchestration invariants (hindsight Phase 5):
 *   - APPROVE appends config (dispatches the config edit) AND ensures.
 *   - DENY writes NOTHING (no config read, diff, dispatch, or ensure).
 *   - A duplicate proposal is rejected BEFORE any edit is dispatched.
 * Self-approve is impossible by construction: this function is only reached
 * after the gateway callback authorizes an allow-listed operator; there is no
 * agent path to it (covered by the config-edit self-scope tests + the callback
 * authorization gate).
 */

const CONFIG_NO_MODELS = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
`;
const CONFIG_DUP = `agents:
  coach:
    persona: fitness
    memory:
      collection: coach-bank
      mental_models:
        - name: plan
          source_query: existing
`;

function pending(overrides: Partial<MentalModelPendingProposal> = {}): MentalModelPendingProposal {
  return {
    agent: "coach",
    chat_id: "123",
    spec: { name: "plan", source_query: "What is the plan?" },
    reason: "recurring lookup",
    ...overrides,
  };
}

function makeDeps(configText: string, overrides: Partial<ResolveDeps> = {}): {
  deps: ResolveDeps;
  spies: {
    readConfigText: ReturnType<typeof vi.fn>;
    registerPreApproval: ReturnType<typeof vi.fn>;
    clearPreApproval: ReturnType<typeof vi.fn>;
    dispatchConfigEdit: ReturnType<typeof vi.fn>;
    ensureModel: ReturnType<typeof vi.fn>;
    injectInbound: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    readConfigText: vi.fn(() => configText),
    registerPreApproval: vi.fn(),
    clearPreApproval: vi.fn(),
    dispatchConfigEdit: vi.fn(async () => ({ state: "applied" as const })),
    ensureModel: vi.fn(async () => {}),
    injectInbound: vi.fn(),
  };
  const deps: ResolveDeps = {
    readConfigText: spies.readConfigText,
    registerPreApproval: spies.registerPreApproval,
    clearPreApproval: spies.clearPreApproval,
    dispatchConfigEdit: spies.dispatchConfigEdit,
    ensureModel: spies.ensureModel,
    injectInbound: spies.injectInbound,
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { deps, spies };
}

describe("resolveMentalModelProposal — APPROVE", () => {
  it("appends config (dispatches the append edit) AND ensures, then wakes the agent", async () => {
    const { deps, spies } = makeDeps(CONFIG_NO_MODELS);
    const out = await resolveMentalModelProposal("approve", pending(), "stage1", "op-42", deps);

    expect(out).toEqual({ outcome: "applied" });
    // Config was read + an edit dispatched whose diff APPENDS the model.
    expect(spies.readConfigText).toHaveBeenCalledTimes(1);
    expect(spies.dispatchConfigEdit).toHaveBeenCalledTimes(1);
    const editArg = spies.dispatchConfigEdit.mock.calls[0][0];
    expect(editArg.agent).toBe("coach");
    expect(editArg.diff).toContain("+++ b/switchroom.yaml");
    expect(editArg.diff).toContain("plan");
    // Single-tap correlation registered then cleared (single-shot).
    expect(spies.registerPreApproval).toHaveBeenCalledWith("coach", editArg.diff);
    expect(spies.clearPreApproval).toHaveBeenCalledWith("coach", editArg.diff);
    // Ensured.
    expect(spies.ensureModel).toHaveBeenCalledWith(pending().spec);
    // Agent woken with the applied inbound.
    expect(spies.injectInbound).toHaveBeenCalledTimes(1);
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_applied",
    );
  });

  it("a failed config edit yields a 'failed' inbound (honest — nothing landed)", async () => {
    const { deps, spies } = makeDeps(CONFIG_NO_MODELS, {
      dispatchConfigEdit: vi.fn(async () => ({ state: "error" as const, reason: "hostd down" })),
    });
    const out = await resolveMentalModelProposal("approve", pending(), "s", "op", deps);
    expect(out).toEqual({ outcome: "failed", reason: "hostd down" });
    expect(spies.ensureModel).not.toHaveBeenCalled();
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_failed",
    );
  });

  it("REJECTS a duplicate BEFORE dispatching any edit (no write, no correlation)", async () => {
    const { deps, spies } = makeDeps(CONFIG_DUP);
    const out = await resolveMentalModelProposal("approve", pending(), "s", "op", deps);
    expect(out.outcome).toBe("rejected");
    expect(spies.dispatchConfigEdit).not.toHaveBeenCalled();
    expect(spies.registerPreApproval).not.toHaveBeenCalled();
    expect(spies.ensureModel).not.toHaveBeenCalled();
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_failed",
    );
  });

  it("a successful declaration is NOT flipped to failure by an ensure error", async () => {
    const { deps, spies } = makeDeps(CONFIG_NO_MODELS, {
      ensureModel: vi.fn(async () => {
        throw new Error("hindsight unreachable");
      }),
    });
    const out = await resolveMentalModelProposal("approve", pending(), "s", "op", deps);
    // Model IS declared (reconcile will ensure regardless); still "applied".
    expect(out).toEqual({ outcome: "applied" });
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_applied",
    );
  });
});

describe("resolveMentalModelProposal — #2975 Stage 1 rate-limit backstop", () => {
  const NOW = 1_700_000_000_000;
  const RETRY_AT = NOW + 55 * 60_000; // hostd's window-open time

  /**
   * Build deps whose dispatchConfigEdit yields `results` in order (one per
   * attempt), plus a manual single-slot scheduler the test fires by hand — a
   * mocked clock, no real timers.
   */
  function rateDeps(results: Array<Awaited<ReturnType<ResolveDeps["dispatchConfigEdit"]>>>) {
    let call = 0;
    let scheduled: { delayMs: number; fn: () => void | Promise<void> } | null = null;
    const spies = {
      registerPreApproval: vi.fn(),
      clearPreApproval: vi.fn(),
      dispatchConfigEdit: vi.fn(async () => results[Math.min(call++, results.length - 1)]!),
      ensureModel: vi.fn(async () => {}),
      injectInbound: vi.fn(),
      scheduleRetry: vi.fn((delayMs: number, fn: () => void | Promise<void>) => {
        scheduled = { delayMs, fn };
      }),
      editProposalCardRateWindow: vi.fn(),
      notifyPersistFailed: vi.fn(),
    };
    const deps: ResolveDeps = {
      readConfigText: () => CONFIG_NO_MODELS,
      registerPreApproval: spies.registerPreApproval,
      clearPreApproval: spies.clearPreApproval,
      dispatchConfigEdit: spies.dispatchConfigEdit,
      ensureModel: spies.ensureModel,
      injectInbound: spies.injectInbound,
      scheduleRetry: spies.scheduleRetry,
      editProposalCardRateWindow: spies.editProposalCardRateWindow,
      notifyPersistFailed: spies.notifyPersistFailed,
      now: () => NOW,
    };
    return { deps, spies, fireScheduled: () => scheduled!.fn(), getScheduled: () => scheduled };
  }

  it("schedules EXACTLY ONE retry at retry_after, which persists with a byte-identical diff", async () => {
    const { deps, spies, fireScheduled, getScheduled } = rateDeps([
      { state: "rate_limited", reason: "config_propose_edit rate limit exceeded", retryAtMs: RETRY_AT },
      { state: "applied" },
    ]);

    const out = await resolveMentalModelProposal("approve", pending(), "stage1", "op-42", deps);

    // The turn is deferred, not lost: a single retry is scheduled at the window.
    expect(out).toEqual({ outcome: "scheduled_retry", retryAtMs: RETRY_AT });
    expect(spies.scheduleRetry).toHaveBeenCalledTimes(1);
    expect(getScheduled()!.delayMs).toBe(RETRY_AT - NOW);
    // Card flipped to the "applying at HH:MM" state so the operator sees it.
    expect(spies.editProposalCardRateWindow).toHaveBeenCalledWith(RETRY_AT);
    // First (rate-limited) attempt already registered+cleared its correlation.
    expect(spies.dispatchConfigEdit).toHaveBeenCalledTimes(1);
    const firstDiff = spies.dispatchConfigEdit.mock.calls[0][0].diff;
    expect(spies.registerPreApproval).toHaveBeenCalledWith("coach", firstDiff);
    // Nothing applied yet.
    expect(spies.ensureModel).not.toHaveBeenCalled();
    expect(spies.injectInbound).not.toHaveBeenCalled();

    // Fire the ONE scheduled retry (mocked clock).
    await fireScheduled();

    // Persisted on the retry.
    expect(spies.dispatchConfigEdit).toHaveBeenCalledTimes(2);
    const retryDiff = spies.dispatchConfigEdit.mock.calls[1][0].diff;
    // Forge-resistance contract: register + dispatch use IDENTICAL diff bytes,
    // and the retry re-registers the SAME bytes as the first attempt.
    expect(retryDiff).toBe(firstDiff);
    expect(spies.registerPreApproval).toHaveBeenCalledTimes(2);
    expect(spies.registerPreApproval.mock.calls[1]).toEqual(["coach", retryDiff]);
    expect(spies.clearPreApproval).toHaveBeenCalledTimes(2);
    // Applied: ensured + agent woken; NO loud failure.
    expect(spies.ensureModel).toHaveBeenCalledWith(pending().spec);
    expect(spies.injectInbound).toHaveBeenCalledTimes(1);
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_applied",
    );
    expect(spies.notifyPersistFailed).not.toHaveBeenCalled();
  });

  it("emits a loud operator failure when the single retry ALSO fails — and does NOT re-schedule", async () => {
    const { deps, spies, fireScheduled } = rateDeps([
      { state: "rate_limited", reason: "rate limit exceeded", retryAtMs: RETRY_AT },
      { state: "error", reason: "hostd down" },
    ]);

    const out = await resolveMentalModelProposal("approve", pending(), "s", "op", deps);
    expect(out.outcome).toBe("scheduled_retry");
    expect(spies.scheduleRetry).toHaveBeenCalledTimes(1);

    await fireScheduled();

    // The retry failed: loud operator-events notification, exactly once.
    expect(spies.notifyPersistFailed).toHaveBeenCalledTimes(1);
    expect(spies.notifyPersistFailed.mock.calls[0][0]).toContain("hostd down");
    // No second retry — bounded to exactly one.
    expect(spies.scheduleRetry).toHaveBeenCalledTimes(1);
    // Agent woken with the failed inbound; nothing ensured.
    expect(spies.ensureModel).not.toHaveBeenCalled();
    expect(spies.injectInbound).toHaveBeenCalledTimes(1);
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_failed",
    );
  });

  it("with no scheduler wired, a rate-limited persist fails loudly instead of silently dropping", async () => {
    const { deps, spies } = rateDeps([
      { state: "rate_limited", reason: "rate limit exceeded", retryAtMs: RETRY_AT },
    ]);
    // Simulate a build without the Stage-1 scheduler dep.
    delete (deps as { scheduleRetry?: unknown }).scheduleRetry;

    const out = await resolveMentalModelProposal("approve", pending(), "s", "op", deps);
    expect(out).toEqual({ outcome: "failed", reason: "rate limit exceeded" });
    expect(spies.notifyPersistFailed).toHaveBeenCalledTimes(1);
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_failed",
    );
  });
});

describe("resolveMentalModelProposal — DENY writes NOTHING", () => {
  it("never reads config, builds a diff, dispatches an edit, or ensures", async () => {
    const { deps, spies } = makeDeps(CONFIG_NO_MODELS);
    const out = await resolveMentalModelProposal("deny", pending(), "stage1", "op-42", deps);

    expect(out).toEqual({ outcome: "denied" });
    expect(spies.readConfigText).not.toHaveBeenCalled();
    expect(spies.dispatchConfigEdit).not.toHaveBeenCalled();
    expect(spies.registerPreApproval).not.toHaveBeenCalled();
    expect(spies.ensureModel).not.toHaveBeenCalled();
    // Only side effect is waking the agent with the denied inbound.
    expect(spies.injectInbound).toHaveBeenCalledTimes(1);
    expect(spies.injectInbound.mock.calls[0][0].meta.source).toBe(
      "mental_model_proposal_denied",
    );
  });
});
