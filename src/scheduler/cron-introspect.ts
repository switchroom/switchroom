/**
 * Cron introspection — self-describing `cron list` views + health checks.
 *
 * The duplicate-`weekly-review` incident (gymbro, two overlay entries both
 * firing `0 20 * * 0` → double-fire) showed that prose in CLAUDE.md is not
 * enough: an agent couldn't tell where its crons lived (base
 * `switchroom.yaml` vs `schedule.d/` overlay) or that a duplicate existed.
 * Determinism has to live in the tool layer, so this module turns the merged
 * schedule array into a self-describing shape and a read-only health report.
 *
 * Inputs: the merged `schedule` array from a resolved agent slice. Overlay
 * entries are stamped (non-enumerably) by `overlay-loader.ts` with
 * {@link OVERLAY_SOURCE} (boolean) and {@link OVERLAY_TITLE} (the file's
 * human title). Those Symbols survive in-process but are invisible to
 * JSON-serialisation — so this module reads them *before* any strip pass and
 * folds them into plain, serialisable fields.
 *
 * Pure: no IO, no clock. The CLI resolves the config (which runs the overlay
 * merge) and the cheap-cron flag, then hands the array + flag here.
 */

import { OVERLAY_SOURCE, OVERLAY_TITLE } from "../config/overlay-loader.js";
import { resolveCronRouting, type CronTier } from "./cron-routing.js";

/** Where a cron entry was defined. */
export type CronSource = "base-config" | "overlay";

/**
 * One self-describing cron entry. Spreads the original entry's enumerable
 * fields (backward compat — `cron`, `prompt`, `kind`, … all preserved) and
 * adds the introspection fields below.
 */
export interface CronListEntry {
  /** Resolved display name: explicit overlay title, else `name` field, else null. */
  name: string | null;
  /** "base-config" (switchroom.yaml) or "overlay" (schedule.d/<file>.yaml). */
  source: CronSource;
  /** "switchroom.yaml" for base entries, or the overlay file basename. */
  file: string;
  /** Resolved tier for this fire: poll | action | cheap | main. */
  tier: CronTier;
  /** Resolved session context: "fresh" (cheap session) | "agent" (live) | null (model-free). */
  context: "fresh" | "agent" | null;
  /**
   * When this entry shares its cron expression with one or more OTHER
   * entries, the names/files of those siblings (so each dupe points at the
   * other). Absent when the entry's cron expression is unique.
   */
  duplicate_of?: { name: string | null; file: string }[];
  /** Original entry fields, preserved verbatim for backward compat. */
  [key: string]: unknown;
}

/** A single health finding from {@link cronDoctor}. */
export interface CronHealthFinding {
  kind: "duplicate_cron" | "name_conflict" | "missing_tier";
  severity: "warn" | "error";
  message: string;
  /** Entries implicated, by display name + file. */
  entries: { name: string | null; file: string }[];
  /** The shared cron expression (duplicate_cron) or name (name_conflict). */
  cron?: string;
  conflicting_name?: string;
}

export interface CronDoctorReport {
  agent: string;
  entry_count: number;
  findings: CronHealthFinding[];
  /** true when `findings` is empty. */
  healthy: boolean;
}

interface RawEntry {
  entry: Record<string, unknown>;
  source: CronSource;
  file: string;
  /** Resolved display name. */
  name: string | null;
}

/** A schedule entry's raw shape (only the fields we read directly). */
type ScheduleLike = Record<string, unknown> & {
  cron?: string;
  prompt?: string;
  name?: string;
  kind?: "poll" | "prompt" | "action";
  model?: string;
  context?: "fresh" | "agent";
};

/** Normalise a cron expression for equality (collapse internal whitespace). */
export function normalizeCronExpr(expr: unknown): string | null {
  if (typeof expr !== "string") return null;
  const t = expr.trim();
  if (t === "") return null;
  return t.replace(/\s+/g, " ");
}

/**
 * Lift the per-entry attribution (source + file + display name) from the
 * overlay Symbols stamped by the loader. Base-config entries carry no
 * Symbols, so they fall through to the "base-config" / "switchroom.yaml"
 * defaults.
 */
function attributeEntry(raw: unknown): RawEntry {
  const entry = (raw ?? {}) as ScheduleLike;
  const isOverlay = (entry as Record<symbol, unknown>)[OVERLAY_SOURCE] === true;
  const overlayTitle = (entry as Record<symbol, unknown>)[OVERLAY_TITLE];
  const explicitName =
    typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name : null;
  if (isOverlay) {
    const title =
      typeof overlayTitle === "string" && overlayTitle.trim() !== ""
        ? overlayTitle
        : explicitName;
    // The overlay file basename: prefer the title-derived name, else the
    // generic content-hash slug isn't known here, so label it generically.
    const file =
      typeof overlayTitle === "string" && overlayTitle.trim() !== ""
        ? `schedule.d/${overlayTitle}.yaml`
        : "schedule.d/<overlay>.yaml";
    return { entry, source: "overlay", file, name: title };
  }
  return { entry, source: "base-config", file: "switchroom.yaml", name: explicitName };
}

