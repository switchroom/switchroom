/**
 * Buzz sidecar liveness beacon — a content-free heartbeat file the stats
 * reporter refreshes each tick and `switchroom doctor` reads to report whether
 * the sidecar is live.
 *
 * WHERE it lands, and why the operator can read it: the sidecar writes under
 * its state dir (`TELEGRAM_STATE_DIR`, `/state/agent/telegram` in the
 * container). The compose bind mounts the agent-home root `/state/agent` at
 * `~/.switchroom/agents/<name>/` (src/agents/compose.ts), so the in-container
 * `<stateDir>/buzz/<file>` surfaces operator-side at
 * `~/.switchroom/agents/<name>/telegram/buzz/<file>` — the same
 * agent-writes / operator-reads shape the notion & m365 launcher heartbeats
 * use (doctor-notion.ts, doctor-microsoft.ts).
 *
 * The beacon carries ONLY counters + booleans + timestamps — never message
 * content and never a secret (the nsec is broker-fetched in-process and never
 * leaves index.ts).
 */

import {
  mkdirSync as realMkdirSync,
  writeFileSync as realWriteFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { BuzzPipelineSummary } from "./stats.js";

/** State-dir-relative directory + filename for the beacon. The state dir the
 *  sidecar writes into (`TELEGRAM_STATE_DIR`) sits one level below the agent
 *  home root under the `telegram` subdir — see AGENT_STATE_SUBDIR. */
export const BUZZ_HEARTBEAT_SUBDIR = "buzz";
export const BUZZ_HEARTBEAT_FILE = "buzz-sidecar.heartbeat.json";
/** Agent-home-relative name of the sidecar's state dir (TELEGRAM_STATE_DIR is
 *  `{agentDir}/telegram` — profiles/_base/start.sh.hbs). Doctor joins through
 *  this to reach the beacon from the operator-side agent home. */
export const AGENT_STATE_SUBDIR = "telegram";

// ────────────────────────────────────────────────────────────────────────
// Heartbeat timing contract (single source of truth — #4302)
//
// The sidecar refreshes the beacon every `BUZZ_HEARTBEAT_INTERVAL_MS`; doctor
// flags a beacon older than `BUZZ_HEARTBEAT_STALE_MS` as stale. Those two knobs
// were decoupled: the beat interval is env-tunable (BUZZ_STATS_INTERVAL_MS in
// index.ts) while the stale threshold was a fixed 180s, so setting the interval
// above ~180s made every healthy sidecar false-red as stale. They now share
// this module: the stale threshold is DERIVED (interval × tolerance) and the
// runtime interval is CLAMPED so it can never exceed what the threshold
// tolerates — a deterministic coupling rather than two hand-synced numbers.
// ────────────────────────────────────────────────────────────────────────

/** Default beat cadence: the sidecar refreshes the beacon this often. */
export const BUZZ_HEARTBEAT_INTERVAL_MS = 60 * 1000;
/** Missed-beat tolerance before doctor flags stale — 3 tolerates a couple of
 *  dropped beats before warning. */
export const BUZZ_HEARTBEAT_STALE_MULTIPLIER = 3;
/** A beacon older than this reads as stale. DERIVED from the beat interval so
 *  the two can't drift apart (interval × missed-beat tolerance). */
export const BUZZ_HEARTBEAT_STALE_MS =
  BUZZ_HEARTBEAT_INTERVAL_MS * BUZZ_HEARTBEAT_STALE_MULTIPLIER;
/** The slowest the beat interval may be configured without the sidecar
 *  false-reddening doctor: keeping interval ≤ stale ÷ tolerance guarantees the
 *  stale window always spans at least `BUZZ_HEARTBEAT_STALE_MULTIPLIER` beats. */
export const BUZZ_HEARTBEAT_MAX_INTERVAL_MS =
  BUZZ_HEARTBEAT_STALE_MS / BUZZ_HEARTBEAT_STALE_MULTIPLIER;

/**
 * Resolve the sidecar's stats/heartbeat beat interval from its raw env value
 * (BUZZ_STATS_INTERVAL_MS), clamped so it can never outrun doctor's stale
 * threshold (#4302). A non-numeric / non-positive value falls back to the
 * default; an over-large value is capped at `BUZZ_HEARTBEAT_MAX_INTERVAL_MS` so
 * a healthy sidecar always beats inside the stale window. Faster-than-default
 * intervals pass through unchanged.
 */
export function resolveStatsIntervalMs(raw: string | undefined): number {
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) {
    return BUZZ_HEARTBEAT_INTERVAL_MS;
  }
  return Math.min(requested, BUZZ_HEARTBEAT_MAX_INTERVAL_MS);
}

