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
 * Wire cap: since the Bot API 10.1 rich-message migration (#2669) every card
 * renders as GFM markdown via `sendRichMessage`, whose limit is
 * `RICH_MESSAGE_MAX_CHARS` (32768), not the legacy 4096 plain-text cap.
 *
 * The former `SWITCHROOM_STATUS_NO_TRUNCATE` feature flag was retired:
 * rolling-window-with-char-budget is now the only behaviour. The per-line
 * cap (`STATUS_LINE_MAX`) and rolling window (`STATUS_ROLLING_LINES`) apply
 * universally on BOTH surfaces; the total char budget
 * (`STATUS_CARD_CHAR_BUDGET`) is the wire-limit backstop.
 */

import { RICH_MESSAGE_MAX_CHARS } from './format.js'

/**
 * Number of trailing narrative/step lines shown in the rolling window.
 * The feed is a fixed-height rolling window: oldest drops off as new arrive.
 * Overflow surfaces a `+N earlier…` header on BOTH surfaces.
 */
export const STATUS_ROLLING_LINES = 5

/**
 * Ceiling on the per-worker recent-step history RETAINED in `row.narrative`
 * (worker-activity-feed.ts) and the deepest trail the worker cards will render.
 *
 * Distinct from `STATUS_ROLLING_LINES` (which governs the 🤖 agent card's
 * window and stays at 5) so raising the worker trail never widens the agent
 * card. Set to 6 because the deterministic per-worker depth curve
 * (`workerHistoryDepth`, tool-activity-summary.ts) peaks at 6 for a lone
 * worker — `max(3, 7 − workerCount)` at `w = 1`. The buffer must retain at
 * least this many lines or the renderer would ask for 6 and only find 5.
 */
export const WORKER_HISTORY_MAX = 6

/**
 * Per-line character cap, applied to every step + child step on BOTH
 * surfaces before HTML-escaping (clip raw → escape last). A line longer
 * than this is truncated with a trailing `…`.
 */
export const STATUS_LINE_MAX = 200

/**
 * The safe char budget for a rendered Telegram status card. The rich-message
 * wire cap is `RICH_MESSAGE_MAX_CHARS` (32768) post-#2669 — the legacy 4096
 * plain-text cap no longer applies on the rich path. We use the constant
 * directly as the backstop.
 *
 * With STATUS_ROLLING_LINES=5 lines each ≤ STATUS_LINE_MAX this backstop
 * effectively never fires in practice, but is kept as a wire-limit safety net.
 */
export const STATUS_CARD_CHAR_BUDGET = RICH_MESSAGE_MAX_CHARS

/** Indent marker for a nested (foreground sub-agent) step line. */
export const NESTED_PREFIX = '   ↳ '
