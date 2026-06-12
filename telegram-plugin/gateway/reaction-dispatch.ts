/**
 * Reaction-dispatch: event-driven Telegram `message_reaction` → agent turn.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/2291
 *
 * Distinct from the `reactions` trigger module (`reaction-trigger.ts`,
 * #1074), which forwards reactions on the BOT's own messages as feedback
 * (debounced, hour-capped, default ON, bot-authored-gated). This module
 * implements the #2291 request: deliver ANY qualifying `message_reaction`
 * update — regardless of who authored the reacted message — as an inbound
 * channel turn shaped like a button-callback event:
 *
 *   <channel source="switchroom-telegram" event="reaction"
 *            emoji="👨‍💻" message_id="123" chat_id="456" user="Ken">
 *   <reacted message text>
 *   </channel>
 *
 * It exists so reaction-driven workflows (e.g. clerk's Telegram→Linear
 * capture on a 👨‍💻 reaction) stop polling get_recent_messages on a cron.
 *
 * Design:
 *   - Default OFF. No turns fire unless an operator configures a
 *     `reaction_dispatch` block with a non-empty `emojis` allowlist.
 *   - Emoji allowlist filter. Only additions/changes whose new emoji is
 *     in the allowlist dispatch. Removals never fire (handled by the
 *     gateway before this module is consulted).
 *   - No bot-authored gate — the whole point is reacting to arbitrary
 *     messages (the user's own, peers', or the bot's).
 *   - The reacted message's text is looked up from the SQLite history
 *     buffer; a miss degrades to an empty body (the envelope still
 *     carries emoji / message_id / chat_id / user).
 *
 * This module is pure gateway-internal logic — no Telegram API calls,
 * no IPC. The gateway's `message_reaction` handler calls
 * `evaluateReactionDispatch` then `buildReactionDispatchInbound`.
 */

export interface ReactionDispatchResolvedConfig {
  enabled: boolean;
  /** Allowlist of emoji that trigger a dispatch. Empty ⇒ nothing fires. */
  emojis: ReadonlySet<string>;
}

/**
 * Built-in defaults — applied when the cascade does not set a field.
 * Default OFF: no `reaction_dispatch` block ⇒ no reaction turns. This is
 * the noise-avoidance contract from #2291.
 */
export const REACTION_DISPATCH_DEFAULTS: ReactionDispatchResolvedConfig = Object.freeze({
  enabled: false,
  emojis: Object.freeze(new Set<string>()) as ReadonlySet<string>,
});

/**
 * Cascade-resolved `reaction_dispatch` slice as it appears on the agent
 * config. Shape mirrors `ReactionDispatchSchema` in `src/config/schema.ts`.
 * Typed loosely so this module stays independent of the src/ zod schemas.
 */
export interface ReactionDispatchConfigInput {
  enabled?: boolean;
  emojis?: readonly string[];
}

/**
 * Fold a raw cascade-resolved `reaction_dispatch:` block into the runtime
 * shape, filling defaults for missing fields. A `null`/`undefined` raw
 * input collapses to the (OFF) built-in defaults.
 */
export function resolveReactionDispatchConfig(
  raw: ReactionDispatchConfigInput | null | undefined,
): ReactionDispatchResolvedConfig {
  if (!raw) return REACTION_DISPATCH_DEFAULTS;
  return {
    enabled: raw.enabled ?? REACTION_DISPATCH_DEFAULTS.enabled,
    emojis: raw.emojis !== undefined
      ? new Set(raw.emojis)
      : REACTION_DISPATCH_DEFAULTS.emojis,
  };
}

// ─── Predicate ───────────────────────────────────────────────────────────

export interface ReactionDispatchCandidate {
  /** Emoji string from the new_reaction; null when not a plain emoji. */
  emoji: string | null;
  /** 'add' | 'change' — 'remove' candidates are rejected pre-call. */
  action: 'add' | 'change';
}

export type ReactionDispatchDecision =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'no_emoji' | 'emoji_not_in_allowlist' };

/**
 * Synchronous predicate. Returns `ok: true` only when the dispatch path
 * is enabled and the candidate's emoji is in the allowlist. Removals are
 * the caller's responsibility to filter (the Bot API distinguishes them
 * via empty `new_reaction`); this predicate only ever sees add/change.
 */
export function evaluateReactionDispatch(
  cfg: ReactionDispatchResolvedConfig,
  c: ReactionDispatchCandidate,
): ReactionDispatchDecision {
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (c.emoji === null) return { ok: false, reason: 'no_emoji' };
  if (!cfg.emojis.has(c.emoji)) return { ok: false, reason: 'emoji_not_in_allowlist' };
  return { ok: true };
}

// ─── Inbound envelope builder ─────────────────────────────────────────────

export interface ReactionDispatchInput {
  emoji: string;
  chatId: string;
  messageId: number;
  /** Display name of the reacter (first_name → username → string id). */
  user: string;
  /** Numeric user_id of the reacter, for the wire's userId field. */
  userId: number;
  /** Reacted message's text from the history buffer; '' on miss. */
  reactedText: string;
  /** Forum thread id if the reacted message lived in a topic. */
  threadId?: number;
}

export interface ReactionDispatchInbound {
  text: string;
  meta: Record<string, string>;
}

/**
 * Build the synthesized inbound's `text` + `meta`. The envelope mirrors
 * the button-callback event shape so the agent reads reactions and button
 * taps the same way. The reacted message's text lands in the element body.
 */
export function buildReactionDispatchInbound(
  input: ReactionDispatchInput,
): ReactionDispatchInbound {
  const safeEmoji = escapeAttr(input.emoji);
  const safeUser = escapeAttr(input.user);
  const safeChat = escapeAttr(input.chatId);
  const body = escapeBody(input.reactedText);

  const text =
    `<channel source="switchroom-telegram" event="reaction" ` +
    `emoji="${safeEmoji}" message_id="${input.messageId}" ` +
    `chat_id="${safeChat}" user="${safeUser}">` +
    body +
    `</channel>`;

  const meta: Record<string, string> = {
    source: 'switchroom-telegram',
    event: 'reaction',
    reaction_emoji: input.emoji,
    target_message_id: String(input.messageId),
    reacted_text: input.reactedText,
  };

  return { text, meta };
}

// Minimal XML-attr escape; the body uses a looser escape because it lands
// inside the element body, not an attribute value.
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeBody(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
