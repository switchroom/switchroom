/**
 * Agent self-improvement — the EVAL GATE on T1 (RFC §"Per-skill eval").
 *
 * Before any T1 edit lands, the candidate skill's `evals/evals.json` is
 * run through the skill-creator harness — the `agents/grader.md` grader
 * subagent (cheap model) produces per-run `grading.json`, and
 * `scripts/aggregate_benchmark.py` produces a `benchmark.json` with
 * pass-rate mean ± stddev for the candidate ("with_skill") vs the
 * pre-edit baseline ("without_skill" / "baseline"). The edit lands ONLY
 * if its evals pass AND don't regress baseline.
 *
 * Slice-1 scope of THIS module: it does NOT spawn the grader subagent
 * (that runs in the forked review's session, which has the model). This
 * module is the deterministic DECISION layer:
 *   - `skillHasEvals()` — precondition: a T1 with no evals.json must NOT
 *     auto-apply; it downgrades to a T2 proposal (RFC "If the skill has
 *     no evals.json yet … downgrade it to a T2 proposal instead").
 *   - `aggregateBenchmark()` — shells out to the real
 *     `scripts/aggregate_benchmark.py`, the same script skill-creator
 *     uses (no new eval engine).
 *   - `evalVerdict()` — reads a benchmark.json and decides
 *     pass / regress against baseline.
 *
 * Keeping the verdict logic pure + the harness call thin is what lets
 * the "eval gate blocks a regressing edit" test run without a model.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveSelfImproveConfig, type SelfImproveConfig } from "./config.js";

/** Path to a skill's evals.json, given the skill dir. */
export function evalsJsonPath(skillDir: string): string {
  return join(skillDir, "evals", "evals.json");
}

/**
 * Precondition gate: does this skill carry runnable evals? A T1 with no
 * evals must downgrade to T2 (we never auto-apply an unmeasured edit).
 */
export function skillHasEvals(skillDir: string): boolean {
  const p = evalsJsonPath(skillDir);
  if (!existsSync(p)) return false;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as {
      evals?: unknown;
    };
    return Array.isArray(parsed.evals) && parsed.evals.length > 0;
  } catch {
    return false;
  }
}

export interface BenchmarkResult {
  ok: boolean;
  /** Path to the generated benchmark.json (when ok). */
  benchmarkJson?: string;
  /** Raw stderr/stdout on failure. */
  error?: string;
}

/**
 * Run the real `aggregate_benchmark.py` over a benchmark dir of
 * `grading.json` files (produced by the grader subagent). Reuses the
 * skill-creator script verbatim — no new eval engine.
 *
 * `repoRoot` locates `skills/skill-creator/scripts/aggregate_benchmark.py`.
 */
export function aggregateBenchmark(
  benchmarkDir: string,
  repoRoot: string,
  pythonBin = process.env.SWITCHROOM_PYTHON ?? "python3",
): BenchmarkResult {
  const script = join(
    repoRoot,
    "skills",
    "skill-creator",
    "scripts",
    "aggregate_benchmark.py",
  );
  if (!existsSync(script)) {
    return { ok: false, error: `aggregate_benchmark.py not found at ${script}` };
  }
  const r = spawnSync(pythonBin, [script, benchmarkDir], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      error: `aggregate_benchmark exited ${r.status}: ${(r.stderr ?? "").trim()}`,
    };
  }
  return { ok: true, benchmarkJson: join(benchmarkDir, "benchmark.json") };
}

/**
 * A directory is a runnable benchmark dir iff `aggregate_benchmark.py` can
 * find grading files under it — i.e. it holds `eval-*` subdirs directly, or
 * a `runs/` subdir that does (the two layouts the script supports). Pure /
 * filesystem-only: it does NOT trigger any eval (the claude-native rule —
 * `bench` only aggregates existing grading files, never runs `run_eval.py`).
 */
export function isBenchmarkDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const hasEvalDirs = (d: string): boolean => {
    try {
      return readdirSync(d, { withFileTypes: true }).some(
        (e) => e.isDirectory() && e.name.startsWith("eval-"),
      );
    } catch {
      return false;
    }
  };
  if (hasEvalDirs(dir)) return true;
  const runs = join(dir, "runs");
  return existsSync(runs) && hasEvalDirs(runs);
}

