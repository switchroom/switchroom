/**
 * Gateway liveness heartbeat (duplicate-message fix, single-writer election).
 *
 * The silent-end Stop hook's single-writer election (see
 * `hooks/silent-end-scan.mjs` `decideStopHookDisposition`) may ALLOW a turn to
 * end without re-prompting — handing delivery of the model's trailing prose to
 * the gateway's turn-end flush / captured-prose bridge. That hand-off is only
 * safe when the gateway is actually alive and WILL run its `turn_end` handler.
 * Allowing into a DEAD gateway would drop the answer entirely — the one outcome
 * worse than a duplicate.
 *
 * Existing markers under `TELEGRAM_STATE_DIR` (`turn-active.json`) only exist
 * DURING a turn and are removed at turn_complete, so they can't prove
 * "gateway alive and ready to process the NEXT turn_end". This adds a minimal,
 * always-on gateway heartbeat: the gateway process touches
 * `<STATE_DIR>/gateway-heartbeat` on a fixed interval while it lives. The Stop
 * hook stats its mtime and requires it fresh before electing an allow.
 *
 * Pure file I/O, best-effort — the heartbeat is a safety gate, never a
 * correctness dependency of the turn path. A write failure just means the hook
 * conservatively BLOCKS (re-prompt), which is the safe direction.
 */

import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { mkdirStateSync, writeStateFileSync } from '../../src/util/state-owner.js'

/** Filename under `TELEGRAM_STATE_DIR`. MUST stay in sync with
 * `GATEWAY_HEARTBEAT_FILE` in `hooks/silent-end-scan.mjs`. */
export const GATEWAY_HEARTBEAT_FILE = 'gateway-heartbeat'

/** How often the gateway refreshes the heartbeat while alive. The hook's
 * freshness bound (`GATEWAY_HEARTBEAT_FRESH_MS`, 60s) is 4× this — tolerant of
 * event-loop / scheduler jitter, tight enough that a crashed gateway is
 * detected within one turn's election window. */
export const GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Write / refresh the heartbeat file's mtime. Creates the file (and the state
 * dir) on first call, then bumps mtime via `utimesSync` on subsequent calls.
 * Never throws.
 */
export function touchGatewayHeartbeat(stateDir: string): void {
  const path = join(stateDir, GATEWAY_HEARTBEAT_FILE)
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    // File doesn't exist yet (or unstattable) — create it.
    try {
      mkdirStateSync(stateDir, { recursive: true })
      writeStateFileSync(path, `${Date.now()}\n`, { mode: 0o600 })
    } catch {
      // Best-effort — a heartbeat write failure makes the hook BLOCK
      // (re-prompt), which is the safe direction.
    }
  }
}

/**
 * Start the periodic heartbeat. Returns the interval handle (unref'd so it
 * never keeps the process alive on its own). Touches once immediately so the
 * file exists before the first turn can end.
 */
export function startGatewayHeartbeat(
  stateDir: string,
  intervalMs: number = GATEWAY_HEARTBEAT_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  touchGatewayHeartbeat(stateDir)
  const timer = setInterval(() => touchGatewayHeartbeat(stateDir), intervalMs)
  timer.unref?.()
  return timer
}
