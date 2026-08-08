import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execFileSync so the docker-run path never actually fires; we only want
// the argv it would have used.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  HINDSIGHT_CLAUDE_CONTEXT_WINDOW,
  HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW,
  HINDSIGHT_CONSOLIDATION_BATCH_SIZE_CEILING,
  HINDSIGHT_CONSOLIDATION_BATCH_SIZE_FLOOR,
  HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS,
  HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT,
  HINDSIGHT_RETAIN_MAX_COMPLETION_CEILING,
  HINDSIGHT_RETAIN_PROMPT_ESTIMATE_TOKENS,
  HINDSIGHT_UPSTREAM_REFLECT_MAX_CONTEXT_TOKENS,
  HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE,
  HindsightContextBudgetError,
  assertHindsightContextBudgetFits,
  defaultContextWindowForProvider,
  resolveCheckedHindsightContextBudget,
  resolveHindsightContextBudget,
  resolveLaneContextWindow,
  usableContextTokens,
} from "../../src/setup/hindsight-context-budget.js";
import {
  HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS,
  generateHindsightComposeSnippet,
  hindsightLlmBudgetEnv,
  hindsightLocalLlmEnabled,
  startHindsight,
} from "../../src/setup/hindsight.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function envPairsFromRun(): string[] {
  const runCall = mockedExec.mock.calls.find(
    (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
  );
  expect(runCall).toBeDefined();
  const args = runCall![1] as string[];
  const pairs: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e") pairs.push(args[i + 1] as string);
  }
  return pairs;
}

/** The live-fleet backend: llama.cpp `-c 65536 -np 2` = 32,768 per slot. */
const LOCAL_SLOT_WINDOW = 32_768;
const localLlm = { provider: "litellm", context_window: LOCAL_SLOT_WINDOW };

