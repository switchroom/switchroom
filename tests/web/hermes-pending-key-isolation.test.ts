import { describe, it, expect } from "vitest";
import {
  claimPromptKey,
  pendingPromptKeys,
  type HermesWsContext,
} from "../../src/web/hermes-adapter.js";

/**
 * Regression coverage for the per-session pending-prompt-key isolation fix
 * (HERMES #2689 review defect #2). Before the fix, `pendingPromptKey` was a
 * single scalar on the WS context, so a prompt.submit to session B could be
 * cross-claimed by session A's incoming reply, and two rapid submits could
 * clobber each other. Keying by session_id removes both hazards.
 */

function makeCtx(): HermesWsContext {
  return {
    // config is unused by the functions under test.
    config: {} as HermesWsContext["config"],
    send: () => {},
  };
}

describe("claimPromptKey — per-session isolation", () => {
  it("claims and consumes only the matching session's pending key", () => {
    const ctx = makeCtx();
    pendingPromptKeys(ctx).set("agentA", "keyA");

    const res = claimPromptKey(ctx, "agentA", 1);
    expect(res).toEqual({ promptKey: "keyA", needsStart: false });
    // Consumed — a second reply on the same session synthesises a fresh key.
    expect(pendingPromptKeys(ctx).has("agentA")).toBe(false);
    const res2 = claimPromptKey(ctx, "agentA", 2);
    expect(res2).toEqual({ promptKey: "tg-2", needsStart: true });
  });

  it("does NOT cross-claim: a reply on session A leaves session B's key intact", () => {
    const ctx = makeCtx();
    pendingPromptKeys(ctx).set("agentB", "keyB");

    // A reply arrives on agentA, which has no pending submit.
    const resA = claimPromptKey(ctx, "agentA", 10);
    expect(resA).toEqual({ promptKey: "tg-10", needsStart: true });
    // agentB's pending key must be untouched.
    expect(pendingPromptKeys(ctx).get("agentB")).toBe("keyB");

    // agentB's own reply then correctly claims it.
    const resB = claimPromptKey(ctx, "agentB", 11);
    expect(resB).toEqual({ promptKey: "keyB", needsStart: false });
  });

  it("two rapid submits to different sessions each keep their own key", () => {
    const ctx = makeCtx();
    const keys = pendingPromptKeys(ctx);
    keys.set("agentA", "keyA");
    keys.set("agentB", "keyB");

    // Replies land interleaved; each resolves its own spinner.
    expect(claimPromptKey(ctx, "agentB", 1).promptKey).toBe("keyB");
    expect(claimPromptKey(ctx, "agentA", 2).promptKey).toBe("keyA");
    expect(keys.size).toBe(0);
  });

  it("a second rapid submit to the SAME session overwrites the pending key (last-writer wins, no stale claim)", () => {
    const ctx = makeCtx();
    const keys = pendingPromptKeys(ctx);
    keys.set("agentA", "first");
    keys.set("agentA", "second"); // simulate a rapid re-submit before a reply

    const res = claimPromptKey(ctx, "agentA", 1);
    expect(res.promptKey).toBe("second");
    expect(keys.has("agentA")).toBe(false);
  });

  it("pendingPromptKeys lazily initialises and is stable across calls", () => {
    const ctx = makeCtx();
    expect(ctx.pendingPromptKeys).toBeUndefined();
    const m1 = pendingPromptKeys(ctx);
    const m2 = pendingPromptKeys(ctx);
    expect(m1).toBe(m2);
    expect(ctx.pendingPromptKeys).toBe(m1);
  });
});
