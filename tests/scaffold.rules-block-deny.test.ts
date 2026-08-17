import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { rulesBlockDenyForAgent, scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * T5 — red-team-M1.md Blocker 1 (MUST-FIX): the CLAUDE.md Edit/Write deny
 * must be flag-gated at BOTH deny-render sites — the fresh-scaffold path
 * (`toolsDeny` inside `buildWorkspaceContext`) AND the reconcile path
 * (`desiredDeny` inside `reconcileAgentInner`, which runs against
 * ALREADY-DEPLOYED agents). Both call sites are required to funnel through
 * the single exported `rulesBlockDenyForAgent` — the red-team's explicit
 * "do not inline the flag check at either site" instruction. This suite:
 *
 *   1. Unit-pins the shared function's ON/OFF shape (the actual deny
 *      specifier bytes Claude Code will match against).
 *   2. Structurally asserts (via source inspection) that BOTH the
 *      `toolsDeny` array and the `desiredDeny` array call
 *      `rulesBlockDenyForAgent(...)` — so a future edit that re-inlines
 *      the check at either site (reproducing the dark-build leak) fails
 *      this test, not just a runtime fixture that could bit-rot silently
 *      if one call site's plumbing changed shape.
 *   3. Confirms the known-safe additive re-seed block (~L5782, which
 *      re-seeds ONLY INTERACTIVE_TUI_FLEET_DENY_TOOLS on existing-agent
 *      settings.json merges) was NOT extended to also re-seed the rules
 *      deny — the red-team explicitly instructed leaving it alone.
 */

const SCAFFOLD_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "agents", "scaffold.ts"),
  "utf-8",
);

const agentConfig = (rulesBlock: boolean | undefined): AgentConfig =>
  ({ memory: { rules_block: rulesBlock } }) as unknown as AgentConfig;

describe("rulesBlockDenyForAgent — shared source of truth", () => {
  it("flag ON: returns the exact Edit()/Write() deny specifiers for the given path", () => {
    const path = "/home/agent/CLAUDE.md";
    expect(rulesBlockDenyForAgent(agentConfig(true), path)).toEqual([
      `Edit(${path})`,
      `Write(${path})`,
    ]);
  });

  it("flag OFF (false): returns no deny", () => {
    expect(rulesBlockDenyForAgent(agentConfig(false), "/home/agent/CLAUDE.md")).toEqual([]);
  });

  it("flag unset (default, the dark-build case): returns no deny", () => {
    expect(rulesBlockDenyForAgent(agentConfig(undefined), "/home/agent/CLAUDE.md")).toEqual([]);
  });

  it("flag set to a truthy non-boolean does NOT trip the deny (strict === true)", () => {
    const weird = { memory: { rules_block: "true" } } as unknown as AgentConfig;
    expect(rulesBlockDenyForAgent(weird, "/home/agent/CLAUDE.md")).toEqual([]);
  });
});

describe("Blocker 1 — both deny-render sites wired through the shared function", () => {
  it("the fresh-scaffold toolsDeny array calls rulesBlockDenyForAgent", () => {
    const toolsDenyBlock = SCAFFOLD_SRC.slice(
      SCAFFOLD_SRC.indexOf("toolsDeny: dedupe(["),
      SCAFFOLD_SRC.indexOf("toolsDeny: dedupe([") + 400,
    );
    expect(toolsDenyBlock).toContain("rulesBlockDenyForAgent(");
  });

  it("the reconcile-path desiredDeny array calls rulesBlockDenyForAgent", () => {
    const desiredDenyIdx = SCAFFOLD_SRC.indexOf("const desiredDeny = dedupe([");
    expect(desiredDenyIdx).toBeGreaterThan(-1);
    const desiredDenyBlock = SCAFFOLD_SRC.slice(desiredDenyIdx, desiredDenyIdx + 400);
    expect(desiredDenyBlock).toContain("rulesBlockDenyForAgent(");
  });

  it("desiredDeny is what gets assigned to settings.permissions.deny on reconcile", () => {
    // Pins the red-team's exact claim: desiredDeny -> settings.permissions.deny
    // on EVERY apply/reconcile against a live agent. If this assignment is
    // ever refactored away from `desiredDeny`, this test must be revisited
    // together with the reconcile-path wiring above — it is the reason
    // Blocker 1 was a blocker at all (this is the path with no separate
    // "already deployed" gate other than the flag itself).
    expect(SCAFFOLD_SRC).toMatch(/settings\.permissions\.deny\s*=\s*desiredDeny/);
  });
});

