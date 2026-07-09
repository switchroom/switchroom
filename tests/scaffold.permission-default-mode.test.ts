import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  AgentDefaults,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

// Change B: acceptEdits is the switchroom BUILT-IN default for the
// settings.json `permissions.defaultMode` of EVERY agent — no yaml needed —
// overridable per-agent via `permission_mode` OR fleet-wide via
// `defaults.permission_mode`. Precedence (highest wins):
//   1. agentConfig.permission_mode
//   2. defaults.permission_mode
//   3. "acceptEdits"
// This is deliberately DECOUPLED from the `tools.allow: [all]` wildcard — the
// wildcard still drives allow-list expansion, but no longer gates defaultMode.

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
  name: string,
  agentConfig: AgentConfig,
  defaults?: AgentDefaults,
): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
    telegram: telegramConfig,
    ...(defaults ? { defaults } : {}),
    agents: { [name]: agentConfig },
  } as SwitchroomConfig;
}

function readDefaultMode(agentDir: string): string | undefined {
  const settings = JSON.parse(
    readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"),
  );
  return settings.permissions?.defaultMode;
}

describe("scaffold: permissions.defaultMode precedence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-defaultmode-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. The core new behavior: a plain agent (no permission_mode, no wildcard,
  //    no fleet default) now gets acceptEdits. Previously it got NO defaultMode.
  it("no override + no wildcard + no fleet default → acceptEdits (built-in)", () => {
    const config = makeAgentConfig({ tools: { allow: ["Read", "Grep"], deny: [] } });
    const switchroomConfig = makeSwitchroomConfig("plain", config);
    const result = scaffoldAgent("plain", config, tmpDir, telegramConfig, switchroomConfig);
    expect(readDefaultMode(result.agentDir)).toBe("acceptEdits");
  });

  // 2. The [all] wildcard, no override → still acceptEdits (unchanged outcome,
  //    but now via the wildcard-independent code path).
  it("[all] wildcard + no override → acceptEdits", () => {
    const config = makeAgentConfig({ tools: { allow: ["all"], deny: [] } });
    const switchroomConfig = makeSwitchroomConfig("wild", config);
    const result = scaffoldAgent("wild", config, tmpDir, telegramConfig, switchroomConfig);
    expect(readDefaultMode(result.agentDir)).toBe("acceptEdits");
  });

  // 3. Per-agent override wins EVEN over the wildcard.
  it("[all] wildcard + permission_mode: default → default (override beats wildcard)", () => {
    const config = makeAgentConfig({
      tools: { allow: ["all"], deny: [] },
      permission_mode: "default",
    });
    const switchroomConfig = makeSwitchroomConfig("wild-manual", config);
    const result = scaffoldAgent("wild-manual", config, tmpDir, telegramConfig, switchroomConfig);
    expect(readDefaultMode(result.agentDir)).toBe("default");
  });

  // 4. Fleet-wide default applies when the agent has no per-agent override.
  it("defaults.permission_mode: plan + no per-agent override → plan", () => {
    const config = makeAgentConfig({ tools: { allow: ["Read"], deny: [] } });
    const switchroomConfig = makeSwitchroomConfig("fleet-plan", config, {
      permission_mode: "plan",
    } as AgentDefaults);
    const result = scaffoldAgent("fleet-plan", config, tmpDir, telegramConfig, switchroomConfig);
    expect(readDefaultMode(result.agentDir)).toBe("plan");
  });

  // 5. Per-agent override beats the fleet default.
  it("defaults.permission_mode: plan + agent permission_mode: acceptEdits → acceptEdits", () => {
    const config = makeAgentConfig({
      tools: { allow: ["Read"], deny: [] },
      permission_mode: "acceptEdits",
    });
    const switchroomConfig = makeSwitchroomConfig("fleet-vs-agent", config, {
      permission_mode: "plan",
    } as AgentDefaults);
    const result = scaffoldAgent(
      "fleet-vs-agent",
      config,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );
    expect(readDefaultMode(result.agentDir)).toBe("acceptEdits");
  });

  // 6. The reconcile path must produce the SAME defaultMode as the scaffold
  //    path for the same config — guard against the two code paths diverging.
  it("reconcile path produces the same defaultMode as scaffold", () => {
    const cases: Array<{ name: string; config: AgentConfig; defaults?: AgentDefaults }> = [
      { name: "rc-plain", config: makeAgentConfig({ tools: { allow: ["Read"], deny: [] } }) },
      { name: "rc-wild", config: makeAgentConfig({ tools: { allow: ["all"], deny: [] } }) },
      {
        name: "rc-agent-override",
        config: makeAgentConfig({ tools: { allow: ["all"], deny: [] }, permission_mode: "plan" }),
      },
      {
        name: "rc-fleet",
        config: makeAgentConfig({ tools: { allow: ["Read"], deny: [] } }),
        defaults: { permission_mode: "default" } as AgentDefaults,
      },
    ];
    for (const { name, config, defaults } of cases) {
      const switchroomConfig = makeSwitchroomConfig(name, config, defaults);
      const result = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
      const scaffoldMode = readDefaultMode(result.agentDir);
      reconcileAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
      const reconcileMode = readDefaultMode(join(tmpDir, name));
      expect(reconcileMode, `reconcile diverged from scaffold for ${name}`).toBe(scaffoldMode);
    }
  });

  // 7. A schema-valid permission_mode with no settings.json defaultMode
  //    equivalent (auto/dontAsk) degrades to the built-in default WITH a
  //    warning — the --permission-mode CLI flag still carries the raw value.
  it("permission_mode: auto (no defaultMode equivalent) → warn + acceptEdits fallback", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = makeAgentConfig({
        tools: { allow: ["Read"], deny: [] },
        permission_mode: "auto",
      });
      const switchroomConfig = makeSwitchroomConfig("auto-agent", config);
      const result = scaffoldAgent("auto-agent", config, tmpDir, telegramConfig, switchroomConfig);
      expect(readDefaultMode(result.agentDir)).toBe("acceptEdits");
      expect(warnSpy).toHaveBeenCalled();
      const msg = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("auto");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
