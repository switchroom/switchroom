/**
 * Unit tests for src/agents/reconcile-default-skills.ts
 *
 * Covers:
 *   (a) symlinks a missing default skill into <agentDir>/.claude/skills/<key>
 *   (b) idempotent — already-correct symlinks are left untouched
 *   (c) refreshes a stale symlink that points elsewhere inside the pool
 *   (d) leaves a foreign symlink (target outside pool) alone, marks conflict
 *   (e) leaves a real dir/file at the destination alone, marks conflict
 *   (f) honours per-agent opt-out (`bundled_skills: { key: false }`)
 *   (g) skips silently when the agent has no .claude/ dir (not yet scaffolded)
 *   (h) skips silently when the pool is missing the skill (trimmed install)
 *   (i) reconcileAllAgentDefaultSkills iterates over agent directories
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileAgentDefaultSkills,
  reconcileAllAgentDefaultSkills,
} from "./reconcile-default-skills.js";
import type { BuiltinSkillEntry } from "../memory/scaffold-integration.js";

// Minimal fixture defaults — three named entries are enough to exercise
// add / opt-out / conflict in one pool.
const FIXTURE_DEFAULTS: BuiltinSkillEntry[] = [
  { key: "skill-a", optOutKey: "skill-a", source: "anthropic" },
  { key: "skill-b", optOutKey: "skill-b", source: "anthropic" },
  { key: "skill-c", optOutKey: "skill-c", source: "switchroom" },
];

function makePool(tmpRoot: string, names: string[]): string {
  const poolDir = join(tmpRoot, "pool");
  for (const name of names) {
    const dir = join(poolDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`, "utf-8");
  }
  return poolDir;
}

function makeAgentDir(tmpRoot: string, name: string, withClaude = true): string {
  const agentDir = join(tmpRoot, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  if (withClaude) mkdirSync(join(agentDir, ".claude"), { recursive: true });
  return agentDir;
}

describe("reconcileAgentDefaultSkills", () => {
  let tmpRoot: string;
  let poolDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-skills-"));
    poolDir = makePool(tmpRoot, ["skill-a", "skill-b", "skill-c"]);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("symlinks every default into <agentDir>/.claude/skills/", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added.sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(result.changed).toBe(true);
    for (const name of ["skill-a", "skill-b", "skill-c"]) {
      const dest = join(agentDir, ".claude", "skills", name);
      expect(lstatSync(dest).isSymbolicLink()).toBe(true);
      expect(readlinkSync(dest)).toBe(join(poolDir, name));
    }
  });

  it("is idempotent — second run produces no additions", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    const second = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent.sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(second.changed).toBe(false);
  });

  it("refreshes a stale symlink whose target is inside the pool dir", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Point skill-a at a different (also pool-dir-prefixed) target — simulates
    // a stale link from a renamed skill in the pool.
    const stalePool = join(poolDir, "old-skill-a");
    mkdirSync(stalePool, { recursive: true });
    symlinkSync(stalePool, join(skillsDir, "skill-a"));

    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added).toContain("skill-a");
    expect(readlinkSync(join(skillsDir, "skill-a"))).toBe(join(poolDir, "skill-a"));
  });

  it("leaves a foreign symlink alone and marks it as a conflict", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const foreignTarget = join(tmpRoot, "operator-custom-skill-a");
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(foreignTarget, join(skillsDir, "skill-a"));

    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.conflicts).toContain("skill-a");
    expect(result.added).not.toContain("skill-a");
    expect(readlinkSync(join(skillsDir, "skill-a"))).toBe(foreignTarget);
  });

  it("leaves a real dir at the destination alone and marks it as a conflict", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const skillsDir = join(agentDir, ".claude", "skills");
    mkdirSync(join(skillsDir, "skill-a"), { recursive: true });
    writeFileSync(join(skillsDir, "skill-a", "SKILL.md"), "operator hand-rolled\n", "utf-8");

    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.conflicts).toContain("skill-a");
    expect(result.added).not.toContain("skill-a");
    // Operator's content survives.
    expect(lstatSync(join(skillsDir, "skill-a")).isDirectory()).toBe(true);
  });

  it("honours per-agent opt-out (`bundled_skills: { key: false }`)", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    const result = reconcileAgentDefaultSkills(
      agentDir,
      { "skill-b": false },
      FIXTURE_DEFAULTS,
      poolDir,
    );
    expect(result.added.sort()).toEqual(["skill-a", "skill-c"]);
    expect(result.optedOut).toEqual(["skill-b"]);
    expect(existsSync(join(agentDir, ".claude", "skills", "skill-b"))).toBe(false);
  });

  it("skips silently when the agent has no .claude/ directory", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1", /*withClaude*/ false);
    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it("skips silently when the pool is missing a skill (trimmed install)", () => {
    const agentDir = makeAgentDir(tmpRoot, "ag1");
    // Re-create the pool without skill-c.
    rmSync(poolDir, { recursive: true, force: true });
    poolDir = makePool(tmpRoot, ["skill-a", "skill-b"]);
    const result = reconcileAgentDefaultSkills(agentDir, {}, FIXTURE_DEFAULTS, poolDir);
    expect(result.added.sort()).toEqual(["skill-a", "skill-b"]);
    expect(result.added).not.toContain("skill-c");
  });
});

