import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hook is a .ts that bundles to .mjs at build time; drive it
// through `bun` against source so the test doesn't depend on build
// order (mirrors server.author.test.ts). Skip cleanly if bun absent.
const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const HOOK = join(process.cwd(), "src", "cli", "skill-validate-pretool.ts");

function run(
  payload: unknown,
  env: Record<string, string> = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("bun", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, ...env },
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

let tmp: string;
let skillsRoot: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "skill-lint-"));
  // Mimic an agent's <agentDir>/.claude/skills/ tree.
  skillsRoot = join(tmp, ".claude", "skills");
  mkdirSync(join(skillsRoot, "demo"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "demo", "SKILL.md"),
    "---\nname: demo\ndescription: a demo skill\n---\n# Demo\n",
  );
});

afterAll(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe("skill-validate-pretool hook", () => {
  it("fails open on empty / non-JSON / unknown stdin", () => {
    if (!bunOk) return;
    for (const bad of ["", "not-json", "{}", '{"tool_name":"Read"}']) {
      const r = run(bad);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("ignores non-edit tools and writes outside .claude/skills/", () => {
    if (!bunOk) return;
    const notEdit = run({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(notEdit.status).toBe(0);
    expect(notEdit.stdout).toBe("");

    const outside = run({
      tool_name: "Write",
      tool_input: { file_path: join(tmp, "notes.md"), content: "hi" },
    });
    expect(outside.status).toBe(0);
    expect(outside.stdout).toBe("");
  });

  it("allows a well-formed SKILL.md write silently", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        content: "---\nname: demo\ndescription: a demo skill\n---\n# Demo\n",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("nudges (not blocks) on bad frontmatter — returns additionalContext", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        content: "# no frontmatter here\n",
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBeUndefined(); // NOT blocked
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.additionalContext).toMatch(/frontmatter/i);
  });

  it("nudges on an out-of-allowlist path", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "scripts", "run.js"),
        content: "console.log(1)",
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/allowlist/i);
  });

  it("nudges on an invalid skill slug", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "Bad Slug", "SKILL.md"),
        content: "---\nname: x\ndescription: y\n---\n",
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/slug/i);
  });

  it("BLOCKS only on the per-skill byte cap", () => {
    if (!bunOk) return;
    const huge = "x".repeat(2 * 1024 * 1024 + 1024);
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(skillsRoot, "demo", "reference", "big.md"),
        content: huge,
      },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/per-skill cap/);
  });

  it("Edit with no content does not block (can't project — fail open)", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "Edit",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        old_string: "Demo",
        new_string: "Demo 2",
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("MultiEdit on a skill path with no content fails open", () => {
    if (!bunOk) return;
    const r = run({
      tool_name: "MultiEdit",
      tool_input: {
        file_path: join(skillsRoot, "demo", "SKILL.md"),
        edits: [{ old_string: "a", new_string: "b" }],
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("byte-cap projection: add-to-existing blocks, shrink-overwrite allows", () => {
    if (!bunOk) return;
    // Seed a skill that already holds ~1.6 MiB.
    const bigDir = join(skillsRoot, "big");
    mkdirSync(join(bigDir, "reference"), { recursive: true });
    writeFileSync(
      join(bigDir, "SKILL.md"),
      "---\nname: big\ndescription: big skill\n---\n",
    );
    const existing = join(bigDir, "reference", "existing.md");
    writeFileSync(existing, "y".repeat(1.6 * 1024 * 1024));

    // Adding a new ~0.6 MiB file pushes the total past 2 MiB → block,
    // even though the new file alone is well under the cap (proves the
    // projection sums the existing dir, not just the new content).
    const add = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(bigDir, "reference", "more.md"),
        content: "z".repeat(0.6 * 1024 * 1024),
      },
    });
    const addOut = JSON.parse(add.stdout);
    expect(addOut.decision).toBe("block");
    expect(addOut.reason).toMatch(/per-skill cap/);

    // Overwriting the existing 1.6 MiB file with tiny content nets the
    // skill far below the cap → allowed (proves it subtracts the
    // target file's current size before adding the new content).
    const shrink = run({
      tool_name: "Write",
      tool_input: { file_path: existing, content: "small" },
    });
    expect(shrink.status).toBe(0);
    expect(shrink.stdout).toBe("");
  });

  // BL1 (RFC amendment §"corrections as eval cases"): evals/evals.json is
  // machine-managed. A raw model Write/Edit to it must be BLOCKED on EVERY
  // turn by this always-on hook (not only the review-scoped apply-guard),
  // because a direct write bypasses the PII/secret scan AND the operator's
  // one-tap approval. The sanctioned path is `add-eval-case`.
  it("BL1: blocks a raw Write to evals/evals.json (always-on, no marker needed)", () => {
    if (!bunOk) return;
    const r = run(
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(skillsRoot, "demo", "evals", "evals.json"),
          content: '{"skill_name":"demo","evals":[{"name":"x","prompt":"p"}]}',
        },
      },
      { SWITCHROOM_SELF_IMPROVE: "1" }, // hermetic: force self-improvement ON
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/add-eval-case/);
    expect(out.reason).toMatch(/machine-managed|PII\/secret scan/i);
  });

  it("BL1: blocks a raw Edit to evals/evals.json too", () => {
    if (!bunOk) return;
    const r = run(
      {
        tool_name: "Edit",
        tool_input: {
          file_path: join(skillsRoot, "demo", "evals", "evals.json"),
          old_string: "p",
          new_string: "p2",
          content: '{"skill_name":"demo","evals":[]}',
        },
      },
      { SWITCHROOM_SELF_IMPROVE: "1" },
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/add-eval-case/);
  });

  it("BL1: SWITCHROOM_SELF_IMPROVE=0 escape hatch allows the raw evals.json write", () => {
    if (!bunOk) return;
    const r = run(
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(skillsRoot, "demo", "evals", "evals.json"),
          content: '{"skill_name":"demo","evals":[]}',
        },
      },
      { SWITCHROOM_SELF_IMPROVE: "0" },
    );
    expect(r.status).toBe(0);
    // With self-improvement off, hand-authoring via skill-creator is allowed;
    // the write is not blocked by BL1 (any residual output must not be a block).
    if (r.stdout) {
      expect(JSON.parse(r.stdout).decision).toBeUndefined();
    }
  });

  it("BL1: a sibling evals/ file that is NOT evals.json is not BL1-blocked", () => {
    if (!bunOk) return;
    // Only evals/evals.json is machine-managed; a held-out or notes file
    // under evals/ is out of BL1 scope (byte-cap / advisory rules still apply).
    const r = run(
      {
        tool_name: "Write",
        tool_input: {
          file_path: join(skillsRoot, "demo", "evals", "notes.md"),
          content: "scratch notes\n",
        },
      },
      { SWITCHROOM_SELF_IMPROVE: "1" },
    );
    expect(r.status).toBe(0);
    if (r.stdout) {
      expect(JSON.parse(r.stdout).decision).not.toBe("block");
    }
  });

  // MAJOR 1 (PR #4403 review): the always-on write-block canonicalizes the
  // target before the equality check, so a `..`/`.`-laden path that OS-resolves
  // to the real evals.json is blocked identically to the plain path. The two
  // concrete strings below are the validator's confirmed bypasses.
  it("BL1/MAJOR1: blocks a `../`-laden Write that resolves to evals/evals.json", () => {
    if (!bunOk) return;
    for (const rel of [
      ["demo", "evals", "..", "evals", "evals.json"],
      ["demo", "sub", "..", "evals", "evals.json"],
      ["demo", "..", "demo", "evals", "evals.json"],
    ]) {
      const r = run(
        {
          tool_name: "Write",
          tool_input: {
            file_path: join(skillsRoot, ...rel),
            content: '{"skill_name":"demo","evals":[]}',
          },
        },
        { SWITCHROOM_SELF_IMPROVE: "1" },
      );
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe("block");
      expect(out.reason).toMatch(/machine-managed|add-eval-case/);
    }
  });

  // MAJOR 2 (PR #4403 review): a Bash tool call carries no file_path, so a
  // shell redirect / writer verb into a machine-managed evals.json used to slip
  // past the write-block entirely. The hook now matches Bash and blocks the
  // demonstrated write vectors while leaving reads and the sanctioned CLI alone.
  it("BL1/MAJOR2: blocks a Bash redirect/write into evals/evals.json", () => {
    if (!bunOk) return;
    const target = join(skillsRoot, "demo", "evals", "evals.json");
    const traversal = join(skillsRoot, "demo", "evals", "..", "evals", "evals.json");
    const commands = [
      `echo poison > ${target}`,
      `echo poison >> ${target}`,
      `cat src > ${traversal}`,
      `tee ${target} < src`,
      `cp /tmp/p ${target}`,
      `sed -i s/a/b/ ${target}`,
      `dd if=/tmp/p of=${target}`,
    ];
    for (const command of commands) {
      const r = run(
        { tool_name: "Bash", tool_input: { command } },
        { SWITCHROOM_SELF_IMPROVE: "1" },
      );
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe("block");
      expect(out.reason).toMatch(/machine-managed|add-eval-case/);
    }
  });

  it("MAJOR2: Bash reads / the sanctioned CLI / unrelated redirects are allowed", () => {
    if (!bunOk) return;
    const target = join(skillsRoot, "demo", "evals", "evals.json");
    const allowed = [
      `cat ${target}`,
      `grep foo ${target}`,
      `jq . ${target}`,
      `switchroom self-improve add-eval-case --skill demo --prompt 'fix evals'`,
      `echo done > /tmp/other.log && cat ${target}`,
      `ls`,
    ];
    for (const command of allowed) {
      const r = run(
        { tool_name: "Bash", tool_input: { command } },
        { SWITCHROOM_SELF_IMPROVE: "1" },
      );
      expect(r.status).toBe(0);
      if (r.stdout) expect(JSON.parse(r.stdout).decision).not.toBe("block");
    }
  });

  it("MAJOR2: SWITCHROOM_SELF_IMPROVE=0 escape hatch allows the Bash redirect", () => {
    if (!bunOk) return;
    const command = `echo x > ${join(skillsRoot, "demo", "evals", "evals.json")}`;
    const r = run(
      { tool_name: "Bash", tool_input: { command } },
      { SWITCHROOM_SELF_IMPROVE: "0" },
    );
    expect(r.status).toBe(0);
    if (r.stdout) expect(JSON.parse(r.stdout).decision).toBeUndefined();
  });

  it("a path containing .claude/skills/ twice never wrong-blocks", () => {
    if (!bunOk) return;
    // Pathological: first occurrence wins → slug "docs". Worst case is
    // a spurious advisory nudge; it must never block and the write
    // must proceed (no decision:block).
    const r = run({
      tool_name: "Write",
      tool_input: {
        file_path: join(
          skillsRoot,
          "docs",
          ".claude",
          "skills",
          "demo",
          "SKILL.md",
        ),
        content: "---\nname: demo\ndescription: d\n---\n",
      },
    });
    expect(r.status).toBe(0);
    if (r.stdout) {
      expect(JSON.parse(r.stdout).decision).toBeUndefined();
    }
  });
});
