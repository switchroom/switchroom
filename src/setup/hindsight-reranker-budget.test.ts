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
import { HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES } from "./hindsight.js";

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

describe("reranker candidate budget", () => {
  it("stays at or below the level that keeps recall off the timeout cliff", () => {
    // Measured 2026-07-26 (see the constant's doc comment): the cross-encoder
    // costs ~17ms per candidate on a mature bank, and reranking was 72-91% of
    // total recall latency. At 150 candidates that is ~2.6s of pure rerank,
    // which put overlord's recall at 3.7s idle and well past the 8s per-bank
    // timeout under fleet concurrency — a measured 96.8% own-bank timeout
    // rate. This ceiling is the regression guard: raising the cap back to 150
    // reintroduces the outage, so it must be a deliberate, reviewed change.
    expect(HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES).toBeLessThanOrEqual(50);
  });

  it("stays high enough to give the final result set real headroom", () => {
    // Recall keeps ~12-20 final memories. A cap at or below that would make
    // the reranker a no-op reorder of exactly the results we already had,
    // trading a real quality signal for latency we did not need.
    expect(HINDSIGHT_DEFAULT_RERANKER_MAX_CANDIDATES).toBeGreaterThanOrEqual(40);
  });
});
