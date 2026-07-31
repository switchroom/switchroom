/**
 * One-time audit + dry-run planner for LEGACY observation-scope fragmentation
 * left behind by banks that retained before #4035 (curated scopes by default).
 *
 * ## What it is for
 *
 * Before #4035 every retain carried its volatile per-session provenance
 * (`{session_id}` → a bare UUID; sub-agent retains add `parent_session:<uuid>`
 * and a `<uuid>-sub-<agent>` id) INTO the consolidation scope. Because
 * Hindsight only dedups an observation against others carrying the identical
 * tag set, each session became its own dedup island and cross-session merging
 * never happened. The result on a long-lived bank is thousands of
 * single-session scopes that #4035 would now fold together:
 *
 *   - **all-volatile scopes** — the tag set is ONLY volatile provenance. Under
 *     curated these collapse to the one `shared` (untagged) scope.
 *   - **mixed scopes** — volatile provenance PLUS stable semantic tags
 *     (`lesson`, `sidechain`, `agent_type:*`, entities). Under curated the
 *     volatile part is stripped and they collapse onto their stable-tag scope.
 *   - **stale producer tags** — `agent-<hex>` scopes from a retired tag
 *     producer that no live code path writes any more. Dead weight; a cleanup
 *     that retires them is the operator's call, so they are flagged separately
 *     and only folded when explicitly asked ({@link CleanupOptions.retireStale}).
 *
 * ## Why it is DRY-RUN ONLY — the write path is not mechanizable today
 *
 * This module deliberately ships without a live-mutation path, and not merely
 * for caution:
 *
 *  - **There is no per-memory tag-write on the Hindsight REST surface.**
 *    `update_memory` / `PATCH /v1/default/banks/<bank>/memories/{id}` accept
 *    only text / context / occurred_* / fact_type / entities; an unknown
 *    argument (`tags`, `add_tags`) is SILENTLY DROPPED (verified in
 *    `switchroom memory demote`, upstream #3772). So an observation's scope
 *    cannot be edited in place to strip its volatile tags.
 *  - **There is no per-scope delete.** `DELETE /v1/default/banks/<bank>/
 *    observations` clears the WHOLE bank's observations (no scope parameter,
 *    verified against the live OpenAPI). Retiring one scope means enumerating
 *    it (`GET /graph?type=observation&tags=<scope>&tags_match=exact`) and
 *    deleting per memory — a destructive, operator-approved operation.
 *
 * So the deliverable is an AUDIT: it quantifies the fragmentation and the exact
 * blast radius of a heal (scopes merged, observations affected, resulting scope
 * count) so an operator can decide, and so a future write path (an upstream
 * tag-write, or a deliberate enumerate-and-invalidate) has a costed target. The
 * planner is a pure function; nothing here issues a write.
 */

import { hindsightRestBase } from "./bank-health.js";

/** One `{tags, count}` entry as `GET /observations/scopes` returns it. */
export interface ObservationScope {
  tags: string[];
  count: number;
}

/**
 * VOLATILE per-session provenance patterns — a paired copy of the plugin's
 * `DEFAULT_VOLATILE_SCOPE_PATTERNS` (`vendor/hindsight-memory/scripts/lib/
 * config.py`). Kept in sync by hand because this runs in the switchroom CLI
 * (Node), not the agent container (Python). A tag matching any of these is what
 * the `curated` strategy strips from the consolidation scope.
 */
export const CLEANUP_VOLATILE_PATTERNS: readonly RegExp[] = [
  /^parent_session:/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(-sub-.+)?$/,
];

/**
 * STALE producer tags — `agent-<hex>` scopes from a retired tag producer. These
 * are NOT in the volatile set (curated leaves them alone), so retiring them is a
 * separate, opt-in cleanup decision, not part of the #4035 heal.
 */
export const CLEANUP_STALE_PATTERNS: readonly RegExp[] = [/^agent-[0-9a-f]{8,}$/];

function matchesAny(tag: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(tag));
}

/** A scope key for grouping — the target scope printed as a stable string. */
function scopeKey(tags: string[]): string {
  return tags.length === 0 ? "shared" : [...tags].sort().join(",");
}

export interface CleanupOptions {
  /**
   * Also strip `agent-<hex>` stale-producer tags (retire those scopes). Off by
   * default: the #4035 heal only touches volatile provenance; retiring the
   * stale producer is a separate operator decision.
   */
  retireStale?: boolean;
  volatilePatterns?: readonly RegExp[];
  stalePatterns?: readonly RegExp[];
}

