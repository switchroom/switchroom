/**
 * Report-only reaper pass — evidence, never deletion.
 *
 * ## Why this exists
 *
 * The reaper (`reaper.ts`, registry claims) and the task-tree sweep
 * (`gc.ts`, per-agent `home/work` checkouts) both know how to classify a tree
 * as reapable. Nothing runs either on a schedule, so the fleet has no record
 * of whether those classifiers are RIGHT — and the first time anyone finds out
 * would be the first time something automatic deletes a checkout.
 *
 * This module runs both classifiers on a schedule and writes down what they
 * WOULD do. It builds the week of evidence that has to exist before any
 * automatic deletion is considered.
 *
 * ## The safety default lives here, structurally
 *
 * `buildReapReport` is a pure read: it composes `planReaper` and `planGc`,
 * both of which are plan-only predicates, and it imports NO removal primitive
 * — not `applyGc`, not `runReaper`, not `removeCheckout`, not `rm`. There is
 * no flag on this path that deletes, because there is no code here that can.
 * `planGc` is always called with `escapeHatch: false` so the report cannot
 * even describe the operator's reversible-quarantine action as something it
 * would do. Turning deletion on is a separate, deliberate change to a
 * different code path (`switchroom worktree gc --yes` / `worktree reap`), not
 * a flag flip on this one.
 *
 * ## Per-agent size budget
 *
 * Reporting is grouped per agent and ordered OLDEST-FIRST, so the report shows
 * the eviction order a budget-driven reaper would use (RFC
 * `agent-home-lifecycle.md` §2). Entries are marked `overBudget` when
 * evicting them oldest-first is what would bring that agent back under the
 * budget — and ONLY entries that already clear every safety guard are ever
 * marked, so the budget can never be a reason to cross a guard. When the
 * guards block enough that the agent stays over budget, the report says so
 * (`stillOverBytes`) instead of widening the eligibility.
 */

import { execFileSync } from "node:child_process";
import { sep } from "node:path";
import { planReaper, type ReapPlanEntry, type ReaperDeps } from "./reaper.js";
import {
  planGc,
  defaultRoots,
  defaultTaskTreeRoots,
  defaultTaskTreeDirs,
  type GcPlan,
  type TaskTreeAction,
} from "./gc.js";

/** Per-agent task-tree budget default (RFC §2: 5 GB). */
export const DEFAULT_AGENT_TREE_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;

/** Agent label used when a tree cannot be attributed to one. */
export const UNATTRIBUTED_AGENT = "(unattributed)";

/**
 * Resolve the per-agent budget: `SWITCHROOM_AGENT_TREE_BUDGET_GB` (a number,
 * may be fractional), else the 5 GB default. An unparseable or negative value
 * falls back to the default rather than silently reporting everything as over
 * budget.
 */
export function agentTreeBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SWITCHROOM_AGENT_TREE_BUDGET_GB;
  if (raw == null || raw.trim() === "") return DEFAULT_AGENT_TREE_BUDGET_BYTES;
  const gb = Number(raw);
  if (!Number.isFinite(gb) || gb <= 0) return DEFAULT_AGENT_TREE_BUDGET_BYTES;
  return Math.round(gb * 1024 * 1024 * 1024);
}

/**
 * Attribute a path to an agent: `<...>/agents/<name>/<...>` → `<name>`.
 * Returns null when the path is not inside an agent home.
 */
export function agentFromPath(path: string): string | null {
  const parts = path.split(sep);
  const i = parts.lastIndexOf("agents");
  if (i < 0 || i + 1 >= parts.length) return null;
  const name = parts[i + 1];
  return name && name !== "" ? name : null;
}

export type ReapReportSource = "claim" | "task-tree";

