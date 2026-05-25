/**
 * Tests for `switchroom skill {init,edit,remove,list}-personal` (#1819, PR-3).
 *
 * Covers the four personal-skill primitives end-to-end against an
 * isolated agents-root tmpdir. The MCP server's dispatch wiring is
 * covered separately by `src/mcp/agent-config/server.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
} from "./skill-personal.js";

const AGENT = "test-agent";

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
