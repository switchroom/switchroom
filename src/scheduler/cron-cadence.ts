/**
 * Cron cadence estimator for tier selection (cheap-crons JTBD value-gate).
 *
 * The tier selector needs "how often does this fire?" to default frequent
 * crons to the cheap tier. The existing `extractCronSmallestGapMin`
 * (agent-config-write.ts) only inspects the MINUTE field — it returns 0 for
 * any single-value minute, so `0 8 * * *` (daily) and `0 * * * *` (hourly)
 * both read as 0. That's fine for its job (catching sub-5-min floor
 * violations) but WRONG for tiering: a daily briefing would look "frequent"
 * and get routed to a memoryless cheap session.
 *
 * This estimator reads minute AND hour (and floors anything coarser at
 * daily), and is deliberately CONSERVATIVE: when the cadence can't be read
 * confidently, it returns Infinity — "treat as infrequent" — so the value
 * gate falls back to the safe full-session (Tier 2) default and NEVER
 * wrongly strips context from a cron it couldn't classify. Only a cron we
 * can confidently call sub-hourly is eligible for the cheap default.
 */

/** Smallest gap (minutes) between two consecutive values in a CSV list, or null. */
function csvSmallestGap(field: string): number | null {
  if (!field.includes(",")) return null;
  const parts = field.split(",").map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 0);
  if (parts.length < 2) return null;
  const sorted = [...parts].sort((a, b) => a - b);
  let smallest = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && gap < smallest) smallest = gap;
  }
  return Number.isFinite(smallest) ? smallest : null;
}

/**
 * Estimate the smallest gap between fires, in minutes. Returns Infinity when
 * the cadence can't be read confidently (conservative — caller treats it as
 * infrequent). Handles the shapes real schedules use:
 *   minute `*`        → 1
 *   minute `*\/N`     → N
 *   minute CSV (≥2)   → smallest pairwise gap
 *   minute single + hour `*`      → 60   (hourly)
 *   minute single + hour `*\/N`   → 60·N
 *   minute single + hour CSV (≥2) → 60·smallest pairwise hour gap
 *   minute single + hour single   → 1440 (daily or rarer; day/week fields only widen it)
 *   anything else / malformed     → Infinity (unknown → infrequent)
 */
export function estimateCronGapMin(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5) return Infinity;
  const [min, hour] = fields;

  // Sub-hour cadence is fully determined by the minute field.
  if (min === "*") return 1;
  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep) {
    const n = Number(minStep[1]);
    return n > 0 ? n : Infinity;
  }
  const minCsv = csvSmallestGap(min);
  if (minCsv !== null) return minCsv;

  // Minute is a single value (e.g. "0", "30") or a shape we don't read as
  // sub-hour. The cadence is then driven by the hour field.
  // A single integer minute is the common "fires once per matched hour" case;
  // a minute range/other → unknown.
  if (!/^\d+$/.test(min)) return Infinity;

  if (hour === "*") return 60; // every hour at minute `min`
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) {
    const n = Number(hourStep[1]);
    return n > 0 ? n * 60 : Infinity;
  }
  const hourCsv = csvSmallestGap(hour);
  if (hourCsv !== null) return hourCsv * 60;

  // Single-value (or other) hour → fires at most once a day. Day-of-month /
  // month / day-of-week fields can only make it rarer, so daily is the floor.
  if (/^\d+$/.test(hour)) return 1440;

  return Infinity;
}
