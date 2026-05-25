import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listBundledSkills,
  listPersonalSkills,
  listSharedSkills,
  readSkillFrontmatter,
  searchSkills,
} from "./skill-search.js";

const AGENT = "test-agent";

function validSkillMd(name: string, opts: { jtbd?: string; description?: string } = {}): string {
  const desc = opts.description ?? `Test skill ${name}`;
  const jtbd = opts.jtbd ? `\njtbd: ${opts.jtbd}` : "";
  return `---
name: ${name}
description: ${desc}${jtbd}
---

# ${name}

Body.
`;
}

function writeSkillDir(dir: string, name: string, opts?: { jtbd?: string; description?: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), validSkillMd(name, opts ?? {}));
}

describe("readSkillFrontmatter", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-search-fm-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when SKILL.md is absent", () => {
    expect(readSkillFrontmatter(root)).toBeNull();
  });

  it("parses well-formed frontmatter", () => {
    writeSkillDir(root, "foo", { jtbd: "do the foo job" });
    const r = readSkillFrontmatter(root);
    expect(r?.fm?.name).toBe("foo");
    expect(r?.fm?.jtbd).toBe("do the foo job");
    expect(r?.error).toBeUndefined();
  });

  it("returns error when frontmatter delimiter is missing", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "# no frontmatter here\n");
    const r = readSkillFrontmatter(root);
    expect(r?.error).toMatch(/leading.*frontmatter/);
  });

  it("returns error when closing delimiter is missing", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "---\nname: foo\ndescription: x\n");
    const r = readSkillFrontmatter(root);
    expect(r?.error).toMatch(/closing/);
  });

  it("returns error when frontmatter is not a YAML mapping", () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "---\n- foo\n- bar\n---\n");
    const r = readSkillFrontmatter(root);
    expect(r?.error).toMatch(/mapping/);
  });
});

describe("listPersonalSkills", () => {
  let agentsRoot: string;
  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "skill-search-p-"));
  });
  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("returns [] when agent dir does not exist", () => {
    expect(listPersonalSkills(AGENT, agentsRoot)).toEqual([]);
  });

  it("returns [] when .claude/skills is missing", () => {
    mkdirSync(join(agentsRoot, AGENT), { recursive: true });
    expect(listPersonalSkills(AGENT, agentsRoot)).toEqual([]);
  });

  it("only enumerates dirs with the personal- prefix", () => {
    const skills = join(agentsRoot, AGENT, ".claude/skills");
    writeSkillDir(join(skills, "personal-foo"), "foo");
    writeSkillDir(join(skills, "personal-bar"), "bar");
    // Non-personal dirs should be ignored.
    writeSkillDir(join(skills, "switchroom-cli"), "switchroom-cli");
    const r = listPersonalSkills(AGENT, agentsRoot);
    const names = r.map((e) => e.name).sort();
    expect(names).toEqual(["bar", "foo"]);
    expect(r.every((e) => e.tier === "personal")).toBe(true);
    expect(r.every((e) => e.agent === AGENT)).toBe(true);
  });

  it("surfaces malformed SKILL.md with error but still lists the entry", () => {
    const skills = join(agentsRoot, AGENT, ".claude/skills");
    const dir = join(skills, "personal-broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter\n");
    const r = listPersonalSkills(AGENT, agentsRoot);
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe("broken");
    expect(r[0]!.error).toMatch(/frontmatter/);
  });
});

describe("listSharedSkills", () => {
  let sharedRoot: string;
  beforeEach(() => {
    sharedRoot = mkdtempSync(join(tmpdir(), "skill-search-s-"));
  });
  afterEach(() => {
    rmSync(sharedRoot, { recursive: true, force: true });
  });

  it("returns [] when shared dir is empty", () => {
    expect(listSharedSkills(sharedRoot)).toEqual([]);
  });

  it("enumerates shared skills, excludes _bundled subdir and dotdirs", () => {
    writeSkillDir(join(sharedRoot, "alpha"), "alpha");
    writeSkillDir(join(sharedRoot, "beta"), "beta");
    writeSkillDir(join(sharedRoot, "_bundled", "gamma"), "gamma");
    writeSkillDir(join(sharedRoot, ".hidden"), "hidden");
    const r = listSharedSkills(sharedRoot);
    expect(r.map((e) => e.name).sort()).toEqual(["alpha", "beta"]);
    expect(r.every((e) => e.tier === "shared")).toBe(true);
  });
});

