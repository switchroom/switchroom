import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  skillCreate,
  skillEdit,
  skillRead,
  skillDelete,
} from "./agent-config-skill-author.js";
import { agentScopeSkillDir } from "./skill-common.js";

const AGENT = "alice";

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), "skill-author-test-"));
}

function validSkillMd(name: string, desc = "a test skill"): string {
  return `---\nname: ${name}\ndescription: ${desc}\n---\n# body\n`;
}

describe("agent-config-skill-author (PR A)", () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
    delete process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_TURN_SOURCE;
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("creates → reads → edits → deletes the happy path", () => {
    const created = skillCreate({
      agent: AGENT,
      name: "my-skill",
      files: {
        "SKILL.md": validSkillMd("my-skill"),
        "README.md": "hi",
        "scripts/run.sh": "#!/bin/sh\necho hi\n",
      },
      root,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.slug).toBe("my-skill");
    expect(created.files).toContain("SKILL.md");
    expect(existsSync(join(created.path, "SKILL.md"))).toBe(true);

    const summary = skillRead({ agent: AGENT, name: "my-skill", root });
    expect(summary.ok).toBe(true);
    if (!summary.ok || !("files" in summary)) throw new Error("expected tree");
    expect(summary.files.sort()).toEqual(
      ["README.md", "SKILL.md", "scripts/run.sh"],
    );
    expect(summary.frontmatter?.name).toBe("my-skill");

    const fileRead = skillRead({
      agent: AGENT, name: "my-skill", file: "SKILL.md", root,
    });
    if (!fileRead.ok || !("content" in fileRead)) throw new Error("expected content");
    expect(fileRead.content).toContain("description:");
    expect(typeof fileRead.version).toBe("string");

    const edited = skillEdit({
      agent: AGENT,
      name: "my-skill",
      file: "SKILL.md",
      content: validSkillMd("my-skill", "updated"),
      version: fileRead.version,
      root,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(readFileSync(join(created.path, "SKILL.md"), "utf-8"))
      .toContain("updated");

    const del = skillDelete({ agent: AGENT, name: "my-skill", root });
    expect(del.ok).toBe(true);
    expect(existsSync(created.path)).toBe(false);
  });

  it("rejects path traversal in create", () => {
    const r = skillCreate({
      agent: AGENT,
      name: "evil",
      files: {
        "SKILL.md": validSkillMd("evil"),
        "../escape.sh": "boom",
      },
      root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_INVALID_PATH");
  });

  it("rejects unknown paths not in allowlist", () => {
    const r = skillCreate({
      agent: AGENT,
      name: "x",
      files: {
        "SKILL.md": validSkillMd("x"),
        "lib/things.js": "code",
      },
      root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_INVALID_PATH");
  });

  it("rejects frontmatter with mismatched name", () => {
    const r = skillCreate({
      agent: AGENT,
      name: "real-name",
      files: { "SKILL.md": validSkillMd("wrong-name") },
      root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_INVALID_FRONTMATTER");
  });

  it("rejects duplicate frontmatter keys", () => {
    const dup = `---\nname: dup\ndescription: a\nname: dup\n---\n`;
    const r = skillCreate({
      agent: AGENT, name: "dup", files: { "SKILL.md": dup }, root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_INVALID_FRONTMATTER");
  });

  it("refuses to edit through a symlink (TOCTOU)", () => {
    // Create the skill normally.
    const created = skillCreate({
      agent: AGENT, name: "victim",
      files: { "SKILL.md": validSkillMd("victim") }, root,
    });
    if (!created.ok) throw new Error("create failed");
    const target = join(created.path, "SKILL.md");
    // Replace the real file with a symlink to /tmp.
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "owned");
    unlinkSync(target);
    symlinkSync(outside, target);
    const fileRead = skillRead({
      agent: AGENT, name: "victim", root,
    });
    if (!fileRead.ok || !("version" in fileRead)) throw new Error("read failed");
    const r = skillEdit({
      agent: AGENT, name: "victim", file: "SKILL.md",
      content: validSkillMd("victim", "pwned"),
      version: fileRead.version, root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_INVALID_PATH");
    // The outside target must NOT have been overwritten.
    expect(readFileSync(outside, "utf-8")).toBe("owned");
  });

  it("rejects stale version on concurrent edit", () => {
    const created = skillCreate({
      agent: AGENT, name: "race",
      files: { "SKILL.md": validSkillMd("race") }, root,
    });
    if (!created.ok) throw new Error("create failed");
    const v0 = created.version;
    // First edit bumps mtime → version.
    const first = skillEdit({
      agent: AGENT, name: "race", file: "SKILL.md",
      content: validSkillMd("race", "v1"), version: v0, root,
    });
    expect(first.ok).toBe(true);
    // Second edit with the stale token must fail.
    const second = skillEdit({
      agent: AGENT, name: "race", file: "SKILL.md",
      content: validSkillMd("race", "v2"), version: v0, root,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("E_SKILL_VERSION_STALE");
  });

  it("denies create when run from a cron-fired turn", () => {
    process.env.SWITCHROOM_TURN_SOURCE = "cron";
    const r = skillCreate({
      agent: AGENT, name: "x",
      files: { "SKILL.md": validSkillMd("x") }, root,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_AUTHOR_REQUIRES_INTERACTIVE");
  });

  it("delete refuses if path is a symlink (bundled-skill install)", () => {
    // Materialize a fake symlink in place of a skill dir.
    const dir = agentScopeSkillDir(AGENT, "bundled-thing", root);
    mkdirSync(join(root, AGENT, ".claude", "skills"), { recursive: true });
    const fakeTarget = join(root, "_pool");
    mkdirSync(fakeTarget);
    symlinkSync(fakeTarget, dir);
    const r = skillDelete({ agent: AGENT, name: "bundled-thing", root });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_INVALID_PATH");
    expect(existsSync(dir)).toBe(true); // still there
  });

  it("rejects create when dir already exists", () => {
    const first = skillCreate({
      agent: AGENT, name: "twice",
      files: { "SKILL.md": validSkillMd("twice") }, root,
    });
    expect(first.ok).toBe(true);
    const second = skillCreate({
      agent: AGENT, name: "twice",
      files: { "SKILL.md": validSkillMd("twice") }, root,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("E_SKILL_ALREADY_EXISTS");
  });
});
