/**
 * Markdown report renderer for the M3 directive-flip UAT gate.
 *
 * Same shape as the agent-self-sufficiency runner's report
 * (`telegram-plugin/uat/runners/report.ts`): a headline verdict, a per-agent ×
 * per-check pass/fail matrix an operator reads in one glance, then a verbatim
 * triage list of every failing check so a PR reviewer can diff without
 * re-running. Pure — takes the gate verdicts, returns a string.
 */

import type { GateRun, GateVerdict, GateCheck } from "./gate.js";

export interface FlipReportOptions {
  startedAt?: Date;
  durationSeconds?: number;
}

function mark(c: GateCheck): string {
  if (c.skipped) return "—";
  return c.pass ? "✅" : "❌";
}

export function renderFlipReport(run: GateRun, opts: FlipReportOptions = {}): string {
  const { verdicts } = run;
  const passed = verdicts.filter((v) => v.pass).length;
  const lines: string[] = [];

  lines.push("# M3 directive-flip UAT gate report");
  lines.push("");
  if (opts.startedAt) lines.push(`- **Run start:** ${opts.startedAt.toISOString()}`);
  if (typeof opts.durationSeconds === "number")
    lines.push(`- **Duration:** ${opts.durationSeconds.toFixed(1)}s`);
  lines.push(`- **Agents:** ${verdicts.map((v) => v.agent).join(", ") || "(none)"}`);
  lines.push(`- **Verdict:** ${run.exitCode === 0 ? "PASS" : "FAIL"} (${passed}/${verdicts.length} agents green)`);
  lines.push("");

  // Per-agent × per-check matrix. Check names are stable across agents, so use
  // the first verdict's check order as the column set.
  const checkNames = verdicts[0]?.checks.map((c) => c.name) ?? [];
  if (checkNames.length > 0 && verdicts.length > 0) {
    lines.push("## Check matrix");
    lines.push("");
    lines.push(`| Agent | Verdict | ${checkNames.map((n) => shortName(n)).join(" | ")} |`);
    lines.push(`|---|---|${checkNames.map(() => "---").join("|")}|`);
    for (const v of verdicts) {
      const byName = new Map(v.checks.map((c) => [c.name, c]));
      const cells = checkNames.map((n) => {
        const c = byName.get(n);
        return c ? mark(c) : "?";
      });
      lines.push(`| \`${v.agent}\` | ${v.pass ? "PASS" : "FAIL"} | ${cells.join(" | ")} |`);
    }
    lines.push("");
    lines.push("_Legend: ✅ pass · ❌ fail · — skipped (input not supplied)._");
    lines.push("");
  }

  // Triage — every failing check, verbatim detail.
  const failing: Array<{ agent: string; check: GateCheck }> = [];
  for (const v of verdicts) {
    for (const c of v.checks) {
      if (!c.pass && !c.skipped) failing.push({ agent: v.agent, check: c });
    }
  }
  lines.push("## Triage — failing checks");
  lines.push("");
  if (failing.length === 0) {
    lines.push("No failing checks. Every ran check passed.");
  } else {
    lines.push("| Agent | Check | Detail |");
    lines.push("|---|---|---|");
    for (const f of failing) {
      lines.push(`| \`${f.agent}\` | ${escapeCell(f.check.name)} | ${escapeCell(f.check.detail)} |`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

/** Render just one agent's verdict as a compact block (for a per-agent log). */
export function renderVerdictLine(v: GateVerdict): string {
  const parts = v.checks.map((c) => `${mark(c)} ${shortName(c.name)}`);
  return `${v.pass ? "PASS" : "FAIL"} ${v.agent}: ${parts.join(" · ")}`;
}

/** Drop the `tierN: ` / `recall_log: ` prefix for a compact column header. */
function shortName(name: string): string {
  const idx = name.indexOf(": ");
  return idx === -1 ? name : name.slice(idx + 2);
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/`/g, "ʼ");
}
