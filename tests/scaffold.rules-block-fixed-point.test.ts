import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent, CLAUDE_MD_YOURS_MARKER } from "../src/agents/scaffold.js";
import { createRule } from "../src/memory/rules-store.js";
import { computeSentinel, parseRulesBlock } from "../src/memory/rules-block.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Memory v2 M1 — carve-M1.md §4 "composeTwoSectionClaudeMd fixed-point vs
 * sentinel" hazard, also called out by red-team-M1.md.
 *
 * `rules-store.ts` writes rule mutations THROUGH the same below-marker
 * "Yours" seam `composeTwoSectionClaudeMd` reads/writes. A `switchroom
 * apply`/reconcile that runs AFTER a rule mutation must reproduce those
 * exact bytes — any reflow (even whitespace-only) would change the
 * rendered block bytes and, if the sentinel hashed rendered bytes instead
 * of the canonical rule set, would false-trip the tamper sentinel on a
 * routine `apply`. This guards the ACTUAL fixed point: reconcile after a
 * rule mutation is a byte-identical no-op, and the sentinel embedded in
 * the block still matches after that no-op reconcile.
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
    memory: { rules_block: true },
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
  } as SwitchroomConfig;
}

describe("rules-block reconcile fixed point", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scaffold-rules-fixed-point-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a reconcile run AFTER a rule mutation is byte-identical (no reflow, sentinel still verifies)", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    // A rule mutation, exactly as `switchroom memory rule add` would run it,
    // writing through the SAME below-marker seam scaffoldAgent/reconcileAgent
    // use.
    createRule(r.agentDir, {
      text: "Always confirm destructive git ops.",
      source: "telegram",
      actor: "klanker",
      now: () => "2026-08-17T00:00:00.000Z",
    });

    const afterMutation = readFileSync(claudeMd, "utf-8");
    const parsedBefore = parseRulesBlock(afterMutation)!;
    expect(parsedBefore.rules).toHaveLength(1);

    // Reconcile with UNCHANGED managed config — this is the "every apply"
    // path the red-team's Blocker 1 was about (desiredDeny runs here too),
    // and it must be a true no-op against the rules block.
    reconcileAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    const afterReconcile = readFileSync(claudeMd, "utf-8");
    expect(afterReconcile).toBe(afterMutation);

    // The sentinel embedded in the (unchanged) block must still verify
    // against the recomputed canonical rule set — proves the hash tracks
    // canonical content, not raw rendered bytes, so a hypothetical reflow
    // elsewhere in a future change would not silently break this.
    const parsedAfter = parseRulesBlock(afterReconcile)!;
    expect(computeSentinel(parsedAfter.rules)).toEqual(parsedAfter.sentinel);
    expect(afterReconcile.split(CLAUDE_MD_YOURS_MARKER)).toHaveLength(2);
  });

  it("a reconcile run with a DRIFTED managed section still preserves the rules block verbatim", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    createRule(r.agentDir, {
      text: "Never delete a rule without an explicit retire.",
      source: "telegram",
      actor: "klanker",
      now: () => "2026-08-17T00:05:00.000Z",
    });
    const beforeDriftedReconcile = readFileSync(claudeMd, "utf-8");
    const rulesBlockBefore = beforeDriftedReconcile.slice(
      beforeDriftedReconcile.indexOf("<!-- switchroom:rules:begin -->"),
      beforeDriftedReconcile.indexOf("<!-- switchroom:rules:end -->") +
        "<!-- switchroom:rules:end -->".length,
    );

    const drifted = makeAgentConfig({ claude_md_raw: "\n\n## Drift\nNew managed section.\n" });
    reconcileAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));

    const after = readFileSync(claudeMd, "utf-8");
    expect(after).toContain("Drift");
    const rulesBlockAfter = after.slice(
      after.indexOf("<!-- switchroom:rules:begin -->"),
      after.indexOf("<!-- switchroom:rules:end -->") + "<!-- switchroom:rules:end -->".length,
    );
    expect(rulesBlockAfter).toBe(rulesBlockBefore);
  });
});
