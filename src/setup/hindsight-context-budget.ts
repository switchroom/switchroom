/**
 * Hindsight context budget — derive token knobs from a DECLARED backend
 * context window instead of hard-coding them.
 *
 * ## Why this file exists
 *
 * Hindsight's retain / reflect / consolidation calls are sized in tokens
 * (`HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE`, the `*_MAX_COMPLETION_TOKENS`
 * caps). Those numbers were tuned when every op ran on Claude behind a 200k
 * window, and NOTHING in switchroom knew how big the backend's window
 * actually was. When the fleet moved hindsight to a local llama.cpp/Ollama
 * backend (`gpt-oss:20b`, launched `-c 65536 -np 2` = a **32,768-token slot**,
 * `--context-shift --keep 4`), the same numbers started overflowing the
 * window — and llama.cpp's context shift makes that overflow SILENT:
 *
 *   - Over the window, llama.cpp discards the oldest tokens and keeps only
 *     the first `--keep` (=4). The system prompt carrying the extraction
 *     instructions and the JSON schema sits at the FRONT, so it is what gets
 *     discarded, mid-generation.
 *   - The model is then answering a bare transcript with no instructions, so
 *     it replies conversationally. Observed verbatim body from LiteLLM
 *     SpendLogs: `"Got it! If you have any questions or need assistance with
 *     something specific, just let me know."` Another was a numbered prose
 *     list where a JSON object was required.
 *   - Both came back **HTTP 200 with `finish_reason: "stop"`**. There is no
 *     error signal anywhere in the stack. Retain/consolidation just silently
 *     stop extracting anything.
 *
 * Measured on 24h of live local traffic (LiteLLM_SpendLogs, model
 * `openai/gpt-oss:20b`, n=695) against that 32,768-token slot:
 *
 *   - p50 prompt 5,244 tok; **p90 prompt 32,270 tok**; max 32,754 tok
 *   - 262/695 = **38%** of calls exceeded 16,384 prompt tokens
 *   - malformed-response rate: 44% and 47% on the two local boxes, vs **2%**
 *     on an OpenRouter route with a 131k window — i.e. the variable is the
 *     window, not the model.
 *
 * Ruled out by direct test, do not revisit: the model itself (the real
 * production prompt + schema passes 10/10 in isolation), `strict: true` vs
 * `false` (10/10 both), `drop_params`, the `think` / `reasoning_effort`
 * extra_body params, and LiteLLM pass-through.
 *
 * ## The durable fix
 *
 * Declare the window (`hindsight.llm.context_window`, per-op overridable) and
 * DERIVE the token knobs from it, then assert at setup time that the derived
 * worst case fits. Hard-coding "better" constants would only relocate the
 * same latent bug to the next backend swap; a declared window plus a
 * deterministic preflight is what makes the swap loud instead of silent.
 */

/** Per-op LLM config fields this module cares about (structural subset). */
export interface ContextBudgetPerOpInput {
  provider?: string;
  context_window?: number;
}

/** `hindsight.llm` fields this module cares about (structural subset). */
export interface ContextBudgetLlmInput {
  provider?: string;
  context_window?: number;
  retain?: ContextBudgetPerOpInput;
  reflect?: ContextBudgetPerOpInput;
  consolidation?: ContextBudgetPerOpInput;
}

/** The lanes with a derived token budget. */
export type HindsightBudgetLane = "retain" | "reflect" | "consolidation";

/**
 * Declared-window default for the `claude-code` provider — the
 * subscription-honest default path, which is Claude behind a 200k window.
 * Keeps the historical (pre-budget) behaviour for every existing install.
 */
export const HINDSIGHT_CLAUDE_CONTEXT_WINDOW = 200_000;

/**
 * Declared-window default for every OTHER provider (`litellm`, `openai`,
 * `openrouter`, …). Deliberately conservative: in switchroom's own fleet
 * `provider: litellm` points at a loopback proxy in front of local
 * llama.cpp slots, and a 32,768-token slot is exactly the configuration that
 * produced the silent-overflow incident above. An operator on a genuinely
 * large-window route raises it explicitly via `hindsight.llm.context_window`
 * — under-declaring costs throughput, over-declaring corrupts memory.
 */
