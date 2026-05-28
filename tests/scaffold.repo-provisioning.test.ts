/**
 * Tests that reconcileAgent correctly calls the worktree provisioning
 * functions (ensureBareClone, ensureAgentWorktree) when repos: entries
 * are configured.
 *
 * These tests use vi.mock so they don't require a real git remote or
 * git binary. The mocked functions record calls so we can assert that
 * reconcileAgent actually drives provisioning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Mock the repos modules before importing reconcileAgent so that vitest
// hoisting replaces the implementations with stubs.
vi.mock("../src/repos/bare-clone.js", () => ({
  ensureBareClone: vi.fn((slug: string, _url: string) => `/mock/repos/${slug}.git`),
  bareClonePath: vi.fn((slug: string) => `/mock/repos/${slug}.git`),
}));

vi.mock("../src/repos/agent-worktree.js", () => ({
  ensureAgentWorktree: vi.fn(() => ({
    path: "/mock/worktree",
    branch: "agent/test/main",
    dirty: false,
  })),
  removeAgentWorktree: vi.fn(),
  agentWorktreePath: vi.fn((agentDir: string, slug: string) => join(agentDir, "work", slug)),
  listAgentWorktrees: vi.fn(() => []),
}));

import { reconcileAgent } from "../src/agents/scaffold.js";
import { ensureBareClone } from "../src/repos/bare-clone.js";
import { ensureAgentWorktree } from "../src/repos/agent-worktree.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function makeSwitchroomConfig(
  agentName: string,
  agentConfig: AgentConfig,
): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: telegramConfig,
    agents: { [agentName]: agentConfig },
  } as SwitchroomConfig;
}

describe("reconcileAgent — repos: worktree provisioning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-repo-prov-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls ensureBareClone and ensureAgentWorktree for each repos: entry", () => {
    const agentConfig = makeAgentConfig({
      repos: {
        "my-app": { url: "https://github.com/example/my-app.git" },
        "shared-lib": { url: "git@github.com:example/shared-lib.git" },
      },
    });

    const switchroomConfig = makeSwitchroomConfig("test-agent", agentConfig);

    // Pre-create the agent directory (reconcileAgent requires it to exist)
    const agentDir = join(tmpDir, "test-agent");
    mkdirSync(agentDir, { recursive: true });

    reconcileAgent("test-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    // ensureBareClone should have been called once per repos: entry
    expect(ensureBareClone).toHaveBeenCalledTimes(2);
    expect(ensureBareClone).toHaveBeenCalledWith("my-app", "https://github.com/example/my-app.git");
    expect(ensureBareClone).toHaveBeenCalledWith("shared-lib", "git@github.com:example/shared-lib.git");

    // ensureAgentWorktree should have been called once per repos: entry
    // with the agentName, slug, clonePath (returned by ensureBareClone), agentDir
    expect(ensureAgentWorktree).toHaveBeenCalledTimes(2);
    expect(ensureAgentWorktree).toHaveBeenCalledWith(
      "test-agent",
      "my-app",
      "/mock/repos/my-app.git",
      agentDir,
    );
    expect(ensureAgentWorktree).toHaveBeenCalledWith(
      "test-agent",
      "shared-lib",
      "/mock/repos/shared-lib.git",
      agentDir,
    );
  });

  it("does not call provisioning functions when repos: is absent", () => {
    const agentConfig = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig("no-repos-agent", agentConfig);
    const agentDir = join(tmpDir, "no-repos-agent");
    mkdirSync(agentDir, { recursive: true });

    reconcileAgent("no-repos-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig);

    expect(ensureBareClone).not.toHaveBeenCalled();
    expect(ensureAgentWorktree).not.toHaveBeenCalled();
  });

  it("continues reconcile when provisioning throws (non-fatal)", () => {
    const mockEnsureBareClone = ensureBareClone as ReturnType<typeof vi.fn>;
    mockEnsureBareClone.mockImplementationOnce(() => {
      throw new Error("simulated git clone failure");
    });

    const agentConfig = makeAgentConfig({
      repos: {
        "failing-repo": { url: "https://github.com/example/bad.git" },
      },
    });

    const switchroomConfig = makeSwitchroomConfig("fault-agent", agentConfig);
    const agentDir = join(tmpDir, "fault-agent");
    mkdirSync(agentDir, { recursive: true });

    // reconcileAgent must not throw — provisioning failure is non-fatal
    expect(() =>
      reconcileAgent("fault-agent", agentConfig, tmpDir, telegramConfig, switchroomConfig),
    ).not.toThrow();
  });
});
