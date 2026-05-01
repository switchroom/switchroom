/**
 * Shared bot-token redaction helper.
 *
 * Telegram's Bot API requires the token as a URL path segment
 * (`https://api.telegram.org/bot<TOKEN>/...`). Any error path that
 * stringifies the request URL — node fetch DNS failures, `Response.url`
 * preserved across error boundaries, an SDK that captures `req.url`
 * into its error message — leaks the token to whatever log sink
 * consumes the error.
 *
 * Use this helper at every API-call boundary that catches errors and
 * surfaces them outward. Keep the redaction string identical across
 * call sites so log scrapers can grep for the marker.
 *
 * Closes #472 finding #12 (topic-manager.ts errors leaking the token);
 * this module also de-duplicates the previously-private helper in
 * src/setup/telegram-api.ts so adding the next call site is mechanical.
 */

const REDACTED_PLACEHOLDER = "<redacted-bot-token>";

/**
 * Replace every literal occurrence of `token` in `message` with the
 * standard placeholder. No-ops when token is empty or implausibly short
 * (avoids over-redacting innocuous strings like "1" or fingerprints).
 */
export function redactToken(message: string, token: string): string {
  if (!token || token.length < 8) return message;
  return message.split(token).join(REDACTED_PLACEHOLDER);
}
