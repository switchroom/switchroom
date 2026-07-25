/**
 * Durable state for the hindsight watchdog: the rolling sample window plus
 * the per-signal hysteresis counters.
 *
 * Lives at `~/.switchroom/hindsight-watch/state.json` (tmp+rename, 0600).
 * Two properties it must hold:
 *
 *  - A torn/absent/garbage file degrades to an EMPTY state, never a throw.
 *    The watchdog then reports `no-data` for a window and re-baselines —
 *    which is honest, and strictly better than a crashed cron.
 *  - A write failure is NOT swallowed: `saveState` throws, and the caller
 *    turns that into a loud non-zero exit. A watchdog that silently cannot
 *    persist its window would re-fire the same alert forever (or never
 *    accumulate the breaches to fire at all).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { MAX_SAMPLE_AGE_MS, RING_MAX } from "./thresholds.js";
import { emptyState, type Sample, type WatchState } from "./types.js";

/** Default state-file path, honouring `SWITCHROOM_HOME` like the rest of the CLI. */
export function defaultStatePath(
  home: string = process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(),
): string {
  return resolve(home, ".switchroom", "hindsight-watch", "state.json");
}

/** Read state, degrading to empty on absent/torn/foreign-version files. */
export function loadState(path: string): WatchState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyState();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyState();
  const s = parsed as Partial<WatchState>;
  if (s.v !== 1 || !Array.isArray(s.ring)) return emptyState();
  const ring = s.ring.filter(isSample).slice(-RING_MAX);
  const signals = typeof s.signals === "object" && s.signals !== null ? s.signals : {};
  return { v: 1, ring, signals };
}

function isSample(x: unknown): x is Sample {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Partial<Sample>;
  return (
    typeof s.ts === "number" &&
    Number.isFinite(s.ts) &&
    typeof s.retainOk === "number" &&
    typeof s.retainFail === "number" &&
    typeof s.pending === "number" &&
    typeof s.dead === "number" &&
    typeof s.restartCount === "number" &&
    typeof s.startedAt === "string" &&
    typeof s.health === "string" &&
    typeof s.retainBuckets === "object" &&
    s.retainBuckets !== null
  );
}

/**
 * Append a sample, keeping the window at `RING_MAX` AND dropping anything
 * older than `MAX_SAMPLE_AGE_MS` relative to the new sample.
 *
 * The age prune is the guard against a stopped cron: without it, a watchdog
 * that was down for a day would come back and compute its first verdict
 * across a day-wide window (see `MAX_SAMPLE_AGE_MS`). Samples dated in the
 * future (clock skew / a restored backup) are dropped for the same reason.
 */
export function pushSample(state: WatchState, sample: Sample): WatchState {
  const floor = sample.ts - MAX_SAMPLE_AGE_MS;
  const kept = state.ring.filter((s) => s.ts >= floor && s.ts <= sample.ts);
  return { ...state, ring: [...kept, sample].slice(-RING_MAX) };
}

/** Atomic write. Throws on failure — the caller must exit loudly. */
export function saveState(path: string, state: WatchState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // pid-scoped tmp name: two concurrent ticks (a hand-run alongside the cron)
  // must not rename each other's half-written file into place.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
