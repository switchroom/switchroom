/**
 * Agent self-improvement — T1 auto-apply rate limit (RFC: ≤3
 * auto-applies/day). A tiny per-agent counter file under the state dir,
 * keyed by UTC day. Distinct from the validator-hook/git audit (which is
 * the change-content audit/rollback) — this is purely the
 * how-many-today budget so a runaway can't churn the skill dir.
 *
 *   <stateDir>/self-improve-applies.jsonl — one line per auto-apply,
 *   {ts, day} — append-only; the day-bucket count is derived on read.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { resolveSelfImproveConfig } from "./config.js";

export const APPLIES_FILE = "self-improve-applies.jsonl";

interface ApplyRecord {
  ts: number;
  day: string; // YYYY-MM-DD (UTC)
}

function appliesPath(stateDir: string): string {
  return join(stateDir, APPLIES_FILE);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Count auto-applies recorded for the given UTC day. */
export function appliesToday(stateDir: string, now: () => number = Date.now): number {
  const p = appliesPath(stateDir);
  if (!existsSync(p)) return 0;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return 0;
  }
  const today = utcDay(now());
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ApplyRecord;
      if (rec.day === today) count += 1;
    } catch {
      /* skip */
    }
  }
  return count;
}

/** True iff another T1 auto-apply is within today's budget. */
export function canAutoApply(
  stateDir: string,
  now: () => number = Date.now,
  cap = resolveSelfImproveConfig().maxAutoAppliesPerDay,
): boolean {
  return appliesToday(stateDir, now) < cap;
}

/** Record one auto-apply. Call only AFTER an edit actually lands. */
export function recordAutoApply(stateDir: string, now: () => number = Date.now): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  }
  const ms = now();
  const fd = openSync(appliesPath(stateDir), "a");
  try {
    writeSync(fd, JSON.stringify({ ts: ms, day: utcDay(ms) } as ApplyRecord) + "\n");
  } finally {
    closeSync(fd);
  }
}
