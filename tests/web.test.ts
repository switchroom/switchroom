import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock lifecycle module
vi.mock("../src/agents/lifecycle.js", () => ({
  getAllAgentStatuses: vi.fn(),
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  restartAgent: vi.fn(),
  containerName: (name: string) => `switchroom-${name}`,
}));

// Mock auth module
vi.mock("../src/auth/manager.js", () => ({
  getAllAuthStatuses: vi.fn(),
}));

// Mock config loader
vi.mock("../src/config/loader.js", () => ({
  resolveAgentsDir: vi.fn(() => "/home/test/.switchroom/agents"),
}));

// Account store — handleGetAccounts reads the on-disk inventory.
vi.mock("../src/auth/account-store.js", () => ({
  getAccountInfos: vi.fn(() => []),
}));

// Analytics is fire-and-forget; stub so handleUseAccount doesn't
// reach PostHog during the unit test.
vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  captureException: vi.fn(),
}));

// Approval-kernel client — handleGetApprovals reads the kernel's
// read-only operator socket. Stub the resolver + list call so the
// unit test never opens a real UDS.
vi.mock("../src/vault/approvals/client.js", () => ({
  resolveKernelOperatorSocket: vi.fn(() => null),
  approvalList: vi.fn(async () => null),
}));

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

// Auth-broker client — used by the accounts handlers and the new
// system-health handler. vi.mock is hoisted above all top-level decls,
// so the shared state + error classes must live inside vi.hoisted().
const brokerHoist = vi.hoisted(() => {
  class FakeUnreachable extends Error {}
  class FakeBrokerError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  }
  return {
    FakeUnreachable,
    FakeBrokerError,
    impl: { run: null as null | ((client: unknown) => Promise<unknown>) },
  };
});
const brokerImpl = brokerHoist.impl;
vi.mock("../src/auth/broker/client.js", () => ({
  AuthBrokerUnreachableError: brokerHoist.FakeUnreachable,
  AuthBrokerError: brokerHoist.FakeBrokerError,
  withAuthBrokerClient: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    if (!brokerHoist.impl.run) {
      throw new brokerHoist.FakeUnreachable("broker down");
    }
    return brokerHoist.impl.run(fn);
  }),
}));

// Hindsight container probes.
vi.mock("../src/setup/hindsight.js", () => ({
  getHindsightStatus: vi.fn(() => null),
  isHindsightRunning: vi.fn(() => false),
}));

// `running` now comes from an HTTP probe (probeHindsight), not docker.
// Mock it; keep getCollectionForAgent real.
vi.mock("../src/memory/hindsight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/memory/hindsight.js")>();
  return { ...actual, probeHindsight: vi.fn(async () => ({ ok: false, reason: "test-default" })) };
});

import {
  handleGetAgents,
  handleStartAgent,
  handleStopAgent,
  handleRestartAgent,
  START_NEEDS_OPERATOR_MESSAGE,
  STOP_NEEDS_OPERATOR_MESSAGE,
  handleGetLogs,
  handleGetSystemHealth,
  handleGetGoogleAccounts,
  handleGetMicrosoftAccounts,
  handleGetNotionWorkspace,
  handleGetSchedule,
  handleGetAccounts,
  handleUseAccount,
  handleSetConnectionAccess,
  handleGetConnectionAccessStatus,
  __resetConnectionAccessStatuses,
  handleStartMicrosoftConnect,
  handleGetMicrosoftConnectStatus,
  __resetMicrosoftConnectStatuses,
  handleGetApprovals,
  handleGetGrants,
  handleRefreshAccountsQuota,
  __resetQuotaCacheForTests,
  __resetAgentStatusCacheForTests,
  handleGetSummary,
  deriveAttention,
  ATTENTION_MAX_ITEMS,
  handleMemoryReprocess,
  handleMemoryRefreshModel,
  handleMemoryBuildProfile,
  handleGetMentalModel,
  __resetDashboardCacheForTests,
  type AgentInfo,
  type SystemHealth,
  type ScheduleDashboard,
  type ApprovalsDashboard,
  type AccountDashboardInfo,
  type MemoryHealth,
  type AttentionItem,
  type SummaryPart,
} from "../src/web/api.js";
import { resolveAgentsDir } from "../src/config/loader.js";
import { getAccountInfos } from "../src/auth/account-store.js";
import {
  resolveKernelOperatorSocket,
  approvalList,
} from "../src/vault/approvals/client.js";
import {
  isOriginAllowed,
  isTailscaleIdentified,
  resolveDashboardFilePath,
  dashboardCacheControl,
} from "../src/web/server.js";
import { getAllAgentStatuses, startAgent, stopAgent, restartAgent } from "../src/agents/lifecycle.js";
import { getAllAuthStatuses } from "../src/auth/manager.js";
import { getHindsightStatus } from "../src/setup/hindsight.js";
import { probeHindsight } from "../src/memory/hindsight.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitchroomConfig } from "../src/config/schema.js";

// Bun's vitest compat layer doesn't implement vi.mocked(). Use a
// cast helper so we can call .mockReturnValue() etc on the mock-wrapped
// imports without TypeScript complaining.
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const mockConfig: SwitchroomConfig = {
  switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
  telegram: { bot_token: "test-token", forum_chat_id: "-1001234" },
  agents: {
    coach: {
      extends: "health-coach",
      topic_name: "Fitness Coach",
      topic_emoji: "\u{1F3CB}\u{FE0F}",
      schedule: [],
      tools: undefined,
      soul: undefined,
      memory: { collection: "coach-mem", auto_recall: true, isolation: "default" },
    },
    sage: {
      extends: "default",
      topic_name: "Wisdom",
      topic_emoji: "\u{1F9D9}",
      schedule: [],
      tools: undefined,
      soul: undefined,
      memory: undefined,
    },
  },
};

describe("handleGetAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The hostd backfill is TTL-cached at module scope; isolate cases.
    __resetAgentStatusCacheForTests();
  });

  it("returns combined status and auth info for each agent", async () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: "2025-01-01T00:00:00Z", memory: "128MB", pid: 1234 },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });

    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: true, subscriptionType: "max", timeUntilExpiry: "7h 30m", expiresAt: Date.now() + 27000000 },
      sage: { authenticated: false },
    });

    const result = await handleGetAgents(mockConfig, {
      fetchFleetStatus: async () => null,
    });

    expect(result).toHaveLength(2);

    const coach = result.find((a) => a.name === "coach")!;
    expect(coach).toBeDefined();
    expect(coach.active).toBe("active");
    expect(coach.uptime).toBe("2025-01-01T00:00:00Z");
    expect(coach.memory).toBe("128MB");
    expect(coach.extends).toBe("health-coach");
    expect(coach.topic_name).toBe("Fitness Coach");
    expect(coach.topic_emoji).toBe("\u{1F3CB}\u{FE0F}");
    expect(coach.auth.authenticated).toBe(true);
    expect(coach.auth.subscriptionType).toBe("max");
    expect(coach.memoryCollection).toBe("coach-mem");

    const sage = result.find((a) => a.name === "sage")!;
    expect(sage).toBeDefined();
    expect(sage.active).toBe("inactive");
    expect(sage.auth.authenticated).toBe(false);
    expect(sage.memoryCollection).toBe("sage"); // Falls back to agent name
  });

  it("returns correct shape with all fields", async () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: null, memory: null, pid: null },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: false },
      sage: { authenticated: false },
    });

    const result = await handleGetAgents(mockConfig, {
      fetchFleetStatus: async () => null,
    });
    const expectedKeys: (keyof AgentInfo)[] = [
      "name", "active", "uptime", "memory", "extends",
      "topic_name", "topic_emoji", "auth", "primaryAccount", "memoryCollection",
      "lastTurnAt",
    ];

    for (const agent of result) {
      for (const key of expectedKeys) {
        expect(agent).toHaveProperty(key);
      }
      expect(agent.auth).toHaveProperty("authenticated");
    }
  });

  it("backfills null uptime/memory from hostd (dockerless web)", async () => {
    // Dockerless: getAllAgentStatuses returns null uptime/memory.
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "inactive", uptime: null, memory: null, pid: null },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: false },
      sage: { authenticated: false },
    });

    const result = await handleGetAgents(mockConfig, {
      // hostd (root, docker socket) supplies what the web can't read.
      fetchFleetStatus: async () => ({
        coach: { active: "active", uptime: "2026-06-15T00:00:00Z", memory: "256MB", pid: 99 },
      }),
    });

    const coach = result.find((a) => a.name === "coach")!;
    expect(coach.uptime).toBe("2026-06-15T00:00:00Z");
    expect(coach.memory).toBe("256MB");
    // No hostd row for sage → stays null (graceful).
    const sage = result.find((a) => a.name === "sage")!;
    expect(sage.uptime).toBeNull();
    expect(sage.memory).toBeNull();
  });

  it("keeps null uptime/memory when hostd is unreachable", async () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    asMock(getAllAuthStatuses).mockReturnValue({ coach: { authenticated: false } });

    const result = await handleGetAgents(mockConfig, {
      fetchFleetStatus: async () => null, // hostd down
    });
    const coach = result.find((a) => a.name === "coach")!;
    expect(coach.uptime).toBeNull();
    expect(coach.memory).toBeNull();
  });

  it("includes lastTurnAt from the injected turns reader", async () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: null, memory: null, pid: null },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: false },
      sage: { authenticated: false },
    });

    const result = await handleGetAgents(mockConfig, {
      fetchFleetStatus: async () => null,
      // Inject so the test never touches the real per-agent turns DB
      // (which needs `bun:sqlite`, unavailable under vitest).
      readLastTurn: (_dir, name) => (name === "coach" ? 1_700_000_000_000 : null),
    });

    const coach = result.find((a) => a.name === "coach")!;
    const sage = result.find((a) => a.name === "sage")!;
    expect(coach).toHaveProperty("lastTurnAt", 1_700_000_000_000);
    // null-safe: an agent with no turns DB / no turns reads null, not a throw.
    expect(sage).toHaveProperty("lastTurnAt", null);
  });

  it("is null-safe for lastTurnAt when the default reader hits a missing DB", async () => {
    // The default readLastTurnAt opens the real turns DB at the mocked
    // agentsDir (which doesn't exist) and must degrade to null, never throw.
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    asMock(getAllAuthStatuses).mockReturnValue({ coach: { authenticated: false } });

    const result = await handleGetAgents(mockConfig, {
      fetchFleetStatus: async () => null,
      // No readLastTurn injected → exercises the real readLastTurnAt path.
    });
    const coach = result.find((a) => a.name === "coach")!;
    expect(coach.lastTurnAt).toBeNull();
  });
});

