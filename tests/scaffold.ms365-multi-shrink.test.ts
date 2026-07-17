/**
 * End-to-end shrink retraction for multi-account Microsoft 365 bindings.
 *
 * Reproduces the review finding on PR #3295 (item 6): when an agent's
 * `microsoft_workspace.accounts` shrinks (an account is FULLY removed),
 * the stale `ms-365-<slug>` key must be dropped from the persisted
 * settings.json.mcpServers on the next `switchroom apply` (the scaffoldAgent
 * MERGE path — the one reconcile site that reads + merges existing state
 * rather than rebuilding it). This test FAILS without the prefix-scoped
 * namespace retraction at that site.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { scaffoldAgent } from "../src/agents/scaffold.js";
import { microsoftAccountSlug } from "../src/config/microsoft-workspace-acl.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

const ACCT_A = "alice@example.com";
const ACCT_B = "bob@example.com";
const ACCT_C = "carol@example.com";
const SLUG_A = `ms-365-${microsoftAccountSlug(ACCT_A)}`;
const SLUG_B = `ms-365-${microsoftAccountSlug(ACCT_B)}`;
const SLUG_C = `ms-365-${microsoftAccountSlug(ACCT_C)}`;

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function makeSwitchroomConfig(
  name: string,
  agentConfig: AgentConfig,
  microsoftAccounts: Record<string, { enabled_for?: string[] }>,
): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
    microsoft_accounts: microsoftAccounts,
  } as unknown as SwitchroomConfig;
}

function readMcpServers(agentDir: string): Record<string, unknown> {
  const settings = JSON.parse(
    readFileSync(join(agentDir, ".claude", "settings.json"), "utf-8"),
  );
  return settings.mcpServers ?? {};
}

describe("scaffoldAgent: multi-account ms-365 shrink retraction (PR #3295 item 6)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-ms365-shrink-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drops a fully-removed account's ms-365-<slug> from settings.json on re-apply", () => {
    const name = "marko";
    const accounts = {
      [ACCT_A]: { enabled_for: [name] },
      [ACCT_B]: { enabled_for: [name] },
      [ACCT_C]: { enabled_for: [name] },
    };

    // First apply: bind THREE accounts → three per-slug keys land.
    const threeAccountCfg = makeAgentConfig({
      microsoft_workspace: {
        accounts: [{ account: ACCT_A }, { account: ACCT_B }, { account: ACCT_C }],
      },
    } as Partial<AgentConfig>);
    const first = scaffoldAgent(
      name,
      threeAccountCfg,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig(name, threeAccountCfg, accounts),
    );
    const afterFirst = readMcpServers(first.agentDir);
    expect(afterFirst[SLUG_A]).toBeDefined();
    expect(afterFirst[SLUG_B]).toBeDefined();
    expect(afterFirst[SLUG_C]).toBeDefined();

    // Second apply: account B removed from the config (A + C remain, still
    // multi-account so survivors keep their per-slug keys). settings.json
    // already exists → scaffoldAgent takes the MERGE path (writeIfMissing
    // skips the template). The stale SLUG_B must be retracted.
    const twoAccountCfg = makeAgentConfig({
      microsoft_workspace: { accounts: [{ account: ACCT_A }, { account: ACCT_C }] },
    } as Partial<AgentConfig>);
    const second = scaffoldAgent(
      name,
      twoAccountCfg,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig(name, twoAccountCfg, accounts),
    );
    const afterSecond = readMcpServers(second.agentDir);
    expect(afterSecond[SLUG_A]).toBeDefined(); // surviving account kept
    expect(afterSecond[SLUG_C]).toBeDefined(); // surviving account kept
    expect(afterSecond[SLUG_B]).toBeUndefined(); // FULLY-REMOVED account gone
  });
});
