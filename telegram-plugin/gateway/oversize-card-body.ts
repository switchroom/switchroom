/**
 * Shared "render-and-fit" helper for approval cards that wrap
 * user-supplied content in HTML framing. (#1762 / #1767)
 *
 * Telegram's `sendMessage` caps the body at 4096 chars and we render
 * with `parse_mode=HTML`. Worst-case escape inflates raw content up
 * to 5x (`&` → `&amp;`), so a naive raw-input cap is unsafe — the
 * post-escape body can blow past the limit and `sendMessage` then
 * returns a generic 400 that surfaces upstream as a silent
 * `E_DENIED`.
 *
 * This helper binary-searches the largest prefix of the RAW content
 * whose rendered body still fits under `cap`, snaps to the last
 * newline so we don't cut mid-line (and never cut mid-entity like
 * `&am|p;` — raw doesn't contain entities yet), and appends a
 * sentinel pointing at the attached full content (if any).
 *
 * Callers own the framing: pass a `render(slice)` closure that
 * embeds the slice in whatever escaped envelope they want, and the
 * helper guarantees the returned `body` fits.
 *
 * Both `config-approval-handler.ts` (config-edit diffs) and
 * `drive-write-approval.ts` (Drive write preview cards) use this.
 */

export interface TruncateRawToFitInput {
  /** Raw, un-escaped content to slice. */
  raw: string;
  /**
   * Build the full rendered card body from a (possibly truncated)
   * raw slice. The closure owns HTML escaping + all framing. Called
   * O(log n) times during the binary search; keep it cheap.
   */
  render: (rawSlice: string) => string;
  /**
   * Maximum rendered length (chars). Should be set below Telegram's
   * 4096 hard limit to leave margin for invisible framing wobble.
   */
  cap: number;
  /**
   * Marker appended to the truncated slice before re-rendering — e.g.
   * `"\n[… diff continues, see attached file]"`. The render closure
   * receives `rawSlice + sentinel` so the marker is visible inside
   * the same envelope (code block etc.).
   */
  sentinel: string;
  /** Absolute hard cap for the defensive last-resort raw cut. Default `cap + 196`. */
  hardLimit?: number;
}

export interface TruncateRawToFitResult {
  /** Rendered body, guaranteed to fit within `cap` (best-effort) or `hardLimit` (defensive). */
  body: string;
  /** True iff the helper had to truncate (raw was sliced or hard-cut). */
  truncated: boolean;
}

/**
 * Try the full content first; if it fits, return as-is. Otherwise
 * binary-search the largest raw prefix whose rendered body fits,
 * snap to the last newline boundary, append the sentinel, re-render
 * and return.
 *
 * Defensive last resort: if even the empty-slice + sentinel render
 * overflows (means the framing alone exceeds `cap` — caller bug or
 * adversarial reason field that slipped past clipping), we hard-cut
 * the rendered body to `hardLimit` chars. Should be unreachable in
 * production but cheaper than crashing.
 */
export function truncateRawToFit(
  input: TruncateRawToFitInput,
): TruncateRawToFitResult {
  const { raw, render, cap, sentinel } = input;
  const hardLimit = input.hardLimit ?? cap + 196;

  const fullBody = render(raw);
  if (fullBody.length <= cap) {
    return { body: fullBody, truncated: false };
  }

  // Binary-search the largest raw prefix length whose rendered body
  // fits (with sentinel suffixed before render). We track the best
  // slice rather than just the length so we can snap after the loop.
  let lo = 0;
  let hi = raw.length;
  let bestSliceLen = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = raw.slice(0, mid) + sentinel;
    if (render(candidate).length <= cap) {
      bestSliceLen = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Snap to the last newline within the chosen raw prefix so we
  // never cut a line in half. If a single unbroken line exceeds
  // the budget, fall through with the char-truncated slice — the
  // caller's framing (e.g. `<pre>`) handles the visual gracefully.
  let chosenRaw = raw.slice(0, bestSliceLen);
  const lastNl = chosenRaw.lastIndexOf("\n");
  if (lastNl > 0) chosenRaw = chosenRaw.slice(0, lastNl);

  let body = render(chosenRaw + sentinel);

  // Defensive: framing-alone overflow. Hard-cut to hardLimit so the
  // outbound sendMessage at least has a chance of succeeding.
  if (body.length > hardLimit) {
    body = body.slice(0, hardLimit - 1);
  }
  return { body, truncated: true };
}
