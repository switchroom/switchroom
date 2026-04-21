import { describe, it, expect, vi } from "vitest";
import {
  buildAgentStatusReport,
  buildClaudeStatus,
  buildGatewayStatus,
  buildHindsightStatus,
  buildPollingStatus,
  buildMessageStatus,
  formatStatusText,
  parseSystemdTimestamp,
  readinessGaps,
  waitForAgentReady,
  type AgentStatusReport,
  type StatusInputs,
} from "../src/agents/status.js";

/**
 * Helper — build a StatusInputs with sensible stubbed defaults that each
 * test can override field-by-field. Keeps the assertions in each test tight.
 */
function makeInputs(overrides: Partial<StatusInputs> = {}): StatusInputs {
  return {
    agentName: "test-agent",
    agentDir: "/tmp/test-agent",
    hindsightApiUrl: "http://127.0.0.1:18888/mcp/",
    hindsightBankId: "test-agent",
    getClaudeProcess: () => ({
      pid: 1234,
      activeEnterTs: Date.now() - 60_000,
      active: "active",
    }),
    getGatewayProcess: () => ({
      pid: 1235,
      activeEnterTs: Date.now() - 60_000,
      active: "active",
    }),
    probeHindsight: async () => ({ reachable: true, bankExists: true }),
    readGatewayLog: () => "telegram gateway: polling as @test_bot\n",
    getLastMessages: () => ({
      lastInboundTs: Math.floor(Date.now() / 1000) - 30,
      lastOutboundTs: Math.floor(Date.now() / 1000) - 20,
    }),
    ...overrides,
  };
}

describe("buildClaudeStatus", () => {
  it("returns ok when process is active with pid", () => {
    const result = buildClaudeStatus({
      pid: 1234,
      activeEnterTs: Date.now() - 120_000, // 2 minutes ago
      active: "active",
    });
    expect(result.state).toBe("ok");
    expect(result.pid).toBe(1234);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(119);
    expect(result.detail).toContain("pid=1234");
  });

  it("returns fail when process is not active", () => {
    const result = buildClaudeStatus({
      pid: null,
      activeEnterTs: null,
      active: "inactive",
    });
    expect(result.state).toBe("fail");
    expect(result.pid).toBeNull();
    expect(result.detail).toContain("not running");
  });

  it("returns fail when active but pid is 0", () => {
    const result = buildClaudeStatus({
      pid: null,
      activeEnterTs: null,
      active: "active",
    });
    expect(result.state).toBe("fail");
  });
});

describe("buildGatewayStatus", () => {
  it("returns ok with pid when gateway is active", () => {
    const result = buildGatewayStatus({
      pid: 1235,
      activeEnterTs: Date.now() - 60_000,
      active: "active",
    });
    expect(result.state).toBe("ok");
    expect(result.pid).toBe(1235);
  });

  it("returns fail when gateway is inactive", () => {
    const result = buildGatewayStatus({
      pid: null,
      activeEnterTs: null,
      active: "inactive",
    });
    expect(result.state).toBe("fail");
  });
});

describe("buildHindsightStatus", () => {
  it("returns ok when reachable and bank exists", () => {
    const result = buildHindsightStatus({ reachable: true, bankExists: true });
    expect(result.state).toBe("ok");
  });

  it("returns fail (missing-bank) when reachable but bank absent", () => {
    const result = buildHindsightStatus({ reachable: true, bankExists: false });
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("bank does not exist");
  });

  it("returns fail (unreachable) when daemon is down", () => {
    const result = buildHindsightStatus({
      reachable: false,
      bankExists: false,
      reason: "daemon not running",
    });
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("unreachable");
    expect(result.detail).toContain("daemon not running");
  });
});

describe("buildPollingStatus", () => {
  it("extracts bot handle from polling line", () => {
    const log = "telegram gateway: polling as @clerk_meken_bot\n";
    const result = buildPollingStatus(log);
    expect(result.state).toBe("ok");
    expect(result.botHandle).toBe("clerk_meken_bot");
  });

  it("uses the most recent polling line when multiple exist", () => {
    const log = [
      "telegram gateway: polling as @old_handle",
      "some other log line",
      "telegram gateway: polling as @new_handle",
    ].join("\n");
    const result = buildPollingStatus(log);
    expect(result.botHandle).toBe("new_handle");
  });

  it("returns fail when polling line is absent", () => {
    const log = "gateway starting up\nno polling info\n";
    const result = buildPollingStatus(log);
    expect(result.state).toBe("fail");
    expect(result.botHandle).toBeNull();
    expect(result.detail).toContain("no 'polling as @bot' line");
  });

  it("returns fail when log file is missing (null)", () => {
    const result = buildPollingStatus(null);
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("gateway.log not found");
  });

  it("returns fail when polling failed after last start", () => {
    const log = [
      "telegram gateway: polling as @my_bot",
      "telegram gateway: polling failed: 401 unauthorized",
    ].join("\n");
    const result = buildPollingStatus(log);
    expect(result.state).toBe("fail");
    expect(result.botHandle).toBe("my_bot");
    expect(result.detail).toContain("polling reported failure");
  });
});

