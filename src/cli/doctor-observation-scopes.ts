/**
 * Doctor surface: Hindsight observation-scope saturation, per bank.
 *
 * ## The defect this detects
 *
 * Every consolidated observation lives under a *scope* — the exact tag set it
 * was consolidated with. Hindsight caps observations per scope. When a scope is
 * full the consolidator does NOT stop: it still recalls, still builds the
 * batch, still spends an extraction-model call, and then tells the model it may
 * only issue updates and deletes:
 *
 *     engine/consolidation/consolidator.py:1604-1613
 *       max_obs = _effective_scope_limit(config, fact_tags)
 *       if max_obs >= 0 and fact_tags:
 *           current_count = await _count_observations_for_scope(...)
 *           remaining_observation_slots = max(max_obs - current_count, 0)
 *           if remaining_observation_slots == 0:
 *               logger.info(f"[CONSOLIDATION] bank={bank_id} scope={fact_tags} "
 *                           f"at observation limit ({current_count}/{max_obs}), "
 *                           f"only updates/deletes allowed")
 *
 * That is the ONLY signal, and it is `logger.info` with no metric, no counter
 * and no health surface attached. On this fleet it repeated roughly every 40
 * seconds for an unknown length of time —
 *
 *     bank=overlord scope=['0f3640d5-089f-4ea1-b5b0-165fe9ae81bf']
 *       at observation limit (1009/1000), only updates/deletes allowed
 *
 * — and was found only because a human ran `docker logs` for an unrelated
 * reason. Nothing in switchroom could have told an operator. A cap that can be
 * hit with no alarm gets hit again, so this module is the alarm.
 *
 * ## Why the obvious count is the WRONG count
 *
 * The engine does not count observations whose tags EQUAL the scope. It counts
 * observations whose tags CONTAIN the scope — a superset match:
 *
 *     engine/consolidation/consolidator.py:598-603
 *       SELECT COUNT(*) FROM memory_units
 *        WHERE bank_id = $1 AND fact_type = 'observation' AND tags @> $2::varchar[]
 *
 * `GET /observations/scopes` reports the other thing: distinct EXACT tag sets
 * with their own counts. Comparing those raw numbers to the cap silently
 * under-reports every scope that has a tagged descendant, and the gap is not
 * academic. Measured against the live fleet on 2026-07-29:
 *
 *   - klanker scope `0291c461-…` — exact 792 (79.2% of 1000, i.e. it would not
 *     even have crossed an 80% WARN line) against an engine-visible **1413**.
 *     41% past the cap, and the naive check reports it green.
 *   - overlord scope `7c62ce38-…` — exact 963 against an engine-visible 1164.
 *   - overlord scope `c7905e1b-…` — exact 935 against an engine-visible 1141.
 *
 * So {@link computeScopeSaturation} folds the endpoint's exact counts back into
 * containment counts client-side, reproducing `tags @> …` from data that is
 * already in hand. No extra query, no extra server work.
 *
 * ## Cost
 *
 * Per bank: `GET /config` (~9ms — one row) and `GET /observations/scopes`
 * (~150ms on a 163k-node / 29k-observation bank; one GROUP BY over the
 * `fact_type = 'observation'` slice, bounded by observation count, which the
 * cap itself bounds). `GET /stats` is ~1.4-2.1s and is fetched ONLY for a bank
 * that already has a saturated scope — on a healthy fleet this check makes zero
 * `/stats` calls, and on the live fleet it makes four. Banks are probed
 * concurrently, so wall time is one bank's latency, not the fleet's sum.
 *
 * ## Detection only
 *
 * Raising the cap, pruning a scope, or re-tagging sessions are operator
 * decisions with real data consequences; `doctor` reports and hands over the
 * numbers.
 */

import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import { collectProfileBanks } from "../memory/hindsight.js";
import { hindsightRestBase, getJson, type FetchOpts } from "../memory/bank-health.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** The doctor row's label. Single row for the whole fleet, like the HNSW check. */
export const OBSERVATION_SCOPE_CHECK_NAME = "hindsight observation scopes";