describe("hindsight context budget — derivation (#3716)", () => {
  it("lands on the 32k values: batch 3 / consolidation 8192 / retain 6144", () => {
    const b = resolveHindsightContextBudget(localLlm);
    expect(b.consolidation.batchSize).toBe(3);
    expect(b.consolidation.maxCompletionTokens).toBe(8192);
    expect(b.retain.maxCompletionTokens).toBe(6144);
  });

  it("holds the 32k batch at 3 — the size production never fails at", () => {
    // Outcome pin for the 2026-08-09 per-fact re-measurement. This test FAILS
    // on the pre-fix constant: 2,500 tokens/fact derives batch 6, which in 24h
    // of live logs produced 9 `LLM failed for sub-batch of 6, splitting into
    // 3/3` truncation events and zero failures at any smaller sub-batch — the
    // measured batch-6 prompt tail reached 31,903 tokens against a 32,768
    // window with 8,192 completion requested on top.
    //
    // Asserted through the real measurement rather than only through the
    // derived number, so a future edit to the constant that silently moves the
    // batch has to confront the production evidence, not just retune a literal.
    const MEASURED_BATCH6_PROMPT_TOKENS_MAX = 31_903; // n=450, banks overlord+klanker
    const impliedPerFact =
      (MEASURED_BATCH6_PROMPT_TOKENS_MAX - HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS) / 6;
    expect(HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT).toBeGreaterThanOrEqual(impliedPerFact);

    const b = resolveHindsightContextBudget(localLlm);
    expect(b.consolidation.batchSize).toBe(3);

    // The bug in one line: what the OLD constant claimed a batch of 6 would
    // cost, versus what a batch of 6 really costs. The estimate has to bound
    // the measurement, and 2,500/fact did not.
    const preFixEstimateForSix = HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS + 6 * 2_500;
    expect(preFixEstimateForSix).toBeLessThan(MEASURED_BATCH6_PROMPT_TOKENS_MAX);
    expect(
      HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS +
        6 * HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT +
        b.consolidation.maxCompletionTokens,
    ).toBeGreaterThan(LOCAL_SLOT_WINDOW);
  });

  it("keeps worst-case prompt+completion strictly inside a 32k window", () => {
    // THE regression assertion for #3716. Before it, the emitted batch size
    // was a hard 12 with an uncapped completion on top against a 32,768 slot,
    // i.e. guaranteed overflow. Recomputing the pre-fix worst case here proves
    // this test would have failed on the bug — and it holds a fortiori under
    // the 2026-08 per-fact re-measurement, which only made the estimate for a
    // batch of 12 larger.
    const preFixPrompt =
      HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS +
      HINDSIGHT_CONSOLIDATION_BATCH_SIZE_CEILING * HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT;
    expect(preFixPrompt).toBeGreaterThan(LOCAL_SLOT_WINDOW - 1000);

    const b = resolveHindsightContextBudget(localLlm);
    expect(b.consolidation.worstCaseTotalTokens).toBeLessThan(LOCAL_SLOT_WINDOW);
    expect(b.retain.worstCaseTotalTokens).toBeLessThan(LOCAL_SLOT_WINDOW);
    // …and with real slack, not by a token.
    expect(LOCAL_SLOT_WINDOW - b.consolidation.worstCaseTotalTokens).toBeGreaterThan(4_000);
  });

  it("does NOT penalise a large window — batch returns to at least 12", () => {
    const small = resolveHindsightContextBudget(localLlm);
    for (const window of [131_072, HINDSIGHT_CLAUDE_CONTEXT_WINDOW]) {
      const big = resolveHindsightContextBudget({ provider: "litellm", context_window: window });
      expect(big.consolidation.batchSize).toBeGreaterThanOrEqual(12);
      expect(big.consolidation.batchSize).toBeGreaterThan(small.consolidation.batchSize);
      expect(big.consolidation.maxCompletionTokens).toBeGreaterThan(
        small.consolidation.maxCompletionTokens,
      );
      expect(big.retain.maxCompletionTokens).toBeGreaterThan(small.retain.maxCompletionTokens);
      expect(big.consolidation.worstCaseTotalTokens).toBeLessThan(window);
    }
  });

  it("is monotonic in the window — a bigger window is never a smaller batch", () => {
    let prev = 0;
    for (const window of [16_384, 32_768, 49_152, 65_536, 131_072, 200_000]) {
      const b = resolveHindsightContextBudget({ provider: "litellm", context_window: window });
      expect(b.consolidation.batchSize).toBeGreaterThanOrEqual(prev);
      expect(b.consolidation.worstCaseTotalTokens).toBeLessThanOrEqual(window);
      prev = b.consolidation.batchSize;
    }
  });

  it("defaults conservatively for a non-claude provider and generously for claude-code", () => {
    expect(resolveLaneContextWindow("consolidation", { provider: "litellm" })).toMatchObject({
      windowTokens: HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW,
      windowSource: "provider-default",
    });
    expect(resolveLaneContextWindow("consolidation", undefined)).toMatchObject({
      windowTokens: HINDSIGHT_CLAUDE_CONTEXT_WINDOW,
      windowSource: "provider-default",
    });
    // An undeclared litellm backend is assumed local-and-small, so it gets the
    // ratcheted budget rather than the pre-fix one.
    expect(resolveHindsightContextBudget({ provider: "litellm" }).consolidation.batchSize).toBe(3);
  });

  it("resolves per-op window over global over provider default", () => {
    const llm = {
      provider: "litellm",
      context_window: 32_768,
      consolidation: { context_window: 131_072 },
    };
    expect(resolveLaneContextWindow("consolidation", llm)).toMatchObject({
      windowTokens: 131_072,
      windowSource: "per-op",
    });
    expect(resolveLaneContextWindow("retain", llm)).toMatchObject({
      windowTokens: 32_768,
      windowSource: "global",
    });
    // Lanes are budgeted independently: the big-window lane keeps batch 12
    // while the small-window lane stays ratcheted.
    const b = resolveHindsightContextBudget(llm);
    expect(b.consolidation.batchSize).toBe(HINDSIGHT_CONSOLIDATION_BATCH_SIZE_CEILING);
    expect(b.retain.maxCompletionTokens).toBe(6144);
  });

  it("caps the reflect prompt inside the 32k slot, at the hand-applied 20000", () => {
    // Upstream's default is 100_000 — three times a llama.cpp slot. That is the
    // reflect-lane half of the same overflow: a recall-heavy reflect prompt is
    // built up to this cap, so leaving it at upstream's value guarantees the
    // context shift on any local backend regardless of the batch size.
    const b = resolveHindsightContextBudget(localLlm);
    expect(b.reflect.maxContextTokens).toBe(20_000);
    expect(b.reflect.worstCaseTotalTokens).toBeLessThan(LOCAL_SLOT_WINDOW);
    expect(b.reflect.maxContextTokens).toBeLessThan(HINDSIGHT_UPSTREAM_REFLECT_MAX_CONTEXT_TOKENS);
  });

  it("gives the reflect lane more context on a large window", () => {
    const small = resolveHindsightContextBudget(localLlm);
    for (const window of [131_072, HINDSIGHT_CLAUDE_CONTEXT_WINDOW]) {
      const big = resolveHindsightContextBudget({ provider: "litellm", context_window: window });
      expect(big.reflect.maxContextTokens).toBeGreaterThan(small.reflect.maxContextTokens);
      expect(big.reflect.worstCaseTotalTokens).toBeLessThan(window);
    }
  });

  it("mirrors the #3611 time-budget cap as the retain ceiling", () => {
    // The two live in different modules to keep the budget dependency-free;
    // this is the check that keeps the mirror honest.
    expect(HINDSIGHT_RETAIN_MAX_COMPLETION_CEILING).toBe(
      HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS,
    );
  });
});