/** How one existing scope is reclassified under a cleanup. */
export interface ScopeReclass {
  /** The scope as it exists today. */
  from: string[];
  /** The curated target scope key it would collapse into (`"shared"` = untagged). */
  to: string;
  /** Observations in the source scope. */
  count: number;
  /** Volatile tags that would be stripped. */
  strippedVolatile: string[];
  /** Stale `agent-<hex>` tags that would be stripped (only when retireStale). */
  strippedStale: string[];
}

/** One target scope several source scopes collapse into. */
export interface ScopeMerge {
  target: string;
  /** How many DISTINCT existing scopes fold into this target. */
  sourceScopes: number;
  /** Total observations across those source scopes. */
  observations: number;
}

/** The full cleanup plan for one bank. Pure data; no writes implied. */
export interface BankCleanupPlan {
  bankId: string;
  ok: boolean;
  reason?: string;
  /** Distinct scopes in the bank today (including untagged). */
  totalScopes: number;
  /** Total observations across all scopes. */
  totalObservations: number;
  /** Scopes whose tag set changes under the cleanup, worst (largest) first. */
  reclassified: ScopeReclass[];
  /** Targets that ≥2 source scopes collapse into, or that a changed scope joins. */
  merges: ScopeMerge[];
  /** Count of scopes that change (== reclassified.length). */
  affectedScopes: number;
  /** Observations in changed scopes — the blast radius. */
  affectedObservations: number;
  /** Distinct scopes AFTER the cleanup. */
  resultingScopeCount: number;
  /** How many distinct scopes the cleanup removes. */
  scopeReduction: number;
  /** Class breakdown, for the summary line. */
  breakdown: {
    allVolatileScopes: number;
    allVolatileObservations: number;
    mixedScopes: number;
    mixedObservations: number;
    staleScopes: number;
    staleObservations: number;
  };
}

/**
 * Pure planner: given a bank's scope table, compute what a curated re-home would
 * do. No I/O, no writes — the same input always yields the same plan, which is
 * what the tests assert against.
 */
export function planScopeCleanup(
  bankId: string,
  scopes: ObservationScope[],
  options: CleanupOptions = {},
): BankCleanupPlan {
  const volatilePatterns = options.volatilePatterns ?? CLEANUP_VOLATILE_PATTERNS;
  const stalePatterns = options.stalePatterns ?? CLEANUP_STALE_PATTERNS;
  const retireStale = options.retireStale ?? false;

  const totalScopes = scopes.length;
  const totalObservations = scopes.reduce((n, s) => n + s.count, 0);

  const reclassified: ScopeReclass[] = [];
  const breakdown = {
    allVolatileScopes: 0,
    allVolatileObservations: 0,
    mixedScopes: 0,
    mixedObservations: 0,
    staleScopes: 0,
    staleObservations: 0,
  };

  // target key -> {distinct source scopes, observations, anyChanged}
  const targets = new Map<string, { sources: number; observations: number; changed: boolean }>();

  for (const s of scopes) {
    const volatileTags = s.tags.filter((t) => matchesAny(t, volatilePatterns));
    const staleTags = s.tags.filter((t) => matchesAny(t, stalePatterns));

    const stripped = s.tags.filter((t) => {
      if (matchesAny(t, volatilePatterns)) return false;
      if (retireStale && matchesAny(t, stalePatterns)) return false;
      return true;
    });
    const toKey = scopeKey(stripped);
    const changed = scopeKey(s.tags) !== toKey;

    // Class breakdown (independent of retireStale — describes the bank as it is).
    const hasStable = s.tags.some(
      (t) => !matchesAny(t, volatilePatterns) && !matchesAny(t, stalePatterns),
    );
    if (staleTags.length > 0) {
      breakdown.staleScopes += 1;
      breakdown.staleObservations += s.count;
    }
    if (volatileTags.length > 0 && !hasStable && staleTags.length === 0) {
      breakdown.allVolatileScopes += 1;
      breakdown.allVolatileObservations += s.count;
    } else if (volatileTags.length > 0 && hasStable) {
      breakdown.mixedScopes += 1;
      breakdown.mixedObservations += s.count;
    }

    const entry = targets.get(toKey) ?? { sources: 0, observations: 0, changed: false };
    entry.sources += 1;
    entry.observations += s.count;
    entry.changed = entry.changed || changed;
    targets.set(toKey, entry);

    if (changed) {
      reclassified.push({
        from: s.tags,
        to: toKey,
        count: s.count,
        strippedVolatile: volatileTags,
        strippedStale: retireStale ? staleTags : [],
      });
    }
  }

  reclassified.sort((a, b) => b.count - a.count);

  const merges: ScopeMerge[] = [...targets.entries()]
    .filter(([, v]) => v.sources > 1 && v.changed)
    .map(([target, v]) => ({ target, sourceScopes: v.sources, observations: v.observations }))
    .sort((a, b) => b.observations - a.observations);

  const affectedObservations = reclassified.reduce((n, r) => n + r.count, 0);
  const resultingScopeCount = targets.size;

  return {
    bankId,
    ok: true,
    totalScopes,
    totalObservations,
    reclassified,
    merges,
    affectedScopes: reclassified.length,
    affectedObservations,
    resultingScopeCount,
    scopeReduction: totalScopes - resultingScopeCount,
    breakdown,
  };
}

