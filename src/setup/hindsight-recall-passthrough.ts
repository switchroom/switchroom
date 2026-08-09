/**
 * Declarative passthrough for the remaining Hindsight auto-recall knobs.
 *
 * ## Why this module exists
 *
 * `vendor/hindsight-memory/scripts/recall.py` reads ~25 `recall*` settings out
 * of the plugin config. Before this module, only eight of them had a
 * `switchroom.yaml` surface (`max_memories`, `query_max_tokens`,
 * `query_stop_terms`, `request_timeout_seconds`, `parallel_deadline_seconds`,
 * `own_bank_min_slots`, `additional_bank_min_slots`, and — since #3838 —
 * `min_score` / `min_score_scope`, plus the two opt-out knobs `types` and
 * `skip_trivial`). Every other one was reachable ONLY by hand-editing plugin
 * internals or by smuggling a raw `HINDSIGHT_RECALL_*` into the agent's
 * `env:` map — and the first of those does not survive `switchroom apply`,
 * which rm's and re-copies the whole plugin tree from `vendor/`.
 *
 * This module resolves the rest of them from the CASCADED agent config
 * (defaults → profile → agent) into concrete, always-present values that
 * `profiles/_base/start.sh.hbs` exports UNCONDITIONALLY.
 *
 * ## Unconditional export, and why (the #3774 defect class)
 *
 * The plugin resolves config in this order
 * (`vendor/hindsight-memory/scripts/lib/config.py:457-490`):
 *
 *   built-in DEFAULTS → plugin settings.json → ~/.hindsight/claude-code.json → env
 *
 * `~/.hindsight/claude-code.json` sits ABOVE anything switchroom stamps into
 * settings.json and SURVIVES an apply. So a knob that is exported only when the
 * operator sets it leaves a stale hand-edited value in that file authoritative
 * for every agent that did NOT set it — silently, and permanently. Exporting
 * the resolved effective value on every boot is the only shape that makes
 * `switchroom.yaml` the authority.
 *
 * The corollary is that every default here MUST equal the value the fleet is
 * running today, or turning the passthrough on would itself change behaviour.
 * They are pinned whole-value against the vendored plugin by
 * `tests/scaffold.recall-passthrough.test.ts`, which reads
 * `vendor/hindsight-memory/settings.json` and `scripts/lib/config.py` directly
 * so the two cannot drift.
 *
 * An EMPTY export is not a no-op either: `_cast_env("", int)` returns `None`
 * and `config.py` then skips the assignment, so an empty export is
 * indistinguishable from no export at all. Everything below therefore resolves
 * to a concrete, non-empty rendering — `[]` / `{}` for the collection-shaped
 * knobs, `true` / `false` for the booleans.
 *
 * ## Validation
 *
 * `switchroom.yaml` is parsed by zod (`src/config/schema.ts`), which is the
 * first gate. This module re-checks the same constraints so that a config that
 * reaches the scaffolder by any other route (a profile merge, a programmatic
 * caller, a hand-built `AgentConfig` in a test) still fails LOUDLY at scaffold
 * time. The alternative is worse than a crash: `_cast_env` is fail-open, so a
 * malformed JSON value silently reverts to the plugin default at recall time
 * and the operator's `switchroom.yaml` reads as though it were in force.
 */

/**
 * Recall-side score weight seed for `sidechain`-tagged (delegated sub-agent)
 * memories. Lives here rather than in `scaffold.ts` because BOTH channels need
 * exactly the same value: `applyHindsightSettingsOverrides` stamps it into the
 * plugin's settings.json, and the env export below carries it (merged with any
 * operator override) as the authoritative copy. Two literals would drift.
 */
export const HINDSIGHT_RECALL_TAG_WEIGHT_SEED: Readonly<Record<string, number>> =
  Object.freeze({ sidechain: 0.8 });

/**
 * The banner the recall hook puts above injected memories. Must match
 * `recallPromptPreamble` in `vendor/hindsight-memory/settings.json` exactly —
 * pinned by test.
 */
export const HINDSIGHT_RECALL_PROMPT_PREAMBLE_DEFAULT =
  "Relevant memories from past conversations (prioritize recent when " +
  "conflicting). Only use memories that are directly useful to continue " +
  "this conversation; ignore the rest:";

