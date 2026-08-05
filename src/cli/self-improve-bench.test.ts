/**
 * PR2 — `switchroom self-improve bench <slug>` CLI, exercised end-to-end
 * against an EPHEMERAL fixture agent (temp $HOME + temp TELEGRAM_STATE_DIR,
 * never a live agent). The command aggregates fabricated grading files
 * through the real `aggregate_benchmark.py` and prints a JSON verdict.
 *
 * NB: this never runs an eval — the grading files are pre-fabricated on disk
 * (claude-native constraint: `bench` only aggregates, never invokes
 * `run_eval.py` / `claude -p`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

import { registerSelfImproveBenchCommand } from "./self-improve-bench.js";

const SLUG = "personal-fixture-skill";

function writeGrading(
  benchDir: string,
  config: string,
  runNo: number,
  passRate: number,
): void {
  const runDir = join(benchDir, "eval-0", config, `run-${runNo}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "grading.json"),
    JSON.stringify({
      summary: { pass_rate: passRate, passed: 2, failed: 0, total: 2 },
    }),
  );
}

/** Build a fixture agent HOME with an owned skill that carries evals, plus a
 *  benchmark dir under the state dir. Returns { home, stateDir }. */
function buildFixture(): { home: string; stateDir: string } {
  const home = mkdtempSync(join(tmpdir(), "bench-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "bench-state-"));

  const skillDir = join(home, ".claude", "skills", SLUG);
  mkdirSync(join(skillDir, "evals"), { recursive: true });
  writeFileSync(
    join(skillDir, "evals", "evals.json"),
    JSON.stringify({ evals: [{ prompt: "do the thing", expectations: ["works"] }] }),
  );

  const benchDir = join(stateDir, "self-improve-benchmarks", SLUG);
  writeGrading(benchDir, "with_skill", 1, 1.0);
  writeGrading(benchDir, "without_skill", 1, 0.5);

  return { home, stateDir };
}

async function runBench(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride(); // don't call process.exit on parse
  registerSelfImproveBenchCommand(program);
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    logs.push(String(m));
  });
  try {
    await program.parseAsync(["node", "switchroom", "self-improve", "bench", ...args]);
  } finally {
    spy.mockRestore();
  }
  const last = logs[logs.length - 1];
  return last ? JSON.parse(last) : null;
}

describe("self-improve bench CLI (ephemeral fixture agent)", () => {
  let home: string;
  let stateDir: string;
  let savedHome: string | undefined;
  let savedState: string | undefined;

  beforeEach(() => {
    ({ home, stateDir } = buildFixture());
    savedHome = process.env.HOME;
    savedState = process.env.TELEGRAM_STATE_DIR;
    process.env.HOME = home;
    process.env.TELEGRAM_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedState === undefined) delete process.env.TELEGRAM_STATE_DIR;
    else process.env.TELEGRAM_STATE_DIR = savedState;
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("aggregates the default benchmark dir into a passing JSON verdict", async () => {
    const out = (await runBench([SLUG])) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.skill).toBe(SLUG);
    expect(out.pass).toBe(true);
    expect(out.candidate_pass_rate).toBe(1.0);
    expect(out.baseline_pass_rate).toBe(0.5);
    expect(String(out.benchmark_dir)).toContain(SLUG);
  });

  it("honours an explicit --benchmark-dir", async () => {
    const explicit = join(stateDir, "self-improve-benchmarks", SLUG);
    const out = (await runBench([SLUG, "--benchmark-dir", explicit])) as Record<
      string,
      unknown
    >;
    expect(out.ok).toBe(true);
    expect(out.benchmark_dir).toBe(explicit);
  });
});
