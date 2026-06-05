/**
 * Parse the `SWITCHROOM_VISIBLE_ANSWER_STREAM` env flag.
 *
 * Default **OFF** (flipped 2026-06-03, operator request) — see the rationale
 * on the `ANSWER_STREAM_VISIBLE_ENABLED` gate in `gateway/gateway.ts`. When
 * off, the answer lane streams to the invisible compose-box draft and the
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
 * Draft-answer-lane retirement (2026-06-05). The compose-box draft transport
 * (`sendMessageDraft`) is invisible to the mtcute UAT harness, so the live
 * answer-stream surface couldn't be tested. Retired by DEFAULT: the answer lane
 * now opens a real, observable edit-in-place message instead of the compose-box
 * draft (and the onMetric silence-liveness reset from #2169 now fires on visible
 * sends in BOTH DMs and supergroups, not just DM drafts). Kill switch
 * `SWITCHROOM_DRAFT_ANSWER_LANE=0` (also false/off/no) restores the legacy
 * invisible draft.
 *
 * Returns true when the draft lane is RETIRED (the default — env unset or any
 * truthy value); false only for an explicit disable of the retirement.
 */
export function parseDraftLaneRetiredEnabled(raw: string | undefined): boolean {
  if (raw == null) return true
  const v = raw.trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

/**
 * `minInitialChars` sentinel meaning "never open a visible chat-timeline
 * preview" — mirrors the `Number.MAX_SAFE_INTEGER` gate the createAnswerStream
 * call site uses so the lane stays silent.
 */
export const ANSWER_LANE_NEVER_OPENS = Number.MAX_SAFE_INTEGER

export type AnswerLaneState = 'visible' | 'draft' | 'dormant'

export interface AnswerLaneConfig {
  /** `minInitialChars` for createAnswerStream: `1` opens a visible preview on
   *  the first text chunk; `ANSWER_LANE_NEVER_OPENS` suppresses it. */
  minInitialChars: number
  /** Whether the lane streams to the invisible compose-box draft transport. */
  usesDraftTransport: boolean
  /** Whether a USER-VISIBLE chat-timeline preview opens — i.e. the surface that
   *  flashed (raw preview → formatted reply → preview deleted). This is THE
   *  regression invariant: it must equal `visibleEnabled`, never depend on the
   *  draft flag. */
  opensVisiblePreview: boolean
  /** Label for the boot log. */
  state: AnswerLaneState
}

/**
 * Resolve the answer-lane config from the two INDEPENDENT inputs.
 *
 * The visible PREVIEW (the flash surface) is gated on `visibleEnabled` ALONE;
 * draft retirement controls only the TRANSPORT (whether `sendMessageDraft` is
 * available). Conflating them was the v0.14.68 regression: retiring the draft
 * (the default) forced a visible preview that flashed on every streaming turn,
 * re-opening the flash v0.14.52 had removed. The load-bearing invariant —
 * `opensVisiblePreview === visibleEnabled` for EVERY `draftFnAvailable` — is
 * what this function exists to make total-enumerable (the gateway IIFE is not).
 *
 *   visibleEnabled                       → 'visible'  (preview opens, minChars 1)
 *   !visible, draft transport available  → 'draft'    (no preview; draft renders)
 *   !visible, no draft transport         → 'dormant'  (no preview, no draft:
 *                                                       the reply tool is the
 *                                                       only message — the default)
 */
export function resolveAnswerLaneConfig(input: {
  visibleEnabled: boolean
  draftFnAvailable: boolean
}): AnswerLaneConfig {
  if (input.visibleEnabled) {
    return {
      minInitialChars: 1,
      usesDraftTransport: false,
      opensVisiblePreview: true,
      state: 'visible',
    }
  }
  if (input.draftFnAvailable) {
    return {
      minInitialChars: ANSWER_LANE_NEVER_OPENS,
      usesDraftTransport: true,
      opensVisiblePreview: false,
      state: 'draft',
    }
  }
  return {
    minInitialChars: ANSWER_LANE_NEVER_OPENS,
    usesDraftTransport: false,
    opensVisiblePreview: false,
    state: 'dormant',
  }
}