describe("handleStartAgent (deferred to approval PR — never shells docker)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the actionable host-CLI message and does NOT call startAgent", async () => {
    const result = await handleStartAgent("coach");
    expect(result.ok).toBe(false);
    expect(result.error).toBe(START_NEEDS_OPERATOR_MESSAGE);
    expect(result.error).toContain("switchroom agent start");
    // The dockerless web must never shell the lifecycle start (→ docker).
    expect(startAgent).not.toHaveBeenCalled();
  });
});

describe("handleStopAgent (deferred to approval PR — never shells docker)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the actionable host-CLI message and does NOT call stopAgent", async () => {
    const result = await handleStopAgent("coach");
    expect(result.ok).toBe(false);
    expect(result.error).toBe(STOP_NEEDS_OPERATOR_MESSAGE);
    expect(result.error).toContain("switchroom agent stop");
    expect(stopAgent).not.toHaveBeenCalled();
  });
});

describe("handleRestartAgent (hostd-routed, ungated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes through the injected hostd restart and returns ok on success", async () => {
    let calledWith: string | undefined;
    const result = await handleRestartAgent("sage", {
      restart: async (name) => {
        calledWith = name;
        return { ok: true };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calledWith).toBe("sage");
    // Never shells the dockerful lifecycle restart from the web container.
    expect(restartAgent).not.toHaveBeenCalled();
  });

  it("surfaces the actionable error when hostd is unreachable", async () => {
    const result = await handleRestartAgent("sage", {
      restart: async () => ({
        ok: false,
        error: "Agent control needs hostd (the dashboard container has no docker access by design).",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("needs hostd");
    expect(restartAgent).not.toHaveBeenCalled();
  });

  it("degrades gracefully if the restart helper itself throws", async () => {
    const result = await handleRestartAgent("sage", {
      restart: async () => {
        throw new Error("unexpected");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unexpected");
  });
});

describe("handleGetLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns logs from the hostd agent_logs verb", async () => {
    const result = await handleGetLogs("coach", 50, {
      fetchLogs: async (name, lines) => {
        expect(name).toBe("coach");
        expect(lines).toBe(50);
        return { ok: true, logs: "line 1\nline 2\nboot warn\n" };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("line 1");
    expect(result.logs).toContain("boot warn");
  });

  it("uses default of 50 lines", async () => {
    let observed = -1;
    await handleGetLogs("sage", undefined, {
      fetchLogs: async (_name, lines) => {
        observed = lines;
        return { ok: true, logs: "output" };
      },
    });
    expect(observed).toBe(50);
  });

  it("surfaces an actionable error when hostd is unreachable", async () => {
    const result = await handleGetLogs("coach", 10, {
      fetchLogs: async () => ({
        ok: false,
        error:
          "Logs need hostd (the dashboard container has no docker access by design). " +
          "Ensure host_control is enabled, or run `switchroom agent logs <name>` on the host.",
      }),
    });
    expect(result.ok).toBe(false);
    // No raw `spawn docker ENOENT` — points the operator at the real lever.
    expect(result.error).toContain("need hostd");
    expect(result.error).not.toContain("ENOENT");
  });
});

// Helper to build a minimal Request with an optional Origin header.
function makeRequest(origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers["Origin"] = origin;
  return new Request("http://127.0.0.1:8080/api/agents", { headers });
}

describe("isOriginAllowed — localhost-only bind (default)", () => {
  const port = 8080;
  const localhostOnly = true;

  it("allows requests with no Origin header (CLI / curl)", () => {
    expect(isOriginAllowed(makeRequest(), port, localhostOnly)).toBe(true);
  });

  it("allows same-origin requests from localhost", () => {
    expect(isOriginAllowed(makeRequest(`http://localhost:${port}`), port, localhostOnly)).toBe(true);
  });

  it("allows same-origin requests from 127.0.0.1", () => {
    expect(isOriginAllowed(makeRequest(`http://127.0.0.1:${port}`), port, localhostOnly)).toBe(true);
  });

  it("rejects a cross-origin request from a remote host", () => {
    expect(isOriginAllowed(makeRequest("http://evil.example.com"), port, localhostOnly)).toBe(false);
  });

  it("rejects a cross-origin request from a LAN IP", () => {
    expect(isOriginAllowed(makeRequest("http://192.168.1.100:8080"), port, localhostOnly)).toBe(false);
  });

  it("rejects when port in Origin doesn't match server port", () => {
    expect(isOriginAllowed(makeRequest("http://localhost:9999"), port, localhostOnly)).toBe(false);
  });

  // Behind `tailscale serve`: loopback request carrying Tailscale-User-Login
  // (only the tailscale daemon can inject it). The tailnet-host Origin must
  // be allowed — this is the path the dashboard's own printed instructions
  // tell users to use, and it previously 403'd here.
  it("allows the tailnet Origin when the request is Tailscale-identified", () => {
    expect(
      isOriginAllowed(
        makeRequest("https://example-host.tailnet.ts.net:8081"),
        port,
        localhostOnly,
        /* tailscaleIdentified */ true,
      ),
    ).toBe(true);
  });

  it("STILL rejects a hostile cross-origin page that is NOT Tailscale-identified", () => {
    // A malicious web page cannot set Tailscale-User-Login, so
    // isTailscaleIdentified is false for it → origin allowlist still
    // applies. CSRF protection for the original threat is unchanged.
    expect(
      isOriginAllowed(makeRequest("http://evil.example.com"), port, localhostOnly, false),
    ).toBe(false);
  });
});

describe("isOriginAllowed — network bind (--bind 0.0.0.0 or Tailscale IP)", () => {
  const port = 8080;
  const localhostOnly = false;

  it("allows requests with no Origin header", () => {
    expect(isOriginAllowed(makeRequest(), port, localhostOnly)).toBe(true);
  });

  it("allows a request from a LAN origin with a valid token (origin check skipped)", () => {
    // When bound to 0.0.0.0 / non-loopback, the origin check is bypassed.
    // The bearer token is the sole auth boundary — tested by checkAuth in the server.
    expect(isOriginAllowed(makeRequest("http://192.168.1.100:8080"), port, localhostOnly)).toBe(true);
  });

  it("allows a request from a Tailscale origin (origin check skipped)", () => {
    expect(isOriginAllowed(makeRequest("http://100.64.0.1:8080"), port, localhostOnly)).toBe(true);
  });

  it("allows even a remote-looking origin (token is the boundary)", () => {
    expect(isOriginAllowed(makeRequest("http://remote.example.com"), port, localhostOnly)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isTailscaleIdentified — Tailscale identity header auth
// ---------------------------------------------------------------------------

/**
 * Build a minimal Request with optional Tailscale identity headers.
 * makeServerStub returns a minimal server stub that reports the given source IP.
 */
function makeTsRequest(login?: string, extraHeaders?: Record<string, string>): Request {
  const headers: Record<string, string> = {};
  if (login !== undefined) headers["Tailscale-User-Login"] = login;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Request("http://127.0.0.1:8080/api/agents", { headers });
}

function makeServerStub(address: string | null): { requestIP(req: Request): { address: string } | null } {
  return {
    requestIP(_req: Request) {
      return address !== null ? { address } : null;
    },
  };
}

describe("isTailscaleIdentified", () => {
  it("returns true when Tailscale-User-Login is present and source IP is 127.0.0.1", () => {
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub("127.0.0.1");
    expect(isTailscaleIdentified(req, server)).toBe(true);
  });

  it("returns true when Tailscale-User-Login is present and source IP is ::1 (IPv6 loopback)", () => {
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub("::1");
    expect(isTailscaleIdentified(req, server)).toBe(true);
  });

  it("returns false when Tailscale-User-Login is present but source IP is non-loopback", () => {
    // Simulates a request from a remote IP with a spoofed identity header.
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub("100.64.0.5");
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when Tailscale-User-Login is absent even from loopback", () => {
    const req = makeTsRequest();
    const server = makeServerStub("127.0.0.1");
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when Tailscale-User-Login is empty string", () => {
    const req = makeTsRequest("");
    const server = makeServerStub("127.0.0.1");
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when server.requestIP returns null (no source IP info)", () => {
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub(null);
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when no header and no source IP (both conditions fail)", () => {
    const req = makeTsRequest();
    const server = makeServerStub(null);
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });
});

describe("handleGetSystemHealth", () => {
  let home: string;

  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
    asMock(getHindsightStatus).mockReturnValue(null);
    asMock(probeHindsight).mockResolvedValue({ ok: false, reason: "test-default" });
    // Default: docker inspect unavailable (no docker) → inspectEnv yields nulls.
    // clearAllMocks() resets call history but NOT return values, so reset here.
    asMock(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "no docker" } as never);
    home = mkdtempSync(join(tmpdir(), "syshealth-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reports broker reachable with fleet snapshot", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listState: async () => ({
          active: "ken@example.com",
          fallback_order: [],
          accounts: [{ label: "a" }, { label: "b" }],
          agents: [{ name: "x" }],
          consumers: [{ name: "hindsight" }],
        }),
      });

    const h = await handleGetSystemHealth(undefined, home);
    expect(h.broker.reachable).toBe(true);
    expect(h.broker.active).toBe("ken@example.com");
    expect(h.broker.accounts).toBe(2);
    expect(h.broker.agents).toBe(1);
    expect(h.broker.consumers).toBe(1);
  });

  it("reports broker unreachable without throwing", async () => {
    brokerImpl.run = null; // withAuthBrokerClient throws FakeUnreachable
    const h = await handleGetSystemHealth(undefined, home);
    expect(h.broker.reachable).toBe(false);
    expect(h.broker.error).toContain("broker down");
  });

  it("formats an AuthBrokerError as `code: message` (reachable but protocol error)", async () => {
    brokerImpl.run = async () => {
      throw new brokerHoist.FakeBrokerError("EPROTO", "bad frame");
    };
    const h = await handleGetSystemHealth(undefined, home);
    expect(h.broker.reachable).toBe(false);
    expect(h.broker.error).toBe("EPROTO: bad frame");
  });

  it("reports hindsight running from the HTTP probe + env from docker inspect when available", async () => {
    asMock(probeHindsight).mockResolvedValue({ ok: true, serverName: "hindsight", serverVersion: "1.0" });
    asMock(getHindsightStatus).mockReturnValue("Up 3 hours");
    asMock(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        "PATH=/usr/bin",
        "HINDSIGHT_API_LLM_MODEL=claude-sonnet-4-6",
        "HINDSIGHT_API_LLM_PROVIDER=claude-code",
        "HINDSIGHT_API_MCP_STATELESS=true",
      ]),
      stderr: "",
    } as never);

    const h = await handleGetSystemHealth(undefined, home);
    expect(h.hindsight.running).toBe(true); // from the HTTP probe, not docker
    expect(h.hindsight.containerStatus).toBe("Up 3 hours");
    expect(h.hindsight.model).toBe("claude-sonnet-4-6");
    expect(h.hindsight.provider).toBe("claude-code");
    expect(h.hindsight.mcpStateless).toBe(true);
  });

  it("reports hindsight NOT running when the probe fails (e.g. dockerless web, hindsight unreachable)", async () => {
    asMock(probeHindsight).mockResolvedValue({ ok: false, reason: "Unreachable" });
    asMock(getHindsightStatus).mockReturnValue(null);
    const h = await handleGetSystemHealth(undefined, home);
    // running is false because the probe failed — NOT because docker said so.
    expect(h.hindsight.running).toBe(false);
    expect(h.hindsight.model).toBeNull();
    expect(h.hindsight.mcpStateless).toBeNull();
  });

  it("falls back to the configured provider when docker inspect is unavailable but the probe succeeds", async () => {
    asMock(probeHindsight).mockResolvedValue({ ok: true, serverName: "h", serverVersion: "1" });
    asMock(getHindsightStatus).mockReturnValue(null);
    asMock(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "no docker" } as never);
    const cfg = { memory: { config: { url: "http://127.0.0.1:18888/mcp/", provider: "claude-code" } } } as never;
    const h = await handleGetSystemHealth(cfg, home);
    expect(h.hindsight.running).toBe(true);
    expect(h.hindsight.provider).toBe("claude-code"); // from config, not docker
  });

  it("parses the hostd audit log when present (newest entries, capped)", async () => {
    mkdirSync(join(home, ".switchroom"), { recursive: true });
    const line = (op: string, code: number) =>
      JSON.stringify({
        ts: "2026-05-16T10:00:00.000Z",
        op,
        caller: { kind: "agent", name: "carrie" },
        request_id: "r",
        result: code === 0 ? "ok" : "error",
        exit_code: code,
        duration_ms: 12,
      });
    writeFileSync(
      join(home, ".switchroom", "host-control-audit.log"),
      [line("restart", 0), line("update-apply", 1)].join("\n") + "\n",
    );

    const h = await handleGetSystemHealth(undefined, home);
    expect(h.hostd.auditLogPresent).toBe(true);
    expect(h.hostd.recent).toHaveLength(2);
    expect(h.hostd.recent.map((e) => e.op)).toEqual([
      "restart",
      "update-apply",
    ]);
  });

  it("reports hostd audit absent on a fresh install (no crash)", async () => {
    const h = await handleGetSystemHealth(undefined, home);
    expect(h.hostd.auditLogPresent).toBe(false);
    expect(h.hostd.recent).toEqual([]);
  });
});

describe("handleGetGoogleAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
  });

  const cfgWith = (ga: Record<string, { enabled_for: string[] }>) =>
    ({ ...mockConfig, google_accounts: ga }) as unknown as SwitchroomConfig;

  it("merges broker live data with the config ACL", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listGoogleAccounts: async () => ({
          accounts: [
            { account: "alice@example.com", expiresAt: 123, scope: "drive gmail", clientId: "cid-abc" },
          ],
        }),
      });
    const out = await handleGetGoogleAccounts(
      cfgWith({ "alice@example.com": { enabled_for: ["coach", "sage"] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      account: "alice@example.com",
      expiresAt: 123,
      scope: "drive gmail",
      clientId: "cid-abc",
      enabledFor: ["coach", "sage"],
      brokerKnown: true,
    });
  });

  it("degrades to config-only when the broker is unreachable", async () => {
    brokerImpl.run = null; // throws FakeUnreachable
    const out = await handleGetGoogleAccounts(
      cfgWith({ "bob@example.com": { enabled_for: ["coach"] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      account: "bob@example.com",
      expiresAt: null,
      scope: null,
      clientId: null,
      enabledFor: ["coach"],
      brokerKnown: false,
    });
  });

  it("unions config-declared and broker-only accounts", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listGoogleAccounts: async () => ({
          accounts: [
            { account: "ghost@example.com", expiresAt: 9, scope: "s", clientId: "c" },
          ],
        }),
      });
    const out = await handleGetGoogleAccounts(
      cfgWith({ "declared@example.com": { enabled_for: [] } }),
    );
    expect(out.map((a) => a.account).sort()).toEqual([
      "declared@example.com",
      "ghost@example.com",
    ]);
    expect(out.find((a) => a.account === "ghost@example.com")!.brokerKnown).toBe(true);
    expect(out.find((a) => a.account === "declared@example.com")!.brokerKnown).toBe(false);
  });
});

describe("handleGetMicrosoftAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
  });

  const cfgWith = (ma: Record<string, { enabled_for: string[] }>) =>
    ({ ...mockConfig, microsoft_accounts: ma }) as unknown as SwitchroomConfig;

  it("merges broker live data (incl. accountType) with the config ACL", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listMicrosoftAccounts: async () => ({
          accounts: [
            {
              account: "lisa@outlook.com",
              expiresAt: 456,
              scope: "Mail.ReadWrite Files.ReadWrite.All",
              clientId: "9dff88fa",
              accountType: "personal",
            },
          ],
        }),
      });
    const out = await handleGetMicrosoftAccounts(
      cfgWith({ "lisa@outlook.com": { enabled_for: ["marko"] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      account: "lisa@outlook.com",
      expiresAt: 456,
      accountType: "personal",
      enabledFor: ["marko"],
      brokerKnown: true,
    });
  });

  it("degrades to config-only ACL when the broker is unreachable", async () => {
    brokerImpl.run = null; // throws FakeUnreachable
    const out = await handleGetMicrosoftAccounts(
      cfgWith({ "ken@contoso.com": { enabled_for: ["clerk"] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      account: "ken@contoso.com",
      expiresAt: null,
      accountType: null,
      enabledFor: ["clerk"],
      brokerKnown: false,
    });
  });

  it("unions config-declared and broker-only accounts", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listMicrosoftAccounts: async () => ({
          accounts: [
            { account: "ghost@outlook.com", expiresAt: 1, scope: "s", clientId: "c", accountType: "work" },
          ],
        }),
      });
    const out = await handleGetMicrosoftAccounts(
      cfgWith({ "declared@outlook.com": { enabled_for: [] } }),
    );
    expect(out.map((a) => a.account).sort()).toEqual([
      "declared@outlook.com",
      "ghost@outlook.com",
    ]);
  });
});

