import { describe, it, expect } from "vitest";
import {
  counterDelta,
  parseExposition,
  readLlmSignals,
  readRetainSignals,
  sumMatching,
} from "./metrics.js";

/**
 * Verbatim shape of the live exposition, captured from
 * `curl http://127.0.0.1:18888/metrics` on switchroom-hindsight v0.19.18
 * (2026-07-25). Label ORDER here is the exporter's real order — `le` lands
 * in the middle of the bucket labels, which is exactly the case a naive
 * string match would get wrong.
 */
const LIVE = `# HELP hindsight_operation_operations_total Operations
# TYPE hindsight_operation_operations_total counter
hindsight_operation_operations_total{budget="",max_tokens="",operation="retain",otel_scope_name="hindsight_api.metrics",otel_scope_schema_url="",otel_scope_version="",source="api",success="true",tenant="public"} 13.0
hindsight_operation_operations_total{budget="low",max_tokens="1024",operation="recall",otel_scope_name="hindsight_api.metrics",otel_scope_schema_url="",otel_scope_version="",source="api",success="true",tenant="public"} 3.0
hindsight_operation_operations_total{budget="",max_tokens="",operation="retain",otel_scope_name="hindsight_api.metrics",otel_scope_schema_url="",otel_scope_version="",source="worker",success="true",tenant="public"} 1.0
hindsight_operation_operations_total{budget="",max_tokens="",operation="retain",otel_scope_name="hindsight_api.metrics",otel_scope_schema_url="",otel_scope_version="",source="api",success="false",tenant="public"} 5.0
hindsight_operation_duration_seconds_bucket{budget="",le="30.0",max_tokens="",operation="retain",source="api",success="true",tenant="public"} 5.0
hindsight_operation_duration_seconds_bucket{budget="",le="60.0",max_tokens="",operation="retain",source="api",success="true",tenant="public"} 10.0
hindsight_operation_duration_seconds_bucket{budget="",le="120.0",max_tokens="",operation="retain",source="api",success="true",tenant="public"} 12.0
hindsight_operation_duration_seconds_bucket{budget="",le="+Inf",max_tokens="",operation="retain",source="api",success="true",tenant="public"} 13.0
hindsight_operation_duration_seconds_bucket{budget="low",le="+Inf",max_tokens="1024",operation="recall",source="api",success="true",tenant="public"} 3.0
`;

describe("parseExposition", () => {
  it("parses name, labels and value, skipping HELP/TYPE", () => {
    const series = parseExposition(LIVE);
    expect(series).toHaveLength(9);
    expect(series[0].name).toBe("hindsight_operation_operations_total");
    expect(series[0].labels.operation).toBe("retain");
    expect(series[0].labels.success).toBe("true");
    expect(series[0].value).toBe(13);
  });

  it("skips malformed lines instead of throwing", () => {
    const series = parseExposition('good_metric{a="1"} 2\nbroken{a=\nalso_broken 1 2 3\n');
    expect(series.map((s) => s.name)).toContain("good_metric");
    expect(series.some((s) => s.name === "broken")).toBe(false);
  });

  it("handles escaped quotes inside label values", () => {
    const series = parseExposition('m{a="say \\"hi\\"",b="2"} 7\n');
    expect(series[0].labels).toEqual({ a: 'say "hi"', b: "2" });
    expect(series[0].value).toBe(7);
  });
});

describe("readRetainSignals", () => {
  it("sums retain successes across sources and ignores recall", () => {
    const s = readRetainSignals(parseExposition(LIVE));
    expect(s.ok).toBe(14); // api 13 + worker 1; recall's 3 excluded
    expect(s.fail).toBe(5);
  });

  it("ignores the duration histogram entirely", () => {
    // The `retain-latency-p95` signal was removed (thresholds.ts documents
    // why: 120s is the top finite `le` and a healthy backend already runs
    // 19.4% of retains past it), so the reader must not carry buckets it
    // has no consumer for.
    const s = readRetainSignals(parseExposition(LIVE));
    expect(Object.keys(s).sort()).toEqual(["fail", "ok"]);
  });

  it("THROWS when the retain counter is absent — a renamed metric must not read as zero failures", () => {
    const body = 'hindsight_operation_operations_total{operation="recall",success="true"} 3.0\n';
    expect(() => readRetainSignals(parseExposition(body))).toThrow(/no .*operation="retain".* series/);
  });
});

describe("sumMatching", () => {
  it("requires every wanted label to match", () => {
    const series = parseExposition(LIVE);
    expect(
      sumMatching(series, "hindsight_operation_operations_total", {
        operation: "retain",
        source: "worker",
        success: "true",
      }),
    ).toBe(1);
  });
});

describe("counterDelta", () => {
  it("is the plain difference when the counter advances", () => {
    expect(counterDelta(100, 130)).toBe(30);
  });

  it("credits the whole new value on a counter RESET (container restart)", () => {
    // The bug this guards: hindsight restarts, retainFail goes 900 → 4.
    // A naive next-prev is -896, which would evaluate as a healthy window
    // precisely when the container just crashed.
    expect(counterDelta(900, 4)).toBe(4);
  });
});

/**
 * `readLlmSignals` — the LLM-call slice.
 *
 * Verbatim label shape from the live endpoint on 2026-07-27. Note what is
 * NOT here: any `*-openrouter` model. LiteLLM's router fallback happens
 * inside the request hindsight makes, so hindsight only ever records the model
 * it ASKED for — which is why the fallback's effectiveness has to be read from
 * the failure rate rather than from OpenRouter traffic.
 */
const LLM_EXPO = `# HELP hindsight_llm_calls_total LLM calls
# TYPE hindsight_llm_calls_total counter
hindsight_llm_calls_total{model="gpt-oss-20b",operation="recall",success="true",tenant="public"} 612.0
hindsight_llm_calls_total{model="gpt-oss-20b-retain",operation="retain",success="true",tenant="public"} 188.0
hindsight_llm_calls_total{model="gpt-oss-20b",operation="recall",success="false",tenant="public"} 7.0
`;

describe("readLlmSignals", () => {
  it("sums successes and failures across every lane", () => {
    const s = readLlmSignals(parseExposition(LLM_EXPO));
    expect(s).toEqual({ ok: 800, fail: 7 });
  });

  it("returns null — not a throw — when the family is absent", () => {
    // Deliberately unlike readRetainSignals: an idle backend that has made no
    // LLM call since boot emits no series at all, and that must degrade ONE
    // supplementary signal to no-data rather than blind the other ten behind
    // a probe failure.
    expect(readLlmSignals(parseExposition(LIVE))).toBeNull();
  });

  it("reads zero failures as zero, not as an absent family", () => {
    const clean = LLM_EXPO.split("\n").filter((l) => !l.includes('success="false"')).join("\n");
    expect(readLlmSignals(parseExposition(clean))).toEqual({ ok: 800, fail: 0 });
  });
});
