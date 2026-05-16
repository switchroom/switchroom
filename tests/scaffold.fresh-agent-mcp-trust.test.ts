import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

/**
 * Regression for the C1 ordering defect (Drive reliability audit,
 * 2026-05-16). In `scaffoldAgent`, `.mcp.json` is written and
 * `ensureMcpServersTrusted` is called BEFORE `.claude.json` is created
 * (copyOnboardingState / createMinimalClaudeConfig + preTrustWorkspace
 * run ~150 lines later). `ensureMcpServersTrusted` is
 * skip-silently-if-`.claude.json`-absent, so on a BRAND-NEW agent the
 * in-block call no-ops and `gdrive` (plus agent-config/hostd) is never
 * added to `enabledMcpjsonServers` → Claude Code silently ignores the
 * server → "agent has no Drive tools". The bug was masked in production
 * only because `reconcileAgent` re-trusts on every restart, and masked
 * in tests because the existing suites either re-scaffold (so
 * `.claude.json` exists on the 2nd pass) or pre-write `.claude.json`.
 *
 * This test exercises the TRUE net-new path: HOME points at an empty
 * dir so `findExistingClaudeJson()` returns null and scaffold takes the
 * `createMinimalClaudeConfig` branch — i.e. `.claude.json` genuinely
 * does not exist until late in scaffold. It must fail pre-fix and pass
 * post-fix (the post-`preTrustWorkspace` idempotent re-trust pass).
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

describe("scaffoldAgent: net-new agent trusts .mcp.json servers (C1)", () => {
  let agentsDir: string;
  let fakeHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "switchroom-c1-agents-"));
    // Empty HOME → findExistingClaudeJson() finds nothing → scaffold
    // takes the createMinimalClaudeConfig path: the genuine net-new
    // agent topology where .claude.json does not exist early.
    fakeHome = mkdtempSync(join(tmpdir(), "switchroom-c1-home-"));
    savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(agentsDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("adds gdrive to enabledMcpjsonServers on first scaffold (no prior .claude.json)", () => {
    const name = "fresh-drive-agent";
    const account = "pixsoul@gmail.com";
    const agentConfig = makeAgentConfig({
      google_workspace: { account },
    } as Partial<AgentConfig>);
    const switchroomConfig = {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: agentConfig },
      google_accounts: { [account]: { enabled_for: [name] } },
      google_workspace: { tier: "extended" },
    } as unknown as SwitchroomConfig;

    const res = scaffoldAgent(
      name,
      agentConfig,
      agentsDir,
      telegramConfig,
      switchroomConfig,
    );

    const claudeJsonPath = join(res.agentDir, ".claude", ".claude.json");
    expect(existsSync(claudeJsonPath)).toBe(true);

    const cfg = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    const project = cfg.projects?.[resolve(res.agentDir)];
    expect(project).toBeDefined();
    expect(project.hasTrustDialogAccepted).toBe(true);
    expect(Array.isArray(project.enabledMcpjsonServers)).toBe(true);

    // The core C1 assertion: gdrive must be trusted after a SINGLE
    // scaffold of a brand-new agent — no reconcile/restart papering
    // over it.
    expect(project.enabledMcpjsonServers).toContain("gdrive");
    // The other scaffolded servers ride the same trust pass; assert one
    // to pin that the whole written set is unioned, not just gdrive.
    expect(project.enabledMcpjsonServers).toContain("switchroom-telegram");

    // And the .mcp.json that was written must actually contain gdrive
    // (guards against the test passing because gdrive was never emitted).
    const mcp = JSON.parse(
      readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcp.mcpServers)).toContain("gdrive");
  });
});
