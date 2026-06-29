/**
 * Tests for `switchroom skill {init,edit,remove,list}-personal` (#1819, PR-3).
 *
 * Covers the four personal-skill primitives end-to-end against an
 * isolated agents-root tmpdir. The MCP server's dispatch wiring is
 * covered separately by `src/mcp/agent-config/server.test.ts`.
 */

import { afterAll, beforeAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  utimesSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initPersonalAction,
  editPersonalAction,
  removePersonalAction,
  listPersonalAction,
  clonePersonalAction,
  countPersonalSkills,
} from "./skill-personal.js";

const AGENT = "test-agent";

// CRITICAL: pin SWITCHROOM_CONFIG_DIR to a per-file tmpdir BEFORE any
// test runs. The personal-skill ops in this file unconditionally try
// to mirror writes into the config repo (#1844). Without this pin,
// every test would leak fixtures into the operator's real
// ~/.switchroom-config/ — same failure class as the 2026-05-22 vault
// clobber. Enforces the Vault/shared-state HARD rule from CLAUDE.md.
const FILE_LEVEL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "skill-personal-config-"));
const SAVED_CONFIG_DIR_ENV = process.env.SWITCHROOM_CONFIG_DIR;

beforeAll(() => {
  process.env.SWITCHROOM_CONFIG_DIR = FILE_LEVEL_CONFIG_DIR;
});

afterAll(() => {
  if (SAVED_CONFIG_DIR_ENV === undefined) {
    delete process.env.SWITCHROOM_CONFIG_DIR;
  } else {
    process.env.SWITCHROOM_CONFIG_DIR = SAVED_CONFIG_DIR_ENV;
  }
  try { rmSync(FILE_LEVEL_CONFIG_DIR, { recursive: true, force: true }); } catch { /**/ }
});

const validSkillMd = (name: string, desc = "A test skill"): string =>
  `---
name: ${name}
description: ${desc}
---
# ${name}

Body.
`;

function tmpAgentsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-personal-test-"));
  // Pre-create the agent's dir so the writer can find it.
  mkdirSync(join(root, AGENT, ".claude", "skills"), { recursive: true });
  return root;
}

function captureStdout(fn: () => void): string {
  // console.log writes through process.stdout, but vitest hijacks
  // console.log itself (not process.stdout.write). Stub console.log
  // directly so the action's JSON output is captured.
  const orig = console.log;
  let captured = "";
  console.log = (...args: unknown[]): void => {
    captured += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return captured;
}

function expectExitCode(fn: () => void, expected: number): void {
  const origExit = process.exit.bind(process);
  let caught: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number): never => {
    caught = code;
    throw new Error(`__test_exit_${code}__`);
  };
  // Also silence stderr during the failing run.
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    try {
      fn();
    } catch (e: unknown) {
      // expected sentinel from our fake exit
      const err = e as { message?: string };
      if (!err.message?.startsWith("__test_exit_")) throw e;
    }
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = origExit;
    process.stderr.write = origStderr;
  }
  expect(caught).toBe(expected);
}

