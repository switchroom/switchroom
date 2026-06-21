/**
 * Feature flag: SWITCHROOM_STATUS_NO_TRUNCATE
 *
 * When ON (the default), the activity-feed card shows a **rolling window of
 * the last STATUS_ROLLING_LINES narrative lines**, each rendered in FULL —
 * no per-line length cap ("…"). Message height stays fixed (≤5 lines) while
 * content stays complete. The ONLY remaining ceiling is `STATUS_CARD_CHAR_BUDGET`
 * (Telegram's 4096-char wire limit backstop).
 *
 * When OFF (env var set to '0'), preserves the original capped behaviour:
 * MIRROR_MAX_LINES / NESTED_MAX_LINES / NESTED_LINE_MAX / NARRATIVE_MAX_LINES
 * all apply exactly as before (per-line clip + line-count cap).
 *
 * Semantics: noTruncate = env !== '0'  →  DEFAULT TRUE (rolling-5-full mode).
 *
 * This is a tiny shared module so both renderer files can import it and tests
 * can flip the flag by setting/deleting process.env.SWITCHROOM_STATUS_NO_TRUNCATE
 * without scattering process.env reads across files.
 */

/**
 * Returns true when status cards should show a rolling window of full-content
 * lines (no per-line truncation). Reads the env var at call time so tests can
 * flip it with set/delete on process.env without module re-imports.
 *
 * Default: true (rolling-5-full mode). Set SWITCHROOM_STATUS_NO_TRUNCATE=0 to
 * restore the original capped behaviour.
 */
export function statusNoTruncate(): boolean {
  return process.env.SWITCHROOM_STATUS_NO_TRUNCATE !== '0'
}

/**
 * Number of trailing narrative lines shown in no-truncate mode.
 * The feed is a fixed-height rolling window: oldest drops off as new arrive.
 * Each of the STATUS_ROLLING_LINES lines renders in FULL (no per-line "…").
 */
export const STATUS_ROLLING_LINES = 5

/**
 * The safe char budget for rendered Telegram messages in no-truncate mode.
 * Telegram's hard cap is 4096; we use 4000 to leave 96 chars of headroom for
 * HTML framing, emoji, and escape expansion — matching the convention in
 * pending-work-progress.ts (TELEGRAM_MSG_CAP = 4000).
 *
 * With STATUS_ROLLING_LINES=5 full lines (~750 chars total), this backstop
 * effectively never fires in practice but is kept as a wire-limit safety net.
 */
export const STATUS_CARD_CHAR_BUDGET = 4000
