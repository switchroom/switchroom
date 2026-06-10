import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

/**
 * Layer 1 — per-agent persistent HOME.
 *
 * compose.ts pins `HOME=/state/agent/home` on every agent container.
 * scaffoldAgent must create the host-side directory backing that path
 * (`<agentDir>/home/`) plus a few subdirs that keep PATH happy
 * (`.local/bin`, `bin`, `.npm-global`) and seed minimal `.bashrc` /
 * `.profile` so attached interactive shells see the same env that
 * start.sh exports for non-interactive children.
 *
 * Crucial property: the seed is `writeIfMissing` — once the agent
 * (or operator) edits .bashrc/.profile, a subsequent `switchroom
 * apply` MUST NOT overwrite those edits. These tests pin both halves
 * of that contract.
 */

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

function makeSwitchroomConfig(
  agentName: string,
  agentConfig: AgentConfig,
): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: {
      [agentName]: agentConfig,
    },
  };
}

describe("scaffoldAgent — Layer 1 persistent HOME", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-home-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates <agentDir>/home/ with PATH-relevant subdirs", () => {
    const cfg = makeAgentConfig();
    const sw = makeSwitchroomConfig("alice", cfg);
    const res = scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);

    const homeDir = join(res.agentDir, "home");
    expect(existsSync(homeDir)).toBe(true);
    expect(statSync(homeDir).isDirectory()).toBe(true);

    // PATH (set in start.sh + .profile) prepends these. Subdirs must
    // exist so `pip install --user`, `npm install -g`, and manual `~/bin`
    // drops have somewhere to land without each tool having to mkdir
    // first under a non-root UID.
    for (const sub of [".local/bin", "bin", ".npm-global"]) {
      const p = join(homeDir, sub);
      expect(existsSync(p), `expected ${p} to exist`).toBe(true);
      expect(statSync(p).isDirectory()).toBe(true);
    }
  });

  it("pre-creates <agentDir>/home/.switchroom symlink to the host ~/.switchroom", () => {
    // The host-side companion to start.sh's #910 symlink: it must exist
    // BEFORE first boot so docker resolves the admin audit-log binds
    // through it instead of materialising a real dir that breaks the
    // gateway↔claude bridge (the overlord root-agent incident).
    const prevHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "switchroom-fakehome-"));
    process.env.HOME = fakeHome;
    try {
      const cfg = makeAgentConfig();
      const sw = makeSwitchroomConfig("alice", cfg);
      const res = scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);

      const link = join(res.agentDir, "home", ".switchroom");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join(fakeHome, ".switchroom"));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not clobber an existing <agentDir>/home/.switchroom symlink", () => {
    const prevHome = process.env.HOME;
    const fakeHome = mkdtempSync(join(tmpdir(), "switchroom-fakehome-"));
    process.env.HOME = fakeHome;
    try {
      const cfg = makeAgentConfig();
      const sw = makeSwitchroomConfig("alice", cfg);
      // First scaffold creates the link; a second scaffold (apply re-run)
      // must leave the existing symlink untouched (idempotent).
      const res = scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);
      const link = join(res.agentDir, "home", ".switchroom");
      const before = readlinkSync(link);
      scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(before);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("seeds .profile with the PATH/NPM env block", () => {
    const cfg = makeAgentConfig();
    const sw = makeSwitchroomConfig("alice", cfg);
    const res = scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);

    const profile = readFileSync(
      join(res.agentDir, "home", ".profile"),
      "utf-8",
    );
    expect(profile).toContain(
      'export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH"',
    );
    expect(profile).toContain(
      'export NPM_CONFIG_PREFIX="$HOME/.npm-global"',
    );
  });

  it("seeds .bashrc that defers to .profile (single source of truth)", () => {
    const cfg = makeAgentConfig();
    const sw = makeSwitchroomConfig("alice", cfg);
    const res = scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);

    const bashrc = readFileSync(
      join(res.agentDir, "home", ".bashrc"),
      "utf-8",
    );
    // Bash's split between .profile (login shells) and .bashrc
    // (interactive non-login) is a footgun if we duplicate env in both;
    // .bashrc sources .profile so we keep one canonical block.
    expect(bashrc).toContain('. "$HOME/.profile"');
  });

  it("does NOT overwrite existing .bashrc / .profile on subsequent scaffolds", () => {
    const cfg = makeAgentConfig();
    const sw = makeSwitchroomConfig("alice", cfg);

    // First scaffold writes the seeds.
    scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);
    const homeDir = join(tmpDir, "alice", "home");
    const customProfile = "# operator-customized .profile\nexport FOO=bar\n";
    const customBashrc = "# operator-customized .bashrc\nalias ll='ls -la'\n";
    writeFileSync(join(homeDir, ".profile"), customProfile);
    writeFileSync(join(homeDir, ".bashrc"), customBashrc);

    // Second scaffold (idempotent reapply) MUST leave the operator
    // edits intact — writeIfMissing skips the seed when the file
    // exists. Otherwise every `switchroom apply` would clobber any
    // shell-level customization the agent or operator ever made.
    scaffoldAgent("alice", cfg, tmpDir, telegramConfig, sw);

    expect(readFileSync(join(homeDir, ".profile"), "utf-8")).toBe(
      customProfile,
    );
    expect(readFileSync(join(homeDir, ".bashrc"), "utf-8")).toBe(customBashrc);
  });
});
