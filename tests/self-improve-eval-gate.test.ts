import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  skillHasEvals,
  evalsJsonPath,
  evalVerdict,
  aggregateBenchmark,
} from "../src/self-improve/eval-gate.js";

const cfg = {
  repetitionThreshold: 2,
  t1MaxChangedLines: 30,
  t1MaxGrowthBytes: 4096,
  maxAutoAppliesPerDay: 3,
  maxOutstandingPending: 5,
};

const pythonOk = spawnSync("python3", ["--version"], { encoding: "utf-8" }).status === 0;
const repoRoot = process.cwd();

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "self-improve-eval-"));
});
afterAll(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function writeBenchmark(name: string, body: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe("eval-gate — skillHasEvals precondition (no evals → T1 must downgrade)", () => {
  it("is false when evals/evals.json is absent", () => {
    const skillDir = join(tmp, "no-evals-skill");
    mkdirSync(skillDir, { recursive: true });
    expect(skillHasEvals(skillDir)).toBe(false);
  });

  it("is false when evals.json has an empty evals array", () => {
    const skillDir = join(tmp, "empty-evals-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(evalsJsonPath(skillDir), JSON.stringify({ skill_name: "x", evals: [] }));
    expect(skillHasEvals(skillDir)).toBe(false);
  });

  it("is true when evals.json has at least one eval", () => {
    const skillDir = join(tmp, "has-evals-skill");
    mkdirSync(join(skillDir, "evals"), { recursive: true });
    writeFileSync(
      evalsJsonPath(skillDir),
      JSON.stringify({ skill_name: "x", evals: [{ id: 1, prompt: "do x", expectations: ["x"] }] }),
    );
    expect(skillHasEvals(skillDir)).toBe(true);
  });
});

describe("eval-gate — verdict from benchmark.json", () => {
  it("PASSES when candidate scores 1.0 and meets/beats baseline", () => {
    const p = writeBenchmark("pass.json", {
      run_summary: {
        with_skill: { pass_rate: { mean: 1.0, stddev: 0.0 } },
        without_skill: { pass_rate: { mean: 0.6, stddev: 0.1 } },
      },
    });
    const v = evalVerdict(p, cfg);
    expect(v.pass).toBe(true);
  });

  it("BLOCKS a regression: candidate below baseline", () => {
    const p = writeBenchmark("regress.json", {
      run_summary: {
        with_skill: { pass_rate: { mean: 0.7, stddev: 0.05 } },
        without_skill: { pass_rate: { mean: 0.9, stddev: 0.05 } },
      },
    });
    const v = evalVerdict(p, cfg);
    expect(v.pass).toBe(false);
    if (!v.pass) {
      // either floor or regression; with floor=1.0 default it's the floor,
      // but the candidate is also < baseline — both are correct blocks.
      expect(v.reason).toMatch(/regression|floor/);
    }
  });

  it("BLOCKS when candidate is below the absolute pass floor", () => {
    const p = writeBenchmark("floor.json", {
      run_summary: {
        with_skill: { pass_rate: { mean: 0.8, stddev: 0.0 } },
        // No baseline config → floor alone decides.
      },
    });
    const v = evalVerdict(p, cfg);
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.reason).toContain("floor");
  });

  it("BLOCKS when there is no candidate pass-rate at all", () => {
    const p = writeBenchmark("nobody.json", { run_summary: {} });
    const v = evalVerdict(p, cfg);
    expect(v.pass).toBe(false);
  });

  it("BLOCKS on an unreadable benchmark.json (fail-closed for the apply gate)", () => {
    const v = evalVerdict(join(tmp, "does-not-exist.json"), cfg);
    expect(v.pass).toBe(false);
  });
});

describe("eval-gate — reuses the real aggregate_benchmark.py", () => {
  it("aggregates grading.json files and the verdict blocks a regressing edit", () => {
    if (!pythonOk) return; // python3 absent — skip the harness integration leg.

    // Build the workspace layout aggregate_benchmark.py expects:
    //   <bench>/eval-1/with_skill/run-1/grading.json   (regressed)
    //   <bench>/eval-1/without_skill/run-1/grading.json (baseline higher)
    const bench = join(tmp, "bench-regress");
    const mk = (config: string, passRate: number, passed: number, total: number) => {
      const dir = join(bench, "eval-1", config, "run-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "grading.json"),
        JSON.stringify({
          expectations: [],
          summary: { passed, failed: total - passed, total, pass_rate: passRate },
        }),
      );
    };
    // Candidate ("with_skill") regresses vs baseline ("without_skill").
    mk("with_skill", 0.5, 1, 2);
    mk("without_skill", 1.0, 2, 2);

    const agg = aggregateBenchmark(bench, repoRoot);
    expect(agg.ok).toBe(true);
    expect(agg.benchmarkJson).toBeDefined();

    const v = evalVerdict(agg.benchmarkJson!, cfg);
    expect(v.pass).toBe(false); // the eval gate blocks the regressing edit
  });

  it("aggregates a passing, non-regressing edit to a PASS verdict", () => {
    if (!pythonOk) return;

    const bench = join(tmp, "bench-pass");
    const mk = (config: string, passRate: number) => {
      const dir = join(bench, "eval-1", config, "run-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "grading.json"),
        JSON.stringify({
          expectations: [],
          summary: { passed: passRate === 1 ? 2 : 1, failed: passRate === 1 ? 0 : 1, total: 2, pass_rate: passRate },
        }),
      );
    };
    mk("with_skill", 1.0);
    mk("without_skill", 0.5);

    const agg = aggregateBenchmark(bench, repoRoot);
    expect(agg.ok).toBe(true);
    const v = evalVerdict(agg.benchmarkJson!, cfg);
    expect(v.pass).toBe(true);
  });
});