describe("buildMessageStatus", () => {
  it("returns ok with both timestamps", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = buildMessageStatus({
      lastInboundTs: now - 60,
      lastOutboundTs: now - 30,
    });
    expect(result.state).toBe("ok");
    expect(result.detail).toContain("in=");
    expect(result.detail).toContain("out=");
  });

  it("returns warn when DB is empty", () => {
    const result = buildMessageStatus({
      lastInboundTs: null,
      lastOutboundTs: null,
    });
    expect(result.state).toBe("warn");
    expect(result.detail).toContain("no messages");
  });

  it("returns fail when error is set", () => {
    const result = buildMessageStatus({
      lastInboundTs: null,
      lastOutboundTs: null,
      error: "history.db not found at /some/path",
    });
    expect(result.state).toBe("fail");
    expect(result.detail).toContain("history.db not found");
  });

  it("renders em-dash placeholder when only one side has a timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = buildMessageStatus({
      lastInboundTs: now - 10,
      lastOutboundTs: null,
    });
    expect(result.state).toBe("ok");
    expect(result.detail).toMatch(/out=/);
    expect(result.detail).toContain("—");
  });
});

describe("buildAgentStatusReport — end-to-end composition", () => {
  it("all-green case — overall ok", async () => {
    const report = await buildAgentStatusReport(makeInputs());
    expect(report.overallState).toBe("ok");
    expect(report.claude.state).toBe("ok");
    expect(report.gateway.state).toBe("ok");
    expect(report.hindsight.state).toBe("ok");
    expect(report.polling.state).toBe("ok");
    expect(report.messages.state).toBe("ok");
  });

  it("claude PID missing → overall fail", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        getClaudeProcess: () => ({
          pid: null,
          activeEnterTs: null,
          active: "inactive",
        }),
      }),
    );
    expect(report.overallState).toBe("fail");
    expect(report.claude.state).toBe("fail");
    // Other checks still run
    expect(report.gateway.state).toBe("ok");
  });

  it("Hindsight unreachable → overall fail, distinct from missing-bank", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        probeHindsight: async () => ({
          reachable: false,
          bankExists: false,
          reason: "daemon not running",
        }),
      }),
    );
    expect(report.overallState).toBe("fail");
    expect(report.hindsight.state).toBe("fail");
    expect(report.hindsight.detail).toContain("unreachable");
  });

  it("Hindsight reachable but bank missing → overall fail with specific detail", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        probeHindsight: async () => ({
          reachable: true,
          bankExists: false,
        }),
      }),
    );
    expect(report.overallState).toBe("fail");
    expect(report.hindsight.state).toBe("fail");
    expect(report.hindsight.detail).toContain("bank does not exist");
    // Crucially: NOT "unreachable" — operator needs to know the difference.
    expect(report.hindsight.detail).not.toContain("unreachable");
  });

  it("polling line absent → overall fail", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        readGatewayLog: () => "gateway booted\nsome other lines\n",
      }),
    );
    expect(report.overallState).toBe("fail");
    expect(report.polling.state).toBe("fail");
  });

  it("Hindsight not configured → check is ok (skipped)", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        hindsightApiUrl: null,
      }),
    );
    expect(report.hindsight.state).toBe("ok");
    expect(report.hindsight.detail).toContain("not configured");
    expect(report.overallState).toBe("ok");
  });

  it("probe that throws is caught and surfaced as fail", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        probeHindsight: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(report.hindsight.state).toBe("fail");
    expect(report.hindsight.detail).toContain("boom");
    expect(report.overallState).toBe("fail");
  });

  it("empty history.db (new agent) → warn, but overall still ok if nothing else fails", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        getLastMessages: () => ({
          lastInboundTs: null,
          lastOutboundTs: null,
        }),
      }),
    );
    expect(report.messages.state).toBe("warn");
    // A fresh agent shouldn't fail status just because no one has talked
    // to it yet — that's a normal state.
    expect(report.overallState).toBe("ok");
  });
});

describe("parseSystemdTimestamp", () => {
  it("parses the systemd format with weekday and AEST zone", () => {
    const ms = parseSystemdTimestamp("Tue 2026-04-21 16:38:48 AEST");
    expect(ms).not.toBeNull();
    expect(typeof ms).toBe("number");
  });

  it("parses the systemd format with UTC zone", () => {
    const ms = parseSystemdTimestamp("Tue 2026-04-21 06:38:48 UTC");
    expect(ms).toBe(Date.UTC(2026, 3, 21, 6, 38, 48));
  });

  it("falls back when zone abbreviation is unknown", () => {
    // Made-up zone — strip weekday, Date.parse may still handle it; if
    // not, the local-time fallback kicks in and we get a non-null answer.
    const ms = parseSystemdTimestamp("Tue 2026-04-21 16:38:48 XYZT");
    expect(ms).not.toBeNull();
  });

  it("returns null on empty input", () => {
    expect(parseSystemdTimestamp("")).toBeNull();
  });

  it("returns null on garbage", () => {
    expect(parseSystemdTimestamp("not a timestamp")).toBeNull();
  });
});