export interface ReapReportEntry {
  source: ReapReportSource;
  agent: string;
  path: string;
  branch: string | null;
  /** Verbatim classifier verdict (`ReapAction` or `TaskTreeVerdict`). */
  verdict: string;
  /** True when the classifier would reap this tree on its own guards. */
  wouldReap: boolean;
  /**
   * Newest activity (ms since epoch) — heartbeat for a claim, newest tracked
   * mtime for a task tree. `null` when it could not be determined, which the
   * classifiers already treat as "active ⇒ keep".
   */
  lastActivityMs: number | null;
  /** Whole days since `lastActivityMs`; null when that is null. */
  idleDays: number | null;
  sizeBytes: number;
  /** False when sizing failed (the tree is counted as 0 bytes). */
  sizeKnown: boolean;
  /**
   * True when oldest-first eviction of the guard-clear trees would have to
   * include this one to bring the agent under budget. Never set on an entry
   * that fails a guard.
   */
  overBudget: boolean;
}

export interface AgentBudgetReport {
  agent: string;
  budgetBytes: number;
  totalBytes: number;
  /** Bytes the guard-clear, over-budget entries would reclaim. */
  reclaimableBytes: number;
  /** Bytes still over budget after every guard-clear eviction. 0 when clear. */
  stillOverBytes: number;
  /** Oldest activity first. */
  entries: ReapReportEntry[];
}

export interface ReapReport {
  /** Always "report-only". There is no other mode on this path. */
  mode: "report-only";
  generatedAt: string;
  budgetBytes: number;
  idleDays: number;
  agents: AgentBudgetReport[];
  totals: {
    candidates: number;
    wouldReap: number;
    wouldSkip: number;
    bytesIfReaped: number;
    /** Trees no probe could clear — the liveness-probe exposure, measured. */
    probeUnavailable: number;
  };
  /** Count per verdict across every candidate — the classifier evidence. */
  verdictCounts: Record<string, number>;
}

export interface ReapReportDeps {
  /** Registry-claim plan. Default: `planReaper()`. */
  reapPlan?: ReapPlanEntry[];
  /** Task-tree plan. Default: `planGc(defaultRoots(), …, defaultTaskTreeRoots())`. */
  gcPlan?: GcPlan;
  /** Directory size in bytes; default shells `du -sk`. */
  dirSizeBytes?: (path: string) => number;
  nowMs?: number;
  budgetBytes?: number;
  idleDays?: number;
  /** Passed through to the default `planGc` call. */
  roots?: string[];
  taskTreeRoots?: string[];
  /** Explicit task-tree candidates (widened discovery). Default: discovered. */
  taskTreeDirs?: string[];
  reaperDeps?: ReaperDeps;
}

/**
 * Apparent disk usage of a directory, in bytes.
 *
 * `du -sk` (KiB) rather than `-sb`: BSD/macOS `du` has no `-b`. Any failure
 * (path gone, permission denied) reports 0 with `sizeKnown: false` upstream —
 * a size is reporting metadata, never a safety input.
 */
export function defaultDirSizeBytes(path: string): number {
  const out = execFileSync("du", ["-sk", path], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).toString();
  const kib = parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(kib)) throw new Error(`unparseable du output: ${out.trim()}`);
  return kib * 1024;
}

function daysBetween(nowMs: number, thenMs: number): number {
  return Math.max(0, Math.floor((nowMs - thenMs) / 86_400_000));
}

function taskTreeEntry(
  t: TaskTreeAction,
  nowMs: number,
  size: (p: string) => number,
): ReapReportEntry {
  let sizeBytes = 0;
  let sizeKnown = true;
  try {
    sizeBytes = size(t.dir);
  } catch {
    sizeKnown = false;
  }
  return {
    source: "task-tree",
    agent: agentFromPath(t.dir) ?? UNATTRIBUTED_AGENT,
    path: t.dir,
    branch: t.branch,
    verdict: t.verdict,
    // `willAct` under a report build is exactly `verdict === "reap"`: the
    // report always plans with the escape hatch OFF.
    wouldReap: t.willAct,
    lastActivityMs: t.newestMtimeMs,
    idleDays: t.newestMtimeMs == null ? null : daysBetween(nowMs, t.newestMtimeMs),
    sizeBytes,
    sizeKnown,
    overBudget: false,
  };
}

