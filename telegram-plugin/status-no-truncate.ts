/**
 * Status-card shared constants.
 *
 * Both status surfaces — the main-session agent activity card
 * (`tool-activity-summary.ts`) and the background-worker activity feed
 * (`worker-activity-feed.ts`) — render through the single
 * `renderStatusCard` primitive in `tool-activity-summary.ts`. This module
 * holds the tuning constants that primitive (and its internal helpers)
 * read, so a forked renderer never re-derives them.
 *
 * The former `SWITCHROOM_STATUS_NO_TRUNCATE` feature flag was retired:
 * rolling-window-with-char-budget is now the only behaviour. The per-line
 * cap (`STATUS_LINE_MAX`) and rolling window (`STATUS_ROLLING_LINES`) apply
 * universally on BOTH surfaces; the total char budget
 * (`STATUS_CARD_CHAR_BUDGET`) is the wire-limit backstop.
 */

/**
 * Number of trailing narrative/step lines shown in the rolling window.
 * The feed is a fixed-height rolling window: oldest drops off as new arrive.
 * Overflow surfaces a `+N earlier…` header on BOTH surfaces.
 */
export const STATUS_ROLLING_LINES = 5

/**
 * Per-line character cap, applied to every step + child step on BOTH
 * surfaces before HTML-escaping (clip raw → escape last). A line longer
 * than this is truncated with a trailing `…`.
 */
export const STATUS_LINE_MAX = 200

/**
 * The safe char budget for a rendered Telegram status card. Telegram's hard
 * cap is 4096; we use 4000 to leave 96 chars of headroom for HTML framing,
 * emoji, and escape expansion — matching the convention in
 * pending-work-progress.ts (TELEGRAM_MSG_CAP = 4000).
 *
 * With STATUS_ROLLING_LINES=5 lines each ≤ STATUS_LINE_MAX this backstop
 * effectively never fires in practice, but is kept as a wire-limit safety net.
 */
export const STATUS_CARD_CHAR_BUDGET = 4000

/** Indent marker for a nested (foreground sub-agent) step line. */
export const NESTED_PREFIX = '   ↳ '
