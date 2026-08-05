import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { benchmarkJsonForSkill } from "../src/self-improve/apply-guard.js";
import { evalsJsonPath } from "../src/self-improve/eval-gate.js";
import { writeReviewContext } from "../src/self-improve/review-context.js";
import { readPending } from "../src/self-improve/pending-queue.js";
import { appliesToday } from "../src/self-improve/rate-limit.js";
import { appendEvalCase } from "../src/self-improve/eval-cases.js";

// Drive the hook through `bun` against source (mirrors the stop-hook test)
// so it doesn't depend on build order. Skip cleanly if bun is absent.
const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const HOOK = join(process.cwd(), "src", "cli", "self-improve-apply-guard-pretool.ts");

const SLUG = "myskill";
let agentDir: string;
let stateDir: string;

function skillDir(): string {
  return join(agentDir, ".claude", "skills", SLUG);
}
function skillFile(): string {
  return join(skillDir(), "SKILL.md");
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
function putMarker(): void {
  writeReviewContext(stateDir, {
    // Past timestamp so a benchmark written 'now' counts as fresh.
    created_at: new Date(Date.now() - 60_000).toISOString(),
    triggering_session: "sess-1",
    chat_id: "c",
    signals: [],
  });
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
function run(toolName: string, filePath: string, content: string, env: Record<string, string> = {}): RunResult {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
  });
  const r = spawnSync("bun", [HOOK], {
    input: payload,
    encoding: "utf-8",
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, ...env },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "self-improve-pt-agent-"));
  stateDir = mkdtempSync(join(tmpdir(), "self-improve-pt-state-"));
});
afterEach(() => {
  for (const d of [agentDir, stateDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("self-improve apply-guard PreToolUse hook", () => {
  it("no marker present → allow (no-op on a normal turn)", () => {
    if (!bunOk) return;
    makeOwnedSkill(false); // no marker written
    const r = run("Write", skillFile(), "anything\n");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(""); // allow = empty stdout
  });

  it("kill switch SWITCHROOM_SELF_IMPROVE=0 → allow even with a marker", () => {
    if (!bunOk) return;
    makeOwnedSkill(false);
    putMarker();
    const r = run("Write", skillFile(), "x\n", { SWITCHROOM_SELF_IMPROVE: "0" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("marker + owned skill + evals-passing + fresh benchmark + T1_LIVE=1 → allow, records an apply", () => {
    if (!bunOk) return;
    makeOwnedSkill(true);
    writeBenchmark(1.0, 0.9);
    putMarker();
    // Silent auto-apply is opt-IN — the allow path only exists with the flag.
    const r = run("Write", skillFile(), "small\nedit\n", {
      SWITCHROOM_SELF_IMPROVE_T1_LIVE: "1",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(""); // allowed
    expect(appliesToday(stateDir)).toBe(1); // one auto-apply recorded
    expect(readPending(stateDir)).toEqual([]); // nothing downgraded
  });

  it("same, but T1_LIVE unset (default OFF) → block + downgrade to a pending proposal", () => {
    if (!bunOk) return;
    // Identical to the allow case EXCEPT the T1-live flag is absent. The hard
    // backstop (RFC amendment invariant) must turn an otherwise-verified T1
    // into a one-tap T2 proposal — never a silent apply.
    makeOwnedSkill(true);
    writeBenchmark(1.0, 0.9);
    putMarker();
    const r = run("Write", skillFile(), "small\nedit\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"decision":"block"');
    expect(r.stdout.toLowerCase()).toContain("silent auto-apply is disabled");
    const pending = readPending(stateDir);
    expect(pending.length).toBe(1);
    expect(pending[0]?.skill_slug).toBe(SLUG);
    expect(appliesToday(stateDir)).toBe(0); // downgraded → no apply recorded
  });

  it("marker + owned skill but NO evals → block + downgrade to a pending proposal", () => {
    if (!bunOk) return;
    makeOwnedSkill(false); // no evals.json
    putMarker();
    const r = run("Write", skillFile(), "x\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"decision":"block"');
    expect(r.stdout.toLowerCase()).toContain("no evals");
    const pending = readPending(stateDir);
    expect(pending.length).toBe(1);
    expect(pending[0]?.skill_slug).toBe(SLUG);
    expect(appliesToday(stateDir)).toBe(0); // blocked → no apply recorded
  });

  // MJ4 (RFC amendment §"corrections as eval cases"): the whole point of the
  // sink is that a correction, once captured as an eval case, catches a FUTURE
  // regression. This is the end-to-end proof on an ephemeral fixture agent:
  // a real eval case is appended via the sink, then a deliberately-regressing
  // edit (candidate pass-rate below the eval floor) is BLOCKED — never silently
  // applied — even with silent-apply opted in.
  it("MJ4: once a case exists, a regressing edit is blocked (downgraded), not applied", () => {
    if (!bunOk) return;
    makeOwnedSkill(false); // create the skill dir; no bare evals.json
    // Populate evals.json through the REAL add-only sink — "cases exist".
    const appended = appendEvalCase(skillDir(), SLUG, {
      prompt: "the correction, captured as a regression test",
    });
    expect(appended.ok).toBe(true);
    // A regression: with-skill 0.5 < without-skill 0.9 (below the eval floor).
    writeBenchmark(0.5, 0.9);
    putMarker();
    const r = run("Write", skillFile(), "regress\n", {
      SWITCHROOM_SELF_IMPROVE_T1_LIVE: "1", // even with silent-apply ON…
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"decision":"block"'); // …the regression is caught
    expect(r.stdout).toContain("eval gate blocked");
    expect(appliesToday(stateDir)).toBe(0); // never applied
    expect(readPending(stateDir).length).toBe(1); // surfaced as a proposal
  });

  it("marker present but a non-skill write → allow (out of scope)", () => {
    if (!bunOk) return;
    makeOwnedSkill(true);
    putMarker();
    const r = run("Write", join(agentDir, "notes.md"), "hello\n");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
