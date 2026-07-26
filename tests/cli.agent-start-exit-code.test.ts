/**
 * `switchroom agent start <name>` must report failure in its EXIT CODE.
 *
 * Setup-verification review H3: every realistic failure in this command —
 * an agent not defined in switchroom.yaml, a quarantined agent, preflight
 * errors, a `startAgent()` throw — printed red and then exited 0. Two
 * consequences:
 *
 *   1. `switchroom agent start x && <next step>` sailed on over a dead agent.
 *   2. `switchroom setup`'s start seam shells out to this command, so the
 *      only failure it could ever observe was ENOENT (no binary). Every
 *      real failure degraded into a container-never-came-up timeout with
 *      misleading `docker logs` guidance.
 *
 * These tests assert the OUTCOME (exit code), not that the code path ran.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  startAgent: vi.fn(),
}));

// The success path polls the agent's readiness for up to 30s against a
// container that does not exist here. Short-circuit it.
vi.mock("../src/agents/status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/status.js")>();
  return {
    ...actual,
    waitForAgentReady: vi.fn(async () => ({
      ready: true,
      elapsedMs: 0,
      notReady: [],
    })),
  };
});

// The lifecycle layer shells out to docker; stub the one verb we drive.
vi.mock("../src/agents/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agents/lifecycle.js")>();
  return { ...actual, startAgent: mocks.startAgent };
});

vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
}));

import { Command } from "commander";
import { registerAgentCommand } from "../src/cli/agent.js";

function buildProgram(configPath: string): Command {
  const program = new Command()
    .name("switchroom")
    .option("-c, --config <path>", "Path to switchroom.yaml");
  registerAgentCommand(program);
  program.setOptionValue("config", configPath);
  return program;
}

describe("switchroom agent start — exit code (review H3)", () => {
  let tmpDir: string;
  let configPath: string;
  let priorExitCode: number | string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sr-agent-start-"));
    mkdirSync(join(tmpDir, "agents"), { recursive: true });
    configPath = join(tmpDir, "switchroom.yaml");
    writeFileSync(
      configPath,
      [
        "switchroom:",
        "  version: 1",
        `  agents_dir: ${join(tmpDir, "agents")}`,
        "telegram:",
        '  bot_token: "test:token"',
        '  forum_chat_id: "0"',
        "agents:",
        "  alpha:",
        "    topic_name: alpha",
        "",
      ].join("\n"),
    );
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.startAgent.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = priorExitCode;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits NON-ZERO for an agent that is not in switchroom.yaml", async () => {
    await buildProgram(configPath).parseAsync(["agent", "start", "ghost"], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
  });

  it("exits NON-ZERO when preflight fails (unscaffolded agent dir)", async () => {
    // `agents/alpha` has no scaffold at all, so preflightCheck reports
    // errors and the command `continue`s — previously exit 0.
    await buildProgram(configPath).parseAsync(["agent", "start", "alpha"], {
      from: "user",
    });
    expect(process.exitCode).toBe(1);
    expect(mocks.startAgent).not.toHaveBeenCalled();
  });

  it("exits NON-ZERO when startAgent() throws", async () => {
    mocks.startAgent.mockImplementation(() => {
      throw new Error("no configuration file provided: not found");
    });
    await buildProgram(configPath).parseAsync(
      ["agent", "start", "alpha", "--force"],
      { from: "user" },
    );
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code alone on a successful start", async () => {
    mocks.startAgent.mockImplementation(() => {});
    await buildProgram(configPath).parseAsync(
      ["agent", "start", "alpha", "--force"],
      { from: "user" },
    );
    expect(process.exitCode).toBeUndefined();
  });
});
