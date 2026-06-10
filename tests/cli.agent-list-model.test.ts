/**
 * Contract pin: `switchroom agent list --json` rows carry a `model`
 * field (cascade-resolved, defaulting to the baked main model when the
 * config doesn't set one).
 *
 * The Telegram gateway's `/status` and `/model` surfaces read this
 * field off the JSON row (`buildAgentMetadata` / `getConfiguredModel`
 * in telegram-plugin/gateway/gateway.ts). Before this pin the field
 * didn't exist, so both surfaces silently rendered "default" on every
 * host — including fleets pinned to a specific model (PR #2259 review
 * finding). If this test fails, those surfaces regress silently.
 *
 * Follows the in-process commander pattern from
 * cli.agent-create-profile.test.ts; all paths point at an isolated
 * tmpdir — never the operator's ~/.switchroom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

// Disable PostHog so no network calls fire during tests.
vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
}));

import { Command } from "commander";
import { registerAgentCommand } from "../src/cli/agent.js";
import { SWITCHROOM_DEFAULT_MAIN_MODEL } from "../src/agents/scaffold.js";

function buildProgram(configPath: string): Command {
  const program = new Command()
    .name("switchroom")
    .option("-c, --config <path>", "Path to switchroom.yaml");
  registerAgentCommand(program);
  program.setOptionValue("config", configPath);
  return program;
}

async function runAgentListJson(
  configPath: string,
): Promise<{ agents: Array<{ name: string; model?: string | null }> }> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await buildProgram(configPath).parseAsync(
      ["agent", "list", "--json"],
      { from: "user" },
    );
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    return JSON.parse(out);
  } finally {
    logSpy.mockRestore();
  }
}

describe("agent list --json model field", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-agent-list-model-"));
    configPath = join(tmpDir, "switchroom.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits the configured per-agent model; unset falls back to the baked default", async () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        switchroom: { version: 1, agents_dir: join(tmpDir, "agents") },
        telegram: { bot_token: "123:ABC", forum_chat_id: "-100123" },
        agents: {
          pinned: { topic_name: "Pinned", model: "claude-opus-4-8" },
          unpinned: { topic_name: "Unpinned" },
        },
      }),
      "utf-8",
    );
    const data = await runAgentListJson(configPath);
    const byName = Object.fromEntries(data.agents.map((a) => [a.name, a]));
    expect(byName.pinned?.model).toBe("claude-opus-4-8");
    // Unset cascades to the baked default — the same value scaffold
    // writes into settings.json / --model, so the surface is truthful.
    expect(byName.unpinned?.model).toBe(SWITCHROOM_DEFAULT_MAIN_MODEL);
  });

  it("resolves model through the defaults cascade", async () => {
    writeFileSync(
      configPath,
      YAML.stringify({
        switchroom: { version: 1, agents_dir: join(tmpDir, "agents") },
        telegram: { bot_token: "123:ABC", forum_chat_id: "-100123" },
        defaults: { model: "claude-haiku-4-5-20251001" },
        agents: { inheriting: { topic_name: "Inheriting" } },
      }),
      "utf-8",
    );
    const data = await runAgentListJson(configPath);
    expect(data.agents[0]?.model).toBe("claude-haiku-4-5-20251001");
  });
});
