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
import {
  DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS,
  resolveHindsightRecallTunables,
} from "./hindsight-recall-tunables.js";

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
  // Either `timeout=<expr>,` on its own line, or the multi-line parenthesised
  // form #3760 introduced for the `timeout_override` escape hatch. Both must
  // resolve to the managed symbol, never to a bare literal that has drifted.
  const kwarg =
    body.match(/^\s*timeout=(\S+?),\s*$/m) ??
    body.match(/^\s*timeout=\(\s*\n\s*(\S+?)\s*$/m);
  if (!kwarg) {
    throw new Error(
      "no `timeout=` kwarg inside recall.py's _make_bank_task — this guard has lost "
        + "its anchor and would otherwise measure nothing. Update readPerBankTimeoutSeconds().",
    );
  }
  const expr = kwarg[1];
  // A literal here would mean the managed key was reverted — accept it, the
  // budget assertions below are what matter.
  if (/^[0-9.]+$/.test(expr)) return Number(expr);
  if (expr !== "request_timeout" && expr !== "recall_request_timeout") {
    throw new Error(
      `recall.py's per-bank timeout kwarg is \`timeout=${expr}\`, which this guard `
        + "cannot resolve to a number. Update readPerBankTimeoutSeconds() so the budget "
        + "check keeps measuring the real value.",
    );
  }
  // The symbol is resolved from config with the shipped DEFAULTS entry as its
  // fallback, so the DEFAULTS entry IS the shipped default.
  return readConfiguredRequestTimeoutDefault();
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

  it("keeps the per-bank timeout inside the hook ceiling, and the RESOLVED one inside the deadline", () => {
    const hook = readHookTimeoutSeconds();
    const deadline = readParallelDeadlineSeconds();
    const perBank = readPerBankTimeoutSeconds();

    // The VENDORED per-bank default is allowed to sit above the shared
    // deadline: since #3757 it is a per-request safety net, not the budget, so
    // the shared fan-out deadline normally cuts first. What is never coherent
    // is a per-bank timeout past the HOOK CEILING — nothing downstream of the
    // ceiling can observe it, because Claude Code has already SIGKILLed the
    // hook by then.
    expect(
      perBank,
      `vendored per-bank timeout=${perBank}s must not exceed the ${hook}s hook ceiling — `
        + "past the ceiling the hook is already dead and the timeout can never fire",
    ).toBeLessThanOrEqual(hook);

    // What actually reaches a host is the RESOLVED value, and that one must sit
    // inside the shared deadline or it is dead code. This is the half a
    // vendored-literals-only guard cannot see: it never reads the resolver.
    const resolved = resolveHindsightRecallTunables(undefined);
    expect(
      resolved.requestTimeoutSeconds,
      `resolved per-bank timeout=${resolved.requestTimeoutSeconds}s must not exceed the `
        + `${resolved.parallelDeadlineSeconds}s resolved shared deadline`,
    ).toBeLessThanOrEqual(resolved.parallelDeadlineSeconds);

    // And the resolver's stock output must agree with the vendored deadline —
    // otherwise switchroom exports an envelope the plugin was never sized for.
    expect(resolved.parallelDeadlineSeconds).toBe(deadline);
    expect(resolved.clamps, "the SHIPPED defaults must resolve without any clamp").toEqual([]);
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
      body.match(/^\s*timeout=(\S+?),\s*$/m)?.[1] ??
        body.match(/^\s*timeout=\(\s*\n\s*(\S+?)\s*$/m)?.[1],
      "the per-bank timeout kwarg must live INSIDE _make_bank_task",
    ).toBeTruthy();
    // And the slice must be tight enough to exclude the issue-reporter call.
    expect(body).not.toContain("subprocess.run");
  });

  it("keeps recall.py's inline fallbacks and lib/config.py's DEFAULTS on the same number", () => {
    // Two independently-editable declarations of the same shipped default: the
    // literal recall.py falls back to when the config value is missing or
    // unusable, and DEFAULTS["recallRequestTimeoutSeconds"] (used when it is
    // present). If they drift, the effective per-bank timeout depends on
    // whether config loading happened to succeed.
    const want = readConfiguredRequestTimeoutDefault();
    const raw = readFileSync(join(VENDOR, "scripts", "recall.py"), "utf8");
    const fallbacks = [
      ...raw.matchAll(/config\.get\("recallRequestTimeoutSeconds",\s*([0-9.]+)\s*\)/g),
      ...raw.matchAll(/recall_request_timeout\s*=\s*([0-9.]+)\s*$/gm),
    ].map((m) => Number(m[1]));
    expect(
      fallbacks.length,
      "no per-bank request-timeout fallback literal found in recall.py — this guard "
        + "has lost its anchor and would pass vacuously",
    ).toBeGreaterThan(0);
    for (const got of fallbacks) expect(got).toBe(want);
  });

  it("keeps the TypeScript request-timeout default and lib/config.py's DEFAULTS on the same number", () => {
    // The gap that let #3759 and #3760 ship two different numbers for one key.
    // The TS constant is what actually reaches a host: start.sh exports it
    // UNCONDITIONALLY and env is the top of the plugin's load order, so a TS
    // value that has drifted from the vendored DEFAULTS does not merely
    // disagree on paper — it silently overrides the shipped default on every
    // agent, with the Python-side pin above still green.
    expect(
      DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS,
      "src/setup/hindsight-recall-tunables.ts's DEFAULT_RECALL_REQUEST_TIMEOUT_SECONDS must "
        + "track lib/config.py's DEFAULTS[\"recallRequestTimeoutSeconds\"] — the env export "
        + "outranks the vendored value, so a drift here wins silently on every host",
    ).toBe(readConfiguredRequestTimeoutDefault());
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
// >50, including five queries' top result.
//
// The 2026-08-06 latency fix took the cap to 100 instead (see the file header
// in src/setup/hindsight-perf-defaults.ts): 100 keeps RRF ranks 1-100 — every
// rank the >50 evidence above showed reaching the prompt — while still trimming
// a third of the per-pair cross-encoder CPU that is the recall bottleneck on a
// GPU-less box. The outcome pin for that value lives with the constant, in
// hindsight-perf-defaults.test.ts. A cut below 100 still needs an answer-quality
// A/B first, for the RRF-rank reason above.
