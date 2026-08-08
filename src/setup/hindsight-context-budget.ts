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

import { isSelfHostedHttpUrl } from "./self-hosted-url.js";

/** Per-op LLM config fields this module cares about (structural subset). */
export interface ContextBudgetPerOpInput {
  provider?: string;
  /**
   * `HINDSIGHT_API_<OP>_LLM_BASE_URL`. Read here (#3723) because the endpoint
   * is a STRONGER signal than the provider name for "how big is this lane's
   * window?": a LiteLLM-fronted local box routinely carries the upstream
   * vendor's name as its provider label.
   */
  base_url?: string;
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
 * system prompt + JSON schema + recall context. Held at its original value and
 * treated as the KNOWN term when the marginal per-fact cost was re-measured
 * against production in 2026-08 — the measurement solves
 * `input = overhead + batch × per-fact` for the per-fact term with this
 * overhead fixed, so an error here lands entirely in
 * {@link HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT}, which is the conservative
 * place for it (the per-fact term is what shrinks the batch). Re-measuring the
 * intercept needs a spread of batch sizes the production log does not supply:
 * outside batch 6, every sample is a post-split remainder.
 */
export const HINDSIGHT_CONSOLIDATION_PROMPT_OVERHEAD_TOKENS = 2_270;

/**
 * Marginal prompt cost of each additional fact in a consolidation batch.
 *
 * This is the number that makes batch size a TOKEN decision rather than a
 * throughput one — the comment the original fix replaced claimed batch size
 * was "tokens-per-call, not concurrency, so it doesn't affect the ceiling",
 * which was true of the *quota* ceiling and dead wrong about the *context*
 * ceiling.
 *
 * **Measured, not back-derived (2026-08-09).** This constant was 2,500,
 * justified as `30,000 / 12`: the whole of a measured p90 prompt at batch 12
 * divided by the batch. That derivation is unsound twice over — it attributes
 * the ENTIRE prompt (fixed overhead included) to the marginal per-fact cost,
 * and it reads one p90 sample at one batch size as the marginal cost at
 * another. The old docstring's own record of a batch-8 experiment on
 * 2026-07-28 hitting 15.5% `OutputTooLongError` against a 32,768-token window
 * was the first symptom of the constant being too small.
 *
 * The replacement is measured directly off production. 24h of
 * `switchroom-hindsight` logs were joined per batch: each
 * `[CONSOLIDATION] … llm_batch #N (K memories, 1 llm calls)` summary line
 * gives the batch size, and the `slow llm call: scope=consolidation …
 * input_tokens=` line for that same call gives the backend's OWN tokenizer
 * count of the prompt. (The summary line's `input_tokens=~` field is only an
 * internal estimate and under-reports the real count by ~20%, which is part of
 * why this went unnoticed.) Restricted to unsplit, single-call batches of 6 —
 * n = 450, banks `overlord` and `klanker`:
 *
 * ```
 *   p50 25,585   p90 28,882   p95 29,738   p99 31,391   max 31,903
 * ```
 *
 * Solving `input = OVERHEAD + 6 × PER_FACT` across that tail gives 4,435 (p90)
 * / 4,578 (p95) / 4,854 (p99) / 4,939 (max) tokens per fact: the old 2,500 was
 * low by ~1.8×. This constant feeds a safety preflight, so it must bound the
 * tail rather than the average — it takes the observed **maximum**, rounded up
 * to 5,000. (Batch 3 holds for any value in 3,939…5,251, so the rounding is
 * slack, not a cliff.)
 *
 * Production evidence that the resulting batch size of 3 is the right answer,
 * from the same 24h window: **9 `LLM failed for sub-batch of 6, splitting into
 * 3/3` events, and zero failures at any smaller sub-batch size.** Every 6 → 3/3
 * split then succeeded. Corroboration from the other direction, same window:
 * genuine (unsplit, not post-split) batches of 3 measured n = 9, max 17,160
 * prompt tokens — which the corrected estimate for a batch of 3
 * (2,270 + 3 × 5,000 = 17,270) bounds, where the old constant's estimate for a
 * batch of 6 did not bound the batch-6 measurement.
 *
 * Under the old constant a 32,768-token window derived
 * batch 6 with an estimated worst case of 25,462 tokens, which "fit" the 26,215
 * usable band and passed preflight — while real prompts reached 31,707, so
 * `prompt + 8,192 requested completion` blew straight through the window, the
 * backend truncated, and hindsight logged `LiteLLM response was truncated due
 * to token limit`, retried three times uselessly (LiteLLM's redis cache returns
 * the identical truncated response), then split the batch.
 *
 * The trade is throughput for correctness: on a 32k backend batch 6 → 3 roughly
 * doubles the consolidation LLM call count, and the LLM is already the
 * bottleneck. That is the intended direction — under-declaring costs
 * throughput, over-declaring corrupts memory. A 131k or 200k window still
 * derives the historical batch 12 under this constant, so a big-window operator
 * is unaffected.
 */
export const HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT = 5_000;

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
  /**
   * `windowTokens` minus the {@link HINDSIGHT_CONTEXT_SAFETY_FRACTION} band —
   * the budget every lane is actually held to. This, not `windowTokens`, is
   * what the preflight compares against (#3721).
   */
  usableTokens: number;
  windowSource: ContextWindowSource;
  /** Effective provider for this lane (per-op override → global → default). */
  provider: string;
  /** Derived `HINDSIGHT_API_<LANE>_MAX_COMPLETION_TOKENS`. */
  maxCompletionTokens: number;
  /** Estimated worst-case PROMPT tokens for one call at the derived settings. */
  estimatedPromptTokens: number;
  /** `estimatedPromptTokens + maxCompletionTokens` — must fit `usableTokens`. */
  worstCaseTotalTokens: number;
}

