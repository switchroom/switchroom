import { describe, it, expect } from "vitest";
import {
  bucketDelta,
  counterDelta,
  histogramQuantile,
  largestFiniteBucket,
  parseExposition,
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

  it("collects only the retain histogram buckets", () => {
    const s = readRetainSignals(parseExposition(LIVE));
    expect(s.buckets["+Inf"]).toBe(13); // recall's +Inf=3 must NOT be folded in
    expect(s.buckets["60.0"]).toBe(10);
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

describe("bucketDelta", () => {
  it("diffs per-le and handles a reset", () => {
    expect(bucketDelta({ "60.0": 10, "+Inf": 12 }, { "60.0": 14, "+Inf": 20 })).toEqual({
      "60.0": 4,
      "+Inf": 8,
    });
    expect(bucketDelta({ "60.0": 10, "+Inf": 12 }, { "60.0": 1, "+Inf": 2 })).toEqual({
      "60.0": 1,
      "+Inf": 2,
    });
  });
});

describe("histogramQuantile", () => {
  it("interpolates inside a bucket", () => {
    // 100 observations, all ≤60s, uniformly spread over 30..60.
    const q = histogramQuantile({ "30.0": 0, "60.0": 100, "+Inf": 100 }, 0.95);
    expect(q.count).toBe(100);
    expect(q.saturated).toBe(false);
    expect(q.seconds).toBeCloseTo(58.5, 1);
  });

  it("reports saturation when the quantile lands in +Inf", () => {
    // 90 fast retains, 10 that blew past the largest finite bucket (120s).
    const q = histogramQuantile({ "60.0": 90, "120.0": 90, "+Inf": 100 }, 0.95);
    expect(q.saturated).toBe(true);
    expect(q.seconds).toBe(Infinity);
  });

  it("returns count 0 for an empty histogram rather than a healthy-looking 0s", () => {
    const q = histogramQuantile({ "60.0": 0, "+Inf": 0 }, 0.95);
    expect(q.count).toBe(0);
  });
});

describe("largestFiniteBucket", () => {
  it("reports the exposition's top finite le", () => {
    expect(largestFiniteBucket({ "30.0": 1, "120.0": 2, "+Inf": 3 })).toBe(120);
  });
});
