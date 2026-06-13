/**
 * Cheap-cron observability — docs/rfcs/cheap-cron-sessions.md §5.
 *
 * Aggregates scheduler.jsonl audit rows into a per-tier cost breakdown so
 * the operator can SEE the saving: how many fires were model-free Tier-0
 * polls (zero cost) vs actual model fires. Pure — the CLI does the IO.
 */

export interface ScheduleReportRow {
  tier?: "poll" | "action" | "cheap" | "main";
  exitCode: number;
  modelUsed?: string;
  startedAt?: number;
  scheduleIndex?: number;
}

export interface ScheduleReportSummary {
  total: number;
  /** Model-free Tier-0 poll fires (no-op/baseline) — the saving, cost 0. */
  pollFires: number;
  /** Model-free Tier-0 action fires (mechanical verbs) — cost 0. */
  actionFires: number;
  /** Tier-1 cheap-session model fires. */
  cheapFires: number;
  /** Tier-2 main-session model fires (incl. legacy untiered rows). */
  mainFires: number;
  /** exitCode < 0 and not a quota-defer (-2). */
  errors: number;
  /** Quota-deferred fires (-2). */
  deferred: number;
  /**
   * Rough relative cost proxy (NOT dollars): poll×0 + cheap×1 + main×5,
   * mirroring the sonnet:opus output ratio. Labelled as a proxy in output.
   */
  costWeight: number;
  /** Count by the model each fire ran at (when recorded). */
  byModel: Record<string, number>;
}

// Relative cost weights (sonnet:opus output ≈ 1:5). Tier 0 (poll/action) is free.
const TIER_WEIGHT: Record<"poll" | "action" | "cheap" | "main", number> = { poll: 0, action: 0, cheap: 1, main: 5 };

export function summarizeScheduleReport(
  rows: ScheduleReportRow[],
  opts: { sinceMs?: number } = {},
): ScheduleReportSummary {
  const s: ScheduleReportSummary = {
    total: 0,
    pollFires: 0,
    actionFires: 0,
    cheapFires: 0,
    mainFires: 0,
    errors: 0,
    deferred: 0,
    costWeight: 0,
    byModel: {},
  };
  for (const r of rows) {
    if (opts.sinceMs !== undefined && (r.startedAt ?? 0) < opts.sinceMs) continue;
    s.total += 1;
    // Legacy rows (pre-cheap-cron) have no tier → count as main (today's behaviour).
    const tier = r.tier ?? "main";
    if (tier === "poll") s.pollFires += 1;
    else if (tier === "action") s.actionFires += 1;
    else if (tier === "cheap") s.cheapFires += 1;
    else s.mainFires += 1;
    s.costWeight += TIER_WEIGHT[tier];
    if (r.exitCode === -2) s.deferred += 1;
    else if (r.exitCode < 0) s.errors += 1;
    if (r.modelUsed) s.byModel[r.modelUsed] = (s.byModel[r.modelUsed] ?? 0) + 1;
  }
  return s;
}

/** Parse a scheduler.jsonl blob into rows, skipping malformed lines. */
export function parseScheduleJsonl(blob: string): ScheduleReportRow[] {
  const rows: ScheduleReportRow[] = [];
  for (const line of blob.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as ScheduleReportRow;
      if (typeof o.exitCode === "number") rows.push(o);
    } catch {
      /* skip malformed audit line */
    }
  }
  return rows;
}

export function formatScheduleReport(agent: string, s: ScheduleReportSummary): string {
  const modelFires = s.cheapFires + s.mainFires;
  const modelFreePct = s.total > 0 ? Math.round(((s.pollFires + s.actionFires) / s.total) * 100) : 0;
  const lines = [
    `cron report — ${agent}`,
    `  total fires        ${s.total}`,
    `  Tier 0 poll (free) ${s.pollFires}  (${modelFreePct}% model-free incl. actions)`,
    `  Tier 0 action(free)${s.actionFires}`,
    `  Tier 1 cheap       ${s.cheapFires}`,
    `  Tier 2 main        ${s.mainFires}`,
    `  model fires        ${modelFires}`,
    `  errors / deferred  ${s.errors} / ${s.deferred}`,
    `  cost-weight proxy  ${s.costWeight}  (poll×0 + cheap×1 + main×5; relative, not $)`,
  ];
  const models = Object.entries(s.byModel);
  if (models.length) lines.push(`  by model           ${models.map(([m, n]) => `${m}=${n}`).join("  ")}`);
  return lines.join("\n");
}