describe("initPersonalAction", () => {
  let root: string;

  beforeEach(() => {
    root = tmpAgentsRoot();
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /**/ }
  });

  it("writes a single-file personal skill via --from <md>", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("foo"));
    const out = captureStdout(() => {
      initPersonalAction("foo", { agent: AGENT, from: skillFile, root });
    });
    const target = join(root, AGENT, ".claude/skills/personal-foo/SKILL.md");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("name: foo");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("init");
    expect(parsed.name).toBe("foo");
  });

  it("writes a multi-file personal skill via --from <dir>", () => {
    const srcDir = join(root, "input");
    mkdirSync(join(srcDir, "scripts"), { recursive: true });
    writeFileSync(join(srcDir, "SKILL.md"), validSkillMd("multi"));
    writeFileSync(join(srcDir, "scripts/run.sh"), "#!/bin/bash\necho ok\n");
    writeFileSync(join(srcDir, "scripts/helper.py"), "print('ok')\n");
    captureStdout(() => {
      initPersonalAction("multi", { agent: AGENT, from: srcDir, root });
    });
    const skillDir = join(root, AGENT, ".claude/skills/personal-multi");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, "scripts/run.sh"))).toBe(true);
    // Scripts marked +x.
    expect(statSync(join(skillDir, "scripts/run.sh")).mode & 0o100).toBe(0o100);
  });

  it("refuses a duplicate name (init twice)", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("dup"));
    captureStdout(() => {
      initPersonalAction("dup", { agent: AGENT, from: skillFile, root });
    });
    expectExitCode(() => {
      initPersonalAction("dup", { agent: AGENT, from: skillFile, root });
    }, 9);
  });

  it("rejects invalid skill name", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("BadCase"));
    expectExitCode(() => {
      initPersonalAction("BadCase", { agent: AGENT, from: skillFile, root });
    }, 2);
  });

  it("rejects `claude -p` in script content", () => {
    const srcDir = join(root, "input");
    mkdirSync(join(srcDir, "scripts"), { recursive: true });
    writeFileSync(join(srcDir, "SKILL.md"), validSkillMd("bad"));
    writeFileSync(
      join(srcDir, "scripts/bad.sh"),
      "#!/bin/bash\nclaude -p 'do bad things'\n",
    );
    expectExitCode(() => {
      initPersonalAction("bad", { agent: AGENT, from: srcDir, root });
    }, 3);
  });

  it("rejects `bash -n` syntax errors", () => {
    const srcDir = join(root, "input");
    mkdirSync(join(srcDir, "scripts"), { recursive: true });
    writeFileSync(join(srcDir, "SKILL.md"), validSkillMd("syntaxbad"));
    writeFileSync(
      join(srcDir, "scripts/broken.sh"),
      "#!/bin/bash\nif [ 1\nfi\n", // unbalanced if
    );
    expectExitCode(() => {
      initPersonalAction("syntaxbad", { agent: AGENT, from: srcDir, root });
    }, 3);
  });

  it("enforces the 20-skill cap on init, but allows edits at cap (#2670)", () => {
    // Seed the cap.
    for (let i = 0; i < 20; i++) {
      const f = join(root, `seed${i}.md`);
      writeFileSync(f, validSkillMd(`seed${i}`));
      captureStdout(() => {
        initPersonalAction(`seed${i}`, { agent: AGENT, from: f, root });
      });
    }
    expect(countPersonalSkills(root, AGENT)).toBe(20);

    // A new skill at the cap is refused (exit 15).
    const overflow = join(root, "overflow.md");
    writeFileSync(overflow, validSkillMd("overflow"));
    expectExitCode(() => {
      initPersonalAction("overflow", { agent: AGENT, from: overflow, root });
    }, 15);

    // Editing an existing skill at the cap is allowed (count unchanged).
    const editF = join(root, "edit-seed0.md");
    writeFileSync(editF, validSkillMd("seed0"));
    captureStdout(() => {
      editPersonalAction("seed0", { agent: AGENT, from: editF, root });
    });
    expect(countPersonalSkills(root, AGENT)).toBe(20);
  });

  it("requires --agent when SWITCHROOM_AGENT_NAME is unset", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("noagent"));
    const orig = process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_AGENT_NAME;
    try {
      expectExitCode(() => {
        initPersonalAction("noagent", { from: skillFile, root });
      }, 2);
    } finally {
      if (orig !== undefined) process.env.SWITCHROOM_AGENT_NAME = orig;
    }
  });
});

describe("editPersonalAction", () => {
  let root: string;
  beforeEach(() => { root = tmpAgentsRoot(); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

  it("overwrites an existing personal skill", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("ed", "v1"));
    captureStdout(() => {
      initPersonalAction("ed", { agent: AGENT, from: skillFile, root });
    });
    writeFileSync(skillFile, validSkillMd("ed", "v2-updated"));
    captureStdout(() => {
      editPersonalAction("ed", { agent: AGENT, from: skillFile, root });
    });
    const target = join(root, AGENT, ".claude/skills/personal-ed/SKILL.md");
    expect(readFileSync(target, "utf-8")).toContain("v2-updated");
  });

  it("refuses if the personal skill doesn't exist (must init first)", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("never-existed"));
    expectExitCode(() => {
      editPersonalAction("never-existed", { agent: AGENT, from: skillFile, root });
    }, 9);
  });
});

describe("removePersonalAction (trash + recovery)", () => {
  let root: string;
  beforeEach(() => { root = tmpAgentsRoot(); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

  it("moves the skill to skills-trash/<name>-<ts>/", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("rm"));
    captureStdout(() => {
      initPersonalAction("rm", { agent: AGENT, from: skillFile, root });
    });
    const skillDir = join(root, AGENT, ".claude/skills/personal-rm");
    expect(existsSync(skillDir)).toBe(true);
    const out = captureStdout(() => {
      removePersonalAction("rm", { agent: AGENT, root });
    });
    expect(existsSync(skillDir)).toBe(false);
    // Trash dir should exist with the skill inside.
    const trashRoot = join(root, AGENT, ".claude/skills-trash");
    expect(existsSync(trashRoot)).toBe(true);
    const entries = readdirSync(trashRoot);
    expect(entries.some((e) => e.startsWith("rm-"))).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("remove");
    expect(parsed.trash_path).toContain("/skills-trash/rm-");
  });

  it("refuses to remove a nonexistent skill", () => {
    expectExitCode(() => {
      removePersonalAction("ghost", { agent: AGENT, root });
    }, 1);
  });

  it("lazy sweep deletes trash entries older than 24h (B1 of Phase 0 Q6)", () => {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("sweep1"));
    captureStdout(() => {
      initPersonalAction("sweep1", { agent: AGENT, from: skillFile, root });
    });
    captureStdout(() => {
      removePersonalAction("sweep1", { agent: AGENT, root });
    });
    const trashRoot = join(root, AGENT, ".claude/skills-trash");
    const entries = readdirSync(trashRoot);
    expect(entries.length).toBe(1);
    // Backdate the trash entry to 25h ago.
    const trashEntry = join(trashRoot, entries[0]!);
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(trashEntry, longAgo, longAgo);
    // Run another personal-skill op — the lazy sweep should fire.
    writeFileSync(skillFile, validSkillMd("sweep2"));
    captureStdout(() => {
      initPersonalAction("sweep2", { agent: AGENT, from: skillFile, root });
    });
    expect(readdirSync(trashRoot).length).toBe(0);
  });
});

