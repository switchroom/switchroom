/**
 * Validates fields loaded from access.json, failing loudly on type mismatches.
 *
 * JSON has no type system — a hand-edit that drops quotes around IDs
 * (e.g. `[8248703757]` instead of `["8248703757"]`) parses without error
 * but produces a number array. The gate compares with strict equality via
 * Array.includes(), so number entries silently drop every matching DM.
 *
 * This module surfaces that mistake at load time rather than at runtime.
 */

/**
 * Validates that `value` is an array of strings.
 *
 * - If `value` is not an array, returns [].
 * - If any entry is not a string, logs a loud warning to stderr and returns []
 *   so the field behaves as if no entries were present (fail-closed).
 * - If all entries are strings, returns the array as-is.
 *
 * @param field  Human-readable field name for the error message (e.g. "allowFrom")
 * @param value  The parsed JSON value to validate
 * @param tag    Process tag for the error message ("gateway" or "channel")
 */
export function validateStringArray(field: string, value: unknown, tag = 'gateway'): string[] {
  if (!Array.isArray(value)) return []
  const hasNonString = value.some((v) => typeof v !== 'string')
  if (hasNonString) {
    const example = String(value[0])
    process.stderr.write(
      `telegram ${tag}: access.json: ${field} contains non-string entries — ` +
        `all values must be quoted strings (e.g. ["${example}"]). ` +
        `Fix and reload. Treating as empty.\n`,
    )
    return []
  }
  return value as string[]
}
