/**
 * The latency-vs-bank-size chart (AC3), rendered as a dependency-free SVG.
 *
 * Hand-rolled rather than pulled from a charting library on purpose: this ships
 * inside the switchroom CLI, and adding a plotting dependency to a 24/7 agent
 * runtime to draw one benchmark chart is a bad trade. The output is a plain
 * `.svg` any browser, GitHub comment or issue attachment renders.
 *
 * **Log x-axis.** The real banks span 12 to ~228,000 rows — four orders of
 * magnitude. On a linear axis every bank but the top three collapses onto the
 * origin and the chart says nothing. Log-x is what makes "flat latency as a
 * bank grows" a visually checkable claim.
 */

import type { BenchResult } from "./types.js";

const W = 900;
const H = 520;
const PAD = { top: 46, right: 210, bottom: 56, left: 76 };

/** Colour-blind-safe qualitative palette (Okabe-Ito). */
const COLOURS = ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#F0E442", "#000000"];

interface Series {
  label: string;
  points: Array<{ x: number; y: number }>;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * One series per (result file × concurrency level), x = bank row count,
 * y = p95 ms.
 *
 * Cells with a non-finite p95 (every call errored) are DROPPED rather than
 * plotted at zero — a chart that draws an outage as the fastest point on the
 * curve is worse than one with a gap in it.
 */
export function buildSeries(results: readonly BenchResult[]): Series[] {
  const series: Series[] = [];
  for (const r of results) {
    const byConc = new Map<number, Array<{ x: number; y: number }>>();
    for (const c of r.cells) {
      if (!Number.isFinite(c.stats.p95) || c.rows <= 0) continue;
      const arr = byConc.get(c.concurrency) ?? [];
      arr.push({ x: c.rows, y: c.stats.p95 });
      byConc.set(c.concurrency, arr);
    }
    const tag = r.config.label || r.config.startedAt;
    for (const conc of [...byConc.keys()].sort((a, b) => a - b)) {
      const pts = (byConc.get(conc) as Array<{ x: number; y: number }>).sort((a, b) => a.x - b.x);
      series.push({ label: `${tag} · c=${conc}`, points: pts });
    }
  }
  return series;
}

/** Render the chart. Returns SVG source; the caller writes it. */
export function renderPlot(results: readonly BenchResult[], title = "Hindsight recall p95 vs bank size"): string {
  const series = buildSeries(results);
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="80"><text x="16" y="44" font-family="sans-serif" font-size="14">no plottable cells (every p95 was non-finite)</text></svg>`;
  }
  const xs = all.map((p) => Math.log10(p.x));
  const ys = all.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  // y starts at 0 so the eye reads the ratio between cells, not a zoomed slope.
  const xSpan = x1 - x0 === 0 ? 1 : x1 - x0;
  const ySpan = y1 === 0 ? 1 : y1 * 1.08;
  const px = (v: number): number => PAD.left + ((Math.log10(v) - x0) / xSpan) * (W - PAD.left - PAD.right);
  const py = (v: number): number => H - PAD.bottom - (v / ySpan) * (H - PAD.top - PAD.bottom);

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(
    `<text x="${PAD.left}" y="26" font-family="sans-serif" font-size="16" font-weight="600">${escapeXml(title)}</text>`,
  );

  // Axes + gridlines.
  for (let i = 0; i <= 4; i++) {
    const v = (ySpan / 4) * i;
    const y = py(v);
    parts.push(`<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" stroke="#e6e6e6"/>`);
    parts.push(
      `<text x="${PAD.left - 8}" y="${y + 4}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#555">${Math.round(v)}</text>`,
    );
  }
  // One x tick per decade present.
  for (let d = Math.floor(x0); d <= Math.ceil(x1); d++) {
    const v = 10 ** d;
    if (Math.log10(v) < x0 || Math.log10(v) > x1) continue;
    const x = px(v);
    parts.push(`<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${H - PAD.bottom}" stroke="#f0f0f0"/>`);
    parts.push(
      `<text x="${x}" y="${H - PAD.bottom + 18}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555">10^${d}</text>`,
    );
  }
  parts.push(
    `<line x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}" stroke="#333"/>`,
  );
  parts.push(`<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${H - PAD.bottom}" stroke="#333"/>`);
  parts.push(
    `<text x="${(PAD.left + W - PAD.right) / 2}" y="${H - 14}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#333">memory_units rows in bank (log scale)</text>`,
  );
  parts.push(
    `<text x="18" y="${(PAD.top + H - PAD.bottom) / 2}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#333" transform="rotate(-90 18 ${(PAD.top + H - PAD.bottom) / 2})">recall p95 (ms)</text>`,
  );

  series.forEach((s, i) => {
    const colour = COLOURS[i % COLOURS.length] as string;
    const d = s.points.map((p, j) => `${j === 0 ? "M" : "L"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
    parts.push(`<path d="${d}" fill="none" stroke="${colour}" stroke-width="2"/>`);
    for (const p of s.points) {
      parts.push(`<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3" fill="${colour}"/>`);
    }
    const ly = PAD.top + 6 + i * 18;
    parts.push(`<line x1="${W - PAD.right + 12}" y1="${ly}" x2="${W - PAD.right + 32}" y2="${ly}" stroke="${colour}" stroke-width="2"/>`);
    parts.push(
      `<text x="${W - PAD.right + 38}" y="${ly + 4}" font-family="sans-serif" font-size="11" fill="#333">${escapeXml(s.label)}</text>`,
    );
  });

  parts.push("</svg>");
  return parts.join("\n");
}