describe("handleGetNotionWorkspace", () => {
  it("reports not-configured when no notion_workspace block", () => {
    const out = handleGetNotionWorkspace(mockConfig as unknown as SwitchroomConfig);
    expect(out.configured).toBe(false);
    expect(out.databases).toEqual([]);
  });

  it("lists declared databases with per-agent grants (which agents can reach which DB)", () => {
    const cfg = {
      ...mockConfig,
      notion_workspace: {
        vault_key: "notion/integration-token",
        databases: { crm: "11111111-1111-1111-1111-111111111111", hr: "22222222-2222-2222-2222-222222222222" },
      },
      agents: {
        marko: { notion_workspace: { databases: ["crm"] } },
        clerk: { notion_workspace: { databases: ["crm", "hr"] } },
        ziggy: {}, // no notion_workspace block → no access at all
      },
    } as unknown as SwitchroomConfig;
    const out = handleGetNotionWorkspace(cfg);
    expect(out.configured).toBe(true);
    expect(out.vaultKey).toBe("notion/integration-token");
    const byName = Object.fromEntries(out.databases.map((d) => [d.name, d]));
    expect(byName.crm.enabledFor).toEqual(["clerk", "marko"]);
    expect(byName.hr.enabledFor).toEqual(["clerk"]);
    // ziggy (no notion_workspace block) reaches nothing.
    expect(out.fullAccessAgents).toEqual([]);
  });

  it("credits a no-filter agent (notion_workspace:{}) as full-access on EVERY database", () => {
    // The bug the reviewer caught: an admin/orchestrator agent with an
    // empty notion_workspace block has full access per the runtime ACL,
    // but the naive enabledFor scan missed it.
    const cfg = {
      ...mockConfig,
      notion_workspace: {
        vault_key: "notion/integration-token",
        databases: { crm: "11111111-1111-1111-1111-111111111111", hr: "22222222-2222-2222-2222-222222222222" },
      },
      agents: {
        orchestrator: { notion_workspace: {} }, // no databases filter → ALL
        scoped: { notion_workspace: { databases: ["crm"] } },
      },
    } as unknown as SwitchroomConfig;
    const out = handleGetNotionWorkspace(cfg);
    const byName = Object.fromEntries(out.databases.map((d) => [d.name, d]));
    // orchestrator appears on BOTH databases; scoped only on crm.
    expect(byName.crm.enabledFor).toEqual(["orchestrator", "scoped"]);
    expect(byName.hr.enabledFor).toEqual(["orchestrator"]);
    // ...and is surfaced as a full-access agent for the UI.
    expect(out.fullAccessAgents).toEqual(["orchestrator"]);
  });

  it("never returns the Notion token, only its vault key reference", () => {
    const cfg = {
      ...mockConfig,
      notion_workspace: {
        vault_key: "notion/integration-token",
        databases: { crm: "11111111-1111-1111-1111-111111111111" },
      },
      agents: { marko: { notion_workspace: { databases: ["crm"] } } },
    } as unknown as SwitchroomConfig;
    const out = handleGetNotionWorkspace(cfg);
    // The shape exposes vault_key (a reference) but no token field at all.
    expect(out.vaultKey).toBe("notion/integration-token");
    const serialized = JSON.stringify(out);
    expect(serialized).not.toMatch(/secret|token["']?\s*:/i);
    // Only the declared keys exist — no token-bearing field leaked in.
    expect(Object.keys(out).sort()).toEqual([
      "configured",
      "databases",
      "fullAccessAgents",
      "vaultKey",
    ]);
  });
});

describe("handleSetConnectionAccess (hostd-routed, approval-gated)", () => {
  const VALID_YAML = `switchroom:
  version: 1
  agents_dir: ~/.switchroom/agents
telegram:
  bot_token: x
  forum_chat_id: "-1001234"
agents:
  marko:
    extends: default
    topic_name: Marko
microsoft_accounts: {}
`;
  const cfg = {
    ...mockConfig,
    agents: { marko: { extends: "default" } },
  } as unknown as SwitchroomConfig;

  let tmp: string;
  let cfgPath: string;
  beforeEach(() => {
    __resetConnectionAccessStatuses();
    tmp = mkdtempSync(join(tmpdir(), "conn-access-"));
    cfgPath = join(tmp, "switchroom.yaml");
    writeFileSync(cfgPath, VALID_YAML);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("rejects bad provider / unknown agent / invalid email without proposing", () => {
    expect(handleSetConnectionAccess(cfgPath, cfg, { provider: "slack", account: "a@b.com", agent: "marko", action: "enable" }).ok).toBe(false);
    expect(handleSetConnectionAccess(cfgPath, cfg, { provider: "microsoft", account: "a@b.com", agent: "ghost", action: "enable" }).ok).toBe(false);
    expect(handleSetConnectionAccess(cfgPath, cfg, { provider: "microsoft", account: "not-an-email", agent: "marko", action: "enable" }).ok).toBe(false);
  });

  it("returns changed:false (no card) when disabling an already-absent grant", () => {
    const res = handleSetConnectionAccess(
      cfgPath,
      cfg,
      { provider: "microsoft", account: "lisa@outlook.com", agent: "marko", action: "disable" },
      { socketPath: "/fake/sock", propose: async () => ({ state: "applied" }) },
    );
    expect(res).toMatchObject({ ok: true, changed: false });
    expect(res.requestId).toBeUndefined();
  });

  it("does NOT write the config — it proposes via hostd and polls to applied", async () => {
    const calls: Array<{ reqId: string; diff: string; reason: string }> = [];
    const res = handleSetConnectionAccess(
      cfgPath,
      cfg,
      { provider: "microsoft", account: "lisa@outlook.com", agent: "marko", action: "enable" },
      {
        socketPath: "/fake/operator/sock",
        // node:child_process is globally mocked in this suite, so inject a
        // diff stub instead of the real git generator (covered separately
        // in config-diff.test.ts). The stub sees the computed before/after.
        generateDiff: (before, after) =>
          `--- a/switchroom.yaml\n+++ b/switchroom.yaml\n@@ @@\nDIFF(${after.includes("lisa@outlook.com") ? "has-account" : "no-account"})`,
        propose: async (reqId, diff, reason) => {
          calls.push({ reqId, diff, reason });
          return { state: "applied" };
        },
      },
    );
    expect(res).toMatchObject({ ok: true, changed: true, pendingApproval: true });
    expect(res.requestId).toBeTruthy();
    // The config file on disk is UNCHANGED (hostd would write it; here propose is faked).
    expect(readFileSync(cfgPath, "utf-8")).toBe(VALID_YAML);
    // The proposal carries the computed diff + a descriptive reason.
    expect(calls).toHaveLength(1);
    expect(calls[0].diff).toContain("has-account");
    expect(calls[0].reason).toContain("enable marko");

    // Initially pending; after the background propose resolves → applied.
    expect(handleGetConnectionAccessStatus(res.requestId!).state).toMatch(/pending|applied/);
    await flush();
    const st = handleGetConnectionAccessStatus(res.requestId!);
    expect(st.state).toBe("applied");
    if (st.state === "applied") expect(st.restartAgent).toBe("marko");
  });

  it("surfaces an operator denial via the status poll", async () => {
    const res = handleSetConnectionAccess(
      cfgPath,
      cfg,
      { provider: "microsoft", account: "lisa@outlook.com", agent: "marko", action: "enable" },
      {
        socketPath: "/fake/sock",
        generateDiff: () => "--- a/x\n+++ b/x\n@@ @@\n+y",
        propose: async () => ({ state: "denied", reason: "operator denied" }),
      },
    );
    await flush();
    const st = handleGetConnectionAccessStatus(res.requestId!);
    expect(st.state).toBe("denied");
    if (st.state === "denied") expect(st.reason).toContain("denied");
  });

  it("fails clearly when hostd is unreachable (no socket)", () => {
    const res = handleSetConnectionAccess(
      cfgPath,
      cfg,
      { provider: "microsoft", account: "lisa@outlook.com", agent: "marko", action: "enable" },
      { socketPath: null },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain("hostd");
  });

  it("returns 'unknown' for an unrecognized requestId", () => {
    expect(handleGetConnectionAccessStatus("nope").state).toBe("unknown");
  });

  it("disabling from account A does NOT clear a pin that points at account B", () => {
    // marko is pinned to B AND (inconsistently) listed in A's ACL.
    // Disabling marko from A must remove it from A's enabled_for but
    // leave the B pin intact — never revoke unrelated access.
    const yaml = `switchroom:
  version: 1
  agents_dir: ~/.switchroom/agents
telegram:
  bot_token: x
  forum_chat_id: "-1001234"
agents:
  marko:
    extends: default
    topic_name: Marko
    microsoft_workspace:
      account: b@outlook.com
microsoft_accounts:
  a@outlook.com:
    enabled_for:
      - marko
  b@outlook.com:
    enabled_for:
      - marko
`;
    writeFileSync(cfgPath, yaml);
    let capturedAfter = "";
    const res = handleSetConnectionAccess(
      cfgPath,
      cfg,
      { provider: "microsoft", account: "a@outlook.com", agent: "marko", action: "disable" },
      {
        socketPath: "/fake/sock",
        generateDiff: (_before, after) => { capturedAfter = after; return "@@ d @@"; },
        propose: async () => ({ state: "applied" }),
      },
    );
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    // The pin to B survives; only A's ACL entry is dropped.
    expect(capturedAfter).toContain("account: b@outlook.com");
    const aBlock = capturedAfter.slice(capturedAfter.indexOf("a@outlook.com"));
    expect(aBlock.slice(0, aBlock.indexOf("b@outlook.com"))).not.toContain("- marko");
  });
});

describe("handleStartMicrosoftConnect (in-browser device-code)", () => {
  const PERSONAL_MSA_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
  const DEVICE = {
    device_code: "dc",
    user_code: "WXYZ-1234",
    verification_uri: "https://microsoft.com/devicelogin",
    expires_in: 900,
    interval: 5,
  };
  const fakeIdToken = (p: Record<string, unknown>) => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "none" })}.${b64(p)}.sig`;
  };
  const okTokens = {
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "Mail.ReadWrite",
    id_token: fakeIdToken({ tid: PERSONAL_MSA_TID, oid: "o1", preferred_username: "lisa@outlook.com" }),
  };
  const cfg = mockConfig as unknown as SwitchroomConfig;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => __resetMicrosoftConnectStatuses());

  it("returns the device code + URL immediately and registers on consent", async () => {
    const added: string[] = [];
    const res = await handleStartMicrosoftConnect(cfg, {
      requestDeviceCode: async () => DEVICE,
      pollDeviceToken: async () => okTokens as never,
      addAccount: async (label) => { added.push(label); return {}; },
    });
    expect(res.ok).toBe(true);
    expect(res.userCode).toBe("WXYZ-1234");
    expect(res.verificationUri).toContain("devicelogin");
    expect(res.requestId).toBeTruthy();
    // Pending until the background poll resolves.
    const before = handleGetMicrosoftConnectStatus(res.requestId!);
    expect(before.state).toMatch(/pending|connected/);
    await flush();
    const after = handleGetMicrosoftConnectStatus(res.requestId!);
    expect(after.state).toBe("connected");
    if (after.state === "connected") expect(after.account).toBe("lisa@outlook.com");
    expect(added).toEqual(["lisa@outlook.com"]);
  });

  it("surfaces a poll failure via the status endpoint (account NOT registered)", async () => {
    let added = false;
    const res = await handleStartMicrosoftConnect(cfg, {
      requestDeviceCode: async () => DEVICE,
      pollDeviceToken: async () => { throw new Error("expired_token"); },
      addAccount: async () => { added = true; return {}; },
    });
    expect(res.ok).toBe(true);
    await flush();
    const st = handleGetMicrosoftConnectStatus(res.requestId!);
    expect(st.state).toBe("failed");
    if (st.state === "failed") expect(st.reason).toContain("expired_token");
    expect(added).toBe(false);
  });

  it("refuses a vaulted BYO Microsoft client (points at the host CLI)", async () => {
    const byoCfg = {
      ...mockConfig,
      microsoft_workspace: { microsoft_client_id: "vault:ms-id" },
    } as unknown as SwitchroomConfig;
    const res = await handleStartMicrosoftConnect(byoCfg, {
      requestDeviceCode: async () => DEVICE,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("host");
  });

  it("returns 'unknown' for an unrecognized connect requestId", () => {
    expect(handleGetMicrosoftConnectStatus("nope").state).toBe("unknown");
  });
});

describe("handleGetSchedule", () => {
  let tmp: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "sched-"));
    asMock(resolveAgentsDir).mockReturnValue(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const cfgWithSchedule = () =>
    ({
      ...mockConfig,
      agents: {
        ...mockConfig.agents,
        coach: {
          ...mockConfig.agents.coach,
          schedule: [
            { cron: "0 9 * * *", prompt: "morning standup" },
            { cron: "0 17 * * *", prompt: "evening recap" },
          ],
        },
      },
    }) as unknown as SwitchroomConfig;

  // hostd-down ⇒ degraded base-config-only fallback path. Inject a null
  // hostd fetch so these exercise the local collectScheduleEntries +
  // readRecentFires path deterministically (no real UDS).
  const hostdDown = { fetchSchedule: async () => null };

  it("returns cascade-resolved entries with recent fires from scheduler.jsonl", async () => {
    mkdirSync(join(tmp, "coach"), { recursive: true });
    const row = (idx: number, code: number) =>
      JSON.stringify({
        agent: "coach",
        scheduleIndex: idx,
        promptKey: "k",
        exitCode: code,
        outputSummary: code === 0 ? "delivered to bridge via gateway" : "no agent client connected",
        startedAt: 1747300000000 + idx,
        finishedAt: 1747300000500 + idx,
      });
    writeFileSync(
      join(tmp, "coach", "scheduler.jsonl"),
      [row(0, 0), row(1, -1)].join("\n") + "\n",
    );

    const d = await handleGetSchedule(cfgWithSchedule(), hostdDown);
    expect(d.entries.filter((e) => e.agent === "coach")).toHaveLength(2);
    expect(d.entries[0].cron).toBe("0 9 * * *");
    expect(d.recentByAgent.coach).toHaveLength(2);
    expect(d.recentByAgent.coach[1].exitCode).toBe(-1);
    // Degraded because hostd was down — UI must warn overlays are missing.
    expect(d.degraded).toBe(true);
    expect(d.reason).toContain("hostd");
  });

  it("skips agents with no scheduler.jsonl without failing", async () => {
    const d = await handleGetSchedule(cfgWithSchedule(), hostdDown);
    expect(d.entries.length).toBeGreaterThan(0);
    expect(d.recentByAgent.coach).toBeUndefined();
  });

  it("tolerates a torn JSONL line", async () => {
    mkdirSync(join(tmp, "coach"), { recursive: true });
    writeFileSync(
      join(tmp, "coach", "scheduler.jsonl"),
      '{"agent":"coach","exitCode":0,"outputSummary":"ok","startedAt":1,"finishedAt":2,"scheduleIndex":0,"promptKey":"k"}\n{ broken json\n',
    );
    const d = await handleGetSchedule(cfgWithSchedule(), hostdDown);
    expect(d.recentByAgent.coach).toHaveLength(1);
  });

  it("uses the hostd superset (overlays) and is NOT degraded when hostd is reachable", async () => {
    const d = await handleGetSchedule(cfgWithSchedule(), {
      // hostd sees an agent-authored schedule.d cron the base config lacks.
      fetchSchedule: async () => ({
        entries: [
          { agent: "clerk", scheduleIndex: 0, cron: "*/30 * * * *", promptKey: "x" },
        ],
        recentByAgent: { clerk: [] },
      }),
    });
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0].agent).toBe("clerk");
    expect(d.degraded).toBeUndefined();
  });
});

// Deferred P0-review nit: pin the RFC-H accounts/use wire shapes.
describe("handleGetAccounts / handleUseAccount shape (RFC-H)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
    asMock(getAccountInfos).mockReturnValue([
      { label: "ken@x.com", health: "ok", expiresAt: 111 },
    ] as never);
  });

  // usedBy is derived from the fleet-active binding, so the config
  // must declare auth.active for coach+sage to resolve to this label.
  const cfgActive = () =>
    ({ ...mockConfig, auth: { active: "ken@x.com" } }) as unknown as SwitchroomConfig;

  it("handleGetAccounts attaches broker quota + usedBy to each account", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listState: async () => ({
          active: "ken@x.com",
          fallback_order: [],
          accounts: [
            { label: "ken@x.com", exhausted: false, threshold_violations: 2 },
          ],
          agents: [],
          consumers: [],
        }),
      });
    const out = await handleGetAccounts(cfgActive());
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("ken@x.com");
    expect(out[0].quota).toMatchObject({ exhausted: false, threshold_violations: 2 });
    // coach + sage both bind the fleet-active account (no overrides).
    expect(out[0].usedBy.sort()).toEqual(["coach", "sage"]);
  });

  it("handleGetAccounts degrades quota to null when broker unreachable", async () => {
    brokerImpl.run = null;
    const out = await handleGetAccounts(cfgActive());
    expect(out[0].quota).toBeNull();
    expect(out[0].usedBy.sort()).toEqual(["coach", "sage"]);
  });

  it("handleUseAccount returns {ok, active, fanned} on success", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        setActive: async (label: string) => ({
          active: label,
          fanned: ["coach", "sage"],
        }),
      });
    const r = await handleUseAccount("ken@x.com");
    expect(r).toEqual({ ok: true, active: "ken@x.com", fanned: ["coach", "sage"] });
  });

  it("handleUseAccount maps broker-unreachable to a clean error", async () => {
    brokerImpl.run = null;
    const r = await handleUseAccount("ken@x.com");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("broker down");
  });
});

describe("handleGetApprovals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports unreachable when the operator socket is absent", async () => {
    asMock(resolveKernelOperatorSocket).mockReturnValue(null);
    const r = await handleGetApprovals();
    expect(r.reachable).toBe(false);
    expect(r.decisions).toEqual([]);
    expect(r.error).toMatch(/operator socket not present/i);
    // Must not even attempt the RPC when there's no socket.
    expect(approvalList).not.toHaveBeenCalled();
  });

  it("reports unreachable when approvalList returns null (kernel down)", async () => {
    asMock(resolveKernelOperatorSocket).mockReturnValue("/run/op/sock");
    asMock(approvalList).mockResolvedValue(null);
    const r = await handleGetApprovals();
    expect(r.reachable).toBe(false);
    expect(r.error).toMatch(/unreachable or returned an error/i);
  });

  it("returns decisions newest-first and pins the socket opt", async () => {
    asMock(resolveKernelOperatorSocket).mockReturnValue("/run/op/sock");
    asMock(approvalList).mockResolvedValue([
      { id: "old", agent_unit: "carrie", scope: "doc:gdrive:write", action: "docs:edit", decision: "allow_ttl", granted_at: 100, granted_by_user_id: 1, ttl_expires_at: null, last_used_at: null, revoked_at: null, revoke_reason: null },
      { id: "new", agent_unit: "clerk", scope: "vault:read", action: "get", decision: "allow_always", granted_at: 999, granted_by_user_id: 1, ttl_expires_at: null, last_used_at: null, revoked_at: null, revoke_reason: null },
    ] as never);
    const r = await handleGetApprovals();
    expect(r.reachable).toBe(true);
    expect(r.decisions.map((d) => d.id)).toEqual(["new", "old"]);
    // No agent filter (fleet-wide) + socket pinned so the resolver
    // can't fall through to the broker.
    expect(approvalList).toHaveBeenCalledWith(undefined, {
      socket: "/run/op/sock",
    });
  });
});

describe("handleGetGrants (standing capability grants — broker grants DB)", () => {
  // Injectable `list` + `socketPath` deps → no real broker, no fs probe.
  const fakeGrant = (over: Partial<{
    id: string;
    agent_slug: string;
    key_allow: string[];
    write_allow: string[];
    expires_at: number | null;
    created_at: number;
    description: string | null;
  }> = {}) => ({
    id: "g1",
    agent_slug: "agent-a",
    key_allow: ["api/foo"],
    write_allow: [],
    expires_at: null,
    created_at: 1_700_000_000, // unix SECONDS
    description: null,
    ...over,
  });

  it("returns reachable:false + an actionable error when the socket is absent (null)", async () => {
    const list = vi.fn();
    const r = await handleGetGrants({ socketPath: null, list });
    expect(r.reachable).toBe(false);
    expect(r.grants).toEqual([]);
    expect(r.error).toMatch(/operator socket not present/i);
    // Must not attempt the RPC when there's no socket.
    expect(list).not.toHaveBeenCalled();
  });

  it("maps kind:'ok' grants and pins opts.socket (no agent filter)", async () => {
    const list = vi.fn(async () => ({
      kind: "ok" as const,
      grants: [
        fakeGrant({
          id: "g1",
          agent_slug: "alice",
          key_allow: ["api/key", "api/other"],
          write_allow: ["api/key"],
          expires_at: 1_700_000_500,
          created_at: 1_700_000_000,
          description: "scoped grant",
        }),
      ],
    }));
    const r = await handleGetGrants({ socketPath: "/run/broker-op/sock", list });
    expect(r.reachable).toBe(true);
    expect(list).toHaveBeenCalledWith(undefined, { socket: "/run/broker-op/sock" });
    expect(r.grants).toHaveLength(1);
    const g = r.grants[0];
    // Projection: agent_slug→agent, key_allow→keys, write_allow→writeKeys.
    expect(g.id).toBe("g1");
    expect(g.agent).toBe("alice");
    expect(g.keys).toEqual(["api/key", "api/other"]);
    expect(g.writeKeys).toEqual(["api/key"]);
    expect(g.description).toBe("scoped grant");
    // Time-unit: GrantMeta is unix SECONDS, UI wants ms → ×1000.
    expect(g.createdAt).toBe(1_700_000_000_000);
    expect(g.expiresAt).toBe(1_700_000_500_000);
  });

  it("keeps a null expires_at as null (never-expiring grant)", async () => {
    const list = vi.fn(async () => ({
      kind: "ok" as const,
      grants: [fakeGrant({ expires_at: null })],
    }));
    const r = await handleGetGrants({ socketPath: "/sock", list });
    expect(r.grants[0].expiresAt).toBeNull();
    // created_at still converted to ms.
    expect(r.grants[0].createdAt).toBe(1_700_000_000_000);
  });

  it("maps kind:'unreachable' to reachable:false + the broker reason", async () => {
    const list = vi.fn(async () => ({ kind: "unreachable" as const, msg: "broker not answering" }));
    const r = await handleGetGrants({ socketPath: "/sock", list });
    expect(r.reachable).toBe(false);
    expect(r.grants).toEqual([]);
    expect(r.error).toBe("broker not answering");
  });

  it("maps kind:'error' to reachable:false + the broker reason", async () => {
    const list = vi.fn(async () => ({ kind: "error" as const, msg: "denied" }));
    const r = await handleGetGrants({ socketPath: "/sock", list });
    expect(r.reachable).toBe(false);
    expect(r.grants).toEqual([]);
    expect(r.error).toBe("denied");
  });

  it("sorts grants newest-first by createdAt", async () => {
    const list = vi.fn(async () => ({
      kind: "ok" as const,
      grants: [
        fakeGrant({ id: "old", created_at: 1_000 }),
        fakeGrant({ id: "new", created_at: 9_000 }),
        fakeGrant({ id: "mid", created_at: 5_000 }),
      ],
    }));
    const r = await handleGetGrants({ socketPath: "/sock", list });
    expect(r.grants.map((g) => g.id)).toEqual(["new", "mid", "old"]);
  });

  it("never throws — a genuinely REJECTING list degrades to reachable:false", async () => {
    // handleGetGrants wraps the await in try/catch so its documented
    // "never throws" holds even if list's non-throwing contract changes.
    const list = vi.fn(async () => {
      throw new Error("socket exploded mid-RPC");
    });
    const r = await handleGetGrants({ socketPath: "/sock", list });
    expect(r.reachable).toBe(false);
    expect(r.grants).toEqual([]);
    expect(r.error).toContain("socket exploded");
  });
});

describe("handleRefreshAccountsQuota (cached + manual refresh)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
    __resetQuotaCacheForTests();
    asMock(getAccountInfos).mockReturnValue([
      { label: "a@x.com", health: "healthy" },
      { label: "b@x.com", health: "healthy" },
    ] as never);
  });

  // The mock client must answer BOTH ops: handleRefreshAccountsQuota
  // calls probeQuota; a subsequent handleGetAccounts calls listState.
  const withProbe = (impl: (labels: string[]) => unknown) => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        probeQuota: async (labels: string[]) => impl(labels),
        listState: async () => ({
          active: "a@x.com",
          fallback_order: [],
          accounts: [],
          agents: [],
          consumers: [],
        }),
      });
  };

  it("force-probes and caches usage; then default load serves it (no re-probe)", async () => {
    let probeCalls = 0;
    withProbe((labels) => {
      probeCalls++;
      return {
        results: labels.map((label) => ({
          label,
          result: {
            ok: true,
            data: {
              fiveHourUtilizationPct: 42,
              sevenDayUtilizationPct: 7,
              fiveHourResetAt: new Date(1810000000000),
              sevenDayResetAt: null,
            },
          },
        })),
      };
    });
    const r = await handleRefreshAccountsQuota(["a@x.com"], true);
    expect(r.ok).toBe(true);
    expect(r.usage["a@x.com"].usage?.fiveHourPct).toBe(42);
    expect(r.usage["a@x.com"].usage?.fiveHourResetAt).toBe(1810000000000);
    expect(r.usage["a@x.com"].usage?.sevenDayResetAt).toBeNull();
    expect(r.usage["a@x.com"].stale).toBe(false);
    expect(probeCalls).toBe(1);

    // Default accounts load now serves the cached probe — no new probe.
    const accts = await handleGetAccounts(undefined);
    const a = accts.find((x) => x.label === "a@x.com")!;
    expect(a.quotaUsage?.fiveHourPct).toBe(42);
    expect(a.quotaStale).toBe(false);
    expect(probeCalls).toBe(1); // unchanged — getAccounts never probes
  });

  it("TTL-respecting: a non-forced refresh skips an account whose cache is fresh", async () => {
    let probeCalls = 0;
    withProbe((labels) => {
      probeCalls++;
      return {
        results: labels.map((label) => ({
          label,
          result: { ok: true, data: { fiveHourUtilizationPct: 1, sevenDayUtilizationPct: 1, fiveHourResetAt: null, sevenDayResetAt: null } },
        })),
      };
    });
    await handleRefreshAccountsQuota(["a@x.com"], true); // primes cache
    expect(probeCalls).toBe(1);
    // Non-forced, cache fresh → must NOT probe again (anti-storm).
    const r = await handleRefreshAccountsQuota(["a@x.com"], false);
    expect(probeCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.usage["a@x.com"].stale).toBe(false);
  });

  it("degrades (ok:false) but still returns cached values when the broker is unreachable", async () => {
    brokerImpl.run = null; // withAuthBrokerClient throws FakeUnreachable
    const r = await handleRefreshAccountsQuota(["a@x.com"], true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("broker down");
    expect(r.usage["a@x.com"].usage).toBeNull();
    expect(r.usage["a@x.com"].stale).toBe(true);
  });

  it("records a per-account probe failure as null usage with the reason", async () => {
    withProbe((labels) => ({
      results: labels.map((label) => ({
        label,
        result: { ok: false, reason: "rate-limited probe" },
      })),
    }));
    const r = await handleRefreshAccountsQuota(["a@x.com"], true);
    expect(r.ok).toBe(true);
    expect(r.usage["a@x.com"].usage).toBeNull();
    expect(r.usage["a@x.com"].error).toBe("rate-limited probe");
  });

  it("default handleGetAccounts reports quotaStale:true and never probes when cache is empty", async () => {
    let probeCalls = 0;
    withProbe(() => {
      probeCalls++;
      return { results: [] };
    });
    const accts = await handleGetAccounts(undefined);
    for (const a of accts) {
      expect(a.quotaUsage).toBeNull();
      expect(a.quotaStale).toBe(true);
    }
    expect(probeCalls).toBe(0); // the cost guarantee
  });
});

describe("handleGetSummary — cached aggregate for the Summary tab", () => {
  beforeEach(() => {
    __resetDashboardCacheForTests();
  });

  // The handler is pure orchestration over cache-bound producers, so the
  // tests inject fakes — no broker/docker/hostd. Each `part(value, at)`
  // mimics what `dashboardCache.get` returns: the value + its dataAsOf.
  const part = <T>(value: T, dataAsOf: number): SummaryPart<T> => ({
    value,
    dataAsOf,
  });

  const fakeAgents: AgentInfo[] = [
    {
      name: "coach",
      active: "active",
      uptime: null,
      memory: null,
      extends: "default",
      topic_name: "Fitness",
      auth: { authenticated: true },
      memoryCollection: "coach-mem",
      lastTurnAt: null,
    },
  ];
  const fakeSystemHealth: SystemHealth = {
    broker: { reachable: true, active: "ops@example.com", accounts: 2, agents: 1, consumers: 0 },
    hindsight: {
      containerStatus: null,
      running: true,
      model: "x",
      provider: "y",
      mcpStateless: true,
    },
    hostd: { auditLogPresent: true, recent: [] },
  };
  const fakeApprovals: ApprovalsDashboard = { reachable: true, decisions: [] };
  const fakeSchedule: ScheduleDashboard = { entries: [], recentByAgent: {} };
  const fakeAccounts: AccountDashboardInfo[] = [];
  const fakeMemoryHealth: MemoryHealth = {
    reachable: true,
    url: "http://127.0.0.1:18888/mcp/",
    banks: [],
  };

  it("returns all parts (incl memoryHealth) and stamps dataAsOf as the OLDEST part", async () => {
    const out = await handleGetSummary({
      agents: async () => part(fakeAgents, 1000),
      systemHealth: async () => part(fakeSystemHealth, 3000),
      approvals: async () => part(fakeApprovals, 2000),
      schedule: async () => part(fakeSchedule, 5000),
      accounts: async () => part(fakeAccounts, 4000),
      memoryHealth: async () => part(fakeMemoryHealth, 6000),
    });
    expect(out.agents).toEqual(fakeAgents);
    expect(out.systemHealth).toEqual(fakeSystemHealth);
    expect(out.approvals).toEqual(fakeApprovals);
    expect(out.schedule).toEqual(fakeSchedule);
    expect(out.accounts).toEqual(fakeAccounts);
    expect(out.memoryHealth).toEqual(fakeMemoryHealth);
    // A healthy fleet → no attention rows.
    expect(out.attention).toEqual([]);
    // Oldest of {1000,3000,2000,5000,4000,6000} = 1000.
    expect(out.dataAsOf).toBe(1000);
  });

  it("derives `attention` from the parts (memory + broker)", async () => {
    const memUnhealthy: MemoryHealth = {
      reachable: true,
      url: "http://127.0.0.1:18888/mcp/",
      banks: [
        {
          bank: "coach-mem",
          agents: ["coach"],
          ok: true,
          totalDocuments: 5,
          totalFacts: 10,
          pendingOperations: 0,
          newestDocumentAt: null,
          recentUnextractedCount: 2,
          oldestUnextractedAt: null,
          unextractedDocIds: [],
          mentalModels: [],
          staleMentalModelCount: 0,
          corruptedMentalModelNames: [],
          status: "fail",
          statusDetail: "gaps",
        },
      ],
    };
    const sysBrokerDown: SystemHealth = {
      ...fakeSystemHealth,
      broker: { reachable: false, error: "socket missing" },
    };
    const out = await handleGetSummary({
      agents: async () => part(fakeAgents, 1000),
      systemHealth: async () => part(sysBrokerDown, 1000),
      approvals: async () => part(fakeApprovals, 1000),
      schedule: async () => part(fakeSchedule, 1000),
      accounts: async () => part(fakeAccounts, 1000),
      memoryHealth: async () => part(memUnhealthy, 1000),
    });
    // Both a critical (broker + unextracted) surface; criticals sort first.
    expect(out.attention.length).toBeGreaterThanOrEqual(2);
    expect(out.attention[0].severity).toBe("critical");
    expect(out.attention.some((a) => a.tab === "system")).toBe(true);
    expect(out.attention.some((a) => a.tab === "memory")).toBe(true);
  });

  it("tolerates ONE producer throwing — that field is null, the rest present", async () => {
    const out = await handleGetSummary({
      agents: async () => part(fakeAgents, 1000),
      systemHealth: async () => {
        throw new Error("broker down");
      },
      approvals: async () => part(fakeApprovals, 2000),
      schedule: async () => part(fakeSchedule, 5000),
      accounts: async () => part(fakeAccounts, 4000),
      memoryHealth: async () => part(fakeMemoryHealth, 6000),
    });
    expect(out.systemHealth).toBeNull(); // the failed part
    expect(out.agents).toEqual(fakeAgents); // others unaffected
    expect(out.approvals).toEqual(fakeApprovals);
    expect(out.schedule).toEqual(fakeSchedule);
    expect(out.accounts).toEqual(fakeAccounts);
    expect(out.memoryHealth).toEqual(fakeMemoryHealth);
    // A null part contributes nothing to attention (no throw).
    expect(out.attention).toEqual([]);
    // dataAsOf ignores the null part → oldest of the survivors = 1000.
    expect(out.dataAsOf).toBe(1000);
  });

  it("when EVERY producer throws, all fields null, attention empty, dataAsOf 0", async () => {
    const boom = async (): Promise<never> => {
      throw new Error("nope");
    };
    const out = await handleGetSummary({
      agents: boom,
      systemHealth: boom,
      approvals: boom,
      schedule: boom,
      accounts: boom,
      memoryHealth: boom,
    });
    expect(out.agents).toBeNull();
    expect(out.systemHealth).toBeNull();
    expect(out.approvals).toBeNull();
    expect(out.schedule).toBeNull();
    expect(out.accounts).toBeNull();
    expect(out.memoryHealth).toBeNull();
    expect(out.attention).toEqual([]);
    expect(out.dataAsOf).toBe(0);
  });

  it("runs the producers concurrently (Promise.all, not sequential)", async () => {
    // If serialized, the second producer would observe the first already
    // settled. We assert all six were INVOKED before any resolves by
    // counting starts before the gate opens.
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mk =
      <T>(value: T): (() => Promise<SummaryPart<T>>) =>
      async () => {
        started++;
        await gate;
        return part(value, 1000);
      };
    const p = handleGetSummary({
      agents: mk(fakeAgents),
      systemHealth: mk(fakeSystemHealth),
      approvals: mk(fakeApprovals),
      schedule: mk(fakeSchedule),
      accounts: mk(fakeAccounts),
      memoryHealth: mk(fakeMemoryHealth),
    });
    // Let the microtasks up to the gate run.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(6); // all kicked before any completed
    release();
    const out = await p;
    expect(out.agents).toEqual(fakeAgents);
  });
});

describe("deriveAttention — server-side triage derivation (pure)", () => {
  const NOW = 1_700_000_000_000;

  const mkBank = (
    over: Partial<MemoryHealth["banks"][number]> = {},
  ): MemoryHealth["banks"][number] => ({
    bank: "coach-mem",
    agents: ["coach"],
    ok: true,
    totalDocuments: 1,
    totalFacts: 1,
    pendingOperations: 0,
    newestDocumentAt: null,
    recentUnextractedCount: 0,
    oldestUnextractedAt: null,
    unextractedDocIds: [],
    mentalModels: [],
    staleMentalModelCount: 0,
    corruptedMentalModelNames: [],
    status: "ok",
    statusDetail: "facts flowing",
    ...over,
  });

  it("empty/healthy inputs → no items", () => {
    expect(deriveAttention({}, NOW)).toEqual([]);
    expect(
      deriveAttention(
        {
          memoryHealth: { reachable: true, url: "u", banks: [] },
          accounts: [],
          schedule: { entries: [], recentByAgent: {} },
          systemHealth: {
            broker: { reachable: true },
            hindsight: {
              containerStatus: null,
              running: true,
              model: null,
              provider: null,
              mcpStateless: null,
            },
            hostd: { auditLogPresent: true, recent: [] },
          },
          agents: [],
        },
        NOW,
      ),
    ).toEqual([]);
  });

  it("null/missing parts contribute nothing", () => {
    expect(
      deriveAttention(
        {
          memoryHealth: null,
          accounts: null,
          schedule: null,
          systemHealth: null,
          agents: null,
        },
        NOW,
      ),
    ).toEqual([]);
  });

  it("memory: corrupted model → critical/memory", () => {
    const out = deriveAttention(
      {
        memoryHealth: {
          reachable: true,
          url: "u",
          banks: [mkBank({ corruptedMentalModelNames: ["user-profile"] })],
        },
      },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "critical", tab: "memory" });
    expect(out[0].title).toContain("user-profile");
  });

  it("memory: recent unextracted → critical/memory", () => {
    const out = deriveAttention(
      {
        memoryHealth: {
          reachable: true,
          url: "u",
          banks: [mkBank({ recentUnextractedCount: 3 })],
        },
      },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "critical", tab: "memory" });
  });

  it("memory: stale model → warn/memory", () => {
    const out = deriveAttention(
      {
        memoryHealth: {
          reachable: true,
          url: "u",
          banks: [mkBank({ staleMentalModelCount: 2 })],
        },
      },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "warn", tab: "memory" });
  });

  it("memory: unreachable hindsight → critical/memory", () => {
    const out = deriveAttention(
      { memoryHealth: { reachable: false, url: "u", banks: [] } },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "critical", tab: "memory" });
  });

  it("accounts: exhausted quota → warn/accounts", () => {
    const out = deriveAttention(
      {
        accounts: [
          {
            label: "pix@x",
            quota: { exhausted: true, exhausted_until: NOW + 3600_000 },
          } as unknown as AccountDashboardInfo,
          {
            label: "ok@x",
            quota: { exhausted: false },
          } as unknown as AccountDashboardInfo,
        ],
      },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "warn", tab: "accounts" });
    expect(out[0].title).toContain("pix@x");
  });

  it("schedule: a non-zero recent fire → warn/schedule", () => {
    const out = deriveAttention(
      {
        schedule: {
          entries: [],
          recentByAgent: {
            clerk: [
              { exitCode: 0 } as never,
              { exitCode: -1 } as never,
            ],
            ok: [{ exitCode: 0 } as never],
          },
        },
      },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "warn", tab: "schedule" });
    expect(out[0].title).toContain("clerk");
  });

  it("system: broker down / hindsight down / hostd error → critical/system", () => {
    const out = deriveAttention(
      {
        systemHealth: {
          broker: { reachable: false, error: "no socket" },
          hindsight: {
            containerStatus: null,
            running: false,
            model: null,
            provider: null,
            mcpStateless: null,
          },
          hostd: { auditLogPresent: false, recent: [], error: "audit unreadable" },
        },
      },
      NOW,
    );
    expect(out).toHaveLength(3);
    expect(out.every((a) => a.severity === "critical" && a.tab === "system")).toBe(true);
  });

  it("agents: token expiring within 24h → warn/agents; far-future does not", () => {
    const mkAgent = (name: string, expiresAt?: number): AgentInfo =>
      ({
        name,
        active: "active",
        uptime: null,
        memory: null,
        extends: "default",
        topic_name: name,
        auth: { authenticated: true, expiresAt },
        memoryCollection: `${name}-mem`,
        lastTurnAt: null,
      } as AgentInfo);
    const out = deriveAttention(
      {
        agents: [
          mkAgent("soon", NOW + 60 * 60 * 1000), // 1h → warn
          mkAgent("later", NOW + 48 * 60 * 60 * 1000), // 48h → no
          mkAgent("past", NOW - 1000), // already expired → no (window is future)
          mkAgent("none"), // no expiry → no
        ],
      },
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: "warn", tab: "agents" });
    expect(out[0].title).toContain("soon");
  });

  it("sorts critical → warn → info", () => {
    const out = deriveAttention(
      {
        memoryHealth: {
          reachable: true,
          url: "u",
          banks: [
            mkBank({ staleMentalModelCount: 1 }), // warn
            mkBank({ recentUnextractedCount: 1 }), // critical
          ],
        },
      },
      NOW,
    );
    expect(out.map((a) => a.severity)).toEqual(["critical", "warn"]);
  });

  it("caps the list at ATTENTION_MAX_ITEMS, keeping the most severe", () => {
    // 20 stale-model (warn) banks + 1 unextracted (critical) bank.
    const banks: MemoryHealth["banks"] = [];
    for (let i = 0; i < 20; i++) {
      banks.push(mkBank({ bank: `bank${i}`, staleMentalModelCount: 1 }));
    }
    banks.push(mkBank({ bank: "critical-bank", recentUnextractedCount: 1 }));
    const out = deriveAttention(
      { memoryHealth: { reachable: true, url: "u", banks } },
      NOW,
    );
    expect(out).toHaveLength(ATTENTION_MAX_ITEMS);
    // The single critical must survive the cap (sorted first).
    expect(out[0].severity).toBe("critical");
    const items: AttentionItem[] = out;
    expect(items.every((a) => a.severity !== "info")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Memory remediation handlers (audit ranks 7 + 22). These are HTTP pokes at
// hindsight — they make ZERO model calls. Tests inject the inspect/trigger
// deps so they never touch a real hindsight instance.
// ---------------------------------------------------------------------------
describe("memory remediation handlers", () => {
  // mockConfig agents: coach (bank "coach-mem"), sage (bank "sage").
  const mkBankHealth = (over: Partial<{
    ok: boolean;
    reason?: string;
    totalDocuments: number;
    totalFacts: number;
    pendingOperations: number;
    newestDocumentAt: string | null;
    unextractedDocuments: Array<{ id: string; createdAt: string; textLength: number; memoryUnitCount: number }>;
    mentalModels: Array<{ id: string; name: string; lastRefreshedAt: string | null; createdAt: string | null; contentLength: number; contentHead: string }>;
  }> = {}) => ({
    bankId: "coach-mem",
    ok: true,
    totalDocuments: 5,
    totalFacts: 20,
    pendingOperations: 0,
    newestDocumentAt: new Date().toISOString(),
    unextractedDocuments: [],
    mentalModels: [],
    ...over,
  });

  describe("handleMemoryReprocess", () => {
    it("rejects an unknown bank without inspecting", async () => {
      const inspect = vi.fn();
      const trigger = vi.fn();
      const r = await handleMemoryReprocess(mockConfig, { bank: "nope" }, {
        inspect: inspect as never,
        trigger: trigger as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Unknown bank");
      expect(inspect).not.toHaveBeenCalled();
      expect(trigger).not.toHaveBeenCalled();
    });

    it("rejects a missing bank", async () => {
      const r = await handleMemoryReprocess(mockConfig, {}, {});
      expect(r.ok).toBe(false);
      expect(r.error).toContain("bank");
    });

    it("re-derives gap doc ids server-side and triggers reprocess", async () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 86400000).toISOString();
      const inspect = vi.fn(async () =>
        mkBankHealth({
          unextractedDocuments: [
            { id: "doc-a", createdAt: recent, textLength: 5000, memoryUnitCount: 0 },
            { id: "doc-b", createdAt: recent, textLength: 5000, memoryUnitCount: 0 },
          ],
        }),
      );
      let passedIds: string[] = [];
      const trigger = vi.fn(async (_base: string, _bank: string, ids: string[]) => {
        passedIds = ids;
        return { triggered: ids.length, failed: 0 };
      });
      const r = await handleMemoryReprocess(mockConfig, { bank: "coach-mem" }, {
        inspect: inspect as never,
        trigger: trigger as never,
        now,
      });
      expect(r.ok).toBe(true);
      expect(r.triggered).toBe(2);
      expect(r.failed).toBe(0);
      expect(passedIds.sort()).toEqual(["doc-a", "doc-b"]);
      // The trigger gets the REST base (no /mcp/), not the raw doc list from the body.
      expect(trigger.mock.calls[0][0]).toBe("http://127.0.0.1:18888");
    });

    it("ignores client-supplied doc ids — only inspected gaps are used", async () => {
      const inspect = vi.fn(async () => mkBankHealth({ unextractedDocuments: [] }));
      const trigger = vi.fn();
      const r = await handleMemoryReprocess(
        mockConfig,
        { bank: "coach-mem", docIds: ["evil-1"] } as never,
        { inspect: inspect as never, trigger: trigger as never },
      );
      // No gaps from inspect → no-op, trigger never called with arbitrary ids.
      expect(r.ok).toBe(true);
      expect(r.triggered).toBe(0);
      expect(trigger).not.toHaveBeenCalled();
    });

    it("maps a failed inspection to ok:false", async () => {
      const inspect = vi.fn(async () => mkBankHealth({ ok: false, reason: "Timeout" }));
      const r = await handleMemoryReprocess(mockConfig, { bank: "coach-mem" }, {
        inspect: inspect as never,
        trigger: vi.fn() as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Timeout");
    });

    it("reports failed > 0 as ok:false but still surfaces counts", async () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 86400000).toISOString();
      const inspect = vi.fn(async () =>
        mkBankHealth({
          unextractedDocuments: [
            { id: "doc-a", createdAt: recent, textLength: 5000, memoryUnitCount: 0 },
          ],
        }),
      );
      const trigger = vi.fn(async () => ({ triggered: 0, failed: 1, error: "HTTP 500" }));
      const r = await handleMemoryReprocess(mockConfig, { bank: "coach-mem" }, {
        inspect: inspect as never,
        trigger: trigger as never,
        now,
      });
      expect(r.ok).toBe(false);
      expect(r.failed).toBe(1);
      expect(r.error).toBe("HTTP 500");
    });

    it("never throws — a throwing trigger is caught and mapped to ok:false", async () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 86400000).toISOString();
      const inspect = vi.fn(async () =>
        mkBankHealth({
          unextractedDocuments: [
            { id: "doc-a", createdAt: recent, textLength: 5000, memoryUnitCount: 0 },
          ],
        }),
      );
      const trigger = vi.fn(async () => {
        throw new Error("boom");
      });
      const r = await handleMemoryReprocess(mockConfig, { bank: "coach-mem" }, {
        inspect: inspect as never,
        trigger: trigger as never,
        now,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("boom");
    });
  });

  describe("handleMemoryRefreshModel", () => {
    it("rejects an unknown bank", async () => {
      const r = await handleMemoryRefreshModel(mockConfig, { bank: "nope", modelId: "m" }, {
        inspect: vi.fn() as never,
        trigger: vi.fn() as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Unknown bank");
    });

    it("rejects a missing modelId", async () => {
      const r = await handleMemoryRefreshModel(mockConfig, { bank: "coach-mem" }, {});
      expect(r.ok).toBe(false);
      expect(r.error).toContain("modelId");
    });

    it("rejects a modelId not belonging to the bank (no arbitrary POST)", async () => {
      const inspect = vi.fn(async () =>
        mkBankHealth({
          mentalModels: [
            { id: "mm-1", name: "user-profile", lastRefreshedAt: null, createdAt: null, contentLength: 10, contentHead: "x" },
          ],
        }),
      );
      const trigger = vi.fn();
      const r = await handleMemoryRefreshModel(mockConfig, { bank: "coach-mem", modelId: "forged-id" }, {
        inspect: inspect as never,
        trigger: trigger as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Unknown mental model");
      expect(trigger).not.toHaveBeenCalled();
    });

    it("triggers a refresh for a valid model id", async () => {
      const inspect = vi.fn(async () =>
        mkBankHealth({
          mentalModels: [
            { id: "mm-1", name: "user-profile", lastRefreshedAt: null, createdAt: null, contentLength: 10, contentHead: "x" },
          ],
        }),
      );
      const trigger = vi.fn(async () => ({ ok: true as const }));
      const r = await handleMemoryRefreshModel(mockConfig, { bank: "coach-mem", modelId: "mm-1" }, {
        inspect: inspect as never,
        trigger: trigger as never,
      });
      expect(r.ok).toBe(true);
      expect(trigger).toHaveBeenCalledWith(
        "http://127.0.0.1:18888",
        "coach-mem",
        "mm-1",
        expect.anything(),
      );
    });

    it("maps a trigger failure to ok:false with error", async () => {
      const inspect = vi.fn(async () =>
        mkBankHealth({
          mentalModels: [
            { id: "mm-1", name: "x", lastRefreshedAt: null, createdAt: null, contentLength: 0, contentHead: "" },
          ],
        }),
      );
      const trigger = vi.fn(async () => ({ ok: false, error: "HTTP 502" }));
      const r = await handleMemoryRefreshModel(mockConfig, { bank: "coach-mem", modelId: "mm-1" }, {
        inspect: inspect as never,
        trigger: trigger as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("HTTP 502");
    });
  });

  describe("handleMemoryBuildProfile", () => {
    it("rejects an unknown bank", async () => {
      const trigger = vi.fn();
      const r = await handleMemoryBuildProfile(mockConfig, { bank: "nope" }, {
        trigger: trigger as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Unknown bank");
      expect(trigger).not.toHaveBeenCalled();
    });

    it("rejects a missing bank", async () => {
      const r = await handleMemoryBuildProfile(mockConfig, {}, {});
      expect(r.ok).toBe(false);
      expect(r.error).toContain("bank");
    });

    it("triggers buildUserProfile with the MCP url (not the REST base)", async () => {
      const trigger = vi.fn(async () => ({ ok: true }));
      const r = await handleMemoryBuildProfile(mockConfig, { bank: "coach-mem" }, {
        trigger: trigger as never,
      });
      expect(r.ok).toBe(true);
      // buildUserProfile takes the MCP url (with /mcp/), not the REST base.
      expect(trigger.mock.calls[0][0]).toBe("http://127.0.0.1:18888/mcp/");
      expect(trigger.mock.calls[0][1]).toBe("coach-mem");
    });

    it("maps a trigger failure to ok:false", async () => {
      const trigger = vi.fn(async () => ({ ok: false, error: "MCP error" }));
      const r = await handleMemoryBuildProfile(mockConfig, { bank: "sage" }, {
        trigger: trigger as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("MCP error");
    });
  });

  describe("handleGetMentalModel", () => {
    it("rejects a missing bank/id without hitting hindsight", async () => {
      const detail = vi.fn();
      const r1 = await handleGetMentalModel(mockConfig, "", "mm-1", { detail: detail as never });
      expect(r1.ok).toBe(false);
      expect(r1.error).toContain("bank");
      const r2 = await handleGetMentalModel(mockConfig, "coach-mem", "", { detail: detail as never });
      expect(r2.ok).toBe(false);
      expect(r2.error).toContain("id");
      expect(detail).not.toHaveBeenCalled();
    });

    it("rejects an unknown bank (gate before any network call)", async () => {
      const detail = vi.fn();
      const r = await handleGetMentalModel(mockConfig, "nope", "mm-1", {
        detail: detail as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Unknown bank");
      expect(detail).not.toHaveBeenCalled();
    });

    it("returns the model detail for a known bank", async () => {
      const detail = vi.fn(async () => ({
        ok: true as const,
        model: {
          id: "mm-1",
          name: "user-profile",
          sourceQuery: "What do we know about the user?",
          content: "# User Profile\n\n…",
          lastRefreshedAt: "2026-06-15T11:00:00Z",
          createdAt: "2026-06-06T00:00:00Z",
          refreshMode: "full",
          basedOnCounts: { observation: 24, directives: 11 },
          totalSourceFacts: 35,
        },
      }));
      const r = await handleGetMentalModel(mockConfig, "coach-mem", "mm-1", {
        detail: detail as never,
      });
      expect(r.ok).toBe(true);
      expect(r.model?.sourceQuery).toBe("What do we know about the user?");
      expect(r.model?.totalSourceFacts).toBe(35);
      // The MCP url (not the REST base) is passed through to the detail fetcher.
      expect(detail.mock.calls[0][0]).toBe("http://127.0.0.1:18888/mcp/");
      expect(detail.mock.calls[0][1]).toBe("coach-mem");
      expect(detail.mock.calls[0][2]).toBe("mm-1");
    });

    it("maps a detail failure (e.g. 404 unknown id) to ok:false", async () => {
      const detail = vi.fn(async () => ({ ok: false as const, reason: "HTTP 404" }));
      const r = await handleGetMentalModel(mockConfig, "coach-mem", "forged", {
        detail: detail as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toBe("HTTP 404");
    });

    it("never throws — a throwing detail fetch is mapped to ok:false", async () => {
      const detail = vi.fn(async () => {
        throw new Error("boom");
      });
      const r = await handleGetMentalModel(mockConfig, "coach-mem", "mm-1", {
        detail: detail as never,
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("boom");
    });
  });
});

describe("resolveDashboardFilePath — SPA tab path routing", () => {
  const TAB_ROUTES = [
    "summary",
    "agents",
    "accounts",
    "system",
    "memory",
    "connections",
    "schedule",
    "approvals",
  ];

  it("serves the index.html shell for the root path", () => {
    expect(resolveDashboardFilePath("/")).toBe("/index.html");
  });

  it("serves the shell for every known tab route (reload/deep-link doesn't 404)", () => {
    for (const tab of TAB_ROUTES) {
      expect(resolveDashboardFilePath(`/${tab}`)).toBe("/index.html");
    }
  });

  it("tolerates a trailing slash on a tab route", () => {
    expect(resolveDashboardFilePath("/connections/")).toBe("/index.html");
  });

  it("passes through real asset paths unchanged (not masked by the shell)", () => {
    expect(resolveDashboardFilePath("/index.html")).toBe("/index.html");
    expect(resolveDashboardFilePath("/styles.css")).toBe("/styles.css");
    expect(resolveDashboardFilePath("/favicon.ico")).toBe("/favicon.ico");
  });

  it("passes through unknown paths unchanged so they still 404", () => {
    // A path that is NOT a tab and NOT a real file must stay as-is — the
    // caller's existsSync check then 404s it, rather than the shell masking
    // the miss.
    expect(resolveDashboardFilePath("/nope")).toBe("/nope");
    expect(resolveDashboardFilePath("/connections-typo")).toBe(
      "/connections-typo",
    );
    expect(resolveDashboardFilePath("/agents/extra/depth")).toBe(
      "/agents/extra/depth",
    );
  });
});

describe("dashboardCacheControl — stale-shell prevention", () => {
  it("forces revalidation on the HTML document (kills stale-render bugs)", () => {
    expect(dashboardCacheControl(".html")).toBe("no-cache, must-revalidate");
  });

  it("applies no explicit policy to non-HTML assets", () => {
    expect(dashboardCacheControl(".css")).toBeUndefined();
    expect(dashboardCacheControl(".js")).toBeUndefined();
    expect(dashboardCacheControl(".png")).toBeUndefined();
    expect(dashboardCacheControl("")).toBeUndefined();
  });
});

describe("dashboard CSS — .accounts-grid desktop-hide must stay scoped", () => {
  // Regression guard for the "connections never show on desktop" bug. The
  // Accounts tab shows a wide-screen table and hides its mobile card grid via
  // `@media (min-width: 701px) { .accounts-grid { display: none } }`. The
  // Connections tab REUSES .accounts-grid for its OAuth/Notion cards but has no
  // table fallback, so an UNSCOPED rule hid every connection card on any screen
  // wider than 700px (cards rendered but display:none; only the non-grid
  // empty-state text showed). The fix scopes the hide to `#accounts`. If anyone
  // reintroduces the unscoped form, this fails.
  const html = readFileSync(
    new URL("../src/web/ui/index.html", import.meta.url),
    "utf8",
  );

  it("hides .accounts-grid on desktop only within #accounts", () => {
    expect(html).toContain("#accounts .accounts-grid { display: none; }");
  });

  it("has no UNSCOPED .accounts-grid display:none rule (would blank Connections)", () => {
    // Any `.accounts-grid { display: none }` NOT scoped by `#accounts ` is the
    // exact regression: it hides the Connections tab's cards (which have no
    // table fallback). The `.accounts-grid` base rule uses `display: grid` and
    // the 600px rule sets grid-template-columns, so this pattern is specific to
    // the desktop-hide. The negative lookbehind passes the scoped form.
    expect(html).not.toMatch(
      /(?<!#accounts )\.accounts-grid\s*\{\s*display:\s*none/,
    );
  });
});
