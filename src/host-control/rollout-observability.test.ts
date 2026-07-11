/**
 * #2726 — durable rollout observability: the audit-reader helper that
 * un-blinds `get_status` (latestRolloutRowForRequest) and the pure status
 * renderer (renderRolloutStatus). Both are pure functions exercised without a
 * daemon or a gateway.
 */

import { describe, it, expect } from "vitest";
import {
  latestRolloutRowForRequest,
  parseAuditLine,
} from "./audit-reader.js";
import {
  renderRolloutStatus,
  formatDurationMs,
} from "./render-rollout-status.js";

/** Build one JSONL audit row (the shape hostd writes, chain fields elided —
 *  parseAuditLine ignores `_seq`/`_prev`/`_hash`). */
function row(o: Record<string, unknown>): string {
  return (
    JSON.stringify({
      ts: "2026-07-01T00:00:00.000Z",
      caller: { kind: "agent", name: "overlord" },
      exit_code: null,
      duration_ms: 10,
      ...o,
    }) + "\n"
  );
}

describe("latestRolloutRowForRequest", () => {
  const REQ = "req-abc";

  it("returns null when no rollout row exists for the request", () => {
    const log =
      row({ op: "apply", request_id: "other", result: "started" }) +
      row({ op: "rollout", request_id: "different", phase: "apply", result: "started" });
    expect(latestRolloutRowForRequest(log, REQ)).toBeNull();
  });

  it("returns the LATEST rollout row (last-written phase) for the request", () => {
    const log =
      row({ op: "rollout", request_id: REQ, phase: "apply", result: "started", pin: "v1.2.3" }) +
      row({ op: "rollout", request_id: REQ, phase: "canary-start", result: "started", pin: "v1.2.3", agent: "test-harness", n: 1, m: 3 }) +
      row({ op: "rollout", request_id: REQ, phase: "agent-start", result: "started", pin: "v1.2.3", agent: "clerk", n: 2, m: 3 });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.phase).toBe("agent-start");
    expect(latest?.agent).toBe("clerk");
    expect(latest?.n).toBe(2);
    expect(latest?.m).toBe(3);
    expect(latest?.pin).toBe("v1.2.3");
  });

  it("returns the terminal row once it is written", () => {
    const log =
      row({ op: "rollout", request_id: REQ, phase: "agent-start", result: "started", pin: "v1.2.3", agent: "clerk", n: 2, m: 3 }) +
      row({ op: "rollout", request_id: REQ, phase: "terminal", result: "completed", pin: "v1.2.3", rolled: ["test-harness", "clerk", "marko"], prior_pin: "v1.2.2" });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.phase).toBe("terminal");
    expect(latest?.result).toBe("completed");
    expect(latest?.rolled).toEqual(["test-harness", "clerk", "marko"]);
    expect(latest?.prior_pin).toBe("v1.2.2");
  });

  it("includes the synthetic rollout_orphaned op", () => {
    const log =
      row({ op: "rollout", request_id: REQ, result: "started" }) +
      row({ op: "rollout_orphaned", request_id: REQ, phase: "orphan_reconciled", result: "error" });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.op).toBe("rollout_orphaned");
    expect(latest?.result).toBe("error");
  });

  it("ignores non-rollout ops sharing the request_id", () => {
    const log =
      row({ op: "rollout", request_id: REQ, phase: "apply", result: "started" }) +
      // A different op (shouldn't happen with distinct request_ids, but be defensive).
      row({ op: "agent_restart", request_id: REQ, result: "completed" });
    const latest = latestRolloutRowForRequest(log, REQ);
    expect(latest?.op).toBe("rollout");
    expect(latest?.phase).toBe("apply");
  });

  it("tolerates torn / malformed lines (parseAuditLine returns null)", () => {
    const log =
      "{ not json\n" +
      row({ op: "rollout", request_id: REQ, phase: "canary-pass", result: "started" }) +
      "\n"; // trailing blank
    expect(latestRolloutRowForRequest(log, REQ)?.phase).toBe("canary-pass");
  });
});

describe("audit-reader parses rollout phase fields", () => {
  it("parses agent / n / m off a phase row", () => {
    const e = parseAuditLine(
      row({ op: "rollout", request_id: "r", phase: "agent-start", result: "started", agent: "clerk", n: 4, m: 9 }),
    );
    expect(e?.agent).toBe("clerk");
    expect(e?.n).toBe(4);
    expect(e?.m).toBe(9);
  });
});