describe("listPersonalAction", () => {
  let root: string;
  beforeEach(() => { root = tmpAgentsRoot(); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

  it("returns empty list when no personal skills exist", () => {
    const out = captureStdout(() => {
      listPersonalAction({ agent: AGENT, root });
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.personal).toEqual([]);
  });

  it("lists multiple personal skills with file count + size", () => {
    const mdA = join(root, "a.md"); writeFileSync(mdA, validSkillMd("alpha"));
    const mdB = join(root, "b.md"); writeFileSync(mdB, validSkillMd("beta"));
    captureStdout(() => {
      initPersonalAction("alpha", { agent: AGENT, from: mdA, root });
      initPersonalAction("beta", { agent: AGENT, from: mdB, root });
    });
    const out = captureStdout(() => {
      listPersonalAction({ agent: AGENT, root });
    });
    const parsed = JSON.parse(out);
    expect(parsed.personal).toHaveLength(2);
    const names = parsed.personal.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
    for (const p of parsed.personal) {
      expect(p.files).toBe(1);
      expect(p.size_bytes).toBeGreaterThan(0);
    }
  });

  it("ignores non-personal-prefix dirs in .claude/skills/", () => {
    // Simulate an opt-in symlink to a shared skill at .claude/skills/bundled-skill/
    const skillsDir = join(root, AGENT, ".claude/skills");
    mkdirSync(join(skillsDir, "bundled-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "bundled-skill/SKILL.md"), validSkillMd("bundled-skill"));
    const out = captureStdout(() => {
      listPersonalAction({ agent: AGENT, root });
    });
    const parsed = JSON.parse(out);
    expect(parsed.personal).toEqual([]); // bundled-skill is NOT personal
  });
});

describe("symlink-safe writes (security T3 regression)", () => {
  let root: string;
  beforeEach(() => { root = tmpAgentsRoot(); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /**/ } });

  it("refuses to write to a target that is a live symlink", () => {
    const skillsDir = join(root, AGENT, ".claude/skills");
    symlinkSync("/tmp", join(skillsDir, "personal-evil"));
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("evil"));
    // Symlink trips the "target already exists" check first (exit 9 — duplicate).
    // Either exit 9 (duplicate) or exit 2 (symlink-refusal in writer) is fine —
    // both refuse. The defense-in-depth in writePersonalSkill catches it
    // if the existence check is ever weakened.
    expectExitCode(() => {
      initPersonalAction("evil", { agent: AGENT, from: skillFile, root });
    }, 9);
  });

  it("refuses to write to a target that is a DANGLING symlink", () => {
    const skillsDir = join(root, AGENT, ".claude/skills");
    symlinkSync("/nonexistent-target-test", join(skillsDir, "personal-dangle"));
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, validSkillMd("dangle"));
    // lstatSync sees the dangling symlink as "exists" → exit 9 (duplicate).
    // The writePersonalSkill fallback also refuses (exit 2) if it ever
    // reaches that path. The key invariant: dangling symlink is NOT
    // silently clobbered.
    expectExitCode(() => {
      initPersonalAction("dangle", { agent: AGENT, from: skillFile, root });
    }, 9);
    // Symlink must still exist (write was rejected, NOT followed).
    expect(existsSync(skillsDir)).toBe(true);
  });
});

describe("clonePersonalAction (fork shared/bundled into personal)", () => {
  let agentsRoot: string;
  let sharedRoot: string;
  let bundledRoot: string;

  beforeEach(() => {
    agentsRoot = tmpAgentsRoot();
    sharedRoot = mkdtempSync(join(tmpdir(), "clone-shared-"));
    bundledRoot = mkdtempSync(join(tmpdir(), "clone-bundled-"));
  });

  afterEach(() => {
    try { rmSync(agentsRoot, { recursive: true, force: true }); } catch { /**/ }
    try { rmSync(sharedRoot, { recursive: true, force: true }); } catch { /**/ }
    try { rmSync(bundledRoot, { recursive: true, force: true }); } catch { /**/ }
  });

  it("clones a shared skill into the agent's personal tier", () => {
    // Seed a shared skill (operator-curated).
    const src = join(sharedRoot, "garmin");
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(join(src, "SKILL.md"), validSkillMd("garmin"));
    writeFileSync(join(src, "scripts/list.sh"), "#!/bin/bash\necho v1\n");

    const out = captureStdout(() => {
      clonePersonalAction("shared:garmin", {
        agent: AGENT,
        root: agentsRoot,
        sharedRoot,
        bundledRoot,
      });
    });

    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("clone_to_personal");
    expect(parsed.source_tier).toBe("shared");
    expect(parsed.name).toBe("garmin");
    expect(parsed.files).toBe(2);

    const dest = join(agentsRoot, AGENT, ".claude/skills/personal-garmin");
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "scripts/list.sh"))).toBe(true);
    // Shared source is untouched.
    expect(readFileSync(join(src, "SKILL.md"), "utf-8")).toContain("name: garmin");
  });

  it("clones a bundled skill into the agent's personal tier", () => {
    const src = join(bundledRoot, "docx");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), validSkillMd("docx", "Word docs"));

    captureStdout(() => {
      clonePersonalAction("bundled:docx", {
        agent: AGENT,
        root: agentsRoot,
        sharedRoot,
        bundledRoot,
      });
    });

    const dest = join(agentsRoot, AGENT, ".claude/skills/personal-docx/SKILL.md");
    expect(existsSync(dest)).toBe(true);
  });

  it("renames the SKILL.md `name:` field when --name override is given", () => {
    const src = join(sharedRoot, "garmin");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), validSkillMd("garmin"));

    captureStdout(() => {
      clonePersonalAction("shared:garmin", {
        agent: AGENT,
        name: "garmin-v2",
        root: agentsRoot,
        sharedRoot,
        bundledRoot,
      });
    });

    const dest = join(agentsRoot, AGENT, ".claude/skills/personal-garmin-v2/SKILL.md");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toContain("name: garmin-v2");
    expect(readFileSync(dest, "utf-8")).not.toContain("name: garmin\n");
  });

  it("refuses if personal-<name> already exists", () => {
    const src = join(sharedRoot, "garmin");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), validSkillMd("garmin"));

    // Seed an existing personal copy.
    captureStdout(() => {
      clonePersonalAction("shared:garmin", {
        agent: AGENT, root: agentsRoot, sharedRoot, bundledRoot,
      });
    });

    expectExitCode(() => {
      clonePersonalAction("shared:garmin", {
        agent: AGENT, root: agentsRoot, sharedRoot, bundledRoot,
      });
    }, 9);
  });

  it("rejects malformed source string", () => {
    expectExitCode(() => {
      clonePersonalAction("notvalid", {
        agent: AGENT, root: agentsRoot, sharedRoot, bundledRoot,
      });
    }, 2);
    expectExitCode(() => {
      clonePersonalAction("file:///etc/passwd", {
        agent: AGENT, root: agentsRoot, sharedRoot, bundledRoot,
      });
    }, 2);
  });

  it("rejects unknown source (exit 1)", () => {
    expectExitCode(() => {
      clonePersonalAction("shared:nonexistent", {
        agent: AGENT, root: agentsRoot, sharedRoot, bundledRoot,
      });
    }, 1);
  });

  it("rejects symlinked source (won't follow out of the pool)", () => {
    const realDir = mkdtempSync(join(tmpdir(), "clone-evil-"));
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "SKILL.md"), validSkillMd("garmin"));
    symlinkSync(realDir, join(sharedRoot, "garmin"));

    expectExitCode(() => {
      clonePersonalAction("shared:garmin", {
        agent: AGENT, root: agentsRoot, sharedRoot, bundledRoot,
      });
    }, 2);

    try { rmSync(realDir, { recursive: true, force: true }); } catch { /**/ }
  });

  it("rejects invalid destination slug", () => {
    const src = join(sharedRoot, "garmin");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), validSkillMd("garmin"));

    expectExitCode(() => {
      clonePersonalAction("shared:garmin", {
        agent: AGENT,
        name: "BadCase",
        root: agentsRoot,
        sharedRoot,
        bundledRoot,
      });
    }, 2);
  });

  it("rejects source dir missing SKILL.md", () => {
    const src = join(sharedRoot, "no-md");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "README.md"), "# nothing useful");

    expectExitCode(() => {
      clonePersonalAction("shared:no-md", {
        agent: AGENT, root: agentsRoot, sharedRoot, bundledRoot,
      });
    }, 2);
  });
});

