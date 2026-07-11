import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scaffoldAgent,
  reconcileAgent,
  CLAUDE_MD_YOURS_MARKER,
} from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * #1857 — `<agentDir>/CLAUDE.md` is a two-section file: everything ABOVE the
 * visible marker is scaffold-regenerated on every apply; everything BELOW is
 * operator-owned and preserved verbatim across both write paths
 * (first-scaffold via scaffoldAgent + reconcile via reconcileAgent).
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
  } as SwitchroomConfig;
}

const PLACEHOLDER = "This space is yours.";

describe("CLAUDE.md two-section marker (#1857)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scaffold-two-section-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fresh scaffold renders the marker + placeholder below it", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");
    const content = readFileSync(claudeMd, "utf-8");

    expect(content).toContain(CLAUDE_MD_YOURS_MARKER);
    const markerIdx = content.indexOf(CLAUDE_MD_YOURS_MARKER);
    const below = content.slice(markerIdx + CLAUDE_MD_YOURS_MARKER.length);
    expect(below).toContain(PLACEHOLDER);
  });

  it("operator content below the marker survives a reconcile with changed managed content", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    // Operator edits below the marker.
    const original = readFileSync(claudeMd, "utf-8");
    const markerIdx = original.indexOf(CLAUDE_MD_YOURS_MARKER);
    const aboveWithMarker = original.slice(0, markerIdx + CLAUDE_MD_YOURS_MARKER.length);
    const edited = `${aboveWithMarker}\n\n## My rules\nAlways speak like a pirate.\n`;
    writeFileSync(claudeMd, edited, "utf-8");

    // Reconcile with changed managed content (claude_md_raw drift).
    const drifted = makeAgentConfig({ claude_md_raw: "\n\n## Drift\nNew managed section.\n" });
    reconcileAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));

    const after = readFileSync(claudeMd, "utf-8");
    // Managed section regenerated...
    expect(after).toContain("Drift");
    // ...operator section preserved verbatim.
    expect(after).toContain("Always speak like a pirate.");
    // Placeholder gone (operator replaced it).
    expect(after).not.toContain(PLACEHOLDER);
    // Exactly one marker.
    expect(after.split(CLAUDE_MD_YOURS_MARKER)).toHaveLength(2);
  });

  it("above-marker operator edits are regenerated per fingerprint/backup rules", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    // Operator hand-edits ABOVE the marker.
    const original = readFileSync(claudeMd, "utf-8");
    const tampered = original.replace(
      CLAUDE_MD_YOURS_MARKER,
      `## SNUCK IN ABOVE\nThis should be clobbered.\n\n${CLAUDE_MD_YOURS_MARKER}`,
    );
    writeFileSync(claudeMd, tampered, "utf-8");

    // Second scaffold (path 1) — fingerprint mismatch → backup + overwrite.
    const r2 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const after = readFileSync(claudeMd, "utf-8");
    expect(after).not.toContain("SNUCK IN ABOVE");
    expect(r2.created).toContain(claudeMd);
  });

  it("migrates workspace/CLAUDE.custom.md below marker + renames sidecar; second run no duplicate", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");
    const sidecar = join(r.agentDir, "workspace", "CLAUDE.custom.md");

    // Seed a legacy sidecar and remove the marker from CLAUDE.md to simulate a
    // pre-#1857 file that has never been migrated.
    mkdirSync(join(r.agentDir, "workspace"), { recursive: true });
    writeFileSync(sidecar, "## Legacy custom\nMigrate me below the line.\n", "utf-8");
    const pre = readFileSync(claudeMd, "utf-8");
    const preNoMarker = pre.slice(0, pre.indexOf(CLAUDE_MD_YOURS_MARKER)).trimEnd() + "\n";
    writeFileSync(claudeMd, preNoMarker, "utf-8");

    reconcileAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    const migrated = readFileSync(claudeMd, "utf-8");
    expect(migrated).toContain(CLAUDE_MD_YOURS_MARKER);
    const belowIdx = migrated.indexOf(CLAUDE_MD_YOURS_MARKER) + CLAUDE_MD_YOURS_MARKER.length;
    expect(migrated.slice(belowIdx)).toContain("Migrate me below the line.");
    // Sidecar renamed to .deprecated.
    expect(existsSync(sidecar)).toBe(false);
    expect(existsSync(sidecar + ".deprecated")).toBe(true);

    // Second reconcile: no duplication of migrated content, still one marker.
    reconcileAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const twice = readFileSync(claudeMd, "utf-8");
    expect(twice.split("Migrate me below the line.")).toHaveLength(2);
    expect(twice.split(CLAUDE_MD_YOURS_MARKER)).toHaveLength(2);
  });

  it("below-marker operator edit + managed change → content preserved, NO backup file (no churn)", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    // Operator edits BELOW the marker — the normal, encouraged state.
    const original = readFileSync(claudeMd, "utf-8");
    const markerIdx = original.indexOf(CLAUDE_MD_YOURS_MARKER);
    const aboveWithMarker = original.slice(0, markerIdx + CLAUDE_MD_YOURS_MARKER.length);
    writeFileSync(claudeMd, `${aboveWithMarker}\n\n## My rules\nBe terse.\n`, "utf-8");

    // Managed content changes (simulates a template/release change) —
    // TWICE, to prove no per-apply backup accumulation.
    for (const raw of ["\n\n## Drift one\n", "\n\n## Drift two\n"]) {
      const drifted = makeAgentConfig({ claude_md_raw: raw });
      scaffoldAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));
    }

    const after = readFileSync(claudeMd, "utf-8");
    expect(after).toContain("Drift two");
    expect(after).toContain("Be terse.");
    // No backup churn: below-marker edits are NOT drift.
    const backups = readdirSync(r.agentDir).filter((f) =>
      f.startsWith("CLAUDE.md.before-rerender."),
    );
    expect(backups).toHaveLength(0);
  });

  it("above-marker hand-edit → exactly one backup + managed section regenerated", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    const original = readFileSync(claudeMd, "utf-8");
    writeFileSync(
      claudeMd,
      original.replace(
        CLAUDE_MD_YOURS_MARKER,
        `## SNUCK IN ABOVE\n\n${CLAUDE_MD_YOURS_MARKER}`,
      ),
      "utf-8",
    );

    scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    // A second run after regeneration must NOT produce another backup.
    scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    const after = readFileSync(claudeMd, "utf-8");
    expect(after).not.toContain("SNUCK IN ABOVE");
    const backups = readdirSync(r.agentDir).filter((f) =>
      f.startsWith("CLAUDE.md.before-rerender."),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(r.agentDir, backups[0]!), "utf-8")).toContain("SNUCK IN ABOVE");
  });

  it("legacy pre-marker file with hand-edits → exactly one backup on migration", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    // Simulate a pre-#1857 file: no marker, operator hand-edits, no fingerprint.
    const pre = readFileSync(claudeMd, "utf-8");
    const noMarker =
      pre.slice(0, pre.indexOf(CLAUDE_MD_YOURS_MARKER)).trimEnd() +
      "\n\n## Legacy hand edit\nKeep a copy of me.\n";
    writeFileSync(claudeMd, noMarker, "utf-8");
    rmSync(claudeMd + ".fingerprint");

    scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    // Second run: no further backups.
    scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    const backups = readdirSync(r.agentDir).filter((f) =>
      f.startsWith("CLAUDE.md.before-rerender."),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(r.agentDir, backups[0]!), "utf-8")).toContain("Legacy hand edit");
    expect(readFileSync(claudeMd, "utf-8")).toContain(CLAUDE_MD_YOURS_MARKER);
  });

  it("scaffold after reconcile-driven managed change is a no-op (fingerprint stays in sync)", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    // Reconcile with changed managed content (writes without a fingerprint
    // update — Phase 3 is plain diff-write).
    const drifted = makeAgentConfig({ claude_md_raw: "\n\n## Drift\n" });
    reconcileAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));
    const afterReconcile = readFileSync(claudeMd, "utf-8");

    // Scaffold with the same config: byte-identical render → skipped, no backup.
    const r2 = scaffoldAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));
    expect(r2.skipped).toContain(claudeMd);
    expect(readFileSync(claudeMd, "utf-8")).toBe(afterReconcile);
    const backups = readdirSync(r.agentDir).filter((f) =>
      f.startsWith("CLAUDE.md.before-rerender."),
    );
    expect(backups).toHaveLength(0);
  });

  it("idempotence: consecutive reconciles are a full no-op", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const claudeMd = join(r.agentDir, "CLAUDE.md");

    reconcileAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const first = readFileSync(claudeMd, "utf-8");
    reconcileAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const second = readFileSync(claudeMd, "utf-8");
    expect(second).toBe(first);
  });

  it("first-scaffold and reconcile produce byte-identical CLAUDE.md for the same inputs", () => {
    const config = makeAgentConfig({ claude_md_raw: "\n\n## Raw\nManaged raw content.\n" });

    // Path 1: fresh scaffold.
    const dir1 = mkdtempSync(join(tmpdir(), "two-section-p1-"));
    const r1 = scaffoldAgent("a", config, dir1, telegramConfig, makeSwitchroomConfig("a", config));
    const fromScaffold = readFileSync(join(r1.agentDir, "CLAUDE.md"), "utf-8");

    // Path 2: scaffold a bare agent then reconcile. To compare the managed
    // block deterministically, both start from a fresh placeholder section.
    const dir2 = mkdtempSync(join(tmpdir(), "two-section-p2-"));
    const r2 = scaffoldAgent("a", config, dir2, telegramConfig, makeSwitchroomConfig("a", config));
    reconcileAgent("a", config, dir2, telegramConfig, makeSwitchroomConfig("a", config));
    const fromReconcile = readFileSync(join(r2.agentDir, "CLAUDE.md"), "utf-8");

    expect(fromReconcile).toBe(fromScaffold);

    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });
});
