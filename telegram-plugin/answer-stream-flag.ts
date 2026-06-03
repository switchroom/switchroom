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
