import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock lifecycle module
vi.mock("../src/agents/lifecycle.js", () => ({
  getAllAgentStatuses: vi.fn(),
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  restartAgent: vi.fn(),
}));

// Mock auth module
vi.mock("../src/auth/manager.js", () => ({
  getAllAuthStatuses: vi.fn(),
}));

// Mock config loader
vi.mock("../src/config/loader.js", () => ({
  resolveAgentsDir: vi.fn(() => "/home/test/.switchroom/agents"),
}));

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

import {
  handleGetAgents,
  handleStartAgent,
  handleStopAgent,
  handleRestartAgent,
  handleGetLogs,
  type AgentInfo,
} from "../src/web/api.js";
import { isOriginAllowed } from "../src/web/server.js";
import { getAllAgentStatuses, startAgent, stopAgent, restartAgent } from "../src/agents/lifecycle.js";
import { getAllAuthStatuses } from "../src/auth/manager.js";
import { execFileSync } from "node:child_process";
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
  });

  it("returns combined status and auth info for each agent", () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: "2025-01-01T00:00:00Z", memory: "128MB", pid: 1234 },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });

    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: true, subscriptionType: "max", timeUntilExpiry: "7h 30m", expiresAt: Date.now() + 27000000 },
      sage: { authenticated: false },
    });

    const result = handleGetAgents(mockConfig);

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

  it("returns correct shape with all fields", () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: null, memory: null, pid: null },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: false },
      sage: { authenticated: false },
    });

    const result = handleGetAgents(mockConfig);
    const expectedKeys: (keyof AgentInfo)[] = [
      "name", "active", "uptime", "memory", "extends",
      "topic_name", "topic_emoji", "auth", "memoryCollection",
    ];

    for (const agent of result) {
      for (const key of expectedKeys) {
        expect(agent).toHaveProperty(key);
      }
      expect(agent.auth).toHaveProperty("authenticated");
    }
  });
});

describe("handleStartAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls startAgent and returns ok on success", () => {
    asMock(startAgent).mockImplementation(() => {});
    const result = handleStartAgent("coach");
    expect(result).toEqual({ ok: true });
    expect(startAgent).toHaveBeenCalledWith("coach");
  });

  it("returns error when startAgent throws", () => {
    asMock(startAgent).mockImplementation(() => {
      throw new Error("service not found");
    });
    const result = handleStartAgent("missing");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("service not found");
  });
});

describe("handleStopAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls stopAgent and returns ok on success", () => {
    asMock(stopAgent).mockImplementation(() => {});
    const result = handleStopAgent("coach");
    expect(result).toEqual({ ok: true });
    expect(stopAgent).toHaveBeenCalledWith("coach");
  });

  it("returns error when stopAgent throws", () => {
    asMock(stopAgent).mockImplementation(() => {
      throw new Error("cannot stop");
    });
    const result = handleStopAgent("coach");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot stop");
  });
});

describe("handleRestartAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls restartAgent and returns ok on success", () => {
    asMock(restartAgent).mockImplementation(() => {});
    const result = handleRestartAgent("sage");
    expect(result).toEqual({ ok: true });
    expect(restartAgent).toHaveBeenCalledWith("sage");
  });

  it("returns error when restartAgent throws", () => {
    asMock(restartAgent).mockImplementation(() => {
      throw new Error("restart failed");
    });
    const result = handleRestartAgent("sage");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("restart failed");
  });
});

describe("handleGetLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns logs from journalctl", () => {
    asMock(execFileSync).mockReturnValue("line 1\nline 2\nline 3\n" as any);

    const result = handleGetLogs("coach", 50);
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("line 1");
    expect(execFileSync).toHaveBeenCalledWith(
      "journalctl",
      ["--user", "-u", "switchroom-coach", "--no-pager", "-n", "50"],
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("uses default of 50 lines", () => {
    asMock(execFileSync).mockReturnValue("output" as any);

    handleGetLogs("sage");
    expect(execFileSync).toHaveBeenCalledWith(
      "journalctl",
      ["--user", "-u", "switchroom-sage", "--no-pager", "-n", "50"],
      expect.any(Object)
    );
  });

  it("returns error when journalctl fails", () => {
    asMock(execFileSync).mockImplementation(() => {
      throw new Error("no journal data");
    });

    const result = handleGetLogs("missing", 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no journal data");
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