/** Content-free liveness + stats snapshot. */
export interface BuzzHeartbeat {
  /** Schema version — bump on shape change so an old reader can reject cleanly. */
  v: 1;
  /** The agent this beacon belongs to. */
  agent: string;
  /** ms epoch this beat was written. */
  ts: number;
  /** ms epoch the sidecar booted (uptime = ts - bootTs). */
  bootTs: number;
  /** Relay subscription live at write time. */
  subscribed: boolean;
  /** The derived pipeline summary at write time. */
  stats: BuzzPipelineSummary;
}

/** In-container path the sidecar writes: `<stateDir>/buzz/<file>`. */
export function buzzHeartbeatStatePath(stateDir: string): string {
  return join(stateDir, BUZZ_HEARTBEAT_SUBDIR, BUZZ_HEARTBEAT_FILE);
}

/** Operator-side path doctor reads:
 *  `<agentHomeDir>/telegram/buzz/<file>`. */
export function buzzHeartbeatOperatorPath(agentHomeDir: string): string {
  return join(agentHomeDir, AGENT_STATE_SUBDIR, BUZZ_HEARTBEAT_SUBDIR, BUZZ_HEARTBEAT_FILE);
}

export interface HeartbeatWriteIo {
  mkdirSync?: (path: string, opts: { recursive: true }) => void;
  writeFileSync?: (path: string, data: string) => void;
}

/**
 * Write the beacon, creating its directory if needed. Overwrites in place
 * (never tmp+rename) so the file keeps the sidecar's agent-uid ownership rather
 * than silently re-owning on every beat. Best-effort by contract — the caller
 * (the stats reporter) swallows a throw so a heartbeat write can never disturb
 * the pipeline.
 */
export function writeBuzzHeartbeat(
  path: string,
  hb: BuzzHeartbeat,
  io: HeartbeatWriteIo = {},
): void {
  const mkdir = io.mkdirSync ?? realMkdirSync;
  const write = io.writeFileSync ?? realWriteFileSync;
  mkdir(dirname(path), { recursive: true });
  write(path, JSON.stringify(hb));
}

/** Every numeric field of BuzzPipelineSummary — the exhaustive key list the
 *  stats guard below validates. Kept in sync with the interface in stats.ts;
 *  a `Record<keyof BuzzPipelineSummary, true>` forces a compile error here if a
 *  field is added or renamed there without updating this guard. */
const BUZZ_SUMMARY_FIELDS = [
  "received",
  "injected",
  "duplicate",
  "queued",
  "injectFailed",
  "droppedByKind",
  "channelOff",
  "authFailures",
  "mirrorOk",
  "mirrorFailed",
] as const;
const _BUZZ_SUMMARY_FIELDS_EXHAUSTIVE: Record<keyof BuzzPipelineSummary, true> = {
  received: true,
  injected: true,
  duplicate: true,
  queued: true,
  injectFailed: true,
  droppedByKind: true,
  channelOff: true,
  authFailures: true,
  mirrorOk: true,
  mirrorFailed: true,
};
void _BUZZ_SUMMARY_FIELDS_EXHAUSTIVE;

/**
 * Parse + shape-guard a beacon's text. Returns null on junk / wrong version.
 *
 * The beacon file lives in the agent's own uid-writable state dir, and this
 * fleet treats agents as prompt-injectable — so a compromised agent could write
 * a `stats` object whose fields carry attacker-controlled strings (including
 * ANSI escapes) that doctor would then interpolate into an operator-facing
 * terminal row. Every BuzzPipelineSummary field is therefore validated as a
 * FINITE number; a missing or non-numeric field makes the whole beacon
 * malformed (→ null), same as any other failed envelope check.
 */
export function parseBuzzHeartbeat(text: string): BuzzHeartbeat | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw == null || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  if (h.v !== 1) return null;
  if (typeof h.agent !== "string") return null;
  if (typeof h.ts !== "number") return null;
  if (typeof h.bootTs !== "number") return null;
  if (typeof h.subscribed !== "boolean") return null;
  if (h.stats == null || typeof h.stats !== "object") return null;
  const stats = h.stats as Record<string, unknown>;
  for (const field of BUZZ_SUMMARY_FIELDS) {
    if (!Number.isFinite(stats[field])) return null;
  }
  return raw as BuzzHeartbeat;
}