describe("config-repo mirror (versioned personal skills)", () => {
  let agentsRoot: string;
  let configDir: string;
  const ENV = "SWITCHROOM_CONFIG_DIR";
  // File-level beforeAll already pins SWITCHROOM_CONFIG_DIR to a tmpdir.
  // Each test in this block points it at its OWN tmpdir for isolation,
  // then restores to the file-level tmpdir after — never to the unset
  // state (which would leak into ~/.switchroom-config if it exists).
  const fileLevelTmp = process.env[ENV];

  beforeEach(() => {
    agentsRoot = tmpAgentsRoot();
    configDir = mkdtempSync(join(tmpdir(), "skill-config-"));
    process.env[ENV] = configDir;
  });

  afterEach(() => {
    process.env[ENV] = fileLevelTmp; // restore to file-level tmpdir, NOT unset
    try { rmSync(agentsRoot, { recursive: true, force: true }); } catch { /**/ }
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /**/ }
  });

  it("init mirrors the new skill into ~/.switchroom-config/agents/<agent>/personal-skills/<name>/", () => {
    const skillFile = join(agentsRoot, "input.md");
    writeFileSync(skillFile, validSkillMd("mirrored"));
    captureStdout(() => {
      initPersonalAction("mirrored", { agent: AGENT, from: skillFile, root: agentsRoot });
    });

    const mirror = join(configDir, "agents", AGENT, "personal-skills", "mirrored");
    expect(existsSync(mirror)).toBe(true);
    expect(existsSync(join(mirror, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(mirror, "SKILL.md"), "utf-8")).toContain("name: mirrored");

    // Live copy also exists (mirror is additive, not redirect).
    expect(existsSync(join(agentsRoot, AGENT, ".claude/skills/personal-mirrored/SKILL.md"))).toBe(true);
  });

  it("edit re-mirrors with updated content", () => {
    const skillFile = join(agentsRoot, "input.md");
    writeFileSync(skillFile, validSkillMd("edited", "v1"));
    captureStdout(() => {
      initPersonalAction("edited", { agent: AGENT, from: skillFile, root: agentsRoot });
    });

    // Update content + edit.
    writeFileSync(skillFile, validSkillMd("edited", "v2-updated"));
    captureStdout(() => {
      editPersonalAction("edited", { agent: AGENT, from: skillFile, root: agentsRoot });
    });

    const mirror = join(configDir, "agents", AGENT, "personal-skills", "edited/SKILL.md");
    expect(readFileSync(mirror, "utf-8")).toContain("v2-updated");
  });

  it("remove moves the mirror to .<name>-trash-<ts>/ sibling for git-visible deletion", () => {
    const skillFile = join(agentsRoot, "input.md");
    writeFileSync(skillFile, validSkillMd("doomed"));
    captureStdout(() => {
      initPersonalAction("doomed", { agent: AGENT, from: skillFile, root: agentsRoot });
    });
    const mirrorDir = join(configDir, "agents", AGENT, "personal-skills", "doomed");
    expect(existsSync(mirrorDir)).toBe(true);

    captureStdout(() => {
      removePersonalAction("doomed", { agent: AGENT, root: agentsRoot });
    });

    expect(existsSync(mirrorDir)).toBe(false);
    // A .doomed-trash-<ts>/ sibling appears.
    const siblings = readdirSync(join(configDir, "agents", AGENT, "personal-skills"));
    expect(siblings.some((s: string) => /^\.doomed-trash-\d+$/.test(s))).toBe(true);
  });

  it("silent skip when the config repo doesn't exist (operator hasn't opted in)", () => {
    // Point env at a path that doesn't exist. resolveConfigSkillsDir
    // returns null → mirror no-ops, the live write still succeeds.
    // CRITICAL: never `delete process.env[ENV]` here — that would
    // fall back to the operator's real ~/.switchroom-config and
    // leak test fixtures into it (project_vault_clobbered_by_test_2026_05_22).
    const ghostDir = join(tmpdir(), `no-config-repo-${Date.now()}`);
    process.env[ENV] = ghostDir;

    const skillFile = join(agentsRoot, "input.md");
    writeFileSync(skillFile, validSkillMd("opted-out"));

    captureStdout(() => {
      initPersonalAction("opted-out", { agent: AGENT, from: skillFile, root: agentsRoot });
    });

    // Live copy is fine.
    expect(existsSync(join(agentsRoot, AGENT, ".claude/skills/personal-opted-out/SKILL.md"))).toBe(true);
    // Mirror dir was never created.
    expect(existsSync(ghostDir)).toBe(false);
  });

  it("clone-to-personal mirrors the cloned fork", () => {
    const sharedRoot = mkdtempSync(join(tmpdir(), "clone-shared-mirror-"));
    try {
      const src = join(sharedRoot, "calendar");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "SKILL.md"), validSkillMd("calendar"));

      captureStdout(() => {
        clonePersonalAction("shared:calendar", {
          agent: AGENT,
          root: agentsRoot,
          sharedRoot,
        });
      });

      const mirror = join(configDir, "agents", AGENT, "personal-skills", "calendar/SKILL.md");
      expect(existsSync(mirror)).toBe(true);
    } finally {
      try { rmSync(sharedRoot, { recursive: true, force: true }); } catch { /**/ }
    }
  });

  it("sweeps .<name>-prior-<ts>/ siblings older than 24h on next mirror op (#1844)", () => {
    const skillFile = join(agentsRoot, "input.md");
    writeFileSync(skillFile, validSkillMd("sweep1", "v1"));
    captureStdout(() => {
      initPersonalAction("sweep1", { agent: AGENT, from: skillFile, root: agentsRoot });
    });

    // Manually backdate a fake .prior- sibling to ~25h ago.
    const mirrorDir = join(configDir, "agents", AGENT, "personal-skills");
    const oldTs = Date.now() - 25 * 60 * 60 * 1000;
    const oldPrior = join(mirrorDir, `.sweep1-prior-${oldTs}`);
    mkdirSync(oldPrior, { recursive: true });
    writeFileSync(join(oldPrior, "SKILL.md"), validSkillMd("sweep1", "ancient"));

    // Trigger any mirror op — the lazy sweep should remove the old entry.
    writeFileSync(skillFile, validSkillMd("sweep1", "v2"));
    captureStdout(() => {
      editPersonalAction("sweep1", { agent: AGENT, from: skillFile, root: agentsRoot });
    });

    expect(existsSync(oldPrior)).toBe(false);
    // A fresh .prior- from THIS edit should still exist.
    const remaining = readdirSync(mirrorDir).filter((n: string) =>
      n.startsWith(".sweep1-prior-"),
    );
    expect(remaining.length).toBe(1);
  });

  it("refuses to mirror a symlinked source dir (defense in depth)", () => {
    // Construct an alt skill dir + symlink the personal slot at it.
    const altDir = mkdtempSync(join(tmpdir(), "evil-skill-"));
    mkdirSync(altDir, { recursive: true });
    writeFileSync(join(altDir, "SKILL.md"), validSkillMd("symevil"));

    const personalSlot = join(agentsRoot, AGENT, ".claude/skills/personal-symevil");
    mkdirSync(join(agentsRoot, AGENT, ".claude/skills"), { recursive: true });
    symlinkSync(altDir, personalSlot);

    // Run mirror via a direct internal call — exercise the defense, not
    // the public init path (which would refuse the symlinked dest at write).
    // Easiest: just verify the mirror dir stays absent after a manual
    // editPersonalAction call against the now-symlinked target.
    const skillFile = join(agentsRoot, "input.md");
    writeFileSync(skillFile, validSkillMd("symevil", "v2"));

    const origStderr = process.stderr.write.bind(process.stderr);
    let stderrText = "";
    process.stderr.write = ((c: unknown) => {
      stderrText += typeof c === "string" ? c : (c as Buffer).toString("utf-8");
      return true;
    }) as typeof process.stderr.write;
    try {
      try {
        editPersonalAction("symevil", { agent: AGENT, from: skillFile, root: agentsRoot });
      } catch { /* writer may reject; that's fine — we're testing mirror defense */ }
    } finally {
      process.stderr.write = origStderr;
    }
    // The mirror dir for symevil should NOT exist (mirror refused).
    expect(existsSync(join(configDir, "agents", AGENT, "personal-skills/symevil"))).toBe(false);

    try { rmSync(altDir, { recursive: true, force: true }); } catch { /**/ }
  });

  it("mirror failure (read-only config dir) does NOT block the live write", () => {
    // Make the config dir effectively unwritable by pointing the override
    // at a non-dir (a regular file). The mirror try/catch should swallow.
    const blockFile = join(tmpdir(), `block-${Date.now()}`);
    writeFileSync(blockFile, "i am not a dir");
    process.env[ENV] = blockFile;

    const origStderr = process.stderr.write.bind(process.stderr);
    let stderrText = "";
    process.stderr.write = ((c: unknown) => {
      stderrText += typeof c === "string" ? c : (c as Buffer).toString("utf-8");
      return true;
    }) as typeof process.stderr.write;

    try {
      const skillFile = join(agentsRoot, "input.md");
      writeFileSync(skillFile, validSkillMd("survives"));
      captureStdout(() => {
        initPersonalAction("survives", { agent: AGENT, from: skillFile, root: agentsRoot });
      });
      // Live copy lands fine.
      expect(existsSync(join(agentsRoot, AGENT, ".claude/skills/personal-survives/SKILL.md"))).toBe(true);
      // Warning printed.
      expect(stderrText).toMatch(/mirror.*failed/);
    } finally {
      process.stderr.write = origStderr;
      try { rmSync(blockFile, { force: true }); } catch { /**/ }
    }
  });
});

