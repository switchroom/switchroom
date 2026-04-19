/**
 * Prompt-injection safety for the Telegram channel envelope.
 *
 * Claude Code wraps inbound channel content as:
 *
 *   <channel source="telegram" chat_id="..." user="..." ...>USER BODY</channel>
 *
 * …when it delivers `notifications/claude/channel` to the LLM. The XML
 * attributes are trusted metadata produced by this plugin; the body is
 * untrusted user-provided content. A message body that contains a literal
 * `</channel>` closing token can confuse Claude's envelope-aware
 * parser and either truncate the envelope or appear to introduce a
 * second one with attacker-chosen metadata.
 *
 * This helper neutralizes those tokens in the body without making the
 * text illegible. `</channel>` becomes `<\/channel>` (forward-slash is
 * backslash-escaped), and `<channel source=` becomes `<_channel source=`.
 * Both substitutions are unambiguous for the LLM to read but don't match
 * the literal tag patterns the delimited-text parser looks for.
 *
 * When substitutions happen, `sanitizeChannelBody` returns a flag so the
 * plugin can attach `pi_attempt: "closer"` / `pi_attempt: "nested"` to
 * the envelope `meta` — the LLM can then alert the real user.
 */

export type ChannelBodySanitizeResult = {
  text: string;
  attempts: ChannelBodyPiAttempt[];
};

export type ChannelBodyPiAttempt = "closer" | "nested";

export function sanitizeChannelBody(body: string): ChannelBodySanitizeResult {
  if (typeof body !== "string" || body.length === 0) {
    return { text: body ?? "", attempts: [] };
  }
  // Fresh regex instances per call: module-scoped /g regexes carry
  // lastIndex between .test/.replace which races under any future
  // concurrent use of this module. Creating fresh is cheap and avoids
  // the footgun entirely.
  const closerRe = /<\/channel\s*>/gi;
  // Allow an optional `/` before `>` so a self-closing <channel/> doesn't
  // slip past the sanitizer.
  const nestedRe = /<channel(\s+[^>]*)?\/?>/gi;
  const attempts = new Set<ChannelBodyPiAttempt>();
  let text = body;
  if (closerRe.test(text)) {
    attempts.add("closer");
    text = text.replace(/<\/channel\s*>/gi, "<\\/channel>");
  }
  if (nestedRe.test(text)) {
    attempts.add("nested");
    text = text.replace(/<channel(\s+[^>]*)?\/?>/gi, "<_channel$1>");
  }
  return { text, attempts: [...attempts] };
}