function claimEntry(
  e: ReapPlanEntry,
  nowMs: number,
  size: (p: string) => number,
): ReapReportEntry {
  let sizeBytes = 0;
  let sizeKnown = true;
  try {
    sizeBytes = size(e.record.path);
  } catch {
    sizeKnown = false;
  }
  const hb = Date.parse(e.record.heartbeatAt);
  const lastActivityMs = Number.isFinite(hb) ? hb : null;
  return {
    source: "claim",
    agent: e.record.ownerAgent ?? UNATTRIBUTED_AGENT,
    path: e.record.path,
    branch: e.record.branch,
    verdict: e.action,
    wouldReap: e.action === "reap" || e.action === "reap-orphan",
    lastActivityMs,
    idleDays: lastActivityMs == null ? null : daysBetween(nowMs, lastActivityMs),
    sizeBytes,
    sizeKnown,
    overBudget: false,
  };
}

/**
 * Mark the oldest-first prefix of guard-clear entries whose eviction would
 * bring the agent under budget. Mutates `entries` (already oldest-first) and
 * returns the reclaimable / still-over figures.
 */
function applyBudget(
  entries: ReapReportEntry[],
  budgetBytes: number,
): { totalBytes: number; reclaimableBytes: number; stillOverBytes: number } {
  const totalBytes = entries.reduce((n, e) => n + e.sizeBytes, 0);
  if (totalBytes <= budgetBytes) {
    return { totalBytes, reclaimableBytes: 0, stillOverBytes: 0 };
  }
  let remaining = totalBytes;
  let reclaimableBytes = 0;
  for (const e of entries) {
    if (remaining <= budgetBytes) break;
    // A guard is never crossed for budget's sake: only trees the classifier
    // already cleared are eligible for eviction.
    if (!e.wouldReap) continue;
    e.overBudget = true;
    reclaimableBytes += e.sizeBytes;
    remaining -= e.sizeBytes;
  }
  return {
    totalBytes,
    reclaimableBytes,
    stillOverBytes: Math.max(0, remaining - budgetBytes),
  };
}

/**
 * Build the report. Reads only — see the module header for why deletion is
 * structurally absent from this path rather than merely defaulted off.
 */
export function buildReapReport(deps: ReapReportDeps = {}): ReapReport {
  const nowMs = deps.nowMs ?? Date.now();
  const budgetBytes = deps.budgetBytes ?? agentTreeBudgetBytes();
  const idleDays = deps.idleDays ?? 14;
  const size = deps.dirSizeBytes ?? defaultDirSizeBytes;

  const reapPlan = deps.reapPlan ?? planReaper(nowMs, deps.reaperDeps ?? {});
  const gcPlan =
    deps.gcPlan ??
    planGc(
      deps.roots ?? defaultRoots(),
      {
        dateStamp: new Date(nowMs).toISOString().slice(0, 10),
        idleDays,
        nowMs,
        // Report-only: the operator escape hatch is never simulated here.
        escapeHatch: false,
      },
      deps.taskTreeRoots ?? defaultTaskTreeRoots(),
      // Explicit roots mean the caller has scoped the sweep (and tests inject
      // them for hermeticity) — do not widen out from under them.
      deps.taskTreeDirs ?? (deps.taskTreeRoots ? [] : defaultTaskTreeDirs()),
    );

  const entries: ReapReportEntry[] = [
    // A fresh claim is not a candidate for anything; excluding it keeps the
    // report about trees the classifiers have an opinion on.
    ...reapPlan.filter((e) => e.action !== "keep-fresh").map((e) => claimEntry(e, nowMs, size)),
    ...gcPlan.taskTrees
      .filter((t) => t.verdict !== "skip-protected")
      .map((t) => taskTreeEntry(t, nowMs, size)),
  ];

  const byAgent = new Map<string, ReapReportEntry[]>();
  for (const e of entries) {
    const list = byAgent.get(e.agent) ?? [];
    list.push(e);
    byAgent.set(e.agent, list);
  }

  const agents: AgentBudgetReport[] = [...byAgent.entries()]
    .map(([agent, list]) => {
      // Oldest first. Unknown activity sorts LAST: the classifiers treat it as
      // active, so it must never head an eviction order.
      list.sort((a, b) => {
        if (a.lastActivityMs == null && b.lastActivityMs == null) return a.path.localeCompare(b.path);
        if (a.lastActivityMs == null) return 1;
        if (b.lastActivityMs == null) return -1;
        return a.lastActivityMs - b.lastActivityMs;
      });
      const budget = applyBudget(list, budgetBytes);
      return {
        agent,
        budgetBytes,
        totalBytes: budget.totalBytes,
        reclaimableBytes: budget.reclaimableBytes,
        stillOverBytes: budget.stillOverBytes,
        entries: list,
      };
    })
    .sort((a, b) => b.totalBytes - a.totalBytes || a.agent.localeCompare(b.agent));

  const verdictCounts: Record<string, number> = {};
  for (const e of entries) verdictCounts[e.verdict] = (verdictCounts[e.verdict] ?? 0) + 1;

  const wouldReap = entries.filter((e) => e.wouldReap);
  return {
    mode: "report-only",
    generatedAt: new Date(nowMs).toISOString(),
    budgetBytes,
    idleDays,
    agents,
    totals: {
      candidates: entries.length,
      wouldReap: wouldReap.length,
      wouldSkip: entries.length - wouldReap.length,
      bytesIfReaped: wouldReap.reduce((n, e) => n + e.sizeBytes, 0),
      probeUnavailable: entries.filter((e) => e.verdict === "skip-probe-unavailable").length,
    },
    verdictCounts,
  };
}