/**
 * Resolve a single entry's tier + context via the pure cron-routing FSM.
 * `null` context means the fire is model-free (poll/action) and has no
 * session context.
 */
function resolveTierContext(
  entry: ScheduleLike,
  cheapCronEnabled: boolean,
): { tier: CronTier; context: "fresh" | "agent" | null } {
  const routing = resolveCronRouting(
    { kind: entry.kind, model: entry.model, context: entry.context },
    { cheapCronEnabled },
  );
  // Tier 0 fires (poll/action) are model-free → no session context.
  const ctx =
    routing.tier === "poll" || routing.tier === "action"
      ? null
      : routing.session === "cron"
        ? "fresh"
        : "agent";
  return { tier: routing.tier, context: ctx };
}

/**
 * Build the self-describing `cron list` rows from a merged schedule array.
 * Each row spreads the original entry, adds `source`/`file`/`name`/`tier`/
 * `context`, and a `duplicate_of` back-reference when another entry shares
 * its cron expression.
 */
export function buildCronList(
  schedule: unknown[],
  opts: { cheapCronEnabled: boolean },
): CronListEntry[] {
  const raws = (schedule ?? []).map(attributeEntry);

  // Group by normalised cron expression so we can cross-link duplicates.
  const byExpr = new Map<string, number[]>();
  raws.forEach((r, i) => {
    const expr = normalizeCronExpr((r.entry as ScheduleLike).cron);
    if (expr === null) return;
    const arr = byExpr.get(expr);
    if (arr) arr.push(i);
    else byExpr.set(expr, [i]);
  });

  return raws.map((r, i) => {
    const { tier, context } = resolveTierContext(r.entry as ScheduleLike, opts.cheapCronEnabled);
    const expr = normalizeCronExpr((r.entry as ScheduleLike).cron);
    const out: CronListEntry = {
      // Original fields first (backward compat), then the introspection
      // fields override the labels where they collide (e.g. `name`).
      ...(r.entry as Record<string, unknown>),
      name: r.name,
      source: r.source,
      file: r.file,
      tier,
      context,
    };
    if (expr !== null) {
      const siblings = (byExpr.get(expr) ?? []).filter((j) => j !== i);
      if (siblings.length > 0) {
        out.duplicate_of = siblings.map((j) => ({ name: raws[j]!.name, file: raws[j]!.file }));
      }
    }
    return out;
  });
}

/**
 * Read-only health report over a merged schedule array. Surfaces:
 *   - duplicate cron expressions (the gymbro double-fire),
 *   - base-vs-overlay name collisions,
 *   - entries with no resolvable tier/context.
 */
export function cronDoctor(
  agent: string,
  schedule: unknown[],
  opts: { cheapCronEnabled: boolean },
): CronDoctorReport {
  const raws = (schedule ?? []).map(attributeEntry);
  const findings: CronHealthFinding[] = [];

  // ── Duplicate cron expressions ──────────────────────────────────────
  const byExpr = new Map<string, RawEntry[]>();
  for (const r of raws) {
    const expr = normalizeCronExpr((r.entry as ScheduleLike).cron);
    if (expr === null) continue;
    const arr = byExpr.get(expr);
    if (arr) arr.push(r);
    else byExpr.set(expr, [r]);
  }
  for (const [expr, group] of byExpr) {
    if (group.length > 1) {
      findings.push({
        kind: "duplicate_cron",
        severity: "error",
        message:
          `${group.length} entries share cron expression "${expr}" — they will ` +
          `all fire together (double-fire). Remove the redundant one(s).`,
        cron: expr,
        entries: group.map((r) => ({ name: r.name, file: r.file })),
      });
    }
  }

  // ── Base-vs-overlay name conflicts ──────────────────────────────────
  const byName = new Map<string, RawEntry[]>();
  for (const r of raws) {
    if (r.name === null) continue;
    const arr = byName.get(r.name);
    if (arr) arr.push(r);
    else byName.set(r.name, [r]);
  }
  for (const [name, group] of byName) {
    const sources = new Set(group.map((r) => r.source));
    if (group.length > 1 && sources.size > 1) {
      findings.push({
        kind: "name_conflict",
        severity: "warn",
        message:
          `name "${name}" is used by both a base-config and an overlay entry — ` +
          `removing by name is ambiguous.`,
        conflicting_name: name,
        entries: group.map((r) => ({ name: r.name, file: r.file })),
      });
    }
  }

  // ── Entries missing a resolvable tier/context ───────────────────────
  for (const r of raws) {
    const expr = normalizeCronExpr((r.entry as ScheduleLike).cron);
    if (expr === null) {
      findings.push({
        kind: "missing_tier",
        severity: "warn",
        message:
          `entry ${r.name ? `"${r.name}"` : "(unnamed)"} has no valid cron ` +
          `expression, so its tier/context cannot be resolved.`,
        entries: [{ name: r.name, file: r.file }],
      });
    }
  }

  return {
    agent,
    entry_count: raws.length,
    findings,
    healthy: findings.length === 0,
  };
}
