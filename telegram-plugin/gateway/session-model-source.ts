/**
 * Freshness-aware source of truth for the /status session model.
 *
 * Two independent signals report what model the live session is running:
 *
 *   - the TRANSCRIPT: `message.model` on each assistant line (session-tail's
 *     `model` event) — ground truth for the model that served the LAST API
 *     call, but only advances when a new assistant line lands;
 *   - the OVERRIDE: the in-memory `/model` switch record (#2982) — set the
 *     moment a switch is positively confirmed, ahead of any assistant line.
 *
 * Neither is unconditionally right. Preferring the transcript regresses the
 * idle-after-switch window (#2982's core fix): a native `/model` inject while
 * idle sets the override to the NEW model, but the transcript still holds the
 * OLD one until the next assistant line — /status would lie. Preferring the
 * override goes stale the other way (a relaunch carrier that never applied).
 *
 * The invariant is "prefer the NEWER observation": every write from either
 * source is stamped with a shared monotonic sequence, and `resolve()` returns
 * whichever was observed last. A fresh assistant line always reclaims the
 * transcript as the source; a confirmed switch always beats an older
 * transcript line. Pinned by tests/session-model-source.test.ts.
 */

export interface SessionModelResolution {
  /** The raw value from the winning source. Transcript entries are resolved
   *  model ids (`claude-opus-4-8`); override entries may be friendly labels
   *  ("Opus 4.8") or sr-* ids depending on the /model path that set them. */
  model: string
  source: 'transcript' | 'override'
}

export interface SessionModelSource {
  /** Record a transcript observation (an assistant line's `message.model`,
   *  already sentinel-filtered by the session-tail projection). */
  noteTranscriptModel(model: string): void
  /** Record an override set (a positively-confirmed /model switch), or clear
   *  it with null. Setting stamps a fresh sequence, so the override wins over
   *  every EARLIER transcript observation until a new assistant line lands. */
  setOverride(model: string | null): void
  /** Current override value (the #2982 in-memory record), independent of
   *  freshness — for callers that need the override itself (e.g. the model
   *  menu's "session" marker), not the /status resolution. */
  getOverride(): string | null
  /** The freshest observation across both sources, or null when neither has
   *  reported yet. */
  resolve(): SessionModelResolution | null
}

export function createSessionModelSource(): SessionModelSource {
  let seq = 0
  let transcript: { model: string; seq: number } | null = null
  let override: { model: string; seq: number } | null = null
  return {
    noteTranscriptModel(model: string): void {
      transcript = { model, seq: ++seq }
    },
    setOverride(model: string | null): void {
      override = model == null ? null : { model, seq: ++seq }
    },
    getOverride(): string | null {
      return override?.model ?? null
    },
    resolve(): SessionModelResolution | null {
      if (transcript == null && override == null) return null
      if (override == null) return { model: transcript!.model, source: 'transcript' }
      if (transcript == null || transcript.seq < override.seq) {
        return { model: override.model, source: 'override' }
      }
      return { model: transcript.model, source: 'transcript' }
    },
  }
}