describe("hindsight context budget — preflight (#3716)", () => {
  it("REJECTS a window too small to fit the budget", () => {
    // 4096 is below anything hindsight can run: even batch 1 overflows.
    const tooSmall = { provider: "litellm", context_window: 4_096 };
    expect(() => resolveCheckedHindsightContextBudget(tooSmall)).toThrow(
      HindsightContextBudgetError,
    );
    expect(() => resolveCheckedHindsightContextBudget(tooSmall)).toThrow(
      /exceeds the \d+ usable tokens of the declared 4096-token context window/,
    );
  });

  it("REJECTS a per-op window that is too small even when the global is fine", () => {
    expect(() =>
      resolveCheckedHindsightContextBudget({
        provider: "litellm",
        context_window: 200_000,
        retain: { context_window: 8_192 },
      }),
    ).toThrow(/hindsight retain/);
  });

  it("rejects a hand-mutated over-budget config, not just a small window", () => {
    // Guards the assertion itself: if the derivation is ever bypassed or
    // edited to emit a bigger cap, the preflight must still catch it.
    const budget = resolveHindsightContextBudget(localLlm);
    budget.consolidation.maxCompletionTokens = 24_000;
    budget.consolidation.worstCaseTotalTokens =
      budget.consolidation.estimatedPromptTokens + 24_000;
    expect(() => assertHindsightContextBudgetFits(budget)).toThrow(HindsightContextBudgetError);
  });

  it("rejects a retain cap that would brick the container on upstream's own check", () => {
    const budget = resolveHindsightContextBudget(localLlm);
    budget.retain.maxCompletionTokens = HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE;
    budget.retain.worstCaseTotalTokens = 0;
    expect(() => assertHindsightContextBudgetFits(budget)).toThrow(/retain_chunk_size/);
  });

  it("checks the reflect lane too, not just retain and consolidation", () => {
    // The reflect lane was added after the first two; without this the lane
    // could be dropped from the assertion loop and every other preflight test
    // would still pass.
    const budget = resolveHindsightContextBudget(localLlm);
    budget.reflect.maxContextTokens = HINDSIGHT_UPSTREAM_REFLECT_MAX_CONTEXT_TOKENS;
    budget.reflect.worstCaseTotalTokens = HINDSIGHT_UPSTREAM_REFLECT_MAX_CONTEXT_TOKENS;
    expect(() => assertHindsightContextBudgetFits(budget)).toThrow(/hindsight reflect/);
  });

  it("names the config knob to raise, since an overflow is otherwise invisible", () => {
    try {
      resolveCheckedHindsightContextBudget({ provider: "litellm", context_window: 4_096 });
      expect.unreachable("preflight should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("hindsight.llm.context_window");
      expect(msg).toContain("HTTP 200");
    }
  });

  it("accepts every window switchroom ships a default for", () => {
    for (const llm of [undefined, { provider: "litellm" }, { provider: "claude-code" }, localLlm]) {
      expect(() => resolveCheckedHindsightContextBudget(llm)).not.toThrow();
    }
  });
});

describe("hindsight context budget — the safety band binds the retain lane too (#3721)", () => {
  // Retain's worst case pins at 11,072 across this whole band: the prompt term
  // is the FIXED 8,000-token estimate and the completion term is clamped to the
  // 3,072 floor. So the raw window it needs is 11,072, but the band it must fit
  // inside is 0.8 × window — and those two disagree from 11,072 to 13,838.
  const RETAIN_WORST_CASE = HINDSIGHT_RETAIN_PROMPT_ESTIMATE_TOKENS + 3_072;

  it("pins the arithmetic the band boundaries are derived from", () => {
    expect(RETAIN_WORST_CASE).toBe(11_072);
    for (const window of [11_072, 13_838]) {
      const b = resolveHindsightContextBudget({ provider: "litellm", context_window: window });
      // The PRE-FIX check — worst case vs the raw window — passes here. That is
      // what makes the two cases below a regression test rather than a walk of
      // the code path: on main they did not throw.
      expect(b.retain.worstCaseTotalTokens).toBe(RETAIN_WORST_CASE);
      expect(b.retain.worstCaseTotalTokens).toBeLessThanOrEqual(b.retain.windowTokens);
      expect(b.retain.worstCaseTotalTokens).toBeGreaterThan(b.retain.usableTokens);
    }
  });

  it("REJECTS the low edge of the band (11,072 — raw check passes exactly)", () => {
    const at = { provider: "litellm", context_window: 11_072 };
    expect(() => resolveCheckedHindsightContextBudget(at)).toThrow(HindsightContextBudgetError);
    // usable = 11072 − ⌊11072 × 0.2⌋ = 8858.
    expect(usableContextTokens(11_072)).toBe(8_858);
    // Retain trips the band on its own — that is #3721's point, and the `pins
    // the arithmetic` case above asserts it directly. It is no longer the lane
    // NAMED in the message: since the 2026-08 per-fact re-measurement,
    // consolidation at its batch floor of 1 costs 2,270 + 5,000 prompt and is
    // checked first, so it reports at this window too. Both lanes overflowing
    // is a stronger rejection, not a weaker one.
    const b = resolveHindsightContextBudget(at);
    expect(b.consolidation.batchSize).toBe(HINDSIGHT_CONSOLIDATION_BATCH_SIZE_FLOOR);
    expect(b.consolidation.worstCaseTotalTokens).toBeGreaterThan(b.consolidation.usableTokens);
    expect(() => resolveCheckedHindsightContextBudget(at)).toThrow(/hindsight consolidation/);
  });

  it("leaves the smallest admissible window at 13,839 — retain is still the binding lane", () => {
    // The corrected per-fact constant raises consolidation's floor-batch cost,
    // so it is worth pinning that it did NOT move the documented minimum.
    // Consolidation stops fitting below 13,217, which is under retain's 13,839,
    // so retain remains what decides the floor and the module docstring's
    // "smallest declared window switchroom will accept is 13,839" still holds.
    for (const window of [13_217, 13_838]) {
      const b = resolveHindsightContextBudget({ provider: "litellm", context_window: window });
      expect(b.consolidation.worstCaseTotalTokens, `cons@${window}`).toBeLessThanOrEqual(
        b.consolidation.usableTokens,
      );
      expect(b.retain.worstCaseTotalTokens, `retain@${window}`).toBeGreaterThan(
        b.retain.usableTokens,
      );
    }
    expect(() =>
      resolveCheckedHindsightContextBudget({ provider: "litellm", context_window: 13_839 }),
    ).not.toThrow();
  });

  it("REJECTS the high edge of the band (13,838 — usable 11,071, one short)", () => {
    const at = { provider: "litellm", context_window: 13_838 };
    expect(usableContextTokens(13_838)).toBe(RETAIN_WORST_CASE - 1);
    expect(() => resolveCheckedHindsightContextBudget(at)).toThrow(/hindsight retain/);
  });

  it("ACCEPTS the first window above the band (13,839 — usable 11,072)", () => {
    expect(usableContextTokens(13_839)).toBe(RETAIN_WORST_CASE);
    expect(() =>
      resolveCheckedHindsightContextBudget({ provider: "litellm", context_window: 13_839 }),
    ).not.toThrow();
  });

  it("reports the band in the failure text, so the operator can do the sum", () => {
    try {
      resolveCheckedHindsightContextBudget({ provider: "litellm", context_window: 12_000 });
      expect.unreachable("preflight should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("usable tokens");
      expect(msg).toContain("20% safety band");
      expect(msg).toContain("declared 12000-token context window");
    }
  });

  it("holds EVERY lane to the same band — no lane budgets the raw window", () => {
    for (const window of [13_839, 16_384, LOCAL_SLOT_WINDOW, 131_072, 200_000]) {
      const b = resolveHindsightContextBudget({ provider: "litellm", context_window: window });
      const usable = usableContextTokens(window);
      for (const lane of [b.retain, b.consolidation, b.reflect]) {
        expect(lane.usableTokens, `${lane.lane}@${window}`).toBe(usable);
        expect(lane.worstCaseTotalTokens, `${lane.lane}@${window}`).toBeLessThanOrEqual(usable);
      }
    }
  });
});

describe("hindsight context budget — reflect's completion figure is a reserve, not a cap (#3722)", () => {
  it("names it a reserve and never calls it a max-completion cap", () => {
    // Upstream (config.py in the shipped image) defines
    // RETAIN_/CONSOLIDATION_MAX_COMPLETION_TOKENS and nothing equivalent for
    // reflect — its token knobs are REFLECT_MAX_CONTEXT_TOKENS,
    // REFLECT_MAX_ITERATIONS, REFLECT_SOURCE_FACTS_MAX_TOKENS. So the field
    // must not be shaped like an env var switchroom forgot to emit.
    const b = resolveHindsightContextBudget(localLlm);
    expect(b.reflect.completionReserveTokens).toBe(6_144);
    expect(b.reflect).not.toHaveProperty("maxCompletionTokens");
  });

  it("holds the reserve back from the emitted prompt cap", () => {
    // The reserve is unenforceable at runtime, so the ONLY thing it can do is
    // shrink the one number that IS emitted. Assert that it did.
    const b = resolveHindsightContextBudget(localLlm);
    expect(b.reflect.maxContextTokens).toBeLessThanOrEqual(
      b.reflect.usableTokens - b.reflect.completionReserveTokens,
    );
  });

  it("emits no reflect completion var on either path (upstream has no such knob)", () => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, localLlm);
    const runEnv = envPairsFromRun();
    const snippet = generateHindsightComposeSnippet(localLlm);
    const budgetEnv = hindsightLlmBudgetEnv(localLlm).map(([k]) => k);
    for (const key of budgetEnv) expect(key).not.toMatch(/REFLECT.*COMPLETION/);
    expect(runEnv.filter((e) => /REFLECT.*COMPLETION/.test(e))).toEqual([]);
    expect(snippet).not.toMatch(/REFLECT.*COMPLETION/);
    // …and the one reflect var that DOES exist upstream is still emitted.
    expect(budgetEnv).toContain("HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS");
  });
});

