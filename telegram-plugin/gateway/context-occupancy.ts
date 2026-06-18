/**
 * Context-headroom snapshot (RFC reference/rfcs/context-headroom-surface.md).
 *
 * The gateway already computes working-context occupancy at the turn-end idle
 * gate for proactive-compaction (gateway.ts ~3000). This module turns that
 * value into a small on-disk snapshot the host surfaces (`switchroom status` /
 * `doctor` / web) read, so the operator can SEE each agent's headroom-to-
 * compaction — the predictability won by ENABLE_TOOL_SEARCH=true made visible.
 *
 * Pure + side-effect-light so it's unit-testable; the write is best-effort and
 * never throws (a missing snapshot reads as `unknown`, never an error).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Filename written under the agent's state dir. Shared with the host reader. */
export const CONTEXT_OCCUPANCY_FILENAME = "context-occupancy.json";

/** Occupancy ≥ this fraction of the cap → "tight" (compaction imminent). */
export const TIGHT_FRACTION = 0.8;

export type ContextState = "ok" | "tight" | "unknown";

export interface ContextOccupancy {
  /** Live working-context tokens (latest turn input + cache_read + cache_creation). */
  occupancy: number;
  /** session.max_context_tokens, or null when unset (native compaction only). */
  cap: number | null;
  /** cap - occupancy, or null when no cap. */
  headroom: number | null;
  /** occupancy / cap (0..1+), or null when no cap. */
  pct: number | null;
  /** ok / tight / unknown. `unknown` only when occupancy is unmeasurable. */
  state: ContextState;
  /** epoch ms (host/container clock) when computed. */
  computedAt: number;
}

/**
 * Build the snapshot from a measured occupancy + the resolved cap. Pure.
 *   - cap null → no ratio; state "ok" (occupancy known, just no ceiling set).
 *   - occupancy < 0 / NaN → "unknown".
 */
export function buildContextOccupancy(
  occupancy: number,
  cap: number | null | undefined,
  now: number,
): ContextOccupancy {
  if (!Number.isFinite(occupancy) || occupancy < 0) {
    return { occupancy: 0, cap: cap ?? null, headroom: null, pct: null, state: "unknown", computedAt: now };
  }
  const c = cap != null && cap > 0 ? cap : null;
  if (c == null) {
    return { occupancy, cap: null, headroom: null, pct: null, state: "ok", computedAt: now };
  }
  const pct = occupancy / c;
  return {
    occupancy,
    cap: c,
    headroom: c - occupancy,
    pct,
    state: pct >= TIGHT_FRACTION ? "tight" : "ok",
    computedAt: now,
  };
}

/**
 * Write `<stateDir>/context-occupancy.json`. Best-effort — callers wrap in
 * try/catch but this also swallows internally so a write failure never
 * disrupts the turn-end gate.
 */
export function writeContextOccupancySnapshot(
  stateDir: string,
  snapshot: ContextOccupancy,
  deps?: {
    mkdir?: (p: string, o: { recursive: true }) => void;
    writeFile?: (p: string, d: string) => void;
  },
): void {
  try {
    const path = join(stateDir, CONTEXT_OCCUPANCY_FILENAME);
    (deps?.mkdir ?? ((p, o) => mkdirSync(p, o)))(stateDir, { recursive: true });
    (deps?.writeFile ?? ((p, d) => writeFileSync(p, d)))(
      path,
      JSON.stringify(snapshot, null, 2) + "\n",
    );
  } catch {
    /* best-effort — never break the turn-end gate */
  }
}