/** Human-readable bytes (report output only). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u === 0 ? n : n.toFixed(1)}${units[u]}`;
}

/**
 * Render the report as the plain text a cron log wants. Deliberately states
 * "nothing was deleted" on every run so a log tail can never be mistaken for
 * a record of deletions.
 */
export function formatReapReport(report: ReapReport): string {
  const lines: string[] = [];
  lines.push(
    `worktree reap-report — REPORT ONLY, nothing was deleted (${report.generatedAt})`,
  );
  lines.push(
    `budget ${formatBytes(report.budgetBytes)}/agent · idle threshold ${report.idleDays}d`,
  );
  lines.push(
    `${report.totals.candidates} candidate(s): ${report.totals.wouldReap} would reap ` +
      `(${formatBytes(report.totals.bytesIfReaped)}), ${report.totals.wouldSkip} would be kept` +
      (report.totals.probeUnavailable > 0
        ? ` — ${report.totals.probeUnavailable} could not be proven idle`
        : ""),
  );

  if (report.agents.length === 0) {
    lines.push("");
    lines.push("No candidate worktrees found.");
    return lines.join("\n");
  }

  for (const a of report.agents) {
    lines.push("");
    const over = a.totalBytes > a.budgetBytes ? ` OVER BUDGET by ${formatBytes(a.totalBytes - a.budgetBytes)}` : "";
    lines.push(`${a.agent} — ${formatBytes(a.totalBytes)} across ${a.entries.length} tree(s)${over}`);
    if (a.stillOverBytes > 0) {
      lines.push(
        `  ${formatBytes(a.stillOverBytes)} would remain over budget: the guards keep the rest.`,
      );
    }
    for (const e of a.entries) {
      const age = e.idleDays == null ? "age?" : `${e.idleDays}d`;
      const marks = [
        e.wouldReap ? "would-reap" : `keep:${e.verdict}`,
        e.overBudget ? "over-budget" : null,
        e.sizeKnown ? null : "size?",
      ].filter(Boolean);
      lines.push(
        `  ${age.padStart(5)}  ${formatBytes(e.sizeBytes).padStart(8)}  ${e.source.padEnd(9)}  ` +
          `${e.path} [${e.branch ?? "detached"}] ${marks.join(" ")}`,
      );
    }
  }

  const verdicts = Object.entries(report.verdictCounts).sort((a, b) => b[1] - a[1]);
  if (verdicts.length > 0) {
    lines.push("");
    lines.push(`verdicts: ${verdicts.map(([v, n]) => `${v}=${n}`).join(" ")}`);
  }
  return lines.join("\n");
}