export interface HindsightConsolidationBudget extends HindsightLaneBudget {
  lane: "consolidation";
  /** Derived `HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE`. */
  batchSize: number;
}

/**
 * The reflect lane. Deliberately NOT an extension of {@link HindsightLaneBudget}:
 * reflect has no `maxCompletionTokens`, because **upstream exposes no reflect
 * completion cap** (#3722).
 *
 * Verified against the shipped image: `config.py` defines
 * `HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS` and
 * `HINDSIGHT_API_CONSOLIDATION_MAX_COMPLETION_TOKENS` and nothing of the kind
 * for reflect — its only token knobs are `REFLECT_MAX_CONTEXT_TOKENS`,
 * `REFLECT_MAX_ITERATIONS` and `REFLECT_SOURCE_FACTS_MAX_TOKENS`. So the
 * completion figure here can only ever be a **reserve held back from the
 * prompt cap**, never a cap pushed to the backend, and it is named that way so
 * nobody reads it as an env-var-shaped quantity that failed to be emitted.
 */
export interface HindsightReflectBudget {
  lane: "reflect";
  windowTokens: number;
  usableTokens: number;
  windowSource: ContextWindowSource;
  provider: string;
  /**
   * Derived `HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS` — the reflect loop's
   * accumulated-context bound. Equal to `estimatedPromptTokens`, because for
   * this lane the cap IS the worst-case prompt: the engine forces the final
   * prompt once accumulation reaches it. This is the ONLY reflect number
   * switchroom emits.
   */
  maxContextTokens: number;
  /**
   * Tokens held back from `maxContextTokens` to leave room for reflect's own
   * answer. **Not enforced at runtime** — see the interface doc: reflect's
   * completion length is whatever the backend does, so this is a heuristic
   * reserve, not a guarantee. Sizing it is the only thing switchroom can do.
   */
  completionReserveTokens: number;
  estimatedPromptTokens: number;
  /**
   * `maxContextTokens + completionReserveTokens`. A self-consistency check on
   * the derivation (did we actually hold the reserve back inside the usable
   * band?), NOT an end-to-end proof — only `maxContextTokens` reaches the
   * backend.
   */
  worstCaseTotalTokens: number;
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
 * The part of a declared window a lane may actually budget against: the window
 * minus the {@link HINDSIGHT_CONTEXT_SAFETY_FRACTION} band. Single definition
 * so no lane can quietly skip the band — the retain lane did exactly that
 * before #3721, and its worst case (a FIXED 8,000-token prompt estimate plus
 * the 3,072 completion floor) was checked against the raw window.
 */
export function usableContextTokens(windowTokens: number): number {
  return windowTokens - Math.floor(windowTokens * HINDSIGHT_CONTEXT_SAFETY_FRACTION);
}

/**
 * Default window for a lane, from `(provider, base_url)` JOINTLY.
 *
 * `claude-code` (and a raw `anthropic` provider) get Claude's 200k; everything
 * else gets the conservative local default, because a non-Claude provider in
 * switchroom overwhelmingly means "LiteLLM in front of something local whose
 * window we do not know".
 *
 * A **self-hosted `base_url` overrides the provider name** and forces the
 * conservative window (#3723). Before that, this function read only the
 * provider name while {@link isSelfHostedHttpUrl}-based
 * `hindsightLocalLlmEnabled` read only the URL, and the two fail-safed in
 * OPPOSITE directions — so
 *
 * ```yaml
 * retain: { provider: anthropic, base_url: http://127.0.0.1:4010 }
 * ```
 *
 * was throttled as a local endpoint by the concurrency caps and simultaneously
 * budgeted for a 200,000-token window here: precisely the silent-overflow
 * config the preflight exists to reject. The base URL is the stronger signal
 * (it is where the traffic actually terminates), and both fail-safes now point
 * the same way — toward the conservative window — because under-declaring
 * costs throughput while over-declaring corrupts memory.
 *
 * @param provider effective provider name for the lane.
 * @param baseUrl effective `base_url` for the lane, if the operator set one.
 */