/** Legal `recallBudget` values (vendor README table, `recallBudget` row). */
export const RECALL_BUDGETS = ["low", "mid", "high"] as const;
export type RecallBudget = (typeof RECALL_BUDGETS)[number];

/**
 * Legal `tags_match` values. `any` / `all` are the loose forms; the `_strict`
 * forms require the memory to carry the tags rather than merely rank for them
 * (see `src/memory/hindsight.ts:894-901` and
 * `vendor/hindsight-memory/tests/test_client.py:251`).
 */
export const RECALL_TAGS_MATCH_MODES = ["any", "all", "any_strict", "all_strict"] as const;
export type RecallTagsMatch = (typeof RECALL_TAGS_MATCH_MODES)[number];

/**
 * Tag groups: either an OR-of-AND list (`[["a","b"],["c"]]`) or a named map
 * (`{group: ["a","b"]}`). `config.py`'s dict caster accepts both shapes
 * explicitly ("tag_groups may be a list").
 */
export type RecallTagGroups = string[][] | Record<string, string[]>;

/** Per-additional-bank filter override, in switchroom.yaml's snake_case. */
export interface RecallBankFilter {
  tags?: string[];
  tags_match?: string;
  tag_groups?: RecallTagGroups;
}

/**
 * The `memory.recall.*` subset this module owns, as it appears in
 * switchroom.yaml. Every field optional — the whole point is that an operator
 * who sets none of them gets today's behaviour byte-for-byte.
 */
export interface RecallPassthroughInput {
  budget?: string;
  max_tokens?: number;
  prefer_observations?: boolean;
  context_turns?: number;
  roles?: string[];
  prompt_preamble?: string;
  tags?: string[];
  tags_match?: string;
  tag_groups?: RecallTagGroups;
  tag_weights?: Record<string, number>;
  additional_bank_filters?: Record<string, RecallBankFilter>;
  transcript_fallback?: boolean;
  transcript_tail_bytes?: number;
  max_query_chars?: number;
  parallel?: boolean;
}

/**
 * Resolved values, shaped for the handlebars context. Scalars stay scalars;
 * everything structural is pre-serialised to JSON here (one serialiser, one
 * shape) and shell-quoted by the caller.
 */
export interface HindsightRecallPassthrough {
  budget: string;
  maxTokens: number;
  /** "true" | "false" — rendered bare, `_cast_env(..., bool)` reads it. */
  preferObservations: string;
  contextTurns: number;
  /** JSON array. */
  rolesJson: string;
  /** Raw string; the caller shell-quotes it. */
  promptPreamble: string;
  /** JSON array. */
  tagsJson: string;
  tagsMatch: string;
  /** JSON — `{}` when unset, which `recall.py` folds to `None` (`or None`). */
  tagGroupsJson: string;
  /** JSON object of {tag: multiplier}. */
  tagWeightsJson: string;
  /** JSON object keyed by bank id, values in the plugin's camelCase keys. */
  additionalBankFiltersJson: string;
  transcriptFallback: string;
  transcriptTailBytes: number;
  maxQueryChars: number;
  parallel: string;
}

/**
 * The effective values the fleet runs TODAY, i.e. what an agent with no
 * `memory.recall.*` config resolves to through
 * `DEFAULTS → settings.json → (no env)`. Pinned against the vendored plugin by
 * test; do not "tidy" one of these without changing the vendor side too.
 */