describe("hindsight context budget — provider name and base URL agree (#3723)", () => {
  const LOOPBACK = "http://127.0.0.1:4010/v1";

  it("forces the conservative window when a lane's base URL is self-hosted", () => {
    // The hazardous config: `provider: anthropic` is just a routing label on a
    // LiteLLM-fronted local box. Pre-fix this returned 200,000 while
    // hindsightLocalLlmEnabled() called the same endpoint local — the exact
    // silent-overflow shape the preflight exists to reject.
    const llm = { retain: { provider: "anthropic", base_url: LOOPBACK } };
    expect(resolveLaneContextWindow("retain", llm)).toMatchObject({
      windowTokens: HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW,
      windowSource: "provider-default",
      provider: "anthropic",
    });
    expect(defaultContextWindowForProvider("anthropic", LOOPBACK)).toBe(
      HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW,
    );
    // And the budget really is the ratcheted one, not just the number.
    expect(resolveHindsightContextBudget(llm).retain.maxCompletionTokens).toBe(6_144);
  });

  it("agrees with hindsightLocalLlmEnabled on the same config", () => {
    // The two detectors now read the same input, so they cannot disagree.
    for (const url of [LOOPBACK, "http://10.0.0.7:11434", "http://ollama.local:11434"]) {
      const llm = { retain: { provider: "anthropic", base_url: url } };
      expect(hindsightLocalLlmEnabled(llm), url).toBe(true);
      expect(resolveLaneContextWindow("retain", llm).windowTokens, url).toBe(
        HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW,
      );
    }
  });

  it("leaves a genuinely hosted endpoint on the provider default", () => {
    const llm = { retain: { provider: "anthropic", base_url: "https://api.anthropic.com" } };
    expect(hindsightLocalLlmEnabled(llm)).toBe(false);
    expect(resolveLaneContextWindow("retain", llm).windowTokens).toBe(
      HINDSIGHT_CLAUDE_CONTEXT_WINDOW,
    );
  });

  it("only decides the UNDECLARED case — an explicit window still wins", () => {
    const llm = {
      context_window: 131_072,
      retain: { provider: "anthropic", base_url: LOOPBACK },
      reflect: { provider: "anthropic", base_url: LOOPBACK, context_window: 65_536 },
    };
    expect(resolveLaneContextWindow("retain", llm)).toMatchObject({
      windowTokens: 131_072,
      windowSource: "global",
    });
    expect(resolveLaneContextWindow("reflect", llm)).toMatchObject({
      windowTokens: 65_536,
      windowSource: "per-op",
    });
  });

  it("scopes the signal to the lane that carries it", () => {
    // Lanes are budgeted independently: a loopback retain lane must not drag
    // an unrelated claude-code consolidation lane down to 32k.
    const llm = { provider: "claude-code", retain: { base_url: LOOPBACK } };
    expect(resolveLaneContextWindow("retain", llm).windowTokens).toBe(
      HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW,
    );
    expect(resolveLaneContextWindow("consolidation", llm).windowTokens).toBe(
      HINDSIGHT_CLAUDE_CONTEXT_WINDOW,
    );
  });
});