export function defaultContextWindowForProvider(provider: string, baseUrl?: string): number {
  const url = baseUrl?.trim();
  if (url && isSelfHostedHttpUrl(url)) return HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW;
  const p = provider.trim().toLowerCase();
  if (p === "claude-code" || p === "anthropic") return HINDSIGHT_CLAUDE_CONTEXT_WINDOW;
  return HINDSIGHT_CONSERVATIVE_CONTEXT_WINDOW;
}

/**
 * Resolve one lane's declared window: per-op override → global → the default
 * for that lane's EFFECTIVE `(provider, base_url)` pair (the per-op provider
 * and base URL win, since a lane can be pointed at a different backend).
 *
 * An explicitly declared window — per-op or global — always wins over the
 * default, so `base_url` only ever decides the UNDECLARED case. An operator
 * who declares a window is taken at their word.
 */
export function resolveLaneContextWindow(
  lane: HindsightBudgetLane,
  llm?: ContextBudgetLlmInput,
): {
  windowTokens: number;
  windowSource: ContextWindowSource;
  provider: string;
  baseUrl?: string;
} {
  const perOp = llm?.[lane];
  const provider = perOp?.provider?.trim() || llm?.provider?.trim() || "claude-code";
  // Only the lane's OWN base URL. Lanes are budgeted independently, and the
  // config schema puts `base_url` on the per-op block only — `hindsight.llm`
  // itself has no global `base_url` field (`HindsightPerOpLlmSchema` in
  // config/schema.ts, `HindsightPerOpLlmConfig` in hindsight.ts), so there is
  // nothing to inherit from.
  const baseUrl = perOp?.base_url?.trim() || undefined;
  const perOpWindow = perOp?.context_window;
  if (typeof perOpWindow === "number" && perOpWindow > 0) {
    return { windowTokens: Math.floor(perOpWindow), windowSource: "per-op", provider, baseUrl };
  }
  const globalWindow = llm?.context_window;
  if (typeof globalWindow === "number" && globalWindow > 0) {
    return { windowTokens: Math.floor(globalWindow), windowSource: "global", provider, baseUrl };
  }
  return {
    windowTokens: defaultContextWindowForProvider(provider, baseUrl),
    windowSource: "provider-default",
    provider,
    baseUrl,
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
 * For a 32,768-token window that lands on batch 3 / consolidation completion
 * 8,192 / retain completion 6,144. Batch 3, not the 6 this originally derived:
 * the per-fact constant was re-measured against production in 2026-08 and the
 * old value was low by ~1.8×, so 32k backends were passing preflight at a
 * batch whose real prompts overflowed the window (see
 * {@link HINDSIGHT_CONSOLIDATION_TOKENS_PER_FACT}). For 131k or 200k it still
 * lands on the historical batch 12, so a big-window operator loses nothing.
 *
 * The retain lane has no batch knob and a FIXED prompt estimate, so nothing in
 * its derivation shrinks with the window — `usable` binds it only through the
 * preflight (see {@link assertHindsightContextBudgetFits}), which is why that
 * check must compare against `usableTokens` and not the raw window (#3721).
 * Practical effect: the smallest declared window switchroom will accept is
 * 13,839 tokens (retain's 11,072-token worst case inside an 80% band), up from
 * 11,072 before the fix. No derived value changed — only which windows the
 * preflight admits.
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
  const consUsable = usableContextTokens(cons.windowTokens);
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
  //
  // The subtracted "room" is a RESERVE, not a cap (#3722): upstream has no
  // reflect completion knob to emit it into, so holding it back from the
  // prompt cap is the only enforcement available. See HindsightReflectBudget.
  const refl = resolveLaneContextWindow("reflect", llm);
  const reflCompletionReserve = clamp(
    Math.floor((refl.windowTokens * 3) / 16),
    HINDSIGHT_RETAIN_MAX_COMPLETION_FLOOR,
    HINDSIGHT_RETAIN_MAX_COMPLETION_CEILING,
  );
  const reflUsable = usableContextTokens(refl.windowTokens);
  const reflMaxContext = Math.max(
    HINDSIGHT_REFLECT_MAX_CONTEXT_FLOOR,
    Math.floor((reflUsable - reflCompletionReserve) / 1000) * 1000,
  );

  return {
    consolidation: {
      lane: "consolidation",
      windowTokens: cons.windowTokens,
      usableTokens: consUsable,
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
      usableTokens: reflUsable,
      windowSource: refl.windowSource,
      provider: refl.provider,
      maxContextTokens: reflMaxContext,
      completionReserveTokens: reflCompletionReserve,
      estimatedPromptTokens: reflMaxContext,
      worstCaseTotalTokens: reflMaxContext + reflCompletionReserve,
    },
    retain: {
      lane: "retain",
      windowTokens: ret.windowTokens,
      usableTokens: usableContextTokens(ret.windowTokens),
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

/**
 * The lane-shaped subset the preflight checks. Reflect's completion figure is
 * a reserve rather than a cap (#3722), so it is normalised in here under a
 * neutral name instead of being called a `maxCompletionTokens` it is not.
 */
interface LaneCheck {
  lane: HindsightBudgetLane;
  windowTokens: number;
  usableTokens: number;
  windowSource: ContextWindowSource;
  provider: string;
  estimatedPromptTokens: number;
  completionTokens: number;
  /** "completion" for retain/consolidation, "completion reserve" for reflect. */
  completionLabel: string;
  worstCaseTotalTokens: number;
  /** Only retain has upstream's `> retain_chunk_size` boot check. */
  maxCompletionTokens?: number;
}

function laneCheck(b: HindsightLaneBudget): LaneCheck {
  return { ...b, completionTokens: b.maxCompletionTokens, completionLabel: "completion" };
}

function reflectLaneCheck(b: HindsightReflectBudget): LaneCheck {
  return {
    ...b,
    completionTokens: b.completionReserveTokens,
    completionLabel: "completion reserve",
  };
}

function laneFailure(b: LaneCheck): string | undefined {
  // Against `usableTokens`, NOT the raw window (#3721). The safety band is the
  // whole defence against the prompt ESTIMATES being wrong, and an overflow is
  // silent, so a lane whose worst case only fits by eating the band has no
  // slack left for the thing the band exists to absorb.
  if (b.worstCaseTotalTokens > b.usableTokens) {
    return (
      `hindsight ${b.lane}: worst-case ${b.worstCaseTotalTokens} tokens ` +
      `(${b.estimatedPromptTokens} prompt + ${b.completionTokens} ${b.completionLabel}) ` +
      `exceeds the ${b.usableTokens} usable tokens of ` +
      `the declared ${b.windowTokens}-token context window ` +
      `(${Math.round(HINDSIGHT_CONTEXT_SAFETY_FRACTION * 100)}% safety band held back; ` +
      `source: ${b.windowSource}, provider: ${b.provider}).`
    );
  }
  if (
    b.lane === "retain" &&
    b.maxCompletionTokens !== undefined &&
    b.maxCompletionTokens <= HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE
  ) {
    return (
      `hindsight retain: derived max_completion_tokens ${b.maxCompletionTokens} is not ` +
      `greater than the upstream retain_chunk_size ${HINDSIGHT_UPSTREAM_RETAIN_CHUNK_SIZE}; ` +
      `the hindsight container refuses to boot with this combination.`
    );
  }
  return undefined;
}

/**
 * Preflight: fail LOUDLY when the derived budget cannot fit the **usable** part
 * of the declared window (window minus the safety band). This is the whole
 * point of the change.
 *
 * A context overflow on a llama.cpp backend produces a well-formed HTTP 200
 * carrying conversational garbage — no exception, no non-2xx, no
 * `finish_reason` anomaly, nothing to alert on. The only place the mismatch
 * is knowable is HERE, before the container is launched, where it is a pure
 * arithmetic comparison. Prompt discipline can't guarantee this; a throw at
 * setup time can.
 *
 * How strong the guarantee is, honestly, per lane (#3722):
 *
 *  - **retain / consolidation** — end to end. Both terms are emitted:
 *    the prompt side via `CONSOLIDATION_LLM_BATCH_SIZE` (retain's prompt is an
 *    estimate, hence the band) and the completion side via
 *    `*_MAX_COMPLETION_TOKENS`, which upstream honours.
 *  - **reflect** — prompt side only. Upstream has `REFLECT_MAX_CONTEXT_TOKENS`
 *    and NO reflect completion knob, so the completion term in reflect's row
 *    is a reserve switchroom holds back from the prompt cap, not a bound the
 *    backend is told about. Reflect's actual answer length is unbounded
 *    upstream; the check proves the reserve was held back, nothing more.
 */
export function assertHindsightContextBudgetFits(budget: HindsightContextBudget): void {
  for (const lane of [
    laneCheck(budget.consolidation),
    laneCheck(budget.retain),
    reflectLaneCheck(budget.reflect),
  ]) {
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
