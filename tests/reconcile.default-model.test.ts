/**
 * Regression test for #472 finding #16.
 *
 * #470 changed the semantics of `reconcileAgent` for agents whose
 * switchroom.yaml has no `model:` field: the new behavior WRITES the
 * switchroom default (`claude-sonnet-4-6`) into `.claude/settings.json`,
 * rather than DELETING the field as the old code did. The change is
 * load-bearing — without it, agents fall back to whichever model claude
 * picks on its own, which on the day of #470 was a model that broke the
 * switchroom UX entirely.
 *
 * No test pinned this. A future PR could revert it without any failure
 * surfacing in CI. Add the missing pin so the next reverter has to
 * justify the change explicitly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileAgent,
  scaffoldAgent,
  SWITCHROOM_DEFAULT_MAIN_MODEL,
} from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

const switchroomConfig: SwitchroomConfig = {
  agents: {},
  telegram: telegramConfig,
  defaults: {},
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function readSettings(agentDir: string): Record<string, unknown> {
  const settingsPath = join(agentDir, ".claude", "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
}

describe("reconcileAgent — default model (#472 #16)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-reconcile-default-model-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the switchroom default model when agentConfig.model is undefined", () => {
    const config = makeAgentConfig(); // no model field
    const { agentDir } = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

    reconcileAgent(
      "test-agent",
      config,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const settings = readSettings(agentDir);
    expect(settings.model).toBe(SWITCHROOM_DEFAULT_MAIN_MODEL);
    expect(settings.model).toBe("claude-sonnet-4-6");
  });

  it("preserves an explicit model from agentConfig", () => {
    const config = makeAgentConfig({ model: "claude-haiku-4-5-20251001" });
    const { agentDir } = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

    reconcileAgent(
      "test-agent",
      config,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const settings = readSettings(agentDir);
    expect(settings.model).toBe("claude-haiku-4-5-20251001");
  });

  it("OVERWRITES a stale settings.model with the default when config drops the field", () => {
    // Initial scaffold with explicit override.
    const initial = makeAgentConfig({ model: "claude-opus-4-7" });
    const { agentDir } = scaffoldAgent("test-agent", initial, tmpDir, telegramConfig);

    // Drop the override — config no longer carries `model`.
    const reconciled = makeAgentConfig();

    reconcileAgent(
      "test-agent",
      reconciled,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const settings = readSettings(agentDir);
    // Pre-#470 behavior: the stale "claude-opus-4-7" stayed because
    // reconcile DELETED the field rather than writing the default.
    // Post-#470: the default is written, replacing the stale value.
    expect(settings.model).toBe(SWITCHROOM_DEFAULT_MAIN_MODEL);
  });

  it("respects settings_raw escape hatch even with default model", () => {
    // Operator overrides via settings_raw — that path should still win.
    const config = makeAgentConfig({
      settings_raw: { model: "claude-haiku-4-5-20251001" },
    });
    const { agentDir } = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);

    reconcileAgent(
      "test-agent",
      config,
      tmpDir,
      telegramConfig,
      switchroomConfig,
    );

    const settings = readSettings(agentDir);
    // settings_raw is applied AFTER the switchroom-owned default, so it
    // takes precedence — that's the design of the escape hatch.
    expect(settings.model).toBe("claude-haiku-4-5-20251001");
  });
});
