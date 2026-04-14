/**
 * Detect whether an agent is currently mid-turn (has active tool calls,
 * running sub-agents, or a session transcript that is still being
 * appended to).
 *
 * Signals used (any one positive ⇒ busy):
 *   1. `<agentDir>/.claude/tasks/<session>/*.json` — per-session task
 *      files written by Claude Code for each TodoWrite/Task-tool record.
 *      If any file in any session dir has mtime within the recency
 *      window, the agent is actively writing task state.
 *   2. `<agentDir>/.claude/projects/<slug>/**\/*.jsonl` — the canonical
 *      session transcript. Appended to as the model streams. Recent
 *      mtime = the main Claude process is mid-turn.
 *   3. `<agentDir>/.claude/projects/<slug>/<session>/subagents/*.jsonl`
 *      — each running Task-tool sub-agent streams its own transcript
 *      here. We also surface the count for user-facing summaries.
 *
 * The heuristic is intentionally simple — a 30-second "recent" window
 * is enough to catch the case that matters (an in-progress turn) while
 * tolerating the gaps between tool calls. Tighter windows produce
 * false negatives during long model thinking pauses; looser windows
 * would block legitimate restarts after the agent has truly gone idle.
 */

import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface InFlightActivity {
  /** True iff any tracked file was modified within the recency window. */
  busy: boolean;
  /** Number of distinct task directories with recent activity. */
  activeSessions: number;
  /** Number of running sub-agent transcripts with recent activity. */
  activeSubagents: number;
  /** Most-recent mtime (ms since epoch) across all scanned files, or 0. */
  lastActivityMs: number;
  /** Human-readable fragments describing what is active (for prompting). */
  details: string[];
}

export interface DetectOptions {
  /** Directory of the agent (e.g. ~/.switchroom/agents/<name>). */
  agentDir: string;
  /** Window in ms — files newer than `now - recencyMs` count as active. */
  recencyMs?: number;
  /** Injected clock — for tests. */
  now?: () => number;
}

const DEFAULT_RECENCY_MS = 30_000;

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function isRecent(mtimeMs: number, cutoff: number): boolean {
  return mtimeMs > 0 && mtimeMs >= cutoff;
}

/**
 * Recursively find `.jsonl` files under `root`, up to `maxDepth` levels
 * deep. We don't need full recursion — Claude Code's layout is known
 * (projects/<slug>/[subagents/]<file>.jsonl) so depth 3 is plenty.
 */
function collectJsonl(root: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    for (const entry of safeReaddir(dir)) {
      const full = resolve(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  return out;
}

export function detectInFlight(opts: DetectOptions): InFlightActivity {
  const recencyMs = opts.recencyMs ?? DEFAULT_RECENCY_MS;
  const now = (opts.now ?? Date.now)();
  const cutoff = now - recencyMs;

  const result: InFlightActivity = {
    busy: false,
    activeSessions: 0,
    activeSubagents: 0,
    lastActivityMs: 0,
    details: [],
  };

  // --- Signal 1: task files under .claude/tasks/<session>/*.json
  const tasksRoot = resolve(opts.agentDir, ".claude", "tasks");
  for (const sessionId of safeReaddir(tasksRoot)) {
    const sessionDir = resolve(tasksRoot, sessionId);
    let sessionHasRecent = false;
    let newestSubject: string | null = null;
    let newestMtime = 0;
    for (const entry of safeReaddir(sessionDir)) {
      if (!entry.endsWith(".json")) continue;
      const mtime = safeMtimeMs(resolve(sessionDir, entry));
      if (mtime > result.lastActivityMs) result.lastActivityMs = mtime;
      if (isRecent(mtime, cutoff)) {
        sessionHasRecent = true;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          // Entry like "5.json" — keep as-is; subject is not parsed here
          // to keep detection IO-light. The caller can read the file
          // if it wants a prettier summary.
          newestSubject = entry;
        }
      }
    }
    if (sessionHasRecent) {
      result.activeSessions += 1;
      result.details.push(
        `session ${sessionId.slice(0, 8)} task ${newestSubject ?? "?"}`,
      );
    }
  }

  // --- Signals 2 & 3: transcript + sub-agent JSONL files
  const projectsRoot = resolve(opts.agentDir, ".claude", "projects");
  for (const slug of safeReaddir(projectsRoot)) {
    const slugDir = resolve(projectsRoot, slug);
    for (const jsonl of collectJsonl(slugDir, 4)) {
      const mtime = safeMtimeMs(jsonl);
      if (mtime > result.lastActivityMs) result.lastActivityMs = mtime;
      if (!isRecent(mtime, cutoff)) continue;
      if (jsonl.includes(`${require("node:path").sep}subagents${require("node:path").sep}`)) {
        result.activeSubagents += 1;
        const file = jsonl.split(require("node:path").sep).pop() ?? jsonl;
        result.details.push(`sub-agent ${file.replace(/\.jsonl$/, "")}`);
      } else {
        const file = jsonl.split(require("node:path").sep).pop() ?? jsonl;
        result.details.push(`main transcript ${file.replace(/\.jsonl$/, "").slice(0, 8)}`);
      }
    }
  }

  result.busy =
    result.activeSessions > 0 ||
    result.activeSubagents > 0 ||
    result.details.length > 0;

  return result;
}

/**
 * Poll `detectInFlight` until it reports idle, or `timeoutMs` elapses.
 * Resolves with the final activity snapshot. Caller decides whether
 * `busy` after timeout means abort or force-restart.
 */
export async function waitUntilIdle(
  opts: DetectOptions & {
    timeoutMs: number;
    pollMs?: number;
    /** Injected sleep — for tests. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<InFlightActivity> {
  const pollMs = opts.pollMs ?? 2_000;
  const clock = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = clock() + opts.timeoutMs;
  let last = detectInFlight(opts);
  while (last.busy && clock() < deadline) {
    await sleep(pollMs);
    last = detectInFlight(opts);
  }
  return last;
}

/**
 * Decide whether a restart should proceed given in-flight activity and
 * user flags. Pure — no IO. Extracted for unit-testing the decision
 * tree without spawning a CLI subprocess.
 */
export type RestartDecision =
  | { kind: "proceed" }
  | { kind: "abort"; reason: string }
  | { kind: "wait" }
  | { kind: "prompt" };

export function decideRestart(input: {
  force: boolean;
  wait: boolean;
  activity: InFlightActivity;
}): RestartDecision {
  if (input.force) return { kind: "proceed" };
  if (!input.activity.busy) return { kind: "proceed" };
  if (input.wait) return { kind: "wait" };
  return { kind: "prompt" };
}
