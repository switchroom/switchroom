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

  it("hoists SWITCHROOM_AGENT_NAME AHEAD of the gateway fork so the daemon always has its identity (#1116 / #2893 durable-identity fix)", () => {
    const startSh = renderStartSh();
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    expect(forkIdx).toBeGreaterThan(-1);

    const nameIdx = startSh.indexOf('export SWITCHROOM_AGENT_NAME=');
    expect(nameIdx).toBeGreaterThan(-1);
    // The FIRST occurrence (outer-pass hoist) must precede the fork, or a
    // non-docker / compose-env-less gateway starts with identity UNSET and its
    // worktree-ownership filter collapses to [] (no live worker feed).
    expect(nameIdx).toBeLessThan(forkIdx);
  });

  it("hoists SWITCHROOM_BOOT_RESUME AHEAD of the gateway fork so the boot-resume policy reaches the daemon", () => {
    const startSh = renderStartSh();
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    expect(forkIdx).toBeGreaterThan(-1);

    const bootResumeIdx = startSh.indexOf("export SWITCHROOM_BOOT_RESUME=");
    expect(bootResumeIdx).toBeGreaterThan(-1);
    // The gateway reads SWITCHROOM_BOOT_RESUME at boot-resume time; if it were
    // exported only after the fork (like SWITCHROOM_RESUME_MODE, which drives
    // the inner claude --continue path), the daemon would never see it and
    // every agent would silently default.
    expect(bootResumeIdx).toBeLessThan(forkIdx);
    // Default value when session_continuity.boot_resume is unset.
    expect(startSh).toContain('export SWITCHROOM_BOOT_RESUME="in-flight"');
  });

  it("hoists the SWITCHROOM_FORCE_FRESH marker snapshot AHEAD of the gateway fork (M1: env-keyed briefing suppression, race-proof)", () => {
    const startSh = renderStartSh();
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    expect(forkIdx).toBeGreaterThan(-1);

    // The outer pass snapshots the .force-fresh-session marker into
    // SWITCHROOM_FORCE_FRESH BEFORE forking the gateway, so the gateway's
    // briefing-suppression decision is fixed at fork time and immune to the
    // inner tmux pass's later `rm` of the marker (the fork and the rm race
    // with no ordering). If this export slid after the fork, a /reset boot
    // could resurrect the briefing and re-feed the just-reset conversation.
    const forceFreshIdx = startSh.indexOf("export SWITCHROOM_FORCE_FRESH=1");
    expect(forceFreshIdx).toBeGreaterThan(-1);
    expect(forceFreshIdx).toBeLessThan(forkIdx);
    // And the inner pass still consumes the marker for the claude session's
    // --continue / session-mode logic — the snapshot only mirrors it.
    expect(startSh).toContain('rm -f "');
  });

  it("hoists the SWITCHROOM_GATEWAY_BOOT_ID stamp AHEAD of the gateway fork (#4242: respawn-stable session generation)", () => {
    const startSh = renderStartSh();
    const forkIdx = startSh.indexOf(GATEWAY_FORK);
    expect(forkIdx).toBeGreaterThan(-1);

    // The outer pass stamps a per-boot session-generation id BEFORE forking
    // the gateway. _switchroom_supervise respawns the gateway `bun` in a loop
    // within this same shell (no re-run of start.sh), so a crash-respawn
    // inherits the identical id and the gateway skips re-minting the briefing
    // into the still-live Claude session; a genuine new boot re-derives a
    // fresh id. If this slid after the fork, the daemon would never see it and
    // the guard would be inert on docker — exactly where the respawn race
    // lives.
    const bootIdIdx = startSh.indexOf("export SWITCHROOM_GATEWAY_BOOT_ID=");
    expect(bootIdIdx).toBeGreaterThan(-1);
    expect(bootIdIdx).toBeLessThan(forkIdx);
    // The value must be derived per boot (not a fixed literal), so distinct
    // container boots never collide on the same generation.
    expect(startSh).toContain('export SWITCHROOM_GATEWAY_BOOT_ID="$(date +%s)-$$-${RANDOM}"');
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
