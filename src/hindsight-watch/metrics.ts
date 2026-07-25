/**
 * Minimal Prometheus text-exposition reader for the hindsight watchdog.
 *
 * Deliberately NOT a general-purpose Prometheus client: this parses the
 * handful of `hindsight_*` families the watchdog alerts on, out of the
 * ~60 KB `/metrics` body hindsight serves, with no dependencies. A full
 * parser would be more code to review and no more correct for this job.
 *
 * Exposition shape we consume (verbatim from
 * `curl http://127.0.0.1:18888/metrics` on 2026-07-25):
 *
 *   hindsight_operation_operations_total{budget="",max_tokens="",
 *     operation="retain",otel_scope_name="hindsight_api.metrics",...,
 *     source="api",success="true",tenant="public"} 13.0
 *   hindsight_operation_duration_seconds_bucket{...,le="60.0",
 *     operation="retain",...} 10.0
 *
 * Label order is NOT stable across exporters, so we parse labels into a map
 * and match on the subset we care about rather than string-matching a
 * rendered label set.
 */

/** One parsed exposition line. */
export interface Series {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** `+Inf` bucket key, kept as a string so the record is JSON-stable. */
export const INF_BUCKET = "+Inf";

/**
 * Parse a Prometheus text exposition body. `#`-prefixed HELP/TYPE lines and
 * blanks are skipped. A line that does not parse is skipped rather than
 * throwing — a single malformed series must not blind the whole watchdog
 * (the callers assert on the series they need being PRESENT, which is the
 * fail-loud path; see `readRetainSignals`).
 */
export function parseExposition(body: string): Series[] {
  const out: Series[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const brace = line.indexOf("{");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (brace === -1) {
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp + 1);
    } else {
      const close = line.lastIndexOf("}");
      if (close === -1 || close < brace) continue;
      name = line.slice(0, brace);
      const parsed = parseLabels(line.slice(brace + 1, close));
      if (parsed === null) continue;
      labels = parsed;
      rest = line.slice(close + 1);
    }
    const value = Number(rest.trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

/**
 * Parse `a="1",b="2"` into a map. Returns null on a shape we don't
 * understand, so the caller drops the line instead of inventing labels.
 * Handles backslash escapes inside values (`\"`, `\\`, `\n`) per the
 * exposition spec.
 */
function parseLabels(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === "," || s[i] === " ")) i++;
    if (i >= s.length) break;
    const eq = s.indexOf("=", i);
    if (eq === -1) return null;
    const key = s.slice(i, eq).trim();
    if (key === "" || s[eq + 1] !== '"') return null;
    let j = eq + 2;
    let value = "";
    for (;;) {
      if (j >= s.length) return null;
      const c = s[j];
      if (c === "\\") {
        const n = s[j + 1];
        value += n === "n" ? "\n" : n === "t" ? "\t" : (n ?? "");
        j += 2;
        continue;
      }
      if (c === '"') {
        j++;
        break;
      }
      value += c;
      j++;
    }
    out[key] = value;
    i = j;
  }
  return out;
}