describe("Blocker 1 — end-to-end: flag OFF leaves an ALREADY-DEPLOYED agent's settings.json deny untouched on every reconcile", () => {
  // This is the exact scenario the red-team's Blocker 1 named: the
  // fresh-scaffold path skips deployed agents, but `desiredDeny` /
  // reconcileAgentInner runs on EVERY reconcile against a LIVE agent's
  // existing settings.json. A live agent scaffolded before the M1
  // rules_block flag existed (flag unset/false, same as every fleet agent
  // today) must never pick up the Edit/Write deny on a routine reconcile.
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
  function makeSwitchroomConfig(name: string, cfg: AgentConfig): SwitchroomConfig {
    return {
      switchroom: {
        version: 1,
        agents_dir: "~/.switchroom/agents",
        skills_dir: "~/.switchroom/skills",
      },
      telegram: telegramConfig,
      agents: { [name]: cfg },
    } as SwitchroomConfig;
  }

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scaffold-rules-deny-e2e-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flag OFF: settings.permissions.deny carries no Edit/Write(CLAUDE.md) entry after scaffold + a subsequent reconcile", () => {
    const config = makeAgentConfig(); // memory.rules_block unset — the fleet default
    const r = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const settingsPath = join(r.agentDir, ".claude", "settings.json");
    const claudeMdPath = join(r.agentDir, "CLAUDE.md");

    const afterScaffold = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const denyAfterScaffold: string[] = afterScaffold.permissions?.deny ?? [];
    expect(denyAfterScaffold).not.toContain(`Edit(${claudeMdPath})`);
    expect(denyAfterScaffold).not.toContain(`Write(${claudeMdPath})`);

    // Simulate the routine "every apply" reconcile against this now-live,
    // already-deployed agent — this is Blocker 1's actual reproduction path.
    reconcileAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    const afterReconcile = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const denyAfterReconcile: string[] = afterReconcile.permissions?.deny ?? [];
    expect(denyAfterReconcile).not.toContain(`Edit(${claudeMdPath})`);
    expect(denyAfterReconcile).not.toContain(`Write(${claudeMdPath})`);
  });

  it("flag ON: settings.permissions.deny DOES carry the exact Edit/Write(CLAUDE.md) entries after reconcile (control — proves the assertion above is not vacuous)", () => {
    const config = makeAgentConfig({ memory: { rules_block: true } });
    const r = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const settingsPath = join(r.agentDir, ".claude", "settings.json");
    const claudeMdPath = join(r.agentDir, "CLAUDE.md");

    reconcileAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    const afterReconcile = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const denyAfterReconcile: string[] = afterReconcile.permissions?.deny ?? [];
    expect(denyAfterReconcile).toContain(`Edit(${claudeMdPath})`);
    expect(denyAfterReconcile).toContain(`Write(${claudeMdPath})`);
  });
});

describe("the additive re-seed block was NOT extended (red-team explicit instruction)", () => {
  it("INTERACTIVE_TUI_FLEET_DENY_TOOLS re-seed block does not also call rulesBlockDenyForAgent", () => {
    // Find every occurrence of the interactive-TUI re-seed idiom and confirm
    // none of them sit adjacent to a rulesBlockDenyForAgent call — i.e. the
    // one context where extending it WOULD have made sense (a merge-time
    // re-seed of settings.json for an existing agent) was left alone, per
    // the red-team's explicit "do not extend it" instruction.
    const reSeedMatches = [
      ...SCAFFOLD_SRC.matchAll(/INTERACTIVE_TUI_FLEET_DENY_TOOLS[^\n]*\n/g),
    ];
    expect(reSeedMatches.length).toBeGreaterThan(0);
    for (const m of reSeedMatches) {
      const idx = m.index ?? 0;
      const windowStart = Math.max(0, idx - 300);
      const windowEnd = Math.min(SCAFFOLD_SRC.length, idx + 300);
      const window = SCAFFOLD_SRC.slice(windowStart, windowEnd);
      // toolsDeny/desiredDeny (which legitimately DO call it) are excluded —
      // this only checks OTHER (i.e. additive re-seed) occurrences.
      if (window.includes("toolsDeny: dedupe([") || window.includes("desiredDeny = dedupe([")) {
        continue;
      }
      expect(window).not.toContain("rulesBlockDenyForAgent(");
    }
  });
});