export const HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW = 32_768;

/**
 * Fraction of the declared window held back and never budgeted. Absorbs
 * tokenizer disagreement (switchroom estimates in tokens, the backend counts
 * with a different tokenizer), per-request chat-template overhead, and the
 * long tail above p90 prompt size. 20% of a 32k slot = ~6.5k tokens of slack.
 */
export const HINDSIGHT_CONTEXT_SAFETY_FRACTION = 0.2;

/**
 * Fixed prompt cost of ONE consolidation call, independent of batch size:
 * system prompt + JSON schema + recall context. Back-derived from the
 * measured p90 (32,270 prompt tokens at batch size 12) split as
 * `overhead + batch × per-fact` — see {@link HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT}.
 */
export const HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS = 2_270;

/**
 * Marginal prompt cost of each additional fact in a consolidation batch.
 * 30,000 / 12 from the same measured p90 decomposition. This is the number
 * that makes batch size a TOKEN decision rather than a throughput one — the
 * comment this fix replaced claimed batch size was "tokens-per-call, not
 * concurrency, so it doesn't affect the ceiling", which was true of the
 * *quota* ceiling and dead wrong about the *context* ceiling.
 */
export const HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT = 2_500;

/**
 * Worst-case prompt size of one retain (fact-extraction) call: the chunk
 * being extracted plus the retain mission, session context and JSON schema.
 * Sized off the measured p90 for the retain lane rather than the fixed
 * `retain_chunk_size` (3,000 CHARS upstream) because the surrounding context
 * dominates.
 */
export const HINDSIGHT_RETAIN_PROMPT_ESTIMATE_TOKENS = 8_000;

/**
 * Batch-size ceiling. 12 is switchroom's historical tuned value (#2894:
 * bigger batches = fewer LLM calls = less shared-quota pressure), so the
 * budget only ever ratchets batch size DOWN from it when the declared window
 * can't fit it. A 200k or 131k window therefore keeps 12 — an operator on a
 * big-window backend is not penalised by this change.
 */
export const HINDSIGHT_CONSOLIDATION_BATCH_SIZE_CEILING = 12;

/** Never emit a batch below this — a batch of 1 is still valid upstream. */
export const HINDSIGHT_CONSOLIDATION_BATCH_SIZE_FLOOR = 1;

/**
 * Ceilings on the derived completion caps — past these, more is pure waste.
 *
 * The retain ceiling deliberately equals `HINDSIGHT_DEFAULT_RETAIN_MAX_COMPLETION_TOKENS`
 * in `hindsight.ts` (#3611's TIME budget: 16384 tokens ≈ 3.4 min at the
 * slowest measured local rate). Mirrored here rather than imported to keep
 * this module dependency-free; `tests/setup/hindsight-context-budget.test.ts`
 * asserts the two stay equal, so the mirror is a check and not a comment. The
 * effect: on a large window the context budget agrees with the time budget and
 * changes nothing, and only a small window ratchets retain down.
 */
export const HINDSIGHT_CONSOLIDATION_MAX_COMPLETION_CEILING = 16_384;
export const HINDSIGHT_RETAIN_MAX_COMPLETION_CEILING = 16_384;

/**
 * Upstream `DEFAULT_RETAIN_CHUNK_SIZE` (config.py). Upstream hard-validates
 * `retain_max_completion_tokens > retain_chunk_size` and refuses to boot
 * otherwise, so the retain floor must clear it. Mirrored here so a shrinking
 * window can never derive a value that bricks the container.
 */
export const HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE = 3_000;

/** Floors for the derived completion caps. Retain's clears the upstream check. */
export const HINDSIGHT_CONSOLIDATION_MAX_COMPLETION_FLOOR = 1_024;
export const HINDSIGHT_RETAIN_MAX_COMPLETION_FLOOR = HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE + 72;