describe("formatStatusText", () => {
  it("produces grep-stable key: value lines", async () => {
    const report = await buildAgentStatusReport(makeInputs());
    const text = formatStatusText(report);
    const lines = text.split("\n");
    // Every line begins with a stable keyword. Scripts can `grep ^claude:`.
    expect(lines.some((l) => l.startsWith("agent: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("overall: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("claude: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("gateway: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("hindsight: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("polling: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("messages: "))).toBe(true);
    // No ANSI color codes (grep-stable in non-tty pipelines).
    expect(text).not.toMatch(/\[/);
  });

  it("includes the bot handle when polling ok", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        readGatewayLog: () => "telegram gateway: polling as @my_cool_bot\n",
      }),
    );
    const text = formatStatusText(report);
    expect(text).toContain("@my_cool_bot");
  });

  it("overall: fail when any check fails", async () => {
    const report = await buildAgentStatusReport(
      makeInputs({
        getClaudeProcess: () => ({ pid: null, activeEnterTs: null, active: "inactive" }),
      }),
    );
    const text = formatStatusText(report);
    expect(text).toContain("overall: fail");
    expect(text).toContain("claude: fail");
  });
});

describe("readinessGaps", () => {
  function reportWith(overrides: Partial<AgentStatusReport> = {}): AgentStatusReport {
    const base: AgentStatusReport = {
      name: "test-agent",
      claude: { state: "ok", pid: 1, uptimeSeconds: 10, detail: "ok" },
      gateway: { state: "ok", pid: 2, detail: "ok" },
      hindsight: { state: "ok", detail: "ok" },
      polling: { state: "ok", botHandle: "b", detail: "@b" },
      messages: { state: "ok", lastInboundTs: 1, lastOutboundTs: 1, detail: "ok" },
      overallState: "ok",
    };
    return { ...base, ...overrides };
  }

  it("returns empty list when all components are ok", () => {
    expect(readinessGaps(reportWith())).toEqual([]);
  });

  it("names each failing component", () => {
    const gaps = readinessGaps(
      reportWith({
        claude: { state: "fail", pid: null, uptimeSeconds: null, detail: "x" },
        gateway: { state: "fail", pid: null, detail: "x" },
        hindsight: { state: "fail", detail: "x" },
        polling: { state: "fail", botHandle: null, detail: "x" },
      }),
    );
    expect(gaps).toEqual(["claude", "gateway", "hindsight", "polling"]);
  });

  it("excludes messages from readiness gaps even when warn/fail", () => {
    const gaps = readinessGaps(
      reportWith({
        messages: {
          state: "warn",
          lastInboundTs: null,
          lastOutboundTs: null,
          detail: "empty db",
        },
      }),
    );
    expect(gaps).toEqual([]);
  });

  it("treats hindsight 'ok — not configured' as ready (no gap)", () => {
    // When hindsight is not configured for the agent, state is ok by
    // construction. Confirm the gap list stays empty.
    expect(readinessGaps(reportWith({ hindsight: { state: "ok", detail: "not configured" } }))).toEqual([]);
  });
});

describe("waitForAgentReady", () => {
  it("returns ready: true on first poll when every component is ok", async () => {
    const sleep = vi.fn(async () => {});
    const result = await waitForAgentReady(makeInputs(), {
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      sleep,
    });
    expect(result.ready).toBe(true);
    expect(result.notReady).toEqual([]);
    // Never needed to sleep — fast-path. Guarantees start/restart return
    // immediately when the agent is already serveable.
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns ready: false with notReady list when the deadline elapses", async () => {
    // Simulate the gateway log never getting its "polling as @bot" line.
    // Advance a virtual clock by returning fixed values from `now`.
    const times = [0, 100, 800, 1600, 2400, 3200, 4000, 4800, 5600];
    let i = 0;
    const now = () => times[Math.min(i++, times.length - 1)];
    const sleep = vi.fn(async () => {});

    const inputs = makeInputs({
      readGatewayLog: () => "", // no polling line → polling state = fail
    });

    const result = await waitForAgentReady(inputs, {
      timeoutMs: 1_000,
      pollIntervalMs: 500,
      sleep,
      now,
    });

    expect(result.ready).toBe(false);
    expect(result.notReady).toContain("polling");
    // sleep was called at least once before giving up (we did poll, not
    // just bail on the first probe).
    expect(sleep).toHaveBeenCalled();
  });

  it("polls until the failing probe recovers", async () => {
    // First call fails (no polling line), subsequent calls succeed.
    let calls = 0;
    const readGatewayLog = () => {
      calls += 1;
      return calls === 1 ? "" : "telegram gateway: polling as @bot\n";
    };

    const sleep = vi.fn(async () => {});
    const result = await waitForAgentReady(
      makeInputs({ readGatewayLog }),
      { timeoutMs: 5_000, pollIntervalMs: 50, sleep },
    );

    expect(result.ready).toBe(true);
    expect(result.notReady).toEqual([]);
    // We slept exactly once between the failing first probe and the
    // succeeding second probe. Guards against a regression where the
    // loop either busy-spins or doesn't re-probe at all.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
