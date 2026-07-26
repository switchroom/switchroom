/**
 * Minimal size-cap rotation for the turn-record JSONL (`turns.jsonl`).
 *
 * emitTurnRecord appends one line per turn forever with no rotation, so the
 * file grows unbounded on a long-lived agent. This keeps at most one rotated
 * generation: when the live file exceeds the cap, it is renamed to
 * `<path>.1` (overwriting any prior generation) and a fresh live file starts.
 * Bounded disk: ≤ 2× the cap.
 *
 * Pure of the append itself — `maybeRotate` only decides + performs the rename.
 * Best-effort: the fs hooks are injected so it's unit-testable and so a rotate
 * failure can be swallowed by the caller (never break turn teardown).
 */
export const TURNS_JSONL_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB

/** The agent state dir inside a switchroom agent container (bind-mounted to
 *  `~/.switchroom/agents/<name>/` on the host). */
export const DEFAULT_AGENT_STATE_DIR = '/state/agent'

/**
 * Resolve the turn-record path from the environment.
 *
 * `emitTurnRecord` used to hard-code `/state/agent/turns.jsonl`, ignoring
 * `SWITCHROOM_AGENT_STATE_DIR` — which the sibling context-occupancy writer a
 * few lines above it in `gateway.ts` already honours. Inside an agent container
 * that path is the bind-mounted PRODUCTION `~/.switchroom/agents/<name>/
 * turns.jsonl`, so any test that drove the real turn-end funnel while running
 * in an agent container appended its synthetic rows straight into that agent's
 * production turn record — even when the test had pointed every state-dir env
 * var at a tmpdir. Those rows are then read back by the fleet-health L0 sensor
 * (`src/fleet-health/scan.ts`) as that agent's real production turns.
 *
 * Honouring the env var is the root-cause fix: production containers do not set
 * it (default unchanged), and a test that isolates its state dir now isolates
 * its turn records with it.
 */
export function resolveTurnsJsonlPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = env.SWITCHROOM_AGENT_STATE_DIR?.trim()
  const base = dir != null && dir !== '' ? dir.replace(/\/+$/, '') : DEFAULT_AGENT_STATE_DIR
  return `${base}/turns.jsonl`
}

export interface RotateFs {
  statSize: (path: string) => number | undefined // undefined ⇒ file absent
  rename: (from: string, to: string) => void
}

/**
 * Rotate `path` → `path.1` if it is at/over `maxBytes`. Returns true if a
 * rotation happened. Absent file (statSize undefined) ⇒ no rotation.
 */
export function maybeRotate(path: string, fs: RotateFs, maxBytes = TURNS_JSONL_MAX_BYTES): boolean {
  const size = fs.statSize(path)
  if (size == null || size < maxBytes) return false
  fs.rename(path, `${path}.1`)
  return true
}