/**
 * Upstream `DEFAULT_REFLECT_MAX_CONTEXT_TOKENS` (config.py) — **100,000**.
 * That is the reflect loop's accumulate-until-you-force-the-final-prompt
 * bound, and against a 32,768-token slot it is not a bound at all: a long
 * agentic reflect walks straight through the window and gets context-shifted,
 * i.e. the same invisible HTTP-200 failure as the consolidation lane. Mirrored
 * here only so the derivation can be compared against what it replaces.
 */
export const HINDSIGHT_UPSTREAM_REFLECT_MAX_CONTEXT_TOKENS = 100_000;

/** Floor on the derived reflect prompt cap — below this, reflect can't work. */
export const HINDSIGHT_REFLECT_MAX_CONTEXT_FLOOR = 2_048;

/** Where a lane's declared window came from — surfaced in preflight errors. */
export type ContextWindowSource = "per-op" | "global" | "provider-default";

export interface HindsightLaneBudget {
  lane: HindsightBudgetLane;
  /** Declared context window (tokens) for this lane's backend. */
  windowTokens: number;
  windowSource: ContextWindowSource;
  /** Effective provider for this lane (per-op override → global → default). */
  provider: string;
  /** Derived `HINDSIGHT_API_<LANE>_MAX_COMPLETION_TOKENS`. */
  maxCompletionTokens: number;
  /** Estimated worst-case PROMPT tokens for one call at the derived settings. */
  estimatedPromptTokens: number;
  /** `estimatedPromptTokens + maxCompletionTokens` — must fit the window. */
  worstCaseTotalTokens: number;
}

export interface HindsightConsolidationBudget extends HindsightLaneBudget {
  lane: "consolidation";
  /** Derived `HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE`. */
  batchSize: number;
}

export interface HindsightReflectBudget extends HindsightLaneBudget {
  lane: "reflect";
  /**
   * Derived `HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS` — the reflect loop's
   * accumulated-context bound. Equal to `estimatedPromptTokens`, because for
   * this lane the cap IS the worst-case prompt: the engine forces the final
   * prompt once accumulation reaches it.
   */
  maxContextTokens: number;
}

export interface HindsightContextBudget {
  retain: HindsightLaneBudget;
  reflect: HindsightReflectBudget;
  consolidation: HindsightConsolidationBudget;
}

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, value));
}

/**
 * Default window for a provider name. `claude-code` (and a raw `anthropic`
 * provider) get Claude's 200k; everything else gets the conservative local
 * default, because a non-Claude provider in switchroom overwhelmingly means
 * "LiteLLM in front of something local whose window we do not know".
 */
export function defaultContextWindowForProvider(provider: string): number {
  const p = provider.trim().toLowerCase();
  if (p === "claude-code" || p === "anthropic") return HINDSIGHT_CLAUDE_CONTEXT_WINDOW;
  return HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW;
}

/**
 * Resolve one lane's declared window: per-op override → global → the
 * per-provider default for that lane's EFFECTIVE provider (per-op provider
 * override wins, since a lane can be pointed at a different backend).
 */
export function resolveLaneContextWindow(
  lane: HindsightBudgetLane,
  llm?: ContextBudgetLlmInput,
): { windowTokens: number; windowSource: ContextWindowSource; provider: string } {
  const perOp = llm?.[lane];
  const provider = perOp?.provider?.trim() || llm?.provider?.trim() || "claude-code";
  const perOpWindow = perOp?.context_window;
  if (typeof perOpWindow === "number" && perOpWindow > 0) {
    return { windowTokens: Math.floor(perOpWindow), windowSource: "per-op", provider };
  }
  const globalWindow = llm?.context_window;
  if (typeof globalWindow === "number" && globalWindow > 0) {
    return { windowTokens: Math.floor(globalWindow), windowSource: "global", provider };
  }
  return {
    windowTokens: defaultContextWindowForProvider(provider),
    windowSource: "provider-default",
    provider,
  };
}

