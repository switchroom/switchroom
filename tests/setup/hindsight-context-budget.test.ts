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
  HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS,
  HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT,
  HINDSIGHT_RETAIN_MAX_COMPLETION_CEILING,
  HINDSIGHT_UPSTREAM_REFLECT_MAX_CONTEXT_TOKENS,
  HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE,
  HindsightContextBudgetError,
  assertHindsightContextBudgetFits,
  resolveCheckedHindsightContextBudget,
  resolveHindsightContextBudget,
  resolveLaneContextWindow,
} from "../../src/setup/hindsight-context-budget.js";
import {
  HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS,
  generateHindsightComposeSnippet,
  hindsightLlmBudgetEnv,
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
  it("lands on the hand-applied 32k values: batch 6 / consolidation 8192 / retain 6144", () => {
    const b = resolveHindsightContextBudget(localLlm);
    expect(b.consolidation.batchSize).toBe(6);
    expect(b.consolidation.maxCompletionTokens).toBe(8192);
    expect(b.retain.maxCompletionTokens).toBe(6144);
  });

  it("keeps worst-case prompt+completion strictly inside a 32k window", () => {
    // THE regression assertion. On main the emitted batch size was a hard 12,
    // whose measured p90 prompt was 32,270 tokens against a 32,768 slot — with
    // an uncapped completion on top, i.e. guaranteed overflow. Recomputing the
    // pre-fix worst case here proves this test would have failed on the bug.
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
    expect(resolveHindsightContextBudget({ provider: "litellm" }).consolidation.batchSize).toBe(6);
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
      /exceeds the declared 4096-token context window/,
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
      "HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=6",
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
