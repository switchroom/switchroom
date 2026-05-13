/**
 * Tests for the reconcile-all batch summary helper.
 *
 * The reconcile-all loop in `agent.ts` aggregates per-agent failures
 * (rather than aborting the batch on the first failure) and exits
 * non-zero when any agent failed. This test pins the helper's
 * formatting contract so the summary stays parseable for callers /
 * CI grep.
 */

import { describe, it, expect } from "vitest";
import { summarizeReconcileBatch } from "./agent.js";

describe("summarizeReconcileBatch", () => {
  it("returns null when no agents failed", () => {
    expect(summarizeReconcileBatch(3, [])).toBeNull();
  });

  it("reports success / fail counts when at least one agent failed", () => {
    const out = summarizeReconcileBatch(3, [
      { name: "alice", error: "boom" },
    ]);
    expect(out).not.toBeNull();
    expect(out!.header).toBe("Summary: 2 succeeded, 1 failed");
    expect(out!.lines).toEqual(["alice: boom"]);
  });

  it("lists every failure when multiple agents fail", () => {
    const out = summarizeReconcileBatch(4, [
      { name: "alice", error: "boom" },
      { name: "bob", error: "permission denied" },
    ]);
    expect(out!.header).toBe("Summary: 2 succeeded, 2 failed");
    expect(out!.lines).toEqual([
      "alice: boom",
      "bob: permission denied",
    ]);
  });

  it("handles the case where every agent failed", () => {
    const out = summarizeReconcileBatch(2, [
      { name: "alice", error: "x" },
      { name: "bob", error: "y" },
    ]);
    expect(out!.header).toBe("Summary: 0 succeeded, 2 failed");
  });
});
