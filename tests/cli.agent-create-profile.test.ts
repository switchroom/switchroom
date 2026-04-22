import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

// Mock every side-effect-heavy dependency so we can exercise the
// `agent create <name> --profile <profile>` command without shelling
// out to systemctl or writing real files into ~/.switchroom/agents.
// Call signatures are captured via vi.fn() so assertions can verify
// whether scaffolding ran at all for a given branch.
//
// vi.hoisted is required because vi.mock factories are hoisted above
// module-level `const` declarations — any symbol they close over has
// to come from vi.hoisted for the TDZ dance to work.
const mocks = vi.hoisted(() => ({
  scaffold: vi.fn(),
  reconcile: vi.fn(),
  generateUnit: vi.fn(() => "UNIT_CONTENT"),
  generateGatewayUnit: vi.fn(() => "GW_UNIT_CONTENT"),
  installUnit: vi.fn(),
  uninstallUnit: vi.fn(),
  installScheduleTimers: vi.fn(),
  enableScheduleTimers: vi.fn(),
  daemonReload: vi.fn(),
  resolveGatewayUnitName: vi.fn(() => null),
}));

vi.mock("../src/agents/scaffold.js", () => ({
  scaffoldAgent: mocks.scaffold,
  reconcileAgent: mocks.reconcile,
}));

vi.mock("../src/agents/systemd.js", () => ({
  generateUnit: mocks.generateUnit,
  generateGatewayUnit: mocks.generateGatewayUnit,
  installUnit: mocks.installUnit,
  uninstallUnit: mocks.uninstallUnit,
  installScheduleTimers: mocks.installScheduleTimers,
  enableScheduleTimers: mocks.enableScheduleTimers,
  daemonReload: mocks.daemonReload,
  resolveGatewayUnitName: mocks.resolveGatewayUnitName,
}));

// Disable PostHog so no network calls fire during tests.
vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
}));

import { Command } from "commander";
import {
  registerAgentCommand,
  writeAgentEntryToConfig,
  updateAgentExtendsInConfig,
  synthesizeTopicName,
} from "../src/cli/agent.js";
import { listAvailableProfiles } from "../src/agents/profiles.js";

/**
 * Minimal config scaffold. Points agents_dir at a temp dir so the
 * code paths that compute agent paths don't blow up, even though the
 * actual scaffold step is mocked.
 */
function makeBaseConfig(agentsDir: string) {
  return {
    switchroom: { version: 1, agents_dir: agentsDir },
    telegram: { bot_token: "123:ABC", forum_chat_id: "-100123" },
    agents: {} as Record<string, unknown>,
  };
}

function writeConfig(path: string, obj: unknown): void {
  writeFileSync(path, YAML.stringify(obj), "utf-8");
}

/**
 * Build a commander program with only the `agent` subcommand
 * registered, targeting the given config path.
 */
function buildProgram(configPath: string): Command {
  const program = new Command()
    .name("switchroom")
    .option("-c, --config <path>", "Path to switchroom.yaml");
  registerAgentCommand(program);
  // Inject --config explicitly as if the user passed it.
  program.setOptionValue("config", configPath);
  return program;
}

describe("listAvailableProfiles", () => {
  it("includes bundled profiles and skips _base", () => {
    const profiles = listAvailableProfiles();
    // Framework-internal _base must never be offered to users.
    expect(profiles).not.toContain("_base");
    // Bundled set on disk today — if one of these disappears, the
    // README needs to change too.
    expect(profiles).toContain("default");
    expect(profiles).toContain("health-coach");
    expect(profiles).toContain("coding");
    expect(profiles).toContain("executive-assistant");
  });
});

describe("synthesizeTopicName", () => {
  it("title-cases hyphenated and underscored names", () => {
    expect(synthesizeTopicName("health-coach")).toBe("Health Coach");
    expect(synthesizeTopicName("exec_assistant")).toBe("Exec Assistant");
    expect(synthesizeTopicName("coach")).toBe("Coach");
  });
});

describe("writeAgentEntryToConfig + updateAgentExtendsInConfig", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-agent-create-"));
    configPath = join(tmpDir, "switchroom.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a new agent entry with extends + topic_name", () => {
    writeConfig(configPath, makeBaseConfig(join(tmpDir, "agents")));
    writeAgentEntryToConfig(configPath, "coach", "health-coach");

    const reloaded = YAML.parse(readFileSync(configPath, "utf-8"));
    expect(reloaded.agents.coach).toBeDefined();
    expect(reloaded.agents.coach.extends).toBe("health-coach");
    expect(reloaded.agents.coach.topic_name).toBe("Coach");
  });

  it("refuses to overwrite an existing agent entry", () => {
    const cfg = makeBaseConfig(join(tmpDir, "agents"));
    cfg.agents = { coach: { extends: "default", topic_name: "Coach" } };
    writeConfig(configPath, cfg);

    expect(() =>
      writeAgentEntryToConfig(configPath, "coach", "health-coach"),
    ).toThrow(/already exists/);
  });

  it("updateAgentExtendsInConfig patches an existing entry without extends", () => {
    const cfg = makeBaseConfig(join(tmpDir, "agents"));
    cfg.agents = { coach: { topic_name: "Coach" } };
    writeConfig(configPath, cfg);

    updateAgentExtendsInConfig(configPath, "coach", "health-coach");

    const reloaded = YAML.parse(readFileSync(configPath, "utf-8"));
    expect(reloaded.agents.coach.extends).toBe("health-coach");
    expect(reloaded.agents.coach.topic_name).toBe("Coach");
  });
});