export const RECALL_PASSTHROUGH_DEFAULTS = Object.freeze({
  /** vendor/hindsight-memory/settings.json `recallBudget` */
  budget: "mid" as RecallBudget,
  /** settings.json `recallMaxTokens` */
  maxTokens: 1024,
  /** config.py DEFAULTS `recallPreferObservations` (not in settings.json) */
  preferObservations: true,
  /** settings.json `recallContextTurns` */
  contextTurns: 2,
  /** settings.json `recallRoles` */
  roles: ["user", "assistant"] as readonly string[],
  /** settings.json `recallPromptPreamble` */
  promptPreamble: HINDSIGHT_RECALL_PROMPT_PREAMBLE_DEFAULT,
  /** settings.json `recallTags` */
  tags: [] as readonly string[],
  /** settings.json `recallTagsMatch` */
  tagsMatch: "any" as RecallTagsMatch,
  /**
   * settings.json ships `null`; `_load_settings_file` drops null values, so the
   * effective value is config.py's `None`. `{}` is the same thing to
   * `recall.py` (`config.get("recallTagGroups") or None`) and, unlike `null`,
   * it actually ASSIGNS through `_cast_env` — exporting `null` would cast to
   * `None`, be skipped, and hand authority back to claude-code.json.
   */
  tagGroups: {} as RecallTagGroups,
  /** scaffold's settings.json stamp (`applyHindsightSettingsOverrides`) */
  tagWeights: HINDSIGHT_RECALL_TAG_WEIGHT_SEED,
  /** settings.json `recallAdditionalBankFilters` */
  additionalBankFilters: {} as Record<string, RecallBankFilter>,
  /** config.py DEFAULTS `recallTranscriptFallback` (not in settings.json) */
  transcriptFallback: true,
  /** settings.json `recallTranscriptTailBytes` */
  transcriptTailBytes: 262144,
  /** settings.json `recallMaxQueryChars` */
  maxQueryChars: 800,
  /** config.py DEFAULTS `recallParallel` (not in settings.json) */
  parallel: true,
});

/** Marker every validation failure carries, so operators can grep for it. */
export const RECALL_PASSTHROUGH_ERROR_MARKER = "HINDSIGHT-RECALL-CONFIG";

/**
 * The `hindsightRecallPass.*` object `profiles/_base/start.sh.hbs` reads. Every
 * structural value is already shell-quoted, so the template renders it with a
 * triple-stash.
 */
export interface RecallPassthroughTemplateFields {
  budget: string;
  maxTokens: number;
  preferObservations: string;
  contextTurns: number;
  rolesQ: string;
  promptPreambleQ: string;
  tagsQ: string;
  tagsMatch: string;
  tagGroupsQ: string;
  tagWeightsQ: string;
  additionalBankFiltersQ: string;
  transcriptFallback: string;
  transcriptTailBytes: number;
  maxQueryChars: number;
  parallel: string;
}

/**
 * Build the template object, in ONE place.
 *
 * `scaffoldAgent` renders through `buildWorkspaceContext`; `reconcileAgentInner`
 * hand-builds its own template context. Two hand-written copies of this mapping
 * is precisely the init-vs-reconcile drift `tests/scaffold.memory-prompt.test.ts`
 * exists to catch — and the failure is silent in the worst way, because
 * handlebars renders an unknown path as the EMPTY STRING rather than throwing.
 * An empty `export HINDSIGHT_RECALL_X=` then casts to `None`, `load_config()`
 * skips the assignment, and a stale `~/.hindsight/claude-code.json` takes the
 * knob back — the exact defect class (#3774) the unconditional export exists to
 * close. So both callers go through this function.
 *
 * @param quote the shell single-quoter (passed in so this module stays free of
 * scaffold.ts imports).
 */
export function recallPassthroughTemplateFields(
  resolved: HindsightRecallPassthrough,
  quote: (value: string) => string,
): RecallPassthroughTemplateFields {
  return {
    budget: resolved.budget,
    maxTokens: resolved.maxTokens,
    preferObservations: resolved.preferObservations,
    contextTurns: resolved.contextTurns,
    rolesQ: quote(resolved.rolesJson),
    promptPreambleQ: quote(resolved.promptPreamble),
    tagsQ: quote(resolved.tagsJson),
    tagsMatch: resolved.tagsMatch,
    tagGroupsQ: quote(resolved.tagGroupsJson),
    tagWeightsQ: quote(resolved.tagWeightsJson),
    additionalBankFiltersQ: quote(resolved.additionalBankFiltersJson),
    transcriptFallback: resolved.transcriptFallback,
    transcriptTailBytes: resolved.transcriptTailBytes,
    maxQueryChars: resolved.maxQueryChars,
    parallel: resolved.parallel,
  };
}

function fail(key: string, detail: string): never {
  throw new Error(
    `${RECALL_PASSTHROUGH_ERROR_MARKER}: memory.recall.${key} is invalid — ${detail}. ` +
    "Fix switchroom.yaml; the value cannot be passed through to the recall hook, " +
    "and shipping it would silently fall back to the plugin default at recall time.",
  );
}

