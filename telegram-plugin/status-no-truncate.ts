/**
 * Feature flag: SWITCHROOM_STATUS_NO_TRUNCATE
 *
 * When ON (the default), activity-feed cards show ALL accumulated lines and
 * full-width lines — no cosmetic line-count or per-line-length caps. The only
 * ceiling in no-truncate mode is Telegram's 4096-char message limit.
 *
 * When OFF (env var set to '0'), preserves the original capped behaviour:
 * MIRROR_MAX_LINES / NESTED_MAX_LINES / NESTED_LINE_MAX / NARRATIVE_MAX_LINES
 * all apply exactly as before.
 *
 * Semantics: noTruncate = env !== '0'  →  DEFAULT TRUE (no truncation).
 *
 * This is a tiny shared module so both renderer files can import it and tests
 * can flip the flag by setting/deleting process.env.SWITCHROOM_STATUS_NO_TRUNCATE
 * without scattering process.env reads across files.
 */

/**
 * Returns true when status cards should show all accumulated lines (no
 * cosmetic truncation). Reads the env var at call time so tests can flip it
 * with set/delete on process.env without module re-imports.
 *
 * Default: true (no truncation). Set SWITCHROOM_STATUS_NO_TRUNCATE=0 to
 * restore the original capped behaviour.
 */
export function statusNoTruncate(): boolean {
  return process.env.SWITCHROOM_STATUS_NO_TRUNCATE !== '0'
}

/**
 * The safe char budget for rendered Telegram messages in no-truncate mode.
 * Telegram's hard cap is 4096; we use 4000 to leave 96 chars of headroom for
 * HTML framing, emoji, and escape expansion — matching the convention in
 * pending-work-progress.ts (TELEGRAM_MSG_CAP = 4000).
 */
export const STATUS_CARD_CHAR_BUDGET = 4000
