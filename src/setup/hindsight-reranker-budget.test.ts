/**
 * Guards for the recall latency budget — the numbers that must stay in
 * agreement for auto-recall to work at all.
 *
 * Three constants govern the UserPromptSubmit recall path, and until #3619
 * their relationship existed ONLY in prose comments:
 *
 *   1. `timeout: 12` — the Claude Code hook ceiling, `hooks/hooks.json`.
 *      Claude Code SIGKILLs `recall.py` at this point. A killed hook writes
 *      NO `recall_log.jsonl` row, so any breach is invisible in telemetry.
 *   2. `recallParallelDeadlineSeconds: 10` — the shared fan-out deadline,
 *      `scripts/lib/config.py`. Its own comment says it is "sized at the
 *      UserPromptSubmit hook ceiling (12s, hooks.json) MINUS 2s headroom".
 *   3. `timeout=8` — the per-bank socket timeout, `scripts/recall.py`.
 *
 * Nothing enforced (1) > (2) > (3). On 2026-07-26 the live fleet was found
 * running an out-of-band deadline of 16s against a 12s hook ceiling — a
 * budget that can never be spent, where the overrun mode is a silent SIGKILL
 * rather than a logged timeout. These tests make that class of drift a red
 * CI check instead of a comment nobody re-reads.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const VENDOR = join(process.cwd(), "vendor", "hindsight-memory");

/** The UserPromptSubmit hook timeout Claude Code enforces, from hooks.json. */
function readHookTimeoutSeconds(): number {
  const raw = readFileSync(join(VENDOR, "hooks", "hooks.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>>;
  };
  const entries = parsed.hooks.UserPromptSubmit ?? [];
  for (const group of entries) {
    for (const hook of group.hooks) {
      if (hook.command.includes("recall.py")) {
        expect(hook.timeout, "recall.py hook must declare an explicit timeout").toBeTypeOf(
          "number",
        );
        return hook.timeout as number;
      }
    }
  }
  throw new Error("no recall.py hook registered on UserPromptSubmit in hooks.json");
}

/** The shared parallel-recall deadline default, from lib/config.py. */
function readParallelDeadlineSeconds(): number {
  const raw = readFileSync(join(VENDOR, "scripts", "lib", "config.py"), "utf8");
  const m = raw.match(/"recallParallelDeadlineSeconds":\s*([0-9.]+)/);
  if (!m) throw new Error("recallParallelDeadlineSeconds default not found in lib/config.py");
  return Number(m[1]);
}

/** The per-bank socket timeout passed to `client.recall`, from recall.py. */
function readPerBankTimeoutSeconds(): number {
  const raw = readFileSync(join(VENDOR, "scripts", "recall.py"), "utf8");
  // The single live call site is the `timeout=` kwarg inside _make_bank_task.
  const m = raw.match(/^\s*timeout=([0-9.]+),\s*$/m);
  if (!m) throw new Error("per-bank timeout kwarg not found in recall.py");
  return Number(m[1]);
}

describe("recall budget coherence", () => {
  it("keeps the shared deadline strictly inside the hook ceiling", () => {
    const hook = readHookTimeoutSeconds();
    const deadline = readParallelDeadlineSeconds();
    // Strictly less, not <=: at equality a deadline-abandoned fan-out has zero
    // time left to format the block, write the cache, and flush stdout, so the
    // hook is killed mid-write and the turn loses BOTH the memories and the
    // telemetry row that would have explained why.
    expect(
      deadline,
      `recallParallelDeadlineSeconds=${deadline}s must be < the ${hook}s recall.py ` +
        "hook timeout in hooks.json, or Claude Code SIGKILLs the hook before it can " +
        "emit its context and its recall_log row (the failure then leaves no trace)",
    ).toBeLessThan(hook);
  });

  it("leaves at least 2s of post-deadline headroom, as config.py documents", () => {
    const hook = readHookTimeoutSeconds();
    const deadline = readParallelDeadlineSeconds();
    expect(hook - deadline).toBeGreaterThanOrEqual(2);
  });

  it("keeps the per-bank timeout at or inside the shared deadline", () => {
    const deadline = readParallelDeadlineSeconds();
    const perBank = readPerBankTimeoutSeconds();
    // The shared deadline is the outer guard. A per-bank timeout LARGER than
    // it would be dead code; equal or smaller is coherent.
    expect(
      perBank,
      `per-bank timeout=${perBank}s must not exceed the ${deadline}s shared deadline`,
    ).toBeLessThanOrEqual(deadline);
  });

  it("documents the hook ceiling that the vendored config comment cites", () => {
    // config.py's comment names "12s, hooks.json" explicitly. If the ceiling
    // moves, that comment becomes a lie — catch it here rather than letting a
    // future reader size a budget from stale prose.
    const raw = readFileSync(join(VENDOR, "scripts", "lib", "config.py"), "utf8");
    const hook = readHookTimeoutSeconds();
    expect(
      raw,
      "lib/config.py's recallParallelDeadlineSeconds comment must cite the real hook ceiling",
    ).toContain(`hook ceiling (${hook}s, hooks.json)`);
  });
});

// NOTE: a `reranker candidate budget` block pinning
// HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES <= 50 was proposed alongside these
// guards and dropped in review. Cutting the cap 150 -> 50 removes roughly half
// of what actually reaches the prompt: the cap is a hard prefix slice of the
// RRF-sorted pool (engine `memory_engine.py:4744-4754`), and on the live
// overlord bank 28 of 61 injected memories across 8 queries came from RRF rank
// >50, including five queries' top result. Latency tuning of this constant is
// tracked separately and needs an answer-quality A/B first.