describe("listBundledSkills", () => {
  let bundledRoot: string;
  beforeEach(() => {
    bundledRoot = mkdtempSync(join(tmpdir(), "skill-search-b-"));
  });
  afterEach(() => {
    rmSync(bundledRoot, { recursive: true, force: true });
  });

  it("enumerates bundled skills", () => {
    writeSkillDir(join(bundledRoot, "switchroom-cli"), "switchroom-cli");
    writeSkillDir(join(bundledRoot, "mcp-builder"), "mcp-builder");
    const r = listBundledSkills(bundledRoot);
    expect(r.map((e) => e.name).sort()).toEqual(["mcp-builder", "switchroom-cli"]);
    expect(r.every((e) => e.tier === "bundled")).toBe(true);
  });
});

describe("searchSkills", () => {
  let agentsRoot: string;
  let sharedRoot: string;
  let bundledRoot: string;
  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "skill-search-all-a-"));
    sharedRoot = mkdtempSync(join(tmpdir(), "skill-search-all-s-"));
    bundledRoot = mkdtempSync(join(tmpdir(), "skill-search-all-b-"));
    // Personal: morning-report (for AGENT)
    writeSkillDir(
      join(agentsRoot, AGENT, ".claude/skills/personal-morning-report"),
      "morning-report",
      { jtbd: "summarise overnight events" },
    );
    // Shared: telegram-sender
    writeSkillDir(
      join(sharedRoot, "telegram-sender"),
      "telegram-sender",
      { jtbd: "deliver structured messages to chat" },
    );
    // Bundled: switchroom-cli, mcp-builder
    writeSkillDir(join(bundledRoot, "switchroom-cli"), "switchroom-cli");
    writeSkillDir(
      join(bundledRoot, "mcp-builder"),
      "mcp-builder",
      { description: "Author new MCP servers" },
    );
  });
  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(sharedRoot, { recursive: true, force: true });
    rmSync(bundledRoot, { recursive: true, force: true });
  });

  it("returns all tiers when tier=any and agent is provided", () => {
    const r = searchSkills({
      agent: AGENT,
      tier: "any",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.map((e) => `${e.tier}/${e.name}`)).toEqual([
      "personal/morning-report",
      "shared/telegram-sender",
      "bundled/mcp-builder",
      "bundled/switchroom-cli",
    ]);
  });

  it("omits personal tier when no agent is provided", () => {
    const r = searchSkills({
      tier: "any",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.find((e) => e.tier === "personal")).toBeUndefined();
    expect(r.length).toBe(3);
  });

  it("filters to a single tier", () => {
    const r = searchSkills({
      tier: "bundled",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.every((e) => e.tier === "bundled")).toBe(true);
    expect(r.length).toBe(2);
  });

  it("query matches against name", () => {
    const r = searchSkills({
      agent: AGENT,
      query: "morning",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.length).toBe(1);
    expect(r[0]!.name).toBe("morning-report");
  });

  it("query matches against description", () => {
    const r = searchSkills({
      agent: AGENT,
      query: "MCP servers",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.length).toBe(1);
    expect(r[0]!.name).toBe("mcp-builder");
  });

  it("query matches against jtbd", () => {
    const r = searchSkills({
      agent: AGENT,
      query: "deliver structured",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.length).toBe(1);
    expect(r[0]!.name).toBe("telegram-sender");
  });

  it("query is case-insensitive", () => {
    const r = searchSkills({
      agent: AGENT,
      query: "MORNING",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.length).toBe(1);
    expect(r[0]!.name).toBe("morning-report");
  });

  it("limit caps the result count", () => {
    const r = searchSkills({
      agent: AGENT,
      tier: "any",
      limit: 2,
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r.length).toBe(2);
    expect(r[0]!.tier).toBe("personal");
    expect(r[1]!.tier).toBe("shared");
  });

  it("returns [] when query matches nothing", () => {
    const r = searchSkills({
      agent: AGENT,
      query: "nonexistent-xyzzy",
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r).toEqual([]);
  });

  it("limit is bounded to [1, 500]", () => {
    const r1 = searchSkills({
      agent: AGENT,
      tier: "any",
      limit: 0,
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(r1.length).toBeGreaterThanOrEqual(1);
    const rBig = searchSkills({
      agent: AGENT,
      tier: "any",
      limit: 1_000_000,
      agentsRoot,
      sharedRoot,
      bundledRoot,
    });
    expect(rBig.length).toBeLessThanOrEqual(500);
  });
});