describe("agent create --profile (command wiring)", () => {
  let tmpDir: string;
  let configPath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-agent-create-cmd-"));
    configPath = join(tmpDir, "switchroom.yaml");
    mocks.scaffold.mockReset();
    mocks.reconcile.mockReset();
    mocks.installUnit.mockReset();
    mocks.installScheduleTimers.mockReset();
    mocks.enableScheduleTimers.mockReset();
    mocks.daemonReload.mockReset();

    // process.exit throws so we can assert on it without the test
    // process actually exiting.
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null | undefined) => {
        throw new Error(`process.exit(${code})`);
      }) as unknown as ReturnType<typeof vi.spyOn>;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("creates a new yaml entry when --profile is given for an unknown agent", async () => {
    writeConfig(configPath, makeBaseConfig(join(tmpDir, "agents")));
    const program = buildProgram(configPath);

    await program.parseAsync(
      ["agent", "create", "smoketest", "--profile", "health-coach"],
      { from: "user" },
    );

    const reloaded = YAML.parse(readFileSync(configPath, "utf-8"));
    expect(reloaded.agents.smoketest).toBeDefined();
    expect(reloaded.agents.smoketest.extends).toBe("health-coach");
    expect(mocks.scaffold).toHaveBeenCalledOnce();
    expect(mocks.scaffold.mock.calls[0][0]).toBe("smoketest");
  });

  it("errors with the valid profile list when --profile is bogus", async () => {
    writeConfig(configPath, makeBaseConfig(join(tmpDir, "agents")));
    const program = buildProgram(configPath);

    await expect(
      program.parseAsync(
        ["agent", "create", "smoketest", "--profile", "bogus-profile"],
        { from: "user" },
      ),
    ).rejects.toThrow(/process\.exit\(1\)/);

    // The error output should list the real bundled profiles so the
    // user can fix their invocation on the spot.
    const allErrors = errSpy.mock.calls.flat().join("\n");
    expect(allErrors).toContain("Unknown profile");
    expect(allErrors).toContain("health-coach");
    expect(mocks.scaffold).not.toHaveBeenCalled();
  });

  it("proceeds silently when --profile matches the existing extends", async () => {
    const cfg = makeBaseConfig(join(tmpDir, "agents"));
    cfg.agents = {
      coach: { extends: "health-coach", topic_name: "Coach" },
    };
    writeConfig(configPath, cfg);
    const program = buildProgram(configPath);

    await program.parseAsync(
      ["agent", "create", "coach", "--profile", "health-coach"],
      { from: "user" },
    );

    expect(mocks.scaffold).toHaveBeenCalledOnce();
    const allErrors = errSpy.mock.calls.flat().join("\n");
    expect(allErrors).not.toContain("already configured");
  });

  it("errors when --profile conflicts with the existing extends", async () => {
    const cfg = makeBaseConfig(join(tmpDir, "agents"));
    cfg.agents = {
      coach: { extends: "health-coach", topic_name: "Coach" },
    };
    writeConfig(configPath, cfg);
    const program = buildProgram(configPath);

    await expect(
      program.parseAsync(
        ["agent", "create", "coach", "--profile", "coding"],
        { from: "user" },
      ),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const allErrors = errSpy.mock.calls.flat().join("\n");
    expect(allErrors).toMatch(/already configured with profile "health-coach"/);
    expect(mocks.scaffold).not.toHaveBeenCalled();
  });

  it("keeps the old 'not defined' error when neither yaml entry nor --profile is present", async () => {
    writeConfig(configPath, makeBaseConfig(join(tmpDir, "agents")));
    const program = buildProgram(configPath);

    await expect(
      program.parseAsync(
        ["agent", "create", "mystery-agent"],
        { from: "user" },
      ),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const allErrors = errSpy.mock.calls.flat().join("\n");
    expect(allErrors).toContain("not defined in switchroom.yaml");
    // The hint about --profile should be there so reviewers + users
    // have a path forward from the error without reading docs.
    expect(allErrors).toContain("--profile");
    expect(mocks.scaffold).not.toHaveBeenCalled();
  });
});
