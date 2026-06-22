/**
 * Parse the `SWITCHROOM_VISIBLE_ANSWER_STREAM` env flag.
 *
 * Default **OFF** (flipped 2026-06-03, operator request) — see the rationale
 * on the `ANSWER_STREAM_VISIBLE_ENABLED` gate in `gateway/gateway.ts`. When
 * off, the answer lane stays dormant (no draft, no visible preview) and the
 * reply tool is the single canonical formatted message — no unformatted
 * preliminary that flashes and gets deleted. Opt back IN per agent with
 * `SWITCHROOM_VISIBLE_ANSWER_STREAM=1` (also accepts true/on/yes).
 *
 * Extracted as a pure function so the default + parsing are unit-testable
 * (gateway.ts is not importable in isolation — top-level side effects).
 */
export function parseVisibleAnswerStreamEnabled(raw: string | undefined): boolean {
  if (raw == null) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/**
 * `minInitialChars` sentinel meaning "never open a visible chat-timeline
 * preview" — mirrors the `Number.MAX_SAFE_INTEGER` gate the createAnswerStream
 * call site uses so the lane stays silent.
 */
export const ANSWER_LANE_NEVER_OPENS = Number.MAX_SAFE_INTEGER

/** The answer-lane rendering state. 'draft' is removed — lane is either
 *  visible (opt-in) or dormant (the default: reply tool is the only message). */
export type AnswerLaneState = 'visible' | 'dormant'

export interface AnswerLaneConfig {
  /** `minInitialChars` for createAnswerStream: `1` opens a visible preview on
   *  the first text chunk; `ANSWER_LANE_NEVER_OPENS` suppresses it. */
  minInitialChars: number
  /** Whether a USER-VISIBLE chat-timeline preview opens — i.e. the surface that
   *  flashed (raw preview → formatted reply → preview deleted). This is THE
   *  regression invariant: it must equal `visibleEnabled`. */
  opensVisiblePreview: boolean
  /** Label for the boot log. */
  state: AnswerLaneState
}

/**
 * Resolve the answer-lane config from the single input.
 *
 * The draft transport (`sendMessageDraft`) is permanently retired — the lane
 * is either VISIBLE (opt-in via SWITCHROOM_VISIBLE_ANSWER_STREAM=1) or
 * DORMANT (the unconditional default). In dormant mode no preview opens and
 * the reply tool is the single canonical formatted message.
 *
 *   visibleEnabled  → 'visible'  (preview opens on first chunk, minChars 1)
 *   !visibleEnabled → 'dormant'  (no preview, no draft — reply tool only)
 */
export function resolveAnswerLaneConfig(input: {
  visibleEnabled: boolean
}): AnswerLaneConfig {
  if (input.visibleEnabled) {
    return {
      minInitialChars: 1,
      opensVisiblePreview: true,
      state: 'visible',
    }
  }
  return {
    minInitialChars: ANSWER_LANE_NEVER_OPENS,
    opensVisiblePreview: false,
    state: 'dormant',
  }
}
