import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  decideApply,
  parseSkillTarget,
  ownsSkill,
  estimateChangedLines,
  benchmarkJsonForSkill,
  skillTargetEscapes,
} from "../src/self-improve/apply-guard.js";
import { evalsJsonPath } from "../src/self-improve/eval-gate.js";
import { recordAutoApply } from "../src/self-improve/rate-limit.js";
import type { SelfImproveConfig } from "../src/self-improve/config.js";

const CFG: SelfImproveConfig = {
  repetitionThreshold: 2,
  t1MaxChangedLines: 30,
  maxAutoAppliesPerDay: 3,
  maxOutstandingPending: 5,
};

const NOW = 1_700_000_000_000;
const now = (): number => NOW;

let agentDir: string;
let stateDir: string;
const SLUG = "myskill";

function skillDir(): string {
  return join(agentDir, ".claude", "skills", SLUG);
}
function skillFile(rel = "SKILL.md"): string {
  return join(skillDir(), rel);
}

function makeOwnedSkill(withEvals: boolean): void {
  mkdirSync(skillDir(), { recursive: true });
  if (withEvals) {
    mkdirSync(dirname(evalsJsonPath(skillDir())), { recursive: true });
    writeFileSync(
      evalsJsonPath(skillDir()),
      JSON.stringify({ skill_name: SLUG, evals: [{ name: "e1", prompt: "p" }] }),
    );
  }
}

