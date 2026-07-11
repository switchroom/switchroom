import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

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

describe("reconcileAgent — persona (Phase 3)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-reconcile-persona-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT regenerate workspace/SOUL.md when config changes (user-owned, seed-once)", () => {
    const config1 = makeAgentConfig({
      soul: { name: "Coach", style: "motivational" },
    });

    const result = scaffoldAgent("test-agent", config1, tmpDir, telegramConfig);
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");

    const soulBefore = readFileSync(workspaceSoulPath, "utf-8");
    expect(soulBefore).toContain("Coach");
    expect(soulBefore).toContain("motivational");

    // Change persona config. SOUL.md is the user's file post-seed —
    // reconcile must leave it byte-identical. `switchroom soul reset`
    // is the explicit re-seed path (config is a seed-time input only).
    const config2 = makeAgentConfig({
      soul: { name: "Assistant", style: "concise, technical" },
    });

    reconcileAgent("test-agent", config2, tmpDir, telegramConfig, switchroomConfig);

    const soulAfter = readFileSync(workspaceSoulPath, "utf-8");
    expect(soulAfter).toBe(soulBefore);
    expect(soulAfter).toContain("Coach");
    expect(soulAfter).not.toContain("concise, technical");
  });

  it("does NOT fold a SOUL.custom.md added AFTER seed into an existing SOUL.md", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const workspaceSoulPath = join(result.agentDir, "workspace", "SOUL.md");
    const customSoulPath = join(result.agentDir, "workspace", "SOUL.custom.md");
    const soulBefore = readFileSync(workspaceSoulPath, "utf-8");

    // Drop a sidecar AFTER the agent was seeded. Pre-design this was
    // re-composed on every reconcile; under seed-once ownership the
    // already-seeded SOUL.md is the user's and is left untouched.
    // (A sidecar present BEFORE the first seed *is* folded in — see
    // scaffold.soul-user-owned.test.ts.)
    writeFileSync(
      customSoulPath,
      "## Custom Section\n\nThis is my personal addition.",
      "utf-8"
    );

    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const soulMd = readFileSync(workspaceSoulPath, "utf-8");
    expect(soulMd).toBe(soulBefore);
    expect(soulMd).not.toContain("## Custom Section");
  });

  it("regenerates CLAUDE.md by default when template changes", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");

    const original = readFileSync(claudeMdPath, "utf-8");

    // Reconcile regenerates CLAUDE.md deterministically
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const afterReconcile = readFileSync(claudeMdPath, "utf-8");
    expect(afterReconcile).toBe(original); // Idempotent when template is the same
  });

  it("migrates a legacy CLAUDE.custom.md sidecar below the marker + retires it (#1857)", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");
    const claudeCustomPath = join(result.agentDir, "workspace", "CLAUDE.custom.md");

    // Simulate a pre-#1857 agent: a legacy sidecar exists and CLAUDE.md has
    // no marker yet (strip the marker the fresh scaffold wrote).
    const MARKER = "# --- Yours (preserved across apply) ---";
    const fresh = readFileSync(claudeMdPath, "utf-8");
    const noMarker = fresh.slice(0, fresh.indexOf(MARKER)).trimEnd() + "\n";
    writeFileSync(claudeMdPath, noMarker, "utf-8");
    writeFileSync(
      claudeCustomPath,
      "## Custom Instructions\n\nThis is my personal addition.",
      "utf-8"
    );

    // Reconcile migrates the sidecar content below the marker.
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);

    const claudeMd = readFileSync(claudeMdPath, "utf-8");
    expect(claudeMd).toContain(MARKER);
    const below = claudeMd.slice(claudeMd.indexOf(MARKER) + MARKER.length);
    expect(below).toContain("## Custom Instructions");
    expect(below).toContain("This is my personal addition");
    // Sidecar retired.
    expect(existsSync(claudeCustomPath)).toBe(false);
    expect(existsSync(claudeCustomPath + ".deprecated")).toBe(true);
  });

  it("preserves CLAUDE.md when --preserve-claude-md is set", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");

    // User edits CLAUDE.md
    const original = readFileSync(claudeMdPath, "utf-8");
    const edited = original + "\n\n## My Custom Section\n\nUser-added content.";
    writeFileSync(claudeMdPath, edited, "utf-8");

    // Reconcile with --preserve-claude-md
    reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig, undefined, {
      preserveClaudeMd: true,
    });

    const afterReconcile = readFileSync(claudeMdPath, "utf-8");
    expect(afterReconcile).toContain("## My Custom Section");
    expect(afterReconcile).toContain("User-added content");
  });

  it("regenerates CLAUDE.md silently when on-disk drifts from template (no abort)", () => {
    const config = makeAgentConfig({
      soul: { name: "Agent", style: "default" },
    });

    const result = scaffoldAgent("test-agent", config, tmpDir, telegramConfig);
    const claudeMdPath = join(result.agentDir, "CLAUDE.md");

    // Simulate stray hand-edits ABOVE the marker (the Switchroom-managed
    // section) — this is the drift that must be regenerated. Content BELOW
    // the marker is operator-owned and preserved, so drift the managed block.
    const MARKER = "# --- Yours (preserved across apply) ---";
    const original = readFileSync(claudeMdPath, "utf-8");
    const edited = original.replace(
      MARKER,
      `## My Custom Section\n\nUser-added content.\n\n${MARKER}`,
    );
    writeFileSync(claudeMdPath, edited, "utf-8");

    // Reconcile must NOT abort; it should regenerate the managed section.
    expect(() => {
      reconcileAgent("test-agent", config, tmpDir, telegramConfig, switchroomConfig);
    }).not.toThrow();

    // Above-marker drift is gone — managed section matches a fresh render.
    const afterReconcile = readFileSync(claudeMdPath, "utf-8");
    expect(afterReconcile).not.toContain("## My Custom Section");
  });
});