/**
 * Derive every window-dependent hindsight token knob from the declared
 * windows. Pure — no IO, no env reads — so both emit paths and the preflight
 * check can call it and can never disagree.
 *
 * Shape of the derivation, per lane:
 *
 *   usable          = window − window × SAFETY_FRACTION
 *   maxCompletion   = clamp(window × laneShare, floor, ceiling)
 *   promptBudget    = usable − maxCompletion
 *   batchSize       = clamp(⌊(promptBudget − OVERHEAD) / PER_FACT⌋, 1, 12)
 *
 * For a 32,768-token window that lands on batch 6 / consolidation completion
 * 8,192 / retain completion 6,144 — the values applied by hand to the live
 * container when the incident was diagnosed. For 131k or 200k it lands on
 * the historical batch 12, so a big-window operator loses nothing.
 */
export function resolveHindsightContextBudget(
  llm?: ContextBudgetLlmInput,
): HindsightContextBudget {
  const cons = resolveLaneContextWindow("consolidation", llm);
  const ret = resolveLaneContextWindow("retain", llm);

  const consMaxCompletion = clamp(
    Math.floor(cons.windowTokens / 4),
    HINDSIGHT_CONSOLIDATION_MAX_COMPLETION_FLOOR,
    HINDSIGHT_CONSOLIDATION_MAX_COMPLETION_CEILING,
  );
  const consUsable = cons.windowTokens - Math.floor(cons.windowTokens * HINDSIGHT_CONTEXT_SAFETY_FRACTION);
  const consPromptBudget = consUsable - consMaxCompletion;
  const batchSize = clamp(
    Math.floor(
      (consPromptBudget - HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS) /
        HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT,
    ),
    HINDSIGHT_CONSOLIDATION_BATCH_SIZE_FLOOR,
    HINDSIGHT_CONSOLIDATION_BATCH_SIZE_CEILING,
  );
  const consPrompt =
    HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS +
    batchSize * HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT;

  const retMaxCompletion = clamp(
    Math.floor((ret.windowTokens * 3) / 16),
    HINDSIGHT_RETAIN_MAX_COMPLETION_FLOOR,
    HINDSIGHT_RETAIN_MAX_COMPLETION_CEILING,
  );

  // Reflect is a prompt-side cap, not a completion cap: the loop accumulates
  // context and the engine forces the final prompt when it hits this bound. So
  // budget it as `usable window − room for reflect's own answer`, using the
  // same 3/16 completion share the retain lane gets. Rounded DOWN to a whole
  // thousand purely for legibility in `docker inspect` (32,768 → 20,000).
  const refl = resolveLaneContextWindow("reflect", llm);
  const reflCompletionAllowance = clamp(
    Math.floor((refl.windowTokens * 3) / 16),
    HINDSIGHT_RETAIN_MAX_COMPLETION_FLOOR,
    HINDSIGHT_RETAIN_MAX_COMPLETION_CEILING,
  );
  const reflUsable =
    refl.windowTokens - Math.floor(refl.windowTokens * HINDSIGHT_CONTEXT_SAFETY_FRACTION);
  const reflMaxContext = Math.max(
    HINDSIGHT_REFLECT_MAX_CONTEXT_FLOOR,
    Math.floor((reflUsable - reflCompletionAllowance) / 1000) * 1000,
  );

  return {
    consolidation: {
      lane: "consolidation",
      windowTokens: cons.windowTokens,
      windowSource: cons.windowSource,
      provider: cons.provider,
      batchSize,
      maxCompletionTokens: consMaxCompletion,
      estimatedPromptTokens: consPrompt,
      worstCaseTotalTokens: consPrompt + consMaxCompletion,
    },
    reflect: {
      lane: "reflect",
      windowTokens: refl.windowTokens,
      windowSource: refl.windowSource,
      provider: refl.provider,
      maxContextTokens: reflMaxContext,
      maxCompletionTokens: reflCompletionAllowance,
      estimatedPromptTokens: reflMaxContext,
      worstCaseTotalTokens: reflMaxContext + reflCompletionAllowance,
    },
    retain: {
      lane: "retain",
      windowTokens: ret.windowTokens,
      windowSource: ret.windowSource,
      provider: ret.provider,
      maxCompletionTokens: retMaxCompletion,
      estimatedPromptTokens: HINDSIGHT_RETAIN_PROMPT_ESTIMATE_TOKENS,
      worstCaseTotalTokens: HINDSIGHT_RETAIN_PROMPT_ESTIMATE_TOKENS + retMaxCompletion,
    },
  };
}