describe("hindsight context budget — emit paths stay in sync (#3716)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
  });

  it("emits the derived budget on BOTH the docker-run and compose paths", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, localLlm);
    const runEnv = envPairsFromRun();
    const snippet = generateHindsightComposeSnippet(localLlm);

    for (const pair of [
      "HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=3",
      "HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS=8192",
      "HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS=6144",
      "HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS=20000",
    ]) {
      expect(runEnv, `docker-run must emit ${pair}`).toContain(pair);
      expect(snippet, `compose must emit ${pair}`).toContain(pair);
    }
  });

  it("emits each budget var exactly once (no stale literal shadowing the derived one)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, localLlm);
    const runEnv = envPairsFromRun();
    const snippet = generateHindsightComposeSnippet(localLlm);
    for (const key of [
      "HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE",
      "HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS",
      "HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS",
      "HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS",
    ]) {
      expect(runEnv.filter((e) => e.startsWith(`${key}=`)), key).toHaveLength(1);
      expect(
        snippet.split("\n").filter((l) => l.includes(`- ${key}=`)),
        key,
      ).toHaveLength(1);
    }
  });

  it("never leaks context_window itself into the container env", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, undefined, {
      ...localLlm,
      consolidation: { context_window: 65_536 },
    });
    const runEnv = envPairsFromRun();
    expect(runEnv.some((e) => /CONTEXT_WINDOW/i.test(e))).toBe(false);
    expect(generateHindsightComposeSnippet(localLlm)).not.toMatch(/CONTEXT_WINDOW/i);
  });

  it("propagates the preflight failure out of hindsightLlmBudgetEnv", () => {
    // Both emit paths go through this one function, so a throw here is what
    // stops an over-budget container ever being launched or written to compose.
    const tooSmall = { provider: "litellm", context_window: 4_096 };
    expect(() => hindsightLlmBudgetEnv(tooSmall)).toThrow(HindsightContextBudgetError);
    expect(() => generateHindsightComposeSnippet(tooSmall)).toThrow(HindsightContextBudgetError);
  });

  it("takes the tighter of the context cap and the #3611 time cap for retain", () => {
    // Large window: the time budget binds (16384), unchanged from before.
    expect(new Map(hindsightLlmBudgetEnv()).get("HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS")).toBe(
      String(HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS),
    );
    // 32k slot: the context budget binds and ratchets it down.
    const local = new Map(hindsightLlmBudgetEnv(localLlm));
    expect(Number(local.get("HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS"))).toBeLessThan(
      HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS,
    );
  });
});
