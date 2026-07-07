import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Regression guard for the LiteLLM ANTHROPIC_CUSTOM_HEADERS outer-pass hoist.
 *
 * The gateway daemon forks in start.sh's OUTER pass (the !SWITCHROOM_DOCKER_TMUX_INNER
 * block). The LiteLLM virtual-key fetch that exports ANTHROPIC_CUSTOM_HEADERS was
 * previously only in the INNER block (after re-exec into tmux). This meant the
 * gateway process launched WITHOUT ANTHROPIC_CUSTOM_HEADERS, so
 * discoverSrModels() (which checks both ANTHROPIC_BASE_URL AND
 * ANTHROPIC_CUSTOM_HEADERS) returned [] and /model never showed OpenRouter entries.
 *
 * Fix: the key fetch block is now also rendered in the OUTER section, after the
 * user-env hoist but BEFORE the `_switchroom_supervise gateway` call.
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

function renderStartSh(name = "ll-agent"): string {
  const config: AgentConfig = {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
  } as AgentConfig;
  const sw = makeSwitchroomConfig(name, config);
  const res = scaffoldAgent(name, config, tmpDir, telegramConfig, sw);
  return readFileSync(join(res.agentDir, "start.sh"), "utf-8");
}

let tmpDir: string;

describe("start.sh: LiteLLM ANTHROPIC_CUSTOM_HEADERS hoisted before gateway fork", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-litellm-gw-outer-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const GATEWAY_FORK = 'bun "$_gateway_bundle"';
  const LITELLM_GATE = "litellm(outer)";
  const CUSTOM_HEADERS_EXPORT = "export ANTHROPIC_CUSTOM_HEADERS=";

  it("renders the outer LiteLLM block before the gateway fork", () => {
    const startSh = renderStartSh();

    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    expect(forkIdx, "gateway fork line not found").toBeGreaterThan(-1);

    const outerBlockIdx = startSh.indexOf(LITELLM_GATE);
    expect(outerBlockIdx, "outer LiteLLM block marker not found").toBeGreaterThan(-1);

    // The outer block must precede the gateway fork — that's the whole point.
    expect(outerBlockIdx).toBeLessThan(forkIdx);
  });

  it("outer block is guarded on SWITCHROOM_LITELLM and ANTHROPIC_CUSTOM_HEADERS not set", () => {
    const startSh = renderStartSh();

    // Must check SWITCHROOM_LITELLM (same gate as inner block).
    expect(startSh).toContain('if [ -n "${SWITCHROOM_LITELLM:-}" ] && [ -z "$ANTHROPIC_CUSTOM_HEADERS" ]');
  });

  it("outer block exports ANTHROPIC_CUSTOM_HEADERS with litellm headers before the gateway fork", () => {
    const startSh = renderStartSh();

    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    const headersIdx = startSh.indexOf(CUSTOM_HEADERS_EXPORT);
    expect(headersIdx, "ANTHROPIC_CUSTOM_HEADERS export not found").toBeGreaterThan(-1);

    // The FIRST occurrence must be before the fork (the outer hoist).
    expect(headersIdx).toBeLessThan(forkIdx);

    // A second occurrence must exist after the fork (the inner block for claude).
    const headersIdx2 = startSh.indexOf(CUSTOM_HEADERS_EXPORT, headersIdx + 1);
    expect(headersIdx2, "inner ANTHROPIC_CUSTOM_HEADERS export not found").toBeGreaterThan(forkIdx);
  });

  it("outer block has fail-open behavior matching the inner block", () => {
    const startSh = renderStartSh();

    // Both fallback log lines must be present (one per fallback branch).
    const outerFallbackCount = (
      startSh.match(/litellm\(outer\): .*falling back to direct OAuth/g) ?? []
    ).length;
    // Two fallback branches: missing key and unreachable proxy.
    expect(outerFallbackCount).toBeGreaterThanOrEqual(1);

    // Fail-open: on unreachable proxy, strip routing env in the outer block too.
    // The outer `unset` must appear before the gateway fork.
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    const outerUnsetIdx = startSh.indexOf(
      "unset ANTHROPIC_BASE_URL ANTHROPIC_SMALL_FAST_MODEL SWITCHROOM_LITELLM",
    );
    expect(outerUnsetIdx, "fail-open unset not found").toBeGreaterThan(-1);
    expect(outerUnsetIdx).toBeLessThan(forkIdx);
  });

  it("outer block is inside the SWITCHROOM_DOCKER_TMUX_INNER guard (outer-only section)", () => {
    const startSh = renderStartSh();

    // The outer block must appear BEFORE the tmux re-exec line that closes the
    // outer section.
    const tmuxReexecIdx = startSh.indexOf('exec tmux -L "switchroom-');
    expect(tmuxReexecIdx, "tmux re-exec not found").toBeGreaterThan(-1);

    const outerBlockIdx = startSh.indexOf(LITELLM_GATE);
    expect(outerBlockIdx).toBeLessThan(tmuxReexecIdx);
  });
});