describe("formatDurationMs", () => {
  it("formats seconds / minutes / hours compactly", () => {
    expect(formatDurationMs(42_000)).toBe("42s");
    expect(formatDurationMs(190_000)).toBe("3m 10s");
    expect(formatDurationMs(180_000)).toBe("3m");
    expect(formatDurationMs(3_900_000)).toBe("1h 5m");
    expect(formatDurationMs(-5)).toBe("0s");
  });
});

describe("renderRolloutStatus", () => {
  it("renders an in-flight applying header", () => {
    const out = renderRolloutStatus({ target: "v1.2.3", phase: "apply" });
    expect(out).toContain("v1.2.3");
    expect(out).toContain("applying");
    expect(out.startsWith("⏳")).toBe(true);
  });

  it("headers with from → to versions and the short request id", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      fromVersion: "v1.2.2",
      requestId: "ro-abcdef1234567890xyz",
      phase: "apply",
    });
    const header = out.split("\n")[0]!;
    expect(header).toContain("`v1.2.2` → `v1.2.3`");
    expect(header).toContain("req `ro-abcdef1234567…`");
  });

  it("renders agent N/M progress with the rolled count footer", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      agent: "clerk",
      n: 3,
      m: 8,
      rolled: ["test-harness", "marko"],
    });
    expect(out).toContain("agent 3/8");
    expect(out).toContain("clerk");
    expect(out).toContain("2/8 rolled");
  });

  it("renders the per-agent checklist (✓ done / ⏳ running / ✗ failed / · pending) with durations", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      agent: "clerk",
      n: 3,
      m: 5,
      rolled: ["test-harness", "marko"],
      agents: [
        { name: "test-harness", status: "done", canary: true, durationMs: 42_000 },
        { name: "marko", status: "done", durationMs: 38_000 },
        { name: "clerk", status: "running" },
      ],
    });
    expect(out).toContain("- ✓ `test-harness` (canary) — 42s");
    expect(out).toContain("- ✓ `marko` — 38s");
    expect(out).toContain("- ⏳ `clerk` — restarting…");
    // 5 total, 3 known → 2 collapsed pending.
    expect(out).toContain("- · 2 more pending");
    // No literal • bullets (progress-card vocabulary uses `-` lists).
    expect(out).not.toContain("•");
  });

  it("estimates a rough ETA from the mean per-agent duration so far", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      m: 4,
      rolled: ["a", "b"],
      agents: [
        { name: "a", status: "done", durationMs: 30_000 },
        { name: "b", status: "done", durationMs: 60_000 },
        { name: "c", status: "running" },
      ],
    });
    // mean 45s × 2 remaining = 1m 30s.
    expect(out).toContain("~1m 30s left (rough est.)");
  });

  it("shows elapsed from startedAtMs/nowMs while in flight", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      phase: "agent-start",
      m: 3,
      startedAtMs: 1_000_000,
      nowMs: 1_105_000,
    });
    expect(out).toContain("elapsed 1m 45s");
  });

  it("renders the ✅ terminal summary with rolled list, elapsed total and deferred components", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "completed",
      rolled: ["test-harness", "clerk"],
      m: 2,
      elapsedMs: 492_000,
    });
    expect(out.startsWith("✅")).toBe(true);
    expect(out).toContain("Done");
    expect(out).toContain("rolled 2/2 agent(s) in 8m 12s");
    expect(out).toContain("test-harness, clerk");
    // Deferred host-side components with their exact update commands.
    expect(out).toContain("Deferred");
    expect(out).toContain("switchroom webd install --tag v1.2.3");
    expect(out).toContain("sudo npm i -g switchroom@1.2.3");
    expect(out).toContain("switchroom hostd install --tag v1.2.3");
  });

  it("renders the ❌ terminal-error summary with the failed step + agent", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "error",
      failedStep: "restart-agent",
      failedAgent: "clerk",
      got: "1.2.2",
      rolled: ["test-harness"],
      elapsedMs: 65_000,
    });
    expect(out.startsWith("❌")).toBe(true);
    expect(out).toContain("STOPPED");
    expect(out).toContain("restart-agent");
    expect(out).toContain("clerk");
    expect(out).toContain("1.2.2");
    expect(out).toContain("test-harness");
    expect(out).toContain("after 1m 5s");
    // A failed roll must NOT advertise the deferred-update commands.
    expect(out).not.toContain("Deferred");
  });

  it("renders 'unreachable' when the failed agent version is null", () => {
    const out = renderRolloutStatus({
      target: "v1.2.3",
      terminal: "error",
      failedStep: "restart-agent",
      failedAgent: "clerk",
      got: null,
    });
    expect(out).toContain("unreachable");
  });
});
