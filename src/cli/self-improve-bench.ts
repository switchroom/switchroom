/**
 * `switchroom self-improve bench <slug> [--benchmark-dir <dir>]`
 * (PR2 — the benchmark SURFACE for self-improvement).
 *
 * Aggregates an EXISTING set of grading files for a skill's evals into a
 * pass/regress verdict and prints it as JSON. This is the read-only
 * numbers surface behind the eval gate (`eval-gate.ts`): the review /
 * synthesis flow computes these numbers, and an operator can recompute
 * them on demand.
 *
 * CLAUDE-NATIVE / SUBSCRIPTION-HONEST — HARD CONSTRAINT:
 *   This command NEVER triggers an eval run. `skills/skill-creator/scripts/
 *   run_eval.py` shells `claude -p`; no self-improve path may invoke it.
 *   Benchmark grading files are produced out-of-band by the grader-subagent
 *   flow (`skills/skill-creator/SKILL.md` §"Grade, aggregate…", the
 *   `agents/grader.md` grader). `bench` ONLY runs `aggregate_benchmark.py`
 *   over grading files that already exist on disk — pure aggregation, no
 *   model, no `claude -p`.
 *
 * Steps:
 *   1. Resolve the skill dir (`~/.claude/skills/<slug>`); require it to be an
 *      OWNED skill dir carrying runnable evals (`skillHasEvals`). No evals ⇒
 *      nothing to benchmark.
 *   2. Resolve the benchmark dir (given `--benchmark-dir`, else the
 *      most-recent one under `<stateDir>/self-improve-benchmarks/<slug>/`).
 *   3. Shell `aggregate_benchmark.py` (via `aggregateBenchmark`, 120s cap)
 *      to (re)generate `benchmark.json`, then read the `evalVerdict`.
 *   4. Print the verdict + pass-rates as JSON to stdout.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";

import { ownsSkill, BENCHMARK_SUBDIR } from "../self-improve/apply-guard.js";
import {
  skillHasEvals,
  aggregateBenchmark,
  resolveBenchmarkDir,
  evalVerdict,
} from "../self-improve/eval-gate.js";
import {
  resolveShippedAsset,
  SKILLS_ASSET,
  describeShippedAssetSearch,
} from "../util/shipped-assets.js";

interface BenchOpts {
  benchmarkDir?: string;
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function stateDir(): string {
  return (
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude", "channels", "telegram")
  );
}

function skillDirFor(slug: string): string {
  return join(homedir(), ".claude", "skills", slug);
}

/** Default benchmark base dir for a slug (mirrors the apply-guard convention:
 *  the review writes per-skill benchmarks under this subdir of the state dir). */
function benchmarkBaseDir(slug: string): string {
  return join(stateDir(), BENCHMARK_SUBDIR, slug);
}

/**
 * Locate the checkout root that carries
 * `skills/skill-creator/scripts/aggregate_benchmark.py`, for
 * `aggregateBenchmark(dir, repoRoot)`. `resolveShippedAsset(SKILLS_ASSET)`
 * resolves the shipped `skills/` dir across every install layout (npm/dev,
 * Docker image, SEA binary, FHS, or the `SWITCHROOM_SKILLS_ROOT` override);
 * the repo root the aggregator needs is its PARENT.
 */
function resolveAggregatorRepoRoot(): string | null {
  const res = resolveShippedAsset(SKILLS_ASSET, {
    bundleDir: import.meta.dirname,
    execPath: process.execPath,
  });
  if (res.path === null) {
    process.stderr.write(
      `switchroom self-improve bench: could not locate shipped skills/ ` +
        `(${describeShippedAssetSearch(res)})\n`,
    );
    return null;
  }
  // res.path is `<root>/skills`; the aggregator joins repoRoot + `skills/...`.
  return dirname(res.path);
}

export function registerSelfImproveBenchCommand(program: Command): void {
  const parent =
    program.commands.find((c) => c.name() === "self-improve") ??
    program.command("self-improve").description("Agent self-improvement ops");

  parent
    .command("bench")
    .description(
      "Aggregate existing grading files for a skill's evals into a " +
        "pass/regress verdict (JSON). Never runs an eval — aggregation only.",
    )
    .argument("<slug>", "target skill slug (a skill you own)")
    .option(
      "--benchmark-dir <dir>",
      "benchmark dir of grading files to aggregate " +
        "(default: most-recent under <stateDir>/self-improve-benchmarks/<slug>/)",
    )
    .action((slug: string, opts: BenchOpts) => {
      const dir = skillDirFor(slug);
      if (!ownsSkill(dir)) {
        fail(
          `skill "${slug}" is not an owned skill dir at ${dir} ` +
            `(missing, or a shared/bundled symlink) — nothing to benchmark`,
        );
      }
      if (!skillHasEvals(dir)) {
        fail(
          `skill "${slug}" has no runnable evals (evals/evals.json) — ` +
            `nothing to benchmark`,
        );
      }

      const base = benchmarkBaseDir(slug);
      const benchDir = resolveBenchmarkDir(base, opts.benchmarkDir);
      if (benchDir === null) {
        fail(
          opts.benchmarkDir
            ? `--benchmark-dir "${opts.benchmarkDir}" is not a benchmark dir ` +
                `(no eval-*/ grading files under it)`
            : `no benchmark dir found under ${base} — run the grader flow ` +
                `first (bench only aggregates existing grading files)`,
        );
      }

      const repoRoot = resolveAggregatorRepoRoot();
      if (repoRoot === null) {
        fail(
          `cannot locate skills/skill-creator/scripts/aggregate_benchmark.py ` +
            `(set SWITCHROOM_SKILLS_ROOT to the shipped skills/ dir)`,
        );
      }

      const agg = aggregateBenchmark(benchDir, repoRoot);
      if (!agg.ok || agg.benchmarkJson == null) {
        fail(`aggregate_benchmark failed: ${agg.error ?? "unknown error"}`);
      }

      const verdict = evalVerdict(agg.benchmarkJson);
      // Surface the generated benchmark.json path for provenance, but keep the
      // machine-readable verdict + pass-rates flat at the top level.
      const out: Record<string, unknown> = {
        ok: true,
        action: "bench",
        skill: slug,
        benchmark_dir: benchDir,
        benchmark_json: agg.benchmarkJson,
        pass: verdict.pass,
        candidate_pass_rate: verdict.candidatePassRate,
        baseline_pass_rate: verdict.baselinePassRate,
      };
      if (!verdict.pass) out.reason = verdict.reason;
      // Drop undefined pass-rate keys (a failing verdict may lack them).
      for (const k of ["candidate_pass_rate", "baseline_pass_rate"] as const) {
        if (out[k] === undefined) delete out[k];
      }
      console.log(JSON.stringify(out));
    });
}
