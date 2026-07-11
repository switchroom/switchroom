import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Regression for #1122 UAT discovery: scaffoldAgent used to write
 * CLAUDE.md via `writeIfMissing` — meaning the file was written ONCE
 * on first scaffold and frozen forever, even if the profile template
 * `_shared/telegram-style.md.hbs` (or anything else feeding the
 * render) changed in a later release. The conversational-pacing
 * rewrite + the mandatory-reply hotfix both silently bypassed every
 * running agent because of this.
 *
 * Fix: re-render with a fingerprint sidecar. Preserve operator
 * hand-edits via `.before-rerender.<ts>` backup files.
 *
 * These tests pin the new behaviour.
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

describe("scaffoldAgent — CLAUDE.md rerender-on-template-change (#1122)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scaffold-rerender-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first scaffold writes CLAUDE.md + fingerprint sidecar", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(result.agentDir, "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);
    expect(existsSync(claudeMd + ".fingerprint")).toBe(true);
    // Fingerprint is a 64-char hex SHA-256.
    const fp = readFileSync(claudeMd + ".fingerprint", "utf-8").trim();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("second scaffold with unchanged template is a no-op", () => {
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r1.agentDir, "CLAUDE.md");
    const fp1 = readFileSync(claudeMd + ".fingerprint", "utf-8");
    const stat1 = readFileSync(claudeMd, "utf-8");

    const r2 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    expect(r2.skipped).toContain(claudeMd);
    expect(readFileSync(claudeMd, "utf-8")).toBe(stat1);
    expect(readFileSync(claudeMd + ".fingerprint", "utf-8")).toBe(fp1);
  });

  it("template drift WITHOUT operator edits → file overwritten + fingerprint updated", () => {
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r1.agentDir, "CLAUDE.md");
    const original = readFileSync(claudeMd, "utf-8");
    const fp1 = readFileSync(claudeMd + ".fingerprint", "utf-8").trim();

    // Simulate a template drift by changing the agent's `claude_md_raw`
    // (which feeds the render path). This produces a different rendered
    // output without us touching the file directly.
    const driftedConfig = makeAgentConfig({ claude_md_raw: "\n\n## Drift\nNew section.\n" });
    const r2 = scaffoldAgent(
      "a",
      driftedConfig,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", driftedConfig),
    );

    expect(r2.created).toContain(claudeMd);
    const rewritten = readFileSync(claudeMd, "utf-8");
    expect(rewritten).not.toBe(original);
    expect(rewritten).toContain("Drift");
    const fp2 = readFileSync(claudeMd + ".fingerprint", "utf-8").trim();
    expect(fp2).not.toBe(fp1);

    // No backup should exist — operator didn't edit.
    const backups = readdirSync(r1.agentDir).filter((f) =>
      f.startsWith("CLAUDE.md.before-rerender."),
    );
    expect(backups).toHaveLength(0);
  });

  it("operator hand-edit → fingerprint mismatch → backup + overwrite", () => {
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r1.agentDir, "CLAUDE.md");

    // Operator hand-edits the MANAGED (above-marker) section — this is what
    // bypasses the fingerprint. (An edit BELOW the two-section marker is a
    // first-class preserved state under #1857 and does NOT trigger a backup;
    // see tests/scaffold.claude-md-two-section.test.ts.)
    const MARKER = "# --- Yours (preserved across apply) ---";
    const handEdited = readFileSync(claudeMd, "utf-8").replace(
      MARKER,
      `## Operator note\nKeep this.\n\n${MARKER}`,
    );
    writeFileSync(claudeMd, handEdited, "utf-8");

    // Template drift triggers a rerender attempt.
    const driftedConfig = makeAgentConfig({ claude_md_raw: "\n\n## Drift\nNew section.\n" });
    const r2 = scaffoldAgent(
      "a",
      driftedConfig,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", driftedConfig),
    );

    // File was rewritten...
    expect(r2.created).toContain(claudeMd);
    expect(readFileSync(claudeMd, "utf-8")).toContain("Drift");

    // ...AND a backup was created with the operator's edit intact.
    const backups = readdirSync(r1.agentDir).filter((f) =>
      f.startsWith("CLAUDE.md.before-rerender."),
    );
    expect(backups).toHaveLength(1);
    const backupContent = readFileSync(join(r1.agentDir, backups[0]!), "utf-8");
    expect(backupContent).toContain("Operator note");
  });

  it("legacy state (CLAUDE.md exists, no fingerprint) → backup + overwrite", () => {
    // Simulate pre-#1122 state: an agent scaffolded under the old
    // writeIfMissing regime — CLAUDE.md exists but no fingerprint
    // sidecar. The first apply post-upgrade should migrate cleanly:
    // back up the existing file (we can't tell if operator edited),
    // overwrite with the fresh render, install the fingerprint.
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r1.agentDir, "CLAUDE.md");

    // Delete the fingerprint to simulate legacy state.
    rmSync(claudeMd + ".fingerprint");
    // Also tweak the file so the rendered output will differ from
    // what's on disk (otherwise we hit the same-content fast path).
    writeFileSync(claudeMd, readFileSync(claudeMd, "utf-8") + "\n# legacy edit\n", "utf-8");

    const driftedConfig = makeAgentConfig({ claude_md_raw: "\n\n## Drift\n" });
    scaffoldAgent("a", driftedConfig, tmpDir, telegramConfig, makeSwitchroomConfig("a", driftedConfig));

    // Legacy file backed up, new one written, fingerprint installed.
    const backups = readdirSync(r1.agentDir).filter((f) =>
      f.startsWith("CLAUDE.md.before-rerender."),
    );
    expect(backups).toHaveLength(1);
    expect(existsSync(claudeMd + ".fingerprint")).toBe(true);
  });

  it("matching content (mid-upgrade refresh) → idempotent skip + fingerprint installed", () => {
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r1.agentDir, "CLAUDE.md");

    // Simulate: operator deleted only the fingerprint (e.g.
    // accidentally rm'd, or migrated from an older version). The
    // file content still exactly matches what we'd render now.
    rmSync(claudeMd + ".fingerprint");

    const r2 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    // Same content → skipped (not rewritten).
    expect(r2.skipped).toContain(claudeMd);
    // But fingerprint is restored for the next round-trip.
    expect(existsSync(claudeMd + ".fingerprint")).toBe(true);
  });
});