/** True when every entry of `want` is present and equal in `labels`. */
export function labelsMatch(
  labels: Record<string, string>,
  want: Record<string, string>,
): boolean {
  for (const [k, v] of Object.entries(want)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

/** Sum every series of `name` whose labels match `want`. */
export function sumMatching(
  series: Series[],
  name: string,
  want: Record<string, string>,
): number {
  let total = 0;
  for (const s of series) {
    if (s.name === name && labelsMatch(s.labels, want)) total += s.value;
  }
  return total;
}

/** True when at least one series of `name` matches `want`. */
export function hasMatching(
  series: Series[],
  name: string,
  want: Record<string, string>,
): boolean {
  return series.some((s) => s.name === name && labelsMatch(s.labels, want));
}

export const OP_COUNTER = "hindsight_operation_operations_total";
export const OP_BUCKET = "hindsight_operation_duration_seconds_bucket";

/** The retain slice of one `/metrics` scrape, as the watchdog uses it. */
export interface RetainSignals {
  /** cumulative successful retain operations (all sources) */
  ok: number;
  /** cumulative failed retain operations (all sources) */
  fail: number;
  /**
   * Cumulative retain-duration histogram, `le` → cumulative count, summed
   * over every retain series (api + worker, success true + false). Keys are
   * the raw `le` strings so the record round-trips through JSON unchanged.
   */
  buckets: Record<string, number>;
}

/**
 * Extract the retain signals, or throw. Throwing is the point: an endpoint
 * that answers 200 with a body that has no retain counter means the metric
 * was renamed / the exporter changed / we are scraping the wrong process —
 * all of which must wake the operator, not silently read as "0 failures,
 * everything fine" (the exact silent-degradation shape this watchdog exists
 * to prevent).
 */
export function readRetainSignals(series: Series[]): RetainSignals {
  if (!hasMatching(series, OP_COUNTER, { operation: "retain" })) {
    throw new Error(
      `no \`${OP_COUNTER}{operation="retain"}\` series in /metrics — ` +
        `metric renamed, wrong endpoint, or exporter changed`,
    );
  }
  const ok = sumMatching(series, OP_COUNTER, {
    operation: "retain",
    success: "true",
  });
  const fail = sumMatching(series, OP_COUNTER, {
    operation: "retain",
    success: "false",
  });
  const buckets: Record<string, number> = {};
  for (const s of series) {
    if (s.name !== OP_BUCKET) continue;
    if (s.labels.operation !== "retain") continue;
    const le = s.labels.le;
    if (le === undefined) continue;
    buckets[le] = (buckets[le] ?? 0) + s.value;
  }
  return { ok, fail, buckets };
}

/**
 * Non-negative counter delta with reset detection. Prometheus counters reset
 * to 0 when the process restarts; hindsight restarts often enough (docker
 * `restart: always` + the operator recreating it) that ignoring this would
 * make the failure-rate signal read a large negative and evaluate as
 * "healthy" exactly when the container just crashed. On a decrease we credit
 * the whole new value as the delta, matching Prometheus' own `rate()`
 * extrapolation convention.
 */
export function counterDelta(prev: number, next: number): number {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return 0;
  return next >= prev ? next - prev : Math.max(0, next);
}

/** Per-`le` delta of two cumulative histograms, with reset handling. */
export function bucketDelta(
  prev: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [le, v] of Object.entries(next)) {
    out[le] = counterDelta(prev[le] ?? 0, v);
  }
  return out;
}

/** Add `b` into `a` in place (bucket accumulation across a ring window). */
export function addBuckets(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  for (const [le, v] of Object.entries(b)) a[le] = (a[le] ?? 0) + v;
  return a;
}

/** Result of a quantile read over a cumulative histogram. */
export interface QuantileResult {
  /** Estimated seconds; `Infinity` when the quantile lands in `+Inf`. */
  seconds: number;
  /** Total observations in the histogram (the `+Inf` bucket). */
  count: number;
  /**
   * True when the quantile fell in the `+Inf` bucket — the exposition's
   * largest finite `le` is 120, so all we can honestly say is "> 120s".
   */
  saturated: boolean;
}

/**
 * Linear-interpolated quantile over a CUMULATIVE bucket map (`le` → count),
 * the same estimator Prometheus' `histogram_quantile` uses. Returns
 * `count: 0` when the histogram is empty; the caller must treat that as
 * insufficient data, never as a healthy zero.
 */
export function histogramQuantile(
  buckets: Record<string, number>,
  q: number,
): QuantileResult {
  const finite = Object.entries(buckets)
    .filter(([le]) => le !== INF_BUCKET)
    .map(([le, count]) => ({ le: Number(le), count }))
    .filter((b) => Number.isFinite(b.le))
    .sort((a, b) => a.le - b.le);
  const count = buckets[INF_BUCKET] ?? (finite.length > 0 ? finite[finite.length - 1].count : 0);
  if (count <= 0) return { seconds: 0, count: 0, saturated: false };
  const rank = q * count;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of finite) {
    if (b.count >= rank) {
      const span = b.count - prevCount;
      if (span <= 0) return { seconds: b.le, count, saturated: false };
      const frac = (rank - prevCount) / span;
      return { seconds: prevLe + frac * (b.le - prevLe), count, saturated: false };
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  // Past the largest finite bucket: the observation is in `+Inf`.
  return { seconds: Infinity, count, saturated: true };
}

/** The largest finite `le` in the retain histogram (exposition-derived). */
export function largestFiniteBucket(buckets: Record<string, number>): number {
  const les = Object.keys(buckets)
    .filter((le) => le !== INF_BUCKET)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return les.length === 0 ? 0 : Math.max(...les);
}
