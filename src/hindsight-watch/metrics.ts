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

/** The retain slice of one `/metrics` scrape, as the watchdog uses it. */
export interface RetainSignals {
  /** cumulative successful retain operations (all sources) */
  ok: number;
  /** cumulative failed retain operations (all sources) */
  fail: number;
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
  return { ok, fail };
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

export const LLM_COUNTER = "hindsight_llm_calls_total";

/** The LLM-call slice of one `/metrics` scrape. */
export interface LlmSignals {
  /** cumulative successful LLM calls across every lane */
  ok: number;
  /** cumulative failed LLM calls across every lane */
  fail: number;
}

/**
 * Extract the LLM-call signals, or null when the family is absent.
 *
 * Unlike `readRetainSignals` this returns null instead of throwing. The
 * difference is deliberate: the retain counter is the watchdog's *reason for
 * existing*, so its disappearance must wake someone. The LLM counter backs
 * ONE supplementary signal, and an exposition that has stopped emitting it
 * (an idle backend that has never made a call since boot emits no series at
 * all) must degrade that one signal to `no-data` rather than blind the eight
 * others behind a probe failure.
 *
 * Note what this counter can and cannot see. Hindsight records the model it
 * ASKED LiteLLM for; LiteLLM's router fallback happens inside that same
 * request, so no `*-openrouter` series ever appears here (verified: 0 on the
 * live endpoint, 2026-07-27). `success="false"` therefore means the local
 * deployment failed AND the fallback did not rescue it — which is exactly the
 * question `llm-fallback-ineffective` asks.
 */
export function readLlmSignals(series: Series[]): LlmSignals | null {
  if (!series.some((s) => s.name === LLM_COUNTER)) return null;
  return {
    ok: sumMatching(series, LLM_COUNTER, { success: "true" }),
    fail: sumMatching(series, LLM_COUNTER, { success: "false" }),
  };
}
