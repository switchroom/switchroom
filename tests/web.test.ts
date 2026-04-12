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
  resolveAgentsDir: vi.fn(() => "/home/test/.clerk/agents"),
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
import { getAllAgentStatuses, startAgent, stopAgent, restartAgent } from "../src/agents/lifecycle.js";
import { getAllAuthStatuses } from "../src/auth/manager.js";
import { execFileSync } from "node:child_process";
import type { ClerkConfig } from "../src/config/schema.js";

const mockConfig: ClerkConfig = {
  clerk: { version: 1, agents_dir: "~/.clerk/agents" },
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
    vi.mocked(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: "2025-01-01T00:00:00Z", memory: "128MB", pid: 1234 },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });

    vi.mocked(getAllAuthStatuses).mockReturnValue({
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
    vi.mocked(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: null, memory: null, pid: null },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    vi.mocked(getAllAuthStatuses).mockReturnValue({
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
    vi.mocked(startAgent).mockImplementation(() => {});
    const result = handleStartAgent("coach");
    expect(result).toEqual({ ok: true });
    expect(startAgent).toHaveBeenCalledWith("coach");
  });

  it("returns error when startAgent throws", () => {
    vi.mocked(startAgent).mockImplementation(() => {
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
    vi.mocked(stopAgent).mockImplementation(() => {});
    const result = handleStopAgent("coach");
    expect(result).toEqual({ ok: true });
    expect(stopAgent).toHaveBeenCalledWith("coach");
  });

  it("returns error when stopAgent throws", () => {
    vi.mocked(stopAgent).mockImplementation(() => {
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
    vi.mocked(restartAgent).mockImplementation(() => {});
    const result = handleRestartAgent("sage");
    expect(result).toEqual({ ok: true });
    expect(restartAgent).toHaveBeenCalledWith("sage");
  });

  it("returns error when restartAgent throws", () => {
    vi.mocked(restartAgent).mockImplementation(() => {
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
    vi.mocked(execFileSync).mockReturnValue("line 1\nline 2\nline 3\n" as any);

    const result = handleGetLogs("coach", 50);
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("line 1");
    expect(execFileSync).toHaveBeenCalledWith(
      "journalctl",
      ["--user", "-u", "clerk-coach", "--no-pager", "-n", "50"],
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("uses default of 50 lines", () => {
    vi.mocked(execFileSync).mockReturnValue("output" as any);

    handleGetLogs("sage");
    expect(execFileSync).toHaveBeenCalledWith(
      "journalctl",
      ["--user", "-u", "clerk-sage", "--no-pager", "-n", "50"],
      expect.any(Object)
    );
  });

  it("returns error when journalctl fails", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("no journal data");
    });

    const result = handleGetLogs("missing", 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no journal data");
  });
});
