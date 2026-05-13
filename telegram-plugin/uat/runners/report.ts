/**
 * Markdown report renderer for the agent-self-sufficiency UAT.
 *
 * Layout decisions:
 *
 *   - Per-criterion pass-rate table is the headline — operator reads
 *     "did we move the needle" in one glance.
 *   - Per-agent + per-shape tables answer "did this regress for one
 *     agent" and "did one shape (typo/voice/multi) collapse".
 *   - Triage table lists every failure / timeout / error verbatim with
 *     the prompt and the reply, so the operator can diff them in the
 *     PR without re-running. Cap at 100 rows to keep the PR body
 *     digestible — the JSON sidecar (written alongside) has everything.
 */

import type { CaseResult } from "./scorer.js";
import { aggregate } from "./scorer.js";
import { CRITERIA } from "./paraphrases.js";

export interface RenderOptions {
  /** When the run started (used in the report header). */
  startedAt: Date;
  /** Total wall-clock seconds for the run. */
  durationSeconds: number;
  /** Agents the runner targeted. */
  agents: readonly string[];
  /** Cap on triage rows shown in the rendered markdown. Default 100. */
  triageCap?: number;
}

export function renderMarkdown(
  results: readonly CaseResult[],
  opts: RenderOptions,
): string {
  const agg = aggregate(results);
  const total = results.length;
  const passes = results.filter((r) => r.outcome === "pass").length;
  const passRate = total === 0 ? 0 : (passes / total) * 100;
  const cap = opts.triageCap ?? 100;

  const lines: string[] = [];
  lines.push("# Agent self-sufficiency UAT report");
  lines.push("");
  lines.push(`- **Run start:** ${opts.startedAt.toISOString()}`);
  lines.push(`- **Duration:** ${opts.durationSeconds.toFixed(1)}s`);
  lines.push(`- **Agents:** ${opts.agents.join(", ") || "(none)"}`);
  lines.push(`- **Total cases:** ${total}`);
  lines.push(`- **Overall pass rate:** ${passRate.toFixed(1)}% (${passes}/${total})`);
  lines.push("");

  // Per-criterion table.
  lines.push("## Pass rate by acceptance criterion");
  lines.push("");
  lines.push("| Criterion | Description | Pass | Fail | Timeout | Error | Rate |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const spec of CRITERIA) {
    const row = agg.byCriterion.get(spec.id) ?? {
      pass: 0,
      fail: 0,
      timeout: 0,
      error: 0,
    };
    const n = row.pass + row.fail + row.timeout + row.error;
    const rate = n === 0 ? "—" : `${((row.pass / n) * 100).toFixed(0)}%`;
    lines.push(
      `| \`${spec.id}\` | ${spec.description} | ${row.pass} | ${row.fail} | ${row.timeout} | ${row.error} | ${rate} |`,
    );
  }
  lines.push("");

  // Per-agent table.
  lines.push("## Pass rate by agent");
  lines.push("");
  lines.push("| Agent | Pass | Fail | Timeout | Error | Rate |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const agent of opts.agents) {
    const row = agg.byAgent.get(agent) ?? {
      pass: 0,
      fail: 0,
      timeout: 0,
      error: 0,
    };
    const n = row.pass + row.fail + row.timeout + row.error;
    const rate = n === 0 ? "—" : `${((row.pass / n) * 100).toFixed(0)}%`;
    lines.push(`| \`${agent}\` | ${row.pass} | ${row.fail} | ${row.timeout} | ${row.error} | ${rate} |`);
  }
  lines.push("");

  // Per-shape table — does the corpus's typo / voice / multi-intent
  // styles regress relative to formal / terse?
  lines.push("## Pass rate by paraphrase shape");
  lines.push("");
  lines.push("| Shape | Pass | Fail | Timeout | Error | Rate |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const shape of ["formal", "terse", "typo", "voice", "multi"] as const) {
    const row = agg.byShape.get(shape) ?? {
      pass: 0,
      fail: 0,
      timeout: 0,
      error: 0,
    };
    const n = row.pass + row.fail + row.timeout + row.error;
    const rate = n === 0 ? "—" : `${((row.pass / n) * 100).toFixed(0)}%`;
    lines.push(`| ${shape} | ${row.pass} | ${row.fail} | ${row.timeout} | ${row.error} | ${rate} |`);
  }
  lines.push("");

  // Triage — every non-pass, verbatim.
  const triage = results.filter((r) => r.outcome !== "pass");
  if (triage.length > 0) {
    lines.push("## Triage — failures, timeouts, errors");
    lines.push("");
    lines.push(`${triage.length} non-pass cases (showing up to ${cap}):`);
    lines.push("");
    lines.push("| # | Agent | Criterion | Shape | Outcome | Prompt | Reply (or error) |");
    lines.push("|---:|---|---|---|---|---|---|");
    triage.slice(0, cap).forEach((r, i) => {
      const reply =
        r.outcome === "error"
          ? `_error: ${escapeCell(r.errorMessage ?? "?")}_`
          : r.outcome === "timeout"
            ? `_timeout after ${r.durationMs}ms_`
            : escapeCell(truncate(r.reply, 240));
      lines.push(
        `| ${i + 1} | \`${r.agent}\` | \`${r.criterion}\` | ${r.paraphrase.shape} | ${r.outcome} | ${escapeCell(truncate(r.paraphrase.text, 120))} | ${reply} |`,
      );
    });
    if (triage.length > cap) {
      lines.push("");
      lines.push(`_…and ${triage.length - cap} more. Full results in the JSON sidecar._`);
    }
    lines.push("");
  } else {
    lines.push("## Triage");
    lines.push("");
    lines.push("All cases passed. No triage required.");
    lines.push("");
  }

  return lines.join("\n");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/`/g, "ʼ");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