describe("reconcileAllAgentDefaultSkills", () => {
  let tmpRoot: string;
  let poolDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sr-skills-all-"));
    poolDir = makePool(tmpRoot, ["skill-a", "skill-b"]);
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("iterates every agent directory and applies opt-outs per agent", () => {
    const agentsDir = join(tmpRoot, "agents");
    makeAgentDir(tmpRoot, "ag1");
    makeAgentDir(tmpRoot, "ag2");
    makeAgentDir(tmpRoot, "ag3");

    const results = reconcileAllAgentDefaultSkills(
      agentsDir,
      { ag2: { "skill-a": false } },
      [
        { key: "skill-a", optOutKey: "skill-a", source: "anthropic" },
        { key: "skill-b", optOutKey: "skill-b", source: "anthropic" },
      ],
      poolDir,
    );

    expect(results).toHaveLength(3);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    expect(byName.ag1.added.sort()).toEqual(["skill-a", "skill-b"]);
    expect(byName.ag2.added).toEqual(["skill-b"]);
    expect(byName.ag2.optedOut).toEqual(["skill-a"]);
    expect(byName.ag3.added.sort()).toEqual(["skill-a", "skill-b"]);
  });

  it("returns [] when the agents dir does not exist", () => {
    const results = reconcileAllAgentDefaultSkills(
      join(tmpRoot, "nonexistent"),
      {},
      FIXTURE_DEFAULTS,
      poolDir,
    );
    expect(results).toEqual([]);
  });
});

describe("getBuiltinDefaultSkillEntries", () => {
  it("ships the expected anthropic + switchroom-core defaults", async () => {
    const { getBuiltinDefaultSkillEntries } = await import(
      "../memory/scaffold-integration.js"
    );
    const entries = getBuiltinDefaultSkillEntries();
    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      "docx",
      "mcp-builder",
      "pdf",
      "pptx",
      "skill-creator",
      "switchroom-cli",
      "switchroom-health",
      "switchroom-status",
      "webapp-testing",
      "xlsx",
    ]);
    // optOutKey is always equal to key today; pin so future renames are deliberate.
    for (const e of entries) {
      expect(e.optOutKey).toBe(e.key);
    }
    // Source attribution is honest about provenance.
    const switchroomEntries = entries.filter((e) => e.source === "switchroom").map((e) => e.key);
    expect(switchroomEntries.sort()).toEqual([
      "switchroom-cli",
      "switchroom-health",
      "switchroom-status",
    ]);
  });
});