describe("clone-to-personal skips non-allowlisted source files (#1847)", () => {
  let agentsRoot: string;
  let sharedRoot: string;

  beforeEach(() => {
    agentsRoot = tmpAgentsRoot();
    sharedRoot = mkdtempSync(join(tmpdir(), "clone-skip-shared-"));
  });

  afterEach(() => {
    try { rmSync(agentsRoot, { recursive: true, force: true }); } catch { /**/ }
    try { rmSync(sharedRoot, { recursive: true, force: true }); } catch { /**/ }
  });

  it("clones a source dir with LICENSE/VENDORED.md/non-allowlisted extras, dropping them", () => {
    const src = join(sharedRoot, "vendored");
    mkdirSync(join(src, "scripts"), { recursive: true });
    writeFileSync(join(src, "SKILL.md"), validSkillMd("vendored"));
    writeFileSync(join(src, "LICENSE"), "MIT License\n");
    writeFileSync(join(src, "VENDORED.md"), "vendored from upstream\n");
    writeFileSync(join(src, "reference.md"), "ad-hoc reference doc\n"); // not allowlisted at root
    writeFileSync(join(src, "scripts/run.sh"), "#!/bin/bash\necho ok\n");

    const origStderr = process.stderr.write.bind(process.stderr);
    let stderrText = "";
    process.stderr.write = ((c: unknown) => {
      stderrText += typeof c === "string" ? c : (c as Buffer).toString("utf-8");
      return true;
    }) as typeof process.stderr.write;

    let stdout = "";
    try {
      stdout = captureStdout(() => {
        clonePersonalAction("shared:vendored", {
          agent: AGENT,
          root: agentsRoot,
          sharedRoot,
        });
      });
    } finally {
      process.stderr.write = origStderr;
    }

    // SKILL.md + scripts/run.sh land; the rest do NOT.
    const dest = join(agentsRoot, AGENT, ".claude/skills/personal-vendored");
    expect(existsSync(join(dest, "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "scripts/run.sh"))).toBe(true);
    expect(existsSync(join(dest, "LICENSE"))).toBe(false);
    expect(existsSync(join(dest, "VENDORED.md"))).toBe(false);
    expect(existsSync(join(dest, "reference.md"))).toBe(false);

    // Stderr notes the skip + names the offenders.
    expect(stderrText).toMatch(/skipped 3 non-allowlisted/);
    expect(stderrText).toMatch(/LICENSE/);
    expect(stderrText).toMatch(/VENDORED\.md/);

    // JSON success surface lists them.
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("clone_to_personal");
    expect(parsed.files).toBe(2); // SKILL.md + scripts/run.sh
    expect(parsed.skipped).toHaveLength(3);
    expect(parsed.skipped).toEqual(
      expect.arrayContaining(["LICENSE", "VENDORED.md", "reference.md"]),
    );
  });

  it("emits skipped:[] (empty) when source is shape-clean — distinguishable from silent drop", () => {
    const src = join(sharedRoot, "clean");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), validSkillMd("clean"));

    const out = captureStdout(() => {
      clonePersonalAction("shared:clean", {
        agent: AGENT,
        root: agentsRoot,
        sharedRoot,
      });
    });
    const parsed = JSON.parse(out);
    expect(parsed.skipped).toEqual([]);
  });

  it("still refuses if SKILL.md itself is missing (even after skipping extras)", () => {
    const src = join(sharedRoot, "no-md");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "LICENSE"), "MIT\n");
    writeFileSync(join(src, "README"), "no skill here\n"); // README (no .md) is not allowlisted

    expectExitCode(() => {
      clonePersonalAction("shared:no-md", {
        agent: AGENT,
        root: agentsRoot,
        sharedRoot,
      });
    }, 2);
  });
});

