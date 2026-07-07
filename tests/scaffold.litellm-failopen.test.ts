import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Ship A (#litellm): the rendered start.sh must implement the operator-decided
// LiteLLM boot contract:
//   - FAIL-OPEN: if the per-agent virtual key is missing OR the proxy is
//     unreachable at boot, strip the routing env and fall back to direct OAuth,
//     logging the reason. A proxy outage must never take an agent dark.
//   - Per-AGENT tags: x-litellm-customer-id + x-litellm-tags carry the agent
//     name so LiteLLM can attribute usage per agent.
// See reference/invariants.md § "Operator-controlled gateway carve-out".

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

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  };
}

describe("scaffoldAgent: LiteLLM fail-open boot contract (#litellm)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-litellm-failopen-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders the fail-open probe + per-agent tags in start.sh", () => {
    const name = "ll-agent";
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const res = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");

    // Gated on the same SWITCHROOM_LITELLM marker compose injects.
    expect(startSh).toContain('if [ -n "${SWITCHROOM_LITELLM:-}" ]');

    // Boot reachability probe against the proxy's unauthenticated liveness
    // endpoint (so a key-less probe still works). It MUST target the ROOT
    // proxy (SWITCHROOM_LITELLM_BASE), not ANTHROPIC_BASE_URL — the latter now
    // points at the /anthropic pass-through, and /anthropic/health/liveliness
    // 404s, which would make the probe fail and silently fail-open the whole
    // fleet to direct OAuth. Regression guard for the passthrough migration.
    expect(startSh).toContain(
      "${SWITCHROOM_LITELLM_BASE:-${ANTHROPIC_BASE_URL%/anthropic}}/health/liveliness",
    );

    // FAIL-OPEN: on missing key OR unreachable proxy, strip ALL routing env so
    // claude talks to Anthropic directly on its OAuth credential. The root URL
    // (SWITCHROOM_LITELLM_BASE) must be dropped too — asserted explicitly (not
    // as a prefix) so it can't silently fall out of the unset list.
    expect(startSh).toContain(
      "unset ANTHROPIC_BASE_URL ANTHROPIC_SMALL_FAST_MODEL SWITCHROOM_LITELLM SWITCHROOM_LITELLM_BASE",
    );

    // The lapse must be logged, not silent (both fallback branches → stderr).
    expect(startSh).toContain("falling back to direct OAuth");

    // Per-AGENT attribution headers, keyed off the agent name.
    expect(startSh).toContain("x-litellm-api-key: Bearer $sr_ll_key");
    expect(startSh).toContain("x-litellm-customer-id: $SWITCHROOM_AGENT_NAME");
    expect(startSh).toContain("x-litellm-tags: agent:$SWITCHROOM_AGENT_NAME");
  });
});
