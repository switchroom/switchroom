/**
 * Integration tests for src/agents/create-orchestrator.ts
 *
 * All external side-effects are mocked:
 *   - validateBotToken (HTTP call)
 *   - scaffoldAgent (large file-system operation)
 *   - installUnit / uninstallUnit / generateUnit / generateGatewayUnit / resolveGatewayUnitName
 *   - installScheduleTimers / enableScheduleTimers / daemonReload
 *   - startAuthSession / submitAuthCode
 *   - startAgent
 *   - writeAgentEntryToConfig / updateAgentExtendsInConfig / removeAgentFromConfig
 *   - loadConfig / resolveAgentsDir (config)
 *   - listAvailableProfiles
 *   - writeAgentEnv
 *   - rmSync / existsSync (fs, partial)
 *
 * The tests verify sequencing, rollback behaviour, fast-fail on bad token,
 * and the happy-path end-to-end for both createAgent + completeCreation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("../setup/telegram-api.js", () => ({
  validateBotToken: vi.fn(),
  validateBotTokenMatchesAgent: vi.fn(),
}));

vi.mock("./scaffold.js", () => ({
  scaffoldAgent: vi.fn().mockReturnValue({ agentDir: "/stub/agent", created: [], skipped: [] }),
}));

vi.mock("./systemd.js", () => ({
  generateUnit: vi.fn().mockReturnValue("[Unit]\nDescription=stub"),
  generateGatewayUnit: vi.fn().mockReturnValue("[Unit]\nDescription=stub-gw"),
  installUnit: vi.fn(),
  uninstallUnit: vi.fn(),
  installScheduleTimers: vi.fn(),
  enableScheduleTimers: vi.fn(),
  daemonReload: vi.fn(),
  resolveGatewayUnitName: vi.fn().mockReturnValue(null),
}));

vi.mock("../auth/manager.js", () => ({
  startAuthSession: vi.fn(),
  submitAuthCode: vi.fn(),
}));

vi.mock("./lifecycle.js", () => ({
  startAgent: vi.fn(),
}));

vi.mock("../cli/agent.js", () => ({
  writeAgentEntryToConfig: vi.fn(),
  updateAgentExtendsInConfig: vi.fn(),
  removeAgentFromConfig: vi.fn(),
  synthesizeTopicName: vi.fn((n: string) => n),
}));

vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn(),
  resolveAgentsDir: vi.fn(),
}));

vi.mock("./profiles.js", () => ({
  listAvailableProfiles: vi.fn(),
}));

vi.mock("../setup/onboarding.js", () => ({
  writeAgentEnv: vi.fn(),
}));

// ─── Imports (after mocks) ───────────────────────────────────────────────────

import { createAgent, completeCreation } from "./create-orchestrator.js";
import { validateBotTokenMatchesAgent } from "../setup/telegram-api.js";
import { scaffoldAgent } from "./scaffold.js";
import {
  generateUnit,
  installUnit,
  uninstallUnit,
  resolveGatewayUnitName,
} from "./systemd.js";
import { startAuthSession, submitAuthCode } from "../auth/manager.js";
import { startAgent } from "./lifecycle.js";
import {
  writeAgentEntryToConfig,
  updateAgentExtendsInConfig,
  removeAgentFromConfig,
} from "../cli/agent.js";
import { loadConfig, resolveAgentsDir } from "../config/loader.js";
import { listAvailableProfiles } from "./profiles.js";
import { writeAgentEnv } from "../setup/onboarding.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sr-orch-test-"));
  // create the directory so existsSync returns true
  mkdirSync(dir, { recursive: true });
  return dir;
}

function setupHappyConfig(agentsDir: string, name = "gymbro") {
  vi.mocked(loadConfig).mockReturnValue({
    agents: {
      [name]: {
        extends: "health-coach",
        topic_name: "Gymbro",
        channels: { telegram: { plugin: "switchroom" } },
        schedule: [],
      },
    },
    telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
  } as any);
  vi.mocked(resolveAgentsDir).mockReturnValue(agentsDir);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("createAgent", () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = makeAgentDir();
    vi.mocked(listAvailableProfiles).mockReturnValue(["health-coach", "coding"]);
    vi.mocked(validateBotTokenMatchesAgent).mockResolvedValue({
      id: 111111111,
      is_bot: true,
      first_name: "Gymbro",
      username: "gymbro_bot",
    });
    setupHappyConfig(agentsDir);
    vi.mocked(startAuthSession).mockReturnValue({
      sessionName: "switchroom-gymbro",
      loginUrl: "https://claude.ai/oauth?code_challenge=abc123",
      instructions: ["Open URL, paste code."],
    });
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("rejects an unknown profile before any disk writes", async () => {
    vi.mocked(listAvailableProfiles).mockReturnValue(["coding"]);
    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "123:abc",
        configPath: join(agentsDir, "switchroom.yaml"),
      }),
    ).rejects.toThrow(/Unknown profile/);
    // validateBotTokenMatchesAgent must NOT have been called (no disk write, no network call)
    expect(validateBotTokenMatchesAgent).not.toHaveBeenCalled();
  });

  it("rejects a bad bot token before any disk writes", async () => {
    vi.mocked(validateBotTokenMatchesAgent).mockRejectedValue(
      new Error("Invalid bot token: Unauthorized"),
    );
    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "bad-token",
        configPath: join(agentsDir, "switchroom.yaml"),
      }),
    ).rejects.toThrow(/Bot token validation failed/);
    // scaffold must NOT have been called
    expect(scaffoldAgent).not.toHaveBeenCalled();
  });

  it("writes agent entry to config when agent is not in yaml", async () => {
    vi.mocked(loadConfig).mockReturnValueOnce({
      agents: {},
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);
    setupHappyConfig(agentsDir); // second call (after writeAgentEntryToConfig)

    await createAgent({
      name: "gymbro",
      profile: "health-coach",
      telegramBotToken: "123:abc",
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(writeAgentEntryToConfig).toHaveBeenCalledWith(
      expect.stringContaining("switchroom.yaml"),
      "gymbro",
      "health-coach",
    );
  });

  it("does not write agent entry when agent already has matching profile", async () => {
    // loadConfig already returns the agent with matching extends
    await createAgent({
      name: "gymbro",
      profile: "health-coach",
      telegramBotToken: "123:abc",
      configPath: join(agentsDir, "switchroom.yaml"),
    });
    expect(writeAgentEntryToConfig).not.toHaveBeenCalled();
    expect(updateAgentExtendsInConfig).not.toHaveBeenCalled();
  });

  it("errors when agent exists with different profile", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      agents: {
        gymbro: {
          extends: "coding",
          topic_name: "Gymbro",
          schedule: [],
        },
      },
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);

    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "123:abc",
        configPath: join(agentsDir, "switchroom.yaml"),
      }),
    ).rejects.toThrow(/already configured with profile/);
  });

  it("calls scaffoldAgent, installUnit, and writeAgentEnv in sequence", async () => {
    const calls: string[] = [];
    vi.mocked(scaffoldAgent).mockImplementation(() => {
      calls.push("scaffold");
      return { agentDir: join(agentsDir, "gymbro"), created: [], skipped: [] } as any;
    });
    vi.mocked(installUnit).mockImplementation(() => { calls.push("installUnit"); });
    vi.mocked(writeAgentEnv).mockImplementation(() => { calls.push("writeAgentEnv"); });

    await createAgent({
      name: "gymbro",
      profile: "health-coach",
      telegramBotToken: "123:abc",
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(calls[0]).toBe("scaffold");
    expect(calls).toContain("installUnit");
    expect(calls).toContain("writeAgentEnv");
    // writeAgentEnv must come after installUnit
    expect(calls.indexOf("writeAgentEnv")).toBeGreaterThan(
      calls.indexOf("installUnit"),
    );
  });

  it("returns loginUrl and sessionName from startAuthSession", async () => {
    const result = await createAgent({
      name: "gymbro",
      profile: "health-coach",
      telegramBotToken: "123:abc",
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(result.loginUrl).toBe("https://claude.ai/oauth?code_challenge=abc123");
    expect(result.sessionName).toBe("switchroom-gymbro");
  });

  it("removes scaffold dir on auth failure when rollbackOnFail=true", async () => {
    // Create actual scaffold dir so rmSync has something to remove
    const agentDir = join(agentsDir, "gymbro");
    mkdirSync(agentDir, { recursive: true });

    vi.mocked(startAuthSession).mockImplementation(() => {
      throw new Error("tmux not found");
    });

    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "123:abc",
        configPath: join(agentsDir, "switchroom.yaml"),
        rollbackOnFail: true,
      }),
    ).rejects.toThrow("tmux not found");

    // The directory should have been removed
    const { existsSync } = await import("node:fs");
    expect(existsSync(agentDir)).toBe(false);
  });

  it("keeps scaffold dir on auth failure when rollbackOnFail=false (default)", async () => {
    const agentDir = join(agentsDir, "gymbro");
    mkdirSync(agentDir, { recursive: true });

    vi.mocked(startAuthSession).mockImplementation(() => {
      throw new Error("tmux not found");
    });

    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "123:abc",
        configPath: join(agentsDir, "switchroom.yaml"),
        rollbackOnFail: false,
      }),
    ).rejects.toThrow("tmux not found");

    const { existsSync } = await import("node:fs");
    expect(existsSync(agentDir)).toBe(true);
  });

  it("rolls back agentDir, systemd unit, and yaml entry on installUnit failure (rollbackOnFail=true)", async () => {
    const agentDir = join(agentsDir, "gymbro");
    mkdirSync(agentDir, { recursive: true });

    // Override: agent NOT yet in yaml, so orchestrator writes the entry (and
    // rollback must remove it).
    vi.mocked(loadConfig).mockReturnValue({
      agents: {},
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);
    vi.mocked(loadConfig).mockReturnValueOnce({
      agents: {},
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);
    vi.mocked(loadConfig).mockReturnValueOnce({
      agents: {
        gymbro: {
          extends: "health-coach",
          topic_name: "Gymbro",
          channels: { telegram: { plugin: "switchroom" } },
          schedule: [],
        },
      },
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);

    vi.mocked(installUnit).mockImplementation(() => {
      throw new Error("permission denied writing unit file");
    });

    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "123:abc",
        configPath: join(agentsDir, "switchroom.yaml"),
        rollbackOnFail: true,
      }),
    ).rejects.toThrow("permission denied writing unit file");

    // YAML entry should be rolled back
    expect(removeAgentFromConfig).toHaveBeenCalledWith(
      expect.stringContaining("switchroom.yaml"),
      "gymbro",
    );
    // agentDir should have been removed
    const { existsSync } = await import("node:fs");
    expect(existsSync(agentDir)).toBe(false);
  });

  it("rolls back agentDir, systemd unit, and yaml entry on writeAgentEnv failure (rollbackOnFail=true)", async () => {
    const agentDir = join(agentsDir, "gymbro");
    mkdirSync(agentDir, { recursive: true });

    // Override: agent NOT yet in yaml, so rollback has an entry to remove.
    vi.mocked(loadConfig).mockReturnValueOnce({
      agents: {},
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);
    vi.mocked(loadConfig).mockReturnValueOnce({
      agents: {
        gymbro: {
          extends: "health-coach",
          topic_name: "Gymbro",
          channels: { telegram: { plugin: "switchroom" } },
          schedule: [],
        },
      },
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);

    vi.mocked(writeAgentEnv).mockImplementation(() => {
      throw new Error("ENOENT: telegram dir missing");
    });

    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "123:abc",
        configPath: join(agentsDir, "switchroom.yaml"),
        rollbackOnFail: true,
      }),
    ).rejects.toThrow("ENOENT: telegram dir missing");

    // systemd unit should be uninstalled
    expect(uninstallUnit).toHaveBeenCalledWith("gymbro");
    // YAML entry should be rolled back
    expect(removeAgentFromConfig).toHaveBeenCalledWith(
      expect.stringContaining("switchroom.yaml"),
      "gymbro",
    );
    // agentDir should have been removed
    const { existsSync } = await import("node:fs");
    expect(existsSync(agentDir)).toBe(false);
  });

  it("rolls back agentDir and yaml entry on writeAgentEntryToConfig failure (rollbackOnFail=true)", async () => {
    // Simulate: agent not yet in yaml, writeAgentEntryToConfig throws part way
    // through (e.g. file system full after first read).
    // We model this by having loadConfig return empty agents (so the branch
    // tries to write) but writeAgentEntryToConfig throws synchronously.
    vi.mocked(loadConfig).mockReturnValueOnce({
      agents: {},
      telegram: { bot_token: "stub", forum_chat_id: "-100111111111" },
    } as any);
    vi.mocked(writeAgentEntryToConfig).mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });

    await expect(
      createAgent({
        name: "gymbro",
        profile: "health-coach",
        telegramBotToken: "123:abc",
        configPath: join(agentsDir, "switchroom.yaml"),
        rollbackOnFail: true,
      }),
    ).rejects.toThrow("ENOSPC: no space left on device");

    // writeAgentEntryToConfig threw before the rollback push — no partial
    // agentDir or systemd state should exist. Crucially, scaffoldAgent and
    // installUnit must NOT have been called at all.
    expect(scaffoldAgent).not.toHaveBeenCalled();
    expect(installUnit).not.toHaveBeenCalled();
  });
});

// ─── completeCreation ─────────────────────────────────────────────────────────

describe("completeCreation", () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = makeAgentDir();
    setupHappyConfig(agentsDir);
    // Create the agent dir so existsSync passes
    mkdirSync(join(agentsDir, "gymbro"), { recursive: true });
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("returns success outcome and starts agent on happy path", async () => {
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: true,
      tokenSaved: true,
      tokenPath: join(agentsDir, "gymbro", ".claude", ".oauth-token"),
      outcome: { kind: "success" },
      instructions: ["Saved token."],
    });
    vi.mocked(startAgent).mockReturnValue(undefined);

    const result = await completeCreation("gymbro", "browser-code-123", {
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(result.outcome.kind).toBe("success");
    expect(result.started).toBe(true);
    expect(startAgent).toHaveBeenCalledWith("gymbro");
  });

  it("returns failure outcome without starting agent on invalid-code", async () => {
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: false,
      tokenSaved: false,
      outcome: { kind: "invalid-code", paneTailText: "Invalid or expired code." },
      instructions: ["Code rejected."],
    });

    const result = await completeCreation("gymbro", "bad-code", {
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(result.outcome.kind).toBe("invalid-code");
    expect(result.started).toBe(false);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it("returns failure outcome on pane-not-ready", async () => {
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: false,
      tokenSaved: false,
      outcome: { kind: "pane-not-ready" },
      instructions: ["Pane not ready."],
    });

    const result = await completeCreation("gymbro", "code", {
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(result.outcome.kind).toBe("pane-not-ready");
    expect(result.started).toBe(false);
  });

  it("returns started=false with instructions when startAgent throws", async () => {
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: true,
      tokenSaved: true,
      outcome: { kind: "success" },
      instructions: ["Saved token."],
    });
    vi.mocked(startAgent).mockImplementation(() => {
      throw new Error("systemctl not found");
    });

    const result = await completeCreation("gymbro", "code", {
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(result.outcome.kind).toBe("success");
    expect(result.started).toBe(false);
    expect(result.instructions.some((l) => l.includes("switchroom agent start"))).toBe(true);
  });

  it("throws when agent dir does not exist", async () => {
    rmSync(join(agentsDir, "gymbro"), { recursive: true, force: true });

    await expect(
      completeCreation("gymbro", "code", {
        configPath: join(agentsDir, "switchroom.yaml"),
      }),
    ).rejects.toThrow(/Agent dir not found/);
  });

  it("passes pollTimeoutMs option through to submitAuthCode", async () => {
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: true,
      tokenSaved: true,
      outcome: { kind: "success" },
      instructions: [],
    });

    await completeCreation("gymbro", "code", {
      configPath: join(agentsDir, "switchroom.yaml"),
      pollTimeoutMs: 5000,
    });

    expect(submitAuthCode).toHaveBeenCalledWith(
      "gymbro",
      expect.any(String),
      "code",
      undefined,
      { pollTimeoutMs: 5000 },
    );
  });

  it("surfaces expired-code outcome with paneTailText correctly", async () => {
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: false,
      tokenSaved: false,
      outcome: {
        kind: "expired-code",
        paneTailText: "Error: The provided code has expired. Please try again.",
      },
      instructions: ["Code expired. Request a new one."],
    });

    const result = await completeCreation("gymbro", "stale-code", {
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(result.outcome.kind).toBe("expired-code");
    expect(result.outcome.paneTailText).toContain("expired");
    expect(result.started).toBe(false);
    expect(startAgent).not.toHaveBeenCalled();
    expect(result.instructions).toEqual(["Code expired. Request a new one."]);
  });

  it("surfaces timeout outcome when submitAuthCode returns undefined outcome (fallback path)", async () => {
    // The ?. ?? { kind: "timeout" } fallback fires when outcome is absent.
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: false,
      tokenSaved: false,
      outcome: undefined as any, // simulate missing outcome — triggers fallback
      instructions: ["Auth timed out."],
    });

    const result = await completeCreation("gymbro", "any-code", {
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(result.outcome.kind).toBe("timeout");
    expect(result.started).toBe(false);
    expect(startAgent).not.toHaveBeenCalled();
  });
});

// ─── End-to-end happy path (createAgent + completeCreation) ──────────────────

describe("createAgent + completeCreation end-to-end", () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = makeAgentDir();
    vi.mocked(listAvailableProfiles).mockReturnValue(["health-coach"]);
    vi.mocked(validateBotTokenMatchesAgent).mockResolvedValue({
      id: 111111111,
      is_bot: true,
      first_name: "Gymbro",
      username: "gymbro_bot",
    });
    setupHappyConfig(agentsDir);
    vi.mocked(startAuthSession).mockReturnValue({
      sessionName: "switchroom-gymbro",
      loginUrl: "https://claude.ai/oauth?code_challenge=xyz",
      instructions: [],
    });
    vi.mocked(submitAuthCode).mockReturnValue({
      completed: true,
      tokenSaved: true,
      outcome: { kind: "success" },
      instructions: ["Saved token."],
    });
    vi.mocked(startAgent).mockReturnValue(undefined);
  });

  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it("createAgent then completeCreation returns success and started=true", async () => {
    // Create the agent dir that scaffoldAgent would produce
    mkdirSync(join(agentsDir, "gymbro"), { recursive: true });

    const creation = await createAgent({
      name: "gymbro",
      profile: "health-coach",
      telegramBotToken: "123:abc",
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(creation.sessionName).toBe("switchroom-gymbro");
    expect(creation.loginUrl).toBeDefined();

    const completion = await completeCreation("gymbro", "BROWSERCODE", {
      configPath: join(agentsDir, "switchroom.yaml"),
    });

    expect(completion.outcome.kind).toBe("success");
    expect(completion.started).toBe(true);
  });
});