/**
 * Fraction of the cap at which a scope is reported as `warn`.
 *
 * The point of the row is to arrive BEFORE the wall. At 80% a scope still has
 * ~200 free slots at the fleet's cap of 1000 — days of headroom at observed
 * rates, and enough for an operator to raise the cap or prune deliberately
 * rather than discovering it from a log line after consolidation output has
 * already been discarded. Below this the row says nothing: a check that fires
 * on a half-full scope is one operators learn to scroll past.
 */
export const OBSERVATION_SCOPE_WARN_RATIO = 0.8;

/** How many saturated scopes are named in the detail before it elides. */
export const OBSERVATION_SCOPE_MAX_LISTED = 6;

/**
 * Observation count at which the UNTAGGED global scope is reported as `warn`.
 *
 * The tagged-scope machinery above deliberately never judges the untagged
 * scope: the engine skips it (`if max_obs >= 0 and fact_tags:`,
 * consolidator.py:1605) so it has no cap to breach. Since #4035 that same scope
 * is the *default consolidation sink* — the `curated` strategy sends every
 * all-volatile retain (a bare session UUID, `parent_session:*`) to `shared`,
 * which is the untagged scope. It therefore grows without a cap while every
 * other scope is bounded, and upstream vectorize-io/hindsight#1284 (whole-bank
 * unbounded consolidation growth) is acknowledged unfixed. A pool that only
 * grows eventually makes every consolidation pass recall a larger set for the
 * same output, so it needs a watch even though it has no wall to hit.
 *
 * 10k is ten times the historical per-scope cap of 1000: far past any single
 * tagged scope's ceiling, quiet on a healthy bank (the live klanker global
 * scope carried 188 observations on 2026-07-31), and early enough that an
 * operator can act — raise consolidation cadence, prune, or split the bank —
 * long before the pool is a drag. This is a WARN, never a FAIL: nothing is
 * being discarded, unlike a saturated tagged scope; it is a growth signal.
 */
export const OBSERVATION_SCOPE_UNTAGGED_WARN_COUNT = 10_000;

/** One `{tags, count}` entry as `GET /observations/scopes` returns it. */
export interface ObservationScope {
  tags: string[];
  count: number;
}

/** One scope's saturation, counted the way the engine counts it. */
export interface ScopeSaturation {
  /** The scope's tag set, sorted (the endpoint already normalizes order). */
  tags: string[];
  /** Observations whose tags are EXACTLY this scope (what the endpoint reports). */
  exact: number;
  /**
   * Observations whose tags CONTAIN this scope — the number
   * `_count_observations_for_scope` returns, and the number the engine's log
   * line prints. This is what the cap is compared against.
   */
  effective: number;
  /** The cap in force for this scope. */
  cap: number;
  status: "ok" | "warn" | "fail";
}

/**
 * One `observation_scope_limits` rule as the engine parses it
 * (`_ScopeLimitRule`, consolidator.py:606-623): a set of fnmatch tag-globs and
 * the observation cap applied to a scope those globs exact-cover.
 */
export interface ScopeLimitRule {
  globs: string[];
  limit: number;
}

/**
 * Translate a single fnmatch pattern into a RegExp — a faithful port of
 * CPython's `fnmatch.translate` (the implementation behind `fnmatchcase`):
 * `*` → any run (incl. empty, DOTALL), `?` → one char, `[seq]`/`[!seq]` →
 * character class, everything else literal. Anchored to the whole string.
 * Case-SENSITIVE, matching the engine's `fnmatchcase`.
 */