function requireInt(key: string, value: number, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(key, `expected a number, got ${JSON.stringify(value)}`);
  }
  if (!Number.isInteger(value)) {
    fail(key, `expected an integer, got ${value}`);
  }
  if (value < min) {
    fail(key, `expected an integer >= ${min}, got ${value}`);
  }
  return value;
}

function requireBool(key: string, value: boolean): boolean {
  if (typeof value !== "boolean") {
    fail(key, `expected true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireStringArray(key: string, value: string[], minLength = 0): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.length === 0)) {
    fail(key, `expected an array of non-empty strings, got ${JSON.stringify(value)}`);
  }
  if (value.length < minLength) {
    fail(key, `expected at least ${minLength} entr${minLength === 1 ? "y" : "ies"}, got none`);
  }
  return [...value];
}

function requireEnum<T extends string>(key: string, value: string, legal: readonly T[]): T {
  if (typeof value !== "string" || !legal.includes(value as T)) {
    fail(key, `expected one of ${legal.map((v) => `"${v}"`).join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function requireTagGroups(key: string, value: RecallTagGroups): RecallTagGroups {
  if (Array.isArray(value)) {
    for (const group of value) {
      if (!Array.isArray(group) || group.some((t) => typeof t !== "string" || t.length === 0)) {
        fail(key, `expected an array of tag arrays, got ${JSON.stringify(value)}`);
      }
    }
    return value.map((g) => [...g]);
  }
  if (value && typeof value === "object") {
    const out: Record<string, string[]> = {};
    for (const [name, group] of Object.entries(value)) {
      if (!Array.isArray(group) || group.some((t) => typeof t !== "string" || t.length === 0)) {
        fail(key, `group "${name}" must be an array of non-empty strings`);
      }
      out[name] = [...group];
    }
    return out;
  }
  return fail(key, `expected a list of tag groups or a {name: [tags]} map, got ${JSON.stringify(value)}`);
}

function requireTagWeights(key: string, value: Record<string, number>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(key, `expected a {tag: multiplier} map, got ${JSON.stringify(value)}`);
  }
  for (const [tag, weight] of Object.entries(value)) {
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      fail(key, `weight for "${tag}" must be a finite number >= 0, got ${JSON.stringify(weight)}`);
    }
  }
  return { ...value };
}

/**
 * Translate the yaml-facing per-bank filter (snake_case) into the plugin keys
 * `recall.py` actually reads off the map
 * (`vendor/hindsight-memory/scripts/recall.py:2018-2023`).
 */
function resolveBankFilters(
  raw: Record<string, RecallBankFilter>,
): Record<string, Record<string, unknown>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("additional_bank_filters", `expected a {bank_id: filter} map, got ${JSON.stringify(raw)}`);
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const [bankId, filter] of Object.entries(raw)) {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      fail("additional_bank_filters", `filter for bank "${bankId}" must be a map`);
    }
    const entry: Record<string, unknown> = {};
    if (filter.tags !== undefined) {
      entry.recallTags = requireStringArray(`additional_bank_filters.${bankId}.tags`, filter.tags);
    }
    if (filter.tags_match !== undefined) {
      entry.recallTagsMatch = requireEnum(
        `additional_bank_filters.${bankId}.tags_match`,
        filter.tags_match,
        RECALL_TAGS_MATCH_MODES,
      );
    }
    if (filter.tag_groups !== undefined) {
      entry.recallTagGroups = requireTagGroups(
        `additional_bank_filters.${bankId}.tag_groups`,
        filter.tag_groups,
      );
    }
    out[bankId] = entry;
  }
  return out;
}

/**
 * Resolve the passthrough knobs for one agent. Every field always resolves to a
 * concrete value — `undefined` is never a legal output, because the template
 * exports all of them unconditionally.
 *
 * @throws Error carrying {@link RECALL_PASSTHROUGH_ERROR_MARKER} when a value is
 * out of range, the wrong type, or outside a known enum.
 */
