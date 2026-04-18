/**
 * Normalizing serializer for HTML / progress-card snapshot tests.
 *
 * Problem: the raw progress-card render contains
 *   - elapsed-time strings like "12s elapsed" / "1m34s"
 *   - ISO timestamps like "2026-04-18T12:34:56.789Z"
 *   - message-ids, toolUseIds, runtime-generated UUIDs
 *
 * Any of these flip on every test run, so a naive snapshot rots the
 * moment it lands. This serializer canonicalizes those fields to stable
 * tokens (`<ELAPSED>`, `<TIME>`, `<ID>`, `<TOOL_USE_ID>`) so the
 * snapshot diff reflects *semantic* changes only.
 *
 * Use by passing `snapshotSerializer` to vitest's `expect.addSnapshotSerializer`
 * in a test's `beforeAll`, or globally via `vitest.config.ts`
 * (`test.snapshotSerializers`).
 */

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // ISO8601 timestamps
  { re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b/g, replacement: '<TIME>' },
  // Unix seconds (10 digits) — only within JSON-like contexts, prefixed by `date":` or `"date":`
  { re: /"date"\s*:\s*\d{10}\b/g, replacement: '"date":<UNIX_SEC>' },
  // Elapsed-time strings rendered by progress-card (hhh? mm ss).
  // Match "NNs elapsed", "NNmNNs", "NNhNNm".
  { re: /\b\d+m\d+s\b/g, replacement: '<ELAPSED>' },
  { re: /\b\d+h\d+m\b/g, replacement: '<ELAPSED>' },
  { re: /\b\d+s\s+elapsed\b/g, replacement: '<ELAPSED> elapsed' },
  // Claude Code tool_use ids: `toolu_01ABC...` (base62, 20+ chars).
  { re: /\btoolu_[A-Za-z0-9_]{10,}\b/g, replacement: '<TOOL_USE_ID>' },
  // grammy/telegram file_ids: long alphanumerics starting with AgACAgI / BQACAgI etc.
  { re: /\b(?:AgAC|BQAC|CQAC|DQAC)[A-Za-z0-9_-]{10,}\b/g, replacement: '<FILE_ID>' },
  // UUIDs
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, replacement: '<UUID>' },
]

/**
 * Apply all normalizing replacements. Safe to call on any string —
 * non-matching content passes through unchanged.
 */
export function normalizeSnapshot(input: string): string {
  let out = input
  for (const { re, replacement } of PATTERNS) {
    out = out.replace(re, replacement)
  }
  return out
}

/**
 * Vitest snapshot serializer compatible with `expect.addSnapshotSerializer`.
 *
 * Only applies to string values that clearly look like HTML / Telegram
 * rendered content. Everything else passes through without interference
 * so we don't accidentally mangle unrelated assertions.
 */
export const snapshotSerializer = {
  test(val: unknown): boolean {
    if (typeof val !== 'string') return false
    // Cheap pre-filter: only normalize when at least one pattern would hit.
    for (const { re } of PATTERNS) {
      re.lastIndex = 0
      if (re.test(val)) {
        re.lastIndex = 0
        return true
      }
      re.lastIndex = 0
    }
    return false
  },
  serialize(val: unknown): string {
    return JSON.stringify(normalizeSnapshot(val as string))
  },
}

/** Convenience: normalize + stringify with stable indent. Good for
 *  inline-snapshot-style assertions without invoking the serializer. */
export function stableHtmlSnapshot(html: string): string {
  return normalizeSnapshot(html)
}
