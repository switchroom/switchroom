import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import { generateUnit } from "../src/agents/systemd.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeSwitchroomConfig(agentName: string, agent: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    defaults: {},
    agents: { [agentName]: agent },
  } as unknown as SwitchroomConfig;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

interface HookGroup {
  hooks: { type: string; command: string; timeout?: number }[];
}

describe("timezone hook integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-tz-integration-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wires timezone-hook.sh into settings.json UserPromptSubmit", () => {
    const agent = makeAgent();
    const swConfig = makeSwitchroomConfig("tz-agent", agent);
    const result = scaffoldAgent("tz-agent", agent, tmpDir, telegramConfig, swConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );

    const groups: HookGroup[] = settings.hooks?.UserPromptSubmit ?? [];
    const hasTimezoneHook = groups.some((g) =>
      g.hooks?.some((h) => h.command?.includes("timezone-hook.sh")),
    );
    expect(hasTimezoneHook).toBe(true);
  });

  it("ships the timezone-hook.sh script and marks it executable", () => {
    const repoRoot = resolve(import.meta.dirname, "..");
    const scriptPath = join(repoRoot, "bin", "timezone-hook.sh");
    expect(existsSync(scriptPath)).toBe(true);

    // S_IXUSR bit — 0o100 — confirms the user-exec bit is set. chmod +x
    // sets user/group/other exec, so this also implicitly covers the
    // `git update-index --chmod` case.
    const mode = statSync(scriptPath).mode;
    expect(mode & 0o100).toBe(0o100);
  });

  it("places timezone hook AFTER the workspace-dynamic hook", () => {
    // Ordering matters because additionalContext from multiple hooks is
    // concatenated in declaration order. The local-time hint renders last
    // so it sits adjacent to the user prompt where the LLM is most likely
    // to reference it.
    const agent = makeAgent();
    const swConfig = makeSwitchroomConfig("tz-agent", agent);
    const result = scaffoldAgent("tz-agent", agent, tmpDir, telegramConfig, swConfig);
    const settings = JSON.parse(
      readFileSync(join(result.agentDir, ".claude", "settings.json"), "utf-8"),
    );
    const groups: HookGroup[] = settings.hooks?.UserPromptSubmit ?? [];
    const commands = groups.flatMap((g) => g.hooks?.map((h) => h.command ?? "") ?? []);
    const dynamicIdx = commands.findIndex((c) => c.includes("workspace-dynamic-hook.sh"));
    const tzIdx = commands.findIndex((c) => c.includes("timezone-hook.sh"));
    expect(dynamicIdx).toBeGreaterThan(-1);
    expect(tzIdx).toBeGreaterThan(dynamicIdx);
  });
});

describe("systemd unit includes timezone env", () => {
  it("emits TZ= and SWITCHROOM_TIMEZONE= when timezone is provided", () => {
    const unit = generateUnit(
      "coach",
      "/tmp/agents/coach",
      false,
      undefined,
      "Australia/Melbourne",
    );
    expect(unit).toContain("Environment=TZ=Australia/Melbourne");
    expect(unit).toContain("Environment=SWITCHROOM_TIMEZONE=Australia/Melbourne");
  });

  it("omits timezone env entirely when no zone is provided", () => {
    const unit = generateUnit("coach", "/tmp/agents/coach");
    expect(unit).not.toContain("Environment=TZ=");
    expect(unit).not.toContain("SWITCHROOM_TIMEZONE=");
  });
});