export function resolveHindsightRecallPassthrough(
  input: RecallPassthroughInput | undefined,
): HindsightRecallPassthrough {
  const cfg = input ?? {};
  const d = RECALL_PASSTHROUGH_DEFAULTS;

  const budget = cfg.budget === undefined
    ? d.budget
    : requireEnum("budget", cfg.budget, RECALL_BUDGETS);
  const maxTokens = cfg.max_tokens === undefined
    ? d.maxTokens
    : requireInt("max_tokens", cfg.max_tokens, 1);
  const preferObservations = cfg.prefer_observations === undefined
    ? d.preferObservations
    : requireBool("prefer_observations", cfg.prefer_observations);
  const contextTurns = cfg.context_turns === undefined
    ? d.contextTurns
    : requireInt("context_turns", cfg.context_turns, 1);
  // At least one role, because `recallRoles: []` casts and ASSIGNS cleanly (it
  // is a list, so `_cast_env` keeps it) and then no transcript turn qualifies
  // to build the query from — recall degrades to nothing with no error.
  const roles = cfg.roles === undefined
    ? [...d.roles]
    : requireStringArray("roles", cfg.roles, 1);
  const promptPreamble = cfg.prompt_preamble === undefined
    ? d.promptPreamble
    : (() => {
      if (typeof cfg.prompt_preamble !== "string") {
        fail("prompt_preamble", `expected a string, got ${JSON.stringify(cfg.prompt_preamble)}`);
      }
      // Non-empty required. `""` is the one string `_cast_env` still assigns,
      // which would strip the banner and leave recalled memories in the prompt
      // with no framing telling the agent what they are — read as instructions
      // rather than as recalled context. Almost always a yaml slip, never worth
      // shipping silently.
      if (cfg.prompt_preamble.trim().length === 0) {
        fail("prompt_preamble", "expected a non-empty string; omit the key to keep the default banner");
      }
      return cfg.prompt_preamble;
    })();
  const tags = cfg.tags === undefined ? [...d.tags] : requireStringArray("tags", cfg.tags);
  const tagsMatch = cfg.tags_match === undefined
    ? d.tagsMatch
    : requireEnum("tags_match", cfg.tags_match, RECALL_TAGS_MATCH_MODES);
  const tagGroups = cfg.tag_groups === undefined
    ? d.tagGroups
    : requireTagGroups("tag_groups", cfg.tag_groups);
  // MERGED, not replaced: the `sidechain` seed is a switchroom-side ranking
  // decision (delegated sub-agent process-memories rank just under first-party
  // ones), not an operator default. A wholesale replace would silently undo it
  // for anyone who set a single unrelated weight. Per-tag override still works
  // — an explicit `sidechain: 1.0` neutralises the seed.
  const tagWeights = {
    ...d.tagWeights,
    ...(cfg.tag_weights === undefined ? {} : requireTagWeights("tag_weights", cfg.tag_weights)),
  };
  const additionalBankFilters = cfg.additional_bank_filters === undefined
    ? {}
    : resolveBankFilters(cfg.additional_bank_filters);
  const transcriptFallback = cfg.transcript_fallback === undefined
    ? d.transcriptFallback
    : requireBool("transcript_fallback", cfg.transcript_fallback);
  const transcriptTailBytes = cfg.transcript_tail_bytes === undefined
    ? d.transcriptTailBytes
    : requireInt("transcript_tail_bytes", cfg.transcript_tail_bytes, 0);
  const maxQueryChars = cfg.max_query_chars === undefined
    ? d.maxQueryChars
    : requireInt("max_query_chars", cfg.max_query_chars, 1);
  const parallel = cfg.parallel === undefined
    ? d.parallel
    : requireBool("parallel", cfg.parallel);

  return {
    budget,
    maxTokens,
    preferObservations: String(preferObservations),
    contextTurns,
    rolesJson: JSON.stringify(roles),
    promptPreamble,
    tagsJson: JSON.stringify(tags),
    tagsMatch,
    tagGroupsJson: JSON.stringify(tagGroups),
    tagWeightsJson: JSON.stringify(tagWeights),
    additionalBankFiltersJson: JSON.stringify(additionalBankFilters),
    transcriptFallback: String(transcriptFallback),
    transcriptTailBytes,
    maxQueryChars,
    parallel: String(parallel),
  };
}
