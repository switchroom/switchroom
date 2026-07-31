/**
 * Compaction-in-flight marker (#4058 — spurious 300s silence-fallback fire
 * during mid-turn auto-compaction).
 *
 * The blind spot this closes: when Claude Code hits mid-turn auto-compaction
 * (the session ran out of context and spends minutes summarizing), the model
 * emits ZERO output and runs ZERO tools — the gateway sees pure silence, so
 * the silence-poke 300s framework fallback fired on a perfectly healthy turn:
 * a spurious "⚠️ no output for 5 min — the framework ended that stalled turn"
 * card plus an obligation re-present, right before the turn completed
 * normally. Observed live: ~1m50s of tools then ~3m25s compacting = 304s of
 * "silence" → false fire.
 *
 * The signal problem: the transcript JSONL carries a compaction record ONLY
 * at the END (`{"type":"system","subtype":"compact_boundary",...}` — it
 * embeds the compaction's own durationMs, so it cannot exist before the
 * compaction finishes). Nothing observable lands at the START from the
 * stream. The START therefore comes from Claude Code's PreCompact hook
 * (`hooks/compaction-marker-precompact.mjs`), which writes
 * `<STATE_DIR>/compaction-in-flight.json` the moment compaction begins —
 * the same sidecar-file pattern as `turn-active-marker.ts` and the
 * tool-label sidecar (#783).
 *
 * Consumers:
 *   - `liveness-wiring.ts` wires `isCompactionInFlight` into the silence-poke
 *     deps: marker present AND younger than the fallback hard ceiling ⇒ the
 *     300s fallback is DEFERRED via the exact same `underCeiling` mechanism
 *     as the #1292/#3519 in-flight-tool defers — a genuinely-wedged
 *     compaction still unwedges once silence crosses `fallbackHardCeiling`.
 *   - `silence-poke-session-event.ts` removes the marker on the
 *     `compact_boundary` session event (the deterministic END) and counts
 *     the boundary as production, so the resumed turn gets a fresh 300s
 *     window instead of firing on the very next tick.
 *
 * Staleness is double-bounded: the reader treats an old marker as absent
 * (age bound supplied by the caller — the hard ceiling), so a marker leaked
 * by a crash between compaction start and boundary can never defer a future
 * genuine wedge for more than one ceiling window.
 *
 * Pure file I/O; clock injectable for tests; never throws.
 */

import { statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const COMPACTION_MARKER_FILE = 'compaction-in-flight.json'

/**
 * The gateway's state dir — same resolution as gateway.ts (`STATE_DIR`).
 * Exported so `silence-poke-session-event.ts` (which is handed no stateDir)
 * can clear the marker without widening its call signature.
 */
export function resolveTelegramStateDir(): string {
  return process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
}

/**
 * Age (ms) of the compaction marker's mtime, or null when absent/unstattable.
 * The PreCompact hook (re)writes the file at compaction start, so a small age
 * means a compaction began recently and may still be running. Never throws.
 */
export function readCompactionMarkerAgeMs(stateDir: string, now?: number): number | null {
  try {
    const st = statSync(join(stateDir, COMPACTION_MARKER_FILE))
    return (now ?? Date.now()) - st.mtimeMs
  } catch {
    return null // ENOENT / unstattable → no compaction in flight
  }
}

/**
 * Remove the marker — called on the `compact_boundary` session event (the
 * compaction's deterministic END record in the transcript). Idempotent;
 * ENOENT and any other unlink failure are swallowed (the age bound in the
 * reader is the correctness backstop, removal is the fast path).
 */
export function removeCompactionMarker(stateDir: string): void {
  try {
    unlinkSync(join(stateDir, COMPACTION_MARKER_FILE))
  } catch {
    // best-effort — staleness bound in readCompactionMarkerAgeMs self-heals
  }
}