/**
 * Resolve the benchmark dir to aggregate for a skill, without running any
 * eval. Resolution order:
 *   1. an explicit `--benchmark-dir` (validated as a benchmark dir);
 *   2. `baseDir` itself, if it directly holds grading files;
 *   3. the MOST-RECENT (by mtime) immediate subdir of `baseDir` that is a
 *      benchmark dir — supports a `<base>/<timestamp>/eval-*` layout.
 * Returns null when nothing under `baseDir` looks like a benchmark dir.
 */
export function resolveBenchmarkDir(
  baseDir: string,
  explicit?: string,
): string | null {
  if (explicit != null && explicit.length > 0) {
    return isBenchmarkDir(explicit) ? explicit : null;
  }
  if (isBenchmarkDir(baseDir)) return baseDir;
  let entries: string[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(baseDir, e.name))
      .filter(isBenchmarkDir);
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return entries[0]!;
}

export type EvalVerdict =
  | { pass: true; candidatePassRate: number; baselinePassRate: number }
  | {
      pass: false;
      reason: string;
      candidatePassRate?: number;
      baselinePassRate?: number;
    };

interface RunSummaryStat {
  mean?: number;
  stddev?: number;
}
interface ConfigSummary {
  pass_rate?: RunSummaryStat;
}
interface Benchmark {
  run_summary?: Record<string, ConfigSummary | unknown>;
}

/** The benchmark configs we treat as "the edited skill". */
const CANDIDATE_CONFIGS = ["with_skill", "candidate", "new_skill", "after"];
/** The benchmark configs we treat as "the pre-edit baseline". */
const BASELINE_CONFIGS = ["without_skill", "baseline", "old_skill", "before"];

function pickPassRate(
  summary: Record<string, unknown>,
  names: string[],
): number | undefined {
  for (const n of names) {
    const c = summary[n] as ConfigSummary | undefined;
    if (c && c.pass_rate && typeof c.pass_rate.mean === "number") {
      return c.pass_rate.mean;
    }
  }
  return undefined;
}

/**
 * Decide whether a T1 edit may land, from a benchmark.json.
 *
 * Rules (RFC "lands only if its evals pass and don't regress baseline"):
 *   - The candidate must reach an absolute floor (default 1.0 — evals
 *     must pass; tune via SWITCHROOM_SELF_IMPROVE_EVAL_FLOOR).
 *   - The candidate must NOT score below baseline beyond a small noise
 *     band (default 0.0 — any regression blocks; the band absorbs
 *     stddev jitter, tune via SWITCHROOM_SELF_IMPROVE_EVAL_REGRESS_BAND).
 *   - If there is no baseline config, the floor alone decides.
 */
export function evalVerdict(
  benchmarkJson: string,
  _cfg: SelfImproveConfig = resolveSelfImproveConfig(),
): EvalVerdict {
  let bench: Benchmark;
  try {
    bench = JSON.parse(readFileSync(benchmarkJson, "utf-8")) as Benchmark;
  } catch (err) {
    return { pass: false, reason: `unreadable benchmark.json: ${(err as Error).message}` };
  }
  const summary = (bench.run_summary ?? {}) as Record<string, unknown>;

  const candidate = pickPassRate(summary, CANDIDATE_CONFIGS);
  if (candidate === undefined) {
    return { pass: false, reason: "no candidate pass-rate in benchmark.json" };
  }
  const baseline = pickPassRate(summary, BASELINE_CONFIGS);

  const floor = floatEnv("SWITCHROOM_SELF_IMPROVE_EVAL_FLOOR", 1.0);
  const regressBand = floatEnv("SWITCHROOM_SELF_IMPROVE_EVAL_REGRESS_BAND", 0.0);

  if (candidate < floor) {
    return {
      pass: false,
      reason: `candidate pass-rate ${candidate.toFixed(2)} below floor ${floor.toFixed(2)}`,
      candidatePassRate: candidate,
      baselinePassRate: baseline,
    };
  }

  if (baseline !== undefined && candidate < baseline - regressBand) {
    return {
      pass: false,
      reason: `regression: candidate ${candidate.toFixed(2)} < baseline ${baseline.toFixed(2)} (band ${regressBand.toFixed(2)})`,
      candidatePassRate: candidate,
      baselinePassRate: baseline,
    };
  }

  return {
    pass: true,
    candidatePassRate: candidate,
    baselinePassRate: baseline ?? candidate,
  };
}

function floatEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined) return def;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : def;
}
