/**
 * Agent self-improvement — the pending-suggestions QUEUE (RFC §"Promotion
 * store: there isn't one"). The ONLY new state slice 1 introduces.
 *
 * T2/T3 candidates are not auto-applied; they're appended here as one
 * line of JSON per suggestion, under the agent's state dir. Agent-
 * agnostic on purpose: a later slice surfaces these as Telegram one-tap
 * cards / Linear issues, but the backing store is this simple file so
 * the feature ships without a broker.
 *
 * Storage layout (mirrors src/issues/store.ts):
 *   <stateDir>/self-improve-pending.jsonl  — append-only, one JSON/line.
 *   <stateDir>/self-improve-pending.lock   — flock for the read cap.
 *
 * Append-only (vs the issues sink's collapse-on-write) because a
 * suggestion is an event the operator actions out-of-band; we keep the
 * full proposal history and mark entries actioned in place is NOT needed
 * for slice 1 (surfacing is deferred). We DO enforce the outstanding-cap
 * so the queue can't grow without bound (RFC: ≤5 outstanding).
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
import { randomUUID } from "node:crypto";

import type { Tier } from "./types.js";
import { resolveSelfImproveConfig } from "./config.js";

export const PENDING_FILE = "self-improve-pending.jsonl";

export interface PendingSuggestion {
  /** Stable id (for a later one-tap surface to reference). */
  id: string;
  /** ISO timestamp when proposed. */
  created_at: string;
  /** T2 or T3 — T0/T1 never reach the queue. */
  tier: Exclude<Tier, "T0" | "T1">;
  /** The lesson in one line. */
  lesson: string;
  /** The smallest change that would make the lesson bind. */
  proposed_change: string;
  /** Why the router chose this tier (operator-facing). */
  tier_reason: string;
  /** Target skill slug, when applicable. */
  skill_slug?: string;
  /** The signal kind(s) that triggered the review. */
  triggered_by: string[];
  /** Skill-file size (bytes) BEFORE the proposed edit. Present when the
   *  downgrade was the T1 net-growth cap — lets the one-tap card show the
   *  before/after byte counts. Omitted for other downgrade reasons. */
  bytes_before?: number;
  /** Projected skill-file size (bytes) AFTER the proposed edit. */
  bytes_after?: number;
  /** Set true once the operator actions it (reserved for a later slice). */
  actioned?: boolean;
}

function pendingPath(stateDir: string): string {
  return join(stateDir, PENDING_FILE);
}

/** Read every line; skip malformed (best-effort, like the issues sink). */
export function readPending(stateDir: string): PendingSuggestion[] {
  const p = pendingPath(stateDir);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  const out: PendingSuggestion[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PendingSuggestion;
      if (parsed && typeof parsed.id === "string" && parsed.tier) {
        out.push(parsed);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Count outstanding (not-yet-actioned) suggestions. */
export function outstandingCount(stateDir: string): number {
  return readPending(stateDir).filter((s) => s.actioned !== true).length;
}

export type EnqueueResult =
  | { ok: true; suggestion: PendingSuggestion }
  | { ok: false; reason: "cap-reached"; outstanding: number; cap: number };

/**
 * Append a suggestion, enforcing the outstanding cap. Returns the stored
 * record (with id + timestamp) or a cap-reached refusal so the caller
 * can degrade gracefully (the gate logs "queue full, not queueing"
 * rather than dropping silently).
 */
export function enqueuePending(
  stateDir: string,
  input: Omit<PendingSuggestion, "id" | "created_at" | "actioned">,
  opts: { now?: () => number; cap?: number } = {},
): EnqueueResult {
  const cfg = resolveSelfImproveConfig();
  const cap = opts.cap ?? cfg.maxOutstandingPending;
  const now = opts.now ?? Date.now;

  ensureDir(stateDir);

  const outstanding = outstandingCount(stateDir);
  if (outstanding >= cap) {
    return { ok: false, reason: "cap-reached", outstanding, cap };
  }

  const suggestion: PendingSuggestion = {
    id: randomUUID(),
    created_at: new Date(now()).toISOString(),
    ...input,
  };

  // Atomic single-line append via O_APPEND. One writev of a complete
  // line is atomic for PIPE_BUF-sized writes on local fs; a suggestion
  // line is well under that, and even a torn append only corrupts its
  // own line (readPending skips malformed lines).
  const fd = openSync(pendingPath(stateDir), "a");
  try {
    writeSync(fd, JSON.stringify(suggestion) + "\n");
  } finally {
    closeSync(fd);
  }
  return { ok: true, suggestion };
}

function ensureDir(stateDir: string): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  }
}