function writeBenchmark(candidate: number, baseline: number): void {
  const p = benchmarkJsonForSkill(stateDir, SLUG);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      run_summary: {
        with_skill: { pass_rate: { mean: candidate, stddev: 0.0 } },
        without_skill: { pass_rate: { mean: baseline, stddev: 0.0 } },
      },
    }),
  );
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "self-improve-agent-"));
  stateDir = mkdtempSync(join(tmpdir(), "self-improve-state-"));
});
afterEach(() => {
  for (const d of [agentDir, stateDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("apply-guard helpers", () => {
  it("parseSkillTarget extracts slug + relPath + skillDir", () => {
    const t = parseSkillTarget("/home/a/.claude/skills/foo/scripts/x.sh");
    expect(t).not.toBeNull();
    expect(t?.slug).toBe("foo");
    expect(t?.relPath).toBe("scripts/x.sh");
    expect(t?.skillDir).toBe("/home/a/.claude/skills/foo");
  });

  it("parseSkillTarget returns null for non-skill paths and bare slug dirs", () => {
    expect(parseSkillTarget("/home/a/notes/x.md")).toBeNull();
    expect(parseSkillTarget("/home/a/.claude/skills/foo")).toBeNull(); // no rel
    expect(parseSkillTarget("")).toBeNull();
  });

  it("ownsSkill: true for a real dir, false for a symlink or missing", () => {
    makeOwnedSkill(false);
    expect(ownsSkill(skillDir())).toBe(true);

    const link = join(agentDir, ".claude", "skills", "linked");
    symlinkSync(skillDir(), link);
    expect(ownsSkill(link)).toBe(false); // shared/bundled pool symlink

    expect(ownsSkill(join(agentDir, ".claude", "skills", "ghost"))).toBe(false);
  });

  it("skillTargetEscapes flags traversal / unsafe slugs, allows clean paths", () => {
    const dir = "/h/.claude/skills/foo";
    expect(skillTargetEscapes({ skillDir: dir, slug: "foo", relPath: "SKILL.md" })).toBe(false);
    expect(skillTargetEscapes({ skillDir: dir, slug: "foo", relPath: "scripts/x.sh" })).toBe(false);
    // traversal in relPath
    expect(skillTargetEscapes({ skillDir: dir, slug: "foo", relPath: "../../../etc/passwd" })).toBe(true);
    expect(skillTargetEscapes({ skillDir: dir, slug: "foo", relPath: "a/../../b" })).toBe(true);
    // unsafe slug (".." bundle name → escapes the skills root)
    expect(skillTargetEscapes({ skillDir: "/h/.claude/skills/..", slug: "..", relPath: "settings.json" })).toBe(true);
    // empty / null-byte segments
    expect(skillTargetEscapes({ skillDir: dir, slug: "foo", relPath: "a//b" })).toBe(true);
  });

  it("estimateChangedLines counts Write/Edit/MultiEdit diffs", () => {
    // New file Write: every content line is added.
    expect(estimateChangedLines("Write", { content: "a\nb\nc" }, "/nope")).toBe(3);
    // Edit: one line changes → 1 added + 1 removed.
    expect(
      estimateChangedLines("Edit", { old_string: "x\ny", new_string: "x\nz" }, "/nope"),
    ).toBe(2);
    // MultiEdit sums across edits.
    expect(
      estimateChangedLines(
        "MultiEdit",
        { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "c\nd" }] },
        "/nope",
      ),
    ).toBe(3);
  });
});

describe("decideApply — the deterministic T1 gate", () => {
  it("ALLOWS a small, owned, evals-passing edit under the rate cap (T1_LIVE on)", () => {
    // The hard backstop (apply-guard step 7) downgrades even a fully-verified
    // T1 to a one-tap T2 unless the operator has opted into silent apply with
    // SWITCHROOM_SELF_IMPROVE_T1_LIVE=1 (default OFF). To exercise the "allow"
    // leg of the deterministic gate we opt in here, then restore.
    const prev = process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE;
    process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE = "1";
    try {
      makeOwnedSkill(true);
      writeBenchmark(1.0, 0.9);
      const d = decideApply({
        toolName: "Write",
        input: { content: "line1\nline2\n" },
        filePath: skillFile(),
        stateDir,
        cfg: CFG,
        now,
      });
      expect(d.action).toBe("allow");
      if (d.action === "allow") {
        expect(d.tier).toBe("T1");
        expect(d.candidatePassRate).toBe(1.0);
        expect(d.changedLines).toBeLessThanOrEqual(CFG.t1MaxChangedLines);
      }
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE;
      else process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE = prev;
    }
  });

  it("BLOCKS a verified T1 (downgrade T2) when T1_LIVE is unset — the hard backstop", () => {
    const prev = process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE;
    delete process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE;
    try {
      makeOwnedSkill(true);
      writeBenchmark(1.0, 0.9);
      const d = decideApply({
        toolName: "Write",
        input: { content: "line1\nline2\n" },
        filePath: skillFile(),
        stateDir,
        cfg: CFG,
        now,
      });
      expect(d.action).toBe("block");
      if (d.action === "block") {
        expect(d.downgradeTier).toBe("T2");
        expect(d.reason).toMatch(/SWITCHROOM_SELF_IMPROVE_T1_LIVE|silent auto-apply is disabled/i);
      }
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE;
      else process.env.SWITCHROOM_SELF_IMPROVE_T1_LIVE = prev;
    }
  });

  it("BLOCKS (T2) a skill the agent does not own", () => {
    makeOwnedSkill(true);
    writeBenchmark(1.0, 0.9);
    const d = decideApply({
      toolName: "Write",
      input: { content: "x\n" },
      filePath: skillFile(),
      stateDir,
      cfg: CFG,
      now,
      ownsSkillFn: () => false,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") {
      expect(d.downgradeTier).toBe("T2");
      expect(d.reason).toMatch(/not a T1/i);
    }
  });

  it("BLOCKS (T2) an edit over the diff cap", () => {
    makeOwnedSkill(true);
    writeBenchmark(1.0, 0.9);
    const big = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
    const d = decideApply({
      toolName: "Write",
      input: { content: big },
      filePath: skillFile(),
      stateDir,
      cfg: CFG,
      now,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.downgradeTier).toBe("T2");
  });

  it("BLOCKS (T2) when the skill has no evals.json", () => {
    makeOwnedSkill(false); // no evals
    writeBenchmark(1.0, 0.9);
    const d = decideApply({
      toolName: "Write",
      input: { content: "x\n" },
      filePath: skillFile(),
      stateDir,
      cfg: CFG,
      now,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toMatch(/no evals/i);
  });

  it("BLOCKS (T2) when no benchmark exists (eval did not run)", () => {
    makeOwnedSkill(true); // evals present, but no benchmark written
    const d = decideApply({
      toolName: "Write",
      input: { content: "x\n" },
      filePath: skillFile(),
      stateDir,
      cfg: CFG,
      now,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toMatch(/no eval result/i);
  });

  it("BLOCKS (T2) when the benchmark regresses / fails the floor", () => {
    makeOwnedSkill(true);
    writeBenchmark(0.5, 1.0); // candidate below the 1.0 floor
    const d = decideApply({
      toolName: "Write",
      input: { content: "x\n" },
      filePath: skillFile(),
      stateDir,
      cfg: CFG,
      now,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toMatch(/eval gate blocked/i);
  });

  it("BLOCKS (T2) when a stale benchmark predates the review", () => {
    makeOwnedSkill(true);
    writeBenchmark(1.0, 0.9); // written 'now' in wall-clock
    const d = decideApply({
      toolName: "Write",
      input: { content: "x\n" },
      filePath: skillFile(),
      stateDir,
      cfg: CFG,
      now,
      // Freshness floor far in the future → the on-disk benchmark is "stale".
      freshAfterMs: Date.now() + 60_000,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toMatch(/stale/i);
  });

  it("BLOCKS a path-traversal write even for an owned, evals-passing skill", () => {
    makeOwnedSkill(true);
    writeBenchmark(1.0, 0.9);
    // String-concat (not join) so the literal ".." survives into the path.
    const evil = skillFile().replace(/SKILL\.md$/, "../../evil.md");
    const d = decideApply({
      toolName: "Write",
      input: { content: "x\n" },
      filePath: evil,
      stateDir,
      cfg: CFG,
      now,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toMatch(/escapes the bundle/i);
  });

  it("BLOCKS (T2) once the daily auto-apply cap is reached", () => {
    makeOwnedSkill(true);
    writeBenchmark(1.0, 0.9);
    for (let i = 0; i < CFG.maxAutoAppliesPerDay; i++) recordAutoApply(stateDir, now);
    const d = decideApply({
      toolName: "Write",
      input: { content: "x\n" },
      filePath: skillFile(),
      stateDir,
      cfg: CFG,
      now,
    });
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toMatch(/cap reached/i);
  });
});
