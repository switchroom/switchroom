import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveHindsightRecallTunables,
  renderHindsightHooksOverrides,
} from "../src/setup/hindsight-recall-tunables.js";

/**
 * The hindsight SessionStart hook must run ASYNC.
 *
 * session_start.py does the durability work a prior session's abrupt death
 * skipped — drain the SessionEnd-queued retains (#1071) and reconcile
 * un-committed transcript turns (#3244). Both carry independent 4s
 * wall-clock budgets, and a Mode-1 external server adds a ~2s health probe;
 * summed, they routinely overran the old synchronous 5s SessionStart
 * timeout, so Claude Code SIGKILLed the hook mid-drain on a large share of
 * firings (fleet-wide `hook_cancelled` transcript attachments, all with
 * `durationMs > 5000` and `timedOut: true`). That truncated exactly the
 * durability work the hook exists to do.
 *
 * The fix is `"async": true` on the hook (hooks/hooks.json): the hook
 * injects NO additionalContext, so nothing in the session depends on it
 * finishing before the first prompt, and async's dropped context costs
 * nothing here. Empirically the fleet's two async hooks (retain.py,
 * subagent_retain.py) record ZERO cancellations while every synchronous
 * hook does — so async is what actually stops the timeout kill.
 *
 * These assert the OUTCOME (async + a timeout ceiling that clears the
 * summed sub-budgets) so a vendor bump or a hand-edit can't silently
 * revert it back to a synchronous 5s hook that gets cut off.
 */

const HOOKS_JSON = join(
  process.cwd(),
  "vendor",
  "hindsight-memory",
  "hooks",
  "hooks.json",
);

/** drain budget (4s) + reconcile budget (4s) + Mode-1 health probe (~2s). */
const SUMMED_DURABILITY_BUDGET_SECONDS = 10;

interface HookLeaf {
  command?: string;
  timeout?: number;
  async?: boolean;
}

function sessionStartHook(rawJson: string): HookLeaf {
  const parsed = JSON.parse(rawJson) as {
    hooks: Record<string, Array<{ hooks: HookLeaf[] }>>;
  };
  const matchers = parsed.hooks.SessionStart;
  expect(Array.isArray(matchers)).toBe(true);
  const leaves = matchers
    .flatMap((m) => m.hooks ?? [])
    .filter((h) => typeof h.command === "string" && h.command.includes("session_start.py"));
  expect(leaves).toHaveLength(1);
  return leaves[0];
}

describe("hindsight SessionStart hook is async", () => {
  const raw = readFileSync(HOOKS_JSON, "utf-8");

  it("runs async so drain + reconcile can't be killed at the SessionStart budget", () => {
    const hook = sessionStartHook(raw);
    expect(hook.async).toBe(true);
  });

  it("carries a timeout ceiling above the summed drain+reconcile+probe budgets", () => {
    const hook = sessionStartHook(raw);
    expect(typeof hook.timeout).toBe("number");
    // A ceiling at or under the summed sub-budgets would reintroduce the
    // mid-work kill even while async. Require real headroom over ~10s.
    expect(hook.timeout).toBeGreaterThan(SUMMED_DURABILITY_BUDGET_SECONDS);
  });

  it("keeps the async flag after the scaffold's recall-hook override runs", () => {
    // installHindsightPlugin re-stamps only the UserPromptSubmit recall
    // timeout via renderHindsightHooksOverrides on every reconcile/restart.
    // The SessionStart async flag must survive that round-trip untouched, or
    // the fix would silently revert on the next `switchroom apply`.
    const tunables = resolveHindsightRecallTunables({ hook_timeout_seconds: 12 });
    const stamped = renderHindsightHooksOverrides(raw, tunables);
    expect(stamped).not.toBeNull();
    const hook = sessionStartHook(stamped!);
    expect(hook.async).toBe(true);
    expect(hook.timeout).toBeGreaterThan(SUMMED_DURABILITY_BUDGET_SECONDS);
  });
});
