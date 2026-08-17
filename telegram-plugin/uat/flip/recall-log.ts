/**
 * recall_log.jsonl reader for the Memory v2 M3 directive-flip UAT gate.
 *
 * The recall hook appends one JSON row per turn to
 * `<agent>/.claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl`
 * (see `vendor/hindsight-memory/scripts/recall.py` `_write_recall_log`). Three
 * fields on each row make the flip measurable WITHOUT a model:
 *
 *   - `directive_count`     — how many active directives were injected into
 *                             the `<active_directives>` block that turn.
 *   - `directives_omitted`  — how many the MAX_DIRECTIVES cap dropped.
 *   - `directive_ids`       — the exact ids injected, priority-descending.
 *
 * The flip's whole point is that AFTER `memory.inject_directives:false` no
 * directives are injected — so `directive_count` collapses to 0 and
 * `directive_ids` empties. This reader + {@link directiveInjectionDelta} turn
 * that into a deterministic before/after assertion the gate can fail on.
 *
 * HONEST SCOPE NOTE (real-source finding): recall_log rows carry directive
 * COUNTS and IDS, not rendered token bytes — the byte/token size of the
 * residue lives in the M2 residue harness (`src/memory/directive-residue.ts`)
 * and the Tier-1 rules-block budget, not here. So the "token delta" the gate
 * consumes from this file is a directive-injection-VOLUME delta (count of
 * directives no longer injected), which is the recall_log's real signal;
 * pairing it with the residue harness's byte number is the caller's job.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One recall_log.jsonl row. Only the fields this gate reads are typed; the
 *  row carries many more (see recall.py) and they pass through untouched. */
export interface RecallLogRow {
  /** ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`). */
  ts?: string;
  directive_count?: number | null;
  directives_omitted?: number | null;
  directive_ids?: string[] | null;
  [k: string]: unknown;
}

/** Absolute path to an agent's recall_log.jsonl. */
export function recallLogPath(agentsDir: string, agent: string): string {
  return join(
    agentsDir,
    agent,
    ".claude",
    "plugins",
    "data",
    "hindsight-memory-inline",
    "state",
    "recall_log.jsonl",
  );
}

export interface ReadRecallLogOptions {
  /** Root agents dir. Defaults to `~/.switchroom/agents`. */
  agentsDir?: string;
  /** Return only the last N rows (the "tail"). Omit for all rows. */
  tail?: number;
}

/**
 * Read + parse an agent's recall_log.jsonl. Tolerant: a blank or malformed
 * line is skipped, not thrown on (the log is append-only and the last line can
 * be a partial write). Missing file ⇒ empty array. Rows come back in file
 * order (oldest first); `tail` slices the most-recent N.
 */
export function readRecallLog(agent: string, opts: ReadRecallLogOptions = {}): RecallLogRow[] {
  const agentsDir = opts.agentsDir ?? join(homedir(), ".switchroom", "agents");
  const path = recallLogPath(agentsDir, agent);
  if (!existsSync(path)) return [];
  const rows: RecallLogRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed) as RecallLogRow);
    } catch {
      // partial / corrupt line — skip.
    }
  }
  return typeof opts.tail === "number" ? rows.slice(-opts.tail) : rows;
}

function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface InjectionSummary {
  rowCount: number;
  /** Peak `directive_count` seen across the window. */
  maxDirectiveCount: number;
  /** `directive_count` on the most-recent row (null when no rows). */
  lastDirectiveCount: number | null;
  /** Union of every id that appeared in any row's `directive_ids`. */
  everInjectedIds: string[];
  /** Peak `directives_omitted` — >0 means the cap was dropping real rules. */
  maxDirectivesOmitted: number;
}

/** Summarize the directive-injection signal over a window of rows. */
export function summarizeInjection(rows: readonly RecallLogRow[]): InjectionSummary {
  const ids = new Set<string>();
  let maxCount = 0;
  let maxOmitted = 0;
  for (const r of rows) {
    maxCount = Math.max(maxCount, num(r.directive_count));
    maxOmitted = Math.max(maxOmitted, num(r.directives_omitted));
    for (const id of r.directive_ids ?? []) ids.add(id);
  }
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  return {
    rowCount: rows.length,
    maxDirectiveCount: maxCount,
    lastDirectiveCount: last ? num(last.directive_count) : null,
    everInjectedIds: [...ids],
    maxDirectivesOmitted: maxOmitted,
  };
}

export interface DirectiveInjectionDelta {
  baseline: InjectionSummary;
  postflip: InjectionSummary;
  /** Drop in peak injected-directive volume (baseline − postflip). Positive is
   *  the expected direction: the flip stopped injecting directives. */
  volumeDelta: number;
  /** True when the postflip window injected ZERO directives — the flip's
   *  success condition on the recall_log side. */
  postflipFullySuppressed: boolean;
  /** Ids still injected postflip (should be empty after a real flip). */
  residualIds: string[];
}

/**
 * Compare a baseline window (before the flip) against a postflip window and
 * report the directive-injection-volume delta. `postflipFullySuppressed` is
 * the gate's success condition: after `inject_directives:false`, no directive
 * is injected, so postflip `maxDirectiveCount` is 0 and `residualIds` empty.
 *
 * This is DETERMINISTIC and pure — the caller supplies the two windows
 * (typically `readRecallLog(...).slice()` around the flip timestamp); this does
 * no IO of its own.
 */
export function directiveInjectionDelta(
  baselineRows: readonly RecallLogRow[],
  postflipRows: readonly RecallLogRow[],
): DirectiveInjectionDelta {
  const baseline = summarizeInjection(baselineRows);
  const postflip = summarizeInjection(postflipRows);
  return {
    baseline,
    postflip,
    volumeDelta: baseline.maxDirectiveCount - postflip.maxDirectiveCount,
    postflipFullySuppressed: postflip.maxDirectiveCount === 0 && postflip.everInjectedIds.length === 0,
    residualIds: postflip.everInjectedIds,
  };
}

/** Split a single row stream into baseline/postflip windows at a flip
 *  timestamp (ISO string). Rows with `ts < flipTs` are baseline; `ts >=
 *  flipTs` are postflip. A row missing `ts` is treated as baseline (it
 *  predates the instrumented flip). Convenience over hand-slicing. */
export function partitionByFlip(
  rows: readonly RecallLogRow[],
  flipTs: string,
): { baseline: RecallLogRow[]; postflip: RecallLogRow[] } {
  const flipMs = Date.parse(flipTs);
  const baseline: RecallLogRow[] = [];
  const postflip: RecallLogRow[] = [];
  for (const r of rows) {
    const t = r.ts ? Date.parse(r.ts) : NaN;
    if (Number.isNaN(t) || Number.isNaN(flipMs) || t < flipMs) baseline.push(r);
    else postflip.push(r);
  }
  return { baseline, postflip };
}
