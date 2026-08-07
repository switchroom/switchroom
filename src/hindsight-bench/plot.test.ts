import { describe, it, expect } from "vitest";
import { makeCell, makeResult } from "./fixtures.js";
import { buildSeries, renderPlot } from "./plot.js";

describe("buildSeries", () => {
  it("emits one series per (result file × concurrency), sorted by bank size", () => {
    const r = makeResult([
      makeCell("small", 12, 1, 200),
      makeCell("big", 228761, 1, 1000),
      makeCell("big", 228761, 4, 2000),
    ]);
    const series = buildSeries([r]);
    expect(series).toHaveLength(2);
    expect(series[0]?.points.map((p) => p.x)).toEqual([12, 228761]);
    expect(series[0]?.label).toContain("c=1");
  });

  it("DROPS a non-finite p95 rather than plotting an outage as the fastest cell", () => {
    const dead = makeCell("small", 12, 1, 200);
    dead.stats = { ...dead.stats, n: 0, errors: 20, p95: NaN };
    const series = buildSeries([makeResult([dead, makeCell("big", 228761, 1, 1000)])]);
    expect(series[0]?.points).toEqual([{ x: 228761, y: 1000 }]);
  });

  it("drops zero-row banks, which have no position on a log axis", () => {
    const series = buildSeries([makeResult([makeCell("empty", 0, 1, 100), makeCell("big", 100, 1, 200)])]);
    expect(series[0]?.points.map((p) => p.x)).toEqual([100]);
  });

  it("distinguishes two result files by label", () => {
    const a = makeResult([makeCell("big", 100, 1, 100)], { label: "idle" });
    const b = makeResult([makeCell("big", 100, 1, 400)], { label: "contended" });
    expect(buildSeries([a, b]).map((s) => s.label)).toEqual(["idle · c=1", "contended · c=1"]);
  });
});

describe("renderPlot", () => {
  const r = makeResult([makeCell("small", 12, 1, 200), makeCell("big", 228761, 1, 1000)], { label: "baseline" });

  it("renders standalone SVG with the axis labelled as log scale", () => {
    const svg = renderPlot([r]);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("log scale");
    expect(svg).toContain("recall p95 (ms)");
  });

  it("escapes label text into the SVG rather than injecting markup", () => {
    const evil = makeResult([makeCell("big", 100, 1, 100)], { label: '<script>x</script>&"' });
    const svg = renderPlot([evil]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&#60;");
  });

  it("degrades to a legible placeholder when nothing is plottable", () => {
    const dead = makeCell("big", 100, 1, 100);
    dead.stats = { ...dead.stats, p95: NaN };
    const svg = renderPlot([makeResult([dead])]);
    expect(svg).toContain("no plottable cells");
  });

  it("is deterministic for the same input", () => {
    expect(renderPlot([r])).toBe(renderPlot([r]));
  });
});