function fnmatchTranslate(pat: string): RegExp {
  // `[\s\S]` (not `.`) so `*`/`?` span newlines too — Python compiles with the
  // DOTALL flag (`(?s:...)`).
  const ANY = "[\\s\\S]";
  let res = "";
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i];
    i += 1;
    if (c === "*") {
      res += ANY + "*";
    } else if (c === "?") {
      res += ANY;
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j += 1;
      if (j < n && pat[j] === "]") j += 1;
      while (j < n && pat[j] !== "]") j += 1;
      if (j >= n) {
        res += "\\[";
      } else {
        let stuff = pat.slice(i, j).replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^") || stuff.startsWith("[")) stuff = "\\" + stuff;
        res += "[" + stuff + "]";
      }
    } else {
      res += (c as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^(?:" + res + ")$");
}

/** Case-sensitive fnmatch — mirror of Python's `fnmatchcase(name, pat)`. */
export function fnmatchcase(name: string, pat: string): boolean {
  return fnmatchTranslate(pat).test(name);
}

/**
 * Parse raw `observation_scope_limits` config into ordered rules, mirroring the
 * engine's `_parse_scope_limit_rules` (consolidator.py:626-648): each entry is a
 * `{ scope: string[], limit: int }` object; malformed entries are skipped (not
 * raised), and list order is preserved (first match wins). Booleans are rejected
 * as limits (the engine guards against `True`/`False` — JS has no int/bool
 * ambiguity but a non-integer or boolean `limit` is still dropped).
 */
export function parseScopeLimitRules(raw: unknown): ScopeLimitRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ScopeLimitRule[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") continue;
    const scope = (entry as { scope?: unknown }).scope;
    const limit = (entry as { limit?: unknown }).limit;
    if (!Array.isArray(scope) || scope.length === 0) continue;
    if (!scope.every((g) => typeof g === "string" && g.length > 0)) continue;
    if (typeof limit !== "number" || !Number.isInteger(limit)) continue;
    rules.push({ globs: scope as string[], limit });
  }
  return rules;
}

/**
 * Exact-cover match between a scope pattern and a concrete tag set — a mirror of
 * the engine's `_scope_matches_globs` (consolidator.py:651-668). True iff every
 * tag is covered by at least one glob AND every glob covers at least one tag (no
 * uncovered tags, no vacuous globs). The empty tag set never matches, so a rule
 * never applies to untagged observations. Case-sensitive.
 */
export function scopeMatchesGlobs(globs: string[], tags: string[]): boolean {
  if (tags.length === 0) return false;
  if (!tags.every((t) => globs.some((g) => fnmatchcase(t, g)))) return false;
  if (!globs.every((g) => tags.some((t) => fnmatchcase(t, g)))) return false;
  return true;
}

/**
 * Resolve the observation cap for one concrete scope — a mirror of the engine's
 * `_effective_scope_limit` (consolidator.py:670-683). The first rule whose
 * globs exact-cover `tags` wins; otherwise the bank-wide cap applies.
 */
export function effectiveScopeLimit(
  rules: ScopeLimitRule[],
  tags: string[],
  bankCap: number,
): number {
  for (const rule of rules) {
    if (scopeMatchesGlobs(rule.globs, tags)) return rule.limit;
  }
  return bankCap;
}

/**
 * Fold exact per-scope counts into the containment counts the engine enforces,
 * and classify each scope against the cap.
 *
 * For a scope `S`, the engine's count is the sum of the counts of every scope
 * `T` with `T ⊇ S` (which includes `S` itself). Computed here with a tag→scope
 * postings index and driven from the rarest tag in `S`, so the work is bounded
 * by how often a tag is shared rather than by the square of the scope count —
 * a bank with 755 mostly-single-tag scopes does a few thousand comparisons, not
 * half a million.
 *
 * Two exclusions, both mirroring the engine rather than taste:
 *
 *  - **The untagged scope (`tags: []`) is skipped.** The cap is guarded by
 *    `if max_obs >= 0 and fact_tags:` (consolidator.py:1605) and the count
 *    helper documents "Observations with no tags are not counted", so untagged
 *    observations are never capped. Including them would manufacture a
 *    permanent FAIL on a bank that is behaving exactly as designed.
 *  - **`cap < 0` yields nothing at all.** -1 is upstream's "unlimited"; there
 *    is no wall to approach.
 *
 * `cap === 0` ("no new observations in this scope") is a deliberate operator
 * setting, not a fault, and is handled by the caller rather than here — see
 * {@link classifyObservationScopeSaturation}.
 *
 * Scopes that have never held an observation are, by construction, at zero and
 * cannot be saturated, so enumerating the scopes that exist is complete for the
 * failure this detects. The one residual: a consolidation scope that is a
 * strict SUBSET of an existing scope and has never itself written an
 * observation is not enumerated. Reaching it would mean scoring every subset of
 * every scope, which invents scope keys the bank has never consolidated under
 * and would report, say, a bare `[sidechain]` as saturated when nothing ever
 * consolidates under it alone. A false FAIL costs more than that gap.
 */
export function computeScopeSaturation(
  scopes: ObservationScope[],
  cap: number,
  warnRatio: number = OBSERVATION_SCOPE_WARN_RATIO,
  scopeLimitRules: ScopeLimitRule[] = [],
): ScopeSaturation[] {
  // No glob rules + an unlimited bank-wide cap ⇒ nothing to judge. WITH rules a
  // rule may impose a finite cap on a specific scope even when the bank-wide cap
  // is unlimited (#3950), so the effective cap must be resolved per scope below.
  if (cap < 0 && scopeLimitRules.length === 0) return [];

  const sets = scopes.map((s) => ({ tags: s.tags, set: new Set(s.tags), count: s.count }));

  // tag -> indices of every scope carrying that tag.
  const postings = new Map<string, number[]>();
  sets.forEach((entry, i) => {
    for (const tag of entry.set) {
      const list = postings.get(tag);
      if (list) list.push(i);
      else postings.set(tag, [i]);
    }
  });

  const out: ScopeSaturation[] = [];
  for (const entry of sets) {
    // Untagged scope: never capped by the engine.
    if (entry.set.size === 0) continue;

    // Drive from the rarest tag — every superset of S carries every tag of S,
    // so any one tag's postings list is a complete candidate set.
    let candidates: number[] | undefined;
    for (const tag of entry.set) {
      const list = postings.get(tag);
      if (list && (candidates === undefined || list.length < candidates.length)) {
        candidates = list;
      }
    }

    let effective = 0;
    for (const idx of candidates ?? []) {
      const other = sets[idx];
      if (other === undefined) continue;
      let contains = true;
      for (const tag of entry.set) {
        if (!other.set.has(tag)) {
          contains = false;
          break;
        }
      }
      if (contains) effective += other.count;
    }

    // Resolve THIS scope's cap: a matching observation_scope_limits glob rule
    // overrides the bank-wide cap (#3950). A scope whose effective cap is
    // unlimited (-1, whether bank-wide or via a rule) has no wall to approach
    // and is dropped from the output.
    const scopeCap = effectiveScopeLimit(scopeLimitRules, entry.tags, cap);
    if (scopeCap < 0) continue;

    // `scopeCap === 0` is "closed on purpose": every scope would be at/over it,
    // so ratio is undefined and the caller reports the bank, not each scope.
    const status: ScopeSaturation["status"] =
      scopeCap > 0 && effective >= scopeCap
        ? "fail"
        : scopeCap > 0 && effective >= scopeCap * warnRatio
          ? "warn"
          : "ok";

    out.push({ tags: [...entry.tags], exact: entry.count, effective, cap: scopeCap, status });
  }

  // Worst first: the operator reads the top of the list, so it must be the
  // scope that is furthest past the wall.
  out.sort((a, b) => b.effective - a.effective);
  return out;
}

/** Everything one bank contributes to the row. */
export interface BankScopeReport {
  bankId: string;
  /** False when the bank could not be read at all (unreachable / bad shape). */
  ok: boolean;
  /** Populated when `ok` is false. */
  reason?: string;
  /** `max_observations_per_scope` as the bank actually carries it. */
  cap: number;
  /** `enable_observations` — false means consolidation writes none. */
  observationsEnabled: boolean;
  /**
   * True when the bank carries `observation_scope_limits` rules. Those resolve
   * a DIFFERENT cap per scope through fnmatch glob patterns
   * (consolidator.py:670-683), which this check does not evaluate — see
   * {@link classifyObservationScopeSaturation}.
   */
  hasScopeLimitRules: boolean;
  /** Distinct scopes in the bank, including the untagged one (raw endpoint total). */
  scopeCount: number;
  /**
   * How many scopes this check actually JUDGED against a cap — the length of
   * {@link computeScopeSaturation}'s output (tagged, capped scopes), which
   * excludes the untagged scope the engine never caps. The OK row reports THIS,
   * not {@link scopeCount}, so the printed number reconciles with what was
   * evaluated rather than overstating it by the untagged scope (#3954 item 1).
   */
  judgedScopeCount: number;
  /**
   * Observations in the UNTAGGED global scope (`tags: []`). This scope is the
   * `curated`-strategy default sink and is never capped by the engine, so it is
   * tracked separately from {@link saturated} and watched by
   * {@link OBSERVATION_SCOPE_UNTAGGED_WARN_COUNT} rather than by the per-scope
   * cap. 0 when the bank has no untagged observations.
   */
  untaggedCount: number;
  /** Scopes at `warn` or `fail`, worst first. */
  saturated: ScopeSaturation[];
  /**
   * `pending_consolidation` from `/stats`, fetched only for banks that already
   * have a saturated scope. `null` when not fetched or unavailable.
   */
  pendingConsolidation: number | null;
}

/** `bank/scope-id (1164/1000)` — the shape the engine's own log line uses. */
function describeScope(bankId: string, s: ScopeSaturation): string {
  return `${bankId}/${s.tags.join(",")} (${s.effective}/${s.cap})`;
}

/**
 * Turn per-bank reports into the single doctor row.
 *
 * - `fail` — at least one scope is AT or OVER its cap. The engine is discarding
 *   the create half of every consolidation pass on that scope right now, at the
 *   cost of a full extraction-model call each time. This is deliberately not a
 *   warning: the 2026-07 incident was a warning-shaped log line nobody read.
 * - `warn` — at least one scope is past {@link OBSERVATION_SCOPE_WARN_RATIO} of
 *   its cap and still writable, OR a bank's untagged global scope has grown past
 *   {@link OBSERVATION_SCOPE_UNTAGGED_WARN_COUNT} (the uncapped `curated` sink —
 *   nothing is discarded, but the pool only grows, so it is watched).
 * - `skip` — nothing could be read, or every readable bank is one this check
 *   cannot judge honestly (glob scope-limit rules, or observations disabled).
 * - `ok`   — every scope on every reachable bank has room.
 *
 * Banks that could not be read do NOT fail the row on their own: "couldn't
 * look" is not "saturated", and a check that reddens on an unreachable server
 * teaches operators to ignore the column. They are named in the detail so the
 * gap is visible rather than silent.
 */
export function classifyObservationScopeSaturation(
  reports: BankScopeReport[],
): CheckResult {
  const name = OBSERVATION_SCOPE_CHECK_NAME;
  if (reports.length === 0) {
    return { name, status: "skip", detail: "no banks to inspect" };
  }

  const unreadable = reports.filter((r) => !r.ok);
  const readable = reports.filter((r) => r.ok);

  // The untagged global scope grows uncapped and is the `curated` default sink
  // (see OBSERVATION_SCOPE_UNTAGGED_WARN_COUNT). It is independent of the
  // per-scope cap and the glob rules, so it is judged for every readable bank
  // that still writes observations, not only the cap-judged ones. Worst first.
  const growing = readable
    .filter((r) => r.observationsEnabled && r.untaggedCount >= OBSERVATION_SCOPE_UNTAGGED_WARN_COUNT)
    .sort((a, b) => b.untaggedCount - a.untaggedCount);
  const growthNote =
    growing.length > 0
      ? `${growing.length} bank(s) with an untagged global scope over ` +
        `${OBSERVATION_SCOPE_UNTAGGED_WARN_COUNT.toLocaleString()} observations ` +
        `(uncapped curated sink, growth watch): ` +
        growing
          .slice(0, OBSERVATION_SCOPE_MAX_LISTED)
          .map((r) => `${r.bankId} ${r.untaggedCount.toLocaleString()}`)
          .join(", ") +
        (growing.length > OBSERVATION_SCOPE_MAX_LISTED
          ? `; +${growing.length - OBSERVATION_SCOPE_MAX_LISTED} more`
          : "")
      : "";

  if (readable.length === 0) {
    return {
      name,
      status: "skip",
      detail:
        `could not read observation scopes for ${unreadable.length} bank(s): ` +
        unreadable.map((r) => `${r.bankId} (${r.reason ?? "unknown"})`).join(", "),
    };
  }

  // Banks carrying observation_scope_limits glob rules ARE now judged: the
  // per-scope cap those rules resolve is mirrored client-side (#3950), so their
  // saturated scopes were computed against the SAME effective cap the engine
  // enforces. Only observations-disabled banks are excluded from judgement.
  const unjudged = readable.filter((r) => !r.observationsEnabled);
  const judged = readable.filter((r) => r.observationsEnabled);

  const notes: string[] = [];
  if (unreadable.length > 0) {
    notes.push(
      `${unreadable.length} bank(s) unreadable: ` +
        unreadable.map((r) => `${r.bankId} (${r.reason ?? "unknown"})`).join(", "),
    );
  }
  const withRules = judged.filter((r) => r.hasScopeLimitRules);
  if (withRules.length > 0) {
    notes.push(
      `${withRules.length} bank(s) judged with per-scope observation_scope_limits ` +
        `glob caps: ${withRules.map((r) => r.bankId).join(", ")}`,
    );
  }
  const disabled = unjudged.filter((r) => !r.observationsEnabled);
  if (disabled.length > 0) {
    notes.push(
      `${disabled.length} bank(s) have observations disabled: ` +
        disabled.map((r) => r.bankId).join(", "),
    );
  }
  const suffix = notes.length > 0 ? ` · ${notes.join(" · ")}` : "";
  const growthSuffix = growthNote ? ` · ${growthNote}` : "";

  if (judged.length === 0) {
    // Nothing can be judged against the per-scope cap, but the untagged growth
    // watch is independent of it — surface a growing sink as a warn rather than
    // swallowing it in a skip.
    if (growing.length > 0) {
      return { name, status: "warn", detail: `${growthNote}${suffix}` };
    }
    return { name, status: "skip", detail: `no bank could be judged${suffix}` };
  }

  // `cap === 0` — the operator has closed the scope to new observations on
  // purpose. Every scope is trivially "at" it, so it is reported as an
  // intentional state, not as saturation.
  const closed = judged.filter((r) => r.cap === 0);
  const unlimited = judged.filter((r) => r.cap < 0);
  const capped = judged.filter((r) => r.cap > 0);

  // Derive the saturated scopes from EVERY judged bank, not just the ones whose
  // bank-wide cap is positive: a glob-rule bank can carry a bank-wide cap of -1
  // or 0 yet still have a scope capped (and saturated) by a rule (#3950). Each
  // bank's `saturated` was already computed against the correct per-scope cap.
  const failing = judged.flatMap((r) =>
    r.saturated.filter((s) => s.status === "fail").map((s) => ({ report: r, scope: s })),
  );
  const warning = judged.flatMap((r) =>
    r.saturated.filter((s) => s.status === "warn").map((s) => ({ report: r, scope: s })),
  );
  failing.sort((a, b) => b.scope.effective - a.scope.effective);
  warning.sort((a, b) => b.scope.effective - a.scope.effective);

  const backlog = (rows: Array<{ report: BankScopeReport }>): string => {
    const seen = new Map<string, number>();
    for (const { report } of rows) {
      if (report.pendingConsolidation != null && !seen.has(report.bankId)) {
        seen.set(report.bankId, report.pendingConsolidation);
      }
    }
    if (seen.size === 0) return "";
    const parts = [...seen]
      .sort((a, b) => b[1] - a[1])
      .map(([bank, pending]) => `${bank} ${pending.toLocaleString()}`);
    return ` · memories pending consolidation: ${parts.join(", ")}`;
  };

  const list = (rows: Array<{ report: BankScopeReport; scope: ScopeSaturation }>): string => {
    const shown = rows
      .slice(0, OBSERVATION_SCOPE_MAX_LISTED)
      .map(({ report, scope }) => describeScope(report.bankId, scope))
      .join("; ");
    const rest = rows.length - Math.min(rows.length, OBSERVATION_SCOPE_MAX_LISTED);
    return rest > 0 ? `${shown}; +${rest} more` : shown;
  };

  // WARNING to future editors: there is no per-scope observation delete on the
  // REST surface. `DELETE /v1/default/banks/<bank>/observations` is "Clear all
  // observations" — it takes no scope and wipes the bank's entire consolidated
  // knowledge (verified against the live OpenAPI, 2026-07-29). Recommending it
  // as a pruning step would turn this row into a data-loss instruction, so the
  // fix names raising the cap as the actionable remedy and says plainly that
  // scoped pruning is not a one-call operation.
  const fix =
    "Consolidation keeps running against a full scope — it recalls, spends an " +
    "extraction-model call, and can only apply updates/deletes " +
    "(engine/consolidation/consolidator.py:1604-1613), so every pass on that " +
    "scope is paid for and its creates are discarded. Remedy: raise the cap, " +
    "via `hindsight.env.HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE` in " +
    "switchroom.yaml (fleet-wide) or `max_observations_per_scope` on the bank " +
    "(PATCH /v1/default/banks/<bank>/config). Confirm the counts first with " +
    "GET /v1/default/banks/<bank>/observations/scopes — but note they are EXACT " +
    "tag sets, while the engine counts by CONTAINMENT (`tags @> scope`), so a " +
    "scope's child scopes count toward it and its true number is higher than " +
    "that endpoint shows. Retiring a scope instead is NOT a single call: " +
    "DELETE /v1/default/banks/<bank>/observations clears the WHOLE bank's " +
    "observations, so enumerate the scope first " +
    "(GET /graph?type=observation&tags=<scope>&tags_match=exact) and delete " +
    "per memory.";

  if (failing.length > 0) {
    return {
      name,
      status: "fail",
      detail:
        `${failing.length} observation scope(s) at or over the cap — consolidation ` +
        `output is being discarded on them right now: ${list(failing)}` +
        (warning.length > 0 ? ` · ${warning.length} more above ${Math.round(OBSERVATION_SCOPE_WARN_RATIO * 100)}%` : "") +
        backlog([...failing, ...warning]) +
        growthSuffix +
        suffix,
      fix,
    };
  }

  if (warning.length > 0 || growing.length > 0) {
    // Either a tagged scope is past its warn ratio, or the untagged sink has
    // grown past its watch line (or both). Both are writable-but-worth-seeing.
    const scopeClause =
      warning.length > 0
        ? `${warning.length} observation scope(s) above ` +
          `${Math.round(OBSERVATION_SCOPE_WARN_RATIO * 100)}% of the cap and still writable: ` +
          `${list(warning)}` +
          backlog(warning)
        : "";
    const detail =
      warning.length > 0
        ? scopeClause + growthSuffix + suffix
        : `${growthNote}${suffix}`;
    return { name, status: "warn", detail, ...(warning.length > 0 ? { fix } : {}) };
  }

  const totalScopes = capped.reduce((n, r) => n + r.judgedScopeCount, 0);
  const detailBase =
    capped.length === 0
      ? `no bank has a positive observation cap`
      : `${totalScopes} scope(s) across ${capped.length} bank(s) below ` +
        `${Math.round(OBSERVATION_SCOPE_WARN_RATIO * 100)}% of the cap`;
  const extra: string[] = [];
  if (unlimited.length > 0) {
    extra.push(`${unlimited.length} bank(s) uncapped (-1)`);
  }
  if (closed.length > 0) {
    extra.push(
      `${closed.length} bank(s) deliberately closed to new observations (cap 0): ` +
        closed.map((r) => r.bankId).join(", "),
    );
  }
  return {
    name,
    status: "ok",
    detail: detailBase + (extra.length > 0 ? ` · ${extra.join(" · ")}` : "") + suffix,
  };
}

/**
 * Inspect one bank: its cap, its scopes, and — only if something is already
 * saturated — its consolidation backlog.
 *
 * The cap is read from the bank's own `/config` rather than from switchroom's
 * `HINDSIGHT_DEFAULT_MAX_OBSERVATIONS_PER_SCOPE` constant on purpose. The
 * constant is what switchroom PUSHES; `/config` is what the bank actually
 * carries, and the two diverge exactly when it matters (an operator override,
 * a bank created before the default changed, a container running with a
 * different env). Comparing live counts against an assumed cap is how a check
 * reports numbers that no log line agrees with.
 *
 * A missing/wrong-typed `max_observations_per_scope` is `ok: false`, never
 * defaulted: a guessed cap produces a confident, wrong verdict.
 */
export async function inspectBankScopes(
  apiUrl: string,
  bankId: string,
  opts?: FetchOpts,
): Promise<BankScopeReport> {
  const base = hindsightRestBase(apiUrl);
  const bank = encodeURIComponent(bankId);
  const fail = (reason: string): BankScopeReport => ({
    bankId,
    ok: false,
    reason,
    cap: -1,
    observationsEnabled: false,
    hasScopeLimitRules: false,
    scopeCount: 0,
    judgedScopeCount: 0,
    untaggedCount: 0,
    saturated: [],
    pendingConsolidation: null,
  });

  const cfg = await getJson<{ config?: Record<string, unknown> | null }>(
    `${base}/v1/default/banks/${bank}/config`,
    opts,
  );
  if (!cfg.ok) return fail(cfg.reason);
  const config = cfg.data?.config;
  if (config == null || typeof config !== "object") return fail("Unexpected shape");
  const rawCap = config["max_observations_per_scope"];
  if (typeof rawCap !== "number" || !Number.isFinite(rawCap)) {
    return fail("Unexpected shape");
  }
  const scopeLimitRules = parseScopeLimitRules(config["observation_scope_limits"]);
  const hasScopeLimitRules = scopeLimitRules.length > 0;
  // Absent means engine default (enabled); only an explicit `false` disables.
  const observationsEnabled = config["enable_observations"] !== false;

  const scopesResp = await getJson<{ scopes?: unknown }>(
    `${base}/v1/default/banks/${bank}/observations/scopes`,
    opts,
  );
  if (!scopesResp.ok) return fail(scopesResp.reason);
  const rawScopes = scopesResp.data?.scopes;
  if (!Array.isArray(rawScopes)) return fail("Unexpected shape");

  const scopes: ObservationScope[] = [];
  for (const entry of rawScopes) {
    const tags = (entry as { tags?: unknown })?.tags;
    const count = (entry as { count?: unknown })?.count;
    if (!Array.isArray(tags) || typeof count !== "number") continue;
    if (!tags.every((t) => typeof t === "string")) continue;
    scopes.push({ tags: tags as string[], count });
  }

  const allJudged = computeScopeSaturation(
    scopes,
    rawCap,
    OBSERVATION_SCOPE_WARN_RATIO,
    scopeLimitRules,
  );
  const saturated = allJudged.filter((s) => s.status !== "ok");
  // The untagged global scope: never in `saturated` (the engine skips it), but
  // it is the `curated` default sink and grows uncapped, so its size is tracked
  // and watched separately (OBSERVATION_SCOPE_UNTAGGED_WARN_COUNT).
  const untaggedCount = scopes
    .filter((s) => s.tags.length === 0)
    .reduce((n, s) => n + s.count, 0);

  // The backlog number is what makes the row legible ("overlord is sitting on
  // 43,734 pending memories" beats a bare uuid), but /stats is the expensive
  // call on this surface — ~1.4-2.1s against the ~150ms scopes query. Fetch it
  // only when there is already something to explain, so a healthy fleet pays
  // nothing for it.
  let pendingConsolidation: number | null = null;
  if (saturated.length > 0 && observationsEnabled) {
    const stats = await getJson<{ pending_consolidation?: unknown }>(
      `${base}/v1/default/banks/${bank}/stats`,
      opts,
    );
    if (stats.ok && typeof stats.data?.pending_consolidation === "number") {
      pendingConsolidation = stats.data.pending_consolidation;
    }
  }

  return {
    bankId,
    ok: true,
    cap: rawCap,
    observationsEnabled,
    hasScopeLimitRules,
    scopeCount: scopes.length,
    judgedScopeCount: allJudged.length,
    untaggedCount,
    saturated,
    pendingConsolidation,
  };
}

/**
 * The doctor entry point: sweep every bank switchroom knows about and return
 * the single row.
 *
 * Bank set matches the ingest sweep — each agent's resolved
 * `memory.collection` (deduped; several agents may share one) plus the profile
 * banks recall routes to. Resolution goes through `resolveAgentConfig` so a
 * `collection` inherited from `defaults:` or a profile lands on the same bank
 * the runtime uses.
 */
export async function checkObservationScopeSaturation(
  config: SwitchroomConfig,
  apiUrl: string,
  opts?: FetchOpts,
): Promise<CheckResult> {
  const banks = new Set<string>();
  for (const [agentName, agentConfig] of Object.entries(config.agents ?? {})) {
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    banks.add(resolved.memory?.collection ?? agentName);
  }
  for (const bank of collectProfileBanks(config)) banks.add(bank);

  const reports = await Promise.all(
    [...banks].map((bankId) => inspectBankScopes(apiUrl, bankId, opts)),
  );
  return classifyObservationScopeSaturation(reports);
}