/** Thrown by {@link assertHindsightContextBudgetFits}. */
export class HindsightContextBudgetError extends Error {
  readonly lane: HindsightBudgetLane;
  constructor(lane: HindsightBudgetLane, message: string) {
    super(message);
    this.name = "HindsightContextBudgetError";
    this.lane = lane;
  }
}

function laneFailure(b: HindsightLaneBudget): string | undefined {
  if (b.worstCaseTotalTokens > b.windowTokens) {
    return (
      `hindsight ${b.lane}: worst-case ${b.worstCaseTotalTokens} tokens ` +
      `(${b.estimatedPromptTokens} prompt + ${b.maxCompletionTokens} completion) ` +
      `exceeds the declared ${b.windowTokens}-token context window ` +
      `(source: ${b.windowSource}, provider: ${b.provider}).`
    );
  }
  if (b.lane === "retain" && b.maxCompletionTokens <= HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE) {
    return (
      `hindsight retain: derived max_completion_tokens ${b.maxCompletionTokens} is not ` +
      `greater than the upstream retain_chunk_size ${HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE}; ` +
      `the hindsight container refuses to boot with this combination.`
    );
  }
  return undefined;
}

/**
 * Preflight: fail LOUDLY when the derived budget cannot fit the declared
 * window. This is the whole point of the change.
 *
 * A context overflow on a llama.cpp backend produces a well-formed HTTP 200
 * carrying conversational garbage — no exception, no non-2xx, no
 * `finish_reason` anomaly, nothing to alert on. The only place the mismatch
 * is knowable is HERE, before the container is launched, where it is a pure
 * arithmetic comparison. Prompt discipline can't guarantee this; a throw at
 * setup time can.
 */
export function assertHindsightContextBudgetFits(budget: HindsightContextBudget): void {
  for (const lane of [
    budget.consolidation,
    budget.retain,
    budget.reflect,
  ] as HindsightLaneBudget[]) {
    const failure = laneFailure(lane);
    if (failure) {
      throw new HindsightContextBudgetError(
        lane.lane,
        `${failure}\n` +
          `A local backend does NOT error on context overflow — llama.cpp context-shift ` +
          `silently drops the system prompt and returns HTTP 200 with conversational text ` +
          `instead of the required JSON, so this must be caught here.\n` +
          `Fix: raise \`hindsight.llm.context_window\` (or \`hindsight.llm.${lane.lane}.context_window\`) ` +
          `to the backend's real window, or point the lane at a larger-window model.`,
      );
    }
  }
}

/**
 * Derive + assert in one call. Callers get a budget that has already passed
 * the preflight, so there is no way to render env from an unchecked one.
 *
 * The env pairs themselves are emitted by `hindsightLlmBudgetEnv()` in
 * `hindsight.ts`, which is the single source both the `docker run -e` path
 * and the generated-compose path already share — the retain completion cap
 * has a SECOND, time-based bound there (#3611) and the two must be combined
 * in one place rather than raced from two emitters.
 */
export function resolveCheckedHindsightContextBudget(
  llm?: ContextBudgetLlmInput,
): HindsightContextBudget {
  const budget = resolveHindsightContextBudget(llm);
  assertHindsightContextBudgetFits(budget);
  return budget;
}
