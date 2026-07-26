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
 * Resolve the agent state dir from the environment — the ONE reader for
 * `SWITCHROOM_AGENT_STATE_DIR` that every writer into that dir must use.
 *
 * Normalisation is the point. The gateway had two writers into this dir a few
 * lines apart (the context-occupancy snapshot and the turn record) reading the
 * env var with two different expressions: a bare
 * `process.env.SWITCHROOM_AGENT_STATE_DIR ?? '/state/agent'` and this one. For
 * a value like `"/x/ "` or `"/x/"` those resolve to DIFFERENT directories, so
 * the two artifacts of the same turn would land in two places — exactly the
 * kind of split-brain state that made the turn-record leak hard to see. Both
 * call sites now share this function.
 *
 * Blank/whitespace-only is treated as unset (a compose file that renders an
 * empty value must not send state to `/turns.jsonl` at the filesystem root),
 * and a trailing slash is stripped so joins never double it.
 */
export function resolveAgentStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = env.SWITCHROOM_AGENT_STATE_DIR?.trim()
  return dir != null && dir !== '' ? dir.replace(/\/+$/, '') : DEFAULT_AGENT_STATE_DIR
}

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
 *
 * ── Operator coupling: setting this var RELOCATES the fleet-health input ──
 *
 * `agent.env` in `switchroom.yaml` is propagated verbatim into the container
 * (`src/agents/compose.ts` `userEnv`), so an operator CAN set
 * `SWITCHROOM_AGENT_STATE_DIR` on an agent. If they point it anywhere other
 * than the bind-mounted `/state/agent`, this file moves with it — but the
 * fleet-health L0 sensor reads `~/.switchroom/agents/<name>/turns.jsonl` at a
 * FIXED host path (`src/fleet-health/scan.ts`). That agent then presents no
 * turns artifact, lands in the scan's `skipped[]`, and goes quiet on the health
 * board: no findings, no ledger entries, indistinguishable from a healthy
 * agent. Do not set this var in production `agent.env`; it exists so tests (and
 * the vitest `agent-state-dir-guard` setup file) can isolate agent state into a
 * tmpdir.
 */
export function resolveTurnsJsonlPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return `${resolveAgentStateDir(env)}/turns.jsonl`
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
