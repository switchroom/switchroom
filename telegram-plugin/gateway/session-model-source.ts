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
 *
 * Divergence tripwire (#3427 item 4): `--fallback-model` masks an invalid
 * requested model id — claude silently serves the fallback while the override
 * carries the requested token. The FIRST transcript observation after an
 * override is set is therefore the earliest deterministic verification point:
 * when the injected comparator says the served id does NOT satisfy the
 * requested token, the registered divergence handler fires (once per override)
 * so the gateway can log + warn instead of self-healing silently.
 */

export interface SessionModelResolution {
  /** The raw value from the winning source. Transcript entries are resolved
   *  model ids (`claude-opus-4-8`); override entries may be friendly labels
   *  ("Opus 4.8") or sr-* ids depending on the /model path that set them. */
  model: string
  source: 'transcript' | 'override'
}

/** The first post-override assistant line served a different model (#3427). */
export interface SessionModelDivergence {
  /** The override token the operator requested (`/model <token>`). */
  requested: string
  /** The transcript's `message.model` — the model actually serving calls. */
  served: string
}

export interface SessionModelSourceOptions {
  /**
   * Comparator for the divergence tripwire: does `served` (a resolved
   * transcript id) satisfy `requested` (the override token)? Must be
   * CONSERVATIVE — return true when the pair is not deterministically
   * comparable (see servedModelMatchesRequested in model-command.ts).
   * Absent → the tripwire never fires (verification is skipped).
   */
  servedMatchesRequested?: (requested: string, served: string) => boolean
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
  /** Register the handler fired when the FIRST transcript observation after a
   *  set override fails the comparator (#3427 item 4). At most once per
   *  override set; null unregisters. Replaces any prior handler. */
  setDivergenceHandler(handler: ((d: SessionModelDivergence) => void) | null): void
}

export function createSessionModelSource(
  options: SessionModelSourceOptions = {},
): SessionModelSource {
  let seq = 0
  let transcript: { model: string; seq: number } | null = null
  let override: { model: string; seq: number } | null = null
  // True while a non-null override awaits its first transcript observation.
  // Consumed (set false) on that observation whether or not it diverges, so
  // the handler fires at most once per override set.
  let overrideUnverified = false
  let onDivergence: ((d: SessionModelDivergence) => void) | null = null
  return {
    noteTranscriptModel(model: string): void {
      transcript = { model, seq: ++seq }
      if (override != null && overrideUnverified) {
        overrideUnverified = false
        const matches = options.servedMatchesRequested
        if (matches != null && !matches(override.model, model)) {
          onDivergence?.({ requested: override.model, served: model })
        }
      }
    },
    setOverride(model: string | null): void {
      override = model == null ? null : { model, seq: ++seq }
      overrideUnverified = model != null
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
    setDivergenceHandler(handler: ((d: SessionModelDivergence) => void) | null): void {
      onDivergence = handler
    },
  }
}
