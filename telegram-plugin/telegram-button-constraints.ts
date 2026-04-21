/**
 * Telegram Bot API button-field constraint validator.
 *
 * Context: 2026-04-22 we shipped a `copy_text` button holding an OAuth
 * authorize URL (~326 chars). Telegram rejected with
 * `BUTTON_COPY_TEXT_INVALID` because the CopyTextButton.text field caps
 * at 256 characters (https://core.telegram.org/bots/api#copytextbutton).
 * Our tests asserted button SHAPE ("has text, has copy_text") but not
 * the API's real constraints. This module closes that gap: import it
 * anywhere we build keyboards and run validateInlineKeyboard() at
 * least in tests, optionally at runtime to drop bad buttons gracefully.
 *
 * Constraints are sourced directly from Telegram Bot API docs. When
 * they change or a new button type is added, update this file and the
 * companion test file to match.
 */

/**
 * Telegram Bot API field length limits for inline-keyboard button
 * payloads. Values from https://core.telegram.org/bots/api as of
 * April 2026 (Bot API 7.11).
 */
export const TELEGRAM_BUTTON_LIMITS = {
  /** InlineKeyboardButton.text — the label users see on the button. */
  TEXT_MAX: 64,
  /** InlineKeyboardButton.url — must be a valid http(s) URL; Telegram
   *  accepts up to 2048 chars in practice (mirrors HTTP URL limit). */
  URL_MAX: 2048,
  /** InlineKeyboardButton.callback_data — 1-64 bytes. */
  CALLBACK_DATA_MAX: 64,
  /** CopyTextButton.text — 1-256 chars. THE ONE THAT BIT US. */
  COPY_TEXT_MAX: 256,
  /** LoginUrl.url — same practical limit as url. */
  LOGIN_URL_MAX: 2048,
  /** SwitchInlineQueryChosenChat.query — 1-256 chars. */
  SWITCH_INLINE_QUERY_MAX: 256,
} as const;

export interface ButtonValidationError {
  /** Path pinpointing which button failed, e.g. 'row[0].col[1]'. */
  path: string;
  /** Field on the button that failed, e.g. 'copy_text.text'. */
  field: string;
  /** Human-readable reason. */
  reason: string;
  /** The actual length (if length-related), for easy debugging. */
  actualLength?: number;
  /** The constraint limit that was exceeded. */
  limit?: number;
}

/** A lightly-typed button. We accept unknowns so callers don't need
 *  to import every grammy type just to validate. */
export type AnyButton = Record<string, unknown>;

/**
 * Validate a single inline-keyboard button against Telegram API limits.
 * Returns an empty array when valid. Never throws — callers decide what
 * to do with errors (log, filter, fail test, etc).
 */
export function validateInlineButton(
  button: AnyButton,
  path: string,
): ButtonValidationError[] {
  const errors: ButtonValidationError[] = [];

  const textField = typeof button.text === "string" ? button.text : null;
  if (textField === null || textField.length === 0) {
    errors.push({ path, field: "text", reason: "missing or empty text" });
  } else if (textField.length > TELEGRAM_BUTTON_LIMITS.TEXT_MAX) {
    errors.push({
      path,
      field: "text",
      reason: `text exceeds ${TELEGRAM_BUTTON_LIMITS.TEXT_MAX}-char limit`,
      actualLength: textField.length,
      limit: TELEGRAM_BUTTON_LIMITS.TEXT_MAX,
    });
  }

  if (typeof button.url === "string") {
    if (button.url.length > TELEGRAM_BUTTON_LIMITS.URL_MAX) {
      errors.push({
        path,
        field: "url",
        reason: `url exceeds ${TELEGRAM_BUTTON_LIMITS.URL_MAX}-char limit`,
        actualLength: button.url.length,
        limit: TELEGRAM_BUTTON_LIMITS.URL_MAX,
      });
    }
    // Also require a valid http(s) scheme — Telegram rejects others.
    if (!/^https?:\/\//i.test(button.url) && !button.url.startsWith("tg://")) {
      errors.push({
        path,
        field: "url",
        reason: `url must start with http(s):// or tg://`,
      });
    }
  }

  if (typeof button.callback_data === "string") {
    // Telegram limits callback_data to 64 BYTES (not chars). Most of our
    // data is ASCII so length ≈ byte count, but use TextEncoder for
    // correctness.
    const bytes = new TextEncoder().encode(button.callback_data).byteLength;
    if (bytes > TELEGRAM_BUTTON_LIMITS.CALLBACK_DATA_MAX) {
      errors.push({
        path,
        field: "callback_data",
        reason: `callback_data exceeds ${TELEGRAM_BUTTON_LIMITS.CALLBACK_DATA_MAX}-byte limit`,
        actualLength: bytes,
        limit: TELEGRAM_BUTTON_LIMITS.CALLBACK_DATA_MAX,
      });
    }
  }

  if (button.copy_text && typeof button.copy_text === "object") {
    const ct = button.copy_text as { text?: unknown };
    const copyText = typeof ct.text === "string" ? ct.text : null;
    if (copyText === null || copyText.length === 0) {
      errors.push({
        path,
        field: "copy_text.text",
        reason: "missing or empty copy_text.text",
      });
    } else if (copyText.length > TELEGRAM_BUTTON_LIMITS.COPY_TEXT_MAX) {
      errors.push({
        path,
        field: "copy_text.text",
        reason: `copy_text.text exceeds ${TELEGRAM_BUTTON_LIMITS.COPY_TEXT_MAX}-char limit`,
        actualLength: copyText.length,
        limit: TELEGRAM_BUTTON_LIMITS.COPY_TEXT_MAX,
      });
    }
  }

  if (button.login_url && typeof button.login_url === "object") {
    const lu = button.login_url as { url?: unknown };
    if (typeof lu.url === "string" && lu.url.length > TELEGRAM_BUTTON_LIMITS.LOGIN_URL_MAX) {
      errors.push({
        path,
        field: "login_url.url",
        reason: `login_url.url exceeds ${TELEGRAM_BUTTON_LIMITS.LOGIN_URL_MAX}-char limit`,
        actualLength: lu.url.length,
        limit: TELEGRAM_BUTTON_LIMITS.LOGIN_URL_MAX,
      });
    }
  }

  return errors;
}

/**
 * Validate a full 2D inline-keyboard layout. Returns an array of all
 * constraint violations (empty when all buttons pass).
 */
export function validateInlineKeyboard(
  inlineKeyboard: AnyButton[][],
): ButtonValidationError[] {
  const errors: ButtonValidationError[] = [];
  inlineKeyboard.forEach((row, rowIdx) => {
    row.forEach((btn, colIdx) => {
      const path = `row[${rowIdx}].col[${colIdx}]`;
      errors.push(...validateInlineButton(btn, path));
    });
  });
  return errors;
}

/**
 * Filter a keyboard down to only buttons that would be accepted by
 * Telegram. Useful as a runtime safety net so a single bad button
 * doesn't take down the whole response with a 400 error. Empty rows
 * are dropped entirely.
 */
export function dropInvalidButtons(
  inlineKeyboard: AnyButton[][],
  onDrop?: (err: ButtonValidationError, btn: AnyButton) => void,
): AnyButton[][] {
  return inlineKeyboard
    .map((row) =>
      row.filter((btn) => {
        const errs = validateInlineButton(btn, "");
        if (errs.length > 0) {
          if (onDrop) errs.forEach((e) => onDrop(e, btn));
          return false;
        }
        return true;
      }),
    )
    .filter((row) => row.length > 0);
}
