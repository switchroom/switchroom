/**
 * Outbound dedup window (#546).
 *
 * Closes the duplicate-reply class where:
 *
 *   1. Agent emits text that the gateway buffers as PTY-tail.
 *   2. Bridge disconnects mid-flight (turn boundary, restart, etc.)
 *      before claude-code's reply / stream_reply tool_call lands.
 *   3. Gateway's `turn-flush` backstop fires after a 500ms grace —
 *      sees no reply tool_call landed, sends the buffered text as
 *      its own message (HTML-rendered).
 *   4. claude-code preserves the un-acked tool_call in its session
 *      and replays it on the next bridge connection. The replayed
 *      stream_reply lands as a SECOND message with the same content
 *      (raw markdown, since reply tools don't always render HTML).
 *
 * Smoking-gun evidence: klanker chat 8248703757, msgs 5025 + 5027,
 * 11s apart. msg=5025 had `<b>...</b>` (turn-flush + markdownToHtml).
 * msg=5027 had `**...**` (the raw markdown reply tool's payload).
 * Same content, different formatting, two messages.
 *
 * Fix shape: maintain a small in-memory cache of "what we just sent"
 * keyed by (chatId, threadId). Before any reply / stream_reply
 * actually sends, check whether a recent outbound matches the
 * normalised content. If so, skip the send and return a successful
 * tool-call result so claude-code's retry loop closes cleanly.
 *
 * This is a SAFETY NET layer. The cleaner architectural fix would be
 * "don't fire turn-flush when claude-code might retry" — but that
 * needs reliable detection of the retry intent ahead of time, which
 * we don't have. Dedup-after-the-fact is robust against the full
 * range of "two paths, same content" failure modes.
 *
 * Pure module: no I/O, no globals, no clock reads beyond the caller-
 * supplied `now`. Fully unit-testable.
 */

/** TTL after which a recorded outbound is forgotten. 60s catches the
 *  typical retry window (we've seen 9-11s in the wild) with margin
 *  for slower networks and avoids deduping legitimate later replies
 *  that happen to repeat content. */
export const DEFAULT_DEDUP_TTL_MS = 60_000

/** Minimum content length below which we don't bother deduping.
 *  Short replies (<= 24 chars) like "ok", "got it", "✅" frequently
 *  recur within seconds in normal multi-turn conversation; deduping
 *  them would suppress legitimate repeats. The bug class we're
 *  defending against involves multi-paragraph content, so the floor
 *  is conservative. */
export const DEDUP_MIN_CONTENT_LEN = 24

interface DedupEntry {
  /** Normalized content hash (see `normalizeForDedup`). */
  hash: string
  /** Wall-clock ms when recorded. */
  ts: number
  /** First 80 chars of the original (un-normalized) text — for
   *  operator-facing log lines that show what got deduped. */
  preview: string
}

/**
 * In-memory dedup cache, keyed by `chatId|threadId`. Bounded by
 * TTL eviction on every read; we don't cap entries because chat
 * count per gateway is small (one per active conversation).
 */
export class OutboundDedupCache {
  private readonly entries = new Map<string, DedupEntry[]>()
  private readonly ttlMs: number

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DEDUP_TTL_MS
  }

  /** Record an outbound message. Caller should invoke this after a
   *  successful send, regardless of which path sent it (turn-flush,
   *  executeReply, executeStreamReply, etc.). Short content is not
   *  recorded — see DEDUP_MIN_CONTENT_LEN. */
  record(chatId: string, threadId: number | undefined, text: string, now: number): void {
    if (text.length < DEDUP_MIN_CONTENT_LEN) return
    const key = makeKey(chatId, threadId)
    const list = this.entries.get(key) ?? []
    this.evict(list, now)
    list.push({
      hash: normalizeForDedup(text),
      ts: now,
      preview: text.slice(0, 80),
    })
    this.entries.set(key, list)
  }

  /** Check whether the given text was already sent recently to the
   *  same chat. Returns the matched entry's preview + age on hit, or
   *  null on miss. Caller decides what to do with the answer
   *  (skip-send, log, etc.). */
  check(
    chatId: string,
    threadId: number | undefined,
    text: string,
    now: number,
  ): { matched: true; preview: string; ageMs: number } | null {
    if (text.length < DEDUP_MIN_CONTENT_LEN) return null
    const key = makeKey(chatId, threadId)
    const list = this.entries.get(key)
    if (!list) return null
    this.evict(list, now)
    const candidateHash = normalizeForDedup(text)
    for (const entry of list) {
      if (entry.hash === candidateHash) {
        return { matched: true, preview: entry.preview, ageMs: now - entry.ts }
      }
    }
    return null
  }

  /** Test-only: clear all entries. */
  clear(): void {
    this.entries.clear()
  }

  /** Test-only: count of live entries (post-eviction). */
  size(now: number): number {
    let total = 0
    for (const list of this.entries.values()) {
      this.evict(list, now)
      total += list.length
    }
    return total
  }

  private evict(list: DedupEntry[], now: number): void {
    const cutoff = now - this.ttlMs
    let i = 0
    while (i < list.length && list[i].ts < cutoff) i++
    if (i > 0) list.splice(0, i)
  }
}

function makeKey(chatId: string, threadId: number | undefined): string {
  return threadId == null ? chatId : `${chatId}|${threadId}`
}

/**
 * Normalise text for content equality. The bug we're defending
 * against produces the SAME content rendered two different ways:
 * one path runs `markdownToHtml` (so `**foo**` becomes `<b>foo</b>`),
 * the other doesn't. Both must hash identically.
 *
 * Steps:
 *   1. Strip HTML tags (`<b>foo</b>` → `foo`).
 *   2. Strip markdown markers (`**foo**` / `__foo__` / `` `foo` `` → `foo`).
 *   3. Collapse all whitespace to single space + trim.
 *   4. Lowercase (defensive — both renderers preserve case but a
 *      future formatter might title-case headings, etc.).
 *
 * NOT a hash function in the cryptographic sense — just a
 * normalised-string comparison key. Identical content + identical
 * normaliser → identical key.
 */
export function normalizeForDedup(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')      // HTML tags
    .replace(/&[a-zA-Z]+;|&#\d+;/g, ' ')     // HTML entities → space
    .replace(/(\*\*|__|`)+/g, '')            // markdown bold/italic/code markers
    .replace(/^[#>\-*+]\s+/gm, '')           // markdown line prefixes
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
