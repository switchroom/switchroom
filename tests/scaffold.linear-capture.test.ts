/**
 * #2312 — capture-on-reaction → Linear playbook gating + the klanker-hazard
 * regression guard.
 *
 * The agent-self-service fragment renders a "Capture to Linear" playbook block
 * gated on `{{#if linearAgentEnabled}}`. That flag MUST be set identically by
 * BOTH render paths — scaffoldAgent's buildWorkspaceContext-derived `context`
 * AND reconcileAgent's hand-curated `claudeContext`. If they diverge, reconcile
 * diff-aborts CLAUDE.md on every `switchroom apply` (the klanker incident
 * class). This test pins:
 *   1. linear_agent.enabled ⇒ the playbook block lands in CLAUDE.md.
 *   2. no linear_agent ⇒ the block is absent.
 *   3. scaffold → reconcile is diff-stable for CLAUDE.md (the guard).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileAgent, scaffoldAgent } from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

const switchroomConfig: SwitchroomConfig = {
  agents: {},
  telegram: telegramConfig,
  defaults: {},
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

const linearEnabled = {
  channels: { telegram: { linear_agent: { enabled: true, token: "vault:linear/test-agent/token" } } },
} as Partial<AgentConfig>;

const PLAYBOOK_MARKER = "Capture to Linear";

function readClaudeMd(agentDir: string): string {
  return readFileSync(join(agentDir, "CLAUDE.md"), "utf-8");
}

describe("linear capture playbook gating (#2312)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-linear-capture-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders the playbook block when linear_agent is enabled", () => {
    const config = makeAgentConfig(linearEnabled);
    const { agentDir } = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claude = readClaudeMd(agentDir);
    expect(claude).toContain(PLAYBOOK_MARKER);
    expect(claude).toContain("linear_create_issue");
    expect(claude).toContain("👨‍💻");
  });

  it("omits the playbook block when linear_agent is absent", () => {
    const config = makeAgentConfig();
    const { agentDir } = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    expect(readClaudeMd(agentDir)).not.toContain(PLAYBOOK_MARKER);
  });

  it("is diff-stable across reconcile (klanker-hazard guard)", () => {
    // Both render paths must set linearAgentEnabled identically; otherwise the
    // reconcile re-render differs from the scaffold render and CLAUDE.md shows
    // up in `changes` on every apply.
    const config = makeAgentConfig(linearEnabled);
    const { agentDir } = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const before = readClaudeMd(agentDir);

    const result = reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    expect(result.changes).not.toContain(join(agentDir, "CLAUDE.md"));
    expect(readClaudeMd(agentDir)).toBe(before);
    // and the block survived the reconcile re-render.
    expect(readClaudeMd(agentDir)).toContain(PLAYBOOK_MARKER);
  });
});
