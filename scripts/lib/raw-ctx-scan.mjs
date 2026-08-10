/**
 * Shared scanner for "raw grammy CONTEXT call" ratchets.
 *
 * Two guards need the SAME counting rules over different method families:
 *
 *   - `check-callback-ctx-wrapping.mjs` — the button-tap family
 *     (`answerCallbackQuery` / `editMessageText` / `editMessageReplyMarkup`),
 *     switchroom#3891.
 *   - `check-ctx-send-wrapping.mjs` — the SEND family (`ctx.reply`,
 *     `ctx.replyWithRichMessage`, …), switchroom#4599.
 *
 * The logic lives here once on purpose. The bug that motivated #4599 was a
 * guard whose docblock CLAIMED coverage its pattern could not deliver; two
 * hand-copied scanners drifting apart is the same failure mode with extra
 * steps.
 *
 * Rules implemented (identical to the ones #3891 shipped):
 *   - a match on a pure-comment line is not a call site;
 *   - a call is WRAPPED (not counted) when a retry-wrapper invocation appears
 *     on the same line before it, or on any of the preceding
 *     {@link WRAP_LOOKBACK_LINES} non-comment lines;
 *   - `<marker> <reason>` on the IMMEDIATELY preceding line waives one site;
 *     the reason is mandatory;
 *   - the per-file inventory is an EXACT match in both directions.
 */

/** Retry wrappers whose presence marks a call as already-policed. */
export const WRAPPERS = [
  'apiCall',
  'robustApiCall',
  'swallowingApiCall',
  'nonEssentialApiCall',
  'retryApiCall',
  'retryWithThreadFallback',
]

/** How many preceding lines are searched for a wrapper invocation. */
export const WRAP_LOOKBACK_LINES = 10

const WRAPPER_RE = new RegExp(String.raw`\b(?:${WRAPPERS.join('|')})\s*\(`)

/** True for a line that is purely a comment (so a doc mention isn't a call). */
export function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * Count raw, unwrapped `ctx.<method>(` calls in one file.
 *
 * @param {string} path
 * @param {string} source
 * @param {{ methods: string[], exemptMarker: string, allowApiInfix?: boolean }} opts
 * @returns {{ count: number, sites: {line: number, text: string}[], errors: string[] }}
 */
export function countRawCtxCalls(path, source, opts) {
  const { methods, exemptMarker, allowApiInfix = true } = opts
  const re = new RegExp(
    String.raw`\bctx\.${allowApiInfix ? '(?:api\\.)?' : ''}(?:${methods.join('|')})\s*\(`,
    'g',
  )
  const lines = source.split('\n')
  const sites = []
  const errors = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isCommentLine(line)) continue
    re.lastIndex = 0
    let m
    while ((m = re.exec(line)) !== null) {
      const prev = i > 0 ? lines[i - 1] : ''
      const at = prev.indexOf(exemptMarker)
      if (at !== -1) {
        const reason = prev.slice(at + exemptMarker.length).trim()
        if (reason === '') {
          errors.push(
            `${path}:${i + 1}: '${exemptMarker}' with no reason. State WHY this raw ` +
              `context call may skip the retry/flood policy, in the marker itself.`,
          )
        }
        continue
      }
      const head = line.slice(0, m.index)
      let wrapped = WRAPPER_RE.test(head)
      for (let k = 1; !wrapped && k <= WRAP_LOOKBACK_LINES && i - k >= 0; k++) {
        const prevLine = lines[i - k]
        if (isCommentLine(prevLine)) continue
        if (WRAPPER_RE.test(prevLine)) wrapped = true
      }
      if (wrapped) continue
      sites.push({ line: i + 1, text: line.trim() })
    }
  }
  return { count: sites.length, sites, errors }
}

/**
 * Exact-match inventory ratchet over a set of already-counted files.
 *
 * @param {{path: string, count: number, sites: {line: number, text: string}[]}[]} counted
 * @param {Record<string, number>} baseline
 * @param {{ baselinePath: string, growMessage: (ctx: {path: string, count: number, expected: number, fresh: string[]}) => string }} opts
 * @returns {{ errors: string[], actual: Record<string, number> }}
 */
export function evaluateInventory(counted, baseline, opts) {
  const errors = []
  /** @type {Record<string, number>} */
  const actual = {}

  for (const { path, count, sites } of counted) {
    if (count > 0) actual[path] = count
    const expected = baseline[path] ?? 0
    if (count > expected) {
      const fresh = sites.slice(expected).map((s) => `${path}:${s.line}: ${s.text}`)
      errors.push(opts.growMessage({ path, count, expected, fresh }))
    } else if (count < expected) {
      errors.push(
        `${path}: ${count} raw context call(s), inventory says ${expected}. ` +
          `You removed some — lower the number in ${opts.baselinePath} in the SAME PR. ` +
          `That is what makes this a ratchet: a stale inventory would re-admit the ` +
          `bypasses you just deleted.`,
      )
    }
  }

  for (const [path, expected] of Object.entries(baseline)) {
    if (expected > 0 && actual[path] === undefined) {
      errors.push(
        `${path}: listed in ${opts.baselinePath} with ${expected} raw call(s) but has none ` +
          `(file moved, renamed, or fully converted). Remove the entry in the same PR.`,
      )
    }
  }

  return { errors, actual }
}