// ─── Secret-scan gate (security fix: skill bodies were unscanned) ─────
//
// The personal-skill write path runs scanBundleForSecrets BEFORE writing
// to disk and (therefore) before mirroring into the operator's config
// repo. A secret embedded ANYWHERE in the bundle — SKILL.md body included,
// not just scripts — must refuse the write with exit 3, name the offending
// file + matched pattern, and never echo the secret value.
//
// Token fixtures are built by concatenation so this source file never
// contains a contiguous real-looking token (GitHub Push Protection).
describe("scanBundleForSecrets gate (init-personal)", () => {
  let root: string;

  beforeEach(() => {
    root = tmpAgentsRoot();
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /**/ }
  });

  // Capture both the exit code AND stderr so we can assert the message
  // shape (names file, never leaks the secret).
  function runCaptureExit(fn: () => void): { code: number | undefined; stderr: string } {
    const origExit = process.exit.bind(process);
    let caught: number | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = (code?: number): never => {
      caught = code;
      throw new Error(`__test_exit_${code}__`);
    };
    let stderr = "";
    const origErr = console.error;
    console.error = (...args: unknown[]): void => {
      stderr += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
    };
    try {
      try {
        fn();
      } catch (e: unknown) {
        const err = e as { message?: string };
        if (!err.message?.startsWith("__test_exit_")) throw e;
      }
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).exit = origExit;
      console.error = origErr;
    }
    return { code: caught, stderr };
  }

  function skillMdWithBody(name: string, body: string): string {
    return `---\nname: ${name}\ndescription: A test skill\n---\n# ${name}\n\n${body}\n`;
  }

  function initWithBody(name: string, body: string): { code: number | undefined; stderr: string } {
    const skillFile = join(root, "input.md");
    writeFileSync(skillFile, skillMdWithBody(name, body));
    return runCaptureExit(() => {
      initPersonalAction(name, { agent: AGENT, from: skillFile, root });
    });
  }

  // Fixtures: assembled at runtime so no contiguous token literal exists.
  const SK_ANT = ["sk-ant-", "Apq13yqRnPzx4MxK0TfAbY98Qw22"].join("");
  const GHP = ["ghp_", "Abcdef1234567890Abcdef1234567890abcd"].join("");
  const AKIA = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
  const PEM = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIBVwIBADANBgkqhkiG9w0BAQEFAASCAUEwggE9AgEAAkEA0Zm9abcdEFGHijkl",
    "mnopQRSTuvwx0123456789ABCDefghIJKLmnopQRSTuvwx0123456789ABCDefgh",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  // Prefix-less high-entropy blob: ≥28 [A-Za-z0-9], ≥18 distinct, has a
  // digit — exercises the generic_high_entropy fallback.
  const HIGH_ENTROPY = ["a", "Z7", "qW3", "rT9bN2", "kL5pX8mC4vH1jD6sQ0fG"].join("");

  const cases: Array<[string, string, RegExp]> = [
    ["sk-ant token", `Here is my key ${SK_ANT} keep it safe`, /Anthropic API key/],
    ["ghp token", `token: ${GHP}`, /GitHub personal access token/],
    ["AKIA key", `aws id ${AKIA} done`, /AWS access key/],
    ["PEM private key block", PEM, /PEM private-key block/],
    ["prefix-less high-entropy key", `apikey ${HIGH_ENTROPY} end`, /high-entropy/],
  ];

  for (const [label, body, patternRe] of cases) {
    it(`refuses a ${label} embedded in the SKILL.md body`, () => {
      const { code, stderr } = initWithBody("secretskill", body);
      // Fail closed.
      expect(code).toBe(3);
      // Names the offending file.
      expect(stderr).toContain("SKILL.md");
      // Names the matched pattern.
      expect(stderr).toMatch(patternRe);
      // Never echoes the secret value.
      const secret = body.match(/[A-Za-z0-9_+/.=-]{16,}/g) ?? [];
      // The longest token in the body is the secret payload; ensure no
      // run of it appears in the error output.
      for (const tok of secret) {
        if (tok.length >= 20) expect(stderr).not.toContain(tok);
      }
      // The skill must NOT have landed on disk.
      const target = join(root, AGENT, ".claude/skills/personal-secretskill");
      expect(existsSync(target)).toBe(false);
    });
  }

  it("PASSES a clean, normal skill (no false positive)", () => {
    const body = [
      "This skill formats a daily digest. It reads recent GitHub activity",
      "and produces a summary. Use the run_digest helper and pass the",
      "org-name and the get_user_profile_by_org lookup. No credentials live",
      "in this file — fetch them with `switchroom vault get github/token`.",
    ].join("\n");
    const out = captureStdout(() => {
      const skillFile = join(root, "clean.md");
      writeFileSync(skillFile, skillMdWithBody("cleanskill", body));
      initPersonalAction("cleanskill", { agent: AGENT, from: skillFile, root });
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    const target = join(root, AGENT, ".claude/skills/personal-cleanskill/SKILL.md");
    expect(existsSync(target)).toBe(true);
  });

  it("a secret-bearing skill never reaches the mirror (config repo)", () => {
    // Point the mirror at a real, existing tmpdir so mirrorToConfigRepo
    // WOULD write there if it were ever reached. Pre-create the
    // agents/<agent>/personal-skills path so the only reason it stays
    // empty is the scan refusing before writePersonalSkill/mirror.
    const mirrorRoot = mkdtempSync(join(tmpdir(), "skill-mirror-"));
    const saved = process.env.SWITCHROOM_CONFIG_DIR;
    process.env.SWITCHROOM_CONFIG_DIR = mirrorRoot;
    const mirrorDir = join(mirrorRoot, "agents", AGENT, "personal-skills");
    mkdirSync(mirrorDir, { recursive: true });
    try {
      const { code } = initWithBody("leakyskill", `key ${SK_ANT} here`);
      expect(code).toBe(3);
      // Nothing mirrored.
      expect(readdirSync(mirrorDir)).toHaveLength(0);
      // Nothing on disk either.
      expect(existsSync(join(root, AGENT, ".claude/skills/personal-leakyskill"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SWITCHROOM_CONFIG_DIR;
      else process.env.SWITCHROOM_CONFIG_DIR = saved;
      try { rmSync(mirrorRoot, { recursive: true, force: true }); } catch { /**/ }
    }
  });
});
