import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Ship A (#litellm): the rendered start.sh must implement the operator-decided
// LiteLLM boot contract. Two boot failure modes, handled DIFFERENTLY (revised
// 2026-07-08 — the old single fail-open path silently took an agent off-proxy
// for its whole lifetime when it booted during a brief litellm blip):
//   - MISSING KEY: fail-open — strip the routing env and fall back to direct
//     OAuth, logging LOUDLY. Without a key there is no metered route to reach.
//   - PROXY UNREACHABLE at boot (key present): do NOT strip. Leave
//     ANTHROPIC_BASE_URL / SWITCHROOM_LITELLM* pointed at the proxy (the socat
//     forwarder at 127.0.0.1:4010 self-heals per-connection) and emit a LOUD
//     warning. Claude traffic fails+retries until the proxy returns, then routes
//     through it automatically — no silent untracked direct-Anthropic fallback.
//   - Per-AGENT tags: x-litellm-customer-id + x-litellm-tags carry the agent
//     name so LiteLLM can attribute usage per agent.
// See reference/invariants.md § "Operator-controlled gateway carve-out" and
// docs/model-routing.md § G2.

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

  it("renders the split-mode boot contract + per-agent tags in start.sh", () => {
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

    // MISSING-KEY branch STILL fails open: strip ALL routing env so claude talks
    // to Anthropic directly on its OAuth credential. The root URL
    // (SWITCHROOM_LITELLM_BASE) must be dropped too — asserted explicitly (not
    // as a prefix) so it can't silently fall out of the unset list.
    expect(startSh).toContain(
      "unset ANTHROPIC_BASE_URL ANTHROPIC_SMALL_FAST_MODEL SWITCHROOM_LITELLM SWITCHROOM_LITELLM_BASE",
    );

    // NEW CONTRACT — PROXY UNREACHABLE at boot must NOT permanently strip the
    // routing env. The old code ran the same fail-open `unset ...` on an
    // unreachable proxy, which took an agent that booted during a transient
    // litellm blip off-proxy for its entire lifetime. This fix is scoped to the
    // INNER (claude-process) block, which begins at `_LITELLM_OK=""`; the OUTER
    // gateway-hoist block is left to its own dedicated contract test, so slice
    // to the inner block before asserting the unreachable-branch behavior.
    const innerBlock = startSh.slice(startSh.indexOf('_LITELLM_OK=""'));
    expect(innerBlock.length).toBeGreaterThan(0);

    //  1. the unreachable branch is distinguished by its own flag,
    expect(innerBlock).toContain('sr_ll_unreachable="1"');
    //  2. the old "unreachable → fall back to direct OAuth" log is GONE from the
    //     inner block (the unreachable path must not silently drop routing),
    expect(innerBlock).not.toContain(
      "falling back to direct OAuth (no tracking/guardrail this session)",
    );
    //  3. and it emits a LOUD, unmistakable warning that routing is held in
    //     place to self-heal rather than silently dropped.
    expect(innerBlock).toContain("litellm proxy unreachable");
    expect(innerBlock).toContain("routing LEFT IN PLACE");
    expect(innerBlock).toContain("NOT falling back to untracked direct Anthropic OAuth");

    // The unreachable branch dispatch must be a no-op (routing kept), guarded by
    // the flag — never the unset. Assert the elif dispatch exists.
    expect(innerBlock).toContain('elif [ -n "$sr_ll_unreachable" ]');

    // MISSING-KEY branch is still logged LOUDLY (not silent).
    expect(innerBlock).toContain("no litellm virtual key for agent");

    // Per-AGENT attribution headers, keyed off the agent name (unchanged path).
    expect(startSh).toContain("x-litellm-api-key: Bearer $sr_ll_key");
    expect(startSh).toContain("x-litellm-customer-id: $SWITCHROOM_AGENT_NAME");
    expect(startSh).toContain("x-litellm-tags: agent:$SWITCHROOM_AGENT_NAME");
  });
});
