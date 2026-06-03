import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Regression guard for the start.sh env-fork landmine
 * (feedback_startsh_env_before_gateway_fork, same class as #1997 /
 * SWITCHROOM_HANDOFF_SHOW_LINE).
 *
 * The docker runtime forks the gateway daemon in start.sh's OUTER pass and
 * then re-execs into a tmux inner pass for claude. The gateway reads
 * channels.telegram.* knobs (SWITCHROOM_TG_*) from process.env at startup —
 * so those exports MUST appear before the gateway-fork line. Before the fix
 * they only rendered in the inner pass (after the fork), so the daemon never
 * saw them and every channels.telegram env knob silently defaulted on docker.
 */

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeSwitchroomConfig(agentName: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [agentName]: agentConfig },
  };
}

const GATEWAY_FORK = 'bun "$_gateway_bundle"';

describe("start.sh: gateway-consumed env exported before the gateway fork", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-gw-env-order-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function renderStartSh(): string {
    const config = {
      extends: "default",
      topic_name: "Test Topic",
      schedule: [],
      channels: {
        telegram: {
          clear_status_on_completion: true,
          stream_throttle_ms: 1234,
        },
      },
    } as AgentConfig;
    const sw = makeSwitchroomConfig("test-agent", config);
    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig, sw);
    return readFileSync(join(result.agentDir, "start.sh"), "utf-8");
  }

  it("hoists SWITCHROOM_TG_* exports AHEAD of the gateway fork (docker outer pass)", () => {
    const startSh = renderStartSh();
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    expect(forkIdx).toBeGreaterThan(-1);

    const clearIdx = startSh.indexOf("export SWITCHROOM_TG_CLEAR_STATUS_ON_COMPLETION=");
    const throttleIdx = startSh.indexOf("export SWITCHROOM_TG_STREAM_THROTTLE_MS=");
    expect(clearIdx).toBeGreaterThan(-1);
    expect(throttleIdx).toBeGreaterThan(-1);

    // The FIRST occurrence (outer-pass hoist) must precede the fork, or the
    // gateway daemon never sees the var.
    expect(clearIdx).toBeLessThan(forkIdx);
    expect(throttleIdx).toBeLessThan(forkIdx);
  });

  it("still re-exports the same vars in the inner pass (after the fork) for claude", () => {
    const startSh = renderStartSh();
    const forkIdx = startSh.indexOf(GATEWAY_FORK);

    const first = startSh.indexOf("export SWITCHROOM_TG_CLEAR_STATUS_ON_COMPLETION=");
    const second = startSh.indexOf(
      "export SWITCHROOM_TG_CLEAR_STATUS_ON_COMPLETION=",
      first + 1,
    );
    // Hoisted copy before the fork (gateway), re-exported copy after it (claude
    // — tmux does not reliably propagate arbitrary env across the re-exec).
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(forkIdx);
    expect(second).toBeGreaterThan(forkIdx);
  });
});
