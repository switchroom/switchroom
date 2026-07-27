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

/**
 * The body of `_make_bank_task` in recall.py — the ONE factory both the
 * parallel and serial recall paths go through.
 *
 * Anchoring matters more than it looks. This guard used to scan the whole file
 * for `/^\s*timeout=([0-9.]+),\s*$/m`, which worked only while the per-bank
 * timeout was the literal `timeout=8,`. When #3759 promoted it to a managed key
 * the kwarg became `timeout=request_timeout,` and the file-wide regex silently
 * fell through to the NEXT match — `timeout=5,` on a `subprocess.run()` call in
 * the issue reporter, ~650 lines away. Every assertion below still passed
 * (5 <= 10), so CI stayed green while the check measured an unrelated
 * subprocess timeout. Slicing the factory first makes that failure loud: if the
 * factory is renamed or the kwarg moves out of it, we throw instead of
 * measuring the wrong thing.
 */
function readMakeBankTaskBody(): string {
  const raw = readFileSync(join(VENDOR, "scripts", "recall.py"), "utf8");
  const start = raw.indexOf("def _make_bank_task(");
  if (start < 0) {
    throw new Error(
      "recall.py no longer defines _make_bank_task — this guard has lost its anchor "
        + "and would otherwise silently measure some other `timeout=` in the file. "
        + "Re-point it at the real per-bank recall call site.",
    );
  }
  const end = raw.indexOf("return _bank_task", start);
  if (end < 0) {
    throw new Error("_make_bank_task in recall.py has no `return _bank_task` terminator");
  }
  return raw.slice(start, end);
}

/**
 * The per-bank recall timeout DEFAULT, from recall.py.
 *
 * Since #3759 the kwarg is a managed key (`recallRequestTimeoutSeconds` /
 * HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS), so the value at the call site is
 * the symbol `request_timeout`, resolved from config with
 * `DEFAULT_RECALL_REQUEST_TIMEOUT` as the fallback. The shipped default is what
 * this budget check is about, so read the module constant — after proving the
 * call site actually consumes it.
 */
function readPerBankTimeoutSeconds(): number {
  const body = readMakeBankTaskBody();
  const kwarg = body.match(/^\s*timeout=(\S+?),\s*$/m);
  if (!kwarg) {
    throw new Error("no `timeout=` kwarg inside recall.py's _make_bank_task");
  }
  const expr = kwarg[1];
  // A literal here would mean the managed key was reverted — accept it, the
  // budget assertions below are what matter.
  if (/^[0-9.]+$/.test(expr)) return Number(expr);
  if (expr !== "request_timeout") {
    throw new Error(
      `recall.py's per-bank timeout kwarg is \`timeout=${expr}\`, which this guard `
        + "cannot resolve to a number. Update readPerBankTimeoutSeconds() so the budget "
        + "check keeps measuring the real value.",
    );
  }
  const raw = readFileSync(join(VENDOR, "scripts", "recall.py"), "utf8");
  const m = raw.match(/^DEFAULT_RECALL_REQUEST_TIMEOUT\s*=\s*([0-9.]+)\s*$/m);
  if (!m) {
    throw new Error(
      "recall.py's per-bank timeout is the managed key `request_timeout`, but its "
        + "DEFAULT_RECALL_REQUEST_TIMEOUT module constant was not found",
    );
  }
  return Number(m[1]);
}

/** The per-bank timeout default declared in lib/config.py's DEFAULTS. */
function readConfiguredRequestTimeoutDefault(): number {
  const raw = readFileSync(join(VENDOR, "scripts", "lib", "config.py"), "utf8");
  const m = raw.match(/"recallRequestTimeoutSeconds":\s*([0-9.]+)/);
  if (!m) throw new Error("recallRequestTimeoutSeconds default not found in lib/config.py");
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

  it("reads the per-bank timeout from _make_bank_task, not some other timeout= in the file", () => {
    // The guard above is only as good as its anchor. recall.py carries other
    // `timeout=` kwargs (e.g. the `subprocess.run()` issue reporter at ~:2356);
    // a file-wide regex silently measured that one for the whole life of #3759
    // and stayed green. Pin the anchor itself.
    const body = readMakeBankTaskBody();
    expect(body, "_make_bank_task must contain the client.recall() call").toContain(
      "client.recall(",
    );
    expect(
      body.match(/^\s*timeout=(\S+?),\s*$/m)?.[1],
      "the per-bank timeout kwarg must live INSIDE _make_bank_task",
    ).toBeTruthy();
    // And the slice must be tight enough to exclude the issue-reporter call.
    expect(body).not.toContain("subprocess.run");
  });

  it("keeps recall.py's fallback and lib/config.py's DEFAULTS on the same number", () => {
    // Two independently-editable declarations of the same shipped default:
    // recall.py's DEFAULT_RECALL_REQUEST_TIMEOUT (used when the config value is
    // missing or unusable) and DEFAULTS["recallRequestTimeoutSeconds"] (used
    // when it is present). If they drift, the effective per-bank timeout
    // depends on whether config loading happened to succeed.
    expect(readPerBankTimeoutSeconds()).toBe(readConfiguredRequestTimeoutDefault());
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
