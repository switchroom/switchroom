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