interface FetchOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getJson<T>(
  url: string,
  opts?: FetchOpts,
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    return { ok: true, data: (await resp.json()) as T };
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") return { ok: false, reason: "Timeout" };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}

/**
 * Fetch one bank's scope table (read-only) and plan the cleanup. `GET
 * /observations/scopes` only — no /config, no writes.
 */
export async function planBankCleanup(
  apiUrl: string,
  bankId: string,
  options: CleanupOptions = {},
  fetchOpts?: FetchOpts,
): Promise<BankCleanupPlan> {
  const base = hindsightRestBase(apiUrl);
  const bank = encodeURIComponent(bankId);
  const resp = await getJson<{ scopes?: unknown }>(
    `${base}/v1/default/banks/${bank}/observations/scopes`,
    fetchOpts,
  );
  if (!resp.ok) {
    return {
      bankId,
      ok: false,
      reason: resp.reason,
      totalScopes: 0,
      totalObservations: 0,
      reclassified: [],
      merges: [],
      affectedScopes: 0,
      affectedObservations: 0,
      resultingScopeCount: 0,
      scopeReduction: 0,
      breakdown: {
        allVolatileScopes: 0,
        allVolatileObservations: 0,
        mixedScopes: 0,
        mixedObservations: 0,
        staleScopes: 0,
        staleObservations: 0,
      },
    };
  }
  const raw = resp.data?.scopes;
  const scopes: ObservationScope[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const tags = (entry as { tags?: unknown })?.tags;
      const count = (entry as { count?: unknown })?.count;
      if (!Array.isArray(tags) || typeof count !== "number") continue;
      if (!tags.every((t) => typeof t === "string")) continue;
      scopes.push({ tags: tags as string[], count });
    }
  }
  return planScopeCleanup(bankId, scopes, options);
}

/** Render one bank's plan as a human-readable dry-run report. */
export function formatCleanupPlan(plan: BankCleanupPlan, maxMerges = 10): string {
  if (!plan.ok) {
    return `bank ${plan.bankId}: UNREADABLE (${plan.reason ?? "unknown"})`;
  }
  const b = plan.breakdown;
  const lines: string[] = [];
  lines.push(`bank ${plan.bankId}`);
  lines.push(
    `  today: ${plan.totalScopes} scopes, ${plan.totalObservations.toLocaleString()} observations`,
  );
  lines.push(
    `  legacy fragmentation:` +
      ` all-volatile ${b.allVolatileScopes} scopes / ${b.allVolatileObservations.toLocaleString()} obs;` +
      ` mixed ${b.mixedScopes} scopes / ${b.mixedObservations.toLocaleString()} obs;` +
      ` stale agent-<hex> ${b.staleScopes} scopes / ${b.staleObservations.toLocaleString()} obs`,
  );
  lines.push(
    `  WOULD change: ${plan.affectedScopes} scopes` +
      ` (${plan.affectedObservations.toLocaleString()} obs re-homed),` +
      ` ${plan.totalScopes} → ${plan.resultingScopeCount} scopes` +
      ` (−${plan.scopeReduction})`,
  );
  if (plan.merges.length > 0) {
    lines.push(`  top merges:`);
    for (const m of plan.merges.slice(0, maxMerges)) {
      lines.push(
        `    ${m.sourceScopes} scopes → ${m.target}  (${m.observations.toLocaleString()} obs)`,
      );
    }
    if (plan.merges.length > maxMerges) {
      lines.push(`    +${plan.merges.length - maxMerges} more merge targets`);
    }
  }
  return lines.join("\n");
}
