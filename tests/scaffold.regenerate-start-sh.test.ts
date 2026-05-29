import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Regression for #879: scaffoldAgent must regenerate start.sh whenever
// the rendered template content differs from what's on disk. The bug
// was that scaffoldAgent used writeIfMissing for start.sh, so an
// existing pre-template-change file was left in place. Operators
// running `apply --only=<name>` after a release that modified the
// start.sh template (e.g. v0.7.5 added the docker-mode tmux preamble)
// silently kept the stale file.

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

describe("scaffoldAgent: start.sh content-aware regeneration (#879)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-regen-startsh-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites an existing start.sh whose contents drift from the template", () => {
    const name = "drifted-agent";
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const first = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const startShPath = join(first.agentDir, "start.sh");
    const fresh = readFileSync(startShPath, "utf-8");
    expect(first.created).toContain(startShPath);

    // Simulate template drift: overwrite the rendered start.sh with
    // pre-v0.7.5 stale content. A real operator would have a file
    // missing the docker-mode tmux preamble; here we just clobber.
    const stale = "#!/bin/bash\n# pre-v0.7.5 stale content — no preamble\nexec claude\n";
    writeFileSync(startShPath, stale, "utf-8");
    expect(readFileSync(startShPath, "utf-8")).toBe(stale);

    // Re-scaffold with the same config. Pre-fix this was a no-op
    // (writeIfMissing skipped the existing file). With the fix it
    // detects content drift and rewrites.
    const second = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);

    expect(readFileSync(startShPath, "utf-8")).toBe(fresh);
    expect(readFileSync(startShPath, "utf-8")).not.toBe(stale);
    expect(second.created).toContain(startShPath);
  });

  it("prunes any user-local claude shadow at boot so the image binary is authoritative", () => {
    const name = "pinned-agent";
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const res = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");

    // The persistent-HOME dirs precede /usr/local/bin on PATH (so agents
    // can install their own npm/pip tools), which means a stray claude in
    // the writable, state-persisted npm prefix would otherwise shadow the
    // version-pinned image binary across every restart. start.sh must
    // remove a user-local claude — by name, leaving other packages intact.
    expect(startSh).toContain("$HOME/.npm-global/bin/claude");
    expect(startSh).toContain("$HOME/.local/bin/claude");
    expect(startSh).toContain("$HOME/bin/claude");
    expect(startSh).toContain(
      "$HOME/.npm-global/lib/node_modules/@anthropic-ai/claude-code",
    );
    // The prune must come BEFORE claude is launched (start.sh later
    // execs into tmux→bash→claude), i.e. before the CLAUDE_CONFIG_DIR
    // export that anchors the runtime block.
    expect(startSh.indexOf("pruning user-local claude shadow")).toBeGreaterThan(
      0,
    );
    expect(startSh.indexOf("pruning user-local claude shadow")).toBeLessThan(
      startSh.indexOf('export CLAUDE_CONFIG_DIR='),
    );
  });

  it("does NOT rewrite an existing start.sh when content already matches the template", () => {
    const name = "stable-agent";
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const first = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const startShPath = join(first.agentDir, "start.sh");

    const second = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);

    // Second pass sees identical content and reports start.sh as
    // skipped, not created — preserves the "up to date" reporting
    // for true no-op runs.
    expect(second.created).not.toContain(startShPath);
    expect(second.skipped).toContain(startShPath);
  });
});
