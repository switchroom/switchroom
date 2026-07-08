import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

  it("outer block splits missing-key (strip) vs unreachable (KEEP routing) like the inner block", () => {
    const startSh = renderStartSh();
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    const outerBlockIdx = startSh.indexOf(LITELLM_GATE);
    // Slice to the OUTER block only (marker → gateway fork) so these assertions
    // never accidentally match the inner (claude-process) block.
    const outerSlice = startSh.slice(outerBlockIdx, forkIdx);

    // The unreachable branch is now distinguished by its own flag — it must NOT
    // fall through to the fail-open unset.
    expect(outerSlice).toContain('sr_ll_unreachable="1"');
    // The unreachable branch keeps routing and loud-warns (routing must survive
    // into the inner tmux pass — the inner self-heal block is gated on
    // SWITCHROOM_LITELLM, which the old strip removed HERE).
    expect(outerSlice).toContain("routing LEFT IN PLACE");
    expect(outerSlice).toContain("NOT falling back to untracked direct Anthropic OAuth");
    // The OLD unreachable-strip log is gone from the outer block.
    expect(outerSlice).not.toContain(
      "falling back to direct OAuth (no tracking/guardrail this session)",
    );

    // MISSING-KEY still fails open: the strip remains, guarded by the else
    // branch, and appears before the gateway fork.
    const outerUnsetIdx = startSh.indexOf(
      "unset ANTHROPIC_BASE_URL ANTHROPIC_SMALL_FAST_MODEL SWITCHROOM_LITELLM",
    );
    expect(outerUnsetIdx, "missing-key fail-open unset not found").toBeGreaterThan(-1);
    expect(outerUnsetIdx).toBeLessThan(forkIdx);
    expect(outerSlice).toContain("no virtual key for agent");
  });

  it("outer dispatch (executed): UNREACHABLE keeps routing env, MISSING KEY strips it", () => {
    const startSh = renderStartSh();
    // Extract JUST the outer dispatch (decision + scratch cleanup): from the
    // FIRST `if [ -n "$sr_ll_ok" ]` (outer precedes inner) through the first
    // `unset sr_ll_key sr_ll_ok sr_ll_unreachable`. This runs the real strip-vs-
    // keep code paths without the 120s probe loop.
    const dispStart = startSh.indexOf('if [ -n "$sr_ll_ok" ]; then');
    const dispEndMarker = "unset sr_ll_key sr_ll_ok sr_ll_unreachable";
    const dispEnd = startSh.indexOf(dispEndMarker, dispStart) + dispEndMarker.length;
    expect(dispStart).toBeGreaterThan(-1);
    expect(dispEnd).toBeGreaterThan(dispStart);
    const dispatch = startSh.slice(dispStart, dispEnd);

    const runDispatch = (preset: { ok: string; unreachable: string }): Record<string, string> => {
      const script = [
        "set -e",
        "export SWITCHROOM_AGENT_NAME=a",
        "export SWITCHROOM_AGENT_PROFILE=default",
        'export ANTHROPIC_BASE_URL="http://litellm:4010/anthropic"',
        "export ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4-5",
        "export SWITCHROOM_LITELLM=1",
        'export SWITCHROOM_LITELLM_BASE="http://litellm:4010"',
        "sr_ll_key=k",
        `sr_ll_ok=${JSON.stringify(preset.ok)}`,
        `sr_ll_unreachable=${JSON.stringify(preset.unreachable)}`,
        dispatch,
        'echo "BASEURL=${ANTHROPIC_BASE_URL:-__UNSET__}"',
        'echo "LITELLM=${SWITCHROOM_LITELLM:-__UNSET__}"',
        'echo "LLBASE=${SWITCHROOM_LITELLM_BASE:-__UNSET__}"',
      ].join("\n");
      const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
      return Object.fromEntries(
        [...out.matchAll(/^(BASEURL|LITELLM|LLBASE)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]),
      );
    };

    // Proxy unreachable → routing env SURVIVES (must reach the tmux exec env).
    const unreachable = runDispatch({ ok: "", unreachable: "1" });
    expect(unreachable.BASEURL).toBe("http://litellm:4010/anthropic");
    expect(unreachable.LITELLM).toBe("1");
    expect(unreachable.LLBASE).toBe("http://litellm:4010");

    // Missing key → fail-open strip (all routing vars gone).
    const missingKey = runDispatch({ ok: "", unreachable: "" });
    expect(missingKey.BASEURL).toBe("__UNSET__");
    expect(missingKey.LITELLM).toBe("__UNSET__");
    expect(missingKey.LLBASE).toBe("__UNSET__");
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
