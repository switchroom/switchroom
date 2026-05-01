/**
 * Tests for src/agents/add-orchestrator.ts (epic #543, workstream 1).
 *
 * Covers:
 *   - Happy path: scaffold → auth → pair DM → access.json → preflight ok.
 *   - --allow-from short-circuits the pairing poll.
 *   - Pair timeout produces a clear, actionable error.
 *   - OAuth completion failure aborts loudly.
 *   - runFinalPreflight reports per-check status correctly.
 *
 * External I/O is mocked end-to-end:
 *   - createAgent + completeCreation (the underlying orchestrator)
 *   - writeAccessJson (no real disk writes for access.json)
 *   - pollForDmStart (injected via opts.pollForPair)
 *   - systemctl probe (injected via opts.isUnitActive)
 *   - filesystem reads inside runFinalPreflight (real fs against a tmpdir)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./create-orchestrator.js", () => ({
  createAgent: vi.fn(),
  completeCreation: vi.fn(),
}));

vi.mock("../setup/onboarding.js", () => ({
  writeAccessJson: vi.fn((agentDir: string, userId: string) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = join(agentDir, "telegram");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      join(dir, "access.json"),
      JSON.stringify({ allowFrom: [userId], groups: {} }, null, 2) + "\n",
    );
  }),
}));

vi.mock("../setup/telegram-api.js", () => ({
  pollForDmStart: vi.fn(),
}));

import { addAgent, runFinalPreflight } from "./add-orchestrator.js";
import { createAgent, completeCreation } from "./create-orchestrator.js";

function setupAgentDir(): { agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-add-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "telegram"), { recursive: true });
  // pretend the bot token landed
  writeFileSync(join(agentDir, "telegram", ".env"), "TELEGRAM_BOT_TOKEN=fake:token\n");
  // stub a unit file under a fake $HOME so runFinalPreflight finds it
  const fakeHome = mkdtempSync(join(tmpdir(), "agent-add-home-"));
  process.env.HOME = fakeHome;
  const unitDir = join(fakeHome, ".config/systemd/user");
  mkdirSync(unitDir, { recursive: true });
  return { agentDir };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addAgent", () => {
  it("happy path: scaffold → auth → pair → access.json → preflight ok", async () => {
    const { agentDir } = setupAgentDir();
    // unit with autoaccept wrapper present
    const unitPath = join(
      process.env.HOME!,
      ".config/systemd/user/switchroom-bot.service",
    );
    writeFileSync(unitPath, "[Unit]\nDescription=stub\nExecStart=expect autoaccept\n");

    (createAgent as any).mockResolvedValue({
      loginUrl: "https://login.example/x",
      sessionName: "auth-bot-1",
      agentDir,
    });
    (completeCreation as any).mockResolvedValue({
      outcome: { kind: "success" },
      started: true,
      instructions: [],
    });

    const pollForPair = vi.fn().mockResolvedValue({
      userId: 12345,
      username: "ken",
      chatId: 12345,
    });
    const isUnitActive = vi.fn().mockReturnValue(true);

    const logs: string[] = [];
    const result = await addAgent({
      name: "bot",
      profile: "general",
      botToken: "fake:token",
      topology: "dm",
      readOAuthCode: async () => "browser-code",
      pollForPair,
      isUnitActive,
      log: (l) => logs.push(l),
    });

    expect(createAgent).toHaveBeenCalledOnce();
    expect(completeCreation).toHaveBeenCalledWith(
      "bot",
      "browser-code",
      expect.any(Object),
    );
    expect(pollForPair).toHaveBeenCalledOnce();
    expect(result.userId).toBe("12345");
    expect(result.preflightOk).toBe(true);
    expect(result.preflight.accessJsonAllowFrom.ok).toBe(true);
    expect(result.preflight.systemdActive.ok).toBe(true);
  });

  it("--allow-from short-circuits the pairing poll", async () => {
    const { agentDir } = setupAgentDir();
    writeFileSync(
      join(process.env.HOME!, ".config/systemd/user/switchroom-bot.service"),
      "[Unit]\nExecStart=/usr/bin/expect autoaccept\n",
    );

    (createAgent as any).mockResolvedValue({
      sessionName: "auth-1",
      agentDir,
      loginUrl: undefined,
    });
    (completeCreation as any).mockResolvedValue({
      outcome: { kind: "success" },
      started: true,
      instructions: [],
    });

    const pollForPair = vi.fn();
    const result = await addAgent({
      name: "bot",
      profile: "general",
      botToken: "fake:token",
      topology: "dm",
      allowFromUserId: "9999",
      readOAuthCode: async () => "code",
      pollForPair,
      isUnitActive: () => true,
      log: () => {},
    });

    expect(pollForPair).not.toHaveBeenCalled();
    expect(result.userId).toBe("9999");
    expect(result.preflight.accessJsonAllowFrom.ok).toBe(true);
  });

  it("pair timeout surfaces an actionable error", async () => {
    const { agentDir } = setupAgentDir();
    (createAgent as any).mockResolvedValue({ sessionName: "s", agentDir, loginUrl: undefined });
    (completeCreation as any).mockResolvedValue({
      outcome: { kind: "success" },
      started: true,
      instructions: [],
    });
    const pollForPair = vi.fn().mockRejectedValue(new Error("Timed out waiting for /start DM"));

    await expect(
      addAgent({
        name: "bot",
        profile: "general",
        botToken: "fake:token",
        topology: "dm",
        readOAuthCode: async () => "code",
        pollForPair,
        isUnitActive: () => true,
        pairTimeoutMs: 1000,
        log: () => {},
      }),
    ).rejects.toThrow(/Pairing timed out.*--allow-from/s);
  });

  it("OAuth completion failure aborts loudly", async () => {
    const { agentDir } = setupAgentDir();
    (createAgent as any).mockResolvedValue({ sessionName: "s", agentDir, loginUrl: undefined });
    (completeCreation as any).mockResolvedValue({
      outcome: { kind: "invalid_code" },
      started: false,
      instructions: [],
    });

    await expect(
      addAgent({
        name: "bot",
        profile: "general",
        botToken: "fake:token",
        topology: "dm",
        readOAuthCode: async () => "code",
        pollForPair: vi.fn(),
        isUnitActive: () => true,
        log: () => {},
      }),
    ).rejects.toThrow(/OAuth completion failed/);
  });

  it("readOAuthCode returning empty aborts", async () => {
    const { agentDir } = setupAgentDir();
    (createAgent as any).mockResolvedValue({ sessionName: "s", agentDir, loginUrl: undefined });

    await expect(
      addAgent({
        name: "bot",
        profile: "general",
        botToken: "fake:token",
        topology: "dm",
        readOAuthCode: async () => "",
        log: () => {},
      }),
    ).rejects.toThrow(/No OAuth code provided/);
  });
});

describe("runFinalPreflight", () => {
  it("flags missing systemd unit", () => {
    const { agentDir } = setupAgentDir();
    const report = runFinalPreflight({
      name: "doesnotexist",
      agentDir,
      expectedUserId: "1",
      isUnitActive: () => false,
    });
    expect(report.autoacceptWrapper.ok).toBe(false);
    expect(report.autoacceptWrapper.detail).toMatch(/systemd unit missing/);
  });

  it("flags missing TELEGRAM_BOT_TOKEN line in .env", () => {
    const { agentDir } = setupAgentDir();
    writeFileSync(join(agentDir, "telegram", ".env"), "# Set your bot token\n");
    writeFileSync(
      join(process.env.HOME!, ".config/systemd/user/switchroom-bot.service"),
      "[Unit]\nExecStart=expect ...\n",
    );
    const report = runFinalPreflight({
      name: "bot",
      agentDir,
      expectedUserId: "1",
      isUnitActive: () => true,
    });
    expect(report.botTokenPresent.ok).toBe(false);
  });

  it("flags allowFrom mismatch", () => {
    const { agentDir } = setupAgentDir();
    writeFileSync(
      join(process.env.HOME!, ".config/systemd/user/switchroom-bot.service"),
      "[Unit]\nExecStart=expect ...\n",
    );
    writeFileSync(
      join(agentDir, "telegram", "access.json"),
      JSON.stringify({ allowFrom: ["someone-else"] }),
    );
    const report = runFinalPreflight({
      name: "bot",
      agentDir,
      expectedUserId: "999",
      isUnitActive: () => true,
    });
    expect(report.accessJsonAllowFrom.ok).toBe(false);
    expect(report.accessJsonAllowFrom.detail).toMatch(/does not contain 999/);
  });

  it("returns ok when all four checks pass", () => {
    const { agentDir } = setupAgentDir();
    writeFileSync(
      join(process.env.HOME!, ".config/systemd/user/switchroom-bot.service"),
      "[Unit]\nExecStart=expect ...\n",
    );
    writeFileSync(
      join(agentDir, "telegram", "access.json"),
      JSON.stringify({ allowFrom: ["999"] }),
    );
    const report = runFinalPreflight({
      name: "bot",
      agentDir,
      expectedUserId: "999",
      isUnitActive: () => true,
    });
    expect(report.autoacceptWrapper.ok).toBe(true);
    expect(report.botTokenPresent.ok).toBe(true);
    expect(report.systemdActive.ok).toBe(true);
    expect(report.accessJsonAllowFrom.ok).toBe(true);
  });

  it("flags inactive systemd unit with actionable detail", () => {
    const { agentDir } = setupAgentDir();
    writeFileSync(
      join(process.env.HOME!, ".config/systemd/user/switchroom-bot.service"),
      "[Unit]\nExecStart=expect ...\n",
    );
    writeFileSync(
      join(agentDir, "telegram", "access.json"),
      JSON.stringify({ allowFrom: ["1"] }),
    );
    const report = runFinalPreflight({
      name: "bot",
      agentDir,
      expectedUserId: "1",
      isUnitActive: () => false,
    });
    expect(report.systemdActive.ok).toBe(false);
    expect(report.systemdActive.detail).toMatch(/switchroom agent start bot/);
  });
});
