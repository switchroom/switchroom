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
