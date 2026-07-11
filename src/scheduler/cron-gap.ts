/**
 * Shared cron minute-cadence helper (switchroom #1783).
 *
 * The 5-minute min-interval floor is enforced at two call sites that used
 * to carry their own, weaker minute-field parsers:
 *
 *   - `violatesMinInterval` (src/agents/reconcile-dry-run.ts) recognised only
 *     `*\/N` and the bare every-minute form, so CSV (`0,1,2`), ranges
 *     (`0-4`), and step-on-range (`0-30/2`) all slipped past the floor.
 *   - `extractCronSmallestGapMin` (src/cli/agent-config-write.ts) handled
 *     `*`, `*\/N`, and plain CSV but returned 0 (unknown → pass) for ranges,
 *     step-on-range, and step-on-list.
 *
 * Both now delegate here. The approach is exhaustive rather than
 * pattern-by-pattern: expand the minute field to the concrete SET of
 * minutes (0–59) it matches, then take the smallest **circular** gap over
 * the 60-minute cycle. That closes the bypass for every standard cron
 * minute form in one place.
 *
 * Semantics:
 *   - Returns the smallest gap in minutes between consecutive fires implied
 *     by the minute field (and, for a `*` minute, the fact that it fires
 *     every minute of every matched hour → gap 1).
 *   - A single matched minute (e.g. `15`) → 60 (hourly): the only wrap is
 *     this-hour's minute to next-hour's same minute.
 *   - Wraparound is honoured: `58,59` → 1 (58→59 = 1), not 58.
 *   - An **unparseable** minute field (unknown shape, or any out-of-range
 *     value like `75`) → 0, meaning "unknown — pass through". Callers keep
 *     their existing permissive behaviour for exotic-but-legal forms rather
 *     than rejecting blindly.
 *
 * This is intentionally distinct from `estimateCronGapMin` in
 * cron-cadence.ts: that estimator serves *tier selection*, reads the HOUR
 * field to distinguish hourly from daily, and is conservative in the
 * opposite direction (unknown → Infinity → "treat as infrequent"). The
 * floor wants unknown → 0 → "let it pass"; consolidating the two would
 * force one policy onto both. See cron-cadence.ts for that rationale.
 */

/**
 * Expand a single cron minute-field term into the set of matched minutes.
 * Supported term shapes: `*`, `*\/S`, `N`, `A-B`, `A-B/S`.
 * Returns `null` if the term is malformed or references an out-of-range
 * minute (outside 0–59).
 */
function expandMinuteTerm(term: string): number[] | null {
  // Step form: BASE/S where BASE is `*` or a range `A-B` (or a bare `A`,
  // treated as `A-59` per cron convention: `5/10` → 5,15,25,...).
  const slash = term.indexOf("/");
  let base = term;
  let step = 1;
  if (slash !== -1) {
    const stepStr = term.slice(slash + 1);
    if (!/^\d+$/.test(stepStr)) return null;
    step = Number(stepStr);
    if (step <= 0) return null;
    base = term.slice(0, slash);
  }

  let lo: number;
  let hi: number;
  if (base === "*") {
    lo = 0;
    hi = 59;
  } else if (/^\d+$/.test(base)) {
    lo = Number(base);
    // A bare number with a step means "from N to end of range".
    hi = slash !== -1 ? 59 : lo;
  } else {
    const range = base.match(/^(\d+)-(\d+)$/);
    if (!range) return null;
    lo = Number(range[1]);
    hi = Number(range[2]);
  }

  if (lo < 0 || hi > 59 || lo > hi) return null;

  const out: number[] = [];
  for (let m = lo; m <= hi; m += step) out.push(m);
  return out;
}

/**
 * Expand a full cron minute field (a CSV of terms, or a single term) to the
 * sorted, de-duplicated set of matched minutes. Returns `null` if any term
 * is unparseable / out of range.
 */
export function expandMinuteField(field: string): number[] | null {
  if (field.length === 0) return null;
  const set = new Set<number>();
  for (const term of field.split(",")) {
    const expanded = expandMinuteTerm(term);
    if (expanded === null) return null;
    for (const m of expanded) set.add(m);
  }
  if (set.size === 0) return null;
  return [...set].sort((a, b) => a - b);
}

/**
 * Smallest **circular** gap (minutes) between consecutive matched minutes
 * over the 60-minute cycle. A single matched minute → 60 (fires hourly).
 */
function smallestCircularGap(minutes: number[]): number {
  if (minutes.length === 1) return 60;
  let smallest = Infinity;
  for (let i = 0; i < minutes.length; i++) {
    const next = minutes[(i + 1) % minutes.length];
    const gap = i + 1 < minutes.length ? next - minutes[i] : next + 60 - minutes[i];
    if (gap > 0 && gap < smallest) smallest = gap;
  }
  return Number.isFinite(smallest) ? smallest : 60;
}

/**
 * Smallest gap, in minutes, between consecutive fires implied by the MINUTE
 * field of a 5-field cron expression.
 *
 * Returns 0 when the expression has fewer than 5 fields or the minute field
 * is unparseable / out of range ("unknown → pass through"). Otherwise the
 * smallest circular gap over the hour (single value → 60, hourly).
 */
export function cronMinuteSmallestGapMin(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5) return 0;
  const minutes = expandMinuteField(fields[0]);
  if (minutes === null) return 0;
  return smallestCircularGap(minutes);
}
